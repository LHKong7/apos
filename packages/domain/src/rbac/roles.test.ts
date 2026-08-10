import { describe, expect, it } from 'vitest';
import { ProjectRole } from '@apos/contracts';
import { PERMISSIONS, PERMISSION_SPECS, type Permission } from './catalog';
import {
  BUILTIN_ROLES,
  BUILTIN_ROLE_PERMISSIONS,
  RoleKey,
  assignableBy,
  assignablePermissions,
  roleAcceptsActor,
  validateRoleDefinition,
} from './roles';
import { can } from './authorize';

/**
 * 自定义角色（docs/tech/09-security.md §2.2）。
 *
 * ★ 超管在这里造出「研发」「运营」「测试」——「组织怎么分工」是每家不一样的，
 *   内置的六个覆盖不了。这一组测试钉住的是**造角色时的三条边界**：
 *   不认识的权限、组织级权限、只能人类行使的权限。
 */

const def = (over: Partial<Parameters<typeof validateRoleDefinition>[0]> = {}) => ({
  key: over.key ?? 'dev',
  name: over.name ?? '研发',
  description: over.description ?? '',
  permissions: over.permissions ?? ['project.view', 'work_item.execute'],
  appliesTo: over.appliesTo ?? (['human'] as ('human' | 'agent')[]),
});

describe('内置角色由权限目录反推', () => {
  /**
   * ★ 不手写第二份。目录写的是「这条权限给哪些角色」，
   *   角色表要的是反方向 —— 手写反向表意味着改目录时要记得同步，
   *   而漏同步的表现是「矩阵里写着 pm 能做，实际 pm 做不了」，没有报错。
   */
  it('★ 角色的权限集合与目录里的角色清单互为反向，不会漂移', () => {
    for (const permission of PERMISSIONS) {
      for (const role of PERMISSION_SPECS[permission].projectRoles ?? []) {
        expect(`${role}/${permission}`).toBe(
          BUILTIN_ROLE_PERMISSIONS[role].includes(permission) ? `${role}/${permission}` : 'MISSING',
        );
      }
    }
  });

  it('★ 按权限集合判与按角色名判，对内置角色给出同一个答案', () => {
    for (const role of ProjectRole.options) {
      for (const permission of PERMISSIONS) {
        const byName = can({ orgRole: 'member', projectRole: role }, permission);
        const bySet = can(
          { orgRole: 'member', projectRole: 'x_custom', grantedPermissions: BUILTIN_ROLE_PERMISSIONS[role] },
          permission,
        );
        expect(`${role}/${permission}=${byName}`).toBe(`${role}/${permission}=${bySet}`);
      }
    }
  });

  it('六个内置角色都有名字与描述', () => {
    expect(BUILTIN_ROLES).toHaveLength(ProjectRole.options.length);
    for (const r of BUILTIN_ROLES) {
      expect(r.builtin).toBe(true);
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.appliesTo.length).toBeGreaterThan(0);
    }
  });
});

describe('★★ 谁能担任：人还是 Agent', () => {
  /**
   * ★ 带 Human Gate 权限的角色一律不能给 Agent。
   *   这不是配置项，是算出来的下限 —— 「确认需求、批准计划、处理决策」
   *   是这个产品「人类掌握最终决策权」那句话的全部落点。
   */
  it('★ 带 Human Gate 权限的内置角色只能给人', () => {
    const humanOnly = ['sponsor', 'tech_lead', 'pm', 'member'] as const;
    for (const key of humanOnly) {
      const role = BUILTIN_ROLES.find((r) => r.key === key)!;
      expect(`${key}:${role.appliesTo.join(',')}`).toBe(`${key}:human`);
    }
  });

  /** 混合团队要有一个 Agent 能担任的干活角色，否则「Agent 是团队成员」无从谈起 */
  it('★ executor 是 Agent 也能担任的执行角色', () => {
    const executor = BUILTIN_ROLES.find((r) => r.key === 'executor')!;
    expect(executor.appliesTo).toEqual(['human', 'agent']);
    expect(executor.permissions).toContain('work_item.execute');
    expect(executor.permissions).not.toContain('decision.act');
  });

  it('assignableBy 按 humanOnly 算出下限', () => {
    expect(assignableBy(['project.view', 'work_item.execute'])).toEqual(['human', 'agent']);
    expect(assignableBy(['project.view', 'decision.act'])).toEqual(['human']);
  });

  it('指派时按 appliesTo 判担任者类型', () => {
    const agentRole = { appliesTo: ['human', 'agent'] as ('human' | 'agent')[] };
    const humanRole = { appliesTo: ['human'] as ('human' | 'agent')[] };
    expect(roleAcceptsActor(agentRole, 'agent')).toBe(true);
    expect(roleAcceptsActor(humanRole, 'agent')).toBe(false);
    expect(roleAcceptsActor(humanRole, 'human')).toBe(true);
    // service / external / system 不进成员表
    expect(roleAcceptsActor(agentRole, 'system')).toBe(false);
  });
});

