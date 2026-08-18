import type { Diagnostic, PlanDiff, Permission } from '@apos/domain';
import type {
  BlockedDetail,
  DecisionReason,
  HumanGate,
  ProjectRole,
  RiskLevel,
  Stage,
  WorkItemStatus,
} from '@apos/contracts';

export type { Permission, ProjectRole };

/**
 * 接口返回形状。
 *
 * ★ 只写后端实际返回的字段，不「预留」——
 *   前端多写一个字段，后端没给，运行时就是 undefined，
 *   而类型系统会说它存在。宁可少写。
 */

export interface BoardCard {
  id: string;
  /** 人类可读编号（`ORD-19`）—— 卡片上要能指着它说出名字 */
  ref: string;
  title: string;
  type: string;
  status: WorkItemStatus;
  stage: Stage;
  priority: number;
  riskLevel: RiskLevel;
  executor: { type: string; id: string; name: string } | null;
  owner: { id: string; name: string } | null;
  humanGate: HumanGate | null;
  humanGateRef: string | null;
  decisionDueInMinutes: number | null;
  blockedSince: string | null;
  blockedReason: string | null;
  /** 结构化阻塞细节 —— 界面优先读它；`blockedReason` 是老数据的兜底句 */
  blockedDetail: BlockedDetail | null;
  blockedMinutes: number | null;
  progress: { step: number; total: number | null; description: string | null } | null;
  tokens: number;
  estimatedTokens: number | null;
  runId: string | null;
  runStatus: string | null;
  consecutiveFailures: number;
  latestNote: string | null;
  artifactCount: number;
  unmetDependencies: number;
  /** 谁挡着这张卡（含已完成的，画整条链要用到） */
  blockedBy: DependencyRef[];
  /** 这张卡挡着谁 —— 「先做哪个」只有这一栏答得了 */
  blocking: DependencyRef[];
  updatedAt: string;
}

/** 依赖链上的一个引用 */
export interface DependencyRef {
  id: string;
  ref: string;
  title: string;
  status: string;
  type: string | null;
  met: boolean;
}

/**
 * 「计划待批准」卡片（页面文档 05 §5.2 原型图里 Planning 列那一张）。
 *
 * ★ 计划不是工作项：没有状态机、没有执行者、不能拖动。所以它不复用
 *   BoardCard，也不混进 `items` —— `items` 被四个视图当工作项处理。
 */
export interface PlanCard {
  id: string;
  requirementId: string | null;
  title: string;
  version: number;
  taskCount: number;
  approver: { id: string; name: string } | null;
  estimatedHours: string | null;
  estimatedTokens: number | null;
  /** 已等待多久。★ 不是倒计时 —— 计划没有截止时间字段 */
  waitingMinutes: number;
  createdAt: string;
}

export interface BoardColumn {
  key: Stage;
  name: string;
  wipLimit: number | null;
  count: number;
  items: BoardCard[];
  hasMore: boolean;
  /** 待批准的计划；目前只有 planning 列非空 */
  plans: PlanCard[];
}

export interface BoardSummary {
  pendingDecisions: number;
  overdueDecisions: number;
  blocked: number;
  executing: number;
  failed: number;
}

export interface BoardResponse {
  columns: BoardColumn[];
  summary: BoardSummary;
}

export interface User {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  /**
   * ★ 可能为 null：身份还没落定时没有"当前组织"，
   *   组织角色是跟着归属走的，那一刻任何一个值都是编的。
   */
  orgRole: string | null;
  approvalScopes: string[];
}

/**
 * 当前身份在某个项目里的权限（docs/tech/09-security.md §2）。
 *
 * ★ 判定口径来自服务端，不在前端重算 —— 界面上灰掉的按钮
 *   和服务端真正拦住的请求必须是同一条规则。
 *
 * ★ `denyReasons` 不是可选的装饰：一个灰掉但不说明原因的按钮
 *   比没有这个按钮更让人困惑，用户会反复点它。
 */
export interface ProjectPermissions {
  projectId: string;
  userId: string;
  orgRole: string;
  projectRole: ProjectRole | null;
  permissions: Record<Permission, boolean>;
  denyReasons: Partial<Record<Permission, string>>;
}

export interface ProjectMemberRow {
  actorId: string;
  actorType: 'human' | 'agent' | 'service' | 'external' | 'system';
  role: string;
  roleLabel: string;
  permissionCount: number;
  addedAt: string;
  name: string | null;
  email: string | null;
  /** Agent 用：类型与状态 */
  detail: string | null;
  orgRole: string | null;
}

export interface AssignableRole {
  role: string;
  label: string;
  description: string;
  /** 这个角色能由谁担任 —— 人的下拉框和 Agent 的下拉框内容不同 */
  appliesTo: ('human' | 'agent')[];
  builtin: boolean;
  permissions: Permission[];
}

export interface MembersResponse {
  members: ProjectMemberRow[];
  assignableRoles: AssignableRole[];
}

/** 角色定义（docs/tech/09-security.md §2.2）—— 超管在角色页里维护 */
export interface RoleRow {
  key: string;
  name: string;
  description: string;
  permissions: Permission[];
  appliesTo: ('human' | 'agent')[];
  builtin: boolean;
  /** 有多少人 / 多少 Agent 正在担任 —— 删除前要知道会影响谁 */
  memberCount: { human: number; agent: number };
}

export interface AvailablePermission {
  key: Permission;
  label: string;
  scope: string;
  /** 带这个标记的权限进不了 Agent 角色 */
  humanOnly: boolean;
  group: string;
}

export interface RolesResponse {
  roles: RoleRow[];
  availablePermissions: AvailablePermission[];
}

