import { round } from './stats';
import { formatHours } from '../graph/critical-path';
import { formatTokens } from '../format/tokens';
import type {
  AgentMetrics,
  CostMetrics,
  FlowMetrics,
  HitlMetrics,
  Insight,
  InsightAction,
} from './types';

/**
 * 系统发现（页面文档 12 §5.1）—— 本页最重要的区域。
 *
 * ★ 这是把数据变成行动的桥梁，也是整页唯一能被「采纳」的东西。
 *   两条硬规矩：
 *   1. 每条发现都必须带动作。只说「决策等待占 34%」不说「去哪儿改」的提示，
 *      用户看两次就会忽略整个区域。
 *   2. 必须包含正面发现。只报坏消息的分析页会被用户回避 —— 一个没人看的
 *      分析页，比没有分析页更糟，因为它让人以为这件事已经有人在管了。
 *
 * ★ 关于阈值：下面这些数字来自页面文档 §5.1 的判据表，是产品设定的经验值，
 *   不是行业统计（§12.2 把「基准值从哪来」列为待确认）。
 *   所以每条发现都把判据本身写进 evidence，让用户能反驳，而不是只能相信。
 */

export interface InsightInput {
  flow: FlowMetrics;
  agent: AgentMetrics;
  hitl: HitlMetrics;
  cost: CostMetrics;
  previous: {
    flow: FlowMetrics;
    agent: AgentMetrics;
    cost: CostMetrics;
  } | null;
  /**
   * 中文的区间说法（「近 7 天」）—— 只进 `evidence` 那句中文兜底。
   * Chinese-only; feeds the fallback prose, never the params.
   */
  rangeLabel: string;
  /**
   * ★★ 区间的**天数**。
   *
   *   `rangeLabel` 是一句中文，把它当参数插进英文句子会得到
   *   "over the 近 7 天" —— 句子翻了，塞进去的词没翻。
   *   参数一律送语言中立的值，由词条自己说「last {days} days」。
   */
  rangeDays: number;
}

const DECISION_WAIT_SHARE = 0.25;
const REWORK_RATE = 0.15;
const AGENT_REGRESSION = 0.1;
const COST_INCREASE = 0.3;
const WIP_GROWTH = 1.5;
/** 环比改善到这个幅度才值得说一句，否则是噪声 */
const IMPROVEMENT = 0.15;

