import type { Stage, WorkItemStatus } from '@apos/contracts';

/**
 * Input and output types for Analytics / Analytics 的输入与输出类型。
 *
 * Every input is a row that has already been read out of the database; nothing here carries a
 * Drizzle or SQL concept. Metric computation is a pure function and can be tested without a
 * database. See 12 Project Analytics §9.
 *
 * 输入一律是「已经从库里读出来的行」，指标计算是纯函数，能脱库测试。
 */

export const ANALYTICS_RANGES = ['7d', '30d', '90d'] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

export const RANGE_DAYS: Record<AnalyticsRange, number> = { '7d': 7, '30d': 30, '90d': 90 };

export const ANALYTICS_TABS = ['flow', 'agent', 'hitl', 'cost', 'quality', 'benefit'] as const;
export type AnalyticsTab = (typeof ANALYTICS_TABS)[number];

/** Times are millisecond timestamps throughout, so Date never smuggles a time zone into a pure
 *  function / 避免 Date 在纯函数里带时区歧义 */
export interface Window {
  from: number;
  to: number;
}

// ── Input rows / 输入行 ───────────────────────────────────────────────────

export interface StatusChange {
  itemId: string;
  from: WorkItemStatus | null;
  to: WorkItemStatus;
  at: number;
}

export interface ItemRow {
  id: string;
  title: string;
  type: string;
  status: WorkItemStatus;
  riskLevel: string;
  createdAt: number;
  actualStart: number | null;
  actualEnd: number | null;
  /** null means the plan carries no due date — on-time delivery shows "not wired up", never 0
   *  计划里没排期时显示「未接入」而不是 0 */
  plannedEnd: number | null;
  actualTokens: number;
  /**
   * The "is blocked" marker. This is a different thing from the `blocked` status: a card sitting
   * in `ready` can also carry the marker (waiting on an external dependency), and the board's
   * "⛔ N blocked" count reads exactly this field. Blocked hours must count both, or Analytics
   * reports 0h while the board reports 1 item and the user has no idea which to believe.
   *
   * 阻塞标记与 blocked 状态是两回事，时长要把两者都算上，否则两个界面互相打架。
   */
  blockedSince: number | null;
  ownerId: string | null;
  executorType: string | null;
  executorId: string | null;
  /**
   * Quality signals flowing back from CI (typeData.qualityGate).
   *
   * ★ This field has always existed and the Policy engine has always read it, but nothing ever
   *   wrote it — that is the real reason the Quality tab could not be computed: not a hard
   *   algorithm, just no data source. Once a code repository is connected, GitHub check-runs
   *   backfill it.
   *
   *   字段一直在、Policy 一直读，但从来没有东西写过它 —— 质量 Tab 算不出来是缺数据源，
   *   不是算法难。
   */
  qualityGate?: {
    testsPassed?: boolean;
    securityScanPassed?: boolean;
    coverage?: number;
    criticalBugs?: number;
  };
}

export interface RunRow {
  id: string;
  workItemId: string;
  agentId: string;
  attempt: number;
  status: string;
  /**
   * The unit of account: the four token classes summed. Every limit, budget,
   * and cost metric reads this one field.
   *
   * 记账单位：四类 token 相加。所有上限、预算、成本指标都读这一个。
   */
  tokens: number;
  /**
   * The runtime's settled USD figure, used **only by ROI**.
   *
   * ★ ROI subtracts agent spend from labor cost, and labor has no denomination other than
   *   money — tokens minus hours is not a quantity. Nothing else may read this field.
   *
   * 运行时结算的美元值，只有 ROI 会用：人力成本只有货币这一种单位，
   * token 减小时数没有意义。除这一处之外任何判定都不该读它。
   */
  costUsd: number;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
  errorClass: string | null;
  model: string | null;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
}