export interface Project {
  /** 工作项编号的前缀（`ORD` → `ORD-19`）*/
  identifier: string;
  id: string;
  name: string;
  goal: string | null;
  status: string;
  autonomyLevel: string;
  tokenBudget: number | null;
  tokensSpent: number;
  wipLimits: Record<string, number> | null;
  updatedAt: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  type: string;
  status: string;
  model: string | null;
  skills: string[];
  maxConcurrency: number;
  tokenLimitPerRun: number | null;
  stats: Record<string, unknown>;
  load: number;
  todayTokens: number;
  items: {
    id: string;
    title: string;
    status: WorkItemStatus;
    consecutiveFailures: number;
    progress: { step: number; total: number | null } | null;
  }[];
}

export interface DecisionRow {
  id: string;
  workItemId: string | null;
  runId: string | null;
  type: string;
  status: string;
  riskLevel: RiskLevel;
  title: string;
  background: string | null;
  whyHuman: string;
  consequence: string | null;
  assigneeId: string | null;
  dueAt: string | null;
  dueInMinutes: number | null;
  requiresCosign: boolean;
}

export interface DecisionOption {
  id: string;
  name: string;
  description: string | null;
  isRecommended: boolean;
  confidence: string | null;
  rationale: string | null;
  attributes: Record<string, unknown>;
}

export interface DecisionDetail {
  decision: DecisionRow;
  options: DecisionOption[];
  workItem: { id: string; title: string; status: WorkItemStatus } | null;
}

export interface WorkItemDetail {
  item: {
    id: string;
    projectId: string;
    /** 人类可读编号（`ORD-19`）*/
    ref: string;
    title: string;
    description: string | null;
    type: string;
    status: WorkItemStatus;
    stage: Stage;
    riskLevel: RiskLevel;
    priority: number;
    humanGate: HumanGate | null;
    blockedReason: string | null;
    blockedDetail: BlockedDetail | null;
    blockedSince: string | null;
    actualTokens: number;
    estimatedTokens: number | null;
    consecutiveFailures: number;
    acceptanceCriteria: { id: string; text: string; status: string; verification: string }[];
    constraints: { type: string; description: string; enforcement: string }[];
    updatedAt: string;
  };
  runs: {
    id: string;
    attempt: number;
    status: string;
    tokens: number;
    stepCurrent: number | null;
    stepTotal: number | null;
    progressNote: string | null;
    errorClass: string | null;
    errorMessage: string | null;
    agentSelfReport: string | null;
    startedAt: string | null;
    endedAt: string | null;
  }[];
  artifacts: {
    id: string;
    kind: string;
    title: string;
    externalUrl: string | null;
    content: string | null;
  }[];
  timeline: TimelineEvent[];
}

export interface TimelineEvent {
  id: string;
  type: string;
  actorType: string;
  actorId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
}

/** SSE 推送的领域事件 */
export interface StreamEvent {
  id: string;
  type: string;
  channels: string[];
  projectId: string | null;
  subjectType: string;
  subjectId: string;
  actorType: string;
  actorId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
}


// ── Run 详情（页面文档 09）────────────────────────────────────────────

export interface RunEventRow {
  seq: number;
  ts: string;
  type: string;
  level: string;
  summary: string;
  payload: Record<string, unknown> | null;
  /** 迁移之前的行是 null —— 那时没记，不是记了 0 */
  tokensDelta: number | null;
}

export interface RunEventPage {
  events: RunEventRow[];
  level: 'brief' | 'detailed';
  nextCursor: number | null;
  hasMore: boolean;
}

export interface RunDetail {
  run: {
    id: string;
    status: string;
    attempt: number;
    idempotencyKey: string;
    stepCurrent: number | null;
    stepTotal: number | null;
    stepDescription: string | null;
    progressNote: string | null;
    startedAt: string;
    endedAt: string | null;
    lastHeartbeatAt: string | null;
    timeoutAt: string | null;
  };
  agent: {
    id: string;
    name: string;
    type: string;
    model: string | null;
    runtimeRef: string;
    tokenLimitPerRun: number | null;
  } | null;
  workItem: { id: string; title: string; status: string; estimatedTokens: number | null } | null;
  project: { id: string; name: string } | null;
  input: {
    goal: string;
    context: {
      kind?: string;
      ref?: string;
      title?: string;
      content?: string | null;
      priority?: string;
      trusted?: boolean;
    }[];
    model: string | null;
    modelConfig: Record<string, unknown> | null;
    tools: string[];
    permissions: {
      allowedTools: string[];
      deniedTools: string[];
      resourceScopes: { kind: string; ref: string; access: string }[];
    } | null;
  };
  metrics: {
    tokens: {
      input: number;
      output: number;
      cacheRead: number;
      total: number;
      cacheHitRate: number;
    };
    /** 运行时结算的美元值，界面标为参考值 */
    costUsd: string;
    estimatedTokens: number | null;
    tokenLimit: number | null;
    durationMs: number;
    toolCalls: { total: number; byTool: Record<string, number> };
    eventCount: number;
  };
  artifacts: {
    id: string;
    kind: string;
    title: string;
    storage: string;
    externalUrl: string | null;
    content: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
  }[];
  interventions: (TimelineEvent & { actorName: string })[];
  error: {
    class: string;
    message: string | null;
    detail: Record<string, unknown> | null;
    selfReport: string | null;
    failedAt: { step: number | null; total: number | null; at: string | null };
  } | null;
  related: {
    previousRun: { id: string; attempt: number; status: string } | null;
    attempts: { id: string; attempt: number; status: string; tokens: number; errorClass: string | null }[];
    decisions: { id: string; title: string; status: string; type: string }[];
    policies: {
      eventId: string;
      policyId: string | null;
      policyName: string | null;
      action: unknown;
      occurredAt: string;
    }[];
  };
}

export interface CostStep {
  step: number | null;
  description: string;
  tokens: number;
  eventCount: number;
}

export type RunControlAction = 'pause' | 'resume' | 'terminate' | 'add_constraint';


