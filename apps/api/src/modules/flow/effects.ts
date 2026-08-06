import type { workItems } from '@apos/db';
import type { ActorRef, WorkItemStatus } from '@apos/contracts';

type WorkItemRow = typeof workItems.$inferSelect;
type WorkItemPatch = Partial<typeof workItems.$inferInsert>;

export interface EffectContext {
  item: WorkItemRow;
  actor: ActorRef;
  from: WorkItemStatus;
  to: WorkItemStatus;
}

/**
 * 流转副作用。每个 effect 返回对 work_items 的字段补丁，
 * 由 transition 合并进同一条 UPDATE —— 保证与状态变更原子。
 */
const EFFECTS: Record<string, (ctx: EffectContext) => WorkItemPatch> = {
  /**
   * 进入决策等待前记住原状态，供 $previous 回退。
   * 同时打上 Human Gate —— 卡片留在原阶段（见 stageFor），
   * 靠这个徽标告诉人「这张卡在等你」（页面文档 05 §5.4）。
   */
  rememberPreviousStatus: ({ from }) => ({
    previousStatus: from,
    humanGate: 'waiting_for_decision' as const,
  }),

  clearPreviousStatus: () => ({ previousStatus: null }),

  /** 人工接管：执行主体切换为人类，但状态仍是 executing */
  switchExecutorToHuman: ({ actor }) => ({
    executorType: 'human',
    executorId: actor.id,
    humanGate: 'human_took_over',
  }),

  clearBlocked: () => ({
    blockedSince: null,
    blockedReason: null,
    blockedDetail: null,
  }),

  /** 改派后重置失败计数，否则新 Agent 会立刻撞上「连续失败 3 次」 */
  clearFailureCount: () => ({ consecutiveFailures: 0 }),

  recordActualStart: ({ item }) => (item.actualStart ? {} : { actualStart: new Date() }),

  recordActualEnd: () => ({ actualEnd: new Date() }),

  applyConstraints: () => ({ humanGate: 'approved' }),

  notifyAssignee: () => ({}),

  createIncident: () => ({}),
};

export function applyEffects(names: string[], ctx: EffectContext): WorkItemPatch {
  let patch: WorkItemPatch = {};
  for (const name of names) {
    const effect = EFFECTS[name];
    if (!effect) throw new Error(`Unknown effect: ${name}`);
    patch = { ...patch, ...effect(ctx) };
  }
  return patch;
}

export const EFFECT_NAMES = Object.keys(EFFECTS);
