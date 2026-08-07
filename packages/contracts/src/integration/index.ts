import { z } from 'zod';

/**
 * 集成（页面文档 14 / 产品文档 九 集成能力、9.1 Source of Truth）。
 *
 * ★ 这一层的全部难点都在 9.1 那一句话上：
 *   「需要定义 Source of Truth，避免多个系统互相覆盖」。
 *   两个系统同时能改一个字段，就必然有一方的修改要被丢掉 ——
 *   把这件事说清楚（谁说了算、另一边怎么办、丢掉的怎么留痕），
 *   是集成能不能被信任的分水岭。做不到就只能是「同步过一阵子，
 *   然后大家都不敢看哪边的数据」。
 */

export const IntegrationCategory = z.enum([
  'code',
  'project_management',
  'communication',
  'data_system',
]);
export type IntegrationCategory = z.infer<typeof IntegrationCategory>;

/**
 * MVP 集成范围（产品文档 12.2）：GitHub、一个 Code Agent、
 * Slack 或飞书、Jira 或 Plane。Agent 运行时走 agent_runtimes，不在这里。
 */
export const IntegrationProvider = z.enum([
  'github',
  'jira',
  'plane',
  'slack',
  'feishu',
]);
export type IntegrationProvider = z.infer<typeof IntegrationProvider>;

export const PROVIDER_CATEGORY: Record<IntegrationProvider, IntegrationCategory> = {
  github: 'code',
  jira: 'project_management',
  plane: 'project_management',
  slack: 'communication',
  feishu: 'communication',
};

export const PROVIDER_LABELS: Record<IntegrationProvider, string> = {
  github: 'GitHub',
  jira: 'Jira',
  plane: 'Plane',
  slack: 'Slack',
  feishu: '飞书',
};

export const CATEGORY_LABELS: Record<IntegrationCategory, string> = {
  code: '代码与研发',
  project_management: '项目管理系统',
  communication: '协同与通知',
  data_system: '企业数据系统',
};

export const IntegrationStatus = z.enum([
  'active',
  /** token 过期 / 权限不足 / 服务不可达，见 §7 */
  'error',
  /** 外部服务不可用时自动暂停，恢复后补同步（§11）*/
  'paused',
]);
export type IntegrationStatus = z.infer<typeof IntegrationStatus>;

/**
 * 参与同步的字段（页面文档 14 §5.3 的那张表）。
 *
 * ★ 刻意是一个封闭枚举而不是任意字符串。
 *   SoT 配置是「关键配置」，能配的字段必须有限且每个都想清楚了
 *   默认归谁 —— 一个能配任意字段的界面，等于把想清楚的责任推给用户。
 */
export const SyncField = z.enum([
  'requirement_content',
  'status',
  'assignee',
  'due_date',
  'comments',
  'artifact_links',
]);
export type SyncField = z.infer<typeof SyncField>;

export const SYNC_FIELD_LABELS: Record<SyncField, string> = {
  requirement_content: '需求内容',
  status: '状态',
  assignee: '负责人',
  due_date: '截止时间',
  comments: '评论',
  artifact_links: '产物链接',
};

/** 谁说了算。merge 只对可合并的字段有意义（当前只有评论）。 */
export const SourceOfTruth = z.enum(['apos', 'external', 'merge']);
export type SourceOfTruth = z.infer<typeof SourceOfTruth>;

/** 非 SoT 端被改动时怎么办（页面文档 14 §5.3 的三种策略） */
export const ConflictStrategy = z.enum([
  /** 以 SoT 为准，把 SoT 的值写回另一端 */
  'writeback',
  /** 生成冲突条目，等人处理 */
  'record_conflict',
  /** 接受修改但通知负责人 */
  'accept_and_warn',
]);
export type ConflictStrategy = z.infer<typeof ConflictStrategy>;

export const STRATEGY_LABELS: Record<ConflictStrategy, string> = {
  writeback: '忽略并回写',
  record_conflict: '记录冲突待人工处理',
  accept_and_warn: '接受并告警',
};

export const SyncMapping = z.object({
  field: SyncField,
  sourceOfTruth: SourceOfTruth,
  strategy: ConflictStrategy,
});
export type SyncMapping = z.infer<typeof SyncMapping>;