// ── 执行图（页面文档 07）─────────────────────────────────────────────

export interface GraphResponse {
  nodes: import('@apos/domain').GraphNode[];
  edges: import('@apos/domain').GraphEdge[];
  metrics: import('@apos/domain').GraphMetrics;
  diagnostics: import('@apos/domain').Diagnostic[];
  layout: import('@apos/domain').LayoutResult & { kind: import('@apos/domain').LayoutKind };
}

/**
 * Analytics 一次返回四个 Tab（后端 analytics.ts 里写了为什么不拆）。
 * 指标类型全部复用领域层，前端不重新声明一遍 —— 两处定义迟早会漂。
 */
export type AnalyticsResponse = import('@apos/domain').Analytics & {
  project: { id: string; name: string };
  generatedAt: string;
  quality: import('@apos/domain').QualityMetrics;
  benefit: import('@apos/domain').BenefitMetrics;
};

export interface AnalyticsItemsResponse {
  kind: 'rework' | 'wip' | 'slow';
  items: {
    id: string;
    title: string;
    status: WorkItemStatus;
    stage: Stage;
    riskLevel: RiskLevel;
    ownerId: string | null;
    elapsedHours: number | null;
  }[];
}


// ── Policy 配置（页面文档 13）──────────────────────────────────────────
type D = typeof import('@apos/domain');

export type PolicyRow = import('@apos/contracts').Policy & {
  /** 模板拼接出来的人话解释，不是模型生成的 —— 必须与执行逻辑严格一致 */
  explanation: string;
  hits30d: number;
  avgWaitSeconds: number | null;
  editable: boolean;
};

export interface PoliciesResponse {
  project: { id: string; name: string; autonomyLevel: string };
  orgPolicies: PolicyRow[];
  projectPolicies: PolicyRow[];
  summary: ReturnType<D['auditPolicies']>['summary'];
  issues: ReturnType<D['auditPolicies']>['issues'];
  wiredFacts: string[];
}

export interface PolicyTemplateRow {
  id: string;
  scenario: string;
  name: string;
  purpose: string;
  direction: 'tighten' | 'loosen';
  params: import('@apos/domain').TemplateParam[];
}

export type SimulationResponse = import('@apos/domain').SimulationResult;

export interface ScenarioTestResponse {
  context: import('@apos/contracts').PolicyContext;
  action: import('@apos/contracts').Action;
  requiresHuman: boolean;
  matchedPolicyId: string | null;
  matchedPolicyName: string | null;
  explanation: string;
  trace: {
    policyId: string;
    name: string;
    priority: number;
    scope: 'org' | 'project';
    state: 'matched' | 'missed' | 'not_evaluated';
    failedAt: { fact: string; op: string; expected: unknown; actual: unknown } | null;
  }[];
}

export interface AutonomyPreview {
  becomesAuto: string[];
  becomesGated: string[];
  autoBefore: number;
  autoAfter: number;
}


// ── 需求录入与计划确认（页面文档 03 / 04）──────────────────────────────
export interface RequirementSummary {
  id: string;
  title: string;
  status: string;
  priority: string;
  createdAt: string;
  approvedAt: string | null;
  latestPlanId: string | null;
  latestPlanStatus: string | null;
}

export interface Clarification {
  id: string;
  level: 'must_confirm' | 'default_applicable' | 'assumption_ok' | 'auto_resolved';
  question: string;
  impact: string | null;
  agentSuggestion: string | null;
  suggestionBasis: string | null;
  options: unknown[];
  answer: string | null;
  answeredAt: string | null;
  resolvedSource: string | null;
}

export interface RequirementDetail {
  requirement: {
    id: string;
    projectId: string;
    status: string;
    rawInput: string;
    title: string | null;
    businessContext: string | null;
    userProblem: string | null;
    businessGoal: string | null;
    userStories: unknown[];
    scope: { inScope?: string[]; outOfScope?: string[] };
    nonFunctional: unknown[];
    risks: unknown[];
    acceptanceCriteria: { id?: string; text?: string; description?: string }[];
    completeness: Record<string, number>;
    fieldProvenance: Record<string, unknown>;
    /** 上一次是谁分析的。回退到规则占位时会带上原因 —— 界面必须如实显示 */
    analysisModel: string | null;
    /** 指定由哪个 Agent 编写 PRD；null = 按项目绑定的规划 Agent 自动挑 */
    authorAgentId: string | null;
    priority: string;
    rejectReason: string | null;
    approvedAt: string | null;
  };
  clarifications: Clarification[];
  /**
   * 指定的编写 Agent 详情。
   *
   * ★ 名字随 id 一起下发，因为下拉框里只装得下**当前**的项目 Agent 成员：
   *   那个 Agent 后来被移出项目的话，光有 id 会让界面显示成「未指定」，
   *   而库里明明还指着它。
   */
  authorAgent: { id: string; name: string; status: string } | null;
}

export interface PlanDetail {
  plan: {
    id: string;
    version: number;
    status: string;
    projectId: string;
    requirementId: string | null;
    model: string | null;
    generationCost: number;
    generationMs: number | null;
    estimatedHours: number;
    estimatedTokens: number;
    createdAt: string;
    approvedAt: string | null;
    approvedBy: string[];
    revisionFeedback: string | null;
    risks: unknown[];
    phases: unknown[];
  };
  metrics: {
    taskCount: number;
    agentTasks: number;
    humanTasks: number;
    estimatedHours: number;
    estimatedTokens: number;
    budget: number | null;
    spent: number;
    overBudget: boolean;
    humanGateCount: number;
    highRiskTasks: number;
  };
  autoActions: {
    description: string;
    policyName: string | null;
    reversible: boolean;
    externalVisible: boolean;
    /** action = 批准后真的会发生；estimate = 只是个数，不是动作也不会「逆」 */
    kind: 'action' | 'estimate';
  }[];
  humanGates: {
    taskTitle: string;
    /** execution = 这活得人干；approval = 干完要人批。两者判断完全不同 */
    cause: 'execution' | 'approval';
    reason: string;
    assigneeHint: string;
  }[];
  currentBoundary: { auto: string[]; human: string[]; depends: { label: string; when: string | null }[] };
  tasks: {
    id: string;
    title: string;
    type: string;
    status: WorkItemStatus;
    stage: Stage;
    riskLevel: RiskLevel;
    estimatedHours: number | null;
    estimatedTokens: number | null;
    executorType: string | null;
    executorName: string | null;
    ownerName: string | null;
    requiresHuman: boolean;
    position: number;
  }[];
  assumptions: { id: string; question: string; answer: string | null; level: string; confirmed: boolean }[];
}

