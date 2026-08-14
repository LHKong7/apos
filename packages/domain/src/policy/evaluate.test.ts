import { describe, expect, it } from 'vitest';
import {
  AutonomyLevel,
  HIGH_RISK_OPERATIONS,
  NEVER_AUTO_APPROVE,
  type Policy,
  type PolicyContext,
} from '@apos/contracts';
import { BASELINE_POLICIES } from './baseline';
import { applyOperator, compile, evaluate, matchCondition } from './evaluate';

function ctx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    projectType: 'development',
    workItemType: 'task',
    riskLevel: 'low',
    reversible: true,
    externalFacing: false,
    environment: 'test',
    dataSensitivity: 'internal',
    impactTaskCount: 0,
    impactServices: [],
    operationType: 'code_change',
    agentType: 'code',
    agentConfidence: 0.9,
    agentSuccessRate: 0.92,
    consecutiveFailures: 0,
    runTokens: 2,
    projectTokensSpent: 50,
    projectTokenBudget: 500,
    budgetUsedPct: 10,
    testsResult: 'passed',
    testCoverage: 84,
    securityScan: 'passed',
    agentReview: 'passed',
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

describe('applyOperator', () => {
  it('数值比较', () => {
    expect(applyOperator('lt', 5, 10)).toBe(true);
    expect(applyOperator('gte', 10, 10)).toBe(true);
    expect(applyOperator('gt', 10, 10)).toBe(false);
  });

  it('类型不匹配时数值操作符返回 false 而不是抛异常', () => {
    expect(applyOperator('lt', 'abc', 10)).toBe(false);
    expect(applyOperator('gte', null, 3)).toBe(false);
  });

  it('集合操作符', () => {
    expect(applyOperator('in', 'db_ddl', ['db_ddl', 'db_dml'])).toBe(true);
    expect(applyOperator('not_in', 'deploy', ['db_ddl'])).toBe(true);
    expect(applyOperator('contains', ['a', 'b'], 'a')).toBe(true);
  });
});

describe('matchCondition', () => {
  it('all 全部满足才通过', () => {
    const cond = {
      all: [
        { fact: 'riskLevel' as const, op: 'eq' as const, value: 'low' },
        { fact: 'testsResult' as const, op: 'eq' as const, value: 'passed' },
      ],
    };
    expect(matchCondition(cond, ctx()).matched).toBe(true);
    expect(matchCondition(cond, ctx({ testsResult: 'failed' })).matched).toBe(false);
  });

  it('any 任一满足即通过', () => {
    const cond = {
      any: [
        { fact: 'riskLevel' as const, op: 'eq' as const, value: 'critical' },
        { fact: 'testsResult' as const, op: 'eq' as const, value: 'passed' },
      ],
    };
    expect(matchCondition(cond, ctx()).matched).toBe(true);
  });

  it('not 取反', () => {
    const cond = { not: { fact: 'riskLevel' as const, op: 'eq' as const, value: 'low' } };
    expect(matchCondition(cond, ctx()).matched).toBe(false);
    expect(matchCondition(cond, ctx({ riskLevel: 'high' })).matched).toBe(true);
  });

  it('★ 风险等级按序比较而非字典序', () => {
    // 字典序下 'high' < 'low'，会得到错误结果
    const cond = { fact: 'riskLevel' as const, op: 'gte' as const, value: 'high' };
    expect(matchCondition(cond, ctx({ riskLevel: 'critical' })).matched).toBe(true);
    expect(matchCondition(cond, ctx({ riskLevel: 'high' })).matched).toBe(true);
    expect(matchCondition(cond, ctx({ riskLevel: 'medium' })).matched).toBe(false);
    expect(matchCondition(cond, ctx({ riskLevel: 'low' })).matched).toBe(false);
  });

  it('未命中时记录失败的叶子条件', () => {
    const cond = {
      all: [
        { fact: 'riskLevel' as const, op: 'eq' as const, value: 'low' },
        { fact: 'runTokens' as const, op: 'lt' as const, value: 1 },
      ],
    };
    const r = matchCondition(cond, ctx({ runTokens: 8 }));
    expect(r.matched).toBe(false);
    if (!r.matched) {
      expect(r.failedAt?.fact).toBe('runTokens');
      expect(r.failedAt?.actual).toBe(8);
      expect(r.failedAt?.expected).toBe(1);
    }
  });
});

