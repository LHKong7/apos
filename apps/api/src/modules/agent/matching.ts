import { and, count, eq, inArray, ne } from 'drizzle-orm';
import { agentRuns, agents, workItems, type Database } from '@apos/db';
import { ACTIVE_RUN_STATUSES, type WorkItemType } from '@apos/contracts';
import { matchExecutors, type AgentCandidate, type MatchResult, type MatchTarget } from '@apos/domain';

type WorkItemRow = typeof workItems.$inferSelect;

/**
 * 执行主体匹配。
 *
 * ★ 抽出来的理由不是「代码复用」，是**口径统一**：调度器选 Agent 和
 *   失败恢复找替补，如果各算一套，会出现「恢复策略说有替补可换，
 *   调度器却认为没有」这种自相矛盾的状态，而且极难复现。
 */
export async function resolveExecutor(
  db: Database,
  item: WorkItemRow,
  opts: { excludeAgentId?: string } = {},
): Promise<MatchResult> {
  const rows = await db
    .select()
    .from(agents)
    .where(
      opts.excludeAgentId
        ? and(eq(agents.orgId, item.orgId), ne(agents.id, opts.excludeAgentId))
        : eq(agents.orgId, item.orgId),
    );

  const loads = await db
    .select({ agentId: agentRuns.agentId, n: count() })
    .from(agentRuns)
    .where(inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]))
    .groupBy(agentRuns.agentId);
  const loadMap = new Map(loads.map((l) => [l.agentId, l.n]));

  const meta = item.typeData;
  const candidates: AgentCandidate[] = rows.map((a) => {
    const stats = (a.stats ?? {}) as Record<string, unknown>;
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      skills: a.skills,
      applicableTypes: a.applicableTypes as WorkItemType[],
      successRate: typeof stats['successRate'] === 'number' ? stats['successRate'] : null,
      sampleSize: typeof stats['sampleSize'] === 'number' ? stats['sampleSize'] : 0,
      avgCost: typeof stats['avgCost'] === 'number' ? stats['avgCost'] : null,
      currentLoad: loadMap.get(a.id) ?? 0,
      maxConcurrency: a.maxConcurrency,
      costLimitPerRun: a.costLimitPerRun ? Number(a.costLimitPerRun) : null,
      allowedTools: a.allowedTools,
      deniedTools: a.deniedTools,
      contextAffinity: 0.5,
      status: a.status,
    };
  });

  const target: MatchTarget = {
    type: item.type,
    requiredSkills: Array.isArray(meta['requiredSkills']) ? (meta['requiredSkills'] as string[]) : [],
    requiredTools: Array.isArray(meta['requiredTools']) ? (meta['requiredTools'] as string[]) : [],
    estimatedCost: item.estimatedCost ? Number(item.estimatedCost) : null,
    riskLevel: item.riskLevel,
    requiresHuman: meta['requiresHuman'] === true,
  };

  return matchExecutors(target, candidates);
}

/** 除当前 Agent 外还有没有能接手的。返回最合适的那个的 id */
export async function findAlternativeAgent(
  db: Database,
  item: WorkItemRow,
  excludeAgentId: string,
): Promise<string | null> {
  const match = await resolveExecutor(db, item, { excludeAgentId });
  return match.candidates[0]?.agentId ?? null;
}
