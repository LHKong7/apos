import { describe, expect, it } from 'vitest';
import type { Policy, PolicyContext } from '@apos/contracts';
import { requiredFacts, simulate, type HistoricalSample } from './simulate';

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
    runCost: 2,
    projectCostSpent: 50,
    projectBudget: 500,
    budgetUsedPct: 10,
    testsResult: 'passed',
    testCoverage: 84,
    securityScan: 'passed',
    agentReview: 'passed',
    autonomyLevel: 'agent_led_approval',
    ...overrides,
  };
}

function sample(
  id: string,
  overrides: Partial<PolicyContext>,
  humanDecision: HistoricalSample['humanDecision'] = 'approved',
  note: string | null = null,
): HistoricalSample {
  return {
    eventId: id,
    // 每个样本一个独立任务 —— 需要「同一任务多次评估」时在用例里显式覆盖
    workItemId: `item-${id}`,
    occurredAt: '2026-08-01T10:00:00.000Z',
    context: ctx(overrides),
    humanDecision,
    humanNote: note,
    workItemTitle: `任务 ${id}`,
  };
}

const draft: Pick<Policy, 'condition' | 'action'> = {
  condition: {
    all: [
      { fact: 'riskLevel', op: 'eq', value: 'low' },
      { fact: 'testsResult', op: 'eq', value: 'passed' },
    ],
  },
  action: { type: 'allow_and_notify', notify: [] },
};

describe('requiredFacts', () => {
  it('提取嵌套条件中的全部 fact', () => {
    const facts = requiredFacts({
      all: [
        { fact: 'riskLevel', op: 'eq', value: 'low' },
        {
          any: [
            { fact: 'runCost', op: 'lt', value: 10 },
            { not: { fact: 'environment', op: 'eq', value: 'production' } },
          ],
        },
      ],
    });
    expect(new Set(facts)).toEqual(new Set(['riskLevel', 'runCost', 'environment']));
  });
});

describe('simulate', () => {
  it('统计会被自动处理的样本数', () => {
    const samples = [
      sample('1', {}),
      sample('2', {}),
      sample('3', { riskLevel: 'high' }),
      sample('4', { testsResult: 'failed' }),
    ];
    const result = simulate(draft, samples);
    expect(result.totalSamples).toBe(4);
    expect(result.wouldAutoHandle).toBe(2);
  });

  it('★ 找出「规则会自动放行但人类当时驳回」的案例', () => {
    const samples = [
      sample('1', {}),
      sample('2', {}, 'rejected', '需法务确认'),
      sample('3', {}, 'revision_requested', '影响外部调用'),
    ];
    const result = simulate(draft, samples);

    expect(result.wouldAutoHandle).toBe(3);
    expect(result.mismatches).toHaveLength(2);
    expect(result.mismatches[0]?.humanNote).toBe('需法务确认');
  });

  it('非自动放行的规则不产生 mismatch（人类本来就要参与）', () => {
    const strictDraft: Pick<Policy, 'condition' | 'action'> = {
      condition: draft.condition,
      action: { type: 'require_human_review', assignee: { kind: 'role', role: 'dba' }, dueInHours: 4 },
    };
    const result = simulate(strictDraft, [sample('1', {}, 'rejected')]);
    expect(result.mismatches).toHaveLength(0);
  });

  it('★ 从不一致案例推导条件补充建议', () => {
    // 三个被驳回的案例都是 send_external，其余通过的都不是
    const samples = [
      ...Array.from({ length: 10 }, (_, i) => sample(`ok-${i}`, { operationType: 'code_change' })),
      sample('bad-1', { operationType: 'send_external' }, 'rejected'),
      sample('bad-2', { operationType: 'send_external' }, 'rejected'),
      sample('bad-3', { operationType: 'send_external' }, 'rejected'),
    ];

    const result = simulate(draft, samples);
    expect(result.mismatches).toHaveLength(3);

    const suggestion = result.suggestions[0];
    expect(suggestion?.addCondition.fact).toBe('operationType');
    expect(suggestion?.addCondition.value).toBe('send_external');
    expect(suggestion?.wouldEliminate).toBe(3);
  });

  it('模式不集中时不给建议（避免噪声）', () => {
    const samples = [
      ...Array.from({ length: 10 }, (_, i) => sample(`ok-${i}`, {})),
      sample('bad-1', { operationType: 'send_external' }, 'rejected'),
      sample('bad-2', { operationType: 'deploy' }, 'rejected'),
      sample('bad-3', { operationType: 'db_dml' }, 'rejected'),
    ];
    expect(simulate(draft, samples).suggestions).toHaveLength(0);
  });

  it('已在条件中的 fact 不再被建议', () => {
    const samples = [
      ...Array.from({ length: 10 }, (_, i) => sample(`ok-${i}`, {})),
      sample('bad-1', {}, 'rejected'),
    ];
    const result = simulate(draft, samples);
    expect(result.suggestions.every((s) => s.addCondition.fact !== 'riskLevel')).toBe(true);
  });
});

