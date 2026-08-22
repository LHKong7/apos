import { percent, round } from './stats';
import type { FlowMetrics, HitlMetrics } from './types';

/**
 * Project health and delay prediction (page doc 02 §5.2, product doc 8.13.4 / 8.6.6).
 *
 * ★ These two numbers are the ones most likely to turn into mystic scores. A user who sees
 *   "health 62" reacts with "says who?" — and if that has no answer they will act on none of it,
 *   which makes the card decoration. So both must break out their **contributions** item by item:
 *   which factors pulled the score down, and by how much each. A prediction that cannot explain
 *   itself is worse than no prediction: it gets quoted as fact.
 *
 *   分数必须逐项给出贡献度，否则用户答不上「凭什么」，这张卡片就成了装饰 ——
 *   而说不清来源的预测会被当成事实引用，比没有预测更糟。
 */

export interface Contribution {
  /**
   * What this contribution is / 这一项是什么。
   *
   * ★★ The UI resolves its copy from this key (`analytics.health.<key>` /
   *   `analytics.delay.<key>`) rather than rendering `label` and `detail`, which are Chinese.
   *   The same key says two different things under health versus delay prediction, so the
   *   namespace is supplied by the caller: this layer only guarantees "one key, one sentence,
   *   within a namespace".
   *
   *   界面按它取词而不是画 `label` / `detail`；命名空间由调用方给。
   */
  key: string;
  /**
   * Chinese prose / 中文说法.
   *
   * ★ Kept as the fallback for logs, exports, and any UI that does not recognize the key — the
   *   UI reads codes, logs read sentences. Dropping it would make "what did the server actually
   *   compute" completely unreadable in the logs.
   */
  label: string;
  /** The raw reading for this item, in plain words. As above: a fallback, not the display source */
  detail: string;
  /**
   * The numbers `detail` interpolates / `detail` 那句话里的数字。
   *
   * ★★ Without these the UI can only render the Chinese sentence. The percentages, task counts,
   *   and week counts inside `detail` are computed values, and the English sentence has to
   *   arrange the same numbers in its own word order — parsing them back out of a sentence is
   *   not viable, so they must be carried out verbatim.
   */
  params: Record<string, string | number>;
  /** Effect on the total; a negative value is a deduction */
  delta: number;
}

export interface Health {
  score: number;
  level: 'good' | 'fair' | 'poor';
  contributions: Contribution[];
}

export interface DelayRisk {
  level: 'low' | 'medium' | 'high';
  probability: number;
  /** Days expected to slip past the plan; null = no schedule baseline, so no day count */
  estimatedSlipDays: number | null;
  contributions: Contribution[];
}

export interface HealthInput {
  flow: FlowMetrics;
  hitl: HitlMetrics;
  /** Weighted average Agent success rate; null = no execution records inside the window */
  agentSuccessRate: number | null;
  totalTasks: number;
  doneTasks: number;
  blockedTasks: number;
  overdueDecisions: number;
  tokensSpent: number;
  tokenBudget: number | null;
}

/**
 * Health starts at 100 and gets deducted from / 健康度 = 100 分起扣。
 *
 * ★ Deductions rather than a weighted average, so that "why isn't it 100?" has a direct answer.
 *   A weighted average produces the same number but cannot be taken apart into "who took these
 *   38 points" — and that is the only thing the user cares about.
 */