// ── 项目总览 / Agent / 决策中心 / 运行时（页面文档 02 / 08 / 10 / 14）──
type Contribution = import('@apos/domain').Contribution;

export interface OverviewResponse {
  project: {
    id: string;
    name: string;
    goal: string | null;
    status: string;
    autonomyLevel: string;
    pausedReason: string | null;
  };
  health: { score: number; level: 'good' | 'fair' | 'poor'; contributions: Contribution[] };
  progress: { pct: number; done: number; total: number };
  delay: {
    level: 'low' | 'medium' | 'high';
    probability: number;
    estimatedSlipDays: number | null;
    contributions: Contribution[];
  };
  tokens: { spent: number; budget: number | null };
  decisions: { pending: number; overdue: number; unassigned: number };
  actionItems: {
    kind: 'plan' | 'decision';
    id: string;
    title: string;
    riskLevel: string;
    overdueMinutes: number | null;
    dueInMinutes: number | null;
  }[];
  blocked: {
    id: string;
    title: string;
    reason: string | null;
    detail: BlockedDetail | null;
    minutes: number | null;
    ownerName: string | null;
    humanGateRef: string | null;
  }[];
  agents: {
    id: string;
    name: string;
    type: string;
    status: string;
    currentTask: string | null;
    currentRunId: string | null;
    successRate: number | null;
    runs: number;
    tokens: number;
  }[];
  members: {
    id: string;
    name: string;
    role: string;
    pendingDecisions: number;
    overdueDecisions: number;
  }[];
  trend: { wip: { day: string; value: number }[]; blocked: { day: string; value: number }[] };
  /** 与执行图共用同一套判定，只给前三条 —— 总览是指挥台不是问题清单 */
  diagnostics: Diagnostic[];
  /** 延期归因那一行（「决策等待 5.6d」）；算不出来时为 null */
  delayCause: string | null;
  recentActivity: { id: string; type: string; actorType: string; occurredAt: string; payload: Record<string, unknown> }[];
}

export interface AgentListResponse {
  agents: {
    id: string;
    name: string;
    type: string;
    model: string | null;
    /** 生命周期：active / paused / retired。与「是不是本项目成员」是两回事 */
    status: string;
    pausedReason: string | null;
    /** 这个项目里的成员关系。组织级视图下为 null（那里没有「本项目」） */
    inProject: boolean | null;
    load: { running: number; max: number };
    runs: number;
    successRate: number | null;
    firstTrySuccessRate: number | null;
    overrideRate: number | null;
    tokens: number;
    ownerName: string;
  }[];
  totals: { tokens: number; runs: number; successRate: number | null };
}

export interface CapabilityReport {
  runtime: { name: string; version: string };
  protocolVersion: string;
  transport: { eventDelivery: string; heartbeatIntervalSeconds: number | null };
  models: string[];
  limits: { maxConcurrentRuns: number; maxRunDurationSeconds: number; maxContextTokens: number | null };
  tools: { name: string; description: string; sideEffects: string }[];
  supported: { feature: string; label: string }[];
  missing: {
    feature: string;
    label: string;
    behavior: string;
    /** 与 contracts 的 Degradation 一致；缺省时界面回落中文 */
    behaviorEn?: string;
    userImpact: string;
    userImpactEn?: string;
    severity: string;
  }[];
  restricted: boolean;
}

export interface AgentDetail {
  agent: {
    id: string;
    name: string;
    type: string;
    description: string | null;
    model: string | null;
    status: string;
    pausedReason: string | null;
    skills: string[];
    applicableTypes: string[];
    maxConcurrency: number;
    timeoutSeconds: number;
    tokenLimitPerRun: number | null;
    tokenLimitDaily: number | null;
    ownerName: string;
    runtime: { name: string; kind: string; status: string } | null;
  };
  permissions: {
    allowedTools: string[];
    deniedTools: string[];
    resourceScopes: { kind: string; ref: string; access: string }[];
  };
  performance: {
    runs: number;
    successRate: number;
    firstTrySuccessRate: number;
    overrideRate: number;
    avgTokens: number;
    totalTokens: number;
    avgMinutes: number | null;
  } | null;
  /** 只含未完成的任务 —— 已完成的数量在 queueDoneCount */
  queue: { id: string; title: string; status: string; riskLevel: string }[];
  queueDoneCount: number;
  recentRuns: {
    /** execution | planning —— 规划 Run 没有工作项 */
    kind: string;
    id: string;
    workItemId: string | null;
    workItemTitle: string;
    status: string;
    attempt: number;
    tokens: number;
    errorClass: string | null;
    startedAt: string | null;
    endedAt: string | null;
  }[];
  capability: CapabilityReport | null;
  permissionChanges: { direction: string; changedBy: string; reason: string | null; createdAt: string }[];
}

