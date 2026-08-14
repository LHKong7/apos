import type { Stage, WorkItemStatus } from '@apos/contracts';

/**
 * Analytics 的输入与输出类型。
 *
 * 输入一律是「已经从库里读出来的行」，不含任何 Drizzle / SQL 概念 ——
 * 指标计算是纯函数，能脱库测试。见 12 项目 Analytics §9。
 */

export const ANALYTICS_RANGES = ['7d', '30d', '90d'] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

export const RANGE_DAYS: Record<AnalyticsRange, number> = { '7d': 7, '30d': 30, '90d': 90 };

export const ANALYTICS_TABS = ['flow', 'agent', 'hitl', 'cost', 'quality', 'benefit'] as const;
export type AnalyticsTab = (typeof ANALYTICS_TABS)[number];

/** 时间统一用毫秒时间戳，避免 Date 在纯函数里带时区歧义 */
export interface Window {
  from: number;
  to: number;
}

// ── 输入行 ────────────────────────────────────────────────────────────────

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
  /** null 表示计划里没排期 —— 按时交付率要显示「未接入」而不是 0 */
  plannedEnd: number | null;
  actualTokens: number;
  /**
   * 「被阻塞」的标记位。与 `blocked` 状态是两回事：
   * 一张 ready 的卡片也可以挂着阻塞标记（在等外部依赖），看板正是按它显示「⛔ N 项阻塞」。
   * 阻塞时长要把两者都算上，否则 Analytics 说 0h、看板说 1 项，用户不知道该信谁。
   */
  blockedSince: number | null;
  ownerId: string | null;
  executorType: string | null;
  executorId: string | null;
  /**
   * CI 回流的质量信号（typeData.qualityGate）。
   *
   * ★ 这个字段一直存在、Policy 引擎一直在读，但从来没有东西写过它 ——
   *   这就是「质量 Tab 算不出来」的真实原因：不是算法难，是没有数据源。
   *   接上代码仓库之后由 GitHub check-runs 回填。
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
   * 记账单位：四类 token 相加。所有上限、预算、成本指标都读这一个。
   *
   * The unit of account: the four token classes summed. Every limit, budget,
   * and cost metric reads this one field.
   */
  tokens: number;
  /**
   * 运行时结算的美元值，**只有 ROI 会用**。
   *
   * ★ ROI 要拿 Agent 开销和人力成本相减，而人力成本只有货币这一种单位 ——
   *   token 减小时数是没有意义的。除这一处之外，任何判定都不该读它。
   *
   * The runtime's settled USD figure, used **only by ROI**: ROI subtracts
   * agent spend from labour cost, and labour has no denomination other than
   * money — tokens minus hours is not a quantity. Nothing else may read it.
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
  /** 决策发生时任务所处的阶段，用于「各阶段人类介入比例」 */
  stage: Stage | null;
}

export interface AgentRow {
  id: string;
  name: string;
  type: string;
  model: string | null;
}

/**
 * 人类手动覆盖系统判断（看板上拖卡片 → 强制填原因的那一次）。
 *
 * 产品文档里的「人工接管」指从运行中的 Agent 手里抢过控制权，
 * 对应事件 `work_item.taken_over` 目前还没有实现。
 * 手动覆盖是现在真实存在、真实被记录的那件事，指标就按它算，
 * 不拿一个永远是 0 的字段冒充。
 */
export interface OverrideRow {
  itemId: string;
  at: number;
  category: string | null;
  reason: string | null;
}

/** policy.evaluated 事件。自动化率 = 自动放行 / 全部评估。 */
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
  /** 项目 token 预算，用于燃尽预测；null = 没设预算 */
  tokenBudget: number | null;
  tokensSpentTotal: number;
}

// ── 输出 ─────────────────────────────────────────────────────────────────

/**
 * ★ 中位数与均值一起给。
 *   页面文档 §11：「单个异常值扭曲平均值 → 同时显示中位数」。
 *   一个跑了三天的任务能把 12 个任务的平均前置时间抬高一倍，
 *   只显示均值就是在误导。
 */