export interface DecisionRow {
  id: string;
  type: string;
  title: string;
  status: string;
  riskLevel: string;
  createdAt: number;
  resolvedAt: number | null;
  dueAt: number | null;
  workItemId: string | null;
  /** The stage the work item was in when the decision arose; feeds "human involvement by stage"
   *  用于「各阶段人类介入比例」 */
  stage: Stage | null;
}

export interface AgentRow {
  id: string;
  name: string;
  type: string;
  model: string | null;
}

/**
 * A human manually overriding the system's judgment — dragging a card on the board and being
 * forced to type a reason.
 *
 * "Taking over" in the product docs means wresting control away from a running Agent; its event
 * `work_item.taken_over` is not implemented yet. Manual override is the thing that actually
 * happens and is actually recorded today, so the metric is computed from it rather than faked
 * from a field that would always be 0.
 *
 * 手动覆盖是现在真实存在、真实被记录的那件事；「人工接管」还没实现，
 * 不拿一个永远是 0 的字段冒充。
 */
export interface OverrideRow {
  itemId: string;
  at: number;
  category: string | null;
  reason: string | null;
}

/** policy.evaluated events. Automation rate = auto-allowed / all evaluations. */
export interface PolicyEvalRow {
  at: number;
  action: string;
  itemId: string;
}

export interface AnalyticsInput {
  window: Window;
  items: ItemRow[];
  changes: StatusChange[];
  runs: RunRow[];
  decisions: DecisionRow[];
  agents: AgentRow[];
  overrides: OverrideRow[];
  policyEvals: PolicyEvalRow[];
  /** Project token budget, used for burn-down projection; null = no budget set */
  tokenBudget: number | null;
  tokensSpentTotal: number;
}

// ── Output / 输出 ────────────────────────────────────────────────────────

/**
 * ★ Median and mean are reported together.
 *   Page doc §11: "a single outlier distorts the average, so show the median alongside it".
 *   One task that ran for three days can double the average lead time across twelve tasks;
 *   showing only the mean is misleading.
 *
 *   中位数与均值一起给：单个异常值能把平均前置时间抬高一倍，只显示均值就是在误导。
 */
export interface Stat {
  median: number;
  mean: number;
  count: number;
  /** The maximum and where it came from, so an outlier can be labeled and clicked through */
  maxValue: number;
  maxItemId: string | null;
}

export const TIME_BUCKETS = [
  'intake',
  'planning',
  'execution',
  'decision_wait',
  'review',
  'release',
] as const;
export type TimeBucket = (typeof TIME_BUCKETS)[number];

export const BUCKET_LABELS: Record<TimeBucket, string> = {
  intake: '需求澄清',
  planning: '计划',
  execution: '执行',
  decision_wait: '等待决策',
  review: '评审',
  release: '发布',
};

export interface BucketShare {
  bucket: TimeBucket;
  hours: number;
  percent: number;
  /** Whether anyone (human or Agent) was pushing this forward — the breakdown chart colors by it
   *  分解图的两类着色依据 */
  kind: 'active' | 'waiting';
}

export interface Point {
  /** YYYY-MM-DD */
  day: string;
  value: number;
}

export interface FlowMetrics {
  leadTime: Stat;
  cycleTime: Stat;
  throughputPerWeek: number;
  completed: number;
  wipNow: number;
  /** null = no measurable time inside the window, so the metric does not hold */
  flowEfficiency: number | null;
  activeHours: number;
  waitingHours: number;
  blockedHours: number;
  decisionWaitHours: number;
  reworkRate: number | null;
  reworkedItems: number;
  /** null = the plan has no due-date field; show "not wired up" rather than 0 (page doc §7) */
  onTimeRate: number | null;
  breakdown: BucketShare[];
  wipTrend: Point[];
  blockedTrend: Point[];
}