export interface DecisionCard {
  id: string;
  projectId: string;
  projectName: string;
  type: string;
  typeLabel: string;
  title: string;
  consequence: string | null;
  whyHuman: string;
  /** ★ 结构化理由。界面优先读它，上面两句中文是存量数据的兜底 */
  reasonDetail: DecisionReason | null;
  riskLevel: string;
  reversible: boolean;
  assigneeId: string | null;
  assigneeName: string | null;
  canAct: boolean;
  createdAt: string;
  dueAt: string | null;
  overdueMinutes: number | null;
  dueInMinutes: number | null;
  waitingMinutes: number;
  workItemId: string | null;
  workItemTitle: string | null;
  runId: string | null;
  agentSelfReport: string | null;
  options: {
    id: string;
    name: string;
    description: string | null;
    isRecommended: boolean;
    rationale: string | null;
    uncertainties: string[];
  }[];
}

export interface DecisionInbox {
  stats: {
    total: number;
    mine: number;
    overdue: number;
    dueSoon: number;
    actionable: number;
    /** 按项目拆的计数 —— 顶栏那个跨项目的数字要能说清「其中这个项目几条」 */
    byProject: Record<string, { mine: number; overdue: number }>;
  };
  repeated: { type: string; label: string; count: number }[];
  decisions: DecisionCard[];
}

export interface RuntimeRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  protocolVersion: string | null;
  registered: boolean;
  reachable: boolean;
  agentCount: number;
  agentNames: string[];
  capability: CapabilityReport | null;
}

// ── 集成设置（页面文档 14）──────────────────────────────────────────

export interface SyncMappingRow {
  field: string;
  fieldLabel: string;
  /** 服务端一起给的英文；前端按当前语言挑 / English sent alongside; client picks */
  fieldLabelEn?: string;
  sourceOfTruth: 'apos' | 'external' | 'merge';
  strategy: 'writeback' | 'record_conflict' | 'accept_and_warn';
  strategyLabel: string;
  strategyLabelEn?: string;
  why: string;
  whyEn?: string;
  options: ('apos' | 'external' | 'merge')[];
  /**
   * 偏离默认值 —— 用户改过的地方下次读这一页时要一眼看见。
   * Deviates from the default: what a user changed must be obvious next time.
   */
  customized: boolean;
}

export interface IntegrationRow {
  id: string;
  provider: string;
  providerLabel: string;
  category: string;
  categoryLabel: string;
  displayName: string;
  config: Record<string, unknown>;
  status: string;
  statusReason: string | null;
  lastSyncAt: string | null;
  /** 只有后四位。接口里没有明文这个字段 */
  credentialHint: string | null;
  credentialExpiresAt: string | null;
  credentialExpiringSoon: boolean;
  /** probed=false 表示这份清单是探测失败后的保守兜底，不是查到的事实 */
  scopes: { allowed: string[]; denied: string[]; probed?: boolean };
  /** 这个 provider 的集成层永远不提供的权限 */
  neverGranted: string[];
  /** 适配器没注册 = 现在同步不了，和「配置错了」是两回事 */
  transportReady: boolean;
  syncMappings: SyncMappingRow[];
  sotPreset: string | null;
  autoRules: { field: string; fieldLabel: string; fieldLabelEn?: string; winner: string }[];
  conflictCount: number;
  linkedItems: number;
  notificationConfig: NotificationConfigRow | null;
  stats: Record<string, unknown>;
}

export interface NotificationConfigRow {
  events: string[];
  dailyDigestAt: string | null;
  quietHours: { from: string; to: string } | null;
  quietHoursExceptHighRisk: boolean;
  escalation: {
    afterHours: number;
    notify: 'assignee' | 'project_owner' | 'manager';
    pauseCriticalPath: boolean;
  }[];
}

export type IntegrationAction =
  | 'view'
  | 'connect'
  | 'grant_write'
  | 'change_sot'
  | 'disconnect'
  | 'resolve_conflict'
  | 'configure_notification'
  | 'configure_data_connector';

export interface IntegrationsResponse {
  integrations: IntegrationRow[];
  conflictBacklog: number;
  hotspots: { field: string; fieldLabel: string; count: number; hint: string }[];
  available: {
    provider: string;
    label: string;
    category: string;
    categoryLabel: string;
    transportReady: boolean;
  }[];
  /**
   * ★ `*En` 是服务端一起给的，前端按当前语言挑 —— 服务端不知道调用方
   *   的界面语言。见 apps/api/src/http/integrations.ts。
   *   The `*En` variants arrive alongside; the client picks by locale because
   *   the server has no idea which one the caller is showing.
   */
  fieldCatalog: {
    field: string;
    label: string;
    labelEn?: string;
    sourceOfTruth: string;
    options: string[];
    why: string;
    whyEn?: string;
  }[];
  presets: {
    key: string;
    label: string;
    labelEn?: string;
    description: string;
    descriptionEn?: string;
  }[];
  strategyLabels: Record<string, string>;
  strategyLabelsEn?: Record<string, string>;
  notifyEvents: { key: string; label: string; noisy: boolean }[];
  permissions: Record<IntegrationAction, boolean>;
}

export interface SyncConflictRow {
  id: string;
  integrationId: string;
  field: string;
  fieldLabel: string;
  externalKey: string;
  externalUrl: string | null;
  workItemId: string | null;
  workItemTitle: string | null;
  apos: { value: unknown; changedAt: string; changedBy: string; actorType: string };
  external: { value: unknown; changedAt: string; changedBy: string; actorType: string };
  sourceOfTruth: string;
  sotNote: string;
  createdAt: string;
}

export interface SyncSummary {
  accepted: number;
  writtenBack: number;
  conflicts: number;
  autoResolved: number;
  echoesBlocked: number;
  warned: number;
  externalDeleted: number;
  notes: string[];
  objects: number;
}

export interface DisconnectImpact {
  provider: string;
  providerLabel: string;
  displayName: string;
  effects: string[];
  linkedItems: number;
  pendingConflicts: number;
}

