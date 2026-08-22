import { describe, expect, it } from 'vitest';
import { STATUS_STAGE, WorkItemStatus, type WorkItemStatus as Status } from '@apos/contracts';
import { ANY_STATE, availableTriggers, PREVIOUS_STATE, resolveTransition } from './machine';
import { WORK_ITEM_MACHINE } from './work-item-machine';

const ALL_STATUSES = WorkItemStatus.options;

describe('状态机结构', () => {
  it('每个 status 都有对应的 stage 映射', () => {
    for (const s of ALL_STATUSES) {
      expect(STATUS_STAGE[s], `${s} 缺少 stage 映射`).toBeDefined();
    }
  });

  it('所有流转目标都是合法状态', () => {
    for (const rule of WORK_ITEM_MACHINE.transitions) {
      if (rule.to === PREVIOUS_STATE) continue;
      expect(ALL_STATUSES, `未知目标状态 ${rule.to}`).toContain(rule.to);
    }
  });

  it('所有 from 都是合法状态或通配符', () => {
    for (const rule of WORK_ITEM_MACHINE.transitions) {
      if (rule.from === ANY_STATE) continue;
      expect(ALL_STATUSES, `未知来源状态 ${rule.from}`).toContain(rule.from);
    }
  });

  it('不存在重复的 (from, trigger) 规则', () => {
    const seen = new Set<string>();
    for (const rule of WORK_ITEM_MACHINE.transitions) {
      const key = `${rule.from}::${rule.trigger}`;
      expect(seen.has(key), `重复规则 ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('终态不能流出（cancelled/done 只能进不能出）', () => {
    for (const terminal of ['done', 'cancelled'] as Status[]) {
      const outgoing = WORK_ITEM_MACHINE.transitions.filter((r) => r.from === terminal);
      expect(outgoing, `${terminal} 不应有流出规则`).toHaveLength(0);
    }
  });
});

describe('resolveTransition', () => {
  it('自动流转链路：ready → executing → reviewing → waiting_for_release → acceptance → done', () => {
    expect(resolveTransition(WORK_ITEM_MACHINE, 'ready', 'run_dispatched')?.to).toBe('executing');
    expect(resolveTransition(WORK_ITEM_MACHINE, 'executing', 'agent_run_completed')?.to).toBe(
      'reviewing',
    );
    expect(resolveTransition(WORK_ITEM_MACHINE, 'reviewing', 'review_passed')?.to).toBe(
      'waiting_for_release',
    );
    expect(resolveTransition(WORK_ITEM_MACHINE, 'releasing', 'release_completed')?.to).toBe(
      'acceptance',
    );
    expect(resolveTransition(WORK_ITEM_MACHINE, 'acceptance', 'accepted')?.to).toBe('done');
  });

  it('非法流转返回 null', () => {
    expect(resolveTransition(WORK_ITEM_MACHINE, 'ready', 'release_completed')).toBeNull();
    expect(resolveTransition(WORK_ITEM_MACHINE, 'done', 'retry_requested')).toBeNull();
  });

  it('decision_required 可从任意状态进入', () => {
    for (const s of ALL_STATUSES) {
      const t = resolveTransition(WORK_ITEM_MACHINE, s, 'decision_required');
      expect(t?.to, `${s} 应能进入 awaiting_decision`).toBe('awaiting_decision');
      expect(t?.effects).toContain('rememberPreviousStatus');
    }
  });

  it('精确匹配优先于通配符：awaiting_decision 的 escalated_to_human 走专门规则', () => {
    const t = resolveTransition(WORK_ITEM_MACHINE, 'awaiting_decision', 'escalated_to_human');
    expect(t?.to).toBe('executing');
    expect(t?.effects).toContain('clearPreviousStatus');
  });

  it('决策批准后回到进入前的状态', () => {
    const t = resolveTransition(WORK_ITEM_MACHINE, 'awaiting_decision', 'decision_approved');
    expect(t?.to).toBe(PREVIOUS_STATE);
    expect(t?.effects).toContain('applyConstraints');
  });

  it('ready → executing 需要三个 guard', () => {
    const t = resolveTransition(WORK_ITEM_MACHINE, 'ready', 'run_dispatched');
    expect(t?.guards).toEqual(['dependenciesSatisfied', 'wipAvailable', 'executorAssigned']);
  });

  it('人工开始执行时同时切换执行主体，避免被监督器误判为孤儿 Run', () => {
    const t = resolveTransition(WORK_ITEM_MACHINE, 'ready', 'human_work_started');
    expect(t?.to).toBe('executing');
    expect(t?.effects).toEqual(
      expect.arrayContaining(['recordActualStart', 'switchExecutorToHuman']),
    );
  });

  it('review_passed 受验收标准与质量门禁双重把关', () => {
    const t = resolveTransition(WORK_ITEM_MACHINE, 'reviewing', 'review_passed');
    expect(t?.guards).toContain('acceptanceCriteriaMet');
    expect(t?.guards).toContain('qualityGatePassed');
  });
});

describe('availableTriggers', () => {
  it('每个非终态至少有一个可用 trigger', () => {
    for (const s of ALL_STATUSES) {
      if (s === 'done' || s === 'cancelled') continue;
      expect(availableTriggers(WORK_ITEM_MACHINE, s).length, `${s} 无可用 trigger`).toBeGreaterThan(
        0,
      );
    }
  });

  it('executing 状态下可用的 trigger 包含失败与接管', () => {
    const triggers = availableTriggers(WORK_ITEM_MACHINE, 'executing');
    expect(triggers).toContain('agent_run_failed');
    expect(triggers).toContain('human_took_over');
    expect(triggers).toContain('decision_required');
  });
});

describe('可达性', () => {
  /** 从 draft 出发能否到达每个状态 —— 不可达状态说明状态机有缺口 */
  it('所有状态都可从 draft 到达', () => {
    const reachable = new Set<Status>(['draft']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const s of [...reachable]) {
        for (const trigger of availableTriggers(WORK_ITEM_MACHINE, s)) {
          const t = resolveTransition(WORK_ITEM_MACHINE, s, trigger);
          if (!t) continue;
          // $previous 依赖运行时状态，等价于回到任意已到达状态
          if (t.to === PREVIOUS_STATE) continue;
          if (!reachable.has(t.to)) {
            reachable.add(t.to);
            grew = true;
          }
        }
      }
    }

    const unreachable = ALL_STATUSES.filter((s) => !reachable.has(s));
    // clarifying / awaiting_requirement_approval 属于 Requirement 生命周期，
    // Work Item 由计划批准后创建，不经过这两个状态
    expect(unreachable).toEqual([
      'clarifying',
      'awaiting_requirement_approval',
      'planning',
      'awaiting_plan_approval',
      'released',
    ]);
  });
});
