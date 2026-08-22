import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  agentPermissionChanges,
  agentRuns,
  agents,
  projectMembers,
  projects,
  users,
  workItems,
  type Database,
} from '@apos/db';
import { ACTIVE_RUN_STATUSES, DEGRADATION_MATRIX, type FeatureKey } from '@apos/contracts';
import { computeAgents, isTerminal, windowFor, type AgentPerf } from '@apos/domain';
import { checkCompatibility, type RuntimeRegistry } from '@apos/agent-runtimes';
import { runtimeKindSpec } from '@apos/contracts';
import { notFound } from './errors';
import { loadAnalyticsInput } from './analytics';

/**
 * Agent Workspace (page doc 08) / Agent 工作台。
 *
 * ★ The design register is "personnel file + workbench", not "service settings
 *   page". So everything returned here is organized the way an HR record would
 *   be: what it is working on, how well it does, what it is allowed to do, what
 *   it has cost, and how to step in when something goes wrong — rather than a
 *   pile of runtime configuration fields.
 */

export async function listAgents(db: Database, projectId: string | null, orgId: string) {
  // ★ Even without a projectId the query must be narrowed by org — otherwise the roster
  //   lists agents belonging to other organizations.
  /** ★ The org-level view has no notion of "this project", so membership is null, not false */
  const rows: (typeof agents.$inferSelect & { inProject?: boolean })[] = projectId
    ? await agentsOfProject(db, projectId)
    : await db.select().from(agents).where(eq(agents.orgId, orgId));

  if (rows.length === 0) return { agents: [], totals: EMPTY_TOTALS };

  const perf = await performanceByAgent(db, projectId);
  const active = await db
    .select()
    .from(agentRuns)
    .where(inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]));

  const userRows = await db.select({ id: users.id, name: users.name }).from(users);
  const userName = new Map(userRows.map((u) => [u.id, u.name]));

  const list = rows.map((a) => {
    const p = perf.get(a.id);
    const running = active.filter((r) => r.agentId === a.id).length;
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      model: a.model,
      /**
       * ★★ Two unrelated states, reported in two separate fields.
       *
       *   `status` is the **lifecycle** (active / paused / retired);
       *   `inProject` is **membership in this project**. The UI used to show
       *   only the first, and painted retired and active alike as a green
       *   "normal" — so a retired agent read "● normal" on the roster while
       *   the board flagged it as "status is retired" (issue log #10 / #11).
       */
      status: a.status,
      pausedReason: a.pausedReason,
      inProject: a.inProject ?? null,
      /** Load: runs in flight over the concurrency ceiling */
      load: { running, max: a.maxConcurrency },
      runs: p?.runs ?? 0,
      successRate: p?.successRate ?? null,
      firstTrySuccessRate: p?.firstTrySuccessRate ?? null,
      overrideRate: p?.overrideRate ?? null,
      tokens: p?.totalTokens ?? 0,
      ownerName: userName.get(a.ownerId) ?? '未知',
    };
  });

  const totalRuns = list.reduce((s, a) => s + a.runs, 0);
  return {
    agents: list,
    totals: {
      tokens: Math.round(list.reduce((s, a) => s + a.tokens, 0)),
      runs: totalRuns,
      successRate:
        totalRuns === 0
          ? null
          : round4(
              list.reduce((s, a) => s + (a.successRate ?? 0) * a.runs, 0) / totalRuns,
            ),
    },
  };
}

