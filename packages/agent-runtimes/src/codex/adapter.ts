import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  PROTOCOL_VERSION,
  type CapabilityManifest,
  type ControlCommand,
  type RunEvent,
  type RunEventBody,
  type RunStatus,
  type TaskDispatch,
} from '@apos/contracts';
import {
  UnsupportedFeatureError,
  type AgentRuntimeAdapter,
  type DispatchAck,
  type RuntimeStatus,
  type Unsubscribe,
} from '../adapter';
import { buildInlinePreamble, buildPrompt } from '../prompt';
import { mapSandbox, type MappedSandbox } from './permissions';
import { CodexEventTranslator, hasCodexPricing } from './translate';

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

export interface CodexRuntimeOptions {
  /** Agent 自己的凭证，绝不复用平台/人类的 key */
  apiKey?: string;
  allowInheritedCredentials?: boolean;
  /** 自建网关地址 */
  baseUrl?: string;
  model?: string;
  /** CLI 可执行文件名 */
  binary?: string;
  /**
   * 审批策略。
   *
   * ★ 非交互执行下只有 'never' 真正可用：其余档位会让 CLI 挂起等人在终端上
   *   确认，而这里没有终端 —— 表现是 Run 一直卡着直到超时。开放这个配置项
   *   是因为有人会接自己的 codex 封装，但默认必须是 never。
   */
  approvalPolicy?: string;
  /** 透传给子进程的环境变量名白名单 */
  passthroughEnv?: string[];
  /**
   * 用户直接给出值的环境变量表（配置里的 `env` JSON）。
   * ★ 最后应用，会盖掉上面各项算出来的同名变量 —— 填了就一定生效。
   */
  env?: Record<string, string>;
  /** 注入 spawn，测试用 */
  spawnFn?: SpawnFn;
  onDiagnostic?: (message: string, detail?: unknown) => void;
}

const DEFAULT_MODELS = ['gpt-5-codex', 'gpt-5', 'o4-mini'];

interface RunState {
  task: TaskDispatch;
  sandbox: MappedSandbox;
  translator: CodexEventTranslator;
  child: ChildProcessWithoutNullStreams | null;
  status: RunStatus;
  lastActivityAt: string | null;
  seq: number;
  chain: Promise<void>;
  closed: boolean;
  stopReason: 'terminate' | 'timeout' | 'detach' | null;
  stderrTail: string[];
  emit: (body: RunEventBody) => Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Codex CLI 运行时适配器。
 *
 * 接这个运行时的价值不只是「多一个 Agent 可选」，而是它把协议里
 * 一个此前没被验证的假设压出来测了：**权限模型未必是工具级的**。
 *
 * 三处真实降级，都如实写进能力清单而不是假装能做：
 *
 * 1. **权限粒度**。Codex 只有沙箱级（read-only / workspace-write），
 *    表达不了「Bash 可用但 rm 不可用」。映射时一律**收紧**，
 *    并把表达不了的规则列进 `unenforceable` 交给页面显示。
 *
 * 2. **无 system prompt 通道**。治理规则只能折进用户消息的最前面
 *    （`buildInlinePreamble`），权重低于真正的 system prompt。
 *
 * 3. **单次执行、无中途注入**。`runtimeConstraints` 与
 *    `interventionRequest` 都是 false —— 沙箱拒绝是静默的，
 *    Agent 没有渠道主动求助，只能靠超时与失败检测兜底。
 */
export class CodexRuntime implements AgentRuntimeAdapter {
  readonly kind = 'codex';

  private runs = new Map<string, RunState>();
  private byIdempotencyKey = new Map<string, string>();

  constructor(private readonly options: CodexRuntimeOptions = {}) {}