describe('evaluate — 优先级与首次命中', () => {
  it('按 priority 升序评估，首次命中即停止', () => {
    const rules = compile([
      policy({
        id: 'low-priority',
        priority: 200,
        condition: { fact: 'riskLevel', op: 'eq', value: 'low' },
        action: { type: 'allow' },
      }),
      policy({
        id: 'high-priority',
        priority: 10,
        condition: { fact: 'riskLevel', op: 'eq', value: 'low' },
        action: { type: 'deny', message: '拦截' },
      }),
    ]);

    const verdict = evaluate(ctx(), rules);
    expect(verdict.matchedPolicyId).toBe('high-priority');
    expect(verdict.action.type).toBe('deny');
    // 低优先级规则未被评估
    expect(verdict.trace).toHaveLength(1);
  });

  it('trace 记录所有已评估的规则，含未命中原因', () => {
    const rules = compile([
      policy({
        id: 'a',
        priority: 10,
        condition: { fact: 'environment', op: 'eq', value: 'production' },
        action: { type: 'deny', message: '' },
      }),
      policy({
        id: 'b',
        priority: 20,
        condition: { fact: 'riskLevel', op: 'eq', value: 'low' },
        action: { type: 'allow' },
      }),
    ]);

    const verdict = evaluate(ctx({ environment: 'test' }), rules);
    expect(verdict.trace).toHaveLength(2);
    expect(verdict.trace[0]?.matched).toBe(false);
    expect(verdict.trace[0]?.failedAt?.fact).toBe('environment');
    expect(verdict.trace[1]?.matched).toBe(true);
  });

  it('无规则命中时使用默认动作', () => {
    const verdict = evaluate(ctx(), []);
    expect(verdict.matchedPolicyId).toBeNull();
    expect(verdict.action.type).toBe('allow');
  });
});

describe('默认动作随自治等级变化（产品文档 8.9.4）', () => {
  it('human_led：一律需要人类审批', () => {
    const v = evaluate(ctx({ autonomyLevel: 'human_led', riskLevel: 'low' }), []);
    expect(v.action.type).toBe('require_human_review');
    expect(v.requiresHuman).toBe(true);
  });

  it('agent_led_approval：中低风险自动，高风险需批准', () => {
    expect(evaluate(ctx({ riskLevel: 'medium' }), []).action.type).toBe('allow');
    expect(evaluate(ctx({ riskLevel: 'high' }), []).action.type).toBe('require_human_review');
  });

  it('agent_autonomous：默认放行', () => {
    const v = evaluate(ctx({ autonomyLevel: 'agent_autonomous', riskLevel: 'high' }), []);
    expect(v.action.type).toBe('allow');
  });
});

describe('★ 安全底线 —— CI 阻断性测试', () => {
  const ADVERSARIAL_RULES: Policy[][] = [
    [],
    // 试图用最高优先级放行一切
    [
      policy({
        id: 'evil-1',
        priority: 1,
        condition: { all: [] },
        action: { type: 'allow' },
      }),
    ],
    // 试图针对具体高风险操作放行
    [
      policy({
        id: 'evil-2',
        priority: 1,
        condition: { fact: 'operationType', op: 'eq', value: 'payment' },
        action: { type: 'allow_and_notify', notify: [] },
      }),
      policy({
        id: 'evil-3',
        priority: 2,
        condition: { fact: 'operationType', op: 'eq', value: 'delete_resource' },
        action: { type: 'allow' },
      }),
      policy({
        id: 'evil-4',
        priority: 3,
        condition: { fact: 'operationType', op: 'eq', value: 'permission_change' },
        action: { type: 'allow' },
      }),
    ],
  ];

  it('NEVER_AUTO_APPROVE 的三类操作在任何配置下都不自动放行', () => {
    for (const op of NEVER_AUTO_APPROVE) {
      for (const autonomy of AutonomyLevel.options) {
        for (const rules of ADVERSARIAL_RULES) {
          const verdict = evaluate(
            ctx({ operationType: op, autonomyLevel: autonomy, riskLevel: 'low' }),
            compile(rules),
          );
          expect(
            verdict.action.type,
            `操作 ${op} / 自治等级 ${autonomy} 被自动放行了`,
          ).not.toBe('allow');
          expect(verdict.action.type).not.toBe('allow_and_notify');
          expect(verdict.requiresHuman).toBe(true);
        }
      }
    }
  });

  it('组织基线规则拦截全部九类高风险操作', () => {
    const rules = compile([
      ...BASELINE_POLICIES,
      // 项目级试图放行一切，但优先级 100+ 走不到
      policy({ id: 'proj-allow-all', priority: 100, condition: { all: [] }, action: { type: 'allow' } }),
    ]);

    for (const op of HIGH_RISK_OPERATIONS) {
      const environment = op === 'deploy' || op === 'db_ddl' || op === 'db_dml' ? 'production' : 'test';
      const dataSensitivity = op === 'access_sensitive_data' ? 'restricted' : 'internal';

      const verdict = evaluate(
        ctx({ operationType: op, environment, dataSensitivity, autonomyLevel: 'agent_autonomous' }),
        rules,
      );

      expect(verdict.requiresHuman, `高风险操作 ${op} 未被基线规则拦截`).toBe(true);
      expect(verdict.matchedPolicyId).toMatch(/^baseline-/);
    }
  });

  it('项目规则无法绕过组织基线：生产 DDL 永远需要 DBA', () => {
    const rules = compile([
      ...BASELINE_POLICIES,
      policy({
        id: 'proj-bypass',
        priority: 100,
        condition: { fact: 'operationType', op: 'eq', value: 'db_ddl' },
        action: { type: 'allow' },
      }),
    ]);

    const verdict = evaluate(ctx({ operationType: 'db_ddl', environment: 'production' }), rules);
    expect(verdict.matchedPolicyId).toBe('baseline-prod-db');
    expect(verdict.action).toMatchObject({
      type: 'require_human_review',
      assignee: { kind: 'role', role: 'dba' },
    });
  });

  it('非生产环境的 DDL 不被基线拦截（避免过度限制）', () => {
    const rules = compile(BASELINE_POLICIES);
    const verdict = evaluate(ctx({ operationType: 'db_ddl', environment: 'test' }), rules);
    expect(verdict.matchedPolicyId).toBeNull();
    expect(verdict.action.type).toBe('allow');
  });

  it('连续失败 3 次触发暂停升级', () => {
    const rules = compile(BASELINE_POLICIES);
    const verdict = evaluate(ctx({ consecutiveFailures: 3 }), rules);
    expect(verdict.matchedPolicyId).toBe('baseline-consecutive-failures');
    expect(verdict.action.type).toBe('pause');
  });

  it('预算用尽触发 Sponsor 审批', () => {
    const rules = compile(BASELINE_POLICIES);
    const verdict = evaluate(ctx({ budgetUsedPct: 105 }), rules);
    expect(verdict.matchedPolicyId).toBe('baseline-budget-exceeded');
  });
});

