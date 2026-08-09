import { describe, expect, it } from 'vitest';
import type { AcceptanceCriterion } from '@apos/contracts';
import { deriveAcceptance } from './review';

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
    const r = deriveAcceptance([ac('AC1')], '- [AC1] 已完成');
    expect(r.criteria[0]?.verification).toBe('agent');
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
