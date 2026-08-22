import { z } from 'zod';

/**
 * 统一 Agent Protocol —— 产品文档 9.3 / docs/tech/06-agent-protocol.md
 *
 * 核心设计不是「规定所有 Agent 必须做什么」，而是协商每个 Agent 能做什么，
 * 并对缺失能力定义明确的降级行为。
 *
 * The unified Agent Protocol — product doc 9.3 /
 * docs/tech/06-agent-protocol.md
 *
 * The design is not "dictate what every Agent must do" but "negotiate what
 * each Agent can do", with an explicit degradation defined for every missing
 * capability.
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
  /** 英文对照；缺省时界面回落中文 / English counterpart, falls back to `behavior` */
  behaviorEn?: string;
  userImpact: string;
  /** 英文对照；缺省时界面回落中文 / English counterpart, falls back to `userImpact` */
  userImpactEn?: string;
  severity: 'info' | 'warning' | 'critical';
}

/**
 * 降级矩阵 —— docs/tech/06-agent-protocol.md §3.1
 * 页面文档 14 §5.4 直接展示这张表，不静默降级。
 *
 * The degradation matrix — docs/tech/06-agent-protocol.md §3.1
 * Page doc 14 §5.4 shows this table verbatim: nothing degrades silently.
 */
export const DEGRADATION_MATRIX: Record<FeatureKey, Degradation> = {
  streamingEvents: {
    behavior: '仅在 Run 结束时写一条汇总事件',
    behaviorEn: 'Writes one summary event when the run ends',
    userImpact: 'Run 详情页无实时执行流，卡片无进度条',
    userImpactEn: 'No live event stream on the run detail page, and no progress bar on the card',
    severity: 'warning',
  },
  toolCallVisibility: {
    behavior: '执行流只记录开始与结束',
    behaviorEn: 'The event stream records only the start and the end',
    userImpact: '排障困难，页面提示「该 Agent 不上报执行细节」',
    userImpactEn: 'Hard to diagnose; the page says "this Agent does not report execution detail"',
    severity: 'warning',
  },
  reasoningVisibility: {
    behavior: '不记录推理过程',
    behaviorEn: 'Reasoning is not recorded',
    userImpact: '无法查看 Agent 的判断依据',
    userImpactEn: 'You cannot see what the Agent based its judgment on',
    severity: 'info',
  },
  /**
   * ★ 这两条的严重性在换成 token 记账后对调了。
   *   美元现在只是参考值，缺了它不影响任何判定；
   *   token 才是上限、预算与 Analytics 的计量基础，缺了它全线失灵。
   */
  costReporting: {
    behavior: '按 token × 单价估算美元参考值',
    behaviorEn: 'Derives the USD reference figure as tokens × unit price',
    userImpact: '美元金额标注为「估算值」；token 计量不受影响',
    userImpactEn: 'The USD figure is labeled "estimated"; token accounting is unaffected',
    severity: 'info',
  },
  tokenReporting: {
    behavior: '不记录 token 明细，用量按时长粗估',
    behaviorEn: 'No token breakdown; usage is roughly estimated from duration',
    userImpact: 'token 上限与预算对该 Agent 失效，成本页标注「不可计量」',
    userImpactEn:
      'Token limits and budgets do not apply to this Agent; the cost page marks it "not measurable"',
    severity: 'critical',
  },
  progressReporting: {
    behavior: '不显示百分比，只显示已耗时',
    behaviorEn: 'No percentage, only elapsed time',
    userImpact: '卡片显示「执行中 12m」而非进度条',
    userImpactEn: 'The card shows "running 12m" instead of a progress bar',
    severity: 'info',
  },
  runtimeConstraints: {
    behavior: '「增加约束」不可用',
    behaviorEn: '"Add a constraint" is unavailable',
    userImpact: '需改用「终止并补充上下文重跑」',
    userImpactEn: 'Use "terminate and rerun with more context" instead',
    severity: 'warning',
  },
  interventionRequest: {
    behavior: 'Agent 无法主动求助，靠超时与失败检测兜底',
    behaviorEn: 'The Agent cannot ask for help; timeouts and failure detection are the fallback',
    userImpact: '卡住的任务发现更晚',
    userImpactEn: 'A stuck work item is noticed later',
    severity: 'warning',
  },
  selfReportOnFailure: {
    behavior: '错误信息只有原始报错',
    behaviorEn: 'The error is only the raw message',
    userImpact: '排障效率降低',
    userImpactEn: 'Diagnosis is slower',
    severity: 'warning',
  },
  pause: {
    behavior: '暂停降级为终止',
    behaviorEn: 'Pause degrades into terminate',
    userImpact: '会丢失执行中的进度，操作前需二次确认',
    userImpactEn:
      'In-flight progress is lost, so the action needs a second confirmation',
    severity: 'warning',
  },
  terminate: {
    behavior: '只能标记本地状态，外部可能仍在运行',
    behaviorEn: 'Only the local state can be marked; the external side may still be running',
    userImpact: '存在成本泄漏风险，禁止用于高风险任务',
    userImpactEn: 'Risk of cost leaking away — not allowed for high-risk work',
    severity: 'critical',
  },
  statusQuery: {
    behavior: '孤儿 Run 无法探测真实状态，超时后直接判失败',
    behaviorEn: 'An orphaned run cannot be probed for its real state and is failed once it times out',
    userImpact: '可能误判仍在运行的 Run',
    userImpactEn: 'A run that is still going may be judged failed',
    severity: 'warning',
  },
  subAgentDelegation: {
    behavior: '不支持委派子 Agent',
    behaviorEn: 'Delegating to a sub-Agent is not supported',
    userImpact: '复杂任务需人工拆分',
    userImpactEn: 'Complex work has to be split by hand',
    severity: 'info',
  },
  artifactUpload: {
    behavior: '产物需通过外部链接引用',
    behaviorEn: 'Artifacts must be referenced by an external link',
    userImpact: '产物不能内联预览',
    userImpactEn: 'Artifacts cannot be previewed inline',
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

/**
 * 这条授权是谁给的。
 *
 * ★★ 只在**派发快照**里有意义，登记接口一律忽略它。
 *
 *   项目级仓库对项目内 Agent 默认只读（见 domain 的 effectiveResourceScopes），
 *   于是 permissionSnapshot 里会出现管理员从没配过的条目。不标出处的话，
 *   审计时「这个 Agent 当时能读这个仓库」有两种完全不同的读法 ——
 *   管理员授了权，还是平台默认给的 —— 而事后追责最需要区分的正是这两者。
 *
 *   缺省视为 explicit：老数据没有这个字段，而它们确实都是显式配的。
 *
 * Where this grant came from. Only meaningful inside a dispatch's permission
 * snapshot: project-scoped repositories are readable by default, so the
 * snapshot contains entries no admin ever configured. Audit needs to tell the
 * two apart. Absent means explicit — that is what old rows are.
 */
export const ScopeOrigin = z.enum(['explicit', 'project_default']);
export type ScopeOrigin = z.infer<typeof ScopeOrigin>;

export const ResourceScope = z.object({
  kind: z.enum(['repo', 'env', 'database', 'external_service', 'dataset']),
  ref: z.string(),
  access: z.enum(['none', 'read', 'write']),
  origin: ScopeOrigin.optional(),
});
export type ResourceScope = z.infer<typeof ResourceScope>;

export const AgentPermissions = z.object({
  allowedTools: z.array(z.string()),
  /** 黑名单优先级高于白名单，不可被模板或继承覆盖 */
  deniedTools: z.array(z.string()),
  resourceScopes: z.array(ResourceScope),
});
export type AgentPermissions = z.infer<typeof AgentPermissions>;

/**
 * 派发前由平台供给的工作区。
 *
 * ★ 供给放在平台侧而不是适配器侧，是因为「clone 到哪、开哪个分支、
 *   跑完推不推」对所有运行时都一样。让每个适配器自己实现，
 *   等于把同一段 git 逻辑抄 N 遍，还会 N 份各自出错。
 *   适配器只需要认一个已经准备好的 `path`。
 */
export const RunWorkspace = z.object({
  /** 已准备完毕的本地绝对路径，可直接作为 cwd */
  path: z.string(),
  /** 只读授权时为 false —— 适配器据此再收一道写工具 */
  writable: z.boolean(),
  /** 额外只读挂载的路径 */
  additionalPaths: z.array(z.string()).default([]),

  /**
   * 版本控制信息。**只有 Git 类工作区才有**，规划/纯本地任务为 null。
   *
   * ★★ 在此之前这几个字段是必填的，于是不涉及仓库的任务只能填占位符。
   *   规划 Run 就是这么干的（repoRef:'planning', branch:'planning'），
   *   而 prompt 会照着生成「你在分支 planning 上工作，它基于 planning」
   *   下发给 Agent —— 一句纯粹的胡话，Agent 读到只会困惑。
   *   可空之后，「有没有版本控制」这件事在类型上就是显式的。
   */
  vcs: z
    .object({
      repoRef: z.string(),
      /** Agent 的工作分支，已切换 */
      branch: z.string(),
      baseBranch: z.string(),
      baseCommit: z.string().nullable(),
    })
    .nullable()
    .default(null),
});
export type RunWorkspace = z.infer<typeof RunWorkspace>;

/**
 * Agent 人设 —— prompt 三层里的第二层。
 *
 * ★ 第一层是平台治理规则（适配器生成，用户改不了）；
 *   第三层是项目工程约定（走 context 下发）。
 *   把这三层分开，是为了让「可配置」只落在真正该配置的地方：
 *   开一个自由文本框覆盖 system prompt，等于允许用户写一句
 *   「遇到问题自己想办法解决」把整条人工干预通道架空。
 */
export const AgentPersona = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string().nullable(),
  skills: z.array(z.string()).default([]),
});
export type AgentPersona = z.infer<typeof AgentPersona>;