export async function getAgent(
  db: Database,
  registry: RuntimeRegistry,
  agentId: string,
) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) throw notFound('agent');

  const runs = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.agentId, agentId))
    .orderBy(desc(agentRuns.createdAt))
    .limit(20);

  const itemIds = [...new Set(runs.map((r) => r.workItemId).filter((id) => id !== null))];
  const items =
    itemIds.length > 0
      ? await db.select().from(workItems).where(inArray(workItems.id, itemIds))
      : [];
  const itemById = new Map(items.map((i) => [i.id, i]));

  /**
   * ★ The "queue" holds only unfinished work.
   *
   *   executorId is a permanent assignment, not a queue — listing it directly
   *   counts everything this agent has ever done into "queue: 16", so the user
   *   reads "it has 16 items piled up" when the truth is 1 running and 15
   *   delivered long ago. The finished count goes to doneCount, and the
   *   history lives in the run records further down.
   */
  const assigned = await db
    .select()
    .from(workItems)
    .where(and(eq(workItems.executorType, 'agent'), eq(workItems.executorId, agentId)));
  const queue = assigned.filter((i) => !isTerminal(i.status));
  const doneCount = assigned.length - queue.length;

  const changes = await db
    .select()
    .from(agentPermissionChanges)
    .where(eq(agentPermissionChanges.agentId, agentId))
    .orderBy(desc(agentPermissionChanges.createdAt))
    .limit(10);

  const userRows = await db.select({ id: users.id, name: users.name }).from(users);
  const userName = new Map(userRows.map((u) => [u.id, u.name]));

  const perf = await performanceByAgent(db, null);
  const p = perf.get(agentId);

  /**
   * ★ Runtime capability report (page doc 08 §5 / 14 §5.4).
   *
   *   No silent degradation: what this runtime cannot do, what happens when it
   *   cannot, and what that means for the user are all laid out. Before handing
   *   an agent a high-risk task, the user has a right to know that "pause on
   *   this agent is really terminate".
   */
  let capability: CapabilityReport | null = null;
  if (registry.has(agent.id)) {
    try {
      const manifest = await registry.get(agent.id).getCapabilities();
      capability = buildCapability(manifest);
    } catch {
      capability = null;
    }
  }

  return {
    agent: {
      id: agent.id,
      name: agent.name,
      type: agent.type,
      description: agent.description,
      model: agent.model,
      status: agent.status,
      pausedReason: agent.pausedReason,
      skills: agent.skills,
      applicableTypes: agent.applicableTypes,
      maxConcurrency: agent.maxConcurrency,
      timeoutSeconds: agent.timeoutSeconds,
      tokenLimitPerRun: agent.tokenLimitPerRun,
      tokenLimitDaily: agent.tokenLimitDaily,
      ownerName: userName.get(agent.ownerId) ?? '未知',
      /** The runtime is a property of the agent itself, no longer a shared "connection" object */
      runtime: {
        kind: agent.runtimeKind,
        config: agent.runtimeConfig,
        endpoint: agent.endpoint,
        credentialHint: agent.credentialHint,
      },
    },

    /**
     * ★ Permissions are configured independently and never inherited from a
     *   human user (product doc X). The page lists the deny list separately and
     *   marks it "cannot be overridden by a template or by inheritance" — an
     *   agent profile whose boundary you cannot see is a profile with no
     *   boundary at all.
     */
    permissions: {
      allowedTools: agent.allowedTools,
      deniedTools: agent.deniedTools,
      resourceScopes: agent.resourceScopes,
    },

    performance: p
      ? {
          runs: p.runs,
          successRate: p.successRate,
          firstTrySuccessRate: p.firstTrySuccessRate,
          overrideRate: p.overrideRate,
          avgTokens: p.avgTokens,
          totalTokens: p.totalTokens,
          avgMinutes: p.avgMinutes,
        }
      : null,

    /** Executing items sort first — "what is it doing right now" is the first question here */
    queue: queue
      .sort((a, b) => queueRank(a.status) - queueRank(b.status))
      .map((i) => ({
        id: i.id,
        title: i.title,
        status: i.status,
        riskLevel: i.riskLevel,
      })),
    queueDoneCount: doneCount,

    recentRuns: runs.map((r) => ({
      id: r.id,
      kind: r.kind,
      workItemId: r.workItemId,
      // ★ A planning run never has a work item — a different thing from "the work item was
      //   deleted", so the two must not collapse into one sentence.
      workItemTitle: r.workItemId
        ? (itemById.get(r.workItemId)?.title ?? '（已删除）')
        : '（需求分析 / 计划生成）',
      status: r.status,
      attempt: r.attempt,
      cost: Number(r.cost),
      errorClass: r.errorClass,
      startedAt: r.startedAt?.toISOString() ?? null,
      endedAt: r.endedAt?.toISOString() ?? null,
    })),

    capability,

    /** Permission change history — who widened this agent's boundary, and when */
    permissionChanges: changes.map((c) => ({
      direction: c.direction,
      changedBy: userName.get(c.changedBy) ?? c.changedBy,
      reason: c.reason,
      createdAt: c.createdAt.toISOString(),
    })),
  };
}

