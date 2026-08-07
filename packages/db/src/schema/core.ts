import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  AcceptanceCriterion,
  Action,
  AgentPermissions,
  Condition,
  ExecutionConstraint,
  HumanGate,
  PolicyContext,
  ResourceScope,
} from '@apos/contracts';
import {
  actorTypeEnum,
  autonomyLevelEnum,
  clarificationLevelEnum,
  decisionStatusEnum,
  dependencyTypeEnum,
  projectStatusEnum,
  requirementStatusEnum,
  riskLevelEnum,
  runStatusEnum,
  stageEnum,
  workItemStatusEnum,
  workItemTypeEnum,
} from './enums';

const now = sql`now()`;

// ── 组织与身份 ────────────────────────────────────────────────────────────

export const organizations = pgTable('organizations', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp({ withTimezone: true }).notNull().default(now),
});

export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull().references(() => organizations.id),
    email: text().notNull(),
    name: text().notNull(),
    avatarUrl: text(),
    orgRole: text().notNull().default('member'),
    skills: text().array().notNull().default(sql`'{}'`),
    /** 可审批事项，支撑产品文档 8.7.5 的决策责任自动识别 */
    approvalScopes: text().array().notNull().default(sql`'{}'`),
    notificationPrefs: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    status: text().notNull().default('active'),
    createdAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [unique().on(t.orgId, t.email)],
);

// ── Project ──────────────────────────────────────────────────────────────

export const projects = pgTable(
  'projects',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull().references(() => organizations.id),
    name: text().notNull(),
    goal: text(),
    type: text().notNull().default('development'),
    status: projectStatusEnum().notNull().default('active'),
    autonomyLevel: autonomyLevelEnum().notNull().default('agent_led_approval'),
    riskLevel: riskLevelEnum().notNull().default('medium'),

    sponsorId: uuid().references(() => users.id),
    techLeadId: uuid().references(() => users.id),

    startsAt: date(),
    endsAt: date(),
    budgetAmount: numeric({ precision: 12, scale: 2 }),
    budgetCurrency: text().notNull().default('USD'),
    /** 冗余累加，避免看板每张卡片都聚合 agent_runs；每日对账纠偏 */
    costSpent: numeric({ precision: 12, scale: 2 }).notNull().default('0'),

    stageConfig: jsonb().$type<string[]>().notNull().default([
      'intake',
      'planning',
      'execution',
      'review',
      'release',
      'done',
    ]),
    wipLimits: jsonb().$type<Record<string, number>>().notNull().default({}),

    pausedReason: text(),
    pausedBy: uuid(),
    deletedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().default(now),
    updatedAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [index().on(t.orgId, t.status)],
);

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: uuid().notNull().references(() => projects.id),
    /** Agent 与人类走同一张表 —— 权限判定上「是否属于本项目」是同一个问题 */
    actorType: actorTypeEnum().notNull(),
    actorId: uuid().notNull(),
    role: text().notNull(),
    addedAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.actorType, t.actorId] })],
);

// ── Requirement ──────────────────────────────────────────────────────────

export const requirements = pgTable(
  'requirements',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    projectId: uuid().notNull().references(() => projects.id),
    status: requirementStatusEnum().notNull().default('draft'),

    /** 原文永不覆盖 —— 用户必须能验证 AI 没有曲解自己的意思 */
    rawInput: text().notNull(),
    inputMethod: text().notNull().default('manual'),
    sourceRef: jsonb().$type<{ system: string; key: string; url?: string } | null>(),

    title: text(),
    businessContext: text(),
    userProblem: text(),
    businessGoal: text(),
    userStories: jsonb().$type<unknown[]>().notNull().default([]),
    scope: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    nonFunctional: jsonb().$type<unknown[]>().notNull().default([]),
    successMetrics: jsonb().$type<unknown[]>().notNull().default([]),
    constraints: jsonb().$type<unknown[]>().notNull().default([]),
    risks: jsonb().$type<unknown[]>().notNull().default([]),
    acceptanceCriteria: jsonb().$type<AcceptanceCriterion[]>().notNull().default([]),

    /** 字段级溯源，支撑需求页的原文对照高亮。事后无法补，必须结构化时就记录 */
    fieldProvenance: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    completeness: jsonb().$type<Record<string, unknown>>().notNull().default({}),

    priority: text().notNull().default('medium'),
    dueAt: timestamp({ withTimezone: true }),

    approvedBy: uuid(),
    approvedAt: timestamp({ withTimezone: true }),
    rejectReason: text(),

    deletedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().default(now),
    updatedAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [index().on(t.projectId, t.status)],
);

