import { describe, expect, it } from 'vitest';
import {
  canIntegration,
  denyReason,
  integrationPermissions,
  type Actor,
} from './integration';

const pm: Actor = { projectRole: 'pm', orgRole: 'member' };
const lead: Actor = { projectRole: 'tech_lead', orgRole: 'member' };
const member: Actor = { projectRole: 'member', orgRole: 'member' };
const viewer: Actor = { projectRole: 'viewer', orgRole: 'member' };
const outsider: Actor = { projectRole: null, orgRole: 'member' };
const orgAdmin: Actor = { projectRole: null, orgRole: 'org_admin' };

/**
 * 集成设置的权限（页面文档 14 §8）。
 *
 * 这一页管的是「谁能给外部系统开写权限」，权限判定本身就是功能的一部分。
 */
describe('分档', () => {
  it('项目成员能看、能处理冲突', () => {
    expect(canIntegration(member, 'view')).toBe(true);
    expect(canIntegration(member, 'resolve_conflict')).toBe(true);
  });

  it('普通成员不能连接、不能改 SoT、不能断开', () => {
    expect(canIntegration(member, 'connect')).toBe(false);
    expect(canIntegration(member, 'change_sot')).toBe(false);
    expect(canIntegration(member, 'disconnect')).toBe(false);
  });

  /**
   * ★ 「能连上」和「能让它改我的代码」是两个量级的授权。
   *   pm 可以连接，但开写权限只有 tech_lead —— 放同一档
   *   等于把后者默认送出去。
   */
  it('★ pm 能连接，但授予写权限只有 tech_lead', () => {
    expect(canIntegration(pm, 'connect')).toBe(true);
    expect(canIntegration(pm, 'grant_write')).toBe(false);
    expect(canIntegration(lead, 'grant_write')).toBe(true);
  });

  it('通知配置归 pm，数据连接器归组织管理员', () => {
    expect(canIntegration(pm, 'configure_notification')).toBe(true);
    expect(canIntegration(lead, 'configure_notification')).toBe(false);
    expect(canIntegration(pm, 'configure_data_connector')).toBe(false);
    expect(canIntegration(orgAdmin, 'configure_data_connector')).toBe(true);
  });

  it('只读成员与非成员看不到', () => {
    expect(canIntegration(viewer, 'view')).toBe(false);
    expect(canIntegration(outsider, 'view')).toBe(false);
  });

  it('组织管理员不受项目角色限制', () => {
    expect(canIntegration(orgAdmin, 'view')).toBe(true);
    expect(canIntegration(orgAdmin, 'grant_write')).toBe(true);
    expect(canIntegration(orgAdmin, 'disconnect')).toBe(true);
  });
});

describe('拒绝时给出为什么', () => {
  /** 只说「无权限」等于让用户卡死在这一页 */
  it('★ 拒绝理由说明需要什么角色，而不是只说「无权限」', () => {
    const r = denyReason(pm, 'grant_write');
    expect(r).toContain('tech_lead');
    expect(r).toContain('比「连上」高一个量级');
  });

  it('非成员的理由指向「不是这个项目的成员」', () => {
    expect(denyReason(outsider, 'connect')).toBe('你不是这个项目的成员');
  });

  it('有权限时没有理由', () => {
    expect(denyReason(lead, 'grant_write')).toBeNull();
  });
});

describe('批量查询', () => {
  it('一次拿全所有动作的可用性', () => {
    const p = integrationPermissions(lead);
    expect(p.view).toBe(true);
    expect(p.grant_write).toBe(true);
    expect(p.configure_notification).toBe(false);
    expect(p.configure_data_connector).toBe(false);
  });
});