export interface PlanDiffResponse {
  versions: { id: string; version: number; status: string; createdAt: string; isCurrent: boolean }[];
  against: { id: string; version: number } | null;
  /** 上一版为什么被要求改 —— diff 只说改了什么，这句说为什么改 */
  feedback: string | null;
  diff: PlanDiff | null;
}

export interface PolicyHitsResponse {
  policy: { id: string; name: string; enabled: boolean; editable: boolean };
  stats: {
    hits: number;
    byAction: { label: string; count: number }[];
    decisionsCreated: number;
    resolved: number;
    approved: number;
    /** ★ 这一页的结论靠它：全批 = 规则在浪费时间；常驳 = 拦对了 */
    approvalRate: number | null;
    avgWaitMinutes: number | null;
  };
  /** 自动放行的任务里事后被人工改过的数量 —— 放行类规则唯一的证伪证据 */
  overriddenAfterPass: number;
  /** 给结论，不只给数字 */
  verdict: string;
  hits: {
    eventId: string;
    at: string;
    action: string;
    actionLabel: string;
    workItemId: string;
    workItemTitle: string;
    context: { operationType: string; riskLevel: string; environment: string | null } | null;
    decision: {
      id: string;
      status: string;
      statusLabel: string;
      resolvedBy: string | null;
      waitMinutes: number | null;
    } | null;
  }[];
  truncated: boolean;
}

export interface QualityMetricRow {
  key: string;
  label: string;
  value: number | null;
  unit: 'percent' | 'count' | 'days';
  source: string;
  /** 数据源接没接上。false 时 value 一定是 null，页面必须显示「未接入」而不是 0 */
  wired: boolean;
  hint: string;
  sample: number;
}

export interface BenefitLineRow {
  key: string;
  label: string;
  hours: number;
  money: number | null;
  side: 'benefit' | 'cost';
  /** 这个数字怎么来的，包括其中的假设 */
  basis: string;
}


// ── Agent 配置（页面文档 08 §5.5）────────────────────────────────────

/**
 * ★ 这几个 `*En` 字段与 `@apos/contracts` 的同名类型保持一致。
 *   服务端原样透传 spec，缺英文时前端回落中文（见 lib/i18n/spec.ts）。
 *   Mirrors the `*En` fields on the contracts types; the server passes specs
 *   through untouched and the UI falls back to Chinese when English is absent.
 */
export interface ConfigFieldOption {
  value: string;
  label: string;
  labelEn?: string;
  help?: string;
  helpEn?: string;
}

export interface ConfigField {
  key: string;
  label: string;
  labelEn?: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'string_list' | 'json';
  default: unknown;
  help?: string;
  helpEn?: string;
  options?: ConfigFieldOption[];
  min?: number;
  max?: number;
  /** type: 'json' 时值的语义。'env' = 环境变量表 */
  jsonShape?: 'env' | 'free';
  /** 界面据此凸显：调这个字段会花更多钱 / 会放宽安全边界 */
  impact?: 'cost' | 'safety';
  advanced?: boolean;
}

export interface RuntimeKindSpec {
  kind: string;
  label: string;
  description: string;
  descriptionEn?: string;
  credential: { label: string; labelEn?: string; help: string; helpEn?: string } | null;
  endpoint: { label: string; labelEn?: string; help: string; helpEn?: string } | null;
  prerequisite: string | null;
  prerequisiteEn?: string | null;
  fields: ConfigField[];
}

export interface AgentCapability {
  runtime: { name: string; version: string };
  protocolVersion: string;
  models: string[];
  limits: { maxConcurrentRuns: number; maxRunDurationSeconds: number; maxContextTokens: number | null };
  tools: { name: string; description: string; sideEffects: string }[];
  supported: string[];
  missing: {
    feature: string;
    behavior: string;
    behaviorEn?: string;
    userImpact: string;
    userImpactEn?: string;
    severity: string;
  }[];
  restricted: boolean;
}

export interface AgentAdminRow {
  id: string;
  name: string;
  type: string;
  description: string | null;
  status: string;
  pausedReason: string | null;
  ownerId: string;

  runtimeKind: string;
  runtimeKindLabel: string;
  /** ★ 环境变量表里的加密值已换成 `secret://saved` 占位符，原样存回表示不改 */
  runtimeConfig: Record<string, unknown>;
  /** 环境变量表里那些取不到值的引用 */
  runtimeConfigProblems: string[];
  endpoint: string | null;

  /** ★ 只有后四位。接口永不回显凭证原值 */
  credentialHint: string | null;
  credentialUsable: boolean;
  credentialKind: 'none' | 'env' | 'encrypted' | 'fingerprint';
  credentialProblem: string | null;

  registered: boolean;
  reachable: boolean;
  problem: string | null;
  lastCheckAt: string | null;

  model: string | null;
  skills: string[];
  applicableTypes: string[];
  /**
   * ★★ 组织级记录只有**上限**，没有「它能做什么」。
   *
   *   后者是项目级的问题（同一个 Agent 在两个项目里可以是两套答案），
   *   在这一页给一个数字等于给一个在任何具体项目里都不准的答案。
   */
  ceiling: {
    /** null = 不设上限（沿用平台基线），不是「一条都不给」 */
    capabilityCeiling: string[] | null;
    deniedCapabilities: string[];
  };
  maxConcurrency: number;
  timeoutSeconds: number;
  tokenLimitPerRun: number | null;
  tokenLimitDaily: number | null;

  capability: AgentCapability | null;
}

export interface CredentialUsageRow {
  hint: string | null;
  kind: string;
  agents: string[];
  /** env 形态轮换只需改环境变量；内联密文要逐个 Agent 重录 */
  rotationCost: string;
}

export interface AgentAdminResponse {
  agents: AgentAdminRow[];
  credentialUsage: CredentialUsageRow[];
  kinds: RuntimeKindSpec[];
  /**
   * 直接粘贴的敏感值是不是**密文**入库。
   *
   * ★ 不是「能不能存」：没配 APOS_SECRET_KEY 照样存得下，只是明文进库。
   *   界面据此提示，而不是据此禁用输入。
   */
  encryptsInlineSecrets: boolean;
  credentialHelp: string;
}

