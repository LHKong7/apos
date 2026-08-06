import type { WorkItemStatus } from '@apos/contracts';

/**
 * 状态机是数据，不是代码里的 switch。
 *
 * 这样才能被前端复用（拖拽卡片时校验目标列）、被测试穷举、被文档自动生成。
 * docs/tech/04-flow-engine.md §2.1
 */

export const WORK_ITEM_TRIGGERS = [
  'plan_approved',
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

/** `*` 表示任意来源状态；`$previous` 表示回到进入决策等待前的状态 */
export const ANY_STATE = '*' as const;
export const PREVIOUS_STATE = '$previous' as const;

export interface TransitionRule<S extends string, T extends string> {
  from: S | typeof ANY_STATE;
  trigger: T;
  to: S | typeof PREVIOUS_STATE;
  /** guard 名称，全部通过才允许流转 */
  guards?: string[];
  /** 流转成功后执行的副作用名称 */
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

/** 当前状态下所有可用的 trigger —— 409 响应里返回给前端做提示 */
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
