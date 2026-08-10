import { describe, expect, it } from 'vitest';
import { PERMISSIONS, PERMISSION_SPECS, type Permission } from './catalog';
import { can, check, denyReasonsOf, permissionsOf, type RbacActor } from './authorize';

/**
 * 权限矩阵（docs/tech/09-security.md §2.2 / §2.3）。
 *
 * 这一组测试不是「覆盖率」，是把规格表逐条钉住 ——
 * 权限判定改错了不会有任何运行时症状，只会安静地多放行一些人。
 */

const actor = (over: Partial<RbacActor> = {}): RbacActor => ({
  orgRole: 'member',
  projectRole: 'member',
  ...over,
});

const sponsor = actor({ projectRole: 'sponsor' });
const lead = actor({ projectRole: 'tech_lead' });
const pm = actor({ projectRole: 'pm' });
const member = actor({ projectRole: 'member' });
const viewer = actor({ projectRole: 'viewer' });
const outsider = actor({ projectRole: null });
const orgAdmin = actor({ projectRole: null, orgRole: 'org_admin' });

describe('§2.3 权限矩阵', () => {
  it('批准需求是业务判断，归 sponsor / pm，tech_lead 不行', () => {
    expect(can(sponsor, 'requirement.approve')).toBe(true);
    expect(can(pm, 'requirement.approve')).toBe(true);
    expect(can(lead, 'requirement.approve')).toBe(false);
    expect(can(member, 'requirement.approve')).toBe(false);
  });

  it('批准计划是技术判断，归 tech_lead，pm 不行', () => {
    expect(can(lead, 'plan.approve')).toBe(true);
    expect(can(pm, 'plan.approve')).toBe(false);
  });

  it('修改自治等级归 pm / tech_lead', () => {
    expect(can(pm, 'project.autonomy.change')).toBe(true);
    expect(can(lead, 'project.autonomy.change')).toBe(true);
    expect(can(member, 'project.autonomy.change')).toBe(false);
  });

  /** 强制放行绕过的是质量闸门，和「能改任务」不是一个量级 */
  it('★ 改任务状态人人可以，强制放行只有 tech_lead', () => {
    expect(can(member, 'work_item.execute')).toBe(true);
    expect(can(member, 'work_item.force_pass')).toBe(false);
    expect(can(pm, 'work_item.force_pass')).toBe(false);
    expect(can(lead, 'work_item.force_pass')).toBe(true);
  });

  it('控制 Run 归 pm / tech_lead，或该 Agent 的 owner', () => {
    expect(can(pm, 'run.control')).toBe(true);
    expect(can(lead, 'run.control')).toBe(true);
    expect(can(member, 'run.control')).toBe(false);
    expect(can(actor({ projectRole: 'member', resourceOwner: true }), 'run.control')).toBe(true);
  });

  /** 详细模式可能含敏感上下文（§2.3 最后一行）*/
  it('Run 详细模式只有 tech_lead 与 agent_owner 能看', () => {
    expect(can(lead, 'run.view_detailed')).toBe(true);
    expect(can(pm, 'run.view_detailed')).toBe(false);
    expect(can(actor({ projectRole: 'member', resourceOwner: true }), 'run.view_detailed')).toBe(
      true,
    );
  });

  it('导出审计日志只有组织管理员', () => {
    expect(can(orgAdmin, 'audit.export')).toBe(true);
    expect(can(lead, 'audit.export')).toBe(false);
  });
});

describe('★★ 不对称：收紧比放宽门槛低', () => {
  /**
   * §2.3「收紧总是安全的，放宽需要更高门槛与额外证据」。
   * 两个方向放同一档，等于让「逐次小幅放宽」（§7 权限累积）畅通无阻。
   */
  it('Policy：pm 能收紧，但放宽只有 tech_lead', () => {
    expect(can(pm, 'policy.tighten')).toBe(true);
    expect(can(pm, 'policy.loosen')).toBe(false);
    expect(can(lead, 'policy.loosen')).toBe(true);
  });

  it('Agent 权限：owner 能收紧，扩大要 tech_lead', () => {
    const owner = actor({ projectRole: 'member', resourceOwner: true });
    expect(can(owner, 'agent.permissions.restrict')).toBe(true);
    expect(can(owner, 'agent.permissions.expand')).toBe(false);
    expect(can(lead, 'agent.permissions.expand')).toBe(true);
  });

  it('放宽类操作在目录里声明了额外证据要求', () => {
    expect(PERMISSION_SPECS['policy.loosen'].governance?.simulation).toBe(true);
    expect(PERMISSION_SPECS['policy.tighten'].governance?.simulation).toBeUndefined();
    expect(PERMISSION_SPECS['agent.permissions.expand'].governance?.audit).toBe(true);
  });
});

