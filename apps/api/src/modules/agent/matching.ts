import { and, count, eq, gte, inArray, ne, sql, sum } from 'drizzle-orm';
import { agentRuns, agents, projectMembers, repositories, workItems, type Database } from '@apos/db';
import { ACTIVE_RUN_STATUSES, ExecutionMode } from '@apos/contracts';
import {
  matchExecutors,
  type AgentCandidate,
  type MatchResult,
  type MatchTarget,
} from '@apos/domain';
import type { RuntimeRegistry } from '@apos/agent-runtimes';
import { loadProjectGrants, resolveAgentAccess } from './access';

type WorkItemRow = typeof workItems.$inferSelect;

/**
 * Resolve which executor should take a work item / 执行主体匹配。
 *
 * ★ This lives in one place for **one verdict**, not for code reuse: the scheduler picks an
 *   Agent and failure recovery looks for a stand-in. Two implementations produce contradictory
 *   states — "recovery says a replacement is available, the scheduler says there is none" —
 *   and those are brutally hard to reproduce.
 *
 *   抽出来的理由不是「代码复用」，是**口径统一**：调度器选 Agent 和失败恢复找替补，
 *   各算一套就会互相打架，而且极难复现。
 *
 * ★★ Candidates come from **this project's members**, not from the whole organization.
 *
 *   This used to be `eq(agents.orgId, item.orgId)` — any Agent in the org could be dispatched
 *   onto any project. A project is the boundary for both permissions and context: humans have
 *   always been gated by project_members, and the Agent side was missing that layer entirely.
 *
 *   Agents **outside** the project are still fetched and handed to domain rather than filtered
 *   out in SQL: the candidate panel has to be able to show "it is not in this project" as the
 *   rejection reason, otherwise the user is left staring at an inexplicably empty list.
 *
 *   候选来自本项目成员，不是整个组织。非本项目的 Agent 仍然一并取出来交给 domain 判，
 *   而不是在 SQL 里过滤掉 —— 否则用户看到的是一个没有任何理由的空列表。
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

  /**
   * ★★ Candidate filtering must use the **same** effective scopes that dispatch uses.
   *
   *   A project-level repository is read-only-by-default for every Agent in that project
   *   (effectiveResourceScopes). Judging by the raw agents.resourceScopes here instead produces
   *   "the scheduler says there is no candidate, yet dispatching by hand actually runs" — and
   *   the panel's rejection reason ("X is not in the resource scopes") sends the user off to
   *   grant that access on every single Agent, something the platform already did for them.
   *
   *   候选筛选必须和派发用同一份生效范围：项目级仓库对项目内 Agent 默认只读，
   *   按原始 resourceScopes 判会把人指向一件平台已经替他做完的事。
   */
  const projectRepos = await db
    .select({ ref: repositories.ref })
    .from(repositories)
    .where(
      and(
        eq(repositories.orgId, item.orgId),
        eq(repositories.projectId, item.projectId),
        eq(repositories.status, 'active'),
      ),
    );
  const projectRepoRefs = projectRepos.map((r) => r.ref);

  const loads = await db
    .select({ agentId: agentRuns.agentId, n: count() })
    .from(agentRuns)
    .where(inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]))
    .groupBy(agentRuns.agentId);
  const loadMap = new Map(loads.map((l) => [l.agentId, l.n]));

  /**
   * ★ Today's usage is counted per **calendar day**, matching what tokenLimitDaily means.
   *   With a rolling 24-hour window, "today's budget" would still be occupied by yesterday's
   *   spend well past midnight.
   *
   * ★ All four token counters have to be added together. Dropping one under-counts, and
   *   under-counting only ever makes the budget look unspent, so a dispatch that should have
   *   been held back goes out anyway — this gate always fails in the "allow" direction.
   *
   *   今日用量按自然日算，与 tokenLimitDaily 对齐；四类 token 必须一起加，
   *   少算一类的后果方向永远是放行。
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
    // ★ Filter on createdAt, not startedAt: the latter is nullable (a queued Run has not begun),
    //   so it would drop Runs already in line and about to spend out of the tally
    //   按 createdAt 不按 startedAt：后者可空，用它会漏掉已排队、马上要花钱的 Run
    .where(gte(agentRuns.createdAt, sql`date_trunc('day', now())`))
    .groupBy(agentRuns.agentId);
  const spentMap = new Map(spent.map((s) => [s.agentId, Number(s.total ?? 0)]));

  /**
   * ★★ Candidate permissions always go through the resolver — the **same** function dispatch
   *   calls.
   *
   *   This used to read allowedTools / resourceScopes straight off the agents table while
   *   dispatch computed its own answer. The two paths only diverge on certain inputs, and the
   *   symptom is "the scheduler says there is no candidate, yet dispatching by hand works" —
   *   nearly impossible to reproduce, because you first have to guess which check disagrees.
   *
   *   Authorization also moved from org level to project level: the same Agent may push
   *   branches in project A and only touch the workspace in project B, and that is visible
   *   only if it is evaluated per project right here.
   *
   *   两份实现的代价不是重复代码，是两个对不上的答案；授权本身也是项目级的，
   *   同一个 Agent 在两个项目里可以是两套。
   */
  const grants = await loadProjectGrants(
    db,
    item.projectId,
    rows.map((a) => a.id),
  );

  const accessOf = new Map(
    await Promise.all(
      rows.map(
        async (a) =>
          [
            a.id,
            await resolveAgentAccess(db, a, {
              orgId: item.orgId,
              projectId: item.projectId,
              repoRefs: projectRepoRefs,
              grantOverride: grants.get(a.id) ?? null,
            }),
          ] as const,
      ),
    ),
  );

  const meta = item.typeData;
  const candidates: AgentCandidate[] = rows.map((a) => {
    const stats = (a.stats ?? {}) as Record<string, unknown>;
    const access = accessOf.get(a.id)!;
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      successRate: typeof stats['successRate'] === 'number' ? stats['successRate'] : null,
      sampleSize: typeof stats['sampleSize'] === 'number' ? stats['sampleSize'] : 0,
      avgTokens: typeof stats['avgTokens'] === 'number' ? stats['avgTokens'] : null,
      currentLoad: loadMap.get(a.id) ?? 0,
      maxConcurrency: a.maxConcurrency,
      tokenLimitPerRun: a.tokenLimitPerRun ?? null,
      capabilities: access.capabilities,
      allowedTools: access.runtimePermissions.allowedTools,
      deniedTools: access.runtimePermissions.deniedTools,
      contextAffinity: 0.5,
      status: a.status,
      inProject: members.has(a.id),
      /**
       * ★ With no registry, skip this check and treat the Agent as registered. Recovery and
       *   some tests have no access to the in-process registry; judging every Agent
       *   "unregistered" there would make "is there a stand-in?" answer no, forever.
       *
       *   没有注册表时当成已注册 —— 否则恢复策略永远找不到替补。
       */
      registered: opts.registry ? opts.registry.has(a.id) : true,
      resourceRefs: access.runtimePermissions.resourceScopes
        .filter((s) => s.access !== 'none')
        .map((s) => s.ref),
      tokensToday: spentMap.get(a.id) ?? 0,
      tokenLimitDaily: a.tokenLimitDaily ?? null,
    };
  });

  const target: MatchTarget = {
    type: item.type,
    /**
     * ★ `requiredSkills` 不再读了。计划里可能还留着这一栏（历史行 + 老版
     *   规划输出），但它已经不参与任何判定 —— 保留数据、停止读取，
     *   等确认没有旧逻辑依赖之后再删列。
     */
    requiredCapabilities: Array.isArray(meta['requiredCapabilities'])
      ? (meta['requiredCapabilities'] as string[])
      : [],
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
 * Read the execution mode out of a work item's metadata / 从工作项元数据里读出执行方式。
 *
 * ★★ Backward compatible with old rows: `requiresHuman: true` means `executionMode: 'human'`.
 *
 *   This field was split out of requiresHuman (the other half became approvalGate). Historical
 *   work items carry only requiresHuman in typeData, and defaulting to "no requirement" when the
 *   new field is absent would silently downgrade "only a human may do this" into "anyone may" —
 *   exactly the class of silent change the split was meant to rule out.
 *
 *   历史数据里只有 requiresHuman，读不到就当没要求，等于把「只能人干」静默降级成
 *   「谁都行」。
 */
export function executionModeOf(meta: Record<string, unknown>): ExecutionMode {
  const parsed = ExecutionMode.safeParse(meta['executionMode']);
  if (parsed.success) return parsed.data;
  return meta['requiresHuman'] === true ? 'human' : 'auto';
}

/** Whether anyone other than the current Agent can take over; returns the best fit's id */
export async function findAlternativeAgent(
  db: Database,
  item: WorkItemRow,
  excludeAgentId: string,
): Promise<string | null> {
  const match = await resolveExecutor(db, item, { excludeAgentId });
  return match.candidates[0]?.agentId ?? null;
}
