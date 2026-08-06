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
