import { STATUS_STAGE, TERMINAL_STATUSES, type WorkItemStatus } from '@apos/contracts';
import type { StatusChange, TimeBucket, Window } from './types';

/**
 * 从状态变更事件重建每个 Work Item 的状态时间线。
 *
 * 这是整个 Analytics 的地基 —— 周期分解、Flow Efficiency、阻塞时长、
 * 决策等待全都从这里长出来。事件流本身就是唯一真相，
 * 不需要额外的埋点或快照表。
 */

export interface Segment {
  itemId: string;
  status: WorkItemStatus;
  from: number;
  /** 仍在该状态时为 null，调用方按「截至现在」处理 */
  to: number | null;
}

/**
 * ★ 「有效工作时间」的口径（页面文档 §12.1 列为待确认，这里定死）。
 *
 *   判据只有一条：**这一刻有没有人或 Agent 正在推进这件事**。
 *   executing / reviewing / planning / clarifying / releasing / acceptance 有；
 *   ready（排在队里）、blocked、failed、changes_requested（等人捡起来）、
 *   awaiting_*（等人批）都没有。
 *
 *   争议点是 Agent 调外部 API 的等待算不算有效 —— 算。
 *   那段时间任务确实在被推进，而且它不是本产品能改善的损耗；
 *   把它算成等待会让 Flow Efficiency 变成「Agent 跑得快不快」，
 *   而这个指标要衡量的是「工作流不流动」。
 */
const ACTIVE_STATUSES = new Set<WorkItemStatus>([
  'clarifying',
  'planning',
  'executing',
  'reviewing',
  'releasing',
  'acceptance',
]);

const DECISION_WAIT_STATUSES = new Set<WorkItemStatus>([
  'awaiting_requirement_approval',
  'awaiting_plan_approval',
  'awaiting_decision',
]);

const TERMINAL = new Set<WorkItemStatus>(TERMINAL_STATUSES);

export function isActive(status: WorkItemStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function isTerminal(status: WorkItemStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * 状态 → 时间去向的分类。
 *
 * ★ 三种 awaiting_* 统一归到 decision_wait，不并入所处阶段。
 *   这是页面文档 §5.3 的关键设计：等待人类决策是本产品特有的损耗，
 *   混进「评审阶段 1.6 天」里就再也看不见了，而它恰恰是最该被压缩的部分。
 */
export function bucketOf(status: WorkItemStatus): TimeBucket | null {
  if (DECISION_WAIT_STATUSES.has(status)) return 'decision_wait';
  if (TERMINAL.has(status)) return null;
  // acceptance 归在 release 桶 —— 它是交付的收尾，不是一个独立阶段
  if (status === 'acceptance') return 'release';
  const stage = STATUS_STAGE[status];
  return stage === 'done' ? null : stage;
}

/**
 * 重建时间线。
 *
 * @param changes 全部状态变更，不必预排序
 * @param createdAt 每个 item 的创建时间，用于补上第一段
 */
export function buildSegments(
  changes: StatusChange[],
  createdAt: Map<string, number>,
): Map<string, Segment[]> {
  const byItem = new Map<string, StatusChange[]>();
  for (const c of changes) {
    const list = byItem.get(c.itemId);
    if (list) list.push(c);
    else byItem.set(c.itemId, [c]);
  }

  const out = new Map<string, Segment[]>();
  for (const [itemId, list] of byItem) {
    list.sort((a, b) => a.at - b.at);
    const segments: Segment[] = [];

    // 第一段：创建 → 第一次变更。用第一条变更的 from 反推当时的状态
    const first = list[0]!;
    const birth = createdAt.get(itemId);
    if (birth !== undefined && first.from && birth < first.at) {
      segments.push({ itemId, status: first.from, from: birth, to: first.at });
    }

    for (let i = 0; i < list.length; i++) {
      const c = list[i]!;
      const next = list[i + 1];
      segments.push({ itemId, status: c.to, from: c.at, to: next ? next.at : null });
    }

    out.set(itemId, segments);
  }
  return out;
}

/** 段与窗口的交集时长（毫秒）。开放段按 now 截断。 */
export function overlapMs(segment: Segment, window: Window, now: number): number {
  const end = segment.to ?? now;
  const from = Math.max(segment.from, window.from);
  const to = Math.min(end, window.to);
  return Math.max(0, to - from);
}

/**
 * 某个瞬间每个 item 的状态。WIP 趋势、CFD 之类的按日快照靠它。
 * 时间线以外（尚未创建）的 item 不出现在结果里。
 */
export function statusAt(segments: Segment[], at: number, now: number): WorkItemStatus | null {
  for (const s of segments) {
    const end = s.to ?? now;
    if (s.from <= at && at < end) return s.status;
  }
  // at 落在最后一段之后（item 已终结）时返回最后的状态
  const last = segments[segments.length - 1];
  return last && at >= last.from ? last.status : null;
}

/** UTC 日期键。整个 Analytics 统一用 UTC 切天，避免服务端时区影响数字。 */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function daysIn(window: Window): string[] {
  const out: string[] = [];
  const DAY = 86_400_000;
  const start = Date.UTC(
    new Date(window.from).getUTCFullYear(),
    new Date(window.from).getUTCMonth(),
    new Date(window.from).getUTCDate(),
  );
  for (let t = start; t <= window.to; t += DAY) out.push(dayKey(t));
  return out;
}
