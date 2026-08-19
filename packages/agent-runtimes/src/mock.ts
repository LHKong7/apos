import {
  PROTOCOL_VERSION,
  type CapabilityManifest,
  type ControlCommand,
  type RunEvent,
  type RunEventBody,
  type TaskDispatch,
} from '@apos/contracts';
import {
  UnsupportedFeatureError,
  type AgentRuntimeAdapter,
  type DispatchAck,
  type RuntimeStatus,
  type Unsubscribe,
} from './adapter';

export interface MockScript {
  /** 模拟的执行步骤，每步产生一条 progress + tool_call 事件 */
  steps?: string[];
  /** 产出的产物 */
  artifacts?: { kind: string; title: string; url?: string }[];
  outcome?: 'completed' | 'failed';
  error?: { class: string; message: string; selfReport?: string; retriable?: boolean };
  costPerStep?: number;
  /** 每步之间的模拟延迟，测试里设 0 */
  stepDelayMs?: number;
  /**
   * 让 dispatch 直接拒收，值就是拒收理由。
   *
   * ★ 真实运行时最常见的失败不是「跑挂了」而是「压根没接」——
   *   缺凭证、没有可用工具、工作目录没准备好。这三种都在 dispatch
   *   就返回 accepted:false，走的是与执行失败完全不同的代码路径，
   *   而那条路径此前没有任何测试覆盖。
   *
   * Rejects at dispatch time rather than failing mid-run: a distinct code
   * path that real adapters hit far more often than an in-flight failure.
   */
  rejectDispatch?: string;
}

/**
 * 内存运行时 —— 用于测试与本地演示。
 *
 * 它实现完整的协议能力，因此可以验证「能力齐全时」的主路径；
 * 需要验证降级行为时用 {@link degradedMockRuntime}。
 */
export class MockRuntime implements AgentRuntimeAdapter {
  readonly kind = 'mock';

  private scripts = new Map<string, MockScript>();
  private dispatched = new Map<string, TaskDispatch>();
  private controls = new Map<string, ControlCommand[]>();
  private terminated = new Set<string>();

  constructor(
    private readonly features: Partial<CapabilityManifest['features']> = {},
    private readonly defaultScript: MockScript = {},
  ) {}

  /** 为某个 Run 预设脚本；未预设时用默认脚本 */
  setScript(runId: string, script: MockScript) {
    this.scripts.set(runId, script);
  }

  controlsFor(runId: string): ControlCommand[] {
    return this.controls.get(runId) ?? [];
  }

  dispatchedTask(runId: string): TaskDispatch | undefined {
    return this.dispatched.get(runId);
  }

