import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  foreignKey,
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
import { OrgRole } from '@apos/contracts';
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

/**
 * 角色取值的库级约束（docs/tech/09-security.md §2.2）。
 *
 * ★ 角色是权限判定的输入。库里存进一个拼错的 `techlead`，判定会把它
 *   当成「不是任何已知角色」——也就是**什么都做不了**，而现象是
 *   「这个人明明是负责人却处处受限」，没有任何报错指向根因。
 *   取值收在库里，错的写不进去。
 *
 * ★ 清单直接来自 contracts，与判定共用一份定义：改枚举时迁移会跟着变，
 *   不会出现「代码认得这个角色、库不认」的错位。
 */
const sqlList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

// ── 组织与身份 ────────────────────────────────────────────────────────────

/**
 * 组织 —— 一切数据的顶层容器（Plane 里叫 Workspace）。
 *
 * ★★ 这里**不**叫 workspace，是刻意的。
 *
 *   `workspace` 在这个代码库里已经有一个确定含义：Agent 干活的那个
 *   git 工作区（`AGENT_WORKSPACE_ROOT`、`WorkspaceService`、
 *   `agent_runs.workspace`）。两个都叫 workspace 的话，
 *   「清理 workspace」「workspace 权限」这类句子会同时指向两件毫不相干的事，
 *   而这种歧义在排障时最贵 —— 看日志的人根本不知道在说哪一个。
 *
 *   组织这个概念在这里已经铺满了 25 张表的 `org_id`、整套 `OrgRole`
 *   与 `org_admin` 判定；改名是纯字面工作，收益为零，还要正面撞车。
 *   所以：**产品层叫「组织」，`workspace` 一词永远只指 Agent 工作区。**
 */
export const organizations = pgTable('organizations', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  /**
   * URL 里的人类可读标识（`acme`）。
   *
   * ★ 全局唯一而不是「每个所有者唯一」：它要能单独出现在链接里，
   *   同名就指不到同一个组织了。
   */
  slug: text().notNull(),
  description: text(),
  settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  createdBy: uuid(),
  createdAt: timestamp({ withTimezone: true }).notNull().default(now),
  updatedAt: timestamp({ withTimezone: true }).notNull().default(now),
}, (t) => [
  unique('organizations_slug_unique').on(t.slug),
]);

/**
 * 谁在哪个组织里、以什么组织身份。
 *
 * ★★ 这张表取代了原来的 `users.org_id` + `users.org_role`。
 *
 *   那两列把「账号」和「归属」焊死成一对一：一个人要参与第二个组织，
 *   只能再注册一个账号。而组织之间的边界正是多租户隔离的边界，
 *   所以「同一个人的两个账号」在审计里是两个不同的人 ——
 *   跨组织协作的顾问、外包、平台方全都描述不出来。
 *
 * ★ 组织角色跟着归属走，不跟着账号走：同一个人可以是 A 组织的管理员、
 *   B 组织的普通成员。放在 users 上的话这句话就说不出来。
 */
export const organizationMembers = pgTable(
  'organization_members',
  {
    orgId: uuid().notNull().references(() => organizations.id),
    userId: uuid().notNull().references(() => users.id),
    orgRole: text().notNull().default('member'),
    addedAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.userId] }),
    /** 「我属于哪些组织」是每个请求都要问的（切换器、当前组织解析），主键前缀对不上 */
    index('organization_members_user_idx').on(t.userId),
    check('organization_members_role_check', sql`${t.orgRole} in (${sqlList(OrgRole.options)})`),
  ],
);

/**
 * 角色 —— 一组权限的名字（docs/tech/09-security.md §2.2）。
 *
 * ★★ 角色是数据不是枚举。内置的五个覆盖「项目怎么运转」，
 *   覆盖不了「这个组织怎么分工」—— 研发、运营、测试、安全、数据，
 *   每家的切法都不一样。写死枚举的结果是所有人都被塞进 member，
 *   然后整套权限矩阵退化成「成员 vs 管理员」两档。
 *
 * ★ `applies_to` 决定这个角色能由人担任还是由 Agent 担任，或者两者。
 *   这是 Human–Agent 混合团队的基本形状：「测试」可能是一个人，
 *   也可能是一个跑测试的 Agent。角色与担任者分开，混合团队才描述得出来。
 */
