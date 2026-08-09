import type { PlanDiff } from '@apos/domain';
import type {
  HumanGate,
  RiskLevel,
  Stage,
  WorkItemStatus,
} from '@apos/contracts';

/**
 * 接口返回形状。
 *
 * ★ 只写后端实际返回的字段，不「预留」——
 *   前端多写一个字段，后端没给，运行时就是 undefined，
 *   而类型系统会说它存在。宁可少写。
 */

export interface BoardCard {
  id: string;
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
  blockedMinutes: number | null;
  progress: { step: number; total: number | null; description: string | null } | null;
  cost: string;
  estimatedCost: string | null;
  runId: string | null;
  runStatus: string | null;
  consecutiveFailures: number;
  latestNote: string | null;
  artifactCount: number;
  unmetDependencies: number;
  updatedAt: string;
}

export interface BoardColumn {
  key: Stage;
  name: string;
  wipLimit: number | null;
  count: number;
  items: BoardCard[];
  hasMore: boolean;
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
  orgRole: string;
  approvalScopes: string[];
}

export interface Project {
  id: string;
  name: string;
  goal: string | null;
  status: string;
  autonomyLevel: string;
  budgetAmount: string | null;
  costSpent: string;
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
  costLimitPerRun: string | null;
  stats: Record<string, unknown>;
  load: number;
  todaySpentUsd: number;
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
    title: string;
    description: string | null;
    type: string;
    status: WorkItemStatus;
    stage: Stage;
    riskLevel: RiskLevel;
    priority: number;
    humanGate: HumanGate | null;
    blockedReason: string | null;
    actualCost: string;
    estimatedCost: string | null;
    consecutiveFailures: number;
    acceptanceCriteria: { id: string; text: string; status: string; verification: string }[];
    constraints: { type: string; description: string; enforcement: string }[];
    updatedAt: string;
  };
  runs: {
    id: string;
    attempt: number;
    status: string;
    cost: string;
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
  costDelta: string | null;
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
    costLimitPerRun: string | null;
  } | null;
  workItem: { id: string; title: string; status: string; estimatedCost: string | null } | null;
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
    cost: string;
    estimatedCost: string | null;
    costLimit: string | null;
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
    attempts: { id: string; attempt: number; status: string; cost: string; errorClass: string | null }[];
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
  costUsd: number;
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
    priority: string;
    rejectReason: string | null;
    approvedAt: string | null;
  };
  clarifications: Clarification[];
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
    estimatedCost: number;
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
    estimatedCost: number;
    budget: number | null;
    spent: number;
    overBudget: boolean;
    humanGateCount: number;
    highRiskTasks: number;
  };
  autoActions: { description: string; policyName: string | null; reversible: boolean; externalVisible: boolean }[];
  humanGates: { taskTitle: string; reason: string; assigneeHint: string }[];
  currentBoundary: { auto: string[]; human: string[]; depends: { label: string; when: string | null }[] };
  tasks: {
    id: string;
    title: string;
    type: string;
    status: WorkItemStatus;
    stage: Stage;
    riskLevel: RiskLevel;
    estimatedHours: number | null;
    estimatedCost: number | null;
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
  cost: { spent: number; budget: number | null };
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
    cost: number;
  }[];
  members: {
    id: string;
    name: string;
    role: string;
    pendingDecisions: number;
    overdueDecisions: number;
  }[];
  trend: { wip: { day: string; value: number }[]; blocked: { day: string; value: number }[] };
  recentActivity: { id: string; type: string; actorType: string; occurredAt: string; payload: Record<string, unknown> }[];
}

export interface AgentListResponse {
  agents: {
    id: string;
    name: string;
    type: string;
    model: string | null;
    status: string;
    pausedReason: string | null;
    load: { running: number; max: number };
    runs: number;
    successRate: number | null;
    firstTrySuccessRate: number | null;
    overrideRate: number | null;
    cost: number;
    ownerName: string;
  }[];
  totals: { cost: number; runs: number; successRate: number | null };
}

export interface CapabilityReport {
  runtime: { name: string; version: string };
  protocolVersion: string;
  transport: { eventDelivery: string; heartbeatIntervalSeconds: number | null };
  models: string[];
  limits: { maxConcurrentRuns: number; maxRunDurationSeconds: number; maxContextTokens: number | null };
  tools: { name: string; description: string; sideEffects: string }[];
  supported: { feature: string; label: string }[];
  missing: { feature: string; label: string; behavior: string; userImpact: string; severity: string }[];
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
    costLimitPerRun: number | null;
    costLimitDaily: number | null;
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
    avgCost: number;
    totalCost: number;
    avgMinutes: number | null;
  } | null;
  /** 只含未完成的任务 —— 已完成的数量在 queueDoneCount */
  queue: { id: string; title: string; status: string; riskLevel: string }[];
  queueDoneCount: number;
  recentRuns: {
    id: string;
    workItemId: string;
    workItemTitle: string;
    status: string;
    attempt: number;
    cost: number;
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
  stats: { total: number; mine: number; overdue: number; dueSoon: number; actionable: number };
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
  sourceOfTruth: 'apos' | 'external' | 'merge';
  strategy: 'writeback' | 'record_conflict' | 'accept_and_warn';
  strategyLabel: string;
  why: string;
  options: ('apos' | 'external' | 'merge')[];
  /** 偏离默认值 —— 用户改过的地方下次读这一页时要一眼看见 */
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
  autoRules: { field: string; fieldLabel: string; winner: string }[];
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
  fieldCatalog: {
    field: string;
    label: string;
    sourceOfTruth: string;
    options: string[];
    why: string;
  }[];
  presets: { key: string; label: string; description: string }[];
  strategyLabels: Record<string, string>;
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

export interface RuntimeKindSpec {
  kind: string;
  label: string;
  description: string;
  needsCredential: boolean;
  credentialLabel: string | null;
  needsEndpoint: boolean;
}

export interface RuntimeAdminRow {
  id: string;
  name: string;
  kind: string;
  endpoint: string | null;
  status: string;
  statusReason: string | null;
  protocolVersion: string | null;
  /** ★ 只有后四位。接口永不回显凭证原值 */
  credentialHint: string | null;
  credentialUsable: boolean;
  credentialKind: 'none' | 'env' | 'encrypted' | 'fingerprint';
  credentialProblem: string | null;
  registered: boolean;
  reachable: boolean;
  problem: string | null;
  lastCheckAt: string | null;
  agentCount: number;
  agentNames: string[];
  capability: {
    runtime: { name: string; version: string };
    protocolVersion: string;
    models: string[];
    limits: { maxConcurrentRuns: number; maxRunDurationSeconds: number; maxContextTokens: number | null };
    tools: { name: string; description: string; sideEffects: string }[];
    supported: string[];
    missing: { feature: string; behavior: string; userImpact: string; severity: string }[];
    restricted: boolean;
  } | null;
}

export interface RuntimeAdminResponse {
  runtimes: RuntimeAdminRow[];
  kinds: RuntimeKindSpec[];
  canStoreInlineCredential: boolean;
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
  warning: string | null;
}

export interface RepositoriesResponse {
  repositories: RepositoryRow[];
  gitAvailable: boolean;
  gitVersion: string | null;
  gitProblem: string | null;
  canStoreInlineCredential: boolean;
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