/**
 * Runtime capability inventory (the part of page doc 14 §5.4 that is real).
 *
 * This is the only slice of "integration settings" with a real backend behind
 * it: capability negotiation and the degradation matrix are implemented in the
 * agent protocol. External system integration (Jira / GitHub / Slack) has no
 * backend at all, so that part is not built.
 *
 * ★ With the "runtime connection" layer gone, this aggregates by **CLI kind**
 *   rather than by connection row — the question to answer is "which kinds of
 *   code agent is this org running, and what can each do", not "how many
 *   connection records exist". Agents of the same kind report identical
 *   capabilities, so probing any one registered instance is enough.
 */
export async function listRuntimes(db: Database, registry: RuntimeRegistry) {
  const agentRows = await db.select().from(agents);

  const byKind = new Map<string, typeof agentRows>();
  for (const a of agentRows) {
    const list = byKind.get(a.runtimeKind);
    if (list) list.push(a);
    else byKind.set(a.runtimeKind, [a]);
  }

  const out = [];
  for (const [kind, used] of byKind) {
    const spec = runtimeKindSpec(kind);
    // Probe capabilities via the first registered agent — same kind, same inventory
    const probeTarget = used.find((a) => registry.has(a.id));

    let capability: CapabilityReport | null = null;
    let reachable = false;
    if (probeTarget) {
      try {
        capability = buildCapability(await registry.get(probeTarget.id).getCapabilities());
        reachable = true;
      } catch {
        reachable = false;
      }
    }

    out.push({
      id: kind,
      name: spec?.label ?? kind,
      kind,
      status: used.some((a) => a.status === 'active') ? 'active' : 'inactive',
      protocolVersion: capability?.protocolVersion ?? null,
      /** No adapter registered in this process = this runtime kind cannot be dispatched to at all */
      registered: Boolean(probeTarget),
      reachable,
      agentCount: used.length,
      agentNames: used.map((a) => a.name),
      capability,
    });
  }

  return { runtimes: out };
}

/** Queue order: running → stuck → waiting. Waiting-on-a-human counts as stuck, because it is */
function queueRank(status: string): number {
  if (status === 'executing' || status === 'releasing') return 0;
  if (status === 'blocked' || status === 'failed' || status === 'awaiting_decision') return 1;
  return 2;
}

type CapabilityReport = ReturnType<typeof buildCapability>;

function buildCapability(manifest: Awaited<ReturnType<import('@apos/agent-runtimes').AgentRuntimeAdapter['getCapabilities']>>) {
  const report = checkCompatibility(manifest);
  return {
    runtime: manifest.runtime,
    protocolVersion: manifest.protocolVersion,
    transport: manifest.transport,
    models: manifest.models,
    limits: manifest.limits,
    tools: manifest.tools,
    supported: report.supported.map((f) => ({ feature: f, label: FEATURE_LABELS[f] ?? f })),
    missing: report.missing.map((m) => ({
      ...m,
      label: FEATURE_LABELS[m.feature] ?? m.feature,
    })),
    /** A missing critical feature = do not run high-risk work on this runtime */
    restricted: report.restricted,
  };
}

