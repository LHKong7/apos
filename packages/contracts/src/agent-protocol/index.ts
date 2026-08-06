import { z } from 'zod';

/**
 * 统一 Agent Protocol —— 产品文档 9.3 / docs/tech/06-agent-protocol.md
 *
 * 核心设计不是「规定所有 Agent 必须做什么」，而是协商每个 Agent 能做什么，
 * 并对缺失能力定义明确的降级行为。
 */

export const PROTOCOL_VERSION = '1.0';

export const RuntimeFeatures = z.object({
  streamingEvents: z.boolean(),
  toolCallVisibility: z.boolean(),
  reasoningVisibility: z.boolean(),
  costReporting: z.boolean(),
  tokenReporting: z.boolean(),
  progressReporting: z.boolean(),
  /** 执行中注入约束 */
  runtimeConstraints: z.boolean(),
  /** Agent 主动请求人工介入 */
  interventionRequest: z.boolean(),
  /** 失败时用自然语言解释为什么卡住 */
  selfReportOnFailure: z.boolean(),
  pause: z.boolean(),
  terminate: z.boolean(),
  /** 支持主动查询状态——孤儿 Run 接管需要 */
  statusQuery: z.boolean(),
  subAgentDelegation: z.boolean(),
  artifactUpload: z.boolean(),
});
export type RuntimeFeatures = z.infer<typeof RuntimeFeatures>;

export type FeatureKey = keyof RuntimeFeatures;

export interface Degradation {
  behavior: string;
  userImpact: string;
  severity: 'info' | 'warning' | 'critical';
}

/**
 * 降级矩阵 —— docs/tech/06-agent-protocol.md §3.1
 * 页面文档 14 §5.4 直接展示这张表，不静默降级。
 */
export const DEGRADATION_MATRIX: Record<FeatureKey, Degradation> = {
  streamingEvents: {
    behavior: '仅在 Run 结束时写一条汇总事件',
    userImpact: 'Run 详情页无实时执行流，卡片无进度条',
    severity: 'warning',
  },
  toolCallVisibility: {
    behavior: '执行流只记录开始与结束',
    userImpact: '排障困难，页面提示「该 Agent 不上报执行细节」',
    severity: 'warning',
  },
  reasoningVisibility: {
    behavior: '不记录推理过程',
    userImpact: '无法查看 Agent 的判断依据',
    severity: 'info',
  },
  costReporting: {
    behavior: '按 token × 单价估算；无 token 则按时长粗估',
    userImpact: '成本标注为「估算值」',
    severity: 'warning',
  },
  tokenReporting: {
    behavior: '不记录 token 明细',
    userImpact: '成本构成不可下钻',
    severity: 'info',
  },
  progressReporting: {
    behavior: '不显示百分比，只显示已耗时',
    userImpact: '卡片显示「执行中 12m」而非进度条',
    severity: 'info',
  },
  runtimeConstraints: {
    behavior: '「增加约束」不可用',
    userImpact: '需改用「终止并补充上下文重跑」',
    severity: 'warning',
  },
  interventionRequest: {
    behavior: 'Agent 无法主动求助，靠超时与失败检测兜底',
    userImpact: '卡住的任务发现更晚',
    severity: 'warning',
  },
  selfReportOnFailure: {
    behavior: '错误信息只有原始报错',
    userImpact: '排障效率降低',
    severity: 'warning',
  },
  pause: {
    behavior: '暂停降级为终止',
    userImpact: '会丢失执行中的进度，操作前需二次确认',
    severity: 'warning',
  },
  terminate: {
    behavior: '只能标记本地状态，外部可能仍在运行',
    userImpact: '存在成本泄漏风险，禁止用于高风险任务',
    severity: 'critical',
  },
  statusQuery: {
    behavior: '孤儿 Run 无法探测真实状态，超时后直接判失败',
    userImpact: '可能误判仍在运行的 Run',
    severity: 'warning',
  },
  subAgentDelegation: {
    behavior: '不支持委派子 Agent',
    userImpact: '复杂任务需人工拆分',
    severity: 'info',
  },
  artifactUpload: {
    behavior: '产物需通过外部链接引用',
    userImpact: '产物不能内联预览',
    severity: 'info',
  },
};