export const roles = pgTable(
  'roles',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull().references(() => organizations.id),
    /** 稳定标识。Policy 的 `{kind:'project_role', role}` 引用的就是它 */
    key: text().notNull(),
    name: text().notNull(),
    description: text().notNull().default(''),
    /** 权限目录里的 key。校验在 @apos/domain 的 validateRoleDefinition */
    permissions: text().array().notNull().default(sql`'{}'`),
    /** 'human' / 'agent'，可以都有 */
    appliesTo: text().array().notNull().default(sql`'{human}'`),
    /** 内置角色不可改权限、不可删 —— 它们就是权限矩阵本身 */
    builtin: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().default(now),
    updatedAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [
    /** 成员表按 (org_id, role) 外键引用过来，所以这组必须唯一 */
    unique('roles_org_key_unique').on(t.orgId, t.key),
  ],
);

/**
 * 账号 —— **全局**的，不属于任何组织。
 *
 * ★ 归属与组织角色在 `organization_members`。这里只剩「这个人是谁」。
 *   email 因此是全局唯一：同一个人在两个组织里必须是同一个账号，
 *   否则审计里就成了两个人。
 */
export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    email: text().notNull(),
    name: text().notNull(),
    /**
     * scrypt 口令散列（`scrypt$N$r$p$salt$hash`），见 modules/auth/password.ts。
     *
     * ★★ 可空，而且空的含义是**这个账号登不进来**，不是「口令为空」。
     *   登录路径对 null 与「口令错」返回同一句话、走同一条耗时路径 ——
     *   区分开来的话，这一列就成了「哪些邮箱是真账号」的探针。
     *
     * ★ 之所以不设成 notNull：账号可以先由超管建出来占位（还没发口令），
     *   而 notNull 会逼出一个哨兵值，那个哨兵值迟早会被当成真口令校验。
     */
    passwordHash: text(),
    avatarUrl: text(),
    skills: text().array().notNull().default(sql`'{}'`),
    /** 可审批事项，支撑产品文档 8.7.5 的决策责任自动识别 */
    approvalScopes: text().array().notNull().default(sql`'{}'`),
    notificationPrefs: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    status: text().notNull().default('active'),
    createdAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [unique('users_email_unique').on(t.email)],
);

// ── Project ──────────────────────────────────────────────────────────────

