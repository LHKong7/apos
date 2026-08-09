import {
  PROTOCOL_VERSION,
  type CapabilityManifest,
  type ControlCommand,
  type ResourceScope,
  type RunEvent,
  type RunEventBody,
  type RunStatus,
  type TaskDispatch,
} from '@apos/contracts';
import type {
  Options,
  PermissionResult,
  Query,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  UnsupportedFeatureError,
  type AgentRuntimeAdapter,
  type DispatchAck,
  type RuntimeStatus,
  type Unsubscribe,
} from '../adapter';
import { isExplicitlyDenied, mapPermissions, type MappedPermissions } from './permissions';
import { buildPrompt, buildSystemAppend } from './prompt';
import { EventTranslator } from './translate';
import { classifyThrown } from './errors';

export type QueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => Query;

export interface ClaudeCodeRuntimeOptions {
  /**
   * Agent 自己的凭证。★ 绝不复用平台/人类的 ANTHROPIC_API_KEY ——
   * 产品文档 10.2：Agent 是独立身份，权限独立配置。
   * 默认读 APOS_AGENT_ANTHROPIC_API_KEY，与平台用的变量分开。
   */
  apiKey?: string;
  /**
   * 显式允许继承进程环境里的 ANTHROPIC_API_KEY。
   * 默认 false —— 想开就得写出来，便于审计。
   */
  allowInheritedCredentials?: boolean;
  /** repo 资源范围 → 本地目录 */
  resolveWorkspace?: (scope: ResourceScope) => string | null;
  /** 未配置 resolveWorkspace 时的兜底工作目录 */
  workspaceRoot?: string;
  /** 轮次上限，同时作为 progress 的分母 */
  maxTurns?: number;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** 透传给子进程的环境变量名白名单（默认只给 PATH / HOME） */
  passthroughEnv?: string[];
  /**
   * 遇到未授权工具时的行为：
   * - 'escalate'（默认）：拒绝并中断，同时发 intervention_request 让人类决策
   * - 'deny'：拒绝但让 Agent 继续，绕不过去时自己收敛
   */
  onUngrantedTool?: 'escalate' | 'deny';
  /** 注入 query 实现，测试用；默认动态加载 SDK */
  queryFn?: QueryFn;
  /** 子进程 stderr 与投递异常的出口 */
  onDiagnostic?: (message: string, detail?: unknown) => void;
}

const DEFAULT_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];

const RUN_STATUS_BY_OUTCOME: Record<'completed' | 'failed' | 'terminated', RunStatus> = {
  completed: 'completed',
  failed: 'failed',
  terminated: 'terminated',
};

type AbortReason = 'terminate' | 'timeout' | 'detach';

interface RunState {
  task: TaskDispatch;
  mapped: MappedPermissions;
  translator: EventTranslator;
  input: PromptStream;
  abort: AbortController;
  query: Query | null;
  status: RunStatus;
  lastActivityAt: string | null;
  sessionId: string | null;
  seq: number;
  /** 串行投递链：保证订阅者按 seq 顺序收到事件 */
  chain: Promise<void>;
  closed: boolean;
  abortReason: AbortReason | null;
  emit: (body: RunEventBody) => Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Claude Code 运行时适配器 —— docs/tech/06-agent-protocol.md §9.2
 *
 * 三个设计决定值得单独说明：
 *
 * 1. **默认拒绝**。tools 只放已授权的工具，allowedTools 决定免确认放行，
 *    其余全部落到 canUseTool 由适配器处置。settingSources 置空，
 *    避免仓库里的 .claude/settings.json 把 Policy 拒绝过的工具再放回来。
 *
 * 2. **流式输入**。prompt 用 AsyncIterable 而不是字符串，代价是要自己管
 *    输入队列，换来的是执行中可以注入约束（Approve with Constraints
 *    落到运行时），以及 interrupt 可用。
 *
 * 3. **成本双轨**。执行过程中按 token 估算，Run 结束时用 SDK 的
 *    total_cost_usd 发一条差额事件校正。过程可见，账目权威。
 */
export class ClaudeCodeRuntime implements AgentRuntimeAdapter {
  readonly kind = 'claude_code';