export interface Stat {
  median: number;
  mean: number;
  count: number;
  /** 最大值及其来源，供「异常值单独标注可点击查看」 */
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
  /** 这段时间里有没有人/Agent 在推进 —— 分解图的两类着色依据 */
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
  /** null = 窗口内没有任何可计量的时间，指标不成立 */
  flowEfficiency: number | null;
  activeHours: number;
  waitingHours: number;
  blockedHours: number;
  decisionWaitHours: number;
  reworkRate: number | null;
  reworkedItems: number;
  /** null = 计划里没有排期字段，显示「未接入」而不是 0（页面文档 §7） */
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
  /** 第一次尝试就成功的比例 —— 重试掩盖的问题只有这个指标能看见 */
  firstTrySuccessRate: number;
  overrideRate: number;
  avgTokens: number;
  totalTokens: number;
  /** 分钟；null = 没有一次跑完带时间戳的 Run */
  avgMinutes: number | null;

  /**
   * Token 用量明细。
   *
   * ★ 总量升为一级指标了 —— 它现在就是记账单位，不再是「诊断量」。
   *   但明细必须一起给：四类 token 的真实单价差到 50 倍，
   *   一个 cacheRead 占九成的总量和一个 output 占九成的总量，
   *   数字一样、账单差一个数量级。只报总量会把这件事藏起来。
   *
   * The breakdown ships alongside the total, which is now the unit of
   * account rather than a diagnostic. The four classes differ by up to 50×
   * in real unit price, so two runs with the same total — one dominated by
   * cacheRead, one by output — differ by an order of magnitude on the bill.
   * Reporting only the total would hide exactly that.
   */
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  /**
   * 缓存命中率 = cacheRead / (input + cacheRead)。
   * 偏低说明每次派发都在重传大块上下文，是可以工程优化的。
   */
  cacheHitRate: number | null;
  /**
   * 每**成功**任务的 token。单看 avgTokens 会奖励「快速失败」的 Agent ——
   * 它每次都便宜，只是从来没做成过。
   */
  tokensPerSuccess: number | null;
}

export interface AgentMetrics {
  agents: AgentPerf[];
  failureReasons: { reason: string; label: string; count: number; percent: number }[];
  /** 全面优于另一个 Agent 的对子，直接给出调度建议 */
  dominance: { betterId: string; betterName: string; worseId: string; worseName: string } | null;
}

export interface RepeatedDecision {
  type: string;
  label: string;
  count: number;
  /** 结果一致的比例（全批准 = 1）—— 规则化的前提 */
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
  /** 自动放行 / (自动放行 + 转人工)。null = 窗口内没有流转 */
  automationRate: number | null;
  autoPassed: number;
  policyEvaluations: number;
  overrides: number;
  blockedByHumanHours: number;
  byStage: { stage: Stage; decisions: number; items: number; percent: number }[];
  responseBuckets: { label: string; count: number; slowest: string | null }[];
  repeated: RepeatedDecision[];
  overrideReasons: { category: string; label: string; count: number; percent: number }[];
}

/** 全部字段的单位都是 token / Every field here is denominated in tokens */
export interface CostMetrics {
  total: number;
  /** 每完成一个 Work Item 的平均 token；null = 窗口内没有完成项 */
  perDelivered: number | null;
  delivered: number;
  trend: Point[];
  byAgent: { id: string; label: string; tokens: number; percent: number }[];
  byType: { id: string; label: string; tokens: number; percent: number }[];
  /** 单次 Run 超过阈值的异常，阈值随样本走 */
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
  /** 按当前速率预计耗尽的天数；null = 无预算或速率为 0 */
  budgetRunwayDays: number | null;
  /**
   * 无法计量的 Run 数（运行时不上报 token）。
   *
   * ★ 单独报出来，不并进 total。并进去等于用 0 冒充「不知道」，
   *   而 0 会被当成「真的没花」—— 这正是界面上「未接入」而不是「0」的同一条理由。
   *
   * Runs whose runtime does not report tokens are counted separately and
   * never folded into `total`: folding them in would pass 0 off as "unknown",
   * and 0 reads as "genuinely free".
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
  label: string;
  tab?: AnalyticsTab;
  ref?: string;
}

export interface Insight {
  type: InsightType;
  severity: 'critical' | 'warning' | 'good';
  message: string;
  /** 判据本身 —— 让用户能反驳，而不是只能相信 */
  evidence: string;
  actions: InsightAction[];
}

/** 环比：只对能比的指标给，比不了就是 null */
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
  /** 样本够不够。不够时页面不给强结论（页面文档 §7 / §11） */
  confidence: { level: 'low' | 'ok'; completed: number; needed: number; days: number };
  insights: Insight[];
  flow: FlowMetrics;
  agent: AgentMetrics;
  hitl: HitlMetrics;
  cost: CostMetrics;
  deltas: Deltas | null;
}