export const projects = pgTable(
  'projects',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull().references(() => organizations.id),
    name: text().notNull(),
    goal: text(),
    /**
     * 工作项编号的前缀（`ORD` → `ORD-19`）。组织内唯一。
     *
     * ★★ 有了它，工作项才有一个**能用嘴说出来**的名字。
     *   在此之前只有 uuid：站会上没法念，聊天里没法提，
     *   提交信息里写进去也没人认得。
     */
    identifier: text().notNull().default('TASK'),
    /**
     * 每项目的工作项序号游标。
     *
     * ★ 用列 + 原子自增，不用 Postgres sequence：每个项目一条 sequence
     *   意味着建项目要 DDL，而 DDL 不能和业务事务放在一起回滚。
     *   `UPDATE … SET seq = seq + n RETURNING seq` 同样是原子的，
     *   而且并发下不会跳号。
     */
    workItemSeq: integer().notNull().default(0),
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
    /**
     * 人力小时成本基准（成本效益换算用）。
     *
     * ★ 可为空，而且默认就是空。系统不替用户猜一个时薪 ——
     *   编出来的「本月为你省了多少」经不起一次追问，
     *   一旦被问倒，整个 Analytics 就都没人信了。
     */
    laborHourlyCost: numeric({ precision: 10, scale: 2 }),

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
    /**
     * ★ 从 projects 冗余下来，为的是能对 roles 建外键 ——
     *   角色是组织级的，没有 org_id 就只能靠应用层保证
     *   「不会引用到别的组织的角色」，而那正是最容易漏的一类检查。
     */
    orgId: uuid().notNull().references(() => organizations.id),
    /** Agent 与人类走同一张表 —— 权限判定上「是否属于本项目」是同一个问题 */
    actorType: actorTypeEnum().notNull(),
    actorId: uuid().notNull(),
    /** 角色 key，指向本组织的 roles */
    role: text().notNull(),
    addedAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.actorType, t.actorId] }),
    /**
     * ★ 「这个人是哪些项目的成员」是每个请求都要问的问题（授权闸门、
     *   决策收件箱、项目列表），而主键是 (project_id, …)，前缀对不上，
     *   这类查询只能全表扫。加了权限判定之后它从偶发变成了每请求一次。
     */
    index('project_members_actor_idx').on(t.actorType, t.actorId),
    /**
     * ★★ 外键取代了原来的 CHECK 枚举。
     *
     *   角色可自定义之后，「合法角色」这份清单是行不是常量，CHECK 表达不了。
     *   外键给的保证比 CHECK 更强：不但写不进不存在的角色，
     *   还删不掉正在被人担任的角色 —— 后者是 CHECK 从来给不了的，
     *   而「角色被删了，成员的权限静默归零」正是最难查的那种故障。
     *
     *   Agent 行同样受约束：Agent 现在也担任真正的角色（§2.2），
     *   不再是一列自由文本。
     */
    foreignKey({
      columns: [t.orgId, t.role],
      foreignColumns: [roles.orgId, roles.key],
      name: 'project_members_role_fk',
    }),
  ],
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

    /**
     * 上一次结构化是谁做的（`claude-code:sonnet`、`stub（规则占位，未走 Agent：…）`）。
     *
     * ★★ 这一列存在的唯一理由是**不许假装**。
     *
     *   界面上写着「🤖 AI 结构化结果」，而底下可能跑的是规则占位
     *   （没配规划 Agent、凭证缺失、Agent 超时都会回退）。不把真相摆出来，
     *   用户拿回自己的原话换了三个标签，只会觉得「这 AI 真差」——
     *   没有任何线索指向「根本没接模型」。
     *
     *   计划那边早有 plans.model 承担同样的职责，需求这边一直缺。
     */
    analysisModel: text(),

    /**
     * 这条需求的 PRD 由哪个 Agent 编写（null = 按项目绑定的规划 Agent 挑）。
     *
     * ★★ 记在**需求**上而不是只作为一次分析的参数：用户选完之后离开页面、
     *   或者过两天回来点「重新分析」，那个选择还得在 —— 否则「选了 Agent
     *   由它来写」就只是「这一次碰巧用了它」，下一次又悄悄换回项目绑定的
     *   那个，而界面上没有任何迹象。
     *
     *   Which agent authors this requirement's PRD (null = fall back to the
     *   project's planner binding). Stored on the requirement, not passed per
     *   call: the choice has to survive a page reload and a later re-analysis,
     *   otherwise it silently reverts to the project binding.
     *
     * ★ 不设外键级联删除：Agent 被删掉时这一列留着悬空比静默清空好 ——
     *   分析时会明说「指定的 Agent 不存在」，而不是若无其事地换一个来写。
     */
    authorAgentId: uuid().references(() => agents.id),

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

    /**
     * 项目内的顺序编号。配合 `projects.identifier` 拼成 `ORD-19`。
     *
     * ★ 只存数字，不冗余整个 `ORD-19`：改了项目前缀之后，
     *   冗余的那份要批量刷一遍，而漏刷的表现是同一个项目里
     *   两种前缀并存 —— 那比多一次 join 贵得多。
     *
     * ★ 可为空：迁移之前的存量数据会在迁移里补号，
     *   但这一列的 NOT NULL 得等所有写入路径都分配了编号之后再收紧。
     */
    number: integer(),

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
    /** 「ORD-19 是哪一条」要能直接查到，而不是全表扫 */
    unique('work_items_project_number_unique').on(t.projectId, t.number),
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

/**
 * 代码仓库登记 —— `ResourceScope { kind: 'repo', ref }` 的 ref 指向这里的 `ref`。
 *
 * ★ 在此之前 ref 只是个没人解析的字符串，所有 Agent 共用一个
 *   AGENT_WORKSPACE_ROOT，两个 Run 并发就在同一份工作树上互相覆盖。
 *   有了这张表，工作区供给才知道该 clone 谁、用哪把钥匙、推到哪个分支。
 */