export interface AgentPerf {
  agentId: string;
  name: string;
  model: string | null;
  runs: number;
  successRate: number;
  /** Share that succeeded on the first attempt — the only metric that sees what retries hide
   *  重试掩盖的问题只有这个指标能看见 */
  firstTrySuccessRate: number;
  overrideRate: number;
  avgTokens: number;
  totalTokens: number;
  /** Minutes; null = not a single completed Run carried both timestamps */
  avgMinutes: number | null;

  /**
   * Token usage breakdown.
   *
   * ★ The breakdown ships alongside the total, which is now a first-class metric — the unit of
   *   account rather than a diagnostic. The four classes differ by up to 50× in real unit price,
   *   so two runs with the same total — one dominated by cacheRead, one by output — differ by an
   *   order of magnitude on the bill. Reporting only the total would hide exactly that.
   *
   * 总量已升为一级指标，但明细必须一起给：四类 token 单价差到 50 倍，
   * 总量相同的两次 Run 账单可以差一个数量级。
   */
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  /**
   * Cache hit rate = cacheRead / (input + cacheRead).
   * A low value means every dispatch is re-sending large blocks of context, which is a solvable
   * engineering problem.
   *
   * 命中率偏低说明每次派发都在重传大块上下文，是可以工程优化的。
   */
  cacheHitRate: number | null;
  /**
   * Tokens per **successful** task. Looking at avgTokens alone rewards the Agent that fails
   * fast — cheap every time, but it never actually finished anything.
   *
   * 单看 avgTokens 会奖励「快速失败」的 Agent：每次都便宜，只是从来没做成过。
   */
  tokensPerSuccess: number | null;
}

export interface AgentMetrics {
  agents: AgentPerf[];
  failureReasons: { reason: string; label: string; count: number; percent: number }[];
  /** A pair where one Agent beats another across the board — a direct scheduling recommendation */
  dominance: { betterId: string; betterName: string; worseId: string; worseName: string } | null;
}

export interface RepeatedDecision {
  type: string;
  label: string;
  count: number;
  /** Share of consistent outcomes (all approved = 1) — the precondition for turning it into a
   *  rule / 规则化的前提 */
  consistency: number;
  approvedCount: number;
  potential: 'high' | 'medium' | 'low';
  avgWaitHours: number;
}

export interface HitlMetrics {
  totalDecisions: number;
  resolved: number;
  resolutionTime: Stat;
  overdue: number;
  /** auto-allowed / (auto-allowed + escalated to a human). null = nothing moved in the window */
  automationRate: number | null;
  autoPassed: number;
  policyEvaluations: number;
  overrides: number;
  blockedByHumanHours: number;
  byStage: { stage: Stage; decisions: number; items: number; percent: number }[];
  responseBuckets: {
    /** Bucket name (`< 1h` and the like) — language-neutral to begin with */
    label: string;
    count: number;
    /** If the slowest bucket holds only one kind of decision, this is its **type code**; the UI
     *  looks up its wording from that */
    slowestType: string | null;
    /** The same thing as a Chinese sentence — for logs and as a fallback; the UI must not render
     *  it / 界面读码，日志读句子 */
    slowest: string | null;
  }[];
  repeated: RepeatedDecision[];
  overrideReasons: { category: string; label: string; count: number; percent: number }[];
}

/** Every field here is denominated in tokens / 全部字段的单位都是 token */
export interface CostMetrics {
  total: number;
  /** Average tokens per completed Work Item; null = nothing completed inside the window */
  perDelivered: number | null;
  delivered: number;
  trend: Point[];
  byAgent: { id: string; label: string; tokens: number; percent: number }[];
  byType: { id: string; label: string; tokens: number; percent: number }[];
  /** Single Runs past the threshold; the threshold tracks the sample */
  anomalies: {
    runId: string;
    workItemId: string;
    title: string;
    agentName: string;
    tokens: number;
    times: number;
  }[];
  budget: number | null;
  budgetSpent: number;
  /** Days until exhaustion at the current burn rate; null = no budget, or a rate of 0 */
  budgetRunwayDays: number | null;
  /**
   * Runs that cannot be measured, because their runtime does not report tokens.
   *
   * ★ Counted separately and never folded into `total`: folding them in would pass 0 off as
   *   "unknown", and 0 reads as "genuinely free". This is the same reason the UI shows
   *   "not wired up" instead of "0".
   *
   * 单独报出来不并进 total：并进去等于用 0 冒充「不知道」，而 0 会被当成「真的没花」。
   */
  unmeasuredRuns: number;
}

