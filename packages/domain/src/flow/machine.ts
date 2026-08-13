import type { WorkItemStatus } from '@apos/contracts';

/**
 * 状态机是数据，不是代码里的 switch。
 *
 * 这样才能被前端复用（拖拽卡片时校验目标列）、被测试穷举、被文档自动生成。
 *
 * The state machine is data, not a switch statement.
 *
 * That is what lets the frontend reuse it (validating a drop target while
 * dragging a card), lets tests enumerate it exhaustively, and lets docs be
 * generated from it.
 * docs/tech/04-flow-engine.md §2.1
 */

export const WORK_ITEM_TRIGGERS = [
  'plan_approved',
  /**
   * 手工建的工作项被放行去执行。
   *
   * ★★ 它和 `plan_approved` 是**同一道 Human Gate**，只是粒度不同：
   *   后者批的是一份计划，前者批的是一个任务。
   *
   *   拆成两个 trigger 而不是复用 plan_approved，是因为 plan_approved
   *   被列进了 SYSTEM_ONLY_TRIGGERS —— 它由「计划被批准」这件事驱动，
   *   人手动伪造它会让事件流里出现一份并不存在的计划。
   *   而手工放行是人**当场**做的决定，必须如实记成那样。
   *
   * A hand-created work item is released for execution.
   *
   * ★★ This and `plan_approved` are the **same Human Gate** at different
   *   granularities: that one approves a plan, this one approves a work item.
   *
   *   They are separate triggers rather than one because `plan_approved` is in
   *   SYSTEM_ONLY_TRIGGERS — it is driven by the fact that a plan was
   *   approved, and a person forging it would put a plan that never existed
   *   into the event stream. Releasing by hand is a decision a person made
   *   there and then, and has to be recorded as exactly that.
   */
  'manual_activated',
  'run_dispatched',
  'assigned_to_human',
  'human_work_started',
  'agent_run_completed',
  'agent_run_failed',
  'human_work_completed',
  'dependency_lost',
  'blocker_cleared',
  'retry_requested',
  'reassigned',
  'escalated_to_human',
  'human_took_over',
  'review_passed',
  'review_rejected',
  'review_conflict',
  'rework_started',
  'release_started',
  'release_completed',
  'release_failed',
  'accepted',
  'acceptance_rejected',
  'decision_required',
  'decision_approved',
  'decision_rejected',
  'cancelled',
] as const;

export type WorkItemTrigger = (typeof WORK_ITEM_TRIGGERS)[number];

/**
 * `*` 表示任意来源状态；`$previous` 表示回到进入决策等待前的状态。
 * `*` matches any source status; `$previous` returns to whatever the status
 * was before the wait for a decision began.
 */
export const ANY_STATE = '*' as const;
export const PREVIOUS_STATE = '$previous' as const;

export interface TransitionRule<S extends string, T extends string> {
  from: S | typeof ANY_STATE;
  trigger: T;
  to: S | typeof PREVIOUS_STATE;
  /**
   * guard 名称，全部通过才允许流转。
   * Guard names; every one must pass before the transition is allowed.
   */
  guards?: string[];
  /**
   * 流转成功后执行的副作用名称。
   * Names of the side effects run after a successful transition.
   */
  effects?: string[];
}

export interface Machine<S extends string, T extends string> {
  initial: S;
  transitions: TransitionRule<S, T>[];
}

export interface ResolvedTransition<S extends string> {
  to: S | typeof PREVIOUS_STATE;
  guards: string[];
  effects: string[];
}

/**
 * 查找匹配的流转规则。精确匹配优先于通配符匹配 —— 这让
 * `{ from: 'awaiting_decision', trigger: 'cancelled' }` 能覆盖
 * `{ from: '*', trigger: 'cancelled' }`。
 *
 * Find the matching transition rule. An exact match wins over a wildcard, so
 * `{ from: 'awaiting_decision', trigger: 'cancelled' }` overrides
 * `{ from: '*', trigger: 'cancelled' }`.
 */
export function resolveTransition<S extends string, T extends string>(
  machine: Machine<S, T>,
  from: S,
  trigger: T,
): ResolvedTransition<S> | null {
  let wildcard: TransitionRule<S, T> | undefined;

  for (const rule of machine.transitions) {
    if (rule.trigger !== trigger) continue;
    if (rule.from === from) {
      return { to: rule.to, guards: rule.guards ?? [], effects: rule.effects ?? [] };
    }
    if (rule.from === ANY_STATE && !wildcard) wildcard = rule;
  }

  return wildcard
    ? { to: wildcard.to, guards: wildcard.guards ?? [], effects: wildcard.effects ?? [] }
    : null;
}

/**
 * 当前状态下所有可用的 trigger —— 409 响应里返回给前端做提示。
 * Every trigger available from the current status; returned in a 409 so the
 * frontend can say what *would* work.
 */
export function availableTriggers<S extends string, T extends string>(
  machine: Machine<S, T>,
  from: S,
): T[] {
  const set = new Set<T>();
  for (const rule of machine.transitions) {
    if (rule.from === from || rule.from === ANY_STATE) set.add(rule.trigger);
  }
  return [...set];
}

export type WorkItemMachine = Machine<WorkItemStatus, WorkItemTrigger>;
