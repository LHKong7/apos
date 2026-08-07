/**
 * 集成设置的权限判定（页面文档 14 §8）。
 *
 * ★ 放在 domain 而不是各写一份：前端要用它来决定按钮的可用状态，
 *   后端要用它来真正拦住请求。两份实现意味着界面上能点的东西
 *   服务端未必让做（用户体验差），或者服务端让做的界面上点不了
 *   （功能等于没有）—— 而这一页管的是「谁能给外部系统开写权限」，
 *   两种偏差都不能接受。
 *
 * ★ 前端的判定只用来「灰掉按钮」，服务端的判定才是真的拦截。
 *   共用一份实现不等于信任前端。
 */

export type ProjectRole = 'pm' | 'tech_lead' | 'member' | 'viewer';
export type OrgRole = 'org_admin' | 'admin' | 'member';

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

const RULES: Record<IntegrationAction, (a: Actor) => boolean> = {
  /** 项目成员即可 */
  view: (a) => isMember(a) || isOrgAdmin(a),

  connect: (a) => lead(a) || isOrgAdmin(a),

  /**
   * ★ 授予写权限单独一档，且只有 tech_lead 以上。
   *   「能连上」和「能让它改我的代码 / 改我的 Jira」是两个量级的授权，
   *   放同一档等于把后者默认送出去。这条同时要求记审计（在 API 层）。
   */
  grant_write: (a) => a.projectRole === 'tech_lead' || isOrgAdmin(a),

  /**
   * ★ 改 SoT 影响数据一致性：它决定以后哪一边的修改会被丢掉。
   *   界面上还要二次确认 —— 这是唯一一个「改完之后错误不会立刻显现」的配置。
   */
  change_sot: (a) => lead(a) || isOrgAdmin(a),

  disconnect: (a) => a.projectRole === 'pm' || a.projectRole === 'tech_lead' || isOrgAdmin(a),

  /** 处理冲突是日常工作，不该卡权限 —— 卡住的结果是冲突没人清 */
  resolve_conflict: (a) => isMember(a) || isOrgAdmin(a),

  configure_notification: (a) => a.projectRole === 'pm' || isOrgAdmin(a),

  /** 数据连接器必须组织级配置（产品文档 10.3 / 10.4） */
  configure_data_connector: (a) => isOrgAdmin(a),
};

export function canIntegration(actor: Actor, action: IntegrationAction): boolean {
  return RULES[action](actor);
}

/** 不能做时给出为什么与该找谁 —— 只说「无权限」等于让用户卡死在这一页 */
export function denyReason(actor: Actor, action: IntegrationAction): string | null {
  if (canIntegration(actor, action)) return null;
  if (!actor.projectRole && !isOrgAdmin(actor)) return '你不是这个项目的成员';
  return REQUIREMENT[action];
}

const REQUIREMENT: Record<IntegrationAction, string> = {
  view: '需要项目成员权限',
  connect: '需要 pm 或 tech_lead 权限',
  grant_write: '授予写权限需要 tech_lead —— 让集成能改代码或改外部工单，是比「连上」高一个量级的授权',
  change_sot: '修改 Source of Truth 需要 pm 或 tech_lead —— 它决定以后哪一边的修改会被丢掉',
  disconnect: '断开连接需要 pm 或 tech_lead',
  resolve_conflict: '需要项目成员权限',
  configure_notification: '配置群组通知需要 pm；个人通知偏好在你自己的设置里',
  configure_data_connector: '数据连接器必须由组织管理员在组织级配置',
};

/** 前端一次拿全，逐个按钮问一遍太啰嗦 */
export function integrationPermissions(actor: Actor): Record<IntegrationAction, boolean> {
  return Object.fromEntries(
    (Object.keys(RULES) as IntegrationAction[]).map((a) => [a, canIntegration(actor, a)]),
  ) as Record<IntegrationAction, boolean>;
}

function isMember(a: Actor): boolean {
  return a.projectRole !== null && a.projectRole !== 'viewer';
}

function lead(a: Actor): boolean {
  return a.projectRole === 'pm' || a.projectRole === 'tech_lead';
}

function isOrgAdmin(a: Actor): boolean {
  return a.orgRole === 'org_admin' || a.orgRole === 'admin';
}