  private runs = new Map<string, RunState>();
  private byIdempotencyKey = new Map<string, string>();
  private loadedQuery: QueryFn | null = null;

  constructor(private readonly options: ClaudeCodeRuntimeOptions = {}) {}

  async getCapabilities(): Promise<CapabilityManifest> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      runtime: { name: 'claude-code', version: '0.3' },
      features: {
        streamingEvents: true,
        toolCallVisibility: true,
        reasoningVisibility: true,
        costReporting: true,
        tokenReporting: true,
        progressReporting: true,
        // 流式输入模式下可以中途追加消息
        runtimeConstraints: true,
        // 未授权工具的调用会被拦下并升级为人工决策
        interventionRequest: this.options.onUngrantedTool !== 'deny',
        selfReportOnFailure: true,
        // ★ SDK 没有暂停/恢复语义，只能中止。按降级矩阵，暂停退化为终止
        pause: false,
        terminate: true,
        // 仅限本进程持有的 Run，见 queryStatus 的说明
        statusQuery: true,
        subAgentDelegation: true,
        artifactUpload: true,
      },
      transport: { eventDelivery: 'sse', heartbeatIntervalSeconds: 30 },
      tools: [
        { name: 'Read', description: '读取文件', sideEffects: 'read' },
        { name: 'Glob', description: '按模式查找文件', sideEffects: 'read' },
        { name: 'Grep', description: '搜索文件内容', sideEffects: 'read' },
        { name: 'Write', description: '写入文件', sideEffects: 'write' },
        { name: 'Edit', description: '修改文件', sideEffects: 'write' },
        { name: 'NotebookEdit', description: '修改 Notebook', sideEffects: 'write' },
        { name: 'Bash', description: '执行 shell 命令', sideEffects: 'destructive' },
        { name: 'WebFetch', description: '抓取网页', sideEffects: 'external' },
        { name: 'WebSearch', description: '联网搜索', sideEffects: 'external' },
        { name: 'Task', description: '委派子 Agent', sideEffects: 'write' },
      ],
      models: this.options.model ? [this.options.model, ...DEFAULT_MODELS] : DEFAULT_MODELS,
      limits: {
        maxConcurrentRuns: 5,
        maxRunDurationSeconds: 7200,
        maxContextTokens: 1_000_000,
      },
    };
  }

  async dispatch(task: TaskDispatch): Promise<DispatchAck> {
    const existing = this.byIdempotencyKey.get(task.idempotencyKey);
    if (existing) {
      return { externalRunId: this.externalId(existing), accepted: true };
    }

    const credential = this.resolveCredential();
    if (!credential) {
      return {
        externalRunId: this.externalId(task.runId),
        accepted: false,
        rejectReason:
          '未配置 Agent 凭证：请设置 APOS_AGENT_ANTHROPIC_API_KEY（不要复用平台的 ANTHROPIC_API_KEY），' +
          '或显式开启 allowInheritedCredentials。',
      };
    }

    const mapped = mapPermissions(task.permissions, (scope) => this.workspaceFor(scope));

    if (mapped.tools.length === 0) {
      return {
        externalRunId: this.externalId(task.runId),
        accepted: false,
        rejectReason: '该 Agent 没有任何可用工具，无法执行编码任务',
      };
    }
    if (!mapped.cwd) {
      return {
        externalRunId: this.externalId(task.runId),
        accepted: false,
        rejectReason: '未解析出可用的工作目录：请为 Agent 配置 repo 资源范围',
      };
    }

    const abort = new AbortController();
    const state: RunState = {
      task,
      mapped,
      translator: new EventTranslator({ task, maxTurns: this.maxTurns() }),
      input: new PromptStream(),
      abort,
      query: null,
      status: 'queued',
      lastActivityAt: null,
      sessionId: null,
      seq: 0,
      chain: Promise.resolve(),
      closed: false,
      abortReason: null,
      emit: async () => {},
      timer: null,
    };

    this.runs.set(task.runId, state);
    this.byIdempotencyKey.set(task.idempotencyKey, task.runId);

    return { externalRunId: this.externalId(task.runId), accepted: true };
  }

  async subscribe(runId: string, onEvent: (e: RunEvent) => Promise<void>): Promise<Unsubscribe> {
    const state = this.runs.get(runId);
    if (!state) throw new Error(`Run ${runId} 未派发到 ${this.kind}`);

    state.emit = (body) => {
      if (state.closed) return Promise.resolve();
      const event = {
        runId,
        seq: state.seq++,
        ts: new Date().toISOString(),
        ...body,
      } as RunEvent;
      state.chain = state.chain
        .then(() => onEvent(event))
        .catch((err) => this.diagnose(`事件投递失败（run=${runId} seq=${event.seq}）`, err));
      return state.chain;
    };

    // run_started 先于任何执行事件 —— 会话起不来时也能看到 Run 开始过
    await state.emit({
      type: 'run_started',
      model: this.modelFor(state.task),
      toolsAvailable: state.mapped.tools,
    });

    state.status = 'running';
    state.lastActivityAt = new Date().toISOString();

    void this.pump(state);

    return async () => {
      await this.stop(state, 'detach');
    };
  }

  async queryStatus(runId: string): Promise<RuntimeStatus> {
    const state = this.runs.get(runId);
    if (state) {
      return { status: state.status, lastActivityAt: state.lastActivityAt };
    }

    /**
     * 本进程没有这个 Run 的记录。
     *
     * Claude Code 会话是本进程的子进程，进程重启后子进程不会留下 ——
     * 所以「查不到」等价于「已经不在跑了」。这个回答是可行动的：
     * 孤儿 Run 接管时可以直接判定终止并走恢复流程，
     * 而不是无限等一个永远不会回来的回调。
     */
    return { status: 'terminated', lastActivityAt: null };
  }

  async control(runId: string, cmd: ControlCommand): Promise<void> {
    const state = this.runs.get(runId);
    if (!state) throw new Error(`Run ${runId} 未派发到 ${this.kind}`);

    switch (cmd.action) {
      case 'terminate':
        await state.emit({ type: 'note', text: `收到终止指令：${cmd.reason}` });
        await this.stop(state, 'terminate');
        return;

      case 'add_constraint': {
        if (state.closed || state.status !== 'running') {
          throw new Error('Run 已结束，无法追加约束');
        }
        state.input.push(
          [
            '【平台注入的新约束，立即生效，优先于此前的任何指示】',
            `（${cmd.constraint.type}）${cmd.constraint.description}`,
            '请据此调整当前做法；若与已完成的工作冲突，先说明冲突再继续。',
          ].join('\n'),
        );
        await state.emit({
          type: 'note',
          text: `已注入执行约束：${cmd.constraint.description}`,
        });
        return;
      }

      case 'pause':
      case 'resume':
        // 降级矩阵：暂停退化为终止，由调用方二次确认后改调 terminate
        throw new UnsupportedFeatureError('pause', this.kind);
    }
  }

  // ── 内部 ──────────────────────────────────────────────────────────

  private async pump(state: RunState): Promise<void> {
    const { task } = state;

    state.timer = setTimeout(() => {
      void this.stop(state, 'timeout');
    }, task.limits.maxDurationSeconds * 1000);
    state.timer.unref?.();

    try {
      const queryFn = this.options.queryFn ?? (await this.loadQuery());
      state.input.push(buildPrompt(task));

      const q = queryFn({ prompt: state.input, options: this.buildOptions(state) });
      state.query = q;

      for await (const msg of q) {
        state.lastActivityAt = new Date().toISOString();
        if ('session_id' in msg && typeof msg.session_id === 'string') {
          state.sessionId = msg.session_id;
        }

        const bodies = state.translator.translate(msg);

        /**
         * 状态先于事件落定：订阅者拿到 run_ended 时再 queryStatus，
         * 必须已经能读到终态，而不是还停在 running。
         *
         * 以 run_ended 的 outcome 为准，不自己再判一次成败 ——
         * subtype='success' 未必是成功（见 translate.ts 的说明），
         * 两处各判一次迟早会打架。
         */
        const ended = bodies.find((b) => b.type === 'run_ended');
        if (ended) state.status = RUN_STATUS_BY_OUTCOME[ended.outcome];

        for (const body of bodies) {
          await state.emit(body);
        }

        // 单轮派发：第一条 result 就是本次 Run 的终点
        if (msg.type === 'result') break;
      }

      if (!state.translator.endedAlready && !state.closed) {
        await this.endUnexpectedly(state);
      }
    } catch (err) {
      await this.handleThrown(state, err);
    } finally {
      this.cleanup(state);
    }
  }

  private async handleThrown(state: RunState, err: unknown): Promise<void> {
    if (state.abortReason === 'detach') return;
    if (state.translator.endedAlready) return;

    if (state.abortReason === 'terminate') {
      state.status = 'terminated';
      await state.emit({ type: 'run_ended', outcome: 'terminated', summary: '已被人工终止' });
      return;
    }

    const error = classifyThrown(err, { aborted: state.abortReason === 'timeout' });
    state.status = state.abortReason === 'timeout' ? 'timeout' : 'failed';

    await state.emit({ type: 'error', error });
    await state.emit({
      type: 'run_ended',
      outcome: 'failed',
      summary: error.message,
      ...(error.selfReport ? { selfReport: error.selfReport } : {}),
    });
  }

  /** 事件流结束但没有 result —— 子进程异常退出会走到这里 */
  private async endUnexpectedly(state: RunState): Promise<void> {
    state.status = 'failed';
    await state.emit({
      type: 'error',
      error: {
        class: 'runtime_error',
        message: '运行时事件流意外结束，未返回执行结果',
        retriable: true,
        classificationSource: 'reported',
      },
    });
    await state.emit({
      type: 'run_ended',
      outcome: 'failed',
      summary: '运行时事件流意外结束',
    });
  }

  private async stop(state: RunState, reason: AbortReason): Promise<void> {
    if (state.abortReason) return;
    state.abortReason = reason;

    if (reason === 'timeout') {
      state.status = 'timeout';
    } else if (reason === 'terminate') {
      state.status = 'terminated';
    }

    state.input.close();
    state.abort.abort();
    try {
      state.query?.close();
    } catch (err) {
      this.diagnose('关闭会话失败', err);
    }

    if (reason === 'detach') {
      // 订阅者主动断开：不再投递，但必须中止子进程，否则成本会继续累积
      state.closed = true;
    }

    await state.chain;
  }

  private cleanup(state: RunState) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.input.close();
    // 走到这里还是 running，说明既没拿到 result 也没抛异常 —— 按失败处理，
    // 不留「永远在跑」的 Run
    if (state.status === 'running') state.status = 'failed';
  }

  private buildOptions(state: RunState): Options {
    const { task, mapped } = state;

    return {
      model: this.modelFor(task),
      effort: this.options.effort ?? 'xhigh',
      thinking: { type: 'adaptive' },

      cwd: mapped.cwd ?? undefined,
      additionalDirectories: mapped.additionalDirectories,

      // ★ 权限三件套：能看到什么 / 什么免确认 / 什么绝对不行
      tools: mapped.tools,
      allowedTools: mapped.allowedTools,
      disallowedTools: mapped.disallowedTools,
      permissionMode: 'default',
      canUseTool: this.permissionGate(state),

      // ★ 不加载用户/项目/本地 settings：
      //   仓库里的 .claude/settings.json 不能把 Policy 拒绝过的工具放回来
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},

      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: buildSystemAppend(task, mapped),
      },

      maxTurns: this.maxTurns(),
      // 运行时侧的硬预算：超了它自己停，不用等我们的成本事件追上
      maxBudgetUsd: task.limits.maxCostUsd,

      abortController: state.abort,
      env: this.childEnv(),
      stderr: (data) => this.diagnose(`[claude-code:${task.runId}] ${data.trimEnd()}`),
      includePartialMessages: false,
      persistSession: false,
    };
  }

  /**
   * 未授权工具的处置点。
   *
   * SDK 只在「既没被 allowedTools 放行、也没被 disallowedTools 拦掉」时调这里，
   * 也就是恰好是「Agent 想要一个没给它的能力」的情形 —— 这正是需要人类拍板的时刻。
   */
  private permissionGate(state: RunState) {
    return async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
      // 显式黑名单：Policy 已经判过了，不再打扰人类
      if (isExplicitlyDenied(toolName, state.task.permissions)) {
        await state.emit({
          type: 'note',
          text: `拒绝 ${toolName}：该工具在黑名单中`,
        });
        return { behavior: 'deny', message: `${toolName} 被组织策略禁止使用，请改用其他方式。` };
      }

      if (this.options.onUngrantedTool === 'deny') {
        return {
          behavior: 'deny',
          message: `你没有 ${toolName} 的授权。不要绕道实现，请在最终回复里说明为什么需要它。`,
        };
      }

      await state.emit({
        type: 'intervention_request',
        request: {
          reason: 'permission_needed',
          question: `Agent 需要使用未授权的工具 ${toolName}，是否授权？`,
          options: [
            {
              id: 'grant',
              label: `授权 ${toolName} 并重试`,
              description: `把 ${toolName} 加入该 Agent 的允许列表后重新执行`,
              consequence: '该 Agent 之后都可使用此工具',
            },
            {
              id: 'reject',
              label: '不授权',
              description: '保持当前权限，任务转人工或换执行方式',
              consequence: 'Agent 无法完成需要该工具的部分',
            },
          ],
          urgency: 'blocking',
        },
      });

      return {
        behavior: 'deny',
        // interrupt：停下来等人，而不是让 Agent 在缺能力的情况下继续试
        interrupt: true,
        message:
          `${toolName} 未在本次派发的授权范围内，已请求人工决策。` +
          `请立即停止并在回复中说明：为什么需要它、参数是 ${safeJson(input)}。`,
      };
    };
  }

  /**
   * 子进程环境：只给最小集合。
   *
   * 不做 { ...process.env } —— 那会把平台的密钥、数据库口令、
   * 其他服务的 token 一起交给 Agent，等于绕开了资源范围控制。
   */
  private childEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      ANTHROPIC_API_KEY: this.resolveCredential() ?? undefined,
    };
    for (const key of this.options.passthroughEnv ?? []) {
      env[key] = process.env[key];
    }
    return env;
  }

  private resolveCredential(): string | null {
    if (this.options.apiKey) return this.options.apiKey;
    const dedicated = process.env['APOS_AGENT_ANTHROPIC_API_KEY'];
    if (dedicated) return dedicated;
    if (this.options.allowInheritedCredentials) {
      return process.env['ANTHROPIC_API_KEY'] ?? null;
    }
    return null;
  }

  private workspaceFor(scope: ResourceScope): string | null {
    if (this.options.resolveWorkspace) return this.options.resolveWorkspace(scope);
    return this.options.workspaceRoot ?? null;
  }

  private modelFor(task: TaskDispatch): string {
    return task.model ?? this.options.model ?? 'claude-opus-5';
  }

  private maxTurns(): number {
    return this.options.maxTurns ?? 60;
  }

  private externalId(runId: string): string {
    return `claude-code:${runId}`;
  }

  private async loadQuery(): Promise<QueryFn> {
    if (this.loadedQuery) return this.loadedQuery;
    // 动态加载：没接 Claude Code 的部署不必安装这个包（含平台二进制，体积不小）
    const mod = await import('@anthropic-ai/claude-agent-sdk');
    this.loadedQuery = mod.query;
    return this.loadedQuery;
  }

  private diagnose(message: string, detail?: unknown) {
    this.options.onDiagnostic?.(message, detail);
  }
}

/**
 * 输入队列。
 *
 * SDK 的流式输入模式要求 prompt 是 AsyncIterable：迭代器不结束，会话就活着，
 * 于是执行中可以继续 push 消息（注入约束）。代价是必须显式 close，
 * 否则子进程会一直等下一条输入。
 */
export class PromptStream implements AsyncIterable<SDKUserMessage> {
  private queue: string[] = [];
  private pending: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(text: string) {
    if (this.closed) return;
    const waiter = this.pending;
    if (waiter) {
      this.pending = null;
      waiter({ value: message(text), done: false });
      return;
    }
    this.queue.push(text);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const waiter = this.pending;
    if (waiter) {
      this.pending = null;
      waiter({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield message(next);
        continue;
      }
      if (this.closed) return;

      const value = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        this.pending = resolve;
      });
      if (value.done) return;
      yield value.value;
    }
  }
}

function message(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  };
}

function safeJson(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s.length > 500 ? `${s.slice(0, 500)}…` : s;
  } catch {
    return '（参数无法序列化）';
  }
}
