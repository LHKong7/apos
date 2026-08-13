import { z } from 'zod';

/**
 * 角色定义（docs/tech/09-security.md §2.2）。
 *
 * ★ 放在 contracts 而不是各处各写一份字符串：角色名同时出现在
 *   数据库列、Policy 的 `{ kind: 'project_role', role }` 通知目标、
 *   前端的按钮判定里。写成裸字符串的话，把 `tech_lead` 敲成 `techlead`
 *   不会有任何报错 —— 只是那条规则从此永远命中不到人，
 *   而「没人收到通知」这种故障要几周后才会被发现。
 *
 * Role definitions (docs/tech/09-security.md §2.2).
 *
 * ★ These live in contracts rather than as loose strings in each place,
 *   because a role name appears in a database column, in a policy's
 *   `{ kind: 'project_role', role }` notification target, and in the
 *   frontend's button gating. As bare strings, typing `techlead` for
 *   `tech_lead` raises no error anywhere — that rule simply never matches
 *   anyone again, and "nobody got notified" is a failure that surfaces
 *   weeks later.
 */

/**
 * 组织角色。
 *
 * ★ `admin` 是 `org_admin` 的历史别名（早期 seed 数据用的是它），
 *   两者等价。新代码一律用 `org_admin`，判定时用 {@link isOrgAdmin}
 *   而不是 `=== 'org_admin'` —— 直接比较会把老数据里的 admin 判成普通成员，
 *   表现为「管理员突然什么都做不了了」。
 *
 * Organisation roles.
 *
 * ★ `admin` is a historical alias of `org_admin` (early seed data used it) and
 *   the two are equivalent. New code writes `org_admin`, and checks go through
 *   {@link isOrgAdmin} rather than `=== 'org_admin'`: a direct comparison
 *   demotes older `admin` rows to ordinary members, which presents as "the
 *   administrator suddenly cannot do anything".
 */
export const OrgRole = z.enum(['org_admin', 'admin', 'member']);
export type OrgRole = z.infer<typeof OrgRole>;

/**
 * 内置项目角色。层级见 09-security §2.2 的角色表。
 *
 * ★★ 这不是角色的全集 —— 角色是数据，组织可以自定义（研发 / 运营 / 测试…），
 *   见 `roles` 表与 @apos/domain 的 `validateRoleDefinition`。
 *   这五…六个是**预置数据**，每个组织建立时得到一份拷贝，
 *   代码里之所以还留着枚举，是因为权限矩阵（§2.3）本身是按它们写的。
 *
 * ★ `executor` 是唯一一个专为 Agent 准备的内置角色：
 *   干活但不决策。其余几个都带 Human Gate 权限（确认需求、批准计划、
 *   处理决策），按 humanOnly 的规则一律不能给 Agent。
 *
 * Built-in project roles; the hierarchy is the role table in 09-security §2.2.
 *
 * ★★ This is not the complete set. Roles are data: an organisation defines its
 *   own (engineering, ops, QA…) — see the `roles` table and
 *   `validateRoleDefinition` in @apos/domain. These six are **seeded data**,
 *   copied into every new organisation. The enum survives in code only because
 *   the permission matrix (§2.3) is written in terms of them.
 *
 * ★ `executor` is the one built-in role meant for Agents: it does the work but
 *   makes no decisions. Every other role carries Human Gate permissions
 *   (approve a requirement, approve a plan, handle a decision), which the
 *   humanOnly rule keeps away from Agents entirely.
 */
export const ProjectRole = z.enum([
  'sponsor',
  'tech_lead',
  'pm',
  'member',
  'executor',
  'viewer',
]);
export type ProjectRole = z.infer<typeof ProjectRole>;

export function isOrgAdmin(role: OrgRole | string | null | undefined): boolean {
  return role === 'org_admin' || role === 'admin';
}

/**
 * ★ 前端不读这两张表 —— 它走 i18n 词条（`role.*`）。这里是给服务端拼句子用的。
 *   The frontend uses the i18n catalog (`role.*`) instead; these serve
 *   server-side sentence building.
 */
export const ORG_ROLE_LABEL: Record<OrgRole, string> = {
  org_admin: '组织管理员',
  admin: '组织管理员',
  member: '成员',
};

export const PROJECT_ROLE_LABEL: Record<ProjectRole, string> = {
  sponsor: '业务负责人',
  tech_lead: '技术负责人',
  pm: '项目经理',
  member: '成员',
  executor: '执行者',
  viewer: '只读',
};

/** 英文对照；类型同为 Record，新增角色时两边一起编译不过 */
/** English counterparts; the same Record types break both on a new role */
export const ORG_ROLE_LABEL_EN: Record<OrgRole, string> = {
  org_admin: 'Organisation administrator',
  admin: 'Organisation administrator',
  member: 'Member',
};

export const PROJECT_ROLE_LABEL_EN: Record<ProjectRole, string> = {
  sponsor: 'Sponsor',
  tech_lead: 'Tech lead',
  pm: 'Project manager',
  member: 'Member',
  executor: 'Executor',
  viewer: 'Viewer',
};

/**
 * 能参与项目日常决策的角色 —— 「录需求、答澄清、处理决策」这一档的门槛。
 *
 * ★ `viewer` 不在其中，这是 viewer 存在的全部意义：
 *   一个能写的只读角色等于没有只读角色。
 *
 * ★ `executor` 也不在其中，而且这才是它的意义：执行者干活但不决策。
 *   把它放进来，「谁能替 Agent 做决定」这个问题就没有答案了。
 *
 * Roles that take part in a project's day-to-day decisions — the bar for
 * "capture a requirement, answer a clarification, handle a decision".
 *
 * ★ `viewer` is absent, and that absence is the entire point of viewer: a
 *   read-only role that can write is not a read-only role.
 *
 * ★ `executor` is absent too, and that is *its* point: an executor works but
 *   does not decide. Include it and "who may decide on an Agent's behalf" no
 *   longer has an answer.
 */
export const ACTING_PROJECT_ROLES: readonly ProjectRole[] = [
  'sponsor',
  'tech_lead',
  'pm',
  'member',
] as const;

/**
 * 能实际推进任务的角色 —— 比 ACTING 多一个只干活的执行者。
 * Roles that can actually move work forward: ACTING plus the work-only executor.
 */
export const EXECUTING_PROJECT_ROLES: readonly ProjectRole[] = [
  ...ACTING_PROJECT_ROLES,
  'executor',
] as const;

/**
 * 项目内的管理角色，用于「谁能改项目配置」这类判定。
 * The managing roles inside a project, for checks like "who may change the
 * project's configuration".
 */
export const LEAD_PROJECT_ROLES: readonly ProjectRole[] = ['tech_lead', 'pm'] as const;
