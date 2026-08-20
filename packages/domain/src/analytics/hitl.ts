import { AUTO_APPROVE_ACTIONS, STATUS_STAGE, Stage, type ActionType } from '@apos/contracts';
import { HOUR, percent, ratio, round, stat } from './stats';
import { bucketOf, overlapMs, statusAt, type Segment } from './timeline';
import type { AnalyticsInput, DecisionRow, HitlMetrics, RepeatedDecision } from './types';

/** 人工覆盖的原因分类，与看板的 ManualMoveDialog 一一对应 */
const OVERRIDE_LABELS: Record<string, string> = {
  review_found_issue: '审核发现问题，需返工',
  requirement_changed: '需求变更',
  system_misjudged: '系统状态判断有误',
  other: '其他',
  uncategorized: '未分类（该操作没有收集原因分类）',
};

const AUTO = new Set<string>(AUTO_APPROVE_ACTIONS as readonly ActionType[]);

const RESPONSE_BUCKETS = [
  { label: '< 1h', max: 1 },
  { label: '1–4h', max: 4 },
  { label: '4–8h', max: 8 },
  { label: '> 8h', max: Infinity },
] as const;

/**
 * 决策类型的中文名。未知类型直接显示原值，不猜。
 *
 * ★ 这份表必须覆盖 decisionTypeFor()（apps/api flow/transition.ts）实际产出的每一个值。
 *   之前它只按页面文档的词汇写，而运行时发出的是另一套 —— 结果
 *   决策中心和 Analytics 的「重复决策」面板上印的一直是 high_risk_operation
 *   这样的裸 key。加类型时两边一起改。
 */
const DECISION_LABELS: Record<string, string> = {
  // 运行时实际产出（policy 命中后由 decisionTypeFor 决定）
  high_risk_operation: '高风险操作审批',
  release_approval: '发布审批',
  budget_overrun: '预算超限',
  agent_failure: 'Agent 连续失败',
  approval: '人工审批',
  // 入口链路与历史数据
  plan_approval: '计划批准',
  requirement_approval: '需求确认',
  test_env_release: '测试环境发布审批',
  db_change: '数据库变更审批',
  risk_review: '风险评审',
  cost_overrun: '成本超限',
  scope_change: '范围变更',
  decision_required: '执行中转人工',
};

export function decisionLabel(type: string): string {
  return DECISION_LABELS[type] ?? type;
}

/**
 * Human-in-the-Loop（页面文档 12 §5.5 / 产品文档 8.13.3）。
 *
 * ★ 这个 Tab 的落点是「重复决策 → 可自动化潜力」。
 *   其余数字都在描述现状，只有这一块告诉用户「你可以少做哪些事」，
 *   并且给出一键创建规则的入口。产品持续降低人类负担的飞轮就在这里。
 */