export function findInsights(input: InsightInput): Insight[] {
  const out: Insight[] = [];
  const { flow, agent, hitl, cost, previous } = input;

  // ── 决策等待瓶颈 ──
  const totalTracked = flow.activeHours + flow.waitingHours;
  const waitShare = totalTracked > 0 ? flow.decisionWaitHours / totalTracked : 0;
  if (waitShare > DECISION_WAIT_SHARE) {
    const top = hitl.repeated[0];
    const actions: InsightAction[] = [
      { kind: 'view_tab', code: 'view_hitl_tab', label: '看决策分析', tab: 'hitl' },
    ];
    if (top && top.potential !== 'low') {
      actions.unshift({
        kind: 'create_policy',
        code: 'create_policy_for',
        params: { name: top.label },
        label: `把「${top.label}」规则化`,
        ref: top.type,
      });
    }
    /**
     * ★★ 「有重复决策」和「没有」是两条码，不是一条码加一个可选从句。
     *
     *   原来那句 evidence 是四段拼起来的，中间那段带条件。英文里这个
     *   从句要换位置、还要换标点 —— 拼出来的句子只在写它的那种语言里成立。
     */
    out.push({
      type: 'decision_bottleneck',
      code: top ? 'decision_bottleneck_repeated' : 'decision_bottleneck',
      severity: waitShare > 0.4 ? 'critical' : 'warning',
      message: `等待人类决策占了总周期的 ${pct(waitShare)}，是最大的时间损耗`,
      evidence:
        `${input.rangeLabel}内等待决策 ${formatHours(flow.decisionWaitHours)}，` +
        `有效工作 ${formatHours(flow.activeHours)}` +
        (top ? `；其中「${top.label}」出现 ${top.count} 次` : '') +
        `。判据：超过 ${pct(DECISION_WAIT_SHARE)} 即提示`,
      params: {
        share: pct(waitShare),
        days: input.rangeDays,
        waiting: formatHours(flow.decisionWaitHours),
        active: formatHours(flow.activeHours),
        threshold: pct(DECISION_WAIT_SHARE),
        ...(top ? { topName: top.label, topCount: top.count } : {}),
      },
      actions,
    });
  }

  // ── 可自动化的重复决策 ──
  // 即使等待没超阈值也值得提 —— 它是持续降低人类负担的飞轮
  const candidate = hitl.repeated.find((r) => r.potential === 'high');
  if (candidate && waitShare <= DECISION_WAIT_SHARE) {
    out.push({
      type: 'automation_candidate',
      code: 'automation_candidate',
      severity: 'warning',
      message: `「${candidate.label}」${candidate.count} 次决策结果高度一致，可以规则化`,
      evidence: `其中 ${candidate.approvedCount} 次批准，一致性 ${pct(candidate.consistency)}，平均等待 ${formatHours(candidate.avgWaitHours)}`,
      params: {
        name: candidate.label,
        count: candidate.count,
        approved: candidate.approvedCount,
        consistency: pct(candidate.consistency),
        avgWait: formatHours(candidate.avgWaitHours),
      },
      actions: [
        { kind: 'create_policy', code: 'create_policy', label: '创建规则', ref: candidate.type },
        { kind: 'view_tab', code: 'view_hitl_tab', label: '看决策分析', tab: 'hitl' },
      ],
    });
  }

  // ── 返工率 ──
  if (flow.reworkRate !== null && flow.reworkRate > REWORK_RATE) {
    out.push({
      type: 'rework_high',
      code: 'rework_high',
      severity: 'warning',
      message: `返工率 ${pct(flow.reworkRate)}，${flow.reworkedItems} 个任务被打回或失败过`,
      evidence: `返工通常指向验收标准不清或需求本身有歧义，不是执行问题。判据：超过 ${pct(REWORK_RATE)} 即提示`,
      params: {
        rate: pct(flow.reworkRate),
        count: flow.reworkedItems,
        threshold: pct(REWORK_RATE),
      },
      actions: [{ kind: 'view_items', code: 'view_reworked_items', label: '看返工的任务' }],
    });
  }

  // ── Agent 表现回退 ──
  if (previous) {
    const before = new Map(previous.agent.agents.map((a) => [a.agentId, a]));
    for (const now of agent.agents) {
      const then = before.get(now.agentId);
      if (!then || then.runs < 5 || now.runs < 5) continue;
      const drop = then.successRate - now.successRate;
      if (drop >= AGENT_REGRESSION) {
        out.push({
          type: 'agent_regression',
          severity: 'critical',
          code: 'agent_regression',
          message: `${now.name} 成功率从 ${pct(then.successRate)} 降到 ${pct(now.successRate)}`,
          evidence: `本期 ${now.runs} 次执行，首次成功率 ${pct(now.firstTrySuccessRate)}。判据：环比下降超过 ${pct(AGENT_REGRESSION)}`,
          params: {
            name: now.name,
            was: pct(then.successRate),
            now: pct(now.successRate),
            runs: now.runs,
            firstTry: pct(now.firstTrySuccessRate),
            threshold: pct(AGENT_REGRESSION),
          },
          actions: [
            { kind: 'view_agent', code: 'view_agent', label: '下钻这个 Agent', ref: now.agentId },
          ],
        });
        break;
      }
    }
  }

  // ── Agent 横向差距 ──
  if (agent.dominance) {
    out.push({
      type: 'improvement',
      severity: 'warning',
      code: 'agent_dominance',
      message: `${agent.dominance.betterName} 在成功率、token 用量、耗时上全面优于 ${agent.dominance.worseName}`,
      evidence: '三项指标同时更优才会给出这条建议，只赢一两项属于权衡，不做推荐',
      params: { better: agent.dominance.betterName, worse: agent.dominance.worseName },
      actions: [{ kind: 'view_tab', code: 'view_agent_tab', label: '看 Agent 对比', tab: 'agent' }],
    });
  }

  // ── 用量效率 ──
  if (previous && cost.perDelivered !== null && previous.cost.perDelivered !== null) {
    const growth = cost.perDelivered / previous.cost.perDelivered - 1;
    if (growth > COST_INCREASE) {
      out.push({
        type: 'cost_efficiency',
        severity: 'warning',
        code: 'cost_efficiency',
        message: `单位交付用量环比上升 ${pct(growth)}（${formatTokens(previous.cost.perDelivered)} → ${formatTokens(cost.perDelivered)} token）`,
        evidence: `本期完成 ${cost.delivered} 项，共 ${formatTokens(cost.total)} token。判据：环比上升超过 ${pct(COST_INCREASE)}`,
        params: {
          growth: pct(growth),
          was: formatTokens(previous.cost.perDelivered),
          now: formatTokens(cost.perDelivered),
          delivered: cost.delivered,
          total: formatTokens(cost.total),
          threshold: pct(COST_INCREASE),
        },
        actions: [{ kind: 'view_cost', code: 'view_cost_breakdown', label: '看用量构成' }],
      });
    }
  }

  // ── WIP 堆积 ──
  // 判据是「进得比出得快」，不是「WIP 高」—— 高而稳定的 WIP 没有问题
  const wip = flow.wipTrend;
  if (wip.length >= 3) {
    const first = wip[0]!.value;
    const last = wip[wip.length - 1]!.value;
    if (first > 0 && last / first >= WIP_GROWTH && last - first >= 2) {
      out.push({
        type: 'wip_pileup',
        severity: 'warning',
        code: 'wip_pileup',
        message: `在制品从 ${first} 涨到 ${last}，进得比出得快`,
        evidence: `同期吞吐 ${flow.throughputPerWeek} 项/周。堆积会拉长每一项的等待时间，先看是哪个阶段卡住`,
        params: { from: first, to: last, throughput: flow.throughputPerWeek },
        actions: [{ kind: 'view_items', code: 'view_wip_items', label: '看在制任务' }],
      });
    }
  }

  // ── 正面发现 ──
  // ★ 必须有。这不是为了讨好用户，是为了让这一页被继续打开：
  //   一个只会报警的页面，用户第三次就不点了。
  const good = findImprovement(input);
  if (good) out.push(good);

  return out.sort(bySeverity);
}