export const requirementClarifications = pgTable('requirement_clarifications', {
  id: uuid().primaryKey().defaultRandom(),
  requirementId: uuid().notNull().references(() => requirements.id),
  level: clarificationLevelEnum().notNull(),
  question: text().notNull(),
  /** 不回答会怎样 —— 让用户理解紧迫性 */
  impact: text(),
  agentSuggestion: text(),
  suggestionBasis: text(),
  options: jsonb().$type<unknown[]>().notNull().default([]),
  answer: text(),
  answeredBy: uuid(),
  answeredAt: timestamp({ withTimezone: true }),
  resolvedSource: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().default(now),
});

export const requirementAssumptions = pgTable('requirement_assumptions', {
  id: uuid().primaryKey().defaultRandom(),
  requirementId: uuid().notNull().references(() => requirements.id),
  statement: text().notNull(),
  origin: text().notNull(),
  /** null = 未经人类确认 */
  confirmedBy: uuid(),
  /** 执行中被证伪时标记，触发需求冲突决策（产品文档 8.8.4） */
  invalidatedAt: timestamp({ withTimezone: true }),
  invalidatedReason: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().default(now),
});

// ── Plan ─────────────────────────────────────────────────────────────────

export const plans = pgTable(
  'plans',
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid().notNull().references(() => projects.id),
    requirementId: uuid().references(() => requirements.id),
    version: integer().notNull(),
    status: text().notNull().default('draft'),

    scope: jsonb().$type<Record<string, unknown>>(),
    phases: jsonb().$type<unknown[]>().notNull().default([]),
    criticalPath: uuid().array().notNull().default(sql`'{}'`),
    milestones: jsonb().$type<unknown[]>().notNull().default([]),
    risks: jsonb().$type<unknown[]>().notNull().default([]),
    releasePlan: jsonb().$type<Record<string, unknown>>(),
    rollbackPlan: jsonb().$type<Record<string, unknown>>(),

    estimatedHours: numeric({ precision: 8, scale: 2 }),
    estimatedCost: numeric({ precision: 10, scale: 2 }),
    estimatedEnd: date(),

    /**
     * ★ 必须快照存储，不能展示时重算：用户批准的是「当时那份清单」。
     * Policy 后来变了，追溯「他到底批准了什么」必须看快照。
     */
    autoActions: jsonb().$type<unknown[]>().notNull().default([]),
    humanGates: jsonb().$type<unknown[]>().notNull().default([]),

    generatedBy: uuid(),
    generationRunId: uuid(),
    model: text(),
    generationCost: numeric({ precision: 10, scale: 4 }),
    generationMs: integer(),

    approvedBy: uuid().array().notNull().default(sql`'{}'`),
    approvedAt: timestamp({ withTimezone: true }),
    revisionFeedback: text(),

    createdAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [unique().on(t.projectId, t.requirementId, t.version)],
);

// ── Work Item ────────────────────────────────────────────────────────────