export const repositories = pgTable(
  'repositories',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull().references(() => organizations.id),
    /** 项目级仓库；为空表示组织级共享（如 shared-lib） */
    projectId: uuid().references(() => projects.id),

    /** ResourceScope.ref 用的稳定标识，如 `order-service` */
    ref: text().notNull(),
    name: text().notNull(),
    /** git remote，https 或 ssh */
    remoteUrl: text().notNull(),
    defaultBranch: text().notNull().default('main'),

    /** ★ 同样只存引用。克隆用的凭证不进业务库 */
    credentialRef: text(),
    credentialHint: text(),

    /**
     * HTTPS token 走 Basic 认证时的用户名占位（GitHub `x-access-token` /
     * GitLab `oauth2` / Bitbucket `x-token-auth`）。
     *
     * ★ 为空表示按 remoteUrl 的域名推断（见 workspace/git.ts 的
     *   resolveAuthUsername）。留这一列而不是纯靠推断，是因为自建 GitLab
     *   装在 git.acme.com 上推断不出来 —— 而推断错的表现是 401，
     *   错误信息里没有任何东西指向「用户名占位不对」。
     */
    authUsername: text(),

    /**
     * SSH 主机公钥（known_hosts 格式）。
     *
     * ★★ 这不是秘密 —— 它本来就是要公开比对的那一份，
     *   存明文是对的。
     *
     * ★ 为空表示还没固定：首次连接走 TOFU（accept-new），连上之后
     *   立刻把学到的公钥写进来，此后转严格校验。不固定的话
     *   `accept-new` 等于 `no` —— 每次都是全新的临时 known_hosts，
     *   「未知主机」这个条件永远成立，中间人换掉主机公钥也照连不误。
     *
     * ★ 管理员可以预先填好（比 TOFU 强），或清空以重新学习
     *   （服务器真的换了密钥时）。
     */
    sshKnownHosts: text(),

    /** Agent 分支命名模板，{runId} / {itemId} / {slug} 会被替换 */
    branchPrefix: text().notNull().default('apos/'),

    /**
     * 质量核验命令，如 `pnpm test`。在 Agent 收工后、提交之前于工作区执行。
     *
     * ★ 这是 reviewing 阶段唯一的**真实**测试数据源。没有它，
     *   `qualityGatePassed` 这道门禁只能靠「Agent 说它跑过测试了」——
     *   而那是一句自述，不是证据。
     */
    checkCommand: text(),
    checkTimeoutSeconds: integer().notNull().default(900),

    /**
     * 产出交货到哪个存储目标。为空 = 按主挂载的种类推断（git 就推分支）。
     *
     * ★★ 这一列兑现的是抽象里「两头独立可选」那半边：铺料与交货本来就
     *   不该 1:1 绑定，而在它出现之前，交货后端**只能**由主挂载的种类决定
     *   （见 modules/workspace 的 publisherFor）。于是「从 Git 拉代码、
     *   把生成的报告传对象存储」这种最常见的组合表达不了 ——
     *   而那正是 docs/tech/11 §2 用来说明这个设计的例子。
     *
     * ★ 指向 storage_targets 而不是自由填一个 URL：交货要用凭证，
     *   而凭证只以引用入库、只在登记表里。填 URL 就得在这一行再存一份凭证。
     */
    deliveryTargetId: uuid(),

    status: text().notNull().default('active'),
    createdBy: uuid().notNull().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().default(now),
    updatedAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [uniqueIndex('repositories_org_ref_idx').on(t.orgId, t.ref)],
);

/**
 * 非 Git 的工作区来源 —— 对象存储 bucket 与宿主机目录。
 *
 * ★★ 为什么不塞进 repositories。
 *
 *   那张表的每一列都是 git 概念：remoteUrl、defaultBranch、branchPrefix、
 *   sshKnownHosts。一个 S3 bucket 塞进去要给这些列填占位符，而占位符会
 *   一路流到界面上（「默认分支：main」）和 prompt 里 —— 这正是规划任务
 *   曾经用 branch:'planning' 假装自己是 git 仓库时踩过的坑。
 *
 * ★ ResourceScope 里用 `kind: 'dataset'` 引用它，与仓库的 `kind: 'repo'`
 *   分开。「授权了什么」在权限快照里因此是自解释的。
 */