export const CapabilityManifest = z.object({
  protocolVersion: z.string(),
  runtime: z.object({ name: z.string(), version: z.string() }),
  features: RuntimeFeatures,
  transport: z.object({
    eventDelivery: z.enum(['sse', 'webhook', 'poll']),
    heartbeatIntervalSeconds: z.number().int().positive().nullable(),
  }),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      sideEffects: z.enum(['none', 'read', 'write', 'destructive', 'external']),
    }),
  ),
  models: z.array(z.string()),
  limits: z.object({
    maxConcurrentRuns: z.number().int().positive(),
    maxRunDurationSeconds: z.number().int().positive(),
    maxContextTokens: z.number().int().positive().nullable(),
  }),
});
export type CapabilityManifest = z.infer<typeof CapabilityManifest>;

export const ResourceScope = z.object({
  kind: z.enum(['repo', 'env', 'database', 'external_service', 'dataset']),
  ref: z.string(),
  access: z.enum(['none', 'read', 'write']),
});
export type ResourceScope = z.infer<typeof ResourceScope>;

export const AgentPermissions = z.object({
  allowedTools: z.array(z.string()),
  /** 黑名单优先级高于白名单，不可被模板或继承覆盖 */
  deniedTools: z.array(z.string()),
  resourceScopes: z.array(ResourceScope),
});
export type AgentPermissions = z.infer<typeof AgentPermissions>;

export const TaskDispatch = z.object({
  runId: z.string().uuid(),
  /** 重复派发保护 */
  idempotencyKey: z.string(),
  goal: z.object({
    title: z.string(),
    description: z.string(),
    acceptanceCriteria: z.array(z.object({ id: z.string(), text: z.string() })),
    constraints: z.array(
      z.object({ type: z.string(), value: z.unknown(), description: z.string() }),
    ),
  }),
  context: z.array(
    z.object({
      kind: z.enum(['requirement', 'knowledge', 'file', 'previous_run', 'decision', 'external']),
      ref: z.string(),
      title: z.string(),
      content: z.string().optional(),
      uri: z.string().optional(),
      priority: z.enum(['must_read', 'reference']),
      /** 外部来源的内容在 prompt 中标注为不可信（docs/tech/09-security.md §7.1） */
      trusted: z.boolean().default(true),
    }),
  ),
  /** 权限显式下发，不依赖运行时侧配置（docs/tech/06 §4） */
  permissions: AgentPermissions,
  limits: z.object({
    maxCostUsd: z.number().positive(),
    maxDurationSeconds: z.number().int().positive(),
    maxTokens: z.number().int().positive().nullable(),
  }),
  model: z.string().nullable(),
  callback: z.object({ eventsUrl: z.string(), token: z.string() }),
});
export type TaskDispatch = z.infer<typeof TaskDispatch>;

/**
 * 错误分类 —— 恢复策略完全依赖它。
 * 分类错了，恢复策略就退化成无差别重试：既烧钱又解决不了问题。
 */
export const ErrorClass = z.enum([
  'context_insufficient',
  'capability_mismatch',
  'tool_failure',
  'permission_denied',
  'external_unavailable',
  'timeout',
  'budget_exceeded',
  'invalid_task',
  'runtime_error',
  'unknown',
]);
export type ErrorClass = z.infer<typeof ErrorClass>;

export const AgentError = z.object({
  class: ErrorClass,
  message: z.string(),
  detail: z.unknown().optional(),
  retriable: z.boolean(),
  /** 面向人类的自述：为什么卡住、需要什么 */
  selfReport: z.string().optional(),
  /** 'reported' = 运行时给的；'inferred' = 适配器从错误消息推断，可靠性低 */
  classificationSource: z.enum(['reported', 'inferred']).default('reported'),
});
export type AgentError = z.infer<typeof AgentError>;

export const InterventionRequest = z.object({
  reason: z.enum([
    'ambiguous_requirement',
    'permission_needed',
    'risky_operation',
    'conflicting_information',
    'low_confidence',
    'external_blocker',
  ]),
  question: z.string(),
  options: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        description: z.string(),
        consequence: z.string(),
      }),
    )
    .optional(),
  recommendation: z
    .object({ optionId: z.string(), confidence: z.number(), rationale: z.string() })
    .optional(),
  urgency: z.enum(['blocking', 'can_continue']),
});
export type InterventionRequest = z.infer<typeof InterventionRequest>;

