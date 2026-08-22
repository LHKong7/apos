import { RUN_SUCCESS } from '@apos/contracts';
import type { AnalyticsInput } from './types';

/**
 * Cost/benefit (the open question in page doc 12 §12.3) / 成本效益。
 *
 * ★ The reason this was left undone: "'we saved you $12,400 this month', computed from a
 *   hard-coded hourly rate, looks the most like a result and holds up the worst under
 *   questioning — one 'where does that number come from?' and nobody trusts this page again."
 *
 *   The problem was never technical; it was that the number is **unfalsifiable**. So the fix is
 *   not to skip the feature but to make the baseline an input **the user fills in themselves**,
 *   and to lay every conversion step out in the open: you supplied the baseline, the system
 *   recorded the hours, the conclusion is those two divided. A conclusion derived from your own
 *   assumption can be argued with, and therefore can be believed.
 *
 * ★ The **cost side** must be shown too. Counting only "how much work an Agent did" without
 *   counting "how much time people spent cleaning up after it" produces a marketing number:
 *   manual overrides, rework, and waiting on decisions are real expenses of this automation, and
 *   not subtracting them is self-deception.
 *
 * 基准由用户自己填、每一步换算都摊开，代价那一侧也必须减掉 —— 否则得到的是一个
 * 经不起一次追问的营销数字。
 */

export interface BenefitInput {
  /** The hourly labor cost the user supplied; null = not supplied, so nothing converts to money */
  laborHourlyCost: number | null;
  currency: string;
}

export interface BenefitLine {
  /**
   * ★★ The UI looks up its wording from this key (`analytics.benefit.<key>.label` / `.basis`);
   *   the two Chinese fields below exist for logs and as a fallback.
   *   界面读码，日志读句子。
   */
  key: string;
  label: string;
  /** The numbers inside the `basis` sentence, so each language can order them its own way */
  params?: Record<string, string | number>;
  /** Hours, taken from what the system recorded */
  hours: number;
  /** Converted to money; null when laborHourlyCost is null */
  money: number | null;
  /** Whether this line is a benefit or a cost */
  side: 'benefit' | 'cost';
  /** Where this number came from, in one sentence */
  basis: string;
}

export interface BenefitMetrics {
  /** False when there is no baseline; the page must then say "fill in a number to convert"
   *  rather than inventing one / 而不是编一个 */
  hasBaseline: boolean;
  currency: string;
  laborHourlyCost: number | null;

  lines: BenefitLine[];

  /** Hours of work the Agents carried */
  agentHours: number;
  /** Extra human hours this automation cost (overrides + rework) */
  humanOverheadHours: number;
  /** The hard-currency spend on Agents */
  agentSpend: number;

  /** Net = labor value − extra human effort − Agent spend; null when there is no baseline */
  net: number | null;
  /**
   * ★ The conclusion in one sentence, and it has to survive questioning.
   *   It always states "at the X/hour you entered" explicitly, so the reader sees at a glance
   *   which assumption the number rests on.
   *
   *   结论必须能被追问，所以总是显式带上「按你填的 X/小时」。
   */
  verdict: string;
}

export function computeBenefit(input: AnalyticsInput, config: BenefitInput): BenefitMetrics {
  const { window, items, runs, overrides } = input;
  const rate = config.laborHourlyCost;

  const inWindow = items.filter((i) => i.createdAt <= window.to && (i.actualEnd ?? window.to) >= window.from);

  /**
   * Agent hours come from **actual execution duration**, never from estimatedHours.
   * Using the estimate amounts to "the plan said 8 hours, therefore we saved 8 hours" — booking a
   * number that was never once validated as a benefit.
   *
   * 用估算值等于拿一个从没被验证过的数字当收益。
   */
  const agentHours = round(
    runs
      .filter((r) => r.startedAt !== null && r.endedAt !== null && r.status === RUN_SUCCESS)
      .reduce((s, r) => s + (r.endedAt! - r.startedAt!) / 3600_000, 0),
  );

  /**
   * ★★ This is the only place left that measures in currency, and necessarily so.
   *
   *   ROI is the subtraction "labor value − Agent spend", and both sides must share a unit. The
   *   labor side is denominated by the hourly rate the user entered, so money is the only
   *   option — tokens minus hours is not a quantity. Hence costUsd here rather than tokens.
   *
   *   The price is that this figure drifts with vendor repricing, which is exactly what moving
   *   accounting onto tokens was meant to avoid. The page therefore labels it as "a USD estimate
   *   settled by the runtime", set apart from the token-denominated metrics: drift is acceptable,
   *   passing drift off as precision is not.
   *
   * 全站只有这一处仍以货币计量：ROI 两边得同一个单位，而人力那一侧只能是钱。
   * 代价是它会随官方调价漂移，所以页面把它单独标成美元估算。
   */
  const agentSpend = round(runs.reduce((s, r) => s + r.costUsd, 0));

  /**
   * Extra human effort.
   *
   * ★ A manual override is estimated at 15 minutes: understand the current state, decide what to
   *   change, write the reason. That is an assumption, which is why `basis` says so outright —
   *   left unstated it becomes another unfalsifiable number, only this time one that errs against
   *   the platform.
   *
   *   人工覆盖按一次 15 分钟估，这是个假设，所以 basis 里写明了。
   */
  const overrideHours = round((overrides.length * OVERRIDE_MINUTES) / 60);

  /** Rework: for a task that ran more than once, every run past the first is rework */
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

/** Estimated time for one manual override: understand the state, decide the change, write the
 *  reason / 这是个估计值，不是实测 */
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
   * ★ With no baseline, what comes back is "the facts, plus a blank for you to fill in" — not a
   *   fabricated conclusion. The sentence is itself the design note for this section: the number
   *   only holds once your own assumption is in it.
   *
   *   没有基准时给的是事实加一个待填的空，不是一个编出来的结论。
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
