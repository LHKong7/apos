import { percent, round } from './stats';
import type { FlowMetrics, HitlMetrics } from './types';

/**
 * 项目健康度与延期预测（页面文档 02 §5.2，产品文档 8.13.4 / 8.6.6）。
 *
 * ★ 这两个数字最容易变成「玄学分数」。用户看到「健康度 62」的第一反应是
 *   「凭什么」——答不上来他就不会据此做任何事，这张卡片也就成了装饰。
 *   所以两者都必须逐项给出**贡献度**：哪几项拉低了分、各拉低多少。
 *   一个说不清来源的预测，比没有预测更糟：它会被当成事实引用。
 */

export interface Contribution {
  /**
   * 这一项是什么 / What this contribution is.
   *
   * ★★ 界面按它取词（`analytics.health.<key>` / `analytics.delay.<key>`），
   *   而不是画 `label` 与 `detail` —— 那两个字段是中文。
   *   同一个 key 在健康度与延期预测里说的是两句不同的话，所以命名空间
   *   由调用方给：这一层只保证「同一个命名空间下，一个 key 一句话」。
   *
   *   The UI resolves copy from this key. A key means one sentence within a
   *   namespace, which is why the two computations namespace theirs apart.
   */
  key: string;
  /**
   * 中文说法 / Chinese prose.
   *
   * ★ 留着是给日志、导出与认不出 key 的界面兜底用的 —— 界面读码，日志读句子。
   *   删掉它会让「服务端算出了什么」在日志里彻底不可读。
   */
  label: string;
  /** 该项的原始表现，用人话写。同上，是兜底不是显示源 */
  detail: string;
  /**
   * `detail` 那句话里的数字 / The numbers `detail` interpolates.
   *
   * ★★ 没有它，界面就只能画那句中文。`detail` 里的百分比、任务数、周数
   *   都是算出来的，英文句子要用同一批数字重新组织语序 ——
   *   把它们从句子里再解析出来是不可能的，所以必须原样带出来。
   */
  params: Record<string, string | number>;
  /** 对总分的影响，负数是扣分 */
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
  /** 预计比计划晚多少天；null = 没有排期基准，给不出天数 */
  estimatedSlipDays: number | null;
  contributions: Contribution[];
}

export interface HealthInput {
  flow: FlowMetrics;
  hitl: HitlMetrics;
  /** Agent 加权平均成功率；null = 窗口内没有执行记录 */
  agentSuccessRate: number | null;
  totalTasks: number;
  doneTasks: number;
  blockedTasks: number;
  overdueDecisions: number;
  tokensSpent: number;
  tokenBudget: number | null;
}

/**
 * 健康度 = 100 分起扣。
 *
 * ★ 用扣分制而不是加权平均，是为了让「为什么不是 100」有直接答案。
 *   加权平均能算出同样的数字，但拆不出「这 38 分是被谁扣掉的」——
 *   而用户唯一关心的就是这个。
 */
export function computeHealth(input: HealthInput): Health {
  const c: Contribution[] = [];

  // 流动效率：本产品最核心的主张，权重也最大
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

  // 阻塞
  if (input.blockedTasks > 0) {
    c.push({
      key: 'blocked',
      label: '阻塞任务',
      detail: `${input.blockedTasks} 个任务卡住`,
      params: { count: input.blockedTasks },
      delta: -Math.min(20, input.blockedTasks * 7),
    });
  }

  // 超时决策 —— 直接指向「人没跟上」，扣得重
  if (input.overdueDecisions > 0) {
    c.push({
      key: 'overdue_decisions',
      label: '超时决策',
      detail: `${input.overdueDecisions} 个决策已过期未处理`,
      params: { count: input.overdueDecisions },
      delta: -Math.min(20, input.overdueDecisions * 10),
    });
  }

  // 返工
  if (input.flow.reworkRate !== null && input.flow.reworkRate > 0.15) {
    c.push({
      key: 'rework',
      label: '返工率',
      detail: `${Math.round(input.flow.reworkRate * 100)}%，高于 15% 的经验阈值`,
      params: { pct: Math.round(input.flow.reworkRate * 100) },
      delta: -Math.min(15, Math.round((input.flow.reworkRate - 0.15) * 60)),
    });
  }

  // Agent 成功率
  if (input.agentSuccessRate !== null && input.agentSuccessRate < 0.85) {
    c.push({
      key: 'agent_success',
      label: 'Agent 成功率',
      detail: `${Math.round(input.agentSuccessRate * 100)}%，低于 85%`,
      params: { pct: Math.round(input.agentSuccessRate * 100) },
      delta: -Math.min(15, Math.round((0.85 - input.agentSuccessRate) * 60)),
    });
  }

  // 预算
  if (input.tokenBudget !== null && input.tokenBudget > 0) {
    const used = input.tokensSpent / input.tokenBudget;
    const doneRatio = input.totalTasks > 0 ? input.doneTasks / input.totalTasks : 0;
    // 配额用得比活干得快才扣分 —— 单纯「用了很多」不是问题
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
  /** 项目计划完成日（毫秒）；null = 没排期 */
  plannedEnd: number | null;
  now: number;
}

/**
 * 延期风险（产品文档 8.6.6）。
 *
 * 输入是七项：剩余工作量、历史周期时间、Agent 成功率、阻塞任务数、
 * 决策等待、返工率、排期余量。每一项都给出它把概率推高了多少 ——
 * 页面文档 §5.2 明确要求「用户必须能看懂预测是怎么来的，否则不会信任它」。
 *
 * ★ 这不是一个统计模型，是一组显式的经验规则。
 *   把它包装成「AI 预测」会让人以为背后有什么了不起的东西；
 *   如实说是经验规则，用户反而知道该怎么读它、什么时候该忽略它。
 */
export function predictDelay(input: DelayInput): DelayRisk {
  const c: Contribution[] = [];
  let risk = 0.1; // 任何项目都有基础风险

  const cycleHours = input.flow.cycleTime.median || 8;
  const throughputPerWeek = input.flow.throughputPerWeek || 0;

  // 剩余工作量 vs 吞吐
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
        * ★ 与下面那条分开成两个 key。同一个 key 底下不能有两句不同的话 ——
        *   界面按 key 取词，一个 key 对应两句就只能取到其中一句。
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
    // 没有吞吐数据时不硬编一个数，只如实说算不出来
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

/** 进度：完成数 / 总数。刻意不按工时加权 —— 工时是估的，任务数是真的。 */
export function computeProgress(done: number, total: number): { pct: number; done: number; total: number } {
  return { pct: percent(done, total), done, total };
}