export function computeHealth(input: HealthInput): Health {
  const c: Contribution[] = [];

  // Flow efficiency: this product's central claim, and the heaviest weight
  if (input.flow.flowEfficiency !== null) {
    const eff = input.flow.flowEfficiency;
    const delta = eff >= 0.5 ? 0 : -Math.round((0.5 - eff) * 60);
    if (delta !== 0) {
      c.push({
        key: 'flow_efficiency',
        label: '流动效率',
        detail: `${Math.round(eff * 100)}%，一半以上的时间在等`,
        params: { pct: Math.round(eff * 100) },
        delta,
      });
    }
  }

  // Blocked
  if (input.blockedTasks > 0) {
    c.push({
      key: 'blocked',
      label: '阻塞任务',
      detail: `${input.blockedTasks} 个任务卡住`,
      params: { count: input.blockedTasks },
      delta: -Math.min(20, input.blockedTasks * 7),
    });
  }

  // Overdue decisions — these point straight at "the humans fell behind", so they cost more
  if (input.overdueDecisions > 0) {
    c.push({
      key: 'overdue_decisions',
      label: '超时决策',
      detail: `${input.overdueDecisions} 个决策已过期未处理`,
      params: { count: input.overdueDecisions },
      delta: -Math.min(20, input.overdueDecisions * 10),
    });
  }

  // Rework
  if (input.flow.reworkRate !== null && input.flow.reworkRate > 0.15) {
    c.push({
      key: 'rework',
      label: '返工率',
      detail: `${Math.round(input.flow.reworkRate * 100)}%，高于 15% 的经验阈值`,
      params: { pct: Math.round(input.flow.reworkRate * 100) },
      delta: -Math.min(15, Math.round((input.flow.reworkRate - 0.15) * 60)),
    });
  }

  // Agent success rate
  if (input.agentSuccessRate !== null && input.agentSuccessRate < 0.85) {
    c.push({
      key: 'agent_success',
      label: 'Agent 成功率',
      detail: `${Math.round(input.agentSuccessRate * 100)}%，低于 85%`,
      params: { pct: Math.round(input.agentSuccessRate * 100) },
      delta: -Math.min(15, Math.round((0.85 - input.agentSuccessRate) * 60)),
    });
  }

  // Budget
  if (input.tokenBudget !== null && input.tokenBudget > 0) {
    const used = input.tokensSpent / input.tokenBudget;
    const doneRatio = input.totalTasks > 0 ? input.doneTasks / input.totalTasks : 0;
    // Deduct only when budget is burning faster than work is finishing — spending a lot is not
    // itself a problem
    if (used > doneRatio + 0.2) {
      c.push({
        key: 'budget_pace',
        label: '预算消耗',
        detail: `已用 ${Math.round(used * 100)}%，而进度只有 ${Math.round(doneRatio * 100)}%`,
        params: { usedPct: Math.round(used * 100), donePct: Math.round(doneRatio * 100) },
        delta: -Math.min(15, Math.round((used - doneRatio) * 40)),
      });
    }
  }

  const score = Math.max(0, Math.min(100, 100 + c.reduce((s, x) => s + x.delta, 0)));
  return {
    score,
    level: score >= 75 ? 'good' : score >= 50 ? 'fair' : 'poor',
    contributions: c.sort((a, b) => a.delta - b.delta),
  };
}

export interface DelayInput {
  flow: FlowMetrics;
  agentSuccessRate: number | null;
  remainingTasks: number;
  blockedTasks: number;
  overdueDecisions: number;
  /** Planned project completion date in milliseconds; null = nothing scheduled */
  plannedEnd: number | null;
  now: number;
}

/**
 * Delay risk (product doc 8.6.6) / 延期风险。
 *
 * Seven inputs: remaining workload, historical cycle time, Agent success rate, blocked task
 * count, decision waiting, rework rate, and schedule slack. Each one reports how far it pushed
 * the probability up — page doc §5.2 requires that "the user must be able to see how the
 * prediction was made, or they will not trust it".
 *
 * ★ This is not a statistical model; it is an explicit set of heuristics. Dressing it up as an
 *   "AI prediction" makes people assume something impressive is behind it. Calling it what it
 *   is lets the user know how to read it, and when to ignore it.
 *
 *   如实说是经验规则，用户反而知道该怎么读它、什么时候该忽略它。
 */