  async getCapabilities(): Promise<CapabilityManifest> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      runtime: { name: 'mock', version: '1.0.0' },
      features: {
        streamingEvents: true,
        toolCallVisibility: true,
        reasoningVisibility: true,
        costReporting: true,
        tokenReporting: true,
        progressReporting: true,
        runtimeConstraints: true,
        interventionRequest: true,
        selfReportOnFailure: true,
        pause: true,
        terminate: true,
        statusQuery: true,
        subAgentDelegation: false,
        artifactUpload: true,
        ...this.features,
      },
      transport: { eventDelivery: 'sse', heartbeatIntervalSeconds: 30 },
      tools: [
        { name: 'read_file', description: '读取文件', sideEffects: 'read' },
        { name: 'write_file', description: '写入文件', sideEffects: 'write' },
        { name: 'run_tests', description: '运行测试', sideEffects: 'read' },
        { name: 'create_pr', description: '创建 PR', sideEffects: 'external' },
        { name: 'merge_pr', description: '合并 PR', sideEffects: 'destructive' },
      ],
      models: ['claude-opus-5'],
      limits: {
        maxConcurrentRuns: 10,
        maxRunDurationSeconds: 1800,
        maxContextTokens: 200_000,
      },
    };
  }

  async dispatch(task: TaskDispatch): Promise<DispatchAck> {
    this.dispatched.set(task.runId, task);
    const reject = (this.scripts.get(task.runId) ?? this.defaultScript).rejectDispatch;
    if (reject !== undefined) {
      return { externalRunId: `mock-${task.runId}`, accepted: false, rejectReason: reject };
    }
    return { externalRunId: `mock-${task.runId}`, accepted: true };
  }

  async subscribe(runId: string, onEvent: (e: RunEvent) => Promise<void>): Promise<Unsubscribe> {
    const script = this.scripts.get(runId) ?? this.defaultScript;
    const steps = script.steps ?? ['分析现状', '实现逻辑', '补充测试'];
    const costPerStep = script.costPerStep ?? 0.5;
    const outcome = script.outcome ?? 'completed';

    let seq = 0;
    let total = 0;
    const ts = () => new Date().toISOString();
    const next = () => ({ runId, seq: seq++, ts: ts() });

    const emit = async (body: RunEventBody) => {
      if (this.terminated.has(runId)) return;
      await onEvent({ ...next(), ...body } as RunEvent);
    };

    // 事件流在下一个 tick 开始，让调用方有机会先完成 dispatch 的事务
    queueMicrotask(async () => {
      try {
        await emit({ type: 'run_started', model: 'claude-opus-5', toolsAvailable: ['read_file'] });

        for (const [i, step] of steps.entries()) {
          if (this.terminated.has(runId)) return;
          if (script.stepDelayMs) await sleep(script.stepDelayMs);

          await emit({
            type: 'progress',
            step: i + 1,
            totalSteps: steps.length,
            description: step,
          });
          await emit({
            type: 'tool_call',
            toolCallId: `tc-${i}`,
            tool: 'read_file',
            params: { path: `src/step-${i}.ts` },
          });
          total += costPerStep;
          await emit({
            type: 'cost',
            deltaUsd: costPerStep,
            totalUsd: total,
            tokens: { input: 1000, output: 200, cacheRead: 500, cacheWrite: 300 },
          });
        }

        if (outcome === 'failed') {
          const err = script.error ?? { class: 'unknown', message: '模拟失败' };
          await emit({
            type: 'error',
            error: {
              class: err.class as never,
              message: err.message,
              retriable: err.retriable ?? true,
              selfReport: err.selfReport,
              classificationSource: 'reported',
            },
          });
          await emit({ type: 'run_ended', outcome: 'failed', summary: err.message });
          return;
        }

        for (const a of script.artifacts ?? [{ kind: 'pull_request', title: 'PR #42' }]) {
          await emit({
            type: 'artifact',
            artifact: {
              kind: a.kind as never,
              title: a.title,
              externalUrl: a.url ?? null,
              content: null,
              metadata: {},
            },
          });
        }

        await emit({
          type: 'run_ended',
          outcome: 'completed',
          summary: `完成 ${steps.length} 个步骤`,
        });
      } catch {
        // 订阅者异常不应让 mock 进程崩溃；真实适配器同理
      }
    });

    return () => {
      this.terminated.add(runId);
    };
  }

  async queryStatus(runId: string): Promise<RuntimeStatus> {
    if (!(await this.getCapabilities()).features.statusQuery) {
      throw new UnsupportedFeatureError('statusQuery', this.kind);
    }
    return {
      status: this.terminated.has(runId) ? 'terminated' : 'running',
      lastActivityAt: new Date().toISOString(),
    };
  }

  async control(runId: string, cmd: ControlCommand): Promise<void> {
    const features = (await this.getCapabilities()).features;
    if (cmd.action === 'terminate' && !features.terminate) {
      throw new UnsupportedFeatureError('terminate', this.kind);
    }
    if (cmd.action === 'pause' && !features.pause) {
      throw new UnsupportedFeatureError('pause', this.kind);
    }
    if (cmd.action === 'add_constraint' && !features.runtimeConstraints) {
      throw new UnsupportedFeatureError('runtimeConstraints', this.kind);
    }

    this.controls.set(runId, [...(this.controls.get(runId) ?? []), cmd]);
    if (cmd.action === 'terminate') this.terminated.add(runId);
  }
}

/** 能力残缺的运行时，用于验证降级路径 */
export function degradedMockRuntime(script: MockScript = {}): MockRuntime {
  return new MockRuntime(
    {
      costReporting: false,
      progressReporting: false,
      runtimeConstraints: false,
      selfReportOnFailure: false,
      // 真实的降级运行时（如 Claude Code）没有暂停语义，
      // 「残缺」的 mock 却支持暂停会让降级路径测不出来
      pause: false,
      terminate: false,
      statusQuery: false,
    },
    script,
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
