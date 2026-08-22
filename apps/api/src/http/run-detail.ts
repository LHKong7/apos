import { and, asc, desc, eq, gt, gte, inArray, lte, or, sql } from 'drizzle-orm';
import {
  agentRuns,
  agents,
  artifacts,
  decisions,
  events,
  projects,
  runEvents,
  users,
  workItems,
  type Database,
} from '@apos/db';
import type { AgentPermissions } from '@apos/contracts';
import { notFound } from './errors';
import { serializeEvent } from './serialize';

/**
 * Brief / detailed (page doc 09 §5.3) / 简明与详细。
 *
 * ★ The difference is **how deep each event goes**, not **which events come
 *   back**.
 *
 *   Splitting on run_events.level for a while (brief returning milestones
 *   only) left brief mode with three lines — "started / produced / ended" —
 *   and everything in between gone, when "what did it actually do" is the
 *   entire reason this page exists. That level column is for SSE degradation
 *   and cheap table scans, not for this.
 *
 *   Brief mode returns every event but without the payload: what it drops is
 *   exactly the bulk (full reasoning text, raw tool arguments, context detail),
 *   which is also exactly what the page doc asks to hide.
 */
export type EventLevel = 'brief' | 'detailed';

/**
 * Run detail (page doc 09 §9) / Run 详情。
 *
 * Fetched in one pass rather than five front-end requests — this is a
 * troubleshooting page, and one extra second to open sends people back to
 * reading raw logs / 打开慢一秒都会让人退回去用日志。
 */
export async function getRunDetail(db: Database, runId: string) {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  if (!run) throw notFound('run');

  const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId));
  /**
   * ★ A planning run has no work item — this is not "the work item was
   *   deleted", it was never supposed to have one. Every relation below that
   *   hangs off a work item (sibling attempts, human interventions, policy
   *   hits) comes back empty for it, rather than querying for a row whose id
   *   is null.
   */
  const [item] = run.workItemId
    ? await db.select().from(workItems).where(eq(workItems.id, run.workItemId))
    : [];
  const [project] = await db.select().from(projects).where(eq(projects.id, run.projectId));

  const runEventRows = await db
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(asc(runEvents.seq));

  const artifactRows = await db.select().from(artifacts).where(eq(artifacts.runId, runId));

  const decisionRows = await db.select().from(decisions).where(eq(decisions.runId, runId));

  // ★ "Previous attempts at the same work item" means nothing for a planning run: empty list
  const siblings = run.workItemId
    ? await db
        .select({
          id: agentRuns.id,
          attempt: agentRuns.attempt,
          status: agentRuns.status,
          tokensInput: agentRuns.tokensInput,
          tokensOutput: agentRuns.tokensOutput,
          tokensCacheRead: agentRuns.tokensCacheRead,
          tokensCacheWrite: agentRuns.tokensCacheWrite,
          errorClass: agentRuns.errorClass,
        })
        .from(agentRuns)
        .where(eq(agentRuns.workItemId, run.workItemId))
        .orderBy(asc(agentRuns.attempt))
    : [];

  /**
   * ★ The four token classes are summed on the server. Handing four columns to
   *   the front end to add up again copies the definition of "what counts as
   *   usage" into a second place — add a fifth class of token later and one of
   *   the two is certain to be forgotten.
   */
  const attempts = siblings.map((s) => ({
    id: s.id,
    attempt: s.attempt,
    status: s.status,
    tokens: s.tokensInput + s.tokensOutput + s.tokensCacheRead + s.tokensCacheWrite,
    errorClass: s.errorClass,
  }));

  const interventions = await loadInterventions(db, run);
  const policyHits = await loadPolicyHits(db, run);

  const toolCalls = countToolCalls(runEventRows);
  const startedAt = run.startedAt ?? run.createdAt;
  const endedAt = run.endedAt;

  return {
    run: {
      id: run.id,
      status: run.status,
      attempt: run.attempt,
      idempotencyKey: run.idempotencyKey,
      stepCurrent: run.stepCurrent,
      stepTotal: run.stepTotal,
      stepDescription: run.stepDescription,
      progressNote: run.progressNote,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt?.toISOString() ?? null,
      lastHeartbeatAt: run.lastHeartbeatAt?.toISOString() ?? null,
      timeoutAt: run.timeoutAt?.toISOString() ?? null,
    },
    agent: agent
      ? {
          id: agent.id,
          name: agent.name,
          type: agent.type,
          model: run.model ?? agent.model,
          runtimeKind: agent.runtimeKind,
          tokenLimitPerRun: agent.tokenLimitPerRun,
        }
      : null,
    workItem: item
      ? { id: item.id, title: item.title, status: item.status, estimatedTokens: item.estimatedTokens }
      : null,
    project: project ? { id: project.id, name: project.name } : null,

    /**
     * The input section (page doc 09 §5.4).
     *
     * The context inventory is the heart of troubleshooting: a great many
     * failures root-cause to "something that should have been supplied was
     * not", so listing every item makes the gap obvious at a glance.
     */
    input: {
      goal: run.goal,
      context: run.inputContext,
      model: run.model,
      modelConfig: run.modelConfig,
      tools: run.toolsSnapshot,
      /** ★ Permission snapshot at dispatch. Permissions can change after a run; audits read this */
      permissions: run.permissionSnapshot as AgentPermissions | null,
    },

    metrics: {
      tokens: {
        input: run.tokensInput,
        output: run.tokensOutput,
        cacheRead: run.tokensCacheRead,
        cacheWrite: run.tokensCacheWrite,
        total:
          run.tokensInput + run.tokensOutput + run.tokensCacheRead + run.tokensCacheWrite,
        // Cache hit rate drives usage directly, so it is worth exposing on its own
        cacheHitRate:
          run.tokensInput + run.tokensCacheRead > 0
            ? run.tokensCacheRead / (run.tokensInput + run.tokensCacheRead)
            : 0,
      },
      /** The dollar figure the runtime settled; the UI marks it indicative — no rule ever reads it */
      costUsd: run.cost,
      estimatedTokens: item?.estimatedTokens ?? null,
      tokenLimit: agent?.tokenLimitPerRun ?? null,
      durationMs: (endedAt ?? new Date()).getTime() - startedAt.getTime(),
      toolCalls,
      eventCount: runEventRows.length,
    },

    artifacts: artifactRows.map((a) => ({
      id: a.id,
      kind: a.kind,
      title: a.title,
      storage: a.storage,
      externalUrl: a.externalUrl,
      content: a.content,
      metadata: a.metadata,
      createdAt: a.createdAt.toISOString(),
    })),

    interventions,

    error: run.errorClass
      ? {
          class: run.errorClass,
          message: run.errorMessage,
          detail: run.errorDetail,
          selfReport: run.agentSelfReport,
          failedAt: failurePoint(runEventRows),
        }
      : null,

    related: {
      previousRun: attempts.find((s) => s.id === run.previousRunId) ?? null,
      attempts,
      decisions: decisionRows.map((d) => ({
        id: d.id,
        title: d.title,
        status: d.status,
        type: d.type,
      })),
      policies: policyHits,
    },
  };
}

