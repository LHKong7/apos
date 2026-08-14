import { describe, expect, it } from 'vitest';
import { FACT_KEYS, Operator, type Action, type Condition } from '@apos/contracts';
import { BASELINE_POLICIES } from './baseline';
import { explainAction, explainCondition, explainPolicy, FACT_LABELS } from './explain';

describe('模板覆盖度', () => {
  it('每个 fact 都有中文标签', () => {
    for (const fact of FACT_KEYS) {
      expect(FACT_LABELS[fact], `${fact} 缺少标签`).toBeTruthy();
    }
  });

  it('每个操作符都能生成解释，不出现 undefined', () => {
    for (const op of Operator.options) {
      const text = explainCondition({ fact: 'riskLevel', op, value: 'low' });
      expect(text).not.toContain('undefined');
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it('每种动作都能生成解释', () => {
    const actions: Action[] = [
      { type: 'allow' },
      { type: 'allow_and_notify', notify: [{ kind: 'project_role', role: 'pm' }] },
      { type: 'require_agent_review', agents: ['review-agent'] },
      {
        type: 'require_human_review',
        assignee: { kind: 'role', role: 'dba' },
        dueInHours: 4,
      },
      {
        type: 'require_multiple_approvals',
        approvers: [{ kind: 'role', role: 'dba' }],
        mode: 'all',
        dueInHours: 8,
      },
      { type: 'ask', assignee: { kind: 'project_role', role: 'tech_lead' } },
      { type: 'pause', resumeCondition: 'human_decision' },
      { type: 'deny', message: '不允许' },
      { type: 'escalate', to: { kind: 'project_role', role: 'sponsor' } },
      { type: 'transfer_to_human', assignee: { kind: 'owner_of', subject: 'work_item' } },
    ];

    for (const action of actions) {
      const text = explainAction(action);
      expect(text, `${action.type} 解释为空`).toBeTruthy();
      expect(text).not.toContain('undefined');
    }
  });

  it('全部组织基线规则都能生成可读解释', () => {
    for (const p of BASELINE_POLICIES) {
      const text = explainPolicy(p.condition, p.action);
      expect(text, `${p.name} 解释异常`).not.toContain('undefined');
      expect(text.startsWith('当')).toBe(true);
      expect(text.endsWith('。')).toBe(true);
    }
  });
});

describe('解释内容', () => {
  it('产品文档 8.9.3 的低风险规则', () => {
    const condition: Condition = {
      all: [
        { fact: 'riskLevel', op: 'eq', value: 'low' },
        { fact: 'testsResult', op: 'eq', value: 'passed' },
        { fact: 'agentReview', op: 'eq', value: 'passed' },
        { fact: 'runTokens', op: 'lt', value: 200_000 },
      ],
    };
    const action: Action = {
      type: 'allow_and_notify',
      notify: [{ kind: 'project_role', role: 'pm' }],
    };

    expect(explainPolicy(condition, action)).toBe(
      '当风险等级是低、且自动测试结果是通过、且 Review Agent 结论是通过、且本次执行 token 用量低于 200k token 时，' +
        '系统会自动批准，并通知项目负责人。你不需要手动审批。',
    );
  });

  it('生产数据库规则', () => {
    const p = BASELINE_POLICIES.find((x) => x.id === 'baseline-prod-db')!;
    expect(explainPolicy(p.condition, p.action)).toBe(
      '当操作环境是生产、且操作类型属于数据库结构变更、数据库数据变更之一时，' +
        '系统会暂停并请 DBA 审批，需在 4 小时内处理。',
    );
  });

  it('用量类 fact 用 token 缩写，百分比类用 %', () => {
    expect(explainCondition({ fact: 'runTokens', op: 'lt', value: 200_000 })).toContain('200k token');
    expect(explainCondition({ fact: 'budgetUsedPct', op: 'gte', value: 100 })).toContain('100%');
    expect(explainCondition({ fact: 'agentConfidence', op: 'gte', value: 0.8 })).toContain('80%');
  });

  it('any 与 not 的嵌套解释可读', () => {
    const cond: Condition = {
      any: [
        { fact: 'environment', op: 'eq', value: 'production' },
        { not: { fact: 'reversible', op: 'eq', value: true } },
      ],
    };
    const text = explainCondition(cond);
    expect(text).toContain('满足以下任一条件');
    expect(text).toContain('不满足');
  });

  it('空 all 条件解释为「任何情况」而不是空字符串', () => {
    expect(explainCondition({ all: [] })).toBe('任何情况');
  });
});
