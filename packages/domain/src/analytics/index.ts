import { computeAgents } from './agents';
import { computeCost } from './cost';
import { computeFlow } from './flow';
import { computeHitl } from './hitl';
import { findInsights } from './insights';
import { round } from './stats';
import { buildSegments } from './timeline';
import {
  RANGE_DAYS,
  type Analytics,
  type AnalyticsInput,
  type AnalyticsRange,
  type Deltas,
  type Window,
} from './types';

export * from './types';
export { bucketOf, buildSegments, dayKey, daysIn, isActive, isTerminal, statusAt } from './timeline';
export type { Segment } from './timeline';
export { stat, round, percent, ratio, HOUR } from './stats';
export { computeFlow } from './flow';
export { computeAgents, FAILURE_LABELS } from './agents';
export { computeHitl, decisionLabel, OVERRIDE_LABELS } from './hitl';
export { computeCost, TYPE_LABELS } from './cost';
export { findInsights, type InsightInput } from './insights';
export {
  computeHealth,
  predictDelay,
  computeProgress,
  type Health,
  type DelayRisk,
  type Contribution,
  type HealthInput,
  type DelayInput,
} from './health';

const DAY = 86_400_000;

/** 样本不足时页面不给强结论（页面文档 12 §7 / §11） */
const MIN_COMPLETED = 10;
const MIN_DAYS = 7;

export function windowFor(range: AnalyticsRange, now: number): Window {
  return { from: now - RANGE_DAYS[range] * DAY, to: now };
}

/** 上一周期：紧邻当前窗口、等长 */
export function previousWindow(window: Window): Window {
  const span = window.to - window.from;
  return { from: window.from - span, to: window.from };
}

/**
 * 组装整页 Analytics。
 *
 * 一次算完四个 Tab 而不是拆四个接口：`insights` 需要跨 Tab 的事实
 * （「决策等待占总周期 34%」同时要 flow 和 hitl），而四个 Tab 读的是
 * 同一批原始行。拆开等于把同样的事件流拉四遍，再在前端拼不出发现。
 * 代价是首屏多算三个 Tab —— 项目级的数据量下这点开销可以忽略。
 */
export function computeAnalytics(
  range: AnalyticsRange,
  current: AnalyticsInput,
  previous: AnalyticsInput | null,
  now: number,
): Analytics {
  const segments = buildSegments(current.changes, new Map(current.items.map((i) => [i.id, i.createdAt])));

  const flow = computeFlow(current, now);
  const agent = computeAgents(current);
  const hitl = computeHitl(current, segments, now);
  const cost = computeCost(current, now);

  const prev = previous
    ? {
        flow: computeFlow(previous, now),
        agent: computeAgents(previous),
        cost: computeCost(previous, now),
      }
    : null;

  const days = Math.round((current.window.to - current.window.from) / DAY);
  const insights = findInsights({
    flow,
    agent,
    hitl,
    cost,
    previous: prev,
    rangeLabel: `近 ${days} 天`,
  });

  return {
    range,
    window: current.window,
    confidence: {
      level: flow.completed >= MIN_COMPLETED && days >= MIN_DAYS ? 'ok' : 'low',
      completed: flow.completed,
      needed: MIN_COMPLETED,
      days,
    },
    insights,
    flow,
    agent,
    hitl,
    cost,
    deltas: prev ? computeDeltas({ flow, agent, cost }, prev) : null,
  };
}

/**
 * 环比。
 *
 * ★ 一律返回「相对变化率」而不是绝对差值，方向由页面按指标决定 ——
 *   前置时间下降是好事，吞吐下降是坏事，同一个 -0.2 含义相反。
 *   把好坏判断留在展示层，这里只负责算对。
 */
function computeDeltas(
  now: { flow: ReturnType<typeof computeFlow>; agent: ReturnType<typeof computeAgents>; cost: ReturnType<typeof computeCost> },
  before: { flow: ReturnType<typeof computeFlow>; agent: ReturnType<typeof computeAgents>; cost: ReturnType<typeof computeCost> },
): Deltas {
  return {
    leadTime: rel(now.flow.leadTime.median, before.flow.leadTime.median),
    cycleTime: rel(now.flow.cycleTime.median, before.flow.cycleTime.median),
    throughput: rel(now.flow.throughputPerWeek, before.flow.throughputPerWeek),
    flowEfficiency: rel(now.flow.flowEfficiency, before.flow.flowEfficiency),
    decisionWaitHours: rel(now.flow.decisionWaitHours, before.flow.decisionWaitHours),
    tokensPerDelivered: rel(now.cost.perDelivered, before.cost.perDelivered),
    agentSuccessRate: rel(avgSuccess(now.agent), avgSuccess(before.agent)),
  };
}

function avgSuccess(agent: ReturnType<typeof computeAgents>): number | null {
  const runs = agent.agents.reduce((s, a) => s + a.runs, 0);
  if (runs === 0) return null;
  return agent.agents.reduce((s, a) => s + a.successRate * a.runs, 0) / runs;
}

/** 上期为 0 或缺失时不给变化率 —— 「从 0 涨到 3」除出来是无穷大，那不是信息 */
function rel(now: number | null, before: number | null): number | null {
  if (now === null || before === null || before === 0) return null;
  return round(now / before - 1, 3);
}
export * from './quality';
export * from './benefit';