export const ArtifactPayload = z.object({
  kind: z.enum([
    'code',
    'pull_request',
    'test_report',
    'document',
    'design',
    'data_analysis',
    'screenshot',
    'deployment',
    'release_note',
  ]),
  title: z.string(),
  externalUrl: z.string().nullable(),
  content: z.string().nullable(),
  metadata: z.record(z.unknown()).default({}),
});
export type ArtifactPayload = z.infer<typeof ArtifactPayload>;

const RunEventBase = z.object({
  runId: z.string().uuid(),
  /** 单 Run 内单调递增，(runId, seq) 天然去重 */
  seq: z.number().int().min(0),
  ts: z.string().datetime(),
});

export const RunEvent = z.discriminatedUnion('type', [
  RunEventBase.extend({
    type: z.literal('run_started'),
    model: z.string(),
    toolsAvailable: z.array(z.string()),
  }),
  RunEventBase.extend({
    type: z.literal('context_loaded'),
    items: z.array(z.object({ ref: z.string(), tokens: z.number(), used: z.boolean() })),
  }),
  RunEventBase.extend({
    type: z.literal('progress'),
    step: z.number().int(),
    totalSteps: z.number().int().nullable(),
    description: z.string(),
  }),
  RunEventBase.extend({
    type: z.literal('reasoning'),
    summary: z.string(),
    detail: z.string().optional(),
  }),
  RunEventBase.extend({
    type: z.literal('tool_call'),
    toolCallId: z.string(),
    tool: z.string(),
    params: z.unknown(),
  }),
  RunEventBase.extend({
    type: z.literal('tool_result'),
    toolCallId: z.string(),
    ok: z.boolean(),
    summary: z.string(),
    detail: z.unknown().optional(),
  }),
  RunEventBase.extend({ type: z.literal('artifact'), artifact: ArtifactPayload }),
  RunEventBase.extend({
    type: z.literal('delegation'),
    childRunId: z.string(),
    agentRef: z.string(),
    goal: z.string(),
  }),
  RunEventBase.extend({
    type: z.literal('cost'),
    deltaUsd: z.number(),
    totalUsd: z.number(),
    tokens: z.object({ input: z.number(), output: z.number(), cacheRead: z.number() }),
  }),
  RunEventBase.extend({
    type: z.literal('intervention_request'),
    request: InterventionRequest,
  }),
  RunEventBase.extend({ type: z.literal('note'), text: z.string() }),
  RunEventBase.extend({ type: z.literal('heartbeat') }),
  RunEventBase.extend({ type: z.literal('error'), error: AgentError }),
  RunEventBase.extend({
    type: z.literal('run_ended'),
    outcome: z.enum(['completed', 'failed', 'terminated']),
    summary: z.string(),
    selfReport: z.string().optional(),
  }),
]);
export type RunEvent = z.infer<typeof RunEvent>;
export type RunEventType = RunEvent['type'];

/** Omit 不会在联合类型上分配，需要这个包装才能保留判别联合的收窄能力 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 事件体，不含由发送方填充的 runId / seq / ts */
export type RunEventBody = DistributiveOmit<RunEvent, 'runId' | 'seq' | 'ts'>;

/** 哪些 run_events 提升为领域事件（docs/tech/06 §5.1） */
export const PROMOTED_RUN_EVENTS: Record<RunEventType, string | null> = {
  run_started: 'agent_run.started',
  artifact: 'artifact.produced',
  intervention_request: 'decision.created',
  run_ended: null, // 按 outcome 分派，见 §5.1
  cost: null, // 仅在触及阈值时提升
  context_loaded: null,
  progress: null,
  reasoning: null,
  tool_call: null,
  tool_result: null,
  delegation: null,
  note: null,
  heartbeat: null,
  error: null,
};

/** 里程碑级事件在简明模式下展示（页面文档 09 §5.3） */
export const MILESTONE_RUN_EVENTS: readonly RunEventType[] = [
  'run_started',
  'artifact',
  'intervention_request',
  'error',
  'run_ended',
] as const;

export const ControlCommand = z.union([
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('resume') }),
  z.object({ action: z.literal('terminate'), reason: z.string() }),
  z.object({
    action: z.literal('add_constraint'),
    constraint: z.object({ type: z.string(), value: z.unknown(), description: z.string() }),
  }),
]);
export type ControlCommand = z.infer<typeof ControlCommand>;

export const RunStatus = z.enum([
  'queued',
  'dispatching',
  'running',
  'paused',
  'completed',
  'failed',
  'timeout',
  'terminated',
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'dispatching',
  'running',
  'paused',
] as const;
