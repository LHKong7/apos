import { isOrgAdmin, type ActorType, type OrgRole, type ProjectRole } from '@apos/contracts';
import { PERMISSIONS, PERMISSION_SPECS, type Permission } from './catalog';

/**
 * 授权判定 —— docs/tech/09-security.md §2.1 的四层里的 ①② 层。
 *
 * ```
 * ① 组织角色 → ② 项目角色 → ③ 资源级 Policy → ④ 数据权限
 *                                  ↑ 任一层拒绝即拒绝
 * ```
 *
 * ★ 这里只回答「你有没有资格做」。「这件事该不该自动做」是 ③ 层，
 *   由 Policy Engine 回答（packages/domain/src/policy/）。两者不能互相替代：
 *   一个 tech_lead 有资格批准计划（②通过），但如果计划涉及生产 DDL，
 *   Policy 仍会要求 DBA 签字（③）。
 *
 * ★ 判定是纯函数，不碰数据库。调用方负责把角色查出来传进来 ——
 *   这样同一份判定前端也能用（灰按钮）而不必把成员表暴露出去。
 *
 * Authorization — layers ① and ② of the four in docs/tech/09-security.md §2.1.
 *
 * ★ This answers only "are you entitled to do it". Whether it *should happen
 *   automatically* is layer ③, answered by the Policy Engine
 *   (packages/domain/src/policy/). Neither substitutes for the other: a
 *   tech_lead is entitled to approve a plan (② passes), but if the plan
 *   involves production DDL, policy still demands a DBA's signature (③).
 *
 * ★ The check is a pure function and never touches the database. The caller
 *   looks the roles up and passes them in, which is what lets the frontend run
 *   the same check (to gray out a button) without exposing the member table.
 */

export interface RbacActor {
  /**
   * 身份类型（§1）。缺省当人类处理 —— humanOnly 的口子必须一直关着，
   * 不管调用方是人、是 Agent，还是一个自定义角色下的 Agent。
   *
   * Actor kind (§1). Defaults to human — the humanOnly gate has to stay shut
   * whether the caller is a person, an Agent, or an Agent wearing a custom
   * role.
   */
  actorType?: ActorType;
  /**
   * 组织角色。跨组织的调用方不该走到这里，由成员关系闸门先挡掉。
   * Organization role. A cross-organization caller should never reach here —
   * the membership gate stops them first.
   */
  orgRole: OrgRole;
  /**
   * 在**目标项目**里的角色 key；不是成员则为 null。
   *
   * ★ 类型是 string 不是内置枚举：角色是数据，组织可以自定义
   *   （研发 / 运营 / 测试…）。内置的五个只是预置数据，不是全集。
   *
   * The role key inside the **target project**; null when not a member.
   *
   * ★ Typed as string rather than the built-in enum: roles are data and an
   *   organization defines its own (engineering, ops, QA…). The built-in five
   *   are seeded data, not the complete set.
   */
  projectRole: ProjectRole | string | null;
  /**
   * 这个角色授予的权限。自定义角色靠它判定 —— 内置角色不传也行，
   * 目录里的 `projectRoles` 会兜住（见 {@link check} 的④⑤两步）。
   *
   * The permissions this role grants. Custom roles are decided by it; built-in
   * roles may omit it, since `projectRoles` in the catalog covers them (see
   * steps ④ and ⑤ of {@link check}).
   */
  grantedPermissions?: readonly Permission[];
  /**
   * 目标资源是否归调用者所有（`agent_owner`）。
   *
   * ★ 这是 §2.2 里唯一的资源级角色：它跨项目，来自 agents.owner_id，
   *   不来自 project_members。
   *
   * Whether the target resource belongs to the caller (`agent_owner`).
   *
   * ★ The one resource-level role in §2.2: it spans projects and comes from
   *   `agents.owner_id`, not from `project_members`.
   */
  resourceOwner?: boolean;
}

export interface PermissionCheck {
  allowed: boolean;
  /**
   * 允许时为 null；拒绝时是一句能直接展示给用户的话。
   * null when allowed; on a refusal, a sentence that can be shown to the user
   * as-is.
   */
  reason: string | null;
}

