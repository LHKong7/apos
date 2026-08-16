import { describe, expect, it } from 'vitest';
import type { Policy, PolicyContext } from '@apos/contracts';
import { BASELINE_POLICIES } from './baseline';
import { selectPolicyGates } from './gates';

function ctx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    projectType: 'development',
    workItemType: 'task',
    riskLevel: 'low',
    reversible: true,
    externalFacing: false,
    environment: null,
    dataSensitivity: null,
    impactTaskCount: 0,
    impactServices: [],
    operationType: 'code_change',
    agentType: 'code',
    agentConfidence: null,
    agentSuccessRate: 0.92,
    consecutiveFailures: 0,
    runTokens: 0,
    projectTokensSpent: 50,
    projectTokenBudget: 500,
    budgetUsedPct: 10,
    testsResult: 'not_run',
    testCoverage: null,
    securityScan: 'not_run',
    agentReview: 'not_run',
    autonomyLevel: 'agent_led_approval',
    ...overrides,
  };
}

function policy(p: Partial<Policy> & Pick<Policy, 'condition' | 'action'>): Policy {
  return {
    id: p.id ?? 'p-test',
    orgId: '00000000-0000-0000-0000-000000000000',
    projectId: p.projectId ?? '11111111-1111-1111-1111-111111111111',
    name: p.name ?? 'test rule',
    description: '',
    priority: p.priority ?? 100,
    enabled: p.enabled ?? true,
    condition: p.condition,
    action: p.action,
  };
}

const names = (gates: { name: string }[]) => gates.map((g) => g.name);

