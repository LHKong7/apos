import { RUN_SUCCESS } from '@apos/contracts';
import { percent, ratio, round } from './stats';
import type { AgentMetrics, AgentPerf, AnalyticsInput, RunRow } from './types';

/** 失败原因的中文说明。errorClass 来自 Agent 协议的分类（06 §7）。 */
const FAILURE_LABELS: Record<string, string> = {
  context_insufficient: '上下文不足',
  capability_mismatch: '能力不匹配',
  tool_failure: '工具调用失败',
  timeout: '超时',
  permission_denied: '权限不足',
  rate_limit: '限流',
  auth: '凭据失效',
  cost_limit: '超出成本上限',
  invalid_output: '产出不符合要求',
  internal: '运行时内部错误',
  unknown: '未分类',
};

/** 全站唯一定义在 @apos/contracts，别再各写一份字面量 */
const SUCCESS = RUN_SUCCESS;

/**
 * Agent 效能对比（页面文档 12 §5.4）。
 *
 * ★ 横向对比才是这个 Tab 的价值。单个 Agent「成功率 92%」说明不了任何事 ——
 *   不知道是好是坏，也不知道该做什么。两个 Agent 摆在一起，
 *   「code-agent-2 在成功率、成本、耗时上全面优于 code-agent-1」
 *   立刻就变成一条可执行的调度建议。
 */
export function computeAgents(input: AnalyticsInput): AgentMetrics {
  const { window, runs, agents, overrides, items } = input;
  const inWindow = runs.filter((r) => r.createdAt >= window.from && r.createdAt <= window.to);

  // 被人工覆盖的任务 → 它归哪个 Agent 跑的
  const overriddenItems = new Set(
    overrides.filter((o) => o.at >= window.from && o.at <= window.to).map((o) => o.itemId),
  );

  const byAgent = new Map<string, RunRow[]>();
  for (const r of inWindow) {
    const list = byAgent.get(r.agentId);
    if (list) list.push(r);
    else byAgent.set(r.agentId, [r]);
  }

  const perf: AgentPerf[] = [];
  for (const agent of agents) {
    const list = byAgent.get(agent.id) ?? [];
    if (list.length === 0) continue;

    const succeeded = list.filter((r) => r.status === SUCCESS);
    // ★ 首次成功率：只看 attempt = 1 的 Run。
    //   重试会把总成功率拉回去，掩盖「它第一次几乎从来做不对」这个真问题。
    const firstTry = list.filter((r) => r.attempt === 1);
    const firstTryOk = firstTry.filter((r) => r.status === SUCCESS);

    const handled = new Set(list.map((r) => r.workItemId));
    const overridden = [...handled].filter((id) => overriddenItems.has(id)).length;

    const timed = list.filter((r) => r.startedAt !== null && r.endedAt !== null);
    const totalCost = list.reduce((sum, r) => sum + r.cost, 0);

    perf.push({
      agentId: agent.id,
      name: agent.name,
      model: agent.model,
      runs: list.length,
      successRate: ratio(succeeded.length, list.length) ?? 0,
      firstTrySuccessRate: ratio(firstTryOk.length, firstTry.length) ?? 0,
      overrideRate: ratio(overridden, handled.size) ?? 0,
      avgCost: round(totalCost / list.length, 4),
      totalCost: round(totalCost, 4),
      avgMinutes:
        timed.length > 0
          ? round(
              timed.reduce((sum, r) => sum + (r.endedAt! - r.startedAt!), 0) / timed.length / 60_000,
            )
          : null,
    });
  }

  perf.sort((a, b) => b.runs - a.runs);

  // 失败原因分布
  const failed = inWindow.filter((r) => r.status !== SUCCESS && r.status !== 'running' && r.status !== 'queued');
  const reasonCounts = new Map<string, number>();
  for (const r of failed) {
    const key = r.errorClass ?? 'unknown';
    reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
  }
  const failureReasons = [...reasonCounts.entries()]
    .map(([reason, count]) => ({
      reason,
      label: FAILURE_LABELS[reason] ?? reason,
      count,
      percent: percent(count, failed.length),
    }))
    .sort((a, b) => b.count - a.count);

  void items;
  return { agents: perf, failureReasons, dominance: findDominance(perf) };
}

/**
 * 找「全面优于」的一对。
 *
 * 三项全赢才算 —— 成功率高、成本低、耗时短。
 * 只赢一两项的对比不该给建议：便宜但成功率低的 Agent 未必更差，
 * 那是权衡不是结论，替用户下判断反而有害。
 */
function findDominance(perf: AgentPerf[]): AgentMetrics['dominance'] {
  /** 样本太少的对比没有说服力 */
  const MIN_RUNS = 5;
  const eligible = perf.filter((p) => p.runs >= MIN_RUNS && p.avgMinutes !== null);

  for (const better of eligible) {
    for (const worse of eligible) {
      if (better.agentId === worse.agentId) continue;
      const wins =
        better.successRate > worse.successRate &&
        better.avgCost < worse.avgCost &&
        better.avgMinutes! < worse.avgMinutes!;
      if (wins) {
        return {
          betterId: better.agentId,
          betterName: better.name,
          worseId: worse.agentId,
          worseName: worse.name,
        };
      }
    }
  }
  return null;
}

export { FAILURE_LABELS };
