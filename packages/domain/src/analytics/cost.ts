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
 * 用量（页面文档 12 §5.6）。
 *
 * ★ 单位是 token，不是钱。美元单价随官方定价漂移，同一份工作量
 *   在调价前后会给出两个数，而没有任何事件解释差异从哪来；
 *   token 不动。历史对比要成立，计量单位必须先稳定下来。
 *
 * Denominated in tokens, not currency: unit prices drift with vendor
 * pricing, so the same amount of work reports two different numbers either
 * side of a repricing with nothing recording why. Token counts do not move.
 * Historical comparison only works once the unit stops moving.
 *
 * 「成本效益视角」（Agent 开销 vs 节省的人力工时）在 benefit.ts，
 * 那是唯一仍以货币计的地方 —— 人力成本没有第二种单位。
 */
export function computeCost(input: AnalyticsInput, now: number): CostMetrics {
  const { window, runs, items, agents, tokenBudget, tokensSpentTotal } = input;
  const inWindow = runs.filter((r) => r.createdAt >= window.from && r.createdAt <= window.to);
  const total = inWindow.reduce((sum, r) => sum + r.tokens, 0);

  /**
   * ★ 判据是「跑完了却一个 token 都没报」。
   *   任何真实的模型调用都不可能是 0 —— 这个 0 的意思是「不知道」，
   *   而不是「免费」。跑到一半的 Run 不算，它本来就还没报。
   */
  const unmeasuredRuns = inWindow.filter(
    (r) => r.tokens === 0 && r.status !== 'running' && r.status !== 'queued',
  ).length;

  const delivered = items.filter(
    (i) => i.actualEnd !== null && i.actualEnd >= window.from && i.actualEnd <= window.to,
  );

  // ── 趋势 ──
  const perDay = new Map<string, number>();
  for (const r of inWindow) perDay.set(dayKey(r.createdAt), (perDay.get(dayKey(r.createdAt)) ?? 0) + r.tokens);
  const trend = daysIn(window).map((day) => ({ day, value: Math.round(perDay.get(day) ?? 0) }));

  // ── 按 Agent ──
  const agentName = new Map(agents.map((a) => [a.id, a.name]));
  const byAgentMap = new Map<string, number>();
  for (const r of inWindow) byAgentMap.set(r.agentId, (byAgentMap.get(r.agentId) ?? 0) + r.tokens);
  const byAgent = [...byAgentMap.entries()]
    .map(([id, tokens]) => ({
      id,
      label: agentName.get(id) ?? id.slice(0, 8),
      tokens: Math.round(tokens),
      percent: percent(tokens, total),
    }))
    .sort((a, b) => b.tokens - a.tokens);

  // ── 按任务类型 ──
  const itemType = new Map(items.map((i) => [i.id, i.type]));
  const byTypeMap = new Map<string, number>();
  for (const r of inWindow) {
    const type = itemType.get(r.workItemId) ?? 'unknown';
    byTypeMap.set(type, (byTypeMap.get(type) ?? 0) + r.tokens);
  }
  const byType = [...byTypeMap.entries()]
    .map(([id, tokens]) => ({
      id,
      label: TYPE_LABELS[id] ?? id,
      tokens: Math.round(tokens),
      percent: percent(tokens, total),
    }))
    .sort((a, b) => b.tokens - a.tokens);

  return {
    total: Math.round(total),
    perDelivered: delivered.length > 0 ? Math.round(total / delivered.length) : null,
    delivered: delivered.length,
    trend,
    byAgent,
    byType,
    anomalies: findAnomalies(input, inWindow, agentName),
    budget: tokenBudget,
    budgetSpent: Math.round(tokensSpentTotal),
    budgetRunwayDays: runway(tokenBudget, tokensSpentTotal, total, window, now),
    unmeasuredRuns,
  };
}

/**
 * 用量异常：单次 Run 显著高于常态。
 *
 * ★ 阈值取「中位数的 3 倍」而不是一个写死的 token 数。
 *   写死的阈值在轻量项目里永远不触发、在重上下文项目里天天报警；
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

  const sorted = runs.map((r) => r.tokens).filter((c) => c > 0).sort((a, b) => a - b);
  if (sorted.length < MIN_SAMPLE) return [];
  const median = sorted[Math.floor(sorted.length / 2)]!;
  if (median <= 0) return [];

  const title = new Map(input.items.map((i) => [i.id, i.title]));
  return runs
    .filter((r) => r.tokens > median * MULTIPLE)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5)
    .map((r) => ({
      runId: r.id,
      workItemId: r.workItemId,
      title: title.get(r.workItemId) ?? '（已删除的任务）',
      agentName: agentName.get(r.agentId) ?? r.agentId.slice(0, 8),
      tokens: Math.round(r.tokens),
      times: round(r.tokens / median),
    }));
}

/** 按窗口内的实际速率推预算还能撑几天。没预算或没用量就不给数字。 */
function runway(
  budget: number | null,
  spent: number,
  windowTokens: number,
  window: { from: number; to: number },
  now: number,
): number | null {
  if (budget === null || budget <= 0 || windowTokens <= 0) return null;
  const days = Math.max(1, (Math.min(window.to, now) - window.from) / 86_400_000);
  const perDay = windowTokens / days;
  const left = budget - spent;
  return left <= 0 ? 0 : round(left / perDay);
}

export { TYPE_LABELS };
