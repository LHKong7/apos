import {
  ACTING_PROJECT_ROLES,
  EXECUTING_PROJECT_ROLES,
  LEAD_PROJECT_ROLES,
  type OrgRole,
  type ProjectRole,
} from '@apos/contracts';

/**
 * 权限目录 —— docs/tech/09-security.md §2.2 的角色表与 §2.3 的权限矩阵，
 * 逐条落成可执行的判定。
 *
 * ★ 一份目录，前后端共用。界面上灰掉的按钮和服务端真正拦住的请求
 *   必须是同一条规则：两份实现的偏差要么是「能点但做不了」（用户体验差），
 *   要么是「做得了但点不到」（功能等于没有）。而这里管的是
 *   「谁能放宽 Policy」「谁能扩大 Agent 权限」这类事，
 *   两种偏差的代价都不是体验问题。
 *
 * ★ 目录是数据不是代码。新增一个受控操作 = 在这里加一行 + 在
 *   apps/api/src/http/rbac.ts 的路由表里登记；漏了登记服务起不来
 *   （见那个文件的 assertRoutesCovered）。这是刻意的：
 *   这类漏洞的成因永远是「漏了一处」。
 */

/** 受控操作。命名一律 `资源.动作`，便于前端按前缀分组 */
export const PERMISSIONS = [
  // ── 项目 ──────────────────────────────────────────────────────────
  'project.view',
  'organization.update',
  'organization.delete',
  'organization.members.manage',
  'project.create',
  'project.settings.update',
  'project.autonomy.change',
  'project.schedule',
  'project.members.manage',

  // ── 需求 ──────────────────────────────────────────────────────────
  'requirement.create',
  'requirement.edit',
  'requirement.approve',
  'clarification.answer',

  // ── 计划 ──────────────────────────────────────────────────────────
  'plan.generate',
  'plan.approve',

  // ── 任务 ──────────────────────────────────────────────────────────
  'work_item.create',
  'work_item.execute',
  'work_item.takeover',
  'work_item.force_pass',

  // ── Run ───────────────────────────────────────────────────────────
  'run.control',
  'run.view_detailed',

  // ── 决策 ──────────────────────────────────────────────────────────
  'decision.act',
  'decision.remind',

  // ── Policy ────────────────────────────────────────────────────────
  'policy.view',
  'policy.tighten',
  'policy.loosen',

  // ── Agent ─────────────────────────────────────────────────────────
  'agent.view',
  'agent.create',
  'agent.update',
  'agent.delete',
  'agent.pause',
  'agent.permissions.expand',
  'agent.permissions.restrict',

  // ── 组织配置 ──────────────────────────────────────────────────────
  'repository.manage',
  'convention.manage',
  'org.members.manage',
  'org.roles.manage',
  'audit.export',

  // ── 集成（页面文档 14 §8）──────────────────────────────────────────
  'integration.view',
  'integration.connect',
  'integration.grant_write',
  'integration.change_sot',
  'integration.disconnect',
  'integration.resolve_conflict',
  'integration.configure_notification',
  'integration.configure_data_connector',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** 额外治理要求。判定本身在 API 层，目录只负责声明「这条需要什么」 */
export interface PermissionGovernance {
  /** 放宽类操作必须携带模拟结果（§2.3） */
  simulation?: boolean;
  /** 必填原因 */
  reason?: boolean;
  /** 高风险项目需双签（§2.3 批准计划） */
  dualSign?: boolean;
  /** 强制记审计（§6.3） */
  audit?: boolean;
}

export interface PermissionSpec {
  /** 判定发生在哪一层：组织角色 / 项目角色 / 资源归属 */
  scope: 'org' | 'project' | 'resource';
  /** 人话操作名，用于拒绝文案与审计 */
  label: string;
  /** 满足其一即通过的项目角色 */
  projectRoles?: readonly ProjectRole[];
  /** 满足其一即通过的组织角色（org_admin 恒通过，不必列） */
  orgRoles?: readonly OrgRole[];
  /**
   * 资源所有者（`agent_owner` 这类资源级角色）是否可以做。
   * 见 §2.2：agent_owner 是跨项目的资源角色，不是项目角色。
   */
  resourceOwner?: boolean;
  /**
   * ★ 只有人类能做（§7.2）。
   *
   *   「如果 Agent 能改自己的约束，整个治理体系就是装饰。」
   *   这个标记不依赖「MVP 只有人类身份」这个当下事实 ——
   *   等 Agent 令牌接进来时，这些口子已经是关着的。
   */
  humanOnly?: boolean;
  governance?: PermissionGovernance;
  /** 拒绝时告诉用户「该找谁」。只说「无权限」等于让人卡死在这一页 */
  requires: string;
}

const ACTING = ACTING_PROJECT_ROLES;
/** 干活的那一档：比 ACTING 多一个只执行不决策的 executor（Agent 的默认角色）*/
const EXECUTING = EXECUTING_PROJECT_ROLES;
const LEADS = LEAD_PROJECT_ROLES;
const ALL_MEMBERS: readonly ProjectRole[] = [...EXECUTING, 'viewer'] as const;

export const PERMISSION_SPECS: Record<Permission, PermissionSpec> = {
  // ── 项目 ──────────────────────────────────────────────────────────
  'project.view': {
    scope: 'project',
    label: '查看项目',
    projectRoles: ALL_MEMBERS,
    requires: '需要是这个项目的成员',
  },
  'project.create': {
    scope: 'org',
    label: '创建项目',
    orgRoles: ['member'],
    requires: '需要组织成员身份',
  },
  'project.settings.update': {
    scope: 'project',
    label: '修改项目设置',
    projectRoles: LEADS,
    requires: '修改项目设置需要 pm 或 tech_lead',
  },
  /**
   * ★ 自治等级是「Agent 能自己走多远」的总开关，改动影响整个项目
   *   此后所有任务的判定结果。§2.3 要求二次确认 + 审计。
   */
  'project.autonomy.change': {
    scope: 'project',
    label: '修改自治等级',
    projectRoles: LEADS,
    governance: { audit: true },
    requires: '修改自治等级需要 pm 或 tech_lead —— 它决定 Agent 能自己走多远',
  },
  'project.schedule': {
    scope: 'project',
    label: '触发调度',
    projectRoles: ACTING,
    requires: '需要项目成员权限（只读角色不能触发调度）',
  },
  /**
   * ★ 改成员角色就是改权限，§4 把「修改权限」列为高风险操作、
   *   §6.3 要求强制记审计。给自己升一级是最典型的提权路径。
   */
  'project.members.manage': {
    scope: 'project',
    label: '管理项目成员',
    projectRoles: LEADS,
    humanOnly: true,
    governance: { audit: true },
    requires: '管理项目成员需要 pm 或 tech_lead',
  },

  // ── 需求 ──────────────────────────────────────────────────────────
  'requirement.create': {
    scope: 'project',
    label: '录入需求',
    projectRoles: ACTING,
    requires: '需要项目成员权限',
  },
  'requirement.edit': {
    scope: 'project',
    label: '编辑需求',
    projectRoles: ACTING,
    requires: '需要项目成员权限',
  },
  /**
   * §2.3：批准需求 = sponsor / pm。驳回同一道闸门 —— 驳回也是结论。
   *
   * ★★ humanOnly：这是产品的第一个 Human Gate。
   *   「让项目自主向前流动，同时确保人类始终掌握目标、风险与最终决策权」——
   *   如果一个 Agent 能确认需求，前半句还在，后半句就没了。
   *   这条不靠角色配置保证：自定义一个角色把它塞给 Agent 也不行。
   */
  'requirement.approve': {
    scope: 'project',
    label: '确认或驳回需求',
    projectRoles: ['sponsor', 'pm'],
    humanOnly: true,
    requires: '确认需求需要 sponsor 或 pm —— 需求是否成立是业务判断',
  },
  'clarification.answer': {
    scope: 'project',
    label: '回答澄清问题',
    projectRoles: ACTING,
    requires: '需要项目成员权限',
  },

  // ── 计划 ──────────────────────────────────────────────────────────
  'plan.generate': {
    scope: 'project',
    label: '生成或重新规划',
    projectRoles: ACTING,
    requires: '需要项目成员权限',
  },
  /**
   * §2.3：批准计划 = tech_lead；高风险项目需 + sponsor 双签。
   *
   * ★ humanOnly，同 requirement.approve：批准计划 = 批准一批自动化行为
   *   （页面文档 04 的核心）。让 Agent 批准「Agent 接下来自动做什么」，
   *   这个闸门就不是闸门了。
   */
  'plan.approve': {
    scope: 'project',
    label: '批准计划',
    projectRoles: ['tech_lead'],
    humanOnly: true,
    governance: { dualSign: true },
    requires: '批准计划需要 tech_lead',
  },

  // ── 任务 ──────────────────────────────────────────────────────────
  /** ★ 这一条给 EXECUTING：干活是 executor 存在的理由，也是 Agent 唯一要的 */
  /**
   * ★★ 建任务的门槛低，**放行去执行**的门槛不低。
   *
   *   手工建的任务不经过「需求 → 计划 → 批准」那条链，如果建完就能跑，
   *   任何能建任务的人都可以让 Agent 去做任意事情 —— 两道 Human Gate
   *   就都被绕开了。所以任务停在 draft，从 draft 走到 ready
   *   要的是 `plan.approve`（见 routes.ts 的 draft → ready 分支）：
   *   门禁没有消失，只是粒度从「一份计划」变成「一个任务」。
   */
  'work_item.create': {
    scope: 'project',
    label: '创建任务',
    projectRoles: EXECUTING,
    requires: '需要项目成员权限（只读角色不能建任务）',
  },
  'work_item.execute': {
    scope: 'project',
    label: '执行任务',
    projectRoles: EXECUTING,
    requires: '需要项目成员权限（只读角色不能改动任务）',
  },
  'work_item.takeover': {
    scope: 'project',
    label: '接管任务',
    projectRoles: ACTING,
    requires: '需要项目成员权限',
  },
  /**
   * ★ 强制放行是「绕过验收标准」，§2.3 要求 tech_lead + 必填原因 + 审计。
   *   这条和 work_item.execute 分开，是因为「能改任务」和
   *   「能让不达标的任务过去」根本不是一个量级的授权。
   */
  'work_item.force_pass': {
    scope: 'project',
    label: '强制放行',
    projectRoles: ['tech_lead'],
    governance: { reason: true, audit: true },
    requires: '强制放行验收标准需要 tech_lead —— 它绕过的是质量闸门',
  },

  // ── Run ───────────────────────────────────────────────────────────
  /** §2.3：终止 Agent Run = tech_lead / pm / agent_owner */
  'run.control': {
    scope: 'project',
    label: '控制 Agent Run',
    projectRoles: LEADS,
    resourceOwner: true,
    requires: '控制运行中的 Run 需要 pm、tech_lead，或是该 Agent 的 owner',
  },
  /** §2.3：查看 Run 详细模式 = tech_lead / agent_owner（可能含敏感上下文）*/
  'run.view_detailed': {
    scope: 'project',
    label: '查看 Run 详细模式',
    projectRoles: ['tech_lead'],
    resourceOwner: true,
    requires: '详细模式可能包含敏感上下文，需要 tech_lead 或该 Agent 的 owner',
  },

  // ── 决策 ──────────────────────────────────────────────────────────
  /**
   * ★ 这一条只判「有没有资格参与决策」。
   *   「是不是这条决策的责任人」是另一回事，且不可代行（§2.4）——
   *   org_admin 在这里通过，仍然批不动别人名下的决策。
   *
   * ★★ humanOnly：决策**就是**被升级给人的那些事。
   *   Agent 拿到这一条，等于让它批准自己升上来的东西 ——
   *   Human Gate 会变成一个自问自答的环。
   */
  'decision.act': {
    scope: 'project',
    label: '处理决策',
    projectRoles: ACTING,
    humanOnly: true,
    requires: '需要项目成员权限（只读角色不能处理决策）',
  },
  'decision.remind': {
    scope: 'project',
    label: '催办决策',
    projectRoles: ACTING,
    requires: '需要项目成员权限',
  },

  // ── Policy ────────────────────────────────────────────────────────
  'policy.view': {
    scope: 'project',
    label: '查看规则',
    projectRoles: ALL_MEMBERS,
    requires: '需要是这个项目的成员',
  },
  /**
   * ★★ 不对称设计（§2.3）：收紧比放宽的门槛低。
   *
   *   收紧总是安全的 —— 最坏结果是多问一次人。放宽是把治理拿掉，
   *   要更高的角色，还要额外证据。把两者放同一档，
   *   等于让「逐次小幅放宽」（§7 的权限累积威胁）畅通无阻。
   */
  'policy.tighten': {
    scope: 'project',
    label: '收紧规则',
    projectRoles: ['pm', 'tech_lead'],
    humanOnly: true,
    governance: { audit: true },
    requires: '收紧规则需要 pm 或 tech_lead',
  },
  'policy.loosen': {
    scope: 'project',
    label: '放宽规则',
    projectRoles: ['tech_lead'],
    humanOnly: true,
    governance: { simulation: true, audit: true },
    requires: '放宽规则需要 tech_lead，并且必须先看过模拟结果',
  },

  // ── Agent ─────────────────────────────────────────────────────────
  'agent.view': {
    scope: 'org',
    label: '查看 Agent',
    orgRoles: ['member'],
    requires: '需要组织成员身份',
  },
  'agent.create': {
    scope: 'org',
    label: '登记 Agent',
    requires: '登记 Agent 需要组织管理员 —— 它同时录入运行时凭证',
  },
  /**
   * 改档案（模型、并发、超时）：owner 自己、它所在项目的负责人，或组织管理员。
   *
   * ★ 必须把项目负责人算进来，否则 §2.3 的「扩大 Agent 权限需 tech_lead」
   *   永远走不到 —— 那条判定在这一关后面，而 tech_lead 通常不是 owner，
   *   会先被这里挡掉。一个矩阵里写了却永远触发不到的条目，
   *   比没写更糟：它让人以为这条路是通的。
   */
  'agent.update': {
    scope: 'resource',
    label: '修改 Agent 配置',
    projectRoles: LEADS,
    resourceOwner: true,
    requires: '修改 Agent 配置需要它的 owner、它所在项目的 pm / tech_lead，或组织管理员',
  },
  'agent.delete': {
    scope: 'org',
    label: '删除 Agent',
    governance: { audit: true },
    requires: '删除 Agent 需要组织管理员',
  },
  /**
   * §2.3：终止 Run 那一档；暂停 Agent 影响整个项目的流速，同级处理。
   *
   * ★ 作用域是 resource 不是 project：Agent 是组织级资源，它的 URL 上
   *   没有项目 id。标成 project 会让拒绝文案变成「你不是这个项目的成员」——
   *   而调用者可能是好几个项目的成员，这句话会把他引去查一个不存在的问题。
   */
  'agent.pause': {
    scope: 'resource',
    label: '暂停 Agent',
    projectRoles: LEADS,
    resourceOwner: true,
    governance: { reason: true },
    requires: '暂停 Agent 需要它所在项目的 pm / tech_lead，或是它的 owner',
  },
  /**
   * ★★ 扩大与收紧分开，理由同 policy.tighten / policy.loosen。
   *   §2.3 明确：扩大需 tech_lead + 审计 + 影响预演，收紧只需 agent_owner。
   */
  'agent.permissions.expand': {
    scope: 'resource',
    label: '扩大 Agent 权限',
    projectRoles: ['tech_lead'],
    humanOnly: true,
    governance: { audit: true, reason: true },
    requires:
      '扩大 Agent 权限需要它所在项目的 tech_lead —— 收紧它的 owner 就可以，扩大不行',
  },
  'agent.permissions.restrict': {
    scope: 'resource',
    label: '收紧 Agent 权限',
    resourceOwner: true,
    humanOnly: true,
    governance: { audit: true },
    requires: '收紧 Agent 权限需要它的 owner 或组织管理员',
  },

  // ── 组织本身 ──────────────────────────────────────────────────────
  /**
   * ★ 建组织**不在目录里**，因为它没有"在哪个组织里"这个前提 ——
   *   四层判定的第①层就是组织角色，而这一刻还没有组织。
   *   它的门槛只有"是不是一个已登录的账号"，判定在路由层（见 rbac.ts 的豁免）。
   */
  'organization.update': {
    scope: 'org',
    label: '修改组织信息',
    governance: { audit: true },
    requires: '改组织名与 slug 需要组织管理员 —— slug 出现在链接里，改了会让已发出去的链接失效',
  },
  'organization.delete': {
    scope: 'org',
    label: '删除组织',
    humanOnly: true,
    governance: { audit: true },
    requires: '删除组织需要组织管理员',
  },
  /**
   * ★★ 把人加进组织，是跨租户方向上唯一的入口。
   *
   *   它和 `org.members.manage`（改组织角色）拆开，是因为两者的后果不同：
   *   改角色只在组织内部移动权限，加人是把**边界外**的账号放进来。
   *   前者错了是内部越权，后者错了是数据出了租户。
   */
  'organization.members.manage': {
    scope: 'org',
    label: '管理组织成员归属',
    humanOnly: true,
    governance: { audit: true },
    requires: '把账号加进 / 移出组织需要组织管理员',
  },

  // ── 组织配置 ──────────────────────────────────────────────────────
  'repository.manage': {
    scope: 'org',
    label: '管理代码仓库登记',
    requires: '代码仓库登记需要组织管理员',
  },
  'convention.manage': {
    scope: 'project',
    label: '管理工程约定',
    projectRoles: LEADS,
    requires: '工程约定需要 pm 或 tech_lead',
  },
  'org.members.manage': {
    scope: 'org',
    label: '管理组织成员',
    humanOnly: true,
    governance: { audit: true },
    requires: '身份管理需要组织管理员',
  },
  /**
   * ★★ 定义角色 = 定义权限本身，是这套体系里权力最大的一条。
   *
   *   所以它必须留在 org 作用域：自定义角色只能授予项目内的权限
   *   （见 roles.ts 的 validateRoleDefinition），拿不到这一条 ——
   *   否则超管可以造一个「能创建角色的角色」发出去，
   *   拿到它的人再造一个更宽的，一步就走到组织管理员。
   */
  'org.roles.manage': {
    scope: 'org',
    label: '定义角色',
    humanOnly: true,
    governance: { audit: true },
    requires: '创建与修改角色需要组织管理员 —— 定义角色就是定义权限本身',
  },
  'audit.export': {
    scope: 'org',
    label: '导出审计日志',
    governance: { audit: true },
    requires: '导出审计日志需要组织管理员，导出行为本身也会记审计',
  },

  // ── 集成（页面文档 14 §8）──────────────────────────────────────────
  'integration.view': {
    scope: 'project',
    label: '查看集成',
    projectRoles: ACTING,
    requires: '需要项目成员权限',
  },
  'integration.connect': {
    scope: 'project',
    label: '连接集成',
    projectRoles: LEADS,
    requires: '需要 pm 或 tech_lead 权限',
  },
  /**
   * ★ 授予写权限单独一档，且只有 tech_lead 以上。
   *   「能连上」和「能让它改我的代码 / 改我的 Jira」是两个量级的授权。
   */
  'integration.grant_write': {
    scope: 'project',
    label: '授予集成写权限',
    projectRoles: ['tech_lead'],
    governance: { audit: true },
    requires:
      '授予写权限需要 tech_lead —— 让集成能改代码或改外部工单，是比「连上」高一个量级的授权',
  },
  'integration.change_sot': {
    scope: 'project',
    label: '修改 Source of Truth',
    projectRoles: LEADS,
    governance: { audit: true },
    requires: '修改 Source of Truth 需要 pm 或 tech_lead —— 它决定以后哪一边的修改会被丢掉',
  },
  'integration.disconnect': {
    scope: 'project',
    label: '断开集成',
    projectRoles: LEADS,
    governance: { audit: true },
    requires: '断开连接需要 pm 或 tech_lead',
  },
  /** 处理冲突是日常工作，不该卡权限 —— 卡住的结果是冲突没人清 */
  'integration.resolve_conflict': {
    scope: 'project',
    label: '处理同步冲突',
    projectRoles: ACTING,
    requires: '需要项目成员权限',
  },
  'integration.configure_notification': {
    scope: 'project',
    label: '配置群组通知',
    projectRoles: ['pm'],
    requires: '配置群组通知需要 pm；个人通知偏好在你自己的设置里',
  },
  /**
   * ★ 作用域是 org 而不是 project：这一条无论在哪个项目里都只有
   *   组织管理员做得了（产品文档 10.3 / 10.4）。标成 project 会让
   *   拒绝文案变成「你不是这个项目的成员」——把人引向去申请项目权限，
   *   而那条路无论走多远都到不了。
   */
  'integration.configure_data_connector': {
    scope: 'org',
    label: '配置数据连接器',
    requires: '数据连接器必须由组织管理员在组织级配置',
  },
};

/** 目录里声明了额外治理要求的操作 —— API 层据此加校验，前端据此加二次确认 */
export function governanceOf(permission: Permission): PermissionGovernance {
  return PERMISSION_SPECS[permission].governance ?? {};
}
