import { eq } from 'drizzle-orm';
import { agents, projects, type Database } from '@apos/db';
import { computeAgents, windowFor, type AgentPerf } from '@apos/domain';
import { loadAnalyticsInput } from '../../http/analytics';

/**
 * Write measured performance back into `agents.stats` / 把实测效能回写到 `agents.stats`。
 *
 * ★ This is the missing link in the scheduling loop.
 *
 *   `computeAgents` has always been able to derive success rate, first-try success rate, override
 *   rate and average cost from agent_runs, but the result only ever reached the analytics page —
 *   it was never fed back into `agents.stats`, and `stats` is exactly what `matchExecutors`
 *   reads. The consequence: every actually registered Agent stayed at
 *   `successRate: null, sampleSize: 0`, so **matching learned nothing at all**. A great Agent and
 *   a terrible one looked identical at selection time.
 *
 * ★ Write the sample size alongside it. Without it the matcher cannot tell "100% success over 1
 *   run" from "92% success over 200 runs" — the former would push a brand-new Agent to the top of
 *   the list when it may simply have gotten lucky once.
 *
 * 这是调度闭环缺的那一环：算出来的效能从没喂回 `agents.stats`，而匹配器读的正是它。
 * 样本量必须一起写，否则跑过一次的新 Agent 会顶到第一位。
 */

/** Below this sample size the performance score is indicative only; the matcher falls back to a
 *  neutral score / 样本量低于此值时匹配器退到中性分 */
export const MIN_SAMPLE_SIZE = 5;

export interface StatsRefreshReport {
  agentsUpdated: number;
  /** Agents with too little data, participating in matching at a neutral score */
  lowConfidence: string[];
}

export async function refreshAgentStats(
  db: Database,
  opts: { rangeDays?: 7 | 30 | 90; now?: number } = {},
): Promise<StatsRefreshReport> {
  const now = opts.now ?? Date.now();
  const window = windowFor(opts.rangeDays === 7 ? '7d' : opts.rangeDays === 90 ? '90d' : '30d', now);

  const projectRows = await db.select().from(projects).where(eq(projects.status, 'active'));

  /** Merge across projects weighted by run count — a plain average over-weights a project the
   *  Agent ran in exactly once / 简单平均会让只跑过一次的项目权重过大 */
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
        totalTokens: Math.round(seen.totalTokens + perf.totalTokens),
        avgTokens: Math.round((seen.totalTokens + perf.totalTokens) / runs),
        tokens: {
          input: seen.tokens.input + perf.tokens.input,
          output: seen.tokens.output + perf.tokens.output,
          cacheRead: seen.tokens.cacheRead + perf.tokens.cacheRead,
          cacheWrite: seen.tokens.cacheWrite + perf.tokens.cacheWrite,
          total: seen.tokens.total + perf.tokens.total,
        },
        cacheHitRate: mergeRate(seen, perf),
        tokensPerSuccess: null, // Not worth recomputing post-merge; the page views it per project
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
          avgTokens: perf.avgTokens,
          totalTokens: perf.totalTokens,
          avgMinutes: perf.avgMinutes,
          sampleSize: perf.runs,
          tokens: perf.tokens,
          cacheHitRate: perf.cacheHitRate,
          /** ★ Flag thin samples explicitly so the matcher can fall back to a neutral score
           *  样本不足要标出来，匹配器据此退到中性分 */
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
