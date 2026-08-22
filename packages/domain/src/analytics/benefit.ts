import { RUN_SUCCESS } from '@apos/contracts';
import type { AnalyticsInput } from './types';

/**
 * 成本效益（页面文档 12 §12.3 的待确认项）。
 *
 * ★ 这一块之前不做的理由是：「硬编一个时薪算出来的『本月为你省了 $12,400』
 *   看起来最像成果，也最经不起追问 —— 被问一次『这个数怎么来的』
 *   就再也没人信这一页了。」
 *
 *   问题从来不在技术上，在于那个数字**不可证伪**。
 *   所以解法不是不做，是把基准变成**用户自己填的输入**，
 *   并且把每一步换算都摊在明面上：
 *   基准是你填的、工时是系统记的、结论是这两者的除法。
 *   一个「你自己的假设推出来的结论」可以被追问，也就可以被相信。
 *
 * ★ 同时必须给出**代价那一侧**。只算「Agent 干了多少活」而不算
 *   「人为此花了多少时间收拾」，得到的是一个营销数字：
 *   人工覆盖、返工、等待决策都是这套自动化的真实开销，
 *   不减掉就是在自欺。
 */

export interface BenefitInput {
  /** 用户填的人力小时成本；null = 没填，所有折算项都不出数 */
  laborHourlyCost: number | null;
  currency: string;
}

export interface BenefitLine {
  /**
   * ★★ 界面按它取词（`analytics.benefit.<key>.label` / `.basis`），
   *   下面那两个中文字段是日志与兜底用的。界面读码，日志读句子。
   */
  key: string;
  label: string;
  /** `basis` 那句话里的数字，供词条按各自语言的语序组织 */
  params?: Record<string, string | number>;
  /** 小时数，来自系统记录 */
  hours: number;
  /** 折算成钱；laborHourlyCost 为 null 时是 null */
  money: number | null;
  /** 这一行是收益还是代价 */
  side: 'benefit' | 'cost';
  /** 这个数字怎么来的，一句话说清 */
  basis: string;
}

export interface BenefitMetrics {
  /** 没有基准时为 false，页面必须显示「填一个数才能换算」而不是编一个 */
  hasBaseline: boolean;
  currency: string;
  laborHourlyCost: number | null;

  lines: BenefitLine[];

  /** Agent 承担的工时 */
  agentHours: number;
  /** 人为这套自动化额外花掉的工时（覆盖 + 返工） */
  humanOverheadHours: number;
  /** Agent 的真金白银开销 */
  agentSpend: number;

  /** 净收益 = 人力折算 − 人的额外投入折算 − Agent 开销；没有基准时为 null */
  net: number | null;
  /**
   * ★ 结论一句话，且必须能被追问。
   *   它总是显式带上「按你填的 X/小时」——
   *   读者一眼就知道这个数字建立在什么假设上。
   */
  verdict: string;
}