export interface EventPage {
  events: {
    seq: number;
    ts: string;
    type: string;
    level: string;
    summary: string;
    payload: Record<string, unknown> | null;
    tokensDelta: number | null;
  }[];
  level: EventLevel;
  nextCursor: number | null;
  hasMore: boolean;
}

/**
 * Event pagination / 事件分页。
 *
 * One run can produce thousands of events, and returning them all leaves the
 * page stuck parsing JSON. The `after` cursor doubles as the incremental tail
 * for a run that is still executing.
 */
export async function getRunEvents(
  db: Database,
  runId: string,
  opts: { level?: EventLevel; after?: number; limit?: number } = {},
): Promise<EventPage> {
  const level: EventLevel = opts.level === 'detailed' ? 'detailed' : 'brief';
  const limit = Math.min(opts.limit ?? 200, 500);

  const conditions = [eq(runEvents.runId, runId)];
  if (typeof opts.after === 'number') conditions.push(gt(runEvents.seq, opts.after));

  const rows = await db
    .select()
    .from(runEvents)
    .where(and(...conditions))
    .orderBy(asc(runEvents.seq))
    .limit(limit + 1);

  const page = rows.slice(0, limit);

  return {
    events: page.map((r) => ({
      seq: r.seq,
      ts: r.ts.toISOString(),
      type: r.type,
      level: r.level,
      summary: r.summary,
      // Brief mode drops the payload: the bulk lives here, and hiding it is what the page doc asks
      payload: level === 'detailed' ? r.payload : null,
      /** ★ Rows from before the migration are NULL — nothing was recorded then, not "0 recorded" */
      tokensDelta: r.tokensDelta,
    })),
    level,
    nextCursor: page.at(-1)?.seq ?? null,
    hasMore: rows.length > limit,
  };
}

export interface CostStep {
  step: number | null;
  description: string;
  tokens: number;
  eventCount: number;
}

/**
 * Token distribution per step (page doc 09 §5.6).
 *
 * It answers "which step burns the quota". Without this view an overrun is
 * just one total, while the most common causes of an overrun (context too
 * large, one tool retrying over and over) are visible only per step.
 *
 * ★ Historical rows have a NULL tokens_delta (the column did not exist before
 *   the migration) and count as 0. That makes runs from before the unit change
 *   show as all zeros in this view — an honest "it was not recorded back then"
 *   rather than converting dollars into a plausible-looking fake distribution.
 */
