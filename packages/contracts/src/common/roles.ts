import { z } from 'zod';

/**
 * 角色定义（docs/tech/09-security.md §2.2）。
 *
 * ★ 放在 contracts 而不是各处各写一份字符串：角色名同时出现在
 *   数据库列、Policy 的 `{ kind: 'project_role', role }` 通知目标、
 *   前端的按钮判定里。写成裸字符串的话，把 `tech_lead` 敲成 `techlead`
 *   不会有任何报错 —— 只是那条规则从此永远命中不到人，
 *   而「没人收到通知」这种故障要几周后才会被发现。
 */

/**
 * 组织角色。
 *
 * ★ `admin` 是 `org_admin` 的历史别名（早期 seed 数据用的是它），
 *   两者等价。新代码一律用 `org_admin`，判定时用 {@link isOrgAdmin}
 *   而不是 `=== 'org_admin'` —— 直接比较会把老数据里的 admin 判成普通成员，
 *   表现为「管理员突然什么都做不了了」。
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

/**
 * 能参与项目日常决策的角色 —— 「录需求、答澄清、处理决策」这一档的门槛。
 *
 * ★ `viewer` 不在其中，这是 viewer 存在的全部意义：
 *   一个能写的只读角色等于没有只读角色。
 *
 * ★ `executor` 也不在其中，而且这才是它的意义：执行者干活但不决策。
 *   把它放进来，「谁能替 Agent 做决定」这个问题就没有答案了。
 */
export const ACTING_PROJECT_ROLES: readonly ProjectRole[] = [
  'sponsor',
  'tech_lead',
  'pm',
  'member',
] as const;

/** 能实际推进任务的角色 —— 比 ACTING 多一个只干活的执行者 */
export const EXECUTING_PROJECT_ROLES: readonly ProjectRole[] = [
  ...ACTING_PROJECT_ROLES,
  'executor',
] as const;

/** 项目内的管理角色，用于「谁能改项目配置」这类判定 */
export const LEAD_PROJECT_ROLES: readonly ProjectRole[] = ['tech_lead', 'pm'] as const;
