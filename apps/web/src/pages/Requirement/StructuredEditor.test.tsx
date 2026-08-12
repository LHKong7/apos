import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StructuredEditor } from './StructuredEditor';
import type { RequirementDetail } from '../../lib/api/types';

/**
 * 人工填写结构化需求（需求页 → 结构化需求 → 自己填写 / 人工修改）。
 *
 * ★ 这一组盯的是「人工提交的东西和 AI 产出是不是同一种形状」。
 *   不是的话，问题不会出现在这一页 —— 它会出现在几小时后的 Review 阶段，
 *   表现成一条永远没人核验的验收标准。
 */

function requirement(over: Partial<RequirementDetail['requirement']> = {}) {
  return {
    id: 'r1',
    projectId: 'p1',
    status: 'draft',
    rawInput: '订单查询太慢',
    title: null,
    businessContext: null,
    userProblem: null,
    businessGoal: null,
    userStories: [],
    scope: {},
    nonFunctional: [],
    risks: [],
    acceptanceCriteria: [],
    completeness: {},
    fieldProvenance: {},
    analysisModel: null,
    priority: 'medium',
    rejectReason: null,
    approvedAt: null,
    ...over,
  } as RequirementDetail['requirement'];
}

describe('人工填写结构化需求', () => {
  it('把一份手填的需求按结构提交，列表字段按行拆开', async () => {
    const onSave = vi.fn();
    render(
      <StructuredEditor
        requirement={requirement()}
        saving={false}
        error={null}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );

    await userEvent.type(screen.getByPlaceholderText('一句话说清要做什么'), '订单查询优化');
    await userEvent.type(screen.getByLabelText(/^做什么/), '按手机号搜索\n按时间段搜索');
    await userEvent.type(screen.getByLabelText(/^不做什么/), '历史数据迁移');
    await userEvent.type(screen.getByLabelText(/^潜在风险/), '涉及生产库索引变更');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const patch = onSave.mock.calls[0]![0];
    expect(patch.title).toBe('订单查询优化');
    expect(patch.scope).toEqual({
      inScope: ['按手机号搜索', '按时间段搜索'],
      outOfScope: ['历史数据迁移'],
    });
    // ★ 需求上的风险是字符串数组 —— 规划器直接对它做 includes
    expect(patch.risks).toEqual(['涉及生产库索引变更']);
  });

  it('新加的验收标准默认人工核验，并跟着提交', async () => {
    const onSave = vi.fn();
    render(
      <StructuredEditor
        requirement={requirement()}
        saving={false}
        error={null}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: '+ 加一条' }));
    await userEvent.type(screen.getByPlaceholderText(/按手机号搜索/), '搜索 P95 < 500ms');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    /**
     * ★ 默认 human 而不是 auto：平台没有依据认定一条手写文本能被自动核验，
     *   默认成 auto 等于替用户许了一个他没许的承诺。
     */
    expect(onSave.mock.calls[0]![0].acceptanceCriteria).toEqual([
      { text: '搜索 P95 < 500ms', verification: 'human' },
    ]);
  });

  /**
   * ★★ AI 判定为 auto 的标准，被人改一个错别字之后不能降级成人工核验 ——
   *   否则 Review 阶段会凭空多出一堆等人点的活，而没人知道是哪一步带来的。
   */
  it('改动已有标准时保留原来的核验方式与 id', async () => {
    const onSave = vi.fn();
    render(
      <StructuredEditor
        requirement={requirement({
          acceptanceCriteria: [
            { id: 'ac-1', text: '单测覆盖率 80%', verification: 'auto' } as never,
          ],
        })}
        saving={false}
        error={null}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );

    await userEvent.type(screen.getByDisplayValue('单测覆盖率 80%'), '以上');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(onSave.mock.calls[0]![0].acceptanceCriteria).toEqual([
      { id: 'ac-1', text: '单测覆盖率 80%以上', verification: 'auto' },
    ]);
  });

  /** 空行不提交：服务端会拒掉空文本，而那条报错对用户毫无意义 */
  it('删掉的与留空的标准不会被提交', async () => {
    const onSave = vi.fn();
    render(
      <StructuredEditor
        requirement={requirement({
          acceptanceCriteria: [{ id: 'ac-1', text: '保留这条', verification: 'human' } as never],
        })}
        saving={false}
        error={null}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: '+ 加一条' }));
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(onSave.mock.calls[0]![0].acceptanceCriteria).toEqual([
      { id: 'ac-1', text: '保留这条', verification: 'human' },
    ]);
  });

  it('认不出来的核验方式落到人工，不静默当成自动', async () => {
    const onSave = vi.fn();
    render(
      <StructuredEditor
        requirement={requirement({
          acceptanceCriteria: [{ id: 'ac-1', text: 'x', verification: 'CI 跑过' } as never],
        })}
        saving={false}
        error={null}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSave.mock.calls[0]![0].acceptanceCriteria[0].verification).toBe('human');
  });
});