export const workItems = pgTable(
  'work_items',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    projectId: uuid().notNull().references(() => projects.id),
    requirementId: uuid().references(() => requirements.id),
    planId: uuid().references(() => plans.id),

    type: workItemTypeEnum().notNull(),
    status: workItemStatusEnum().notNull().default('draft'),
    /** 冗余：由 status 映射，看板按列查询用 */
    stage: stageEnum().notNull(),
    title: text().notNull(),
    description: text(),
    priority: smallint().notNull().default(2),
    riskLevel: riskLevelEnum().notNull().default('low'),

    parentId: uuid(),
    /** ltree 路径，子树查询用。Drizzle 无原生 ltree，用 text + 自定义索引 */
    path: text(),
    position: integer().notNull().default(0),

    /** 人类负责人（问责）与执行主体分离，支持「Agent 执行、人类审核」 */
    ownerId: uuid(),
    executorType: actorTypeEnum(),
    executorId: uuid(),

    plannedStart: timestamp({ withTimezone: true }),
    plannedEnd: timestamp({ withTimezone: true }),
    actualStart: timestamp({ withTimezone: true }),
    actualEnd: timestamp({ withTimezone: true }),
    estimatedHours: numeric({ precision: 6, scale: 2 }),

    estimatedCost: numeric({ precision: 10, scale: 4 }),
    actualCost: numeric({ precision: 10, scale: 4 }).notNull().default('0'),

    acceptanceCriteria: jsonb().$type<AcceptanceCriterion[]>().notNull().default([]),
    /** 来自 Approve with Constraints，Agent 执行时必须遵守 */
    constraints: jsonb().$type<ExecutionConstraint[]>().notNull().default([]),

    humanGate: text().$type<HumanGate | null>(),
    humanGateRef: uuid(),

    blockedSince: timestamp({ withTimezone: true }),
    blockedReason: text(),
    blockedDetail: jsonb().$type<Record<string, unknown>>(),

    /** 决策等待前的状态，支撑状态机的 $previous 机制 */
    previousStatus: workItemStatusEnum(),
    consecutiveFailures: integer().notNull().default(0),

    typeData: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    externalRefs: jsonb()
      .$type<{ system: string; key: string; url: string | null }[]>()
      .notNull()
      .default([]),

    /** 乐观锁 */
    version: integer().notNull().default(1),
    deletedAt: timestamp({ withTimezone: true }),
    mergedInto: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().default(now),
    updatedAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [
    index('work_items_board_idx').on(t.projectId, t.stage, t.status),
    index('work_items_executor_idx').on(t.executorType, t.executorId, t.status),
    index('work_items_owner_idx').on(t.ownerId),
    index('work_items_blocked_idx').on(t.projectId, t.blockedSince),
    index('work_items_path_idx').on(t.path),
  ],
);

export const workItemDependencies = pgTable(
  'work_item_dependencies',
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid().notNull(),
    fromId: uuid().notNull().references(() => workItems.id),
    toId: uuid().notNull().references(() => workItems.id),
    type: dependencyTypeEnum().notNull().default('finish_to_start'),
    lagMinutes: integer().notNull().default(0),
    createdByType: actorTypeEnum().notNull(),
    createdById: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [
    unique().on(t.fromId, t.toId, t.type),
    index('deps_to_idx').on(t.toId),
    index('deps_from_idx').on(t.fromId),
  ],
);

// ── Agent ────────────────────────────────────────────────────────────────

export const agentRuntimes = pgTable('agent_runtimes', {
  id: uuid().primaryKey().defaultRandom(),
  orgId: uuid().notNull(),
  name: text().notNull(),
  kind: text().notNull(),
  endpoint: text(),
  /** 指向密钥管理，不存明文 */
  credentialRef: text(),
  protocolVersion: text(),
  /** 能力协商结果，决定降级行为 */
  capabilities: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  status: text().notNull().default('active'),
  lastCheckAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().default(now),
});

export const agents = pgTable(
  'agents',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull().references(() => organizations.id),
    name: text().notNull(),
    type: text().notNull(),
    description: text(),

    runtimeId: uuid().notNull().references(() => agentRuntimes.id),
    runtimeRef: text().notNull(),
    model: text(),

    skills: text().array().notNull().default(sql`'{}'`),
    applicableTypes: workItemTypeEnum().array().notNull().default(sql`'{}'`),

    /** ★ 权限独立配置，绝不继承人类用户 */
    allowedTools: text().array().notNull().default(sql`'{}'`),
    /** 黑名单优先，不可被模板或继承覆盖 */
    deniedTools: text().array().notNull().default(sql`'{}'`),
    resourceScopes: jsonb().$type<ResourceScope[]>().notNull().default([]),

    maxConcurrency: integer().notNull().default(3),
    timeoutSeconds: integer().notNull().default(1800),
    costLimitPerRun: numeric({ precision: 10, scale: 4 }),
    costLimitDaily: numeric({ precision: 10, scale: 2 }),
    retryPolicy: jsonb().$type<Record<string, unknown>>().notNull().default({
      max_attempts: 2,
      backoff_seconds: [60, 300],
    }),

    /** 不可为空 —— 出问题时的问责链条不能断 */
    ownerId: uuid().notNull().references(() => users.id),

    status: text().notNull().default('active'),
    pausedReason: text(),
    stats: jsonb().$type<Record<string, unknown>>().notNull().default({}),

    createdAt: timestamp({ withTimezone: true }).notNull().default(now),
    updatedAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [index('agents_org_status_idx').on(t.orgId, t.status)],
);