export function computeHitl(
  input: AnalyticsInput,
  segments: Map<string, Segment[]>,
  now: number,
): HitlMetrics {
  const { window, decisions, overrides, policyEvals, items } = input;
  const inWindow = decisions.filter((d) => d.createdAt >= window.from && d.createdAt <= window.to);
  const resolved = inWindow.filter((d) => d.resolvedAt !== null);

  const resolutionTime = stat(
    resolved.map((d) => ({
      value: (d.resolvedAt! - d.createdAt) / HOUR,
      itemId: d.workItemId ?? d.id,
    })),
  );

  // 超时：已过 dueAt 仍未解决，或解决时已经晚了
  const overdue = inWindow.filter(
    (d) => d.dueAt !== null && (d.resolvedAt ?? now) > d.dueAt,
  ).length;

  // ── 自动化率 ──
  const evals = policyEvals.filter((p) => p.at >= window.from && p.at <= window.to);
  const autoPassed = evals.filter((p) => AUTO.has(p.action)).length;

  // ── 等待人类造成的阻塞时长 ──
  let blockedByHumanHours = 0;
  for (const list of segments.values()) {
    for (const s of list) {
      if (bucketOf(s.status) !== 'decision_wait') continue;
      blockedByHumanHours += overlapMs(s, window, now) / HOUR;
    }
  }

  // ── 各阶段人类介入比例 ──
  // 分母是「窗口内经过该阶段的任务数」，分子是「其中需要人做决定的任务数」。
  // Intake 天然接近 100%（需求必须人确认），Execution 越低越好。
  const itemsPerStage = new Map<Stage, Set<string>>();
  for (const [itemId, list] of segments) {
    for (const s of list) {
      if (overlapMs(s, window, now) === 0) continue;
      const stage = STATUS_STAGE[s.status];
      let set = itemsPerStage.get(stage);
      if (!set) itemsPerStage.set(stage, (set = new Set()));
      set.add(itemId);
    }
  }
  /**
   * ★ 决策归到「它发生时任务所在的阶段」，不是任务现在的阶段。
   *
   *   按当前状态归类的话，所有已完成的任务都算 done，
   *   于是整张图只剩下还没做完的那几项 —— 一个越用越空的分析图，
   *   而且空得毫无道理可言。用时间线回溯当时的状态才对得上。
   */
  const decidedPerStage = new Map<Stage, Set<string>>();
  for (const d of inWindow) {
    if (!d.workItemId) continue;
    const list = segments.get(d.workItemId);
    // 往前挪 1ms：决策创建的那一刻任务正好切进 awaiting_decision，
    // 而这张图问的是「这个决策是从哪个阶段抛出来的」
    const at = list ? statusAt(list, d.createdAt - 1, now) : null;
    const stage = at ? STATUS_STAGE[at] : d.stage;
    if (!stage) continue;
    let set = decidedPerStage.get(stage);
    if (!set) decidedPerStage.set(stage, (set = new Set()));
    set.add(d.workItemId);
  }

  const byStage = Stage.options
    .filter((s) => s !== 'done')
    .map((stage) => {
      const total = itemsPerStage.get(stage)?.size ?? 0;
      const decided = decidedPerStage.get(stage)?.size ?? 0;
      return { stage, decisions: decided, items: total, percent: percent(decided, total) };
    })
    .filter((row) => row.items > 0);

  // ── 响应时间分布 ──
  const responseBuckets = RESPONSE_BUCKETS.map((b, i) => {
    const min = i === 0 ? 0 : RESPONSE_BUCKETS[i - 1]!.max;
    const inBucket = resolved.filter((d) => {
      const hours = (d.resolvedAt! - d.createdAt) / HOUR;
      return hours >= min && hours < b.max;
    });
    // 最慢那一档里如果只有一类决策，直接点名 —— 这是最有行动价值的一句话
    const types = new Set(inBucket.map((d) => d.type));
    /**
     * ★ 同时给类型码和中文说法：界面按码取词（`decision.type.*` 那组词条
     *   本来就有），`slowest` 那句中文留给日志与认不出码的界面兜底。
     */
    const onlyType =
      b.max === Infinity && inBucket.length > 0 && types.size === 1 ? [...types][0]! : null;
    return {
      label: b.label,
      count: inBucket.length,
      slowestType: onlyType,
      slowest: onlyType === null ? null : decisionLabel(onlyType),
    };
  });

  // ── 人工覆盖原因 ──
  const overridesInWindow = overrides.filter((o) => o.at >= window.from && o.at <= window.to);
  const reasonCounts = new Map<string, number>();
  for (const o of overridesInWindow) {
    // 没有分类 ≠ 用户选了「其他」。前者是这条路径没收集分类，
    // 后者是用户主动归的类 —— 混在一起会让「其他」永远排第一，
    // 而那恰恰是最没有信息量的一档
    reasonCounts.set(o.category ?? 'uncategorized', (reasonCounts.get(o.category ?? 'uncategorized') ?? 0) + 1);
  }
  const overrideReasons = [...reasonCounts.entries()]
    .map(([category, count]) => ({
      category,
      label: OVERRIDE_LABELS[category] ?? category,
      count,
      percent: percent(count, overridesInWindow.length),
    }))
    .sort((a, b) => b.count - a.count);

  void items;
  return {
    totalDecisions: inWindow.length,
    resolved: resolved.length,
    resolutionTime,
    overdue,
    automationRate: ratio(autoPassed, evals.length),
    autoPassed,
    policyEvaluations: evals.length,
    overrides: overridesInWindow.length,
    blockedByHumanHours: round(blockedByHumanHours),
    byStage,
    responseBuckets,
    repeated: findRepeated(inWindow),
  overrideReasons,
  };
}

/**
 * 重复决策与可自动化潜力。
 *
 * ★ 判据必须同时看**次数**和**结果一致性**。
 *   只看次数会把「审了 12 次、批了 7 次驳了 5 次」也推荐规则化 ——
 *   那种决策恰恰最需要人，自动化了就是在制造事故。
 *   一致性高才说明这个判断稳定到可以写成规则。
 */
function findRepeated(decisions: DecisionRow[]): RepeatedDecision[] {
  /** 少于这个次数谈不上「重复」 */
  const MIN_COUNT = 3;

  const byType = new Map<string, DecisionRow[]>();
  for (const d of decisions) {
    const list = byType.get(d.type);
    if (list) list.push(d);
    else byType.set(d.type, [d]);
  }

  const out: RepeatedDecision[] = [];
  for (const [type, list] of byType) {
    if (list.length < MIN_COUNT) continue;
    const settled = list.filter((d) => d.status === 'approved' || d.status === 'rejected');
    if (settled.length === 0) continue;

    const approved = settled.filter((d) => d.status === 'approved').length;
    const consistency = Math.max(approved, settled.length - approved) / settled.length;
    const waits = settled
      .filter((d) => d.resolvedAt !== null)
      .map((d) => (d.resolvedAt! - d.createdAt) / HOUR);

    out.push({
      type,
      label: decisionLabel(type),
      count: list.length,
      consistency: round(consistency, 2),
      approvedCount: approved,
      potential: potentialOf(settled.length, consistency),
      avgWaitHours: waits.length > 0 ? round(waits.reduce((a, b) => a + b, 0) / waits.length) : 0,
    });
  }

  return out.sort((a, b) => b.count - a.count).slice(0, 3);
}

function potentialOf(count: number, consistency: number): RepeatedDecision['potential'] {
  if (count >= 5 && consistency >= 0.95) return 'high';
  if (count >= 3 && consistency >= 0.8) return 'medium';
  return 'low';
}

export { OVERRIDE_LABELS };
