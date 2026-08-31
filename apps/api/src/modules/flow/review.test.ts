import { describe, expect, it } from 'vitest';
import type { AcceptanceCriterion } from '@apos/contracts';
import { deriveAcceptance, sameQualityCheck } from './review';

function ac(id: string, text = '要求'): AcceptanceCriterion {
  return { id, text, status: 'pending', verification: 'agent', evidenceRef: null, verifiedAt: null };
}

describe('验收标准自评解析', () => {
  it('按 ID 逐条读出通过与未通过', () => {
    const r = deriveAcceptance([ac('AC1'), ac('AC2')], ['- [AC1] 已完成，会话有效期改为 30 分钟', '- [AC2] 未满足：缺少配置项'].join('\n'));

    expect(r.passed).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.criteria.find((c) => c.id === 'AC1')?.status).toBe('passed');
    expect(r.criteria.find((c) => c.id === 'AC2')?.status).toBe('failed');
  });

  /**
   * ★ 报告里没提到的标准算 unclear，不算通过。
   *   默认通过的话，一个什么都没写的报告会让所有验收标准自动变绿。
   */
  it('报告没提到的标准算「无法确认」而不是通过', () => {
    const r = deriveAcceptance([ac('AC1'), ac('AC2')], '- [AC1] 已完成');
    expect(r.passed).toBe(1);
    expect(r.unclear).toBe(1);
    expect(r.failed).toBe(0);
  });

  it('空报告时全部无法确认', () => {
    const r = deriveAcceptance([ac('AC1'), ac('AC2')], null);
    expect(r.unclear).toBe(2);
    expect(r.passed).toBe(0);
  });

  /**
   * ★ 「基本满足，但边界情况未处理」两边都能匹配上。
   *   判成 passed 是危险的 —— 这正是需要人看一眼的那类句子。
   */
  it('同时出现肯定与否定措辞时判为无法确认，不乐观取值', () => {
    const r = deriveAcceptance([ac('AC1')], '- [AC1] 主流程已满足，但边界情况未完成');
    expect(r.passed).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.unclear).toBe(1);
  });

  it('自评结果标注 verification=agent，不冒充独立验证', () => {
    const r = deriveAcceptance([ac('AC1')], '- [AC1] 已完成', 'agent-run:run-1');
    expect(r.criteria[0]?.verification).toBe('agent');
    expect(r.criteria[0]?.evidenceRef).toBe('agent-run:run-1');
    expect(r.criteria[0]?.verifiedAt).toBeTruthy();
  });

  it('报告不再包含某条标准时清除陈旧证据并恢复 pending', () => {
    const previouslyPassed: AcceptanceCriterion = {
      ...ac('AC1'),
      status: 'passed',
      evidenceRef: 'agent-run:old',
      verifiedAt: new Date().toISOString(),
    };
    const r = deriveAcceptance([previouslyPassed], '只提到了 AC2', 'agent-run:new');
    expect(r.changed).toBe(true);
    expect(r.criteria[0]).toMatchObject({
      status: 'pending',
      evidenceRef: null,
      verifiedAt: null,
    });
  });

  it('人已确认过的条目不被 Agent 自评覆盖', () => {
    const human: AcceptanceCriterion = {
      id: 'AC1',
      text: '要求',
      status: 'passed',
      verification: 'human',
      evidenceRef: null,
      verifiedAt: null,
    };
    const r = deriveAcceptance([human], '- [AC1] 未满足');
    expect(r.criteria[0]?.status).toBe('passed');
    expect(r.failed).toBe(0);
  });

  it('英文报告同样可解析', () => {
    const r = deriveAcceptance([ac('AC1'), ac('AC2')], ['AC1: passed', 'AC2: failed - missing migration'].join('\n'));
    expect(r.passed).toBe(1);
    expect(r.failed).toBe(1);
  });

  it('没有验收标准时不产生任何判断', () => {
    const r = deriveAcceptance([], '随便什么内容');
    expect(r.passed + r.failed + r.unclear).toBe(0);
    expect(r.changed).toBe(false);
  });
});

/**
 * ★★ 评审循环每 20 秒把同一批 reviewing 任务重判一遍，而判据在人来处理之前
 *   通常一动不动。这组用例锁的是 CLAUDE.md 里那条通用要求：
 *   「定时循环写库前先问一句变了吗」——「没变 → 不写第二条事件」
 *   与「变了 → 记一条」两个方向都要断言，只测其中一边的话，
 *   一个恒等于 false 的比较函数照样能通过。
 *
 * The review loop re-derives the same verdict every 20s; these lock down both
 * directions of the "did anything change?" check.
 */
describe('评审判据的变更检测', () => {
  const facts = {
    testsRan: true,
    testsPassed: true,
    testCommand: 'pnpm test',
    acceptance: { passed: 2, failed: 0, unclear: 1 },
    autonomy: 'agent_autonomous',
  };

  it('判据没变时认作相同 —— 不再写第二条 quality_checked', () => {
    expect(sameQualityCheck({ ...facts }, facts)).toBe(true);
  });

  it('核验结果翻转时认作不同', () => {
    expect(sameQualityCheck({ ...facts, testsPassed: false }, facts)).toBe(false);
  });

  it('验收自评的任一计数变化都认作不同', () => {
    expect(
      sameQualityCheck({ ...facts, acceptance: { passed: 3, failed: 0, unclear: 0 } }, facts),
    ).toBe(false);
  });

  it('自治等级改了也认作不同 —— 同一批判据在新等级下结论可能相反', () => {
    expect(sameQualityCheck({ ...facts, autonomy: 'human_led' }, facts)).toBe(false);
  });

  /** ★ 第一次评审这一栏还不存在，必须当作「变了」，否则首条事件就丢了 */
  it('从未记录过时认作不同', () => {
    expect(sameQualityCheck(undefined, facts)).toBe(false);
    expect(sameQualityCheck(null, facts)).toBe(false);
  });

  /**
   * ★★ 存进去的那份是从 jsonb 列读回来的，而 jsonb 不保留键序。
   *   直接 JSON.stringify 两边比的话，内容一模一样的判据也会判成「变了」,
   *   于是这道闸门一次都拦不住，事件照旧每轮一条 —— 而单测里两边都是
   *   手写字面量、键序天然一致，正是最容易漏掉的那种。
   *
   * The stored copy comes back from jsonb, which reorders keys; comparison
   * has to be canonical or the guard silently never fires.
   */
  it('键序不同但内容相同，仍认作相同（jsonb 读回来就是这样）', () => {
    const reordered = {
      autonomy: facts.autonomy,
      acceptance: { unclear: 1, failed: 0, passed: 2 },
      testCommand: facts.testCommand,
      testsPassed: facts.testsPassed,
      testsRan: facts.testsRan,
    };
    expect(sameQualityCheck(reordered, facts)).toBe(true);
  });
});