/**
 * ★ 组织管理员恒通过 —— §2.2「org_admin：全部」。
 *
 *   注意这**不是**「org_admin 能看所有项目」：项目成员关系闸门
 *   （apps/api/src/http/rbac.ts 的 assertProjectAccess）另有判定，
 *   且限定在同一组织内。这里放行的是**能力**，不是**范围**。
 *
 * ★ An organization administrator always passes — §2.2, "org_admin: all".
 *
 *   Note this is **not** "org_admin can see every project": the project
 *   membership gate (`assertProjectAccess` in apps/api/src/http/rbac.ts) makes
 *   its own decision and stays within one organization. What passes here is
 *   **capability**, not **scope**.
 *
 *   两个例外，都在别处硬编码，不由角色决定：
 *   - 决策不可代行（§2.4）：org_admin 也批不动别人名下的决策
 *   - Agent 不能改 Policy（§7.2）：humanOnly 与角色无关
 */
export function can(actor: RbacActor, permission: Permission): boolean {
  return check(actor, permission).allowed;
}

export function check(actor: RbacActor, permission: Permission): PermissionCheck {
  const spec = PERMISSION_SPECS[permission];

  // ① 身份类型：与角色无关的硬约束，最先判，org_admin 也豁免不了
  if (spec.humanOnly && (actor.actorType ?? 'human') !== 'human') {
    return {
      allowed: false,
      reason: `「${spec.label}」只能由人类执行。Agent 可以提出建议，但不能自己动手。`,
    };
  }

  // ② 组织管理员：能力上全通
  if (isOrgAdmin(actor.orgRole)) return ALLOWED;

  // ③ 资源归属（agent_owner）
  if (spec.resourceOwner && actor.resourceOwner) return ALLOWED;

  /**
   * ④ 角色授予的权限。
   *
   * ★ 自定义角色（研发 / 运营 / 测试…）走的是这一步：它们不在目录的
   *   `projectRoles` 里，能不能做完全由这份权限集合决定。
   */
  if (actor.grantedPermissions?.includes(permission)) return ALLOWED;

  /**
   * ⑤ 内置角色。
   *
   * ★ 保留这一步是为了让只知道角色名的调用方也能判
   *   （前端夹具、集成设置那个窄接口）。内置角色的权限集合本身
   *   就是从这张表反推的（roles.ts 的 BUILTIN_ROLE_PERMISSIONS），
   *   所以④⑤两步对内置角色永远给出同一个答案。
   */
  if (
    spec.projectRoles &&
    actor.projectRole &&
    (spec.projectRoles as readonly string[]).includes(actor.projectRole)
  ) {
    return ALLOWED;
  }

  // ⑥ 组织角色（org 级操作里「组织成员即可」的那些）
  if (spec.orgRoles && spec.orgRoles.includes(actor.orgRole)) return ALLOWED;

  return { allowed: false, reason: permissionDenyReason(actor, permission) };
}

const ALLOWED: PermissionCheck = { allowed: true, reason: null };

/**
 * 不能做时给出为什么与该找谁。
 *
 * ★ 「你不是成员」和「你是成员但角色不够」要分开说 ——
 *   前者的下一步是换身份或找人加成员，后者的下一步是找对应角色的人。
 *   混成一句「无权限」，两种情况的用户都会卡在原地。
 */
export function permissionDenyReason(
  actor: RbacActor,
  permission: Permission,
  overrides: { notMember?: string } = {},
): string {
  const spec = PERMISSION_SPECS[permission];
  if (spec.scope === 'project' && actor.projectRole === null) {
    return overrides.notMember ?? `你不是这个项目的成员，无法${spec.label}`;
  }
  return spec.requires;
}

/**
 * 一次算全部 —— 前端要按十几个按钮的可用状态渲染一页，
 * 逐个问一遍既啰嗦又会让「问漏一个」变成默认可点。
 */
export function permissionsOf(actor: RbacActor): Record<Permission, boolean> {
  return Object.fromEntries(PERMISSIONS.map((p) => [p, can(actor, p)])) as Record<
    Permission,
    boolean
  >;
}

/**
 * 拒绝原因表，与 {@link permissionsOf} 配套。
 *
 * ★ 前端需要它来写 tooltip：一个灰掉但不说明原因的按钮，
 *   比没有这个按钮更让人困惑 —— 用户会反复点它。
 */
export function denyReasonsOf(actor: RbacActor): Partial<Record<Permission, string>> {
  const out: Partial<Record<Permission, string>> = {};
  for (const p of PERMISSIONS) {
    const result = check(actor, p);
    if (!result.allowed && result.reason) out[p] = result.reason;
  }
  return out;
}