/**
 * 字段级 SoT 的默认值与理由（页面文档 14 §5.3）。
 *
 * ★ 每一项都带 why，因为这一屏最需要解释的不是「能选什么」，
 *   而是「为什么默认是这个」。用户看不懂默认值的道理，
 *   就只会照抄或者乱改 —— 两种都通向同一个下场：
 *   哪边的数据都不敢信。
 */
export const FIELD_DEFAULTS: Record<
  SyncField,
  { sourceOfTruth: SourceOfTruth; options: SourceOfTruth[]; why: string }
> = {
  requirement_content: {
    sourceOfTruth: 'apos',
    options: ['apos', 'external'],
    why: 'AI 结构化的需求更完整',
  },
  status: {
    sourceOfTruth: 'apos',
    options: ['apos', 'external'],
    why: '状态由 Flow Engine 事件驱动，外部手改会打乱',
  },
  assignee: {
    sourceOfTruth: 'external',
    options: ['apos', 'external'],
    why: '人员分配通常在原系统管理',
  },
  due_date: {
    sourceOfTruth: 'external',
    options: ['apos', 'external'],
    why: '排期通常在原系统管理',
  },
  comments: {
    sourceOfTruth: 'merge',
    options: ['apos', 'external', 'merge'],
    why: '讨论应两边都看得到',
  },
  artifact_links: {
    sourceOfTruth: 'apos',
    options: ['apos'],
    why: 'APOS 是产物的产生方',
  },
};

/**
 * 三种预设（页面文档 14 §12.1「倾向于是」）。
 *
 * ★ 字段级配置对普通用户偏复杂，但把它藏起来只给预设同样不行 ——
 *   SoT 是会决定「谁的修改被丢掉」的配置，用户有权看到每个字段的归属。
 *   所以做法是：预设一键铺满，铺完之后每一格仍然摆在明面上可改。
 */
export const SOT_PRESETS = {
  apos_led: {
    label: 'APOS 主导',
    description: '除评论外全部以 APOS 为准。适合把 APOS 当作主工作台的团队',
    fields: {
      requirement_content: 'apos',
      status: 'apos',
      assignee: 'apos',
      due_date: 'apos',
      comments: 'merge',
      artifact_links: 'apos',
    },
  },
  external_led: {
    label: '外部系统主导',
    description: '除产物外全部以外部系统为准。适合 Jira 仍是全公司口径的团队',
    fields: {
      requirement_content: 'external',
      status: 'external',
      assignee: 'external',
      due_date: 'external',
      comments: 'merge',
      artifact_links: 'apos',
    },
  },
  split: {
    label: 'APOS 管执行，外部管计划',
    description: '需求、状态、产物归 APOS，人和排期归外部系统。默认就是这一档',
    fields: {
      requirement_content: 'apos',
      status: 'apos',
      assignee: 'external',
      due_date: 'external',
      comments: 'merge',
      artifact_links: 'apos',
    },
  },
} as const satisfies Record<
  string,
  { label: string; description: string; fields: Record<SyncField, SourceOfTruth> }
>;

export type SotPreset = keyof typeof SOT_PRESETS;

/**
 * 同步方向（页面文档 14 §12.2「倾向于 MVP 只做这两个方向的有限同步」）。
 *
 * ★ 完整双向同步的复杂度不在于「两个方向」，而在于两个方向同时开着时
 *   每一次写入都可能触发对面的写入。MVP 做单次拉取 + 单次回写，
 *   循环由 originTag 挡住（见 domain/integration/loop.ts）。
 */
export const SyncDirection = z.enum(['import', 'writeback']);
export type SyncDirection = z.infer<typeof SyncDirection>;

/**
 * 集成授予的权限。
 *
 * ★ allowed 与 denied 都要列（页面文档 14 §5.1）——
 *   与 08 Agent Workspace 完全同一条原则：用户需要确认的往往是
 *   「这个连接**不能**合并我的代码」，而一份只列允许项的清单
 *   回答不了这个问题。
 */
export const IntegrationScopes = z.object({
  allowed: z.array(z.string()),
  denied: z.array(z.string()),
});
export type IntegrationScopes = z.infer<typeof IntegrationScopes>;