function findImprovement(input: InsightInput): Insight | null {
  const { flow, hitl, cost, previous, rangeLabel, rangeDays } = input;

  if (previous) {
    /**
     * ★★ 每个候选自带码。`improvement` 这个 type 底下有五句完全不同的话，
     *   界面按 type 取词只会取到其中一句 —— 而且必然是错的那四句之一。
     */
    const cands: {
      code: string;
      message: string;
      evidence: string;
      params: Record<string, string | number>;
    }[] = [];

    if (flow.flowEfficiency !== null && previous.flow.flowEfficiency !== null) {
      const gain = flow.flowEfficiency - previous.flow.flowEfficiency;
      if (gain >= IMPROVEMENT * previous.flow.flowEfficiency && gain > 0.02) {
        cands.push({
          code: 'improvement_flow_efficiency',
          message: `流动效率从 ${pct(previous.flow.flowEfficiency)} 提升到 ${pct(flow.flowEfficiency)}`,
          evidence: '等待时间的占比在下降，说明卡点确实被解开了 —— 这是本产品最该改善的指标',
          params: { was: pct(previous.flow.flowEfficiency), now: pct(flow.flowEfficiency) },
        });
      }
    }

    if (previous.flow.leadTime.median > 0 && flow.leadTime.count > 0) {
      const cut = 1 - flow.leadTime.median / previous.flow.leadTime.median;
      if (cut >= IMPROVEMENT) {
        cands.push({
          code: 'improvement_lead_time',
          message: `前置时间中位数缩短 ${pct(cut)}（${formatHours(previous.flow.leadTime.median)} → ${formatHours(flow.leadTime.median)}）`,
          evidence: `本期完成 ${flow.completed} 项。用中位数比较，不受个别超长任务影响`,
          params: {
            cut: pct(cut),
            was: formatHours(previous.flow.leadTime.median),
            now: formatHours(flow.leadTime.median),
            completed: flow.completed,
          },
        });
      }
    }

    if (cost.perDelivered !== null && previous.cost.perDelivered !== null) {
      const cut = 1 - cost.perDelivered / previous.cost.perDelivered;
      if (cut >= IMPROVEMENT) {
        cands.push({
          code: 'improvement_cost',
          message: `单位交付用量下降 ${pct(cut)}（${formatTokens(previous.cost.perDelivered)} → ${formatTokens(cost.perDelivered)} token）`,
          evidence: `本期完成 ${cost.delivered} 项，共 ${formatTokens(cost.total)} token`,
          params: {
            cut: pct(cut),
            was: formatTokens(previous.cost.perDelivered),
            now: formatTokens(cost.perDelivered),
            delivered: cost.delivered,
            total: formatTokens(cost.total),
          },
        });
      }
    }

    if (cands[0]) {
      return { type: 'improvement', severity: 'good', ...cands[0], actions: [] };
    }
  }

  // 没有上期可比时，用绝对值里够好的那个说一句，别让这块空着
  if (hitl.automationRate !== null && hitl.automationRate >= 0.6) {
    return {
      type: 'improvement',
      code: 'improvement_automation_rate',
      severity: 'good',
      message: `${pct(hitl.automationRate)} 的流转由规则自动放行，没有打扰任何人`,
      evidence: `${rangeLabel}内 ${hitl.policyEvaluations} 次策略评估，${hitl.autoPassed} 次自动通过`,
      params: {
        rate: pct(hitl.automationRate),
        days: rangeDays,
        evaluations: hitl.policyEvaluations,
        autoPassed: hitl.autoPassed,
      },
      actions: [],
    };
  }
  if (flow.flowEfficiency !== null && flow.flowEfficiency >= 0.5) {
    return {
      type: 'improvement',
      code: 'improvement_flow_efficiency_absolute',
      severity: 'good',
      message: `流动效率 ${pct(flow.flowEfficiency)}，一半以上的时间真的在推进工作`,
      evidence: `有效工作 ${formatHours(flow.activeHours)}，等待 ${formatHours(flow.waitingHours)}`,
      params: {
        rate: pct(flow.flowEfficiency),
        active: formatHours(flow.activeHours),
        waiting: formatHours(flow.waitingHours),
      },
      actions: [],
    };
  }
  return null;
}

const ORDER = { critical: 0, warning: 1, good: 2 } as const;
function bySeverity(a: Insight, b: Insight): number {
  return ORDER[a.severity] - ORDER[b.severity];
}

function pct(v: number): string {
  return `${round(v * 100, 0)}%`;
}

