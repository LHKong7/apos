import { percent, round } from './stats';
import { dayKey, daysIn } from './timeline';
import type { AnalyticsInput, CostMetrics } from './types';

/** 与 contracts 的 WorkItemType 一一对应，缺一个就会在图上露出英文原值 */
const TYPE_LABELS: Record<string, string> = {
  requirement: '需求',
  feature: '特性',
  story: '用户故事',
  task: '开发任务',
  bug: '缺陷修复',
  research: '技术调研',
  review: '评审',
  test: '测试',
  incident: '线上事故',
  decision: '决策',
  approval: '审批',
  release: '发布',
  knowledge: '知识沉淀',
};

/**
 * 成本（页面文档 12 §5.6）。
 *
 * 刻意没做「成本效益视角」（Agent 成本 vs 节省的人力工时）——
 * 它需要一个人力成本基准，而这个数字既没地方配置、又敏感
 * （页面文档 §12.3 把它列为待确认）。硬编一个时薪去算「省了多少钱」，
 * 得到的是一个看起来很厉害、但没有任何依据的数字。
 */
export function computeCost(input: AnalyticsInput, now: number): CostMetrics {
  const { window, runs, items, agents, budget, costSpentTotal } = input;
  const inWindow = runs.filter((r) => r.createdAt >= window.from && r.createdAt <= window.to);
  const total = inWindow.reduce((sum, r) => sum + r.cost, 0);

  const delivered = items.filter(
    (i) => i.actualEnd !== null && i.actualEnd >= window.from && i.actualEnd <= window.to,
  );

  // ── 趋势 ──
  const perDay = new Map<string, number>();
  for (const r of inWindow) perDay.set(dayKey(r.createdAt), (perDay.get(dayKey(r.createdAt)) ?? 0) + r.cost);
  const trend = daysIn(window).map((day) => ({ day, value: round(perDay.get(day) ?? 0, 4) }));

  // ── 按 Agent ──
  const agentName = new Map(agents.map((a) => [a.id, a.name]));
  const byAgentMap = new Map<string, number>();
  for (const r of inWindow) byAgentMap.set(r.agentId, (byAgentMap.get(r.agentId) ?? 0) + r.cost);
  const byAgent = [...byAgentMap.entries()]
    .map(([id, cost]) => ({
      id,
      label: agentName.get(id) ?? id.slice(0, 8),
      cost: round(cost, 4),
      percent: percent(cost, total),
    }))
    .sort((a, b) => b.cost - a.cost);

  // ── 按任务类型 ──
  const itemType = new Map(items.map((i) => [i.id, i.type]));
  const byTypeMap = new Map<string, number>();
  for (const r of inWindow) {
    const type = itemType.get(r.workItemId) ?? 'unknown';
    byTypeMap.set(type, (byTypeMap.get(type) ?? 0) + r.cost);
  }
  const byType = [...byTypeMap.entries()]
    .map(([id, cost]) => ({
      id,
      label: TYPE_LABELS[id] ?? id,
      cost: round(cost, 4),
      percent: percent(cost, total),
    }))
    .sort((a, b) => b.cost - a.cost);

  return {
    total: round(total, 4),
    perDelivered: delivered.length > 0 ? round(total / delivered.length, 4) : null,
    delivered: delivered.length,
    trend,
    byAgent,
    byType,
    anomalies: findAnomalies(input, inWindow, agentName),
    budget,
    budgetSpent: round(costSpentTotal, 4),
    budgetRunwayDays: runway(budget, costSpentTotal, total, window, now),
  };
}

/**
 * 成本异常：单次 Run 显著高于常态。
 *
 * ★ 阈值取「中位数的 3 倍」而不是一个写死的美元数。
 *   写死的阈值在便宜的项目里永远不触发、在昂贵的项目里天天报警；
 *   跟着样本走才能在任何量级上都指向「这一次不对劲」。
 */
function findAnomalies(
  input: AnalyticsInput,
  runs: AnalyticsInput['runs'],
  agentName: Map<string, string>,
): CostMetrics['anomalies'] {
  const MULTIPLE = 3;
  /** 样本太少时中位数不稳，不报 */
  const MIN_SAMPLE = 5;

  const costs = runs.map((r) => r.cost).filter((c) => c > 0).sort((a, b) => a - b);
  if (costs.length < MIN_SAMPLE) return [];
  const median = costs[Math.floor(costs.length / 2)]!;
  if (median <= 0) return [];

  const title = new Map(input.items.map((i) => [i.id, i.title]));
  return runs
    .filter((r) => r.cost > median * MULTIPLE)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5)
    .map((r) => ({
      runId: r.id,
      workItemId: r.workItemId,
      title: title.get(r.workItemId) ?? '（已删除的任务）',
      agentName: agentName.get(r.agentId) ?? r.agentId.slice(0, 8),
      cost: round(r.cost, 4),
      times: round(r.cost / median),
    }));
}

/** 按窗口内的实际速率推预算还能撑几天。没预算或没花钱就不给数字。 */
function runway(
  budget: number | null,
  spent: number,
  windowCost: number,
  window: { from: number; to: number },
  now: number,
): number | null {
  if (budget === null || budget <= 0 || windowCost <= 0) return null;
  const days = Math.max(1, (Math.min(window.to, now) - window.from) / 86_400_000);
  const perDay = windowCost / days;
  const left = budget - spent;
  return left <= 0 ? 0 : round(left / perDay);
}

export { TYPE_LABELS };
