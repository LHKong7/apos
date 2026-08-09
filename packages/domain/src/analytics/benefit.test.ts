import { describe, expect, it } from 'vitest';
import { computeBenefit } from './benefit';
import type { AnalyticsInput, RunRow } from './types';

const H = 3600_000;
const T0 = Date.parse('2026-08-01T00:00:00Z');

function run(over: Partial<RunRow> = {}): RunRow {
  return {
    id: `r-${Math.random().toString(36).slice(2, 7)}`,
    workItemId: 'i1',
    agentId: 'a1',
    attempt: 1,
    status: 'completed',
    cost: 1,
    startedAt: T0,
    endedAt: T0 + 2 * H,
    createdAt: T0,
    errorClass: null,
    model: null,
    tokensInput: 0,
    tokensOutput: 0,
    tokensCacheRead: 0,
    ...over,
  };
}

function input(runs: RunRow[], overrides: { itemId: string; at: number; category: null; reason: null }[] = []): AnalyticsInput {
  return {
    window: { from: T0 - 30 * 24 * H, to: T0 + 30 * 24 * H },
    items: [],
    changes: [],
    runs,
    decisions: [],
    agents: [],
    overrides,
    policyEvals: [],
    budget: null,
    costSpentTotal: 0,
  } as unknown as AnalyticsInput;
}

const ov = (n: number) =>
  Array.from({ length: n }, () => ({ itemId: 'i1', at: T0, category: null, reason: null }));

/**
 * 成本效益。
 *
 * 之前不做的理由是「硬编一个时薪算出来的数最像成果，也最经不起追问」。
 * 问题不在技术上，在于那个数字不可证伪 —— 所以基准改成用户自己填的输入，
 * 每一步换算都摊在明面上。
 */
describe('没有基准时不编数字', () => {
  /**
   * ★ 这是整块设计的核心：不替用户填一个时薪。
   *   编出来的「本月为你省了 $12,400」经不起一次追问。
   */
  it('★ 没填人力成本时不给结论，只给事实和一个待填的空', () => {
    const b = computeBenefit(input([run()]), { laborHourlyCost: null, currency: '$' });

    expect(b.hasBaseline).toBe(false);
    expect(b.net).toBeNull();
    expect(b.verdict).toContain('这个数只有你知道');
    expect(b.verdict).toContain('经不起一次追问');
    // 工时和花费仍然如实给出 —— 这两个是系统记的，不依赖任何假设
    expect(b.agentHours).toBe(2);
    expect(b.agentSpend).toBe(1);
  });

  it('没有基准时逐行的折算金额是 null，但工时照给', () => {
    const b = computeBenefit(input([run()]), { laborHourlyCost: null, currency: '$' });
    const line = b.lines.find((l) => l.key === 'agent_hours')!;
    expect(line.hours).toBe(2);
    expect(line.money).toBeNull();
  });
});

describe('填了基准之后', () => {
  it('结论里始终带上「按你填的 X/小时」', () => {
    const b = computeBenefit(input([run()]), { laborHourlyCost: 50, currency: '$' });
    expect(b.verdict).toContain('按你填的 $50/小时');
    expect(b.verdict).toContain('换个数就是另一个结论');
  });

  it('净收益 = 人力折算 − 人工覆盖折算 − Agent 花费', () => {
    // 2 小时 × $50 = 100；覆盖 4 次 = 1 小时 × $50 = 50；花费 $1
    const b = computeBenefit(input([run()], ov(4)), { laborHourlyCost: 50, currency: '$' });
    expect(b.net).toBe(100 - 50 - 1);
  });

  /**
   * ★ 只算「Agent 干了多少活」不算「人为此花了多少时间收拾」，
   *   得到的是一个营销数字。净投入的情况必须说得出来。
   */
  it('★ 代价大于收益时如实说「净投入」', () => {
    const b = computeBenefit(input([run({ cost: 500 })]), { laborHourlyCost: 10, currency: '$' });
    expect(b.net! < 0).toBe(true);
    expect(b.verdict).toContain('净投入');
  });
});

describe('工时口径', () => {
  /**
   * ★ 用实际执行时长，不用 estimatedHours。
   *   用估算值等于「计划说要 8 小时，所以省了 8 小时」——
   *   那是拿一个从没被验证过的数字当收益。
   */
  it('★ 只算成功执行的实际时长', () => {
    const b = computeBenefit(
      input([
        run({ status: 'completed', startedAt: T0, endedAt: T0 + 3 * H }),
        run({ status: 'failed', startedAt: T0, endedAt: T0 + 5 * H }),
      ]),
      { laborHourlyCost: 10, currency: '$' },
    );
    expect(b.agentHours).toBe(3);
  });

  it('没有时间戳的 Run 不参与工时', () => {
    const b = computeBenefit(
      input([run({ startedAt: null, endedAt: null })]),
      { laborHourlyCost: 10, currency: '$' },
    );
    expect(b.agentHours).toBe(0);
    expect(b.verdict).toContain('没有完成过执行');
  });

  /** ★ 返工是白干的，单列为代价而不是收益 */
  it('★ 返工时长单列为代价', () => {
    const b = computeBenefit(
      input([run({ attempt: 1 }), run({ attempt: 2, startedAt: T0, endedAt: T0 + H })]),
      { laborHourlyCost: 10, currency: '$' },
    );
    const rework = b.lines.find((l) => l.key === 'rework')!;
    expect(rework.side).toBe('cost');
    expect(rework.hours).toBe(1);
  });

  /** 假设必须写在明面上，否则它就是另一个不可证伪的数字 */
  it('★ 人工覆盖的耗时假设写在 basis 里', () => {
    const b = computeBenefit(input([run()], ov(2)), { laborHourlyCost: 10, currency: '$' });
    const line = b.lines.find((l) => l.key === 'human_override')!;
    expect(line.basis).toContain('每次 15 分钟');
    expect(line.basis).toContain('这是个假设，不是实测');
  });
});