describe('★ 模拟的诚实性 —— 必须告知局限', () => {
  it('样本量小时给出警示', () => {
    const result = simulate(draft, [sample('1', {}), sample('2', {})]);
    expect(result.caveats.some((c) => c.includes('样本量较小'))).toBe(true);
    expect(result.confidence).toBe('low');
  });

  it('缺少 fact 的样本被跳过并计数', () => {
    const bad = sample('1', {});
    // 模拟历史快照中缺少某个后来才引入的 fact
    delete (bad.context as Record<string, unknown>)['agentConfidence'];

    const draftWithNewFact: Pick<Policy, 'condition' | 'action'> = {
      condition: { fact: 'agentConfidence', op: 'gte', value: 0.8 },
      action: { type: 'allow' },
    };

    const result = simulate(draftWithNewFact, [bad, sample('2', {})]);
    expect(result.skippedForMissingFacts).toBe(1);
    expect(result.caveats.some((c) => c.includes('缺少条件所需数据'))).toBe(true);
  });

  it('超过半数样本无法评估时明确说明结果不可用', () => {
    const missing = Array.from({ length: 8 }, (_, i) => {
      const s = sample(`m-${i}`, {});
      delete (s.context as Record<string, unknown>)['agentConfidence'];
      return s;
    });
    const draftWithNewFact: Pick<Policy, 'condition' | 'action'> = {
      condition: { fact: 'agentConfidence', op: 'gte', value: 0.8 },
      action: { type: 'allow' },
    };

    const result = simulate(draftWithNewFact, [...missing, sample('ok', {})]);
    expect(result.caveats.some((c) => c.includes('不足以作为决策依据'))).toBe(true);
  });

  it('零不一致但样本少时不宣称无风险', () => {
    const result = simulate(draft, Array.from({ length: 5 }, (_, i) => sample(`${i}`, {})));
    expect(result.mismatches).toHaveLength(0);
    expect(result.caveats.some((c) => c.includes('不足以证明无风险'))).toBe(true);
  });

  it('样本充足且缺失少时置信度为 high', () => {
    const samples = Array.from({ length: 60 }, (_, i) => sample(`${i}`, {}));
    expect(simulate(draft, samples).confidence).toBe('high');
  });
});

describe('不一致案例去重', () => {
  /**
   * ★ 一个任务在生命周期里会被评估很多次，每次都产生一个样本。
   *   不去重的话「发现 10 处不一致」实际只是 4 个任务被数了两三遍 ——
   *   用户点进去发现同一张卡片出现三次，就再也不信这个数字了。
   */
  it('★ 同一个任务的多次评估只算一处不一致', () => {
    const samples: HistoricalSample[] = [
      { ...sample('e1', { riskLevel: 'low' }, 'rejected'), workItemId: 'item-a' },
      { ...sample('e2', { riskLevel: 'low' }, 'rejected'), workItemId: 'item-a' },
      { ...sample('e3', { riskLevel: 'low' }, 'rejected'), workItemId: 'item-b' },
    ];

    const result = simulate(
      { condition: { fact: 'riskLevel', op: 'eq', value: 'low' }, action: { type: 'allow' } },
      samples,
    );

    expect(result.mismatches).toHaveLength(2);
    expect(result.mismatches.map((m) => m.workItemId).sort()).toEqual(['item-a', 'item-b']);
    // 原始次数仍然如实给出，两个数字的口径不同，页面各用各的
    expect(result.mismatchEvaluations).toBe(3);
  });
});
