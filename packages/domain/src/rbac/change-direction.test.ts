import { describe, expect, it } from 'vitest';
import type { Policy } from '@apos/contracts';
import { agentPermissionChangeDirection, policyChangeDirection } from './change-direction';

/**
 * 收紧还是放宽（docs/tech/09-security.md §2.3 的不对称设计）。
 *
 * ★ 这是整套矩阵里最容易被绕开的一条：不对称设计只有在能可靠区分
 *   两个方向时才成立。判错任一方向，不对称就白设了。
 */

/** 「要人批」的动作。assignee / dueInHours 是契约要求的，取值不影响方向判定 */
const NEEDS_HUMAN = {
  type: 'require_human_review',
  assignee: { kind: 'project_role', role: 'tech_lead' },
  dueInHours: 4,
} as const;

const policy = (over: Partial<Policy> = {}): Policy => ({
  id: over.id ?? 'p-1',
  orgId: 'org-1',
  projectId: 'proj-1',
  name: over.name ?? '规则',
  description: '',
  priority: over.priority ?? 100,
  enabled: over.enabled ?? true,
  condition: over.condition ?? { fact: 'operationType', op: 'eq', value: 'deploy' },
  action: over.action ?? { type: 'allow' },
});

describe('Policy 改动的方向', () => {
  it('加一条自动放行的规则算放宽', () => {
    expect(policyChangeDirection([], [policy()], 'agent_led_approval')).toBe('loosen');
  });

  it('把自动放行改成必须人工确认算收紧', () => {
    const before = [policy()];
    const after = [policy({ action: NEEDS_HUMAN })];
    expect(policyChangeDirection(before, after, 'agent_led_approval')).toBe('tighten');
  });

  it('只改名字不改判定结果，方向是 neutral', () => {
    const before = [policy()];
    const after = [policy({ name: '改了个名字' })];
    expect(policyChangeDirection(before, after, 'agent_led_approval')).toBe('neutral');
  });

  /**
   * ★★ 判据是结果不是写法。
   *
   *   原规则一个字没动，新规则也没直接改它 —— 只是插了一条优先级更高的
   *   宽松规则挡在前面。按「比较两条规则谁更严」判的话这次改动查不出来，
   *   而实际生效的已经是新的那条。这正是不对称设计最典型的绕法。
   */
  it('★ 用更高优先级的宽松规则盖住严格规则，照样算放宽', () => {
    const strict = policy({ id: 'strict', priority: 100, action: NEEDS_HUMAN });
    const shadow = policy({ id: 'shadow', priority: 10, action: { type: 'allow' } });

    expect(policyChangeDirection([strict], [strict, shadow], 'agent_led_approval')).toBe('loosen');
  });

  /** 混合改动按最宽的那一面判 —— 放宽的部分才是需要额外证据的 */
  it('★ 一处收紧一处放宽时，整体判为放宽', () => {
    const deploy = { fact: 'operationType', op: 'eq', value: 'deploy' } as const;
    const codeChange = { fact: 'operationType', op: 'eq', value: 'code_change' } as const;

    const before = [policy({ id: 'a', condition: deploy, action: NEEDS_HUMAN })];
    const after = [
      policy({ id: 'a', condition: deploy, action: { type: 'allow' } }),
      policy({ id: 'b', condition: codeChange, action: NEEDS_HUMAN }),
    ];
    expect(policyChangeDirection(before, after, 'agent_autonomous')).toBe('loosen');
  });
});

const perms = (over: Partial<Parameters<typeof agentPermissionChangeDirection>[0]> = {}) => ({
  allowedTools: over.allowedTools ?? ['read_file'],
  deniedTools: over.deniedTools ?? ['merge_pr'],
  resourceScopes: over.resourceScopes ?? [],
});

describe('Agent 权限改动的方向', () => {
  it('白名单变长算放宽', () => {
    expect(
      agentPermissionChangeDirection(perms(), perms({ allowedTools: ['read_file', 'write_file'] })),
    ).toBe('loosen');
  });

  it('白名单变短算收紧', () => {
    expect(agentPermissionChangeDirection(perms(), perms({ allowedTools: [] }))).toBe('tighten');
  });

  /**
   * ★ 黑名单是硬约束（§3.1「黑名单优先」）。从里面拿掉一项，
   *   等于把「这个 Agent 绝对不能合并代码」这条撤了 —— 是放宽，
   *   哪怕白名单一个字没动。按「列表变短 = 收紧」的直觉判会判反。
   */
  it('★ 黑名单变短算放宽，不是收紧', () => {
    expect(agentPermissionChangeDirection(perms(), perms({ deniedTools: [] }))).toBe('loosen');
  });

  it('黑名单变长算收紧', () => {
    expect(
      agentPermissionChangeDirection(perms(), perms({ deniedTools: ['merge_pr', 'deploy'] })),
    ).toBe('tighten');
  });

  /** 未列出的资源默认 none（§3.1 默认拒绝），所以新增一条 read 也是放宽 */
  it('★ 新增一个资源范围算放宽 —— 未列出等于 none 而不是「不管」', () => {
    expect(
      agentPermissionChangeDirection(
        perms(),
        perms({ resourceScopes: [{ kind: 'repo', ref: 'order-service', access: 'read' }] }),
      ),
    ).toBe('loosen');
  });

  it('read 升到 write 算放宽，反过来算收紧', () => {
    const read = perms({ resourceScopes: [{ kind: 'repo', ref: 'svc', access: 'read' }] });
    const write = perms({ resourceScopes: [{ kind: 'repo', ref: 'svc', access: 'write' }] });
    expect(agentPermissionChangeDirection(read, write)).toBe('loosen');
    expect(agentPermissionChangeDirection(write, read)).toBe('tighten');
  });

  it('没动就是 neutral', () => {
    expect(agentPermissionChangeDirection(perms(), perms())).toBe('neutral');
  });
});