export const storageTargets = pgTable(
  'storage_targets',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull().references(() => organizations.id),
    /** 项目级；为空表示组织级共享 */
    projectId: uuid().references(() => projects.id),

    /** ResourceScope.ref 用的稳定标识 */
    ref: text().notNull(),
    name: text().notNull(),
    /** 'object_storage' | 'local' */
    kind: text().notNull(),

    // ── object_storage ────────────────────────────────────────────────
    endpoint: text(),
    region: text().notNull().default('us-east-1'),
    bucket: text(),
    /** 只挂这个前缀下的对象；空串表示整个 bucket */
    prefix: text().notNull().default(''),
    /**
     * path-style（`host/bucket/key`）还是 virtual-host-style。
     *
     * ★ 默认 true：MinIO、Ceph、自建网关基本只支持 path-style，
     *   而 AWS 两种都支持。反过来默认的话，自建端点的表现是 DNS 解析失败 ——
     *   完全不指向「寻址风格」这件事。
     */
    forcePathStyle: boolean().notNull().default(true),

    // ── local ─────────────────────────────────────────────────────────
    /**
     * 宿主机上的绝对路径。
     *
     * ★ 能不能真的挂还要过部署方的白名单（APOS_LOCAL_MOUNT_ROOTS）——
     *   登记是管理员在界面上做的事，而一条填成 `/` 的登记等于把整台机器
     *   交给 Agent。库里存意图，环境里存闸门。
     */
    rootPath: text(),

    // ── 公共 ──────────────────────────────────────────────────────────
    /** 对象存储是 `accessKeyId:secretAccessKey`。★ 同样只存引用，不存明文 */
    credentialRef: text(),
    credentialHint: text(),

    /** 只读挂载时为 false —— 交货阶段据此拒绝写回 */
    writable: boolean().notNull().default(false),

    /**
     * 产出交货到哪个存储目标。为空 = 写回自己（sync 语义）。
     *
     * ★ 与 repositories 上那一列同义。指向别处时语义变成**投递**
     *   （deliver）：只上传变更集里新增/修改的文件，落在 `{前缀}{runId}/` 下，
     *   **不删除**目标里的任何东西 —— 那些 key 跟本次变更集毫无关系。
     */
    deliveryTargetId: uuid(),

    status: text().notNull().default('active'),
    createdBy: uuid().notNull().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().default(now),
    updatedAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [
    uniqueIndex('storage_targets_org_ref_idx').on(t.orgId, t.ref),
    check('storage_targets_kind_check', sql`${t.kind} in ('object_storage', 'local')`),
    /**
     * ★ 两类各自的必填列在库里就卡住。少一个 bucket 的对象存储登记，
     *   现象是派发时报「挂载失败」，而管理员看着那条登记觉得一切正常。
     */
    check(
      'storage_targets_shape_check',
      sql`(${t.kind} = 'object_storage' and ${t.endpoint} is not null and ${t.bucket} is not null)
          or (${t.kind} = 'local' and ${t.rootPath} is not null)`,
    ),
  ],
);

/**
 * 项目工程约定 —— prompt 三层里的第三层（[08](docs/product/pages/08-agent-workspace.md) 之外的补充）。
 *
 * ★ 刻意不做成「Agent 的 system prompt 文本框」：编码规范是**项目**属性，
 *   对该项目里所有 Agent 一视同仁。挂在 Agent 上意味着换个 Agent 就得重填一遍，
 *   而且会诱导用户往里写治理规则，把 Policy 架空。
 */
export const projectConventions = pgTable(
  'project_conventions',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull().references(() => organizations.id),
    projectId: uuid().notNull().references(() => projects.id),

    title: text().notNull(),
    content: text().notNull(),
    /** 限定适用的任务类型；空数组 = 全部适用 */
    appliesTo: workItemTypeEnum().array().notNull().default(sql`'{}'`),
    /** must_read 会进「必读上下文」，reference 进「参考上下文」 */
    priority: text().notNull().default('must_read'),

    enabled: boolean().notNull().default(true),
    position: integer().notNull().default(0),

    createdBy: uuid().notNull().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().default(now),
    updatedAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [index('project_conventions_project_idx').on(t.projectId, t.enabled)],
);