export const TaskDispatch = z.object({
  runId: z.string().uuid(),
  /** 重复派发保护 */
  idempotencyKey: z.string(),
  /** 执行者是谁。进 prompt 的第二层，也让 Agent 知道自己的定位 */
  agent: AgentPersona.nullable().default(null),
  /**
   * 产出该用哪种语言写。来自项目的 outputLocale。
   *
   * ★★ prompt 里此前一个字都没提语言，于是同一个项目里 PRD 是英文、
   *   Agent 的执行报告是中文 —— 而那份报告会显示在 Run 详情页上给人读
   *   （问题记录：NEW-BUG-5）。
   */
  outputLocale: z.enum(['en', 'zh']).default('en'),
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
  /**
   * 这次工作一旦落到哪些情形上，会被 Policy 拦下转人工 —— 已渲染成人话。
   *
   * ★ 派发时算好再下发，而不是让 Agent 自己推断：Agent 看不到 Policy 引擎，
   *   Policy 评估发生在状态流转上，是平台侧的事。不告诉它的后果是它可能
   *   一路做到生产发布，才在流转那一步被冻住 —— 那时 token 已经花完了。
   * ★ 存渲染好的字符串而非规则 AST：`@apos/agent-runtimes` 只依赖
   *   `@apos/contracts`，取不到 domain 里的 `explainPolicy()`。
   *
   * Which situations will get this work held for human approval by Policy,
   * already rendered as prose. Computed at dispatch rather than inferred by the
   * agent: policy evaluation happens on state transitions, which the agent
   * cannot see. Stored rendered because the runtimes package cannot reach
   * domain's `explainPolicy()`.
   */
  policyGates: z
    .array(z.object({ name: z.string(), explanation: z.string() }))
    .default([]),
  /** 平台已备好的工作区；null 表示这次派发不涉及代码仓库 */
  workspace: RunWorkspace.nullable().default(null),
  limits: z.object({
    /**
     * ★ 平台侧的权威上限。null = 没配（迁移后的默认状态），不拦。
     *
     * The platform's authoritative cap. null means unset — the state every
     * agent is in right after the token-accounting migration — and does not
     * block dispatch.
     */
    maxTokens: z.number().int().positive().nullable(),
    /**
     * ★ 运行时自带的美元硬停线，**保险丝而非账目**。
     *   由 maxTokens 按最贵的那类 token 折算而来，因此一定晚于它触发；
     *   模型价格未知时为 null，此时这道保险丝不存在。
     *
     * The runtime's own USD hard stop: a fuse, not an accounting figure.
     * Derived from maxTokens at the most expensive per-token rate so it always
     * trips after the token cap; null when the model's price is unknown.
     */
    maxCostUsd: z.number().positive().nullable(),
    maxDurationSeconds: z.number().int().positive(),
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
  /**
   * 用量事件。事件名保留 `cost` —— 它已经写进了 run_events.type 的历史行，
   * 改名要连带迁移既有数据，而收益只是一个更贴切的字面量。
   *
   * ★ token 是记账单位，美元只是参考值。
   *   两者都报：token 不随官方定价漂移，适合做上限与预算；
   *   美元来自运行时的权威结算，适合回答「这个月账单大概多少」。
   *   谁是记账单位这件事只体现在下游怎么用，不体现在这里报不报。
   *
   * The usage event. The name stays `cost`: it is already written into
   * historical `run_events.type` rows, and renaming it would mean migrating
   * that data for nothing but a better-fitting literal.
   *
   * Tokens are the unit of account; USD is a reference figure. Both are
   * reported — tokens do not drift with vendor pricing, which is what makes
   * them usable for limits and budgets, while USD comes from the runtime's
   * authoritative settlement.
   */
  RunEventBase.extend({
    type: z.literal('cost'),
    deltaUsd: z.number(),
    totalUsd: z.number(),
    /**
     * 本次增量的 token 明细。★ cacheWrite 必须报：它按输入价的 1.25 倍计费，
     * 长上下文任务里往往是最大的一项，漏掉它等于系统性少算。
     */
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number(),
    }),
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

/** cost 事件里的 token 明细 / The token breakdown carried by a cost event */
export type TokenBreakdown = Extract<RunEvent, { type: 'cost' }>['tokens'];

/**
 * 四类 token 相加 —— 记账单位的唯一定义。
 *
 * ★ 之所以要一个函数而不是让每个调用方自己写加法：漏掉一项（历史上就是
 *   cacheWrite）不会有任何症状，只会让总量偏小，而偏小的方向没有人会来报错。
 *   放在契约包里，加一类 token 时改一处，所有调用方跟着走。
 *
 * The single definition of the unit of account. It is a function rather than
 * inline addition in each caller because dropping a class (historically
 * cacheWrite) produces no symptom — only an undercount, and nobody reports a
 * bill that looks too low. Adding a class is then a one-line change here.
 */
export function totalTokens(t: TokenBreakdown): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

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

/**
 * Run 成功的那个状态值。
 *
 * ★ 单独导出，因为「什么算成功」被至少四处引用（成功率、成本效益、
 *   Agent 效能、调度重试），而字面量写错的表现是**静默算成 0** ——
 *   我自己就刚踩过一次：成本效益里写成 'succeeded'，
 *   于是「Agent 承担的工时」永远是 0，页面显示「没有可换算的工时」，
 *   看起来完全像是「这个周期确实没跑过」。
 */
export const RUN_SUCCESS: RunStatus = 'completed';

/** 终态：不会再变了 */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'completed',
  'failed',
  'timeout',
  'terminated',
] as const;

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'dispatching',
  'running',
  'paused',
] as const;