export interface RepositoryRow {
  id: string;
  ref: string;
  name: string;
  remoteUrl: string;
  defaultBranch: string;
  branchPrefix: string;
  scope: 'project' | 'organization';
  projectId: string | null;
  status: string;
  credentialHint: string | null;
  credentialUsable: boolean;
  credentialProblem: string | null;
  /**
   * 认证形态。token 那套（用户名占位）和 SSH 那套（私钥、主机公钥）
   * 不重叠，配置页按它二选一渲染 —— 同时摆出来只会让人填错栏。
   */
  authKind: 'token' | 'ssh_key';
  /**
   * 即将用于 HTTP Basic 的用户名占位。
   *
   * ★ 这一项填错的表现是 401，而 401 的报错里没有任何东西指向它 ——
   *   所以要在配置页上直接显示「现在会用哪个、为什么是它」。
   */
  authUsername: string;
  authUsernameSource: 'explicit' | 'host' | 'default';
  authProvider: string | null;
  /** 主机公钥不是秘密，明文回显。空 = 还没固定，首次连接走 TOFU */
  sshKnownHosts: string | null;
  sshHostKeyPinned: boolean;
  /** 这段 known_hosts 固定了哪几台主机 */
  sshHosts: string[];
  checkCommand: string | null;
  checkTimeoutSeconds: number;
  /**
   * 产出交货到哪个存储目标。null = 推分支（默认）。
   *
   * ★ 填了就**不推分支**了 —— 是覆盖不是追加。
   */
  deliveryTargetId: string | null;
  warnings: string[];
}

/** 连通性探测结果（git ls-remote）*/
export interface RepositoryProbe {
  ok: boolean;
  /**
   * ★ ssh 与 host_key 是两档独立的失败：前者是「这把 key / 工具链有问题」，
   *   后者是「服务器换了密钥或有人在中间」。混进 network 的话，
   *   报错会把人指向网络，而那两种情况的下一步动作都不在网络上。
   */
  stage: 'git' | 'ssh' | 'host_key' | 'credential' | 'auth' | 'network' | 'branch' | 'ok';
  message: string | null;
  authKind?: 'token' | 'ssh_key';
  authUsername?: string;
  authUsernameSource?: 'explicit' | 'host' | 'default';
  branchCount?: number;
  branches: string[] | null;
}

export interface RepositoriesResponse {
  repositories: RepositoryRow[];
  gitAvailable: boolean;
  gitVersion: string | null;
  gitProblem: string | null;
  /** 镜像里少装 openssh-client 的话，ssh 形态的仓库一个都用不了 */
  sshAvailable: boolean;
  sshProblem: string | null;
  /** 直接粘贴的凭证是不是密文入库。false = 明文进库，不是存不下 */
  encryptsInlineSecrets: boolean;
}

/**
 * 存储目标 —— 非 Git 的工作区来源。
 *
 * ★ 与仓库分开的理由见 docs/tech/11-workspace-abstraction.md §7.2：
 *   repositories 的每一列都是 git 概念，一个 S3 bucket 塞进去要填占位符，
 *   而占位符会一路流到界面上（「默认分支：main」）。
 */
export interface StorageTargetRow {
  id: string;
  ref: string;
  name: string;
  kind: 'object_storage' | 'local';
  endpoint: string | null;
  region: string;
  bucket: string | null;
  prefix: string;
  /** path-style（host/bucket/key）还是 virtual-host-style（bucket.host/key） */
  forcePathStyle: boolean;
  rootPath: string | null;
  /** 只读挂载在交货阶段会被原样跳过 —— 登记成只读却指望它接收产物是常见的坑 */
  writable: boolean;
  /** 产出交货到哪个存储目标。null = 写回自己 */
  deliveryTargetId: string | null;
  scope: 'project' | 'organization';
  projectId: string | null;
  status: string;
  credentialHint: string | null;
  credentialUsable: boolean;
  credentialProblem: string | null;
  warnings: string[];
}

export interface StorageTargetProbe {
  ok: boolean;
  /**
   * ★ allowlist 与 not_found 是两档独立的失败：前者要改**部署环境**的
   *   APOS_LOCAL_MOUNT_ROOTS，后者要改登记里的路径。混成一句的话，
   *   管理员会一直在界面上改路径，而闸门根本不在界面上。
   */
  stage: 'ok' | 'config' | 'credential' | 'allowlist' | 'network' | 'auth' | 'not_found';
  message: string;
  objectCount: number | null;
  samples: string[];
}

export interface StorageTargetsResponse {
  storageTargets: StorageTargetRow[];
  /**
   * 部署方允许挂载的宿主目录白名单。
   *
   * ★ 它是环境变量，管理员在界面上看不到，而一条 local 登记「过没过闸」
   *   完全由它决定 —— 不显示的话，被闸掉的登记在页面上和正常的一模一样。
   */
  localMountRoots: string[];
  localMountRestricted: boolean;
  encryptsInlineSecrets: boolean;
}

export interface ConventionRow {
  id: string;
  title: string;
  content: string;
  appliesTo: string[];
  priority: string;
  enabled: boolean;
  position: number;
  updatedAt: string;
}

export interface ConventionsResponse {
  conventions: ConventionRow[];
  notice: string;
}

// ── 组织（顶层容器；Plane 里叫 Workspace）──────────────────────────────
/**
 * ★ 这里不叫 Workspace：`workspace` 在这个代码库里已经指 Agent 的 git 工作区。
 *   两个都叫这个名字，排障时没人分得清在说哪一个。
 */
export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  /** 当前身份在**这个**组织里的角色 —— 同一个人在别的组织可以不一样 */
  orgRole: string;
  orgRoleLabel: string;
  projectCount: number;
  joinedAt: string;
}