export const agentPermissionChanges = pgTable('agent_permission_changes', {
  id: uuid().primaryKey().defaultRandom(),
  agentId: uuid().notNull().references(() => agents.id),
  changedBy: uuid().notNull().references(() => users.id),
  direction: text().notNull(),
  before: jsonb().$type<AgentPermissions>().notNull(),
  after: jsonb().$type<AgentPermissions>().notNull(),
  reason: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().default(now),
});

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    projectId: uuid().notNull(),
    workItemId: uuid().notNull().references(() => workItems.id),
    agentId: uuid().notNull().references(() => agents.id),
    attempt: integer().notNull().default(1),
    previousRunId: uuid(),

    status: runStatusEnum().notNull().default('queued'),
    /** 防重复派发 —— 网络重试导致 Agent 重复执行是真实风险 */
    idempotencyKey: text().notNull(),

    goal: text().notNull(),
    inputContext: jsonb().$type<unknown[]>().notNull().default([]),
    model: text(),
    modelConfig: jsonb().$type<Record<string, unknown>>(),
    toolsSnapshot: text().array().notNull().default(sql`'{}'`),
    /** ★ 派发时的权限快照：权限可能在 Run 之后被改，审计回溯需要当时的状态 */
    permissionSnapshot: jsonb().$type<AgentPermissions>(),

    stepCurrent: integer(),
    stepTotal: integer(),
    stepDescription: text(),
    progressNote: text(),

    tokensInput: bigint({ mode: 'number' }).notNull().default(0),
    tokensOutput: bigint({ mode: 'number' }).notNull().default(0),
    tokensCacheRead: bigint({ mode: 'number' }).notNull().default(0),
    cost: numeric({ precision: 10, scale: 4 }).notNull().default('0'),
    toolCallCount: integer().notNull().default(0),

    errorClass: text(),
    errorMessage: text(),
    errorDetail: jsonb().$type<Record<string, unknown>>(),
    /** Agent 用自然语言解释为什么卡住 —— 比堆栈有用得多 */
    agentSelfReport: text(),

    startedAt: timestamp({ withTimezone: true }),
    endedAt: timestamp({ withTimezone: true }),
    lastHeartbeatAt: timestamp({ withTimezone: true }),
    timeoutAt: timestamp({ withTimezone: true }),

    createdAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [
    uniqueIndex('agent_runs_idem_idx').on(t.idempotencyKey),
    /** 孤儿 Run 检测专用 */
    index('agent_runs_heartbeat_idx').on(t.status, t.lastHeartbeatAt),
    index('agent_runs_item_idx').on(t.workItemId, t.attempt),
    index('agent_runs_agent_idx').on(t.agentId, t.createdAt),
  ],
);

