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
 */

export interface RbacActor {
  /**
   * 身份类型（§1）。缺省当人类处理 —— MVP 只有人类身份能到这一层，
   * 但 humanOnly 的口子必须现在就关上，而不是等 Agent 令牌接进来再补。
   */
  actorType?: ActorType;
  /** 组织角色。跨组织的调用方不该走到这里，由成员关系闸门先挡掉 */
  orgRole: OrgRole;
  /** 在**目标项目**里的角色；不是成员则为 null */
  projectRole: ProjectRole | null;
  /**
   * 目标资源是否归调用者所有（`agent_owner`）。
   *
   * ★ 这是 §2.2 里唯一的资源级角色：它跨项目，来自 agents.owner_id，
   *   不来自 project_members。
   */
  resourceOwner?: boolean;
}

export interface PermissionCheck {
  allowed: boolean;
  /** 允许时为 null；拒绝时是一句能直接展示给用户的话 */
  reason: string | null;
}

/**
 * ★ 组织管理员恒通过 —— §2.2「org_admin：全部」。
 *
 *   注意这**不是**「org_admin 能看所有项目」：项目成员关系闸门
 *   （apps/api/src/http/rbac.ts 的 assertProjectAccess）另有判定，
 *   且限定在同一组织内。这里放行的是**能力**，不是**范围**。
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

  // ④ 项目角色
  if (spec.projectRoles && actor.projectRole && spec.projectRoles.includes(actor.projectRole)) {
    return ALLOWED;
  }

  // ⑤ 组织角色（org 级操作里「组织成员即可」的那些）
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