/**
 * 默认不授予的权限（页面文档 14 §5.2「权限最小化」）。
 *
 * ★ 合并代码应当经过 Policy 判定，而不是让集成层直接放开。
 *   这条和 NEVER_AUTO_APPROVE 是同一类约束：不是「默认关掉、想开可以开」，
 *   而是集成层根本不提供这条路径 —— 提供了它就迟早会被打开。
 */
export const NEVER_GRANTED_SCOPES: Record<IntegrationProvider, readonly string[]> = {
  github: ['merge_pr', 'admin_repo', 'delete_repo', 'force_push'],
  jira: ['admin_project', 'delete_issue'],
  plane: ['admin_project', 'delete_issue'],
  slack: ['admin_workspace'],
  feishu: ['admin_tenant'],
};

/**
 * 通知事件（产品文档十一）。
 *
 * ★ 围绕「需要行动」设计，而不是发送大量 Agent 日志。
 *   noisy 标记的两项默认关闭：如果默认全开，用户会在两天内屏蔽这个机器人，
 *   之后连真正需要行动的通知也收不到了 —— 那时候损失的不是这两项，是全部。
 */
export const NOTIFY_EVENTS = [
  { key: 'decision_required', label: '需要决策', noisy: false },
  { key: 'decision_due_soon', label: '决策即将超时', noisy: false },
  { key: 'project_risk_up', label: '项目风险升高', noisy: false },
  { key: 'agent_repeated_failure', label: 'Agent 连续失败', noisy: false },
  { key: 'item_blocked_long', label: '任务长期阻塞', noisy: false },
  { key: 'cost_threshold', label: '成本即将超限', noisy: false },
  { key: 'milestone_done', label: '里程碑完成', noisy: false },
  { key: 'release_failed', label: '发布异常', noisy: false },
  { key: 'takeover_requested', label: '人工接管请求', noisy: false },
  { key: 'item_status_changed', label: '每个任务状态变化', noisy: true },
  { key: 'agent_run_finished', label: '每次 Agent 执行', noisy: true },
] as const;

export type NotifyEventKey = (typeof NOTIFY_EVENTS)[number]['key'];

export const NotificationConfig = z.object({
  /** 开启的事件。默认是全部 noisy=false 的项 */
  events: z.array(z.string()),
  /** 每日摘要发送时刻，HH:mm；null = 不发 */
  dailyDigestAt: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  /** 免打扰时段，HH:mm */
  quietHours: z.object({ from: z.string(), to: z.string() }).nullable(),
  /** ★ 高风险决策不受免打扰约束 —— 免打扰保护的是注意力，不是责任 */
  quietHoursExceptHighRisk: z.boolean(),
  /** 升级规则（产品文档十一）：等待 N 小时后找谁 */
  escalation: z.array(
    z.object({
      afterHours: z.number().int().positive(),
      notify: z.enum(['assignee', 'project_owner', 'manager']),
      pauseCriticalPath: z.boolean(),
    }),
  ),
});
export type NotificationConfig = z.infer<typeof NotificationConfig>;

export const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  events: NOTIFY_EVENTS.filter((e) => !e.noisy).map((e) => e.key),
  dailyDigestAt: '09:00',
  quietHours: { from: '22:00', to: '08:00' },
  quietHoursExceptHighRisk: true,
  escalation: [
    { afterHours: 4, notify: 'assignee', pauseCriticalPath: false },
    { afterHours: 8, notify: 'project_owner', pauseCriticalPath: false },
    { afterHours: 24, notify: 'manager', pauseCriticalPath: true },
  ],
};

export const ConflictStatus = z.enum(['pending', 'resolved', 'auto_resolved']);
export type ConflictStatus = z.infer<typeof ConflictStatus>;

export const ConflictWinner = z.enum(['apos', 'external']);
export type ConflictWinner = z.infer<typeof ConflictWinner>;

/**
 * 一侧的取值快照。冲突界面要摆出「值 / 时间 / 谁改的」三样 ——
 * 少了任何一样，用户就只能靠猜来决定听谁的。
 */
export const SideSnapshot = z.object({
  value: z.unknown(),
  changedAt: z.string(),
  changedBy: z.string(),
  actorType: z.string(),
});
export type SideSnapshot = z.infer<typeof SideSnapshot>;