/** Chinese names for the capability keys. This list is read by project leads, not by protocol implementers. */
const FEATURE_LABELS: Record<FeatureKey, string> = {
  streamingEvents: '实时事件流',
  toolCallVisibility: '工具调用可见',
  reasoningVisibility: '推理过程可见',
  costReporting: '成本上报',
  tokenReporting: 'Token 用量上报',
  progressReporting: '进度上报',
  runtimeConstraints: '执行中注入约束',
  interventionRequest: 'Agent 主动求助',
  selfReportOnFailure: '失败时自述原因',
  pause: '暂停（可恢复）',
  terminate: '终止',
  statusQuery: '主动查询状态',
  subAgentDelegation: '子 Agent 委派',
  artifactUpload: '产物上传',
};

void DEGRADATION_MATRIX;

/**
 * Project roster / 项目花名册。
 *
 * ★★ This deliberately **lists every agent in the org**, not only project
 *   members — "the org has it but this project hasn't added it" is exactly the
 *   state the user needs to see on this page. List members only and those
 *   agents vanish from the roster while the board keeps saying "refactor-agent
 *   is not a member of this project".
 *
 * ★★ But each row must **say which it is**. Every row used to render
 *   identically, so the roster said refactor-agent was perfectly fine and the
 *   board said it was not in this project — both true, and what the user saw
 *   was a system contradicting itself (issue log #10).
 *
 *   两句都对，用户看到的是系统在自相矛盾。
 */
async function agentsOfProject(db: Database, projectId: string) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw notFound('project');

  const rows = await db.select().from(agents).where(eq(agents.orgId, project.orgId));
  const members = await db
    .select({ actorId: projectMembers.actorId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.actorType, 'agent')));
  const memberIds = new Set(members.map((m) => m.actorId));

  return rows.map((a) => ({ ...a, inProject: memberIds.has(a.id) }));
}

/** Performance is measured exactly as Analytics measures it — two definitions will diverge */
async function performanceByAgent(
  db: Database,
  projectId: string | null,
): Promise<Map<string, AgentPerf>> {
  const projectRows = projectId
    ? await db.select().from(projects).where(eq(projects.id, projectId))
    : await db.select().from(projects);

  const now = Date.now();
  const window = windowFor('30d', now);
  const merged = new Map<string, AgentPerf>();

  for (const project of projectRows) {
    const input = await loadAnalyticsInput(db, project, window, now);
    for (const a of computeAgents(input).agents) {
      const seen = merged.get(a.agentId);
      if (!seen) {
        merged.set(a.agentId, a);
        continue;
      }
      // Merging across projects weights by run count, not a plain average
      const runs = seen.runs + a.runs;
      merged.set(a.agentId, {
        ...seen,
        runs,
        successRate: weighted(seen, a, (x) => x.successRate, runs),
        firstTrySuccessRate: weighted(seen, a, (x) => x.firstTrySuccessRate, runs),
        overrideRate: weighted(seen, a, (x) => x.overrideRate, runs),
        totalTokens: Math.round(seen.totalTokens + a.totalTokens),
        avgTokens: Math.round((seen.totalTokens + a.totalTokens) / runs),
        avgMinutes:
          seen.avgMinutes === null
            ? a.avgMinutes
            : a.avgMinutes === null
              ? seen.avgMinutes
              : Math.round(((seen.avgMinutes * seen.runs + a.avgMinutes * a.runs) / runs) * 10) / 10,
      });
    }
  }

  return merged;
}

function weighted(a: AgentPerf, b: AgentPerf, pick: (x: AgentPerf) => number, runs: number): number {
  return Math.round(((pick(a) * a.runs + pick(b) * b.runs) / runs) * 1000) / 1000;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

const EMPTY_TOTALS = { cost: 0, runs: 0, successRate: null as number | null };
