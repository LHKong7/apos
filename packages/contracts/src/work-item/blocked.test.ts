import { describe, expect, it } from 'vitest';
import { FIX_FOR_CODE, RejectionCode, sameBlockedDetail, type BlockedDetail } from './blocked';

const detail = (over: Partial<BlockedDetail> = {}): BlockedDetail => ({
  kind: 'no_matching_agent',
  candidates: [
    { agentId: 'a1', agentName: 'coder', code: 'not_project_member', scope: 'project' },
    { agentId: 'a2', agentName: 'tester', code: 'agent_inactive', scope: 'org', params: { status: 'retired' } },
  ],
  detail: null,
  ...over,
});

describe('阻塞细节', () => {
  /**
   * ★★ 这个判等是调度器不再刷屏的唯一依据。它一旦变松，Timeline 会重新
   *   堆出几十条一模一样的 blocked 事件；变紧则 `blockedSince` 每轮被重置，
   *   卡片上的阻塞时长永远显示 0m。两个方向都要有断言压着。
   */
  it('同一批候选、同一批原因 → 视为同一件事', () => {
    expect(sameBlockedDetail(detail(), detail())).toBe(true);
  });

  it('★ 候选顺序不算差异 —— 那取决于查询计划，不是语义', () => {
    const reordered = detail({ candidates: [...detail().candidates].reverse() });
    expect(sameBlockedDetail(detail(), reordered)).toBe(true);
  });

  it('★ 原因变了就是另一件事，必须重新记一条', () => {
    const changed = detail({
      candidates: [
        { agentId: 'a1', agentName: 'coder', code: 'missing_tools', scope: 'project' },
        detail().candidates[1]!,
      ],
    });
    expect(sameBlockedDetail(detail(), changed)).toBe(false);
  });

  it('★ 插值参数变了也算变 —— 「还剩 3 个额度」和「用完了」不是一回事', () => {
    const changed = detail({
      candidates: [
        detail().candidates[0]!,
        { agentId: 'a2', agentName: 'tester', code: 'agent_inactive', scope: 'org', params: { status: 'paused' } },
      ],
    });
    expect(sameBlockedDetail(detail(), changed)).toBe(false);
  });

  it('候选数量变了、大类变了、兜底句变了，都算变', () => {
    expect(sameBlockedDetail(detail(), detail({ candidates: [detail().candidates[0]!] }))).toBe(false);
    expect(sameBlockedDetail(detail(), detail({ kind: 'no_agents_in_project' }))).toBe(false);
    expect(sameBlockedDetail(detail(), detail({ detail: '工作区挂不上' }))).toBe(false);
  });

  /** ★ 没有旧记录时一律「不同」—— 否则首次阻塞不会被记下来 */
  it('★ 缺任何一侧都判不同', () => {
    expect(sameBlockedDetail(null, detail())).toBe(false);
    expect(sameBlockedDetail(detail(), null)).toBe(false);
  });

  /**
   * ★★ 每个原因码都要有修复入口的说法（含「没得修」）。
   *   漏一个的表现是界面上那条原因静默地不给按钮，而用户无从知道
   *   到底是「不用修」还是「忘了做」。
   */
  it('★ 每个原因码都在修复入口表里', () => {
    for (const code of RejectionCode.options) {
      expect(FIX_FOR_CODE[code]).toBeTruthy();
    }
  });
});