describe('selectPolicyGates', () => {
  /**
   * ★ 这条是这个功能存在的理由。派发时 operationType 还是默认的
   *   code_change、environment 还是 null —— 照当前上下文直接求值的话，
   *   八条基线规则一条都不命中，Agent 什么警告都收不到，然后一路做到
   *   生产发布才在流转那一步被冻住。
   */
  it('★ 未定的 fact 按「可能」处理，生产发布类规则要出现在派发时的警告里', () => {
    const gates = selectPolicyGates(BASELINE_POLICIES, ctx());

    expect(names(gates)).toContain('生产环境发布需发布负责人审批');
    expect(names(gates)).toContain('生产数据库变更必须由 DBA 审批');
    expect(names(gates)).toContain('对外发送信息需人工确认');
  });

  it('已被固定 fact 排除的规则不提 —— 连续失败次数在这次执行里不会变', () => {
    const gates = selectPolicyGates(BASELINE_POLICIES, ctx({ consecutiveFailures: 0 }));
    expect(names(gates)).not.toContain('Agent 连续失败 3 次转人工');

    const retry = selectPolicyGates(BASELINE_POLICIES, ctx({ consecutiveFailures: 3 }));
    expect(names(retry)).toContain('Agent 连续失败 3 次转人工');
  });

  /**
   * ★ 没设预算时 budgetUsedPct 恒为 null，这条规则永远不可能命中。
   *   照样警告的话，每一次派发都会挂着一条永远不会发生的事 ——
   *   噪音会把真正该看的那几条淹掉。
   */
  it('★ 项目没设预算时不警告预算超限 —— 那条规则在这个项目上不可能命中', () => {
    const noBudget = selectPolicyGates(
      BASELINE_POLICIES,
      ctx({ projectTokenBudget: null, budgetUsedPct: null }),
    );
    expect(names(noBudget)).not.toContain('预算超限需 Sponsor 批准');

    const withBudget = selectPolicyGates(BASELINE_POLICIES, ctx());
    expect(names(withBudget)).toContain('预算超限需 Sponsor 批准');
  });

  /**
   * ★★ 规划标过性的任务只收到会命中的那一条。
   *
   *   不做这个区分的话，一个明确标了 deploy/production 的任务会连同付款、
   *   删资源、改权限一起收到九条 —— 真正会命中的那条淹在里面，
   *   与没警告差不多，而这正是这个功能要解决的问题。
   */
  it('★ 任务已标明 deploy/production 时只警告会命中的那条，不再撒网', () => {
    const gates = selectPolicyGates(
      BASELINE_POLICIES,
      ctx({ operationType: 'deploy', environment: 'production' }),
    );

    expect(names(gates)).toContain('生产环境发布需发布负责人审批');
    expect(names(gates)).not.toContain('执行付款需多人会签');
    expect(names(gates)).not.toContain('删除资源需多人会签');
    expect(names(gates)).not.toContain('生产数据库变更必须由 DBA 审批');
  });

  it('标了非生产环境时，生产类规则整条排除', () => {
    const gates = selectPolicyGates(
      BASELINE_POLICIES,
      ctx({ operationType: 'deploy', environment: 'test' }),
    );
    expect(names(gates)).not.toContain('生产环境发布需发布负责人审批');
  });

  /**
   * ★ 没标过的任务照旧撒网 —— operationType 兜底成 code_change 时，
   *   「没标过」与「确实是改代码」分不开，此时宁可多报。
   */
  it('★ 没标过性的任务仍然广泛警告', () => {
    const gates = selectPolicyGates(BASELINE_POLICIES, ctx());
    expect(names(gates)).toContain('执行付款需多人会签');
    expect(names(gates)).toContain('生产环境发布需发布负责人审批');
  });

  it('自动放行的规则不进警告 —— 说了 Agent 也无事可做', () => {
    const rules = [
      policy({
        name: '低风险自动放行',
        condition: { fact: 'riskLevel', op: 'eq', value: 'low' },
        action: { type: 'allow' },
      }),
      policy({
        name: '高风险要人批',
        priority: 101,
        condition: { fact: 'operationType', op: 'eq', value: 'deploy' },
        action: {
          type: 'require_human_review',
          assignee: { kind: 'project_role', role: 'tech_lead' },
          dueInHours: 4,
        },
      }),
    ];

    expect(names(selectPolicyGates(rules, ctx()))).toEqual(['高风险要人批']);
  });

  it('停用的规则不进警告', () => {
    const rules = [
      policy({
        name: '停用了的',
        enabled: false,
        condition: { fact: 'operationType', op: 'eq', value: 'deploy' },
        action: { type: 'pause', resumeCondition: 'human_decision' },
      }),
    ];
    expect(selectPolicyGates(rules, ctx())).toEqual([]);
  });

  it('按 priority 升序返回，与 evaluate 的首次命中顺序一致', () => {
    const gates = selectPolicyGates(BASELINE_POLICIES, ctx());
    expect(gates[0]?.name).toBe('执行付款需多人会签');
  });

  it('带上渲染好的人话解释，Agent 不需要自己读 AST', () => {
    const rules = [
      policy({
        name: '生产发布要批',
        condition: {
          all: [
            { fact: 'environment', op: 'eq', value: 'production' },
            { fact: 'operationType', op: 'eq', value: 'deploy' },
          ],
        },
        action: {
          type: 'require_human_review',
          assignee: { kind: 'role', role: 'release_manager' },
          dueInHours: 4,
        },
      }),
    ];

    const [gate] = selectPolicyGates(rules, ctx());
    expect(gate?.explanation).toContain('操作环境是生产');
    expect(gate?.explanation).toContain('发布负责人');
  });

  it('固定 fact 不匹配时整条 all 被排除', () => {
    const rules = [
      policy({
        name: '只管高风险任务',
        condition: {
          all: [
            { fact: 'riskLevel', op: 'gte', value: 'high' },
            { fact: 'operationType', op: 'eq', value: 'deploy' },
          ],
        },
        action: { type: 'pause', resumeCondition: 'human_decision' },
      }),
    ];

    expect(selectPolicyGates(rules, ctx({ riskLevel: 'low' }))).toEqual([]);
    expect(names(selectPolicyGates(rules, ctx({ riskLevel: 'critical' })))).toEqual([
      '只管高风险任务',
    ]);
  });
});
