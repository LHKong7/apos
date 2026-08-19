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
import { mapSandbox, type MappedSandbox } from '../codex/permissions';
import { CliOutputTranslator } from './translate';
import type { CliProfile } from './profile';

export type CliSpawnFn = (
  command: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

export interface GenericCliOptions {
  /** Agent 自己的凭证，绝不复用平台/人类的 key */
  apiKey?: string;
  /** 只在 Agent 没登记凭证时才允许沿用进程环境 */
  allowInheritedCredentials?: boolean;
  baseUrl?: string;
  model?: string;
  /** 覆盖 profile 里的默认可执行文件名 */
  binary?: string;
  /** 追加到 argv 末尾的原始参数 */
  extraArgs?: string[];
  passthroughEnv?: string[];
  /**
   * 用户直接给出值的环境变量表（配置里的 `env` JSON）。
   * ★ 最后应用，会盖掉上面各项算出来的同名变量 —— 填了就一定生效。
   */
  env?: Record<string, string>;
  /** 注入 spawn，测试用 */
  spawnFn?: CliSpawnFn;
  onDiagnostic?: (message: string, detail?: unknown) => void;
}

interface RunState {
  task: TaskDispatch;
  sandbox: MappedSandbox;
  translator: CliOutputTranslator;
  child: ChildProcessWithoutNullStreams | null;
  status: RunStatus;
  lastActivityAt: string | null;
  seq: number;
  chain: Promise<void>;
  closed: boolean;
  stopReason: 'terminate' | 'timeout' | 'detach' | null;
  stderrTail: string[];
  ended: boolean;
  emit: (body: RunEventBody) => Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * 通用 headless CLI 运行时。
 *
 * ★★ 一个类承载六个 CLI（pi / gemini / aider / goose / opencode / qwen），
 *   差异全部在 {@link CliProfile} 那张声明式的表里。
 *
 *   这不是为了少写代码，是因为**共通的那部分才是容易写错的部分**：
 *   子进程要在超时后先 SIGTERM 再补 SIGKILL（否则留下继续烧钱的孤儿）、
 *   环境变量要白名单而不是 `{...process.env}`（否则平台密钥全交给了 Agent）、
 *   事件要按 seq 串行投递（否则前端收到乱序的状态）、
 *   detach 之后不能再发事件（否则订阅者已经走了还在往里写）。
 *   这些在 codex 适配器上已经踩过一遍，抄六份等于给自己留六处各自出错的机会。
 *
 * ★★ 三处对所有 CLI 都成立的降级，如实写进能力清单而不是假装能做：
 *
 *   1. **权限是沙箱级的**。这六个都没有工具级授权通道，表达不了
 *      「Bash 可用但 rm 不可用」。复用 codex 的 mapSandbox 一律收紧，
 *      并把表达不了的规则列出来（下面 subscribe 里那条 note）。
 *   2. **没有 system prompt 通道**。治理规则只能折进用户消息最前面，
 *      权重低于真正的 system prompt。
 *   3. **单次执行、无中途注入**。起跑后没有输入通道，所以
 *      runtimeConstraints / interventionRequest 都是 false。
 */
export class GenericCliRuntime implements AgentRuntimeAdapter {
  readonly kind: string;

  private runs = new Map<string, RunState>();
  private byIdempotencyKey = new Map<string, string>();

  constructor(
    private readonly profile: CliProfile,
    private readonly options: GenericCliOptions = {},
  ) {
    this.kind = profile.kind;
  }

  async getCapabilities(): Promise<CapabilityManifest> {
    const models = this.modelFor(null) ? [this.modelFor(null)!] : [];
    return {
      protocolVersion: PROTOCOL_VERSION,
      runtime: { name: this.profile.binary, version: 'unknown' },
      features: {
        streamingEvents: false,
        toolCallVisibility: false,
        reasoningVisibility: false,
        costReporting: false,
        tokenReporting: false,
        progressReporting: false,
        runtimeConstraints: false,
        interventionRequest: false,
        selfReportOnFailure: false,
        pause: false,
        terminate: true,
        statusQuery: true,
        subAgentDelegation: false,
        artifactUpload: false,
        ...this.profile.features,
      },
      transport: { eventDelivery: 'sse', heartbeatIntervalSeconds: 30 },
      /**
       * ★ 工具清单按沙箱能做什么给，不按「这个 CLI 内部有哪些工具」给 ——
       *   后者我们不知道，各家也不统一。这里回答的是「它被允许做什么」。
       */
      tools: [
        { name: 'Read', description: '读取文件（沙箱内）', sideEffects: 'read' as const },
        { name: 'Edit', description: '修改文件（可写沙箱下）', sideEffects: 'write' as const },
        { name: 'Bash', description: '执行命令（沙箱内）', sideEffects: 'destructive' as const },
      ],
      models,
      limits: { maxConcurrentRuns: 3, maxRunDurationSeconds: 7200, maxContextTokens: 200_000 },
    };
  }

  async dispatch(task: TaskDispatch): Promise<DispatchAck> {
    const existing = this.byIdempotencyKey.get(task.idempotencyKey);
    if (existing) return { externalRunId: this.externalId(existing), accepted: true };

    /**
     * ★ credentialEnv 为 null 表示该 CLI 自己管登录态（OAuth 缓存之类），
     *   平台不该拦。其余情况没凭证就明确拒绝 —— 让它跑起来再失败，
     *   报错会是 CLI 自己那句没人看得懂的鉴权错误。
     */
    /**
     * ★ 环境变量表里直接给出凭证变量也算配齐了 —— 接中转站时凭证常常写在那里，
     *   此时 credentialRef 是空的。只认凭证栏的话，一个配好了、也确实能跑的
     *   Agent 会被拒发，而报错还理直气壮地让人去登记凭证。
     */
    const credentialInEnv = Boolean(
      this.profile.credentialEnv && (this.options.env ?? {})[this.profile.credentialEnv],
    );
    if (this.profile.credentialEnv && !this.resolveCredential() && !credentialInEnv) {
      return {
        externalRunId: this.externalId(task.runId),
        accepted: false,
        rejectCode: 'missing_credential',
        rejectReason:
          `未配置 Agent 凭证：请为「${this.profile.label}」登记凭证（不要复用平台凭证），` +
          `或设置 ${this.profile.dedicatedEnv ?? '专用环境变量'}，` +
          `也可以在环境变量表里直接给出 ${this.profile.credentialEnv}。`,
      };
    }

    if (!task.workspace) {
      return {
        externalRunId: this.externalId(task.runId),
        accepted: false,
        rejectCode: 'no_workspace',
        /**
         * ★ 兜底句里的指路也改了：原话让人去配「repo 资源范围」，
         *   而那三列（allowed_tools / denied_tools / resource_scopes）
         *   早已退役 —— 照着做找不到那个东西。现在的路径是
         *   「工作区来源」登记 + 在项目里把该资源授给这个 Agent。
         */
        rejectReason:
          `${this.profile.label} 必须在一个已准备好的工作目录里执行：` +
          '请先在「工作区来源」里登记这个仓库或目录，再到项目的 Agent 设置里把它授权给该 Agent。',
      };
    }

    this.runs.set(task.runId, {
      task,
      sandbox: mapSandbox(task.permissions, task.workspace.writable),
      translator: new CliOutputTranslator({ format: this.profile.output, kind: this.profile.label }),
      child: null,
      status: 'queued',
      lastActivityAt: null,
      seq: 0,
      chain: Promise.resolve(),
      closed: false,
      stopReason: null,
      stderrTail: [],
      ended: false,
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
      model: this.modelFor(state.task) ?? this.profile.binary,
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
          `⚠ ${this.profile.label} 的权限粒度是沙箱级（${state.sandbox.mode}），以下 ${state.sandbox.unenforceable.length} 条限制无法逐项执行：`,
          ...state.sandbox.unenforceable.map((u) => `- ${u.rule}：${u.why}`),
        ].join('\n'),
      });
    }

    /**
     * ★ 输出形态不支持流式时先说一声。否则用户盯着一个一直没动静的
     *   执行流，只会以为卡死了 —— 而它其实在正常跑，只是要跑完才有输出。
     */
    if (this.profile.output === 'json') {
      await state.emit({
        type: 'note',
        text: `${this.profile.label} 只在进程结束后一次性输出结果，执行过程中不会有中间事件。`,
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
      const child = spawnFn(this.binary(), this.args(state), {
        cwd: task.workspace?.path,
        env: this.childEnv(),
      });
      state.child = child;

      /**
       * ★ 无论 prompt 走哪条路，stdin 都要关掉。
       *   不关的话 CLI 会以为还有输入，一直等到超时 —— 而它看起来完全正常，
       *   只是不动。这是非交互调用最常见的挂起原因。
       */
      if (this.profile.promptDelivery === 'stdin') {
        child.stdin.write(this.fullPrompt(state));
      }
      child.stdin.end();

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        state.stderrTail.push(text);
        if (state.stderrTail.length > 20) state.stderrTail.shift();
        this.diagnose(`[${this.kind}:${task.runId}] ${text.trimEnd()}`);
      });

      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      for await (const line of lines) {
        state.lastActivityAt = new Date().toISOString();
        for (const body of state.translator.line(line)) await state.emit(body);
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
    if (state.ended) return;
    state.ended = true;

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
          class: notFound ? 'capability_mismatch' : 'runtime_error',
          message: notFound
            ? `未找到 ${this.binary()} 可执行文件：${message}`
            : `${this.profile.label} 执行异常：${message}`,
          retriable: !notFound,
          /**
           * ★ 没装就把安装命令直接给出来。让运维去搜「这个 CLI 怎么装」
           *   是把一条本来一行就能解决的信息藏起来。
           */
          selfReport: notFound
            ? `部署环境没有安装 ${this.profile.label}。安装方式：${this.profile.installHint}`
            : undefined,
          classificationSource: 'inferred' as const,
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

  private binary(): string {
    return this.options.binary || this.profile.binary;
  }

  private args(state: RunState): string[] {
    const args = this.profile.buildArgs({
      sandbox: state.sandbox,
      model: this.modelFor(state.task),
      workspacePath: state.task.workspace?.path ?? null,
      extraArgs: this.options.extraArgs ?? [],
    });

    const delivery = this.profile.promptDelivery;
    if (delivery === 'arg') return [...args, this.fullPrompt(state)];
    if (typeof delivery === 'object') return [...args, delivery.flag, this.fullPrompt(state)];
    return args; // stdin
  }

  /** 治理规则 + 人设折进用户消息最前面 —— 这些 CLI 都没有 system prompt 通道 */
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
    };
    const credential = this.resolveCredential();
    if (this.profile.credentialEnv && credential) env[this.profile.credentialEnv] = credential;
    if (this.profile.baseUrlEnv && this.options.baseUrl) {
      env[this.profile.baseUrlEnv] = this.options.baseUrl;
    }
    for (const key of this.options.passthroughEnv ?? []) env[key] = process.env[key];
    // ★ 用户填的排最后：填了就一定生效
    for (const [key, value] of Object.entries(this.options.env ?? {})) env[key] = value;
    return env;
  }

  private resolveCredential(): string | null {
    if (this.options.apiKey) return this.options.apiKey;
    const dedicated = this.profile.dedicatedEnv ? process.env[this.profile.dedicatedEnv] : undefined;
    if (dedicated) return dedicated;
    if (this.options.allowInheritedCredentials && this.profile.inheritEnv) {
      return process.env[this.profile.inheritEnv] ?? null;
    }
    return null;
  }

  private modelFor(task: TaskDispatch | null): string | null {
    return task?.model ?? this.options.model ?? this.profile.defaultModel;
  }

  private externalId(runId: string): string {
    return `${this.kind}:${runId}`;
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

const defaultSpawn: CliSpawnFn = (command, args, options) =>
  spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once('close', (code) => resolve(code));
    child.once('error', () => resolve(null));
  });
}