export const INSIGHT_TYPES = [
  'decision_bottleneck',
  'rework_high',
  'agent_regression',
  'cost_efficiency',
  'wip_pileup',
  'improvement',
  'automation_candidate',
] as const;
export type InsightType = (typeof INSIGHT_TYPES)[number];

export interface InsightAction {
  kind: 'create_policy' | 'view_items' | 'view_agent' | 'view_decisions' | 'view_cost' | 'view_tab';
  /**
   * Which button copy to use / 按钮上写什么。
   *
   * ★ `kind` alone is not enough: the same `create_policy` reads differently in two places —
   *   one says "turn 'deploy approval' into a rule" (carrying the decision type's name), the
   *   other simply says "create a rule". One code, one sentence, so the code is finer than kind.
   *
   *   一个码一句话，所以码比 kind 细。
   */
  code: string;
  /** Arguments for `{name}` in the message. Names from users or data are passed through verbatim,
   *  never translated / 用户写的名字不翻译 */
  params?: Record<string, string | number>;
  /** Chinese fallback — used when the UI does not recognize the code, and the readable copy in
   *  logs / 界面认不出码时用它 */
  label: string;
  tab?: AnalyticsTab;
  ref?: string;
}

export interface Insight {
  type: InsightType;
  /**
   * Which sentence this insight is / 这条发现说的是哪一句。
   *
   * ★★ Finer than `type`. The single `improvement` type covers five completely different
   *   sentences (flow efficiency, lead time, usage per delivery, automation rate, "the absolute
   *   number is already good enough"); a UI keying off `type` could only ever pick one of them.
   *
   *   `type` stays: it drives the icon, the ordering, and the grouping of "insights of the same
   *   kind", all of which go by **category** rather than by sentence.
   *
   *   码比 type 细：一个 type 底下可以有五句完全不同的话，而 type 决定图标、排序与归并。
   */
  code: string;
  severity: 'critical' | 'warning' | 'good';
  /** Chinese fallback. The UI reads codes, logs read sentences / 界面读码，日志读句子 */
  message: string;
  /** The evidence itself — so a user can argue with it instead of merely believing it. Also a
   *  fallback sentence / 让用户能反驳，而不是只能相信 */
  evidence: string;
  /**
   * The numbers those two sentences carry / `message` 与 `evidence` 里的数字。
   *
   * ★ Percentages, durations, and token counts are already formatted into language-neutral
   *   shapes (`34%`, `22h`, `1.2M`), so they drop straight into a sentence in either language.
   */
  params: Record<string, string | number>;
  actions: InsightAction[];
}

/** Period-over-period change: given only for metrics that can be compared; null otherwise */
export interface Deltas {
  leadTime: number | null;
  cycleTime: number | null;
  throughput: number | null;
  flowEfficiency: number | null;
  decisionWaitHours: number | null;
  tokensPerDelivered: number | null;
  agentSuccessRate: number | null;
}

export interface Analytics {
  range: AnalyticsRange;
  window: Window;
  /** Whether the sample is large enough. When it is not, the page draws no strong conclusion
   *  (page doc §7 / §11) */
  confidence: { level: 'low' | 'ok'; completed: number; needed: number; days: number };
  insights: Insight[];
  flow: FlowMetrics;
  agent: AgentMetrics;
  hitl: HitlMetrics;
  cost: CostMetrics;
  deltas: Deltas | null;
}