export function predictDelay(input: DelayInput): DelayRisk {
  const c: Contribution[] = [];
  let risk = 0.1; // Every project carries baseline risk

  const cycleHours = input.flow.cycleTime.median || 8;
  const throughputPerWeek = input.flow.throughputPerWeek || 0;

  // Remaining workload vs. throughput
  let weeksNeeded: number | null = null;
  if (input.remainingTasks > 0 && throughputPerWeek > 0) {
    weeksNeeded = input.remainingTasks / throughputPerWeek;
  }

  if (input.plannedEnd !== null && weeksNeeded !== null) {
    const weeksLeft = (input.plannedEnd - input.now) / (7 * 86_400_000);
    const gap = weeksNeeded - weeksLeft;
    if (gap > 0) {
      const add = Math.min(0.5, gap * 0.2);
      risk += add;
      /**
        * ★ Split into a separate key from the one below. One key cannot carry two different
        *   sentences — the UI resolves copy by key, so a key mapped to two sentences can only
        *   ever surface one of them.
        *
        *   同一个 key 底下不能有两句不同的话。
        */
      c.push({
        key: 'workload_projected',
        label: '剩余工作量',
        detail: `按当前吞吐 ${throughputPerWeek} 项/周，还需 ${round(weeksNeeded)} 周，而排期只剩 ${round(Math.max(0, weeksLeft))} 周`,
        params: {
          throughput: throughputPerWeek,
          weeksNeeded: round(weeksNeeded),
          weeksLeft: round(Math.max(0, weeksLeft)),
        },
        delta: round(add * 100, 0),
      });
    }
  } else if (weeksNeeded === null && input.remainingTasks > 0) {
    // With no throughput data, do not invent a number — say plainly that the rate is unknown
    c.push({
      key: 'workload_unknown_rate',
      label: '剩余工作量',
      detail: `${input.remainingTasks} 项未完成，但窗口内没有完成记录，算不出速率`,
      params: { count: input.remainingTasks },
      delta: 0,
    });
  }

  if (input.blockedTasks > 0) {
    const add = Math.min(0.25, input.blockedTasks * 0.08);
    risk += add;
    c.push({
      key: 'blocked',
      label: '阻塞任务',
      detail: `${input.blockedTasks} 个任务卡住，每个都在消耗排期余量`,
      params: { count: input.blockedTasks },
      delta: round(add * 100, 0),
    });
  }

  if (input.overdueDecisions > 0) {
    const add = Math.min(0.2, input.overdueDecisions * 0.1);
    risk += add;
    c.push({
      key: 'decisions',
      label: '超时决策',
      detail: `${input.overdueDecisions} 个决策已过期，下游任务动不了`,
      params: { count: input.overdueDecisions },
      delta: round(add * 100, 0),
    });
  }

  if (input.flow.reworkRate !== null && input.flow.reworkRate > 0.15) {
    const add = Math.min(0.15, (input.flow.reworkRate - 0.15) * 0.6);
    risk += add;
    c.push({
      key: 'rework',
      label: '返工率',
      detail: `${Math.round(input.flow.reworkRate * 100)}% 的任务被打回过，实际工作量高于表面`,
      params: { pct: Math.round(input.flow.reworkRate * 100) },
      delta: round(add * 100, 0),
    });
  }

  if (input.agentSuccessRate !== null && input.agentSuccessRate < 0.85) {
    const add = Math.min(0.15, (0.85 - input.agentSuccessRate) * 0.6);
    risk += add;
    c.push({
      key: 'agent_success',
      label: 'Agent 成功率',
      detail: `${Math.round(input.agentSuccessRate * 100)}%，失败重试会吃掉时间`,
      params: { pct: Math.round(input.agentSuccessRate * 100) },
      delta: round(add * 100, 0),
    });
  }

  if (input.flow.flowEfficiency !== null && input.flow.flowEfficiency < 0.4) {
    const add = Math.min(0.15, (0.4 - input.flow.flowEfficiency) * 0.5);
    risk += add;
    c.push({
      key: 'flow_efficiency',
      label: '流动效率',
      detail: `${Math.round(input.flow.flowEfficiency * 100)}%，大部分时间在等而不是在做`,
      params: { pct: Math.round(input.flow.flowEfficiency * 100) },
      delta: round(add * 100, 0),
    });
  }

  const probability = Math.min(0.95, round(risk, 2));
  const slipDays =
    input.plannedEnd !== null && weeksNeeded !== null
      ? Math.max(
          0,
          Math.round(weeksNeeded * 7 - (input.plannedEnd - input.now) / 86_400_000),
        )
      : null;

  void cycleHours;
  return {
    level: probability >= 0.5 ? 'high' : probability >= 0.25 ? 'medium' : 'low',
    probability,
    estimatedSlipDays: slipDays,
    contributions: c.sort((a, b) => b.delta - a.delta),
  };
}

/** Progress: done / total. Deliberately not weighted by hours — hours are estimated, task counts
 *  are real / 工时是估的，任务数是真的 */
export function computeProgress(done: number, total: number): { pct: number; done: number; total: number } {
  return { pct: percent(done, total), done, total };
}
