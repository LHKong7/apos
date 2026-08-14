import { and, count, eq, gte, inArray, ne, sql, sum } from 'drizzle-orm';
import { agentRuns, agents, projectMembers, workItems, type Database } from '@apos/db';
import { ACTIVE_RUN_STATUSES, ExecutionMode, type WorkItemType } from '@apos/contracts';
import { matchExecutors, type AgentCandidate, type MatchResult, type MatchTarget } from '@apos/domain';
import type { RuntimeRegistry } from '@apos/agent-runtimes';

type WorkItemRow = typeof workItems.$inferSelect;

/**
 * 执行主体匹配。
 *
 * ★ 抽出来的理由不是「代码复用」，是**口径统一**：调度器选 Agent 和
 *   失败恢复找替补，如果各算一套，会出现「恢复策略说有替补可换，
 *   调度器却认为没有」这种自相矛盾的状态，而且极难复现。
 *
 * ★★ 候选来自**本项目成员**，不是整个组织。
 *
 *   此前这里是 `eq(agents.orgId, item.orgId)` —— 组织里任何一个 Agent
 *   都可能被派到任何一个项目上。项目是权限与上下文的边界：人类那边
 *   一直靠 project_members 守着，Agent 这边漏了整整一层。
 *
 *   仍然把**非本项目**的 Agent 一并取出来交给 domain 判，而不是在 SQL 里
 *   过滤掉：候选面板要能显示「它不在这个项目里」这条拒绝理由，
 *   否则用户看到的是一个莫名其妙的空列表。
 */
export async function resolveExecutor(
  db: Database,
  item: WorkItemRow,
  opts: { excludeAgentId?: string; registry?: RuntimeRegistry } = {},
): Promise<MatchResult> {
  const rows = await db
    .select()
    .from(agents)
    .where(
      opts.excludeAgentId
        ? and(eq(agents.orgId, item.orgId), ne(agents.id, opts.excludeAgentId))
        : eq(agents.orgId, item.orgId),
    );

  const memberRows = await db
    .select({ actorId: projectMembers.actorId })
    .from(projectMembers)
    .where(
      and(eq(projectMembers.projectId, item.projectId), eq(projectMembers.actorType, 'agent')),
    );
  const members = new Set(memberRows.map((m) => m.actorId));

  const loads = await db
    .select({ agentId: agentRuns.agentId, n: count() })
    .from(agentRuns)
    .where(inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]))
    .groupBy(agentRuns.agentId);
  const loadMap = new Map(loads.map((l) => [l.agentId, l.n]));

  /**
   * ★ 今日用量按**自然日**统计，与 tokenLimitDaily 的语义对齐。
   *   用滚动 24 小时的话，「今天的额度」会在半夜之后仍然被昨天的消耗占着。
   *
   * ★ 四类 token 必须一起加。少一类就是少算，而少算只会让额度显得没用完，
   *   于是本该被拦下的派发照常发出去 —— 闸门失效的方向永远是「放行」。
   */
  const spent = await db
    .select({
      agentId: agentRuns.agentId,
      total: sum(
        sql`${agentRuns.tokensInput} + ${agentRuns.tokensOutput}
            + ${agentRuns.tokensCacheRead} + ${agentRuns.tokensCacheWrite}`,
      ),
    })
    .from(agentRuns)
    // ★ 按 createdAt 不按 startedAt：后者可空（排队中的 Run 还没开始），
    //   用它会把已经排上队、马上要花钱的那些漏出统计
    .where(gte(agentRuns.createdAt, sql`date_trunc('day', now())`))
    .groupBy(agentRuns.agentId);
  const spentMap = new Map(spent.map((s) => [s.agentId, Number(s.total ?? 0)]));

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
      avgTokens: typeof stats['avgTokens'] === 'number' ? stats['avgTokens'] : null,
      currentLoad: loadMap.get(a.id) ?? 0,
      maxConcurrency: a.maxConcurrency,
      tokenLimitPerRun: a.tokenLimitPerRun ?? null,
      allowedTools: a.allowedTools,
      deniedTools: a.deniedTools,
      contextAffinity: 0.5,
      status: a.status,
      inProject: members.has(a.id),
      /**
       * ★ 没有 registry 就不判这一条（当成已注册）。恢复策略与部分测试
       *   拿不到进程里的注册表，在那里把所有 Agent 判成「没注册」，
       *   会让「有没有替补」这个问题永远答否。
       */
      registered: opts.registry ? opts.registry.has(a.id) : true,
      resourceRefs: a.resourceScopes.filter((s) => s.access !== 'none').map((s) => s.ref),
      tokensToday: spentMap.get(a.id) ?? 0,
      tokenLimitDaily: a.tokenLimitDaily ?? null,
    };
  });

  const target: MatchTarget = {
    type: item.type,
    requiredSkills: Array.isArray(meta['requiredSkills']) ? (meta['requiredSkills'] as string[]) : [],
    requiredTools: Array.isArray(meta['requiredTools']) ? (meta['requiredTools'] as string[]) : [],
    estimatedTokens: item.estimatedTokens ?? null,
    riskLevel: item.riskLevel,
    executionMode: executionModeOf(meta),
    requiredResources: Array.isArray(meta['requiredResources'])
      ? (meta['requiredResources'] as string[])
      : [],
  };

  return matchExecutors(target, candidates);
}

/**
 * 从工作项元数据里读出执行方式。
 *
 * ★★ 兼容旧数据：`requiresHuman: true` 等价于 `executionMode: 'human'`。
 *
 *   这一栏是从 requiresHuman 拆出来的（另一半是 approvalGate）。历史工作项
 *   的 typeData 里只有 requiresHuman，读不到就当没要求会把「这活只能人干」
 *   静默降级成「谁都行」—— 而那正是这次拆分要避免的那类沉默变更。
 */
export function executionModeOf(meta: Record<string, unknown>): ExecutionMode {
  const parsed = ExecutionMode.safeParse(meta['executionMode']);
  if (parsed.success) return parsed.data;
  return meta['requiresHuman'] === true ? 'human' : 'auto';
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