  async getCapabilities(): Promise<CapabilityManifest> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      runtime: { name: 'codex-cli', version: '0.1' },
      features: {
        streamingEvents: true,
        toolCallVisibility: true,
        reasoningVisibility: true,
        // 有 token 用量，但没有权威结算值 —— 成本是估算的
        costReporting: true,
        tokenReporting: true,
        // 不上报总步数
        progressReporting: false,
        // 单次执行，起跑后无法追加消息
        runtimeConstraints: false,
        // 沙箱拒绝是静默的，Agent 无法把「我需要这个权限」变成人类待办
        interventionRequest: false,
        selfReportOnFailure: true,
        pause: false,
        terminate: true,
        statusQuery: true,
        subAgentDelegation: false,
        artifactUpload: false,
      },
      transport: { eventDelivery: 'sse', heartbeatIntervalSeconds: 30 },
      tools: [
        { name: 'Read', description: '读取文件（沙箱内）', sideEffects: 'read' },
        { name: 'Edit', description: '修改文件（workspace-write 下）', sideEffects: 'write' },
        { name: 'Bash', description: '执行命令（沙箱内）', sideEffects: 'destructive' },
        { name: 'WebSearch', description: '联网搜索（开网时）', sideEffects: 'external' },
      ],
      models: this.options.model ? [this.options.model, ...DEFAULT_MODELS] : DEFAULT_MODELS,
      limits: { maxConcurrentRuns: 3, maxRunDurationSeconds: 7200, maxContextTokens: 400_000 },
    };
  }

  async dispatch(task: TaskDispatch): Promise<DispatchAck> {
    const existing = this.byIdempotencyKey.get(task.idempotencyKey);
    if (existing) return { externalRunId: this.externalId(existing), accepted: true };

    // 环境变量表里直接给出 OPENAI_API_KEY 也算配齐了（接中转站的常见形态）
    if (!this.resolveCredential() && !(this.options.env ?? {})['OPENAI_API_KEY']) {
      return {
        externalRunId: this.externalId(task.runId),
        accepted: false,
        rejectCode: 'missing_credential',
        rejectReason:
          '未配置 Agent 凭证：请为该运行时登记 OpenAI API Key（不要复用平台凭证），' +
          '或显式开启 allowInheritedCredentials，也可以在环境变量表里直接给出 OPENAI_API_KEY。',
      };
    }

    if (!task.workspace) {
      return {
        externalRunId: this.externalId(task.runId),
        accepted: false,
        rejectCode: 'no_workspace',
        rejectReason:
          'Codex 必须在一个已准备好的工作目录里执行：请先在「工作区来源」里登记这个仓库或目录，' +
          '再到项目的 Agent 设置里把它授权给该 Agent。',
      };
    }

    const sandbox = mapSandbox(task.permissions, task.workspace.writable);

    this.runs.set(task.runId, {
      task,
      sandbox,
      translator: new CodexEventTranslator({ task, model: this.modelFor(task) }),
      child: null,
      status: 'queued',
      lastActivityAt: null,
      seq: 0,
      chain: Promise.resolve(),
      closed: false,
      stopReason: null,
      stderrTail: [],
      emit: async () => {},
      timer: null,
    });
    this.byIdempotencyKey.set(task.idempotencyKey, task.runId);

    return { externalRunId: this.externalId(task.runId), accepted: true };
  }

  async subscribe(runId: string, onEvent: (e: RunEvent) => Promise<void>): Promise<Unsubscribe> {
    const state = this.runs.get(runId);
    if (!state) throw new Error(`Run ${runId} 未派发到 ${this.kind}`);

    state.emit = (body) => {
      if (state.closed) return Promise.resolve();
      const event = { runId, seq: state.seq++, ts: new Date().toISOString(), ...body } as RunEvent;
      state.chain = state.chain
        .then(() => onEvent(event))
        .catch((err) => this.diagnose(`事件投递失败（run=${runId} seq=${event.seq}）`, err));
      return state.chain;
    };

    await state.emit({
      type: 'run_started',
      model: this.modelFor(state.task),
      toolsAvailable: toolsFor(state.sandbox),
    });

    /**
     * ★ 权限表达不了的部分立刻说出来，而不是等出事再解释。
     *   这条 note 会出现在 Run 详情的执行流里，是审计链的一部分。
     */
    if (state.sandbox.unenforceable.length > 0) {
      await state.emit({
        type: 'note',
        text: [
          `⚠ 该运行时的权限粒度是沙箱级（${state.sandbox.mode}），以下 ${state.sandbox.unenforceable.length} 条限制无法逐项执行：`,
          ...state.sandbox.unenforceable.map((u) => `- ${u.rule}：${u.why}`),
        ].join('\n'),
      });
    }

    state.status = 'running';
    state.lastActivityAt = new Date().toISOString();
    void this.pump(state);

    return async () => {
      await this.stop(state, 'detach');
    };
  }

  async queryStatus(runId: string): Promise<RuntimeStatus> {
    const state = this.runs.get(runId);
    if (state) return { status: state.status, lastActivityAt: state.lastActivityAt };
    // 子进程随本进程消亡；查不到 == 已经不在跑了
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
      case 'add_constraint':
        // 单次执行，起跑后没有输入通道
        throw new UnsupportedFeatureError('runtimeConstraints', this.kind);
      case 'pause':
      case 'resume':
        throw new UnsupportedFeatureError('pause', this.kind);
    }
  }

  // ── 内部 ────────────────────────────────────────────────────────────

  private async pump(state: RunState): Promise<void> {
    const { task } = state;

    state.timer = setTimeout(() => {
      void this.stop(state, 'timeout');
    }, task.limits.maxDurationSeconds * 1000);
    state.timer.unref?.();

    try {
      const spawnFn = this.options.spawnFn ?? defaultSpawn;
      const child = spawnFn(this.options.binary ?? 'codex', this.args(state), {
        cwd: task.workspace?.path,
        env: this.childEnv(),
      });
      state.child = child;

      child.stdin.write(this.fullPrompt(state));
      child.stdin.end();

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        state.stderrTail.push(text);
        if (state.stderrTail.length > 20) state.stderrTail.shift();
        this.diagnose(`[codex:${task.runId}] ${text.trimEnd()}`);
      });

      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        state.lastActivityAt = new Date().toISOString();

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // 非 JSON 行（CLI 的横幅、进度条）不是错误，留一条痕迹就够
          this.diagnose(`[codex:${task.runId}] 非 JSON 输出：${line.slice(0, 200)}`);
          continue;
        }

        for (const body of state.translator.translate(parsed)) {
          await state.emit(body);
        }
      }

      const exitCode = await waitForExit(child);
      await this.finish(state, exitCode);
    } catch (err) {
      await this.finish(state, null, err);
    } finally {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      if (state.status === 'running') state.status = 'failed';
    }
  }

  private async finish(state: RunState, exitCode: number | null, thrown?: unknown) {
    if (state.stopReason === 'detach') return;
    if (state.translator.endedAlready) return;

    if (state.stopReason === 'terminate') {
      state.status = 'terminated';
      await state.emit({ type: 'run_ended', outcome: 'terminated', summary: '已被人工终止' });
      return;
    }

    if (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      const notFound = /ENOENT|not found/i.test(message);
      state.status = 'failed';
      await state.emit({
        type: 'error',
        error: {
          class: 'runtime_error',
          message: notFound
            ? `未找到 codex 可执行文件：${message}`
            : `Codex 执行异常：${message}`,
          retriable: !notFound,
          selfReport: notFound
            ? '部署环境没有安装 Codex CLI，需要先安装并确保它在 PATH 中。'
            : undefined,
          classificationSource: 'reported',
        },
      });
      await state.emit({ type: 'run_ended', outcome: 'failed', summary: message });
      return;
    }

    const isTimeout = state.stopReason === 'timeout';
    state.status = isTimeout ? 'timeout' : exitCode === 0 ? 'completed' : 'failed';

    const events = state.translator.finish(
      isTimeout ? 124 : exitCode,
      isTimeout ? '执行超时，已中止' : state.stderrTail.join('').slice(-4000),
    );

    // 成本无权威结算值时说清楚，避免用户把估算读成账单
    if (!hasCodexPricing(this.modelFor(state.task))) {
      await state.emit({
        type: 'note',
        text: `模型 ${this.modelFor(state.task)} 不在本地价目表中，本次成本无法估算（显示为 $0）`,
      });
    }

    for (const body of events) await state.emit(body);
  }

  private async stop(state: RunState, reason: 'terminate' | 'timeout' | 'detach'): Promise<void> {
    if (state.stopReason) return;
    state.stopReason = reason;

    if (reason === 'timeout') state.status = 'timeout';
    if (reason === 'terminate') state.status = 'terminated';
    if (reason === 'detach') state.closed = true;

    // ★ 无论哪种停法都要杀掉子进程，否则成本会继续累积
    state.child?.kill('SIGTERM');
    setTimeout(() => state.child?.kill('SIGKILL'), 5000).unref?.();

    await state.chain;
  }

  private args(state: RunState): string[] {
    const args = ['exec', '--json', '--skip-git-repo-check'];
    args.push('--sandbox', state.sandbox.mode);
    args.push('--model', this.modelFor(state.task));
    if (state.task.workspace) args.push('--cd', state.task.workspace.path);
    // 非交互执行：任何需要人确认的操作直接失败，而不是挂着等
    args.push('--ask-for-approval', this.options.approvalPolicy ?? 'never');
    args.push('-');
    return args;
  }

  /** 治理规则 + 人设折进用户消息最前面 —— Codex 没有 system prompt 通道 */
  private fullPrompt(state: RunState): string {
    const preamble = buildInlinePreamble(state.task, {
      writable: state.sandbox.mode !== 'read-only',
      otherScopes: state.task.permissions.resourceScopes.filter(
        (s) => s.kind !== 'repo' && s.access !== 'none',
      ),
    });
    return `${preamble}\n\n${buildPrompt(state.task)}`;
  }

  /** 最小环境集合。不做 { ...process.env } —— 那等于把平台密钥交给 Agent */
  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      OPENAI_API_KEY: this.resolveCredential() ?? undefined,
    };
    if (this.options.baseUrl) env['OPENAI_BASE_URL'] = this.options.baseUrl;
    for (const key of this.options.passthroughEnv ?? []) env[key] = process.env[key];
    // ★ 用户填的排最后：填了就一定生效
    for (const [key, value] of Object.entries(this.options.env ?? {})) env[key] = value;
    return env;
  }

  private resolveCredential(): string | null {
    if (this.options.apiKey) return this.options.apiKey;
    const dedicated = process.env['APOS_AGENT_OPENAI_API_KEY'];
    if (dedicated) return dedicated;
    if (this.options.allowInheritedCredentials) return process.env['OPENAI_API_KEY'] ?? null;
    return null;
  }

  private modelFor(task: TaskDispatch): string {
    return task.model ?? this.options.model ?? 'gpt-5-codex';
  }

  private externalId(runId: string): string {
    return `codex:${runId}`;
  }

  private diagnose(message: string, detail?: unknown) {
    this.options.onDiagnostic?.(message, detail);
  }
}

function toolsFor(sandbox: MappedSandbox): string[] {
  const tools = ['Read', 'Bash'];
  if (sandbox.mode !== 'read-only') tools.push('Edit', 'Write');
  if (sandbox.network) tools.push('WebSearch');
  return tools;
}

const defaultSpawn: SpawnFn = (command, args, options) =>
  spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once('close', (code) => resolve(code));
    child.once('error', () => resolve(null));
  });
}
