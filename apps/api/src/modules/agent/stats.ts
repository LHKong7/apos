import { eq } from 'drizzle-orm';
import { agents, projects, type Database } from '@apos/db';
import { computeAgents, windowFor, type AgentPerf } from '@apos/domain';
import { loadAnalyticsInput } from '../../http/analytics';

/**
 * 把实测效能回写到 `agents.stats`。
 *
 * ★ 这是调度闭环缺的那一环。
 *
 *   `computeAgents` 一直能从 agent_runs 算出成功率、首次成功率、接管率、
 *   平均成本，但算完只给页面看，从没喂回 `agents.stats` ——
 *   而 `matchExecutors` 读的正是 `stats`。结果是：真实注册的 Agent
 *   永远是 `successRate: null, sampleSize: 0`，**调度匹配学不到任何东西**。
 *   跑得好的和跑得烂的，在选人时长得一模一样。
 *
 * ★ 样本量一起写。没有它，匹配器无法区分「成功率 100%（跑过 1 次）」
 *   和「成功率 92%（跑过 200 次）」—— 前者会把新 Agent 顶到第一位，
 *   而它可能只是运气好。
 */

/** 低于这个样本量时，效能分只作参考，匹配器应退到中性分 */
export const MIN_SAMPLE_SIZE = 5;

export interface StatsRefreshReport {
  agentsUpdated: number;
  /** 样本不足、按中性分参与匹配的 Agent */
  lowConfidence: string[];
}

export async function refreshAgentStats(
  db: Database,
  opts: { rangeDays?: 7 | 30 | 90; now?: number } = {},
): Promise<StatsRefreshReport> {
  const now = opts.now ?? Date.now();
  const window = windowFor(opts.rangeDays === 7 ? '7d' : opts.rangeDays === 90 ? '90d' : '30d', now);

  const projectRows = await db.select().from(projects).where(eq(projects.status, 'active'));

  /** 跨项目按 Run 数加权合并 —— 简单平均会让只跑过一次的项目权重过大 */
  const merged = new Map<string, AgentPerf>();

  for (const project of projectRows) {
    const input = await loadAnalyticsInput(db, project, window, now);
    for (const perf of computeAgents(input).agents) {
      const seen = merged.get(perf.agentId);
      if (!seen) {
        merged.set(perf.agentId, perf);
        continue;
      }
      const runs = seen.runs + perf.runs;
      merged.set(perf.agentId, {
        ...seen,
        runs,
        successRate: weighted(seen.successRate, seen.runs, perf.successRate, perf.runs, runs),
        firstTrySuccessRate: weighted(
          seen.firstTrySuccessRate,
          seen.runs,
          perf.firstTrySuccessRate,
          perf.runs,
          runs,
        ),
        overrideRate: weighted(seen.overrideRate, seen.runs, perf.overrideRate, perf.runs, runs),
        totalCost: round(seen.totalCost + perf.totalCost, 4),
        avgCost: round((seen.totalCost + perf.totalCost) / runs, 4),
        tokens: {
          input: seen.tokens.input + perf.tokens.input,
          output: seen.tokens.output + perf.tokens.output,
          cacheRead: seen.tokens.cacheRead + perf.tokens.cacheRead,
          total: seen.tokens.total + perf.tokens.total,
        },
        cacheHitRate: mergeRate(seen, perf),
        costPerSuccess: null, // 合并后重算意义不大，页面按项目看
      });
    }
  }

  const report: StatsRefreshReport = { agentsUpdated: 0, lowConfidence: [] };

  for (const [agentId, perf] of merged) {
    const lowConfidence = perf.runs < MIN_SAMPLE_SIZE;
    if (lowConfidence) report.lowConfidence.push(agentId);

    await db
      .update(agents)
      .set({
        stats: {
          successRate: perf.successRate,
          firstTrySuccessRate: perf.firstTrySuccessRate,
          overrideRate: perf.overrideRate,
          avgCost: perf.avgCost,
          totalCost: perf.totalCost,
          avgMinutes: perf.avgMinutes,
          sampleSize: perf.runs,
          tokens: perf.tokens,
          cacheHitRate: perf.cacheHitRate,
          /** ★ 样本不足要标出来，匹配器据此退到中性分 */
          lowConfidence,
          window: { from: window.from, to: window.to },
          refreshedAt: new Date(now).toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId));

    report.agentsUpdated++;
  }

  return report;
}

function weighted(a: number, aRuns: number, b: number, bRuns: number, total: number): number {
  return round((a * aRuns + b * bRuns) / total, 4);
}

function mergeRate(a: AgentPerf, b: AgentPerf): number | null {
  const base = a.tokens.input + a.tokens.cacheRead + b.tokens.input + b.tokens.cacheRead;
  if (base === 0) return null;
  return round((a.tokens.cacheRead + b.tokens.cacheRead) / base, 4);
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
