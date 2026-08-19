import type {
  CapabilityManifest,
  ControlCommand,
  ErrorClass,
  RunEvent,
  RunStatus,
  TaskDispatch,
} from '@apos/contracts';

export type Unsubscribe = () => void | Promise<void>;

/**
 * 运行时拒收派发的原因码 / Why a runtime refused a dispatch.
 *
 * ★★ 拒收理由是**用户要照着做的话**，所以必须是码。
 *
 *   此前只有 `rejectReason` 一句中文，而它现在会一路显示到任务卡片上
 *   （拒收终于走 run_ended 之后）。一句中文在英文界面上已经够糟，
 *   更糟的是它没法带「怎么修」的入口 —— 三种拒收的下一步动作完全不同：
 *   缺凭证去 Agent 配置、没工作区去登记工作区来源、没工具去改能力档案。
 */
export type DispatchRejectCode =
  | 'missing_credential'
  | 'no_workspace'
  | 'no_tools'
  | 'unsupported_task';

export interface DispatchAck {
  externalRunId: string;
  accepted: boolean;
  /** 拒收原因码 —— 界面按它取词并给出修复入口 */
  rejectCode?: DispatchRejectCode;
  /**
   * @deprecated 中文兜底句 / Chinese fallback.
   *   带着码里放不下的细节（缺的是哪个环境变量），日志与排查靠它。
   */
  rejectReason?: string;
}

export interface RuntimeStatus {
  status: RunStatus;
  /** 运行时侧观察到的最后活动时间，用于孤儿判定 */
  lastActivityAt: string | null;
}

/**
 * Agent 运行时适配器 —— docs/tech/06-agent-protocol.md §9.1
 *
 * 每个适配器负责把某个具体运行时（Claude Code / MCP / 自建 HTTP）
 * 的行为归一化成统一协议。
 */
export interface AgentRuntimeAdapter {
  readonly kind: string;

  getCapabilities(): Promise<CapabilityManifest>;

  dispatch(task: TaskDispatch): Promise<DispatchAck>;

  /**
   * 订阅事件流。适配器负责保证 seq 单调递增。
   * 不支持流式的运行时在此处轮询并合成事件。
   */
  subscribe(runId: string, onEvent: (e: RunEvent) => Promise<void>): Promise<Unsubscribe>;

  /** 孤儿 Run 接管时探测真实状态；不支持时抛 UnsupportedFeatureError */
  queryStatus(runId: string): Promise<RuntimeStatus>;

  control(runId: string, cmd: ControlCommand): Promise<void>;
}

export class UnsupportedFeatureError extends Error {
  constructor(
    readonly feature: string,
    readonly runtimeKind: string,
  ) {
    super(`运行时 ${runtimeKind} 不支持 ${feature}`);
    this.name = 'UnsupportedFeatureError';
  }
}

/**
 * 启发式错误分类 —— 运行时不上报分类时的降级路径。
 *
 * ⚠ 结果不可靠，因此调用方要把 classificationSource 标为 'inferred'，
 *   并对这类 Agent 采用更保守的恢复策略（更早转人工）。
 */
const PATTERNS: [RegExp, ErrorClass][] = [
  [/permission|forbidden|unauthor|access denied|EACCES/i, 'permission_denied'],
  [/timeout|timed out|deadline exceeded|ETIMEDOUT/i, 'timeout'],
  [/budget|quota|cost limit|rate limit exceeded/i, 'budget_exceeded'],
  [/not found|cannot find|no such file|missing context|insufficient context/i, 'context_insufficient'],
  [/ECONNREFUSED|ENOTFOUND|503|502|service unavailable|upstream/i, 'external_unavailable'],
  [/tool .* failed|tool error|command failed|exit code [1-9]/i, 'tool_failure'],
  [/cannot|unable to|not capable|unsupported operation/i, 'capability_mismatch'],
  [/contradict|conflicting|ambiguous|invalid task/i, 'invalid_task'],
];

export function classifyError(message: string): ErrorClass {
  for (const [pattern, cls] of PATTERNS) {
    if (pattern.test(message)) return cls;
  }
  return 'unknown';
}

/** 能力缺失时的默认清单，用于未声明字段的保守填充 */
export function conservativeFeatures(): CapabilityManifest['features'] {
  return {
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
    terminate: false,
    statusQuery: false,
    subAgentDelegation: false,
    artifactUpload: false,
  };
}
