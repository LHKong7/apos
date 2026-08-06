import { STATUS_STAGE, type Stage, type WorkItemStatus } from '@apos/contracts';
import {
  availableTriggers,
  PREVIOUS_STATE,
  resolveTransition,
  type WorkItemTrigger,
} from './machine';
import { WORK_ITEM_MACHINE } from './work-item-machine';

/**
 * 只能由系统发起的 trigger。
 *
 * 人手动调状态时不该能伪造这些：`agent_run_completed` 意味着「Agent 报告完成了」，
 * 人点一下就写进事件流，事后追责时分不清到底是谁做的。
 * 人要表达同样的意思，走 human_work_completed。
 */
const SYSTEM_ONLY_TRIGGERS: readonly WorkItemTrigger[] = [
  'plan_approved',
  'run_dispatched',
  'agent_run_completed',
  'agent_run_failed',
  'dependency_lost',
  'decision_required',
  'decision_approved',
  'decision_rejected',
];

/**
 * 找出「从 from 手动调到 to」该用哪个 trigger。
 *
 * ★ 从状态机推导，而不是手写一张 status → trigger 的表。
 *
 *   手写表的问题是它只认目标状态：ready 被写死成 retry_requested，
 *   于是 changes_requested → ready（返工重新开始）这条合法路径就永远走不通 ——
 *   界面上能拖，后端一律拒绝。同一个目标状态可以由不同的来源状态经不同 trigger 抵达，
 *   这件事只有状态机自己知道。
 *
 * 前后端共用这一个函数，判定不会漂移。
 */
export function manualTriggerFor(
  from: WorkItemStatus,
  to: WorkItemStatus,
): WorkItemTrigger | null {
  for (const trigger of availableTriggers(WORK_ITEM_MACHINE, from)) {
    if (SYSTEM_ONLY_TRIGGERS.includes(trigger)) continue;

    const rule = resolveTransition(WORK_ITEM_MACHINE, from, trigger);
    // $previous 的目标取决于运行时数据，静态推导不出来，不作为手动目标
    if (!rule || rule.to === PREVIOUS_STATE) continue;
    if (rule.to === to) return trigger;
  }
  return null;
}

export interface ManualTarget {
  status: WorkItemStatus;
  trigger: WorkItemTrigger;
}

/**
 * 把卡片拖到某一列时，落点应该是哪个状态。
 *
 * 同一列里可能有多个候选状态（Execution 列有 ready / executing / blocked / failed），
 * 取第一个从当前状态可达的。
 */
export function manualTargetForStage(
  from: WorkItemStatus,
  toStage: Stage,
): ManualTarget | null {
  for (const trigger of availableTriggers(WORK_ITEM_MACHINE, from)) {
    if (SYSTEM_ONLY_TRIGGERS.includes(trigger)) continue;

    const rule = resolveTransition(WORK_ITEM_MACHINE, from, trigger);
    if (!rule || rule.to === PREVIOUS_STATE) continue;
    if (STATUS_STAGE[rule.to] === toStage) return { status: rule.to, trigger };
  }
  return null;
}

export { SYSTEM_ONLY_TRIGGERS };