export const runEvents = pgTable(
  'run_events',
  {
    runId: uuid().notNull(),
    seq: integer().notNull(),
    ts: timestamp({ withTimezone: true }).notNull().default(now),
    type: text().notNull(),
    /** milestone 用于简明模式；detail 是工具调用级噪声 */
    level: text().notNull().default('detail'),
    summary: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>(),
    costDelta: numeric({ precision: 10, scale: 6 }),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

// ── Decision ─────────────────────────────────────────────────────────────

export const decisions = pgTable(
  'decisions',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    projectId: uuid().notNull().references(() => projects.id),
    workItemId: uuid().references(() => workItems.id),
    runId: uuid().references(() => agentRuns.id),

    type: text().notNull(),
    status: decisionStatusEnum().notNull().default('pending'),
    riskLevel: riskLevelEnum().notNull(),
    reversible: boolean().notNull().default(true),

    title: text().notNull(),
    background: text(),
    /** 为什么需要人决定 —— 指明触发的 Policy */
    whyHuman: text().notNull(),
    /** ★ 不处理会怎样 —— 把紧迫性从抽象的「高优先级」变成具体的「阻塞 5 个任务」 */
    consequence: text(),
    impact: jsonb().$type<Record<string, unknown>>().notNull().default({}),

    triggeredByPolicy: uuid(),
    policyTrace: jsonb().$type<unknown[]>(),

    assigneeId: uuid().references(() => users.id),
    assigneeRole: text(),
    delegatedFrom: uuid(),
    requiresCosign: boolean().notNull().default(false),

    dueAt: timestamp({ withTimezone: true }),
    escalationLevel: smallint().notNull().default(0),
    escalatedAt: timestamp({ withTimezone: true }),
    /** 催办冷却，防重复轰炸 */
    remindedAt: timestamp({ withTimezone: true }),

    selectedOptionId: uuid(),
    resolutionNote: text(),
    resolvedBy: uuid(),
    resolvedAt: timestamp({ withTimezone: true }),
    appliedConstraints: jsonb().$type<ExecutionConstraint[]>().notNull().default([]),

    /** 结果回填，支撑「历史类似决策」的「结果如何」 */
    outcome: text(),
    outcomeNote: text(),
    outcomeAt: timestamp({ withTimezone: true }),

    createdAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [
    index('decisions_inbox_idx').on(t.assigneeId, t.status, t.dueAt),
    index('decisions_project_idx').on(t.projectId, t.status),
    /** 重复决策检测 */
    index('decisions_type_idx').on(t.type, t.status, t.createdAt),
  ],
);

export const decisionOptions = pgTable('decision_options', {
  id: uuid().primaryKey().defaultRandom(),
  decisionId: uuid().notNull().references(() => decisions.id),
  name: text().notNull(),
  description: text(),
  isRecommended: boolean().notNull().default(false),
  confidence: numeric({ precision: 4, scale: 3 }),
  rationale: text(),
  /** Agent 说明自己哪里没把握 —— 告诉人类该重点验证什么 */
  uncertainties: text().array().notNull().default(sql`'{}'`),
  attributes: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  reversible: boolean(),
  position: smallint().notNull().default(0),
});

export const decisionApprovals = pgTable(
  'decision_approvals',
  {
    decisionId: uuid().notNull().references(() => decisions.id),
    approverId: uuid().notNull().references(() => users.id),
    status: text().notNull().default('pending'),
    opinion: text(),
    decidedAt: timestamp({ withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.decisionId, t.approverId] })],
);

export const decisionEvidence = pgTable('decision_evidence', {
  id: uuid().primaryKey().defaultRandom(),
  decisionId: uuid().notNull().references(() => decisions.id),
  kind: text().notNull(),
  title: text().notNull(),
  ref: text(),
  producedByType: actorTypeEnum(),
  producedById: uuid(),
  /** 实时数据（如监控面板）比几小时前的报告更有决策价值 */
  isLive: boolean().notNull().default(false),
  createdAt: timestamp({ withTimezone: true }).notNull().default(now),
});

// ── Artifact ─────────────────────────────────────────────────────────────

export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    projectId: uuid().notNull(),
    workItemId: uuid().references(() => workItems.id),
    runId: uuid().references(() => agentRuns.id),

    kind: text().notNull(),
    title: text().notNull(),
    storage: text().notNull().default('external'),
    externalUrl: text(),
    storageKey: text(),
    content: text(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),

    producedByType: actorTypeEnum().notNull(),
    producedById: uuid(),
    fromIncompleteRun: boolean().notNull().default(false),

    createdAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [index('artifacts_item_idx').on(t.workItemId)],
);

// ── Policy ───────────────────────────────────────────────────────────────

export const policies = pgTable(
  'policies',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull().references(() => organizations.id),
    /** null = 组织级，项目不可删除、不可放宽 */
    projectId: uuid().references(() => projects.id),
    name: text().notNull(),
    description: text().notNull().default(''),
    priority: integer().notNull(),
    enabled: boolean().notNull().default(true),

    condition: jsonb().$type<Condition>().notNull(),
    action: jsonb().$type<Action>().notNull(),

    hitCount30d: integer().notNull().default(0),
    avgWaitSeconds: integer(),

    createdBy: uuid().notNull(),
    disabledBy: uuid(),
    disabledReason: text(),
    version: integer().notNull().default(1),
    createdAt: timestamp({ withTimezone: true }).notNull().default(now),
    updatedAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [index('policies_lookup_idx').on(t.orgId, t.projectId, t.priority)],
);