export function computeBenefit(input: AnalyticsInput, config: BenefitInput): BenefitMetrics {
  const { window, items, runs, overrides } = input;
  const rate = config.laborHourlyCost;

  const inWindow = items.filter((i) => i.createdAt <= window.to && (i.actualEnd ?? window.to) >= window.from);

  /**
   * Agent 承担的工时用**实际执行时长**，不用 estimatedHours。
   * 用估算值等于「计划说要 8 小时，所以省了 8 小时」——
   * 那是在拿一个从没被验证过的数字当收益。
   */
  const agentHours = round(
    runs
      .filter((r) => r.startedAt !== null && r.endedAt !== null && r.status === RUN_SUCCESS)
      .reduce((s, r) => s + (r.endedAt! - r.startedAt!) / 3600_000, 0),
  );

  /**
   * ★★ 全站只有这一处仍以货币计量，而且必须如此。
   *
   *   ROI 是「人力折算 − Agent 开销」这个减法，两边得同一个单位。
   *   人力那一侧的单位由用户填的时薪决定，只能是钱 ——
   *   token 减小时数不是一个量。所以这里读 costUsd 而不是 tokens。
   *
   *   代价是这个数会随官方调价漂移，正是记账口径换成 token 要躲开的那件事。
   *   页面因此把它标成「按运行时结算的美元估算」，与其余 token 口径的
   *   指标区分开：漂移是可以接受的，把漂移说成精确不行。
   *
   * This is the only place left that measures in currency, necessarily so.
   * ROI subtracts agent spend from labor value, and both sides must share a
   * unit. The labor side is denominated by the user's hourly rate, so money
   * is the only option — tokens minus hours is not a quantity. The cost is
   * that this figure drifts with vendor repricing, which is exactly what
   * token accounting avoids elsewhere; the page therefore labels it as a USD
   * estimate rather than passing the drift off as precision.
   */
  const agentSpend = round(runs.reduce((s, r) => s + r.costUsd, 0));

  /**
   * 人的额外投入。
   *
   * ★ 人工覆盖按一次 15 分钟估：看懂现状 + 决定怎么改 + 写原因。
   *   这是个假设，所以 basis 里写明了 —— 不写明的话它就成了
   *   另一个「不可证伪的数字」，只不过这次是往不利方向编。
   */
  const overrideHours = round((overrides.length * OVERRIDE_MINUTES) / 60);

  /** 返工：跑过不止一次的任务，多出来的那些次都是返工 */
  const runsByItem = new Map<string, number>();
  for (const r of runs) runsByItem.set(r.workItemId, (runsByItem.get(r.workItemId) ?? 0) + 1);
  const reworkRuns = [...runsByItem.values()].reduce((s, n) => s + Math.max(0, n - 1), 0);
  const reworkHours = round(
    runs
      .filter((r) => r.attempt > 1 && r.startedAt !== null && r.endedAt !== null)
      .reduce((s, r) => s + (r.endedAt! - r.startedAt!) / 3600_000, 0),
  );

  const humanOverheadHours = round(overrideHours);

  const lines: BenefitLine[] = [
    {
      key: 'agent_hours',
      label: 'Agent 承担的工时',
      hours: agentHours,
      money: rate === null ? null : round(agentHours * rate),
      side: 'benefit',
      basis: `${runs.filter((r) => r.status === RUN_SUCCESS).length} 次成功执行的实际时长之和（不是计划估算）`,
      params: { runs: runs.filter((r) => r.status === RUN_SUCCESS).length },
    },
    {
      key: 'agent_spend',
      label: 'Agent 的实际花费',
      hours: 0,
      money: agentSpend,
      side: 'cost',
      basis: '所有 Run 的 token 与调用成本',
    },
    {
      key: 'human_override',
      label: '人工覆盖占用的时间',
      hours: overrideHours,
      money: rate === null ? null : round(overrideHours * rate),
      side: 'cost',
      basis: `${overrides.length} 次人工覆盖 × 每次 ${OVERRIDE_MINUTES} 分钟（这是个假设，不是实测）`,
      params: { count: overrides.length, minutes: OVERRIDE_MINUTES },
    },
    {
      key: 'rework',
      label: '返工消耗的 Agent 工时',
      hours: reworkHours,
      money: null,
      side: 'cost',
      basis: `${reworkRuns} 次重试执行的时长 —— 这部分是白干的，不该算进收益`,
      params: { runs: reworkRuns },
    },
  ];

  const net =
    rate === null
      ? null
      : round(agentHours * rate - overrideHours * rate - agentSpend);

  return {
    hasBaseline: rate !== null,
    currency: config.currency,
    laborHourlyCost: rate,
    lines,
    agentHours,
    humanOverheadHours,
    agentSpend,
    net,
    verdict: verdictOf({ rate, agentHours, overrideHours, agentSpend, net, currency: config.currency, items: inWindow.length }),
  };
}

/** 一次人工覆盖的估计耗时：看懂现状 + 决定怎么改 + 写原因 */
const OVERRIDE_MINUTES = 15;

function verdictOf(x: {
  rate: number | null;
  agentHours: number;
  overrideHours: number;
  agentSpend: number;
  net: number | null;
  currency: string;
  items: number;
}): string {
  if (x.agentHours === 0) {
    return '这个周期 Agent 没有完成过执行，没有可换算的工时';
  }

  /**
   * ★ 没有基准时给的是「事实 + 一个待你填的空」，不是一个编出来的结论。
   *   这句话本身就是这一块的设计说明：数字要你自己的假设才成立。
   */
  if (x.rate === null || x.net === null) {
    return (
      `Agent 承担了 ${x.agentHours} 小时的执行，花掉 ${money(x.agentSpend, x.currency)}。` +
      `换算成钱需要一个人力小时成本 —— 这个数只有你知道，填进去之后这一块才会给结论。` +
      `我们不替你填一个：编出来的「本月为你省了多少」经不起一次追问。`
    );
  }

  if (x.net <= 0) {
    return (
      `按你填的 ${money(x.rate, x.currency)}/小时算，这个周期是**净投入** ${money(-x.net, x.currency)}：` +
      `Agent 承担 ${x.agentHours} 小时（折合 ${money(x.agentHours * x.rate, x.currency)}），` +
      `但花掉 ${money(x.agentSpend, x.currency)}、还占用了 ${x.overrideHours} 小时人工覆盖。`
    );
  }

  return (
    `按你填的 ${money(x.rate, x.currency)}/小时算，这个周期净收益约 ${money(x.net, x.currency)}：` +
    `Agent 承担 ${x.agentHours} 小时（折合 ${money(x.agentHours * x.rate, x.currency)}），` +
    `减去 ${money(x.agentSpend, x.currency)} 的执行成本与 ${x.overrideHours} 小时人工覆盖。` +
    `这个数完全建立在你填的时薪上，换个数就是另一个结论。`
  );
}

function money(n: number, currency: string): string {
  return `${currency}${Math.round(n * 100) / 100}`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