export async function getCostBreakdown(db: Database, runId: string): Promise<CostStep[]> {
  const rows = await db
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(asc(runEvents.seq));

  const steps = new Map<string, CostStep>();
  let current: { step: number | null; description: string } = { step: null, description: '启动与上下文加载' };

  for (const row of rows) {
    if (row.type === 'progress') {
      const payload = row.payload ?? {};
      current = {
        step: typeof payload['step'] === 'number' ? payload['step'] : null,
        description: typeof payload['description'] === 'string' ? payload['description'] : row.summary,
      };
    }

    const key = `${current.step ?? 'pre'}`;
    const entry = steps.get(key) ?? { ...current, tokens: 0, eventCount: 0 };
    entry.tokens += row.tokensDelta ?? 0;
    entry.eventCount += 1;
    steps.set(key, entry);
  }

  return [...steps.values()];
}

// ── Internal ──────────────────────────────────────────────────────────

type RunRow = typeof agentRuns.$inferSelect;
type RunEventRow = typeof runEvents.$inferSelect;

function countToolCalls(rows: RunEventRow[]) {
  const byTool = new Map<string, number>();
  for (const row of rows) {
    if (row.type !== 'tool_call') continue;
    const tool = String(row.payload?.['tool'] ?? '未知');
    byTool.set(tool, (byTool.get(tool) ?? 0) + 1);
  }
  return {
    total: [...byTool.values()].reduce((a, b) => a + b, 0),
    byTool: Object.fromEntries([...byTool.entries()].sort((a, b) => b[1] - a[1])),
  };
}

/** Which step the failure happened at — a location is far more useful than "it failed" */
function failurePoint(rows: RunEventRow[]): { step: number | null; total: number | null; at: string | null } {
  const errorAt = rows.findIndex((r) => r.type === 'error');
  if (errorAt === -1) return { step: null, total: null, at: null };

  for (let i = errorAt; i >= 0; i--) {
    const row = rows[i]!;
    if (row.type !== 'progress') continue;
    const payload = row.payload ?? {};
    return {
      step: typeof payload['step'] === 'number' ? payload['step'] : null,
      total: typeof payload['totalSteps'] === 'number' ? payload['totalSteps'] : null,
      at: rows[errorAt]!.ts.toISOString(),
    };
  }
  return { step: null, total: null, at: rows[errorAt]!.ts.toISOString() };
}

/**
 * What humans did during this run / 人类在这次 Run 期间做了什么。
 *
 * Selected by time window rather than by subject — a human intervention can
 * land on the work item instead (taking over, attaching a constraint, forcing
 * a release), and querying agent_run alone would miss every one of them.
 */
async function loadInterventions(db: Database, run: RunRow) {
  const from = run.startedAt ?? run.createdAt;
  const to = run.endedAt ?? new Date();

  const rows = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.actorType, 'human'),
        // ★ With no work item, match on the run alone — never compare against null
        run.workItemId
          ? or(eq(events.subjectId, run.id), eq(events.subjectId, run.workItemId))
          : eq(events.subjectId, run.id),
        gte(events.occurredAt, from),
        lte(events.occurredAt, to),
      ),
    )
    .orderBy(asc(events.id));

  if (rows.length === 0) return [];

  const actorIds = [...new Set(rows.map((r) => r.actorId).filter((id): id is string => Boolean(id)))];
  const userRows = actorIds.length
    ? await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, actorIds))
    : [];
  const nameOf = new Map(userRows.map((u) => [u.id, u.name]));

  return rows.map((r) => ({
    ...serializeEvent(r),
    actorName: r.actorId ? (nameOf.get(r.actorId) ?? '未知') : '未知',
  }));
}

/** Policies hit during the run — an audit has to answer which rule let it through or blocked it */
async function loadPolicyHits(db: Database, run: RunRow) {
  // ★ Policy evaluations hang off the work item; a planning run has none, so no hits either
  if (!run.workItemId) return [];
  const from = run.startedAt ?? run.createdAt;
  const to = run.endedAt ?? new Date();

  const rows = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.type, 'policy.evaluated'),
        eq(events.subjectId, run.workItemId),
        gte(events.occurredAt, from),
        lte(events.occurredAt, to),
      ),
    )
    .orderBy(desc(events.id))
    .limit(20);

  return rows
    .map((r) => {
      const payload = r.payload ?? {};
      return {
        eventId: String(r.id),
        policyId: (payload['matchedPolicyId'] as string | null) ?? null,
        policyName: (payload['matchedPolicyName'] as string | null) ?? null,
        action: payload['action'] ?? null,
        occurredAt: r.occurredAt.toISOString(),
      };
    })
    // An evaluation that matched no rule carries no troubleshooting signal, so drop it
    .filter((p) => p.policyName !== null);
}

export { sql };
