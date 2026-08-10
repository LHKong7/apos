import type { OrgRole, ProjectRole } from '@apos/contracts';
import { can, permissionDenyReason, type RbacActor } from '../rbac/authorize';
import { PERMISSION_SPECS, type Permission } from '../rbac/catalog';

/**
 * 集成设置的权限判定（页面文档 14 §8）。
 *
 * ★ 这里是 {@link ../rbac 权限目录} 的一个**窄接口**，不是第二份实现。
 *   集成设置页只关心八个动作，让它按 `'grant_write'` 这样的短名字提问
 *   比让它拼 `'integration.grant_write'` 舒服；但判定必须是同一份 ——
 *   两份规则意味着界面上能点的东西服务端未必让做，
 *   而这一页管的是「谁能给外部系统开写权限」。
 *
 * ★ 前端的判定只用来「灰掉按钮」，服务端的判定才是真的拦截。
 *   共用一份实现不等于信任前端。
 */

export type { OrgRole, ProjectRole };

export type IntegrationAction =
  | 'view'
  | 'connect'
  | 'grant_write'
  | 'change_sot'
  | 'disconnect'
  | 'resolve_conflict'
  | 'configure_notification'
  | 'configure_data_connector';

export interface Actor {
  /** 在这个项目里的角色；不是成员则为 null */
  projectRole: ProjectRole | null;
  orgRole: OrgRole;
}

const PERMISSION_OF: Record<IntegrationAction, Permission> = {
  view: 'integration.view',
  connect: 'integration.connect',
  grant_write: 'integration.grant_write',
  change_sot: 'integration.change_sot',
  disconnect: 'integration.disconnect',
  resolve_conflict: 'integration.resolve_conflict',
  configure_notification: 'integration.configure_notification',
  configure_data_connector: 'integration.configure_data_connector',
};

const ACTIONS = Object.keys(PERMISSION_OF) as IntegrationAction[];

function toRbacActor(actor: Actor): RbacActor {
  return { projectRole: actor.projectRole, orgRole: actor.orgRole };
}

export function canIntegration(actor: Actor, action: IntegrationAction): boolean {
  return can(toRbacActor(actor), PERMISSION_OF[action]);
}

/** 不能做时给出为什么与该找谁 —— 只说「无权限」等于让用户卡死在这一页 */
export function denyReason(actor: Actor, action: IntegrationAction): string | null {
  if (canIntegration(actor, action)) return null;
  return permissionDenyReason(toRbacActor(actor), PERMISSION_OF[action], {
    /** 这一页的「你不是成员」措辞在界面上单独有一段引导，不带动作名 */
    notMember: '你不是这个项目的成员',
  });
}

/** 前端一次拿全，逐个按钮问一遍太啰嗦 */
export function integrationPermissions(actor: Actor): Record<IntegrationAction, boolean> {
  return Object.fromEntries(ACTIONS.map((a) => [a, canIntegration(actor, a)])) as Record<
    IntegrationAction,
    boolean
  >;
}

/** 权限目录里这八个动作的人话名字，审计与提示共用 */
export function integrationActionLabel(action: IntegrationAction): string {
  return PERMISSION_SPECS[PERMISSION_OF[action]].label;
}
