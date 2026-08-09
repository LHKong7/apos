import { describe, expect, it } from 'vitest';
import { batchDenyReason, isBatchable } from './batch';

const base = { canAct: true, reversible: true, riskLevel: 'low' };

describe('批量批准资格', () => {
  it('低风险且可逆的可以批量', () => {
    expect(isBatchable(base)).toBe(true);
    expect(isBatchable({ ...base, riskLevel: 'medium' })).toBe(true);
  });

  /**
   * ★ 这三条是安全底线：批量的价值在于省掉重复点击，不在于省掉阅读。
   *   放宽任何一条，「全选」就变成了可以一次性批掉生产事故的按钮。
   */
  it('★ 不可逆的一律不能批量', () => {
    expect(isBatchable({ ...base, reversible: false })).toBe(false);
  });

  it('★ 高风险与极高风险一律不能批量', () => {
    for (const riskLevel of ['high', 'critical']) {
      expect(isBatchable({ ...base, riskLevel }), riskLevel).toBe(false);
    }
  });

  it('★ 无处置权的不能批量（责任不可代行）', () => {
    expect(isBatchable({ ...base, canAct: false })).toBe(false);
  });

  it('拒绝时说清楚是哪一条挡的', () => {
    expect(batchDenyReason(base)).toBeNull();
    expect(batchDenyReason({ ...base, canAct: false })).toMatch(/不可代行/);
    expect(batchDenyReason({ ...base, reversible: false })).toMatch(/不可逆/);
    expect(batchDenyReason({ ...base, riskLevel: 'high' })).toMatch(/高风险/);
    expect(batchDenyReason({ ...base, riskLevel: 'critical' })).toMatch(/极高/);
  });

  it('★ 不可逆优先于风险等级报出来 —— 它更不可挽回', () => {
    expect(batchDenyReason({ canAct: true, reversible: false, riskLevel: 'critical' })).toMatch(
      /不可逆/,
    );
  });
});
