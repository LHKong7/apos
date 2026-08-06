import { describe, expect, it } from 'vitest';
import { evaluateDrop } from './KanbanView';
import { card } from '../../test/fixtures';

/**
 * 拖拽合法性。
 *
 * 前端判定只为体验 —— 但如果它比后端宽松，用户会拖成功再被 409 打回，
 * 比不让拖更糟。所以规则必须同源于 WORK_ITEM_MACHINE。
 */
describe('拖拽落点判定', () => {
  it('允许 reviewing → Release（审核通过）', () => {
    const r = evaluateDrop(card({ status: 'reviewing', stage: 'review' }), 'release');
    expect(r.allowed).toBe(true);
  });

  /**
   * 手写 status → trigger 表时这条走不通：ready 被写死成 retry_requested，
   * 而返工重新开始用的是 rework_started。落点必须由状态机推导。
   */
  it('★ 允许 changes_requested → Execution（返工重新开始）', () => {
    const r = evaluateDrop(card({ status: 'changes_requested', stage: 'review' }), 'execution');
    expect(r.allowed).toBe(true);
  });

  it('拒绝不符合状态机的落点，并用中文状态名说明原因', () => {
    const r = evaluateDrop(card({ status: 'ready', stage: 'execution' }), 'release');
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('待执行');
    expect(r.reason).toContain('不能直接进入');
  });

  it('★ 依赖未满足时不许进入 Execution，原因写清楚有几个依赖', () => {
    const r = evaluateDrop(
      card({ status: 'changes_requested', stage: 'review', unmetDependencies: 2 }),
      'execution',
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('2 个前置依赖未完成');
  });

  it('拖回原列没有意义', () => {
    const r = evaluateDrop(card({ stage: 'execution' }), 'execution');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('已经在这一列了');
  });

  it('Intake / Planning 不接受手动拖入 —— 后端没有对应 trigger', () => {
    expect(evaluateDrop(card(), 'intake').allowed).toBe(false);
    expect(evaluateDrop(card(), 'planning').allowed).toBe(false);
  });
});