export const policyVersions = pgTable(
  'policy_versions',
  {
    policyId: uuid().notNull().references(() => policies.id),
    version: integer().notNull(),
    snapshot: jsonb().$type<Record<string, unknown>>().notNull(),
    changedBy: uuid().notNull(),
    direction: text(),
    /** 放宽类变更必须关联模拟结果 */
    simulationId: uuid(),
    changedAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.policyId, t.version] })],
);

// ── Integration（页面文档 14 / 产品文档 九）────────────────────────────────

/**
 * 项目与外部系统的连接。
 *
 * ★ 凭证不落这张表。`credentialRef` 指向密钥管理，
 *   接口永不回显明文（页面文档 14 §9「凭证安全」），页面只显示后四位。
 *   一张能查出 token 的表，迟早会有人把它 SELECT 出来贴进日志。
 */
export const integrations = pgTable(
  'integrations',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull().references(() => organizations.id),
    projectId: uuid().notNull().references(() => projects.id),

    provider: text().notNull(),
    category: text().notNull(),
    /** 连接对象的人类可读名：仓库 / 项目 key / 群组 */
    displayName: text().notNull(),
    /** 外部侧的定位信息（repo owner/name、Jira projectKey、群 id 等），不含凭证 */
    config: jsonb().$type<Record<string, unknown>>().notNull().default({}),

    /** ★ 只存引用。明文凭证不进业务库 */
    credentialRef: text(),
    /** 页面上显示的 ****1234，由建立连接时截取，之后再也拿不到原值 */
    credentialHint: text(),
    credentialExpiresAt: timestamp({ withTimezone: true }),

    /** 允许项与禁止项都要存 —— 页面必须能回答「它不能合并我的代码」 */
    scopes: jsonb().$type<{ allowed: string[]; denied: string[] }>().notNull().default({
      allowed: [],
      denied: [],
    }),

    status: text().notNull().default('active'),
    statusReason: text(),
    lastSyncAt: timestamp({ withTimezone: true }),

    /** 通知类集成用；其余为空 */
    notificationConfig: jsonb().$type<Record<string, unknown> | null>(),

    /** 使用统计：API 调用量、创建对象数、已阻止的循环同步次数 */
    stats: jsonb().$type<Record<string, unknown>>().notNull().default({}),

    createdBy: uuid().notNull().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().default(now),
    updatedAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [
    index('integrations_project_idx').on(t.projectId, t.status),
    /** 同一项目同一 provider 只连一个对象，避免同步目标含混 */
    unique('integrations_project_provider_uq').on(t.projectId, t.provider),
  ],
);

/** 字段级 Source of Truth 与冲突策略（页面文档 14 §5.3） */
export const integrationSyncMappings = pgTable(
  'integration_sync_mappings',
  {
    integrationId: uuid().notNull().references(() => integrations.id, { onDelete: 'cascade' }),
    field: text().notNull(),
    sourceOfTruth: text().notNull(),
    strategy: text().notNull(),
    updatedBy: uuid().references(() => users.id),
    updatedAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.integrationId, t.field] })],
);

/**
 * Work Item ↔ 外部对象的映射。
 *
 * ★ 唯一约束不是形式主义：一个 Work Item 映射到两个外部对象，
 *   回写时就有两个目标、拉取时就有两个来源，SoT 判定直接失去意义
 *   （页面文档 14 §11「同一 Work Item 映射到多个外部对象 —— 不允许」）。
 */
