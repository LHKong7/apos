import { AUTO_APPROVE_ACTIONS, STATUS_STAGE, Stage, type ActionType } from '@apos/contracts';
import { HOUR, percent, ratio, round, stat } from './stats';
import { bucketOf, overlapMs, statusAt, type Segment } from './timeline';
import type { AnalyticsInput, DecisionRow, HitlMetrics, RepeatedDecision } from './types';

/** Reason categories for a manual override, mirroring the board's ManualMoveDialog one for one */
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
 * Chinese names for decision types. An unknown type is shown verbatim; nothing is guessed.
 *
 * ★ This table must cover every value decisionTypeFor() (apps/api flow/transition.ts) actually
 *   emits. It used to follow the page doc's vocabulary while the runtime emitted a different
 *   set — so the Decision Center and the "repeated decisions" panel in Analytics spent a long
 *   time printing bare keys such as high_risk_operation. Add a type in both places at once.
 *
 *   这份表必须覆盖 decisionTypeFor() 实际产出的每一个值，加类型时两边一起改。
 */
const DECISION_LABELS: Record<string, string> = {
  // What the runtime actually emits (decided by decisionTypeFor once a policy matches)
  high_risk_operation: '高风险操作审批',
  release_approval: '发布审批',
  budget_overrun: '预算超限',
  agent_failure: 'Agent 连续失败',
  approval: '人工审批',
  // Intake paths and historical data
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
 * Human-in-the-Loop (page doc 12 §5.5 / product doc 8.13.3).
 *
 * ★ The point of this tab is "repeated decisions → automation potential". Every other number
 *   describes the status quo; only this section tells the user what they could stop doing, and
 *   hands them a one-click entry point to create the rule. This is the flywheel by which the
 *   product keeps lowering the human burden.
 *
 *   其余数字都在描述现状，只有这一块告诉用户「你可以少做哪些事」。
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

  // Overdue: past dueAt and still unresolved, or resolved after the deadline had passed
  const overdue = inWindow.filter(
    (d) => d.dueAt !== null && (d.resolvedAt ?? now) > d.dueAt,
  ).length;

  // ── Automation rate ──
  const evals = policyEvals.filter((p) => p.at >= window.from && p.at <= window.to);
  const autoPassed = evals.filter((p) => AUTO.has(p.action)).length;

  // ── Hours blocked while waiting on a human ──
  let blockedByHumanHours = 0;
  for (const list of segments.values()) {
    for (const s of list) {
      if (bucketOf(s.status) !== 'decision_wait') continue;
      blockedByHumanHours += overlapMs(s, window, now) / HOUR;
    }
  }

  // ── Human involvement by stage ──
  // Denominator: work items that passed through the stage inside the window. Numerator: those
  // among them that needed a human decision. Intake is naturally near 100% (a requirement has to
  // be confirmed by a person); the lower Execution is, the better.
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
   * ★ A decision is attributed to the stage the work item was in **when it happened**, not to the
   *   stage the item is in now.
   *
   *   Bucketing by current status puts every completed item under `done`, leaving the chart with
   *   only the unfinished few — an analysis that empties out the more the project succeeds, and
   *   for no reason a reader could ever reconstruct. Replaying the timeline gives the right
   *   answer.
   *
   *   按当前状态归类的话，图会越用越空，而且空得毫无道理可言。
   */
  const decidedPerStage = new Map<Stage, Set<string>>();
  for (const d of inWindow) {
    if (!d.workItemId) continue;
    const list = segments.get(d.workItemId);
    // Step back 1ms: at the instant the decision is created the item flips into
    // awaiting_decision, and this chart asks which stage the decision was raised *from*
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

  // ── Response time distribution ──
  const responseBuckets = RESPONSE_BUCKETS.map((b, i) => {
    const min = i === 0 ? 0 : RESPONSE_BUCKETS[i - 1]!.max;
    const inBucket = resolved.filter((d) => {
      const hours = (d.resolvedAt! - d.createdAt) / HOUR;
      return hours >= min && hours < b.max;
    });
    // If the slowest bucket holds only one kind of decision, name it — the single most
    // actionable sentence on this tab
    const types = new Set(inBucket.map((d) => d.type));
    /**
     * ★ Emit both the type code and the Chinese wording: the UI resolves copy from the code (the
     *   `decision.type.*` messages already exist), while the `slowest` sentence stays as the
     *   fallback for logs and for any UI that does not recognize the code.
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

  // ── Manual override reasons ──
  const overridesInWindow = overrides.filter((o) => o.at >= window.from && o.at <= window.to);
  const reasonCounts = new Map<string, number>();
  for (const o of overridesInWindow) {
    // No category ≠ the user picked "other". The first means this code path never collected a
    // category; the second is a choice the user made. Merging them puts "other" permanently at
    // the top of the list — and "other" is the least informative bucket there is
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
 * Repeated decisions and their automation potential.
 *
 * ★ The test has to look at **count** and **outcome consistency** together.
 *   Count alone would recommend automating "reviewed 12 times, approved 7, rejected 5" — exactly
 *   the kind of decision that most needs a human, and automating it manufactures incidents.
 *   Only high consistency shows the judgment is stable enough to be written as a rule.
 *
 *   只看次数会把「批了 7 次驳了 5 次」也推荐规则化，而那种决策恰恰最需要人。
 */
function findRepeated(decisions: DecisionRow[]): RepeatedDecision[] {
  /** Below this count there is no "repetition" to speak of */
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