describe('产品文档 8.9.3 的示例规则', () => {
  const lowRiskAutoApprove = policy({
    id: 'low-risk',
    name: '低风险任务自动批准',
    priority: 100,
    condition: {
      all: [
        { fact: 'riskLevel', op: 'eq', value: 'low' },
        { fact: 'testsResult', op: 'eq', value: 'passed' },
        { fact: 'agentReview', op: 'eq', value: 'passed' },
        { fact: 'runTokens', op: 'lt', value: 10 },
      ],
    },
    action: { type: 'allow_and_notify', notify: [{ kind: 'project_role', role: 'pm' }] },
  });

  it('四个条件全满足时自动批准', () => {
    const v = evaluate(ctx({ runTokens: 8 }), compile([lowRiskAutoApprove]));
    expect(v.matchedPolicyId).toBe('low-risk');
    expect(v.requiresHuman).toBe(false);
  });

  it('成本超阈值则不命中，回落到默认动作', () => {
    const v = evaluate(ctx({ runTokens: 12 }), compile([lowRiskAutoApprove]));
    expect(v.matchedPolicyId).toBeNull();
    expect(v.trace[0]?.failedAt?.fact).toBe('runTokens');
  });
});

describe('枚举序号化', () => {
  /**
   * ★ riskLevel 会被换成序号，好让 `>= 'high'` 这类比较成立。
   *   数组不跟着换的话，`riskLevel in ['medium','high']` 里
   *   actual 是数字、expected 还是字符串数组，includes 恒为 false ——
   *   规则在界面上看着完全正确、保存也不报错，却**永远不会命中**。
   *   一条以为在保护自己的治理规则实际是死的，比没有这条规则更危险。
   */
  it('★ riskLevel 用 in 比较时，数组里的每一项也要序号化', () => {
    const c = ctx({ riskLevel: 'medium' });

    expect(matchCondition({ fact: 'riskLevel', op: 'in', value: ['medium', 'high'] }, c).matched).toBe(true);
    expect(matchCondition({ fact: 'riskLevel', op: 'in', value: ['low'] }, c).matched).toBe(false);
    expect(matchCondition({ fact: 'riskLevel', op: 'not_in', value: ['low', 'medium'] }, c).matched).toBe(false);
  });

  it('不需要序号化的 fact 用 in 比较不受影响', () => {
    const c = ctx({ environment: 'production' });
    expect(matchCondition({ fact: 'environment', op: 'in', value: ['staging', 'production'] }, c).matched).toBe(true);
  });
});
