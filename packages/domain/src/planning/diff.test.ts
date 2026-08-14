import { describe, expect, it } from 'vitest';
import { diffPlans, type PlanSide, type PlanTaskSide } from './diff';

function task(title: string, over: Partial<PlanTaskSide> = {}): PlanTaskSide {
  return {
    title,
    type: 'task',
    riskLevel: 'low',
    estimatedHours: 4,
    estimatedTokens: 2,
    requiresHuman: false,
    ...over,
  };
}

function plan(over: Partial<PlanSide> = {}): PlanSide {
  return {
    version: 1,
    status: 'awaiting_approval',
    createdAt: '2026-08-01T00:00:00Z',
    estimatedHours: 8,
    estimatedTokens: 4,
    tasks: [task('服务端实现'), task('单元测试')],
    autoActions: [{ title: '服务端实现' }],
    humanGates: [{ taskTitle: '发布到生产环境' }],
    risks: [],
    ...over,
  };
}

/**
 * 计划版本对比（页面文档 04）。
 *
 * 用户要批准的是 v2，脑子里记得的是 v1。不给 diff 的话他只能整个重读一遍 ——
 * 而重读一遍的真实结果通常是不读，直接批。
 */
describe('自动化边界的变化排在最前', () => {
  /**
   * ★ 这是唯一一类「不看就会漏掉、漏掉就出事」的变化。
   *   其余变化最坏是计划不如预期，这一类最坏是批准了自己不知道的自动化。
   */
  it('★ v2 新增的自动化动作被单独拎出来并标为放宽', () => {
    const before = plan();
    const after = plan({
      version: 2,
      autoActions: [{ title: '服务端实现' }, { title: '发布到生产环境' }],
    });

    const d = diffPlans(before, after);
    expect(d.boundary.autoAdded).toEqual(['发布到生产环境']);
    expect(d.boundary.loosened).toBe(true);
  });

  it('★ 原本要人确认、现在不用了 —— 也是放宽', () => {
    const before = plan({ tasks: [task('数据库变更', { requiresHuman: true })], humanGates: [{ taskTitle: '数据库变更' }] });
    const after = plan({
      version: 2,
      tasks: [task('数据库变更', { requiresHuman: false })],
      humanGates: [],
    });

    const d = diffPlans(before, after);
    expect(d.boundary.gatesRemoved).toEqual(['数据库变更']);
    expect(d.boundary.loosened).toBe(true);
  });

  it('新增人工确认点是收紧，也要说，但不算放宽', () => {
    const before = plan({ tasks: [task('数据库变更')], humanGates: [] });
    const after = plan({
      version: 2,
      tasks: [task('数据库变更', { requiresHuman: true })],
      humanGates: [{ taskTitle: '数据库变更' }],
    });

    const d = diffPlans(before, after);
    expect(d.boundary.gatesAdded).toEqual(['数据库变更']);
    expect(d.boundary.loosened).toBe(false);
  });

  /**
   * ★ 一个总在喊狼来了的警告，用户第三次就不看了。
   *   新增的任务本来就没有 gate，不能算成「gate 被去掉了」。
   */
  it('★ 新增任务不被误报成「边界放宽」', () => {
    const before = plan({ tasks: [task('服务端实现')], humanGates: [] });
    const after = plan({
      version: 2,
      tasks: [task('服务端实现'), task('新加的任务')],
      humanGates: [],
    });

    const d = diffPlans(before, after);
    expect(d.boundary.gatesRemoved).toEqual([]);
    expect(d.boundary.loosened).toBe(false);
  });
});

describe('任务级差异', () => {
  it('新增 / 删除 / 修改分别标出', () => {
    const before = plan({ tasks: [task('保留'), task('要删的')] });
    const after = plan({
      version: 2,
      tasks: [task('保留', { estimatedHours: 8 }), task('新加的')],
    });

    const d = diffPlans(before, after);
    const byTitle = new Map(d.tasks.map((t) => [t.title, t]));

    expect(byTitle.get('保留')?.kind).toBe('changed');
    expect(byTitle.get('新加的')?.kind).toBe('added');
    expect(byTitle.get('要删的')?.kind).toBe('removed');
  });

  it('改动逐字段列出，并标明哪一项是放宽', () => {
    const before = plan({ tasks: [task('数据库变更', { requiresHuman: true, riskLevel: 'low' })] });
    const after = plan({
      version: 2,
      tasks: [task('数据库变更', { requiresHuman: false, riskLevel: 'high' })],
    });

    const fields = diffPlans(before, after).tasks[0]!.fields;
    const byField = new Map(fields.map((f) => [f.field, f]));

    expect(byField.get('requiresHuman')).toMatchObject({
      before: '👤 需要人',
      after: '🤖 Agent',
      loosened: true,
    });
    expect(byField.get('riskLevel')?.loosened).toBe(true);
  });

  /**
   * ★ 同名任务是存在的。用 Map<title, task> 的话第二条会覆盖第一条，
   *   diff 里就会凭空出现一条「删除」加一条「新增」。
   */
  it('★ 同名任务按顺序配对，不会被误报成一删一增', () => {
    const before = plan({ tasks: [task('单元测试'), task('单元测试')] });
    const after = plan({ version: 2, tasks: [task('单元测试'), task('单元测试')] });

    const d = diffPlans(before, after);
    expect(d.tasks.filter((t) => t.kind === 'added')).toHaveLength(0);
    expect(d.tasks.filter((t) => t.kind === 'removed')).toHaveLength(0);
    expect(d.identical).toBe(true);
  });

  it('diff 跟着新版的顺序走 —— 用户读的是新版', () => {
    const before = plan({ tasks: [task('A'), task('B')] });
    const after = plan({ version: 2, tasks: [task('B'), task('A')] });

    const d = diffPlans(before, after);
    expect(d.tasks.slice(0, 2).map((t) => t.title)).toEqual(['B', 'A']);
  });
});

describe('总量与风险', () => {
  it('总工时、token 用量、需人确认数变化都列出来', () => {
    const before = plan({ estimatedHours: 8, estimatedTokens: 4 });
    const after = plan({
      version: 2,
      estimatedHours: 20,
      estimatedTokens: 12,
      tasks: [task('服务端实现'), task('单元测试'), task('新任务')],
    });

    const labels = diffPlans(before, after).metrics.map((m) => m.label);
    expect(labels).toContain('总工时');
    expect(labels).toContain('预估 token 用量');
    expect(labels).toContain('任务数');
  });

  it('需人确认的任务变少标为放宽', () => {
    const before = plan({ tasks: [task('A', { requiresHuman: true }), task('B')] });
    const after = plan({ version: 2, tasks: [task('A'), task('B')] });

    const m = diffPlans(before, after).metrics.find((x) => x.field === 'humanTasks');
    expect(m?.loosened).toBe(true);
  });

  it('新增与消失的风险都列出', () => {
    const before = plan({ risks: [{ title: '索引重建期间查询变慢' }] });
    const after = plan({ version: 2, risks: [{ title: '第三方接口限流' }] });

    const d = diffPlans(before, after);
    expect(d.risks.added).toEqual(['第三方接口限流']);
    expect(d.risks.removed).toEqual(['索引重建期间查询变慢']);
  });
});

describe('两版一样时如实说', () => {
  it('重新规划产出一份一样的计划 —— identical', () => {
    const d = diffPlans(plan(), plan({ version: 2 }));
    expect(d.identical).toBe(true);
  });
});