describe('viewer 与非成员', () => {
  /** 一个能写的只读角色等于没有只读角色 */
  it('★ viewer 一个写操作都做不了', () => {
    const writes = PERMISSIONS.filter(
      (p) => !p.endsWith('.view') && p !== 'project.create' && p !== 'agent.view',
    );
    for (const p of writes) {
      expect(`${p}=${can(viewer, p)}`).toBe(`${p}=false`);
    }
  });

  it('viewer 能看项目与规则', () => {
    expect(can(viewer, 'project.view')).toBe(true);
    expect(can(viewer, 'policy.view')).toBe(true);
  });

  it('非成员连看都不行', () => {
    expect(can(outsider, 'project.view')).toBe(false);
    expect(can(outsider, 'policy.view')).toBe(false);
  });
});

describe('组织管理员', () => {
  it('能力上全通，不受项目角色限制', () => {
    for (const p of PERMISSIONS) {
      expect(`${p}=${can(orgAdmin, p)}`).toBe(`${p}=true`);
    }
  });

  /** 老数据里的 admin 与 org_admin 等价 —— 直接比字符串会把管理员判成普通成员 */
  it('admin 是 org_admin 的别名', () => {
    expect(can(actor({ orgRole: 'admin', projectRole: null }), 'audit.export')).toBe(true);
  });

  /**
   * ★ 「全部权限」说的是能力，不是范围。
   *   跨组织的收窄由成员关系闸门负责（apps/api 的 assertProjectAccess），
   *   不在这一层 —— 这里放行不等于他能看到别的组织的项目。
   */
  it('★ 但 Agent 身份即使是管理员也改不了 Policy', () => {
    const agentAdmin = actor({ orgRole: 'org_admin', projectRole: null, actorType: 'agent' });
    expect(can(agentAdmin, 'policy.loosen')).toBe(false);
    expect(can(agentAdmin, 'policy.tighten')).toBe(false);
  });
});

describe('§7.2 Agent 不能修改自己的约束', () => {
  /** 「如果 Agent 能改自己的约束，整个治理体系就是装饰」 */
  it('★ humanOnly 的操作，Agent 一律不行 —— 哪怕项目角色是 tech_lead', () => {
    const agentLead = actor({ actorType: 'agent', projectRole: 'tech_lead' });
    expect(can(agentLead, 'policy.tighten')).toBe(false);
    expect(can(agentLead, 'policy.loosen')).toBe(false);
    expect(can(agentLead, 'agent.permissions.expand')).toBe(false);
    expect(can(agentLead, 'project.members.manage')).toBe(false);
  });

  it('人类同角色则可以 —— 拦的是身份类型不是角色', () => {
    expect(can(lead, 'policy.tighten')).toBe(true);
  });

  it('拒绝理由说明「可以建议但不能自己动手」', () => {
    const verdict = check(actor({ actorType: 'agent', projectRole: 'tech_lead' }), 'policy.loosen');
    expect(verdict.reason).toContain('只能由人类执行');
  });

  it('service / external 身份同样被拦', () => {
    for (const actorType of ['service', 'external', 'system'] as const) {
      expect(can(actor({ actorType, projectRole: 'tech_lead' }), 'policy.loosen')).toBe(false);
    }
  });
});

describe('拒绝时说清楚为什么', () => {
  /** 只说「无权限」等于让用户卡死在原地 */
  it('★ 「不是成员」与「角色不够」是两句不同的话', () => {
    expect(check(outsider, 'plan.approve').reason).toContain('不是这个项目的成员');
    expect(check(pm, 'plan.approve').reason).toContain('tech_lead');
  });

  it('每条权限都有可展示的拒绝理由，没有空话', () => {
    for (const p of PERMISSIONS) {
      const spec = PERMISSION_SPECS[p];
      expect(`${p}: ${spec.requires}`).not.toContain('权限不足');
      expect(spec.requires.length).toBeGreaterThan(4);
      expect(spec.label.length).toBeGreaterThan(1);
    }
  });

  it('批量查询与逐条判定结果一致', () => {
    const all = permissionsOf(pm);
    for (const p of PERMISSIONS) expect(all[p]).toBe(can(pm, p));
  });

  it('拒绝理由表只包含拒绝掉的那些', () => {
    const reasons = denyReasonsOf(pm);
    const allowed = permissionsOf(pm);
    for (const p of PERMISSIONS) {
      expect(`${p}:${p in reasons}`).toBe(`${p}:${!allowed[p]}`);
    }
  });
});

describe('目录本身的完整性', () => {
  it('每条权限都能被某个角色满足 —— 没有谁都做不了的死条目', () => {
    const candidates: RbacActor[] = [
      sponsor,
      lead,
      pm,
      member,
      viewer,
      orgAdmin,
      actor({ projectRole: null, resourceOwner: true }),
    ];
    for (const p of PERMISSIONS as readonly Permission[]) {
      expect(`${p}:${candidates.some((a) => can(a, p))}`).toBe(`${p}:true`);
    }
  });

  it('project 作用域的权限都列了项目角色，否则只有管理员做得了', () => {
    for (const p of PERMISSIONS) {
      const spec = PERMISSION_SPECS[p];
      if (spec.scope !== 'project') continue;
      expect(`${p}:${Boolean(spec.projectRoles?.length)}`).toBe(`${p}:true`);
    }
  });
});