export const integrationObjectLinks = pgTable(
  'integration_object_links',
  {
    id: uuid().primaryKey().defaultRandom(),
    integrationId: uuid().notNull().references(() => integrations.id, { onDelete: 'cascade' }),
    workItemId: uuid().notNull().references(() => workItems.id),
    /** 外部对象标识，如 ORDER-142 / PR #37 */
    externalKey: text().notNull(),
    externalUrl: text(),

    /** 上次同步成功时两侧的公共值，逐字段存。判「这一侧改过没有」全靠它 */
    lastSyncedValues: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    lastSyncedAt: timestamp({ withTimezone: true }),
    /** 外部对象被删除时打标，不自动删本地数据（§11）*/
    externalDeletedAt: timestamp({ withTimezone: true }),

    createdAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [
    unique('integration_links_item_uq').on(t.integrationId, t.workItemId),
    unique('integration_links_external_uq').on(t.integrationId, t.externalKey),
    index('integration_links_item_idx').on(t.workItemId),
  ],
);

/** 同步冲突（页面文档 14 §5.3 的冲突处理界面） */
export const syncConflicts = pgTable(
  'sync_conflicts',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    projectId: uuid().notNull().references(() => projects.id),
    integrationId: uuid().notNull().references(() => integrations.id, { onDelete: 'cascade' }),
    linkId: uuid().notNull().references(() => integrationObjectLinks.id, { onDelete: 'cascade' }),

    field: text().notNull(),
    /** 两侧的值 / 时间 / 修改人 —— 少一样用户就只能靠猜决定听谁的 */
    aposSide: jsonb().$type<Record<string, unknown>>().notNull(),
    externalSide: jsonb().$type<Record<string, unknown>>().notNull(),
    sourceOfTruth: text().notNull(),

    status: text().notNull().default('pending'),
    resolvedWinner: text(),
    resolvedBy: uuid().references(() => users.id),
    resolvedAt: timestamp({ withTimezone: true }),
    /** 「以后同类冲突自动按此处理」命中时置真 */
    autoResolved: boolean().notNull().default(false),

    createdAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [index('sync_conflicts_project_idx').on(t.projectId, t.status, t.createdAt)],
);

/**
 * 「以后同类冲突自动按此处理」的记忆。
 *
 * ★ 单独一张表而不是塞进 mapping：它是用户在冲突现场做的临时决定，
 *   和 SoT 配置不是一回事，随时可以撤销，撤销时也不该动 SoT。
 */
export const syncConflictRules = pgTable(
  'sync_conflict_rules',
  {
    integrationId: uuid().notNull().references(() => integrations.id, { onDelete: 'cascade' }),
    field: text().notNull(),
    winner: text().notNull(),
    createdBy: uuid().notNull().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.integrationId, t.field] })],
);

/**
 * 开发用的「假外部系统」存放处。
 *
 * ★ 这不是集成模型的一部分，是进程内适配器的持久化后端。
 *   种子脚本和 API 是两个进程，假外部系统只活在种子进程里的话，
 *   页面上点「立即同步」什么也不会发生 —— 而那正是最该被看见能工作的一步。
 *   真实 provider 接上之后这张表就没有用了，可以直接删。
 */
export const devExternalObjects = pgTable(
  'dev_external_objects',
  {
    provider: text().notNull(),
    externalKey: text().notNull(),
    url: text(),
    fields: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    lastChange: jsonb().$type<Record<string, unknown> | null>(),
    deleted: boolean().notNull().default(false),
    updatedAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.provider, t.externalKey] })],
);

// ── Event ────────────────────────────────────────────────────────────────

/**
 * 领域事件。只允许 INSERT —— 应用连接的数据库角色不应有 UPDATE/DELETE 权限。
 * 需要「更正」历史事件时写补偿事件，不改旧的。
 */
export const events = pgTable(
  'events',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey(),
    orgId: uuid().notNull(),
    projectId: uuid(),
    type: text().notNull(),
    level: text().notNull().default('milestone'),

    actorType: actorTypeEnum().notNull(),
    actorId: uuid(),
    subjectType: text().notNull(),
    subjectId: uuid().notNull(),

    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** ★ Policy 模拟回放所需。缺了它，模拟功能等于无米之炊。 */
    contextSnapshot: jsonb().$type<PolicyContext | null>(),

    causationId: bigint({ mode: 'bigint' }),
    correlationId: uuid().notNull(),

    occurredAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [
    index('events_subject_idx').on(t.subjectType, t.subjectId, t.occurredAt),
    index('events_project_idx').on(t.projectId, t.level, t.id),
    index('events_correlation_idx').on(t.correlationId),
    index('events_actor_idx').on(t.actorType, t.actorId, t.occurredAt),
    /** Policy 模拟的数据源查询 */
    index('events_policy_sim_idx').on(t.type, t.occurredAt),
  ],
);