export const agents = pgTable(
  'agents',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull().references(() => organizations.id),
    name: text().notNull(),
    type: text().notNull(),
    description: text(),

    /**
     * ★ 运行时配置内联在 Agent 上，没有单独的「接入」层。
     *
     *   一个 Agent 就是「一种 headless CLI + 一套它的个性化参数 + 一份凭证」，
     *   建 N 个 Agent 就是 N 套独立配置 —— 这是刻意的产品选择：
     *   Agent 是一等对象，运行时是它的一个属性，而不是反过来。
     *
     *   代价是同一把 key 会被多个 Agent 各存一份引用。缓解办法是用
     *   `env:变量名` 形态：N 个 Agent 引用同一个变量名，轮换仍只改一处。
     */
    runtimeKind: text().notNull(),
    /** 该 CLI 的个性化参数，形状由 RUNTIME_KIND_SPECS 定义并校验 */
    runtimeConfig: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** 自建网关地址；官方端点留空 */
    endpoint: text(),
    /** ★ 只存引用。明文凭证不进业务库 */
    credentialRef: text(),
    /** 页面上显示的 ****1234，登记时截取，之后再也拿不到原值 */
    credentialHint: text(),
    /** 能力探测结果缓存 */
    capabilities: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    lastCheckAt: timestamp({ withTimezone: true }),

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

/**
 * 项目 Agent 绑定 —— 「这个项目的规划 / 协调 / 评审交给哪个 Agent」。
 *
 * ★★ 这张表补的是「Project Agent 到底是谁」这个一直没有答案的问题。
 *
 *   在它出现之前，规划 Agent 是**现算出来的**：从组织里找第一个
 *   `status='active'` 且 applicableTypes 含 requirement 的 Agent
 *   （见 modules/planning/agent-provider.ts 的 pickAgent）。三个后果：
 *   用户指定不了；换一个 Agent 的唯一办法是改另一个 Agent 的配置或
 *   建号顺序；而且它压根不看项目成员关系 —— 组织里任何一个 Agent
 *   都可能被拉来读这个项目的需求。
 *
 * ★ 绑的是**已配置好的 Agent**，不是运行时。选 Claude Code 还是 Codex
 *   是 AgentDefinition 那一层的事，到这一层只剩「哪个 Agent 干这个角色」。
 *   这条分层是这次拆分的要点：配置身份与分派角色不该在同一个下拉框里。
 *
 * ★ (project_id, role) 唯一：一个角色同一时刻只有一个主 Agent。
 *   fallback / 多 Agent 优先级是后话（P2），先把「是谁」定下来。
 */
export const projectAgentBindings = pgTable(
  'project_agent_bindings',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull().references(() => organizations.id),
    projectId: uuid().notNull().references(() => projects.id),
    /** planner / coordinator / reviewer */
    role: text().notNull(),
    agentId: uuid().notNull().references(() => agents.id),
    /**
     * 同一角色内的优先级，0 是主 Agent，往后是备选。
     *
     * ★★ 只有主 Agent 时，绑定的 Agent 一停用，整个项目的规划就断了 ——
     *   而唯一的补救是管理员去改绑定。备选让它能自己往下退一格。
     *
     * ★ 显式一列而不是靠 created_at 排：靠时间排的话，「换一下优先级」
     *   要靠删了重建，而那会丢掉 createdBy 与 createdAt 这两条问责线索。
     */
    priority: integer().notNull().default(0),
    createdBy: uuid().notNull().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().default(now),
    updatedAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [
    /**
     * ★ 唯一性从 (project, role) 放宽到 (project, role, priority)：
     *   一个角色可以有主 + 备选，但同一优先级只能有一个 ——
     *   否则「谁是主」在两条 priority=0 的记录之间无从判定。
     */
    uniqueIndex('project_agent_bindings_project_role_idx').on(t.projectId, t.role, t.priority),
    /** ★ 同一个 Agent 不该在同一角色里占两格 */
    uniqueIndex('project_agent_bindings_project_role_agent_idx').on(
      t.projectId,
      t.role,
      t.agentId,
    ),
    index('project_agent_bindings_agent_idx').on(t.agentId),
    check(
      'project_agent_bindings_role_check',
      sql`${t.role} in ('planner', 'coordinator', 'reviewer')`,
    ),
  ],
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
    /**
     * ★★ 可空，因为规划 Run 发生在工作项**存在之前**。
     *
     *   在此之前这一列是 NOT NULL，于是规划（需求结构化、生成计划）根本
     *   进不了这张表 —— AgentPlanningProvider 只好自己开工作区、自己收事件、
     *   自己管超时，代价写在那个类的文档里：不出现在 Run 详情页与 Agent 视图、
     *   supervisor / recovery 管不着、成本不进统计。
     *   也就是说，产品里最贵、最影响后续所有产出的那次 Agent 调用，
     *   是唯一一次没有留痕的调用。
     *
     *   放开它不影响既有查询：那 8 处消费点全是
     *   `where work_item_id = <某个真实 id>`，NULL 行永远不匹配 ——
     *   规划 Run 因此不会串进看板、执行图与工作项的 Run 列表里。
     */
    workItemId: uuid().references(() => workItems.id),
    agentId: uuid().notNull().references(() => agents.id),
    /**
     * 这次 Run 是干什么的。
     *
     * ★ 显式一列，而不是靠「workItemId 为空就是规划」去推。
     *   推断出来的分类在查询里读不出意图，加第三种用途（比如评审）时
     *   还要再发明一条隐含规则。
     */
    kind: text().notNull().default('execution'),
    /**
     * 规划 Run 是给哪条需求做的。
     *
     * ★★ 没有它，规划 Run 就是一批查得到却**找不回来**的记录：
     *   agent_runs 里躺着一条 kind='planning'，而需求页上没有任何入口
     *   指向它 —— 用户想看「刚才那次分析到底做了什么」无从下手。
     *
     * ★ 执行 Run 不用它（它们靠 work_item_id 找回去）；只在 kind='planning'
     *   时有值。不加 check 约束是因为历史规划 Run（这一列出现之前的）
     *   本来就没有，卡死会让它们变成不合法的行。
     */
    requirementId: uuid().references(() => requirements.id),
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

    /**
     * 本次 Run 的工作区：仓库、分支、基线 commit、本地路径。
     *
     * ★ 落库而不是只留在进程内存里 —— 进程重启后要能回答
     *   「这个孤儿 Run 在哪个分支上留了什么」，否则改动只能靠人翻磁盘。
     */
    workspace: jsonb().$type<{
      repoRef: string;
      repoId: string;
      branch: string;
      baseBranch: string;
      baseCommit: string | null;
      path: string;
      /**
       * 本次 Run 的**全部**挂载点，收尾时逐个回收。
       *
       * ★ 在此之前只落了主工作树的 path，参考仓库的工作树因此只能被
       *   `rm -rf` 掉 —— 镜像里的 worktree 登记会残留到下一次
       *   `worktree prune`，而如果这个仓库再没有新 Run，就永远残留。
       *
       * ★ 迁移 0020 已经把老行回填出 mounts。仍留可选，是因为滚动发布
       *   期间可能还有老进程在写老结构的行 —— 那不是「正确性依赖」，
       *   是发布窗口的保险。
       */
      mounts?: Array<{
        path: string;
        role: 'primary' | 'reference';
        writable?: boolean;
        /** 挂载点的来源描述；旧结构没有，按 git 解释 */
        source?: {
          kind: 'git' | 'empty' | 'local' | 'object_storage';
          identifier: string;
          label: string;
          baseVersion: string | null;
        };
        /**
         * repositories.id 或 storage_targets.id。
         *
         * ★ 交货时要拿它回查 remoteUrl / endpoint 与凭证引用。存 id 而不是
         *   把整份描述连同凭证引用抄进来 —— 那等于把凭证引用复制一份到
         *   agent_runs 表，而那张表的读取面比 repositories 宽得多。
         */
        targetId?: string;
        /** @deprecated 旧结构里的仓库 id，等价于 targetId */
        repoId?: string;
      }>;
      /** 结束时回填 */
      headCommit?: string | null;
      pushed?: boolean;
      changedFiles?: number;
    } | null>(),

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

    /**
     * 恢复决策的落点。
     *
     * ★ 判定（decideRecovery）与执行（recovery-worker）分开，中间靠这三个字段。
     *   放在库里而不是内存队列，是因为「已经决定重试但还没重试」这个状态
     *   必须扛得住进程重启 —— 丢掉它的表现是任务永远停在 failed，
     *   而事件流里明明写着「将自动重试」。
     */
    recoveryAction: text(),
    recoveryReason: text(),
    /** 退避到点之前不执行，来自 agents.retryPolicy.backoff_seconds */
    recoveryNotBefore: timestamp({ withTimezone: true }),
    recoveryAppliedAt: timestamp({ withTimezone: true }),
    /** switch_agent 用；判定时就算好，执行时不必再算一遍 */
    recoveryAgentId: uuid(),

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
    /** 规划 Run 列表按项目查（需求页的「历次分析」） */
    index('agent_runs_kind_idx').on(t.kind, t.projectId, t.createdAt),
    /** 需求页的「历次分析」按这个查 */
    index('agent_runs_requirement_idx').on(t.requirementId, t.createdAt),
    check('agent_runs_kind_check', sql`${t.kind} in ('execution', 'planning')`),
    /**
     * ★★ 执行 Run 必须有工作项，规划 Run 必须没有。
     *
     *   放开 NOT NULL 之后，「执行 Run 的 work_item_id 为空」会静默地
     *   变成一种可能 —— 而那种行不会出现在任何按工作项查的界面上，
     *   等于凭空消失。库里卡住比事后查为什么少了一条便宜得多。
     */
    check(
      'agent_runs_shape_check',
      sql`(${t.kind} = 'execution' and ${t.workItemId} is not null)
          or (${t.kind} = 'planning' and ${t.workItemId} is null)`,
    ),
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
    scopes: jsonb()
      .$type<{ allowed: string[]; denied: string[]; probed?: boolean }>()
      .notNull()
      .default({ allowed: [], denied: [], probed: true }),

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

/**
 * 通知投递记录。
 *
 * ★ 「发过没有」必须查得到。通知这类功能最典型的故障是**静默失败**：
 *   webhook 被撤销、群被解散、限流被丢弃 —— 而用户只会觉得
 *   「这系统从来不提醒我」，根本不会想到去查投递。
 *   所以成功和失败都落一条，被抑制的（免打扰 / 用户关了这类）也落一条。
 */
export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    projectId: uuid().notNull().references(() => projects.id),
    integrationId: uuid().references(() => integrations.id, { onDelete: 'set null' }),

    eventKey: text().notNull(),
    subjectType: text().notNull(),
    subjectId: uuid(),

    /** delivered / failed / suppressed */
    status: text().notNull(),
    /** 被抑制的原因：event_disabled / quiet_hours */
    suppressedReason: text(),
    /** 失败原因，直接展示给用户 */
    error: text(),
    /** 需要用户重新配置（webhook 撤销 / 群解散），重试没用 */
    needsReconfigure: boolean().notNull().default(false),

    title: text(),
    latencyMs: integer(),
    createdAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [index('notification_deliveries_project_idx').on(t.projectId, t.createdAt)],
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

/**
 * 幂等键（docs/tech/07-api-design.md §4）。
 *
 * ★ 为什么需要它：决策批准、Run 派发这类操作要么花钱（重复派发 Agent），
 *   要么不可逆（重复批准生产发布）。网络超时后客户端重试是真实场景 ——
 *   而重试时它并不知道上一次到底成没成。
 *
 * ★ 没有它时的表现不是「重复执行」（那一层由状态机的 VERSION_CONFLICT 挡住了），
 *   而是：**操作其实成功了，客户端却收到 409**，于是界面告诉用户「批准失败」。
 *   用户再点一次，还是失败。这比真的失败更难排查。
 *
 * ★ 主键是 (key, endpoint)：同一个 key 用在不同端点上互不干扰，
 *   否则客户端复用一个请求 id 去调两个接口就会拿到对方的响应。
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text().notNull(),
    endpoint: text().notNull(),
    /** 首次响应的状态码与响应体，重放时原样返回 */
    statusCode: integer().notNull(),
    response: jsonb().$type<unknown>().notNull(),
    /** 谁发起的 —— 换个人拿同一个 key 重放不该拿到别人的结果 */
    actorId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.key, t.endpoint] }),
    /** 过期清理按时间扫 */
    index('idempotency_created_idx').on(t.createdAt),
  ],
);