export interface OrganizationsResponse {
  organizations: OrganizationRow[];
  /** ★ 服务端算出来的当前组织。前端不该自己猜缺省值 */
  currentOrgId: string;
}

export interface OrganizationMemberRow {
  userId: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  status: string;
  orgRole: string;
  orgRoleLabel: string;
  addedAt: string;
}

export interface OrganizationMembersResponse {
  members: OrganizationMemberRow[];
  assignableOrgRoles: { role: string; label: string }[];
}

/** 执行方式 —— 与「要不要人批」是两件事，后者是 approvalGate */
export type ExecutionModeValue = 'auto' | 'agent' | 'human';

export interface CandidateAgent {
  agentId: string;
  name: string;
  runtimeKind: string | null;
  status: string | null;
  registered: boolean;
  maxConcurrency: number | null;
}

export interface EligibleAgent extends CandidateAgent {
  score: number;
  /** 面向用户的匹配依据，直接展示 */
  reasons: string[];
}

export interface IneligibleAgent extends CandidateAgent {
  /** ★ 不可选的必须带原因：空下拉框回答不了「为什么选不了」 */
  reason: string;
}

export interface ExecutorCandidates {
  executionMode: ExecutionModeValue;
  current: { executorType: 'agent' | 'human' | null; executorId: string | null };
  agents: { eligible: EligibleAgent[]; ineligible: IneligibleAgent[] };
  humans: { userId: string; name: string; email: string | null; role: string }[];
}

export interface ProjectAgentBindings {
  bindings: {
    id: string;
    role: string;
    /** 0 = 主 Agent，往后是备选。主的不可用时按这个顺序退 */
    priority: number;
    agentId: string;
    agentName: string;
    runtimeKind: string;
    status: string;
    applicableTypes: string[];
    updatedAt: string;
  }[];
  /** ★ 只列本项目成员里的 Agent —— 列全组织的话会选到保存时才被拒的那些 */
  available: {
    agentId: string;
    name: string;
    runtimeKind: string;
    status: string;
    applicableTypes: string[];
    skills: string[];
  }[];
}

export interface ArtifactFileList {
  artifactId: string;
  projectId: string;
  /** ★ 目录可能已随工作区回收 —— 与「这次没产出」是两回事，所以带原因 */
  available: boolean;
  reason: string | null;
  files: {
    path: string;
    size: number;
    isDirectory: boolean;
    /** 新增 / 修改 / 删除。deleted 的文件不在归档里，但必须列出来 */
    change: 'added' | 'modified' | 'deleted' | null;
  }[];
  truncated: boolean;
  /** ★ 本地归档只存改完之后的内容，没有变更前的版本 —— 所以没有对照 diff */
  diffAvailable: boolean;
}

export interface ArtifactFileContent {
  artifactId: string;
  projectId: string;
  path: string;
  size: number;
  mime: string;
  /** 二进制或超大文件为 null，此时 reason 说明为什么 */
  preview: string | null;
  reason: string | null;
}

/**
 * 项目级 Agent 生效权限。
 *
 * ★★ 界面拿到的是**已经算好、且已经翻译成人话**的结论，不是原始配置。
 *
 *   让前端自己按档案 + 上限 + 运行时算一遍，等于把求值器抄第二份 ——
 *   而两份实现的分歧会表现为「界面显示它能推分支，实际派下去推不了」。
 *   这里的每个字段都来自服务端那一次求值。
 */
export interface AgentAccessView {
  agentId: string;
  agentName: string;
  runtimeKind: string;
  profileKey: string;
  profileVersion: number;
  /** 没配过：界面要说「用的是默认档案」，而不是显示一份假配置 */
  usingDefault: boolean;
  /** 档案出了新版；只提示，不自动升级 */
  profileOutdated: boolean;
  capabilities: string[];
  deniedCapabilities: string[];
  resourceScopes: { kind: string; ref: string; access: string; origin?: string }[];
  sources: { capability: string; source: string; denied: boolean }[];
  /** 运行时兜不住的那部分，必须显示 */
  warnings: string[];
  explained: { capability: string; label: string; labelEn: string; risk: string }[];
  profiles: {
    key: string;
    name: string;
    nameEn: string;
    description: string;
    descriptionEn: string;
  }[];
}

export interface AgentAccessPreview {
  direction: 'loosen' | 'tighten' | 'neutral';
  addedCapabilities: string[];
  removedCapabilities: string[];
  affectedResources: string[];
  requiresReason: boolean;
  warnings: string[];
}

export interface AgentAccessBody {
  profileKey: string;
  addCapabilities?: string[];
  removeCapabilities?: string[];
  resourceScopes?: { kind: string; ref: string; access: string }[];
  reason?: string | null;
}

/**
 * 角色改动的影响预览。
 *
 * ★★ 角色是**组织级**的：改一次可能同时改掉五个项目里十几个人的可做操作。
 *   这件事在保存之后没有任何界面会告诉他，所以必须在保存之前说。
 */
export interface RolePreview {
  direction: 'loosen' | 'tighten' | 'neutral';
  added: { key: string; label: string }[];
  removed: { key: string; label: string }[];
  affectedHumans: number;
  affectedAgents: number;
  /** 给 Agent 也能担任的角色加 humanOnly 权限 —— 保存时会被拒，这里提前说 */
  humanOnlyConflicts: { key: string; label: string }[];
  builtin: boolean;
  requiresReason: boolean;
}

/** 平台的语义能力目录。每一条都带上「授予它意味着什么」 */
export interface CapabilityCatalog {
  capabilities: {
    key: string;
    label: string;
    labelEn: string;
    consequence: string;
    consequenceEn: string;
    risk: string;
    /** 平台底线：任何配置都授不出去 */
    neverAutoGrant: boolean;
  }[];
}