describe('★★ 建角色的三条边界', () => {
  it('合法定义没有错误', () => {
    expect(validateRoleDefinition(def())).toEqual([]);
  });

  /** 放过去的话那条权限永远不生效，而管理员以为自己授权了 */
  it('★ 不认识的权限名当场拒绝，不静默忽略', () => {
    const errors = validateRoleDefinition(def({ permissions: ['project.view', 'not_a_permission'] }));
    expect(errors[0]?.field).toBe('permissions');
    expect(errors[0]?.message).toContain('not_a_permission');
  });

  /**
   * ★★ 组织级权限不下放。允许的话，超管可以造一个「能创建角色的角色」，
   *   拿到它的人再造一个更宽的 —— 一步从项目角色走到组织管理员。
   */
  it('★ 组织级权限不能进项目角色 —— 堵掉「能创建角色的角色」', () => {
    const errors = validateRoleDefinition(
      def({ permissions: ['project.view', 'org.roles.manage'] }),
    );
    expect(errors[0]?.message).toContain('组织级权限不能下放');
    expect(errors[0]?.message).toContain('定义角色');
  });

  it('可授予的权限清单里没有任何组织级权限', () => {
    for (const p of assignablePermissions()) {
      expect(`${p}:${PERMISSION_SPECS[p].scope}`).not.toBe(`${p}:org`);
    }
    expect(assignablePermissions()).not.toContain('org.roles.manage' as Permission);
    expect(assignablePermissions()).not.toContain('audit.export' as Permission);
  });

  /**
   * ★★ §7.2 的推论：不能靠「自定义一个叫研发的角色，把改 Policy 塞进去，
   *   再指派给 Agent」绕过「Agent 不能改自己的约束」。
   */
  it('★ humanOnly 的权限进不了 Agent 角色', () => {
    const errors = validateRoleDefinition(
      def({ permissions: ['project.view', 'policy.loosen'], appliesTo: ['human', 'agent'] }),
    );
    expect(errors[0]?.field).toBe('appliesTo');
    expect(errors[0]?.message).toContain('只能由人类行使');
  });

  it('同样的权限限定给人类就没问题', () => {
    expect(
      validateRoleDefinition(
        def({ permissions: ['project.view', 'policy.loosen'], appliesTo: ['human'] }),
      ),
    ).toEqual([]);
  });

  it('角色标识有格式约束 —— 它会出现在 Policy 规则里', () => {
    expect(RoleKey.safeParse('dev').success).toBe(true);
    expect(RoleKey.safeParse('sec_scan_2').success).toBe(true);
    expect(RoleKey.safeParse('研发').success).toBe(false);
    expect(RoleKey.safeParse('Dev').success).toBe(false);
    expect(RoleKey.safeParse('2dev').success).toBe(false);
  });
});

describe('自定义角色参与判定', () => {
  it('★ 权限集合说了算，跟角色叫什么名字无关', () => {
    const devAgent = {
      orgRole: 'member' as const,
      projectRole: 'dev',
      grantedPermissions: ['project.view', 'work_item.execute'] as Permission[],
      actorType: 'agent' as const,
    };
    expect(can(devAgent, 'work_item.execute')).toBe(true);
    expect(can(devAgent, 'plan.approve')).toBe(false);
  });

  /** 角色配错了也拦得住：humanOnly 在判定层还有一道 */
  it('★ 就算角色里塞进了 humanOnly 权限，Agent 也用不了', () => {
    const misconfigured = {
      orgRole: 'member' as const,
      projectRole: 'dev',
      grantedPermissions: ['policy.loosen'] as Permission[],
      actorType: 'agent' as const,
    };
    expect(can(misconfigured, 'policy.loosen')).toBe(false);
    // 同一个角色给人就能用
    expect(can({ ...misconfigured, actorType: 'human' }, 'policy.loosen')).toBe(true);
  });
});
