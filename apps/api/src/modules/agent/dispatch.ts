import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import {
  agents,
  artifacts,
  projectConventions,
  projects,
  repositories,
  requirements,
  workItems,
  agentRuns,
  type Database,
} from '@apos/db';
import { selectPolicyGates } from '@apos/domain';
import {
  ACTIVE_RUN_STATUSES,
  agentActor,
  SYSTEM_ACTOR,
  type AgentPermissions,
  type AgentPermissionSnapshot,
  type TaskDispatch,
} from '@apos/contracts';
import { usdCeilingForTokens, type RuntimeRegistry } from '@apos/agent-runtimes';
import { emitAndPublish } from '../event/bus';
import { buildPolicyContext } from '../flow/context';
import { loadPolicies, transition } from '../flow/transition';
import { resolveAgentAccess } from './access';
import type { WorkspaceService } from '../workspace';
import { ingestRunEvent } from './ingest';

export interface DispatchInput {
  workItemId: string;
  agentId: string;
  correlationId: string;
  /** Extra context supplied on a retry */
  additionalContext?: { title: string; content: string }[];
  /** Caller-supplied idempotency key; derived from (workItemId, attempt) when omitted */
  idempotencyKey?: string;
}

export interface DispatchDeps {
  /** Omitting it degrades to "no workspace provisioning"; only for tests that touch no repository */
  workspaces?: WorkspaceService;
}

export type DispatchResult =
  | { ok: true; runId: string; attempt: number; reused: boolean }
  | {
      ok: false;
      code: 'AGENT_UNAVAILABLE' | 'TRANSITION_REJECTED' | 'WORKSPACE_UNAVAILABLE';
      detail: unknown;
    };

/**
 * Dispatches one Agent execution / 派发一次 Agent 执行。
 *
 * Three things matter here:
 * 1. idempotencyKey prevents double dispatch — a network retry making the Agent
 *    edit the same code twice is a real risk, not a theoretical one
 * 2. The intermediate `dispatching` state separates "not dispatched yet" from
 *    "dispatched but the outcome is unknown"
 * 3. Permissions and the tool set are snapshotted at dispatch time, so a config
 *    change during the Run does not affect an execution already in flight
 */
export async function dispatchRun(
  db: Database,
  registry: RuntimeRegistry,
  input: DispatchInput,
  deps: DispatchDeps = {},
): Promise<DispatchResult> {
  const [item] = await db.select().from(workItems).where(eq(workItems.id, input.workItemId));
  if (!item) return { ok: false, code: 'AGENT_UNAVAILABLE', detail: 'work item not found' };

  const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId));
  if (!agent || agent.status !== 'active') {
    return { ok: false, code: 'AGENT_UNAVAILABLE', detail: { agentId: input.agentId } };
  }

  /**
   * ★ The registry is keyed by agentId: every Agent gets its own runtime
   *   instance, because each carries its own CLI parameters (effort / maxTurns
   *   / sandbox tier, …).
   */
  if (!registry.has(agent.id)) {
    return {
      ok: false,
      code: 'AGENT_UNAVAILABLE',
      detail: { agentId: agent.id, runtimeKind: agent.runtimeKind },
    };
  }

  const priorRuns = await db
    .select({ id: agentRuns.id, attempt: agentRuns.attempt, status: agentRuns.status })
    .from(agentRuns)
    .where(eq(agentRuns.workItemId, item.id));

  /**
   * ★ The core invariant: one Work Item may have at most one active Run.
   *
   * Without this guard, scheduler reentrancy or a redelivered callback puts two
   * Agents into the same code at the same time. It is more reliable than
   * deduplicating on idempotencyKey, which depends on the caller generating the
   * right key.
   */
  const active = priorRuns.find((r) =>
    (ACTIVE_RUN_STATUSES as readonly string[]).includes(r.status),
  );
  if (active) {
    return { ok: true, runId: active.id, attempt: active.attempt, reused: true };
  }

  const attempt = priorRuns.length + 1;
  const idempotencyKey = input.idempotencyKey ?? `${item.id}:${attempt}`;

  /**
   * Repositories registered at **project** level and active — Agents in this
   * project can read them by default / 它们对项目内的 Agent 默认只读。
   *
   * ★ Only rows matching this projectId; org-level rows (projectId is null) are
   *   excluded. An org-level repository is visible to the whole organization,
   *   so handing it over by default would mean "an Agent in project A can
   *   automatically read project B's code". Granting across projects has to be
   *   a decision someone makes.
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

  /**
   * ★★ Permissions are evaluated in **this one place**, not inside acquire() or
   *   the adapter.
   *
   *   The result is both persisted as the audit record and passed verbatim to
   *   workspace provisioning and to the runtime — computed once here, all three
   *   necessarily agree. Computed separately, "what the Agent could actually do
   *   at the time" and "what the audit record says it could do" diverge, which
   *   defeats the entire purpose of taking a snapshot.
   *
   * ★★ It goes through the **same** function the scheduler's matching uses
   *   (resolveAgentAccess). What two separate implementations cost is written
   *   up in modules/agent/matching.ts.
   */
  const access = await resolveAgentAccess(db, agent, {
    orgId: item.orgId,
    projectId: item.projectId,
    repoRefs: projectRepos.map((r) => r.ref),
  });

  /** The copy sent to the runtime and the workspace — at the protocol layer these are still tool names */
  const permissionSnapshot: AgentPermissions = {
    allowedTools: access.runtimePermissions.allowedTools,
    deniedTools: access.runtimePermissions.deniedTools,
    resourceScopes: access.runtimePermissions.resourceScopes,
  };

  /**
   * The copy written to the database (v2) / 落库的那一份。
   *
   * ★★ It carries more than the dispatched copy: semantic capabilities, the
   *   profile, and the provenance. Six months later the person reading the
   *   audit trail is asking "what was it authorized to do at the time", and
   *   tool names cannot answer that — the same `['Read','Edit']` means
   *   different things before and after an adapter revision.
   *
   * ★ Historical snapshots (v1, with no version field) are kept **exactly as
   *   they are**: never migrated, never backfilled. They are the record of that
   *   execution, and rewriting one is forging evidence. Readers tell them apart
   *   by the version field.
   */
  const storedSnapshot: AgentPermissionSnapshot = {
    version: 2,
    profileKey: access.profileKey,
    profileVersion: access.profileVersion,
    capabilities: access.capabilities,
    deniedCapabilities: access.deniedCapabilities,
    allowedTools: permissionSnapshot.allowedTools,
    deniedTools: permissionSnapshot.deniedTools,
    resourceScopes: permissionSnapshot.resourceScopes,
    sources: access.sources,
    degradations: access.degradations,
  };

  const context = await buildRunContext(db, item, input.additionalContext);

  /** ★ Output language is a project property — a scheduler dispatch has no request, so there is no X-Locale to read */
  const [project] = await db
    .select({ outputLocale: projects.outputLocale })
    .from(projects)
    .where(eq(projects.id, item.projectId));
  const outputLocale = project?.outputLocale ?? 'en';

  // Dispatching to an Agent is what makes it the executor — keeping dispatchRun
  // self-consistent, so a scheduler call and a manual "retry with this Agent"
  // behave identically
  if (item.executorType !== 'agent' || item.executorId !== agent.id) {
    await db
      .update(workItems)
      .set({ executorType: 'agent', executorId: agent.id })
      .where(eq(workItems.id, item.id));
    item.executorType = 'agent';
    item.executorId = agent.id;
  }

  const runId = randomUUID();
  await db.insert(agentRuns).values({
    id: runId,
    orgId: item.orgId,
    projectId: item.projectId,
    workItemId: item.id,
    agentId: agent.id,
    attempt,
    previousRunId: priorRuns.at(-1)?.id ?? null,
    status: 'dispatching',
    idempotencyKey,
    goal: item.title,
    inputContext: context,
    model: agent.model,
    toolsSnapshot: permissionSnapshot.allowedTools,
    permissionSnapshot: storedSnapshot,
    timeoutAt: new Date(Date.now() + agent.timeoutSeconds * 1000),
  });

  await emitAndPublish(db, {
    type: 'agent_run.dispatched',
    orgId: item.orgId,
    projectId: item.projectId,
    actor: SYSTEM_ACTOR,
    subjectType: 'agent_run',
    subjectId: runId,
    payload: {
      workItemId: item.id,
      agentId: agent.id,
      attempt,
      idempotencyKey,
      contextSize: context.length,
    },
    correlationId: input.correlationId,
  });

  // Transition: ready → executing. When a Guard or Policy blocks it, nothing is actually dispatched.
  const moved = await transition(db, {
    workItemId: item.id,
    trigger: 'run_dispatched',
    actor: agentActor(agent.id),
    correlationId: input.correlationId,
  });

  if (!moved.ok) {
    await db
      .update(agentRuns)
      .set({ status: 'terminated', errorClass: 'invalid_task', errorMessage: '状态流转被拒绝' })
      .where(eq(agentRuns.id, runId));
    return { ok: false, code: 'TRANSITION_REJECTED', detail: moved };
  }

  // Policy may reroute the item to awaiting_decision — in which case the Agent must not actually start
  if (moved.to !== 'executing') {
    await db
      .update(agentRuns)
      .set({ status: 'queued', errorMessage: null })
      .where(eq(agentRuns.id, runId));
    return { ok: true, runId, attempt, reused: false };
  }

  /**
   * ★ The workspace is prepared **before** dispatch, provisioned by the
   *   platform in one place.
   *
   *   It lives here rather than in the adapter because "where to clone, which
   *   branch to open, whether to push afterward" is the same for every runtime;
   *   and more importantly because failure has to be caught at this step. Let
   *   an Agent start work in an empty directory and it will confidently report
   *   "no relevant code found, created a new implementation" — a failure ten
   *   times harder to trace than an error.
   */
  const acquired = deps.workspaces
    ? await deps.workspaces.acquire({
        runId,
        orgId: item.orgId,
        projectId: item.projectId,
        workItemId: item.id,
        workItemTitle: item.title,
        permissions: permissionSnapshot,
      })
    : ({ ok: true, workspace: null, note: '未启用工作区供给' } as const);

  if (!acquired.ok) {
    /**
     * ★★ Record the error class only; do **not** set status to failed here.
     *
     *   ingestRunEvent opens with a gate that ignores every event arriving after
     *   a terminal state. Mark the Run failed first and the run_ended below is
     *   swallowed by that gate — endedAt is never written, no run_events row
     *   appears, agent_run.failed is never emitted, and the work item never
     *   transitions: it looks like the teardown ran while in fact nothing
     *   happened. Status and endedAt are settled by run_ended itself
     *   (applyRunPatch); all that is left here is the errorClass decideRecovery
     *   needs.
     */
    await db
      .update(agentRuns)
      .set({ errorClass: 'context_insufficient', errorMessage: acquired.reason })
      .where(eq(agentRuns.id, runId));

    await ingestRunEvent(db, {
      runId,
      event: {
        runId,
        seq: 0,
        ts: new Date().toISOString(),
        type: 'run_ended',
        outcome: 'failed',
        summary: acquired.reason,
        selfReport: '平台没能为这次执行准备好代码工作区，任务未开始。',
      },
      correlationId: input.correlationId,
    });

    return { ok: false, code: 'WORKSPACE_UNAVAILABLE', detail: { reason: acquired.reason } };
  }

  /**
   * Tells the Agent, before dispatch, which situations will stop this work and
   * hand it to a human / 派发前告诉 Agent 哪些情形会把这次工作拦下转人工。
   *
   * ★ Reuses the contextSnapshot the transition just computed rather than
   *   rebuilding it. It is the output of buildPolicyContext() and the very same
   *   object written into the policy.evaluated event. Build a second one and
   *   the two drift silently as facts are added or removed — and the way that
   *   drift presents is "the warning said it would be gated, and it was not".
   */
  const policyGates = selectPolicyGates(
    await db.transaction((tx) => loadPolicies(tx, item.orgId, item.projectId)),
    moved.verdict.contextSnapshot,
  );

  const adapter = registry.get(agent.id);
  const task: TaskDispatch = {
    runId,
    idempotencyKey,
    policyGates,
    agent: {
      name: agent.name,
      type: agent.type,
      description: agent.description,
      skills: agent.skills,
    },
    workspace: acquired.workspace,
    /** ★ Language is a project property — a scheduler dispatch has no request and no "current user" */
    outputLocale: outputLocale === 'zh' ? 'zh' : 'en',
    goal: {
      title: item.title,
      description: item.description ?? '',
      acceptanceCriteria: item.acceptanceCriteria.map((c) => ({ id: c.id, text: c.text })),
      constraints: item.constraints.map((c) => ({
        type: c.type,
        value: c.value,
        description: c.description,
      })),
    },
    context,
    permissions: permissionSnapshot,
    limits: {
      maxTokens: agent.tokenLimitPerRun,
      maxCostUsd: usdCeilingForTokens(agent.model, agent.tokenLimitPerRun),
      maxDurationSeconds: agent.timeoutSeconds,
    },
    model: agent.model,
    callback: { eventsUrl: `/api/v1/agent-callback/runs/${runId}/events`, token: runId },
  };

  const ack = await adapter.dispatch(task);
  if (!ack.accepted) {
    // ★ As above: run_ended settles the status; writing it first gets swallowed by ingest's terminal-state gate
    await db
      .update(agentRuns)
      .set({
        errorClass: 'runtime_error',
        errorMessage: ack.rejectReason ?? '运行时拒绝任务',
      })
      .where(eq(agentRuns.id, runId));

    /**
     * ★★ A runtime refusing the task also has to go through run_ended, exactly
     *   like the "workspace unavailable" branch above.
     *
     *   This used to just mark the Run failed and return. The cost was that the
     *   work item stayed pinned at `executing` forever: nobody rolled back the
     *   ready → executing transition made above, not one run_events row was
     *   written, and the `agent_run.failed` domain event never existed. And
     *   run-supervisor only looks at the dispatching / running states, so a
     *   failed Run is outside its field of view — no loop could ever touch that
     *   work item again, while the board still counted "1 Agent running" from
     *   `status = 'executing'`.
     *
     *   ingestRunEvent does all of it in one step: writes run_events, sets
     *   endedAt, emits agent_run.failed, transitions out of executing on
     *   agent_run_failed, and lets decideRecovery choose between a retry and
     *   handing it to a human.
     *
     *   ★ deps has to be passed down here (the branch above does not need it):
     *     the workspace **has** already been acquired, and not releasing it
     *     leaves the work tree on disk with the Run over and nobody left to
     *     collect it.
     */
    await ingestRunEvent(
      db,
      {
        runId,
        event: {
          runId,
          seq: 0,
          ts: new Date().toISOString(),
          type: 'run_ended',
          outcome: 'failed',
          summary: ack.rejectReason ?? '运行时拒绝任务',
          selfReport: '运行时拒绝接收这次派发，任务未开始。',
        },
        correlationId: input.correlationId,
      },
      deps,
    );

    return { ok: false, code: 'AGENT_UNAVAILABLE', detail: ack };
  }

  await db
    .update(agentRuns)
    .set({ status: 'running', startedAt: new Date(), lastHeartbeatAt: new Date() })
    .where(eq(agentRuns.id, runId));

  await adapter.subscribe(runId, async (event) => {
    await ingestRunEvent(db, { runId, event, correlationId: input.correlationId }, deps);
  });

  return { ok: true, runId, attempt, reused: false };
}

/**
 * Continue the exact Run that was parked at a Policy gate during dispatch.
 * The audit row already exists and the approved work item is already
 * `executing`, so creating a second Run would either duplicate work or leave
 * the original queued forever.
 */
export async function resumeQueuedRun(
  db: Database,
  registry: RuntimeRegistry,
  input: { workItemId: string; correlationId: string },
  deps: DispatchDeps = {},
): Promise<DispatchResult | null> {
  const [item] = await db.select().from(workItems).where(eq(workItems.id, input.workItemId));
  if (!item || item.status !== 'executing' || item.humanGate !== 'approved') return null;

  const [run] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.workItemId, item.id), eq(agentRuns.status, 'queued')))
    .limit(1);
  if (!run) return null;

  const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId));
  if (!agent || agent.status !== 'active' || !registry.has(agent.id)) {
    return {
      ok: false,
      code: 'AGENT_UNAVAILABLE',
      detail: { agentId: run.agentId, runtimeKind: agent?.runtimeKind ?? null },
    };
  }

  // Claim once: simultaneous approval replays must not dispatch the CLI twice.
  const claimed = await db
    .update(agentRuns)
    .set({ status: 'dispatching' })
    .where(and(eq(agentRuns.id, run.id), eq(agentRuns.status, 'queued')))
    .returning({ id: agentRuns.id });
  if (claimed.length === 0) {
    return { ok: true, runId: run.id, attempt: run.attempt, reused: true };
  }

  const stored = run.permissionSnapshot;
  const permissionSnapshot: AgentPermissions = {
    allowedTools: run.toolsSnapshot,
    deniedTools: stored?.deniedTools ?? [],
    resourceScopes: stored?.resourceScopes ?? [],
  };
  const context = run.inputContext as TaskDispatch['context'];
  const [project] = await db
    .select({ outputLocale: projects.outputLocale })
    .from(projects)
    .where(eq(projects.id, item.projectId));
  const policyContext = await db.transaction((tx) => buildPolicyContext(tx, item));

  const acquired = deps.workspaces
    ? await deps.workspaces.acquire({
        runId: run.id,
        orgId: item.orgId,
        projectId: item.projectId,
        workItemId: item.id,
        workItemTitle: item.title,
        permissions: permissionSnapshot,
      })
    : ({ ok: true, workspace: null, note: '未启用工作区供给' } as const);

  if (!acquired.ok) {
    await db
      .update(agentRuns)
      .set({ errorClass: 'context_insufficient', errorMessage: acquired.reason })
      .where(eq(agentRuns.id, run.id));
    await ingestRunEvent(db, {
      runId: run.id,
      event: {
        runId: run.id,
        seq: 0,
        ts: new Date().toISOString(),
        type: 'run_ended',
        outcome: 'failed',
        summary: acquired.reason,
        selfReport: '平台没能为批准后的执行准备好代码工作区，任务未开始。',
      },
      correlationId: input.correlationId,
    });
    return { ok: false, code: 'WORKSPACE_UNAVAILABLE', detail: { reason: acquired.reason } };
  }

  const policyGates = selectPolicyGates(
    await db.transaction((tx) => loadPolicies(tx, item.orgId, item.projectId)),
    policyContext,
  );
  const adapter = registry.get(agent.id);
  const task: TaskDispatch = {
    runId: run.id,
    idempotencyKey: run.idempotencyKey,
    policyGates,
    agent: {
      name: agent.name,
      type: agent.type,
      description: agent.description,
      skills: agent.skills,
    },
    workspace: acquired.workspace,
    outputLocale: project?.outputLocale === 'zh' ? 'zh' : 'en',
    goal: {
      title: item.title,
      description: item.description ?? '',
      acceptanceCriteria: item.acceptanceCriteria.map((c) => ({ id: c.id, text: c.text })),
      constraints: item.constraints.map((c) => ({
        type: c.type,
        value: c.value,
        description: c.description,
      })),
    },
    context,
    permissions: permissionSnapshot,
    limits: {
      maxTokens: agent.tokenLimitPerRun,
      maxCostUsd: usdCeilingForTokens(agent.model, agent.tokenLimitPerRun),
      maxDurationSeconds: agent.timeoutSeconds,
    },
    model: agent.model,
    callback: { eventsUrl: `/api/v1/agent-callback/runs/${run.id}/events`, token: run.id },
  };

  const ack = await adapter.dispatch(task);
  if (!ack.accepted) {
    await db
      .update(agentRuns)
      .set({ errorClass: 'runtime_error', errorMessage: ack.rejectReason ?? '运行时拒绝任务' })
      .where(eq(agentRuns.id, run.id));
    await ingestRunEvent(
      db,
      {
        runId: run.id,
        event: {
          runId: run.id,
          seq: 0,
          ts: new Date().toISOString(),
          type: 'run_ended',
          outcome: 'failed',
          summary: ack.rejectReason ?? '运行时拒绝任务',
          selfReport: '运行时拒绝接收批准后的派发，任务未开始。',
        },
        correlationId: input.correlationId,
      },
      deps,
    );
    return { ok: false, code: 'AGENT_UNAVAILABLE', detail: ack };
  }

  await db
    .update(agentRuns)
    .set({ status: 'running', startedAt: new Date(), lastHeartbeatAt: new Date() })
    .where(eq(agentRuns.id, run.id));
  await adapter.subscribe(run.id, async (event) => {
    await ingestRunEvent(db, { runId: run.id, event, correlationId: input.correlationId }, deps);
  });

  return { ok: true, runId: run.id, attempt: run.attempt, reused: true };
}

/** Builds the Agent's context. Content from external sources is marked trusted=false to guard against prompt injection. */
async function buildRunContext(
  db: Database,
  item: typeof workItems.$inferSelect,
  additional: DispatchInput['additionalContext'],
): Promise<TaskDispatch['context']> {
  const ctx: TaskDispatch['context'] = [];

  /**
   * Project engineering conventions — the third of the prompt's three layers /
   * 项目工程约定，prompt 三层里的第三层。
   *
   * ★ Carried in context rather than in the Agent's system prompt: coding
   *   standards are a **project** property and apply identically to every Agent
   *   in that project. Hanging them off the Agent means refilling them for each
   *   new Agent, and it also tempts users to write governance rules in there,
   *   which hollows out Policy.
   */
  const conventions = await db
    .select()
    .from(projectConventions)
    .where(
      and(
        eq(projectConventions.projectId, item.projectId),
        eq(projectConventions.enabled, true),
        // An empty appliesTo means it applies to every work item type
        or(
          sql`cardinality(${projectConventions.appliesTo}) = 0`,
          sql`${item.type} = ANY(${projectConventions.appliesTo})`,
        ),
      ),
    )
    .orderBy(asc(projectConventions.position), asc(projectConventions.createdAt));

  for (const c of conventions) {
    ctx.push({
      kind: 'knowledge',
      ref: c.id,
      title: `工程约定：${c.title}`,
      content: c.content,
      priority: c.priority === 'reference' ? 'reference' : 'must_read',
      trusted: true,
    });
  }

  if (item.requirementId) {
    const [req] = await db
      .select()
      .from(requirements)
      .where(eq(requirements.id, item.requirementId));
    if (req) {
      ctx.push({
        kind: 'requirement',
        ref: req.id,
        title: req.title ?? '需求说明',
        content: [req.businessContext, req.businessGoal].filter(Boolean).join('\n\n'),
        priority: 'must_read',
        trusted: true,
      });
      // The raw input may come from an external system, so treat it as untrusted
      ctx.push({
        kind: 'requirement',
        ref: `${req.id}:raw`,
        title: '原始需求描述',
        content: req.rawInput,
        priority: 'reference',
        trusted: req.inputMethod === 'manual' || req.inputMethod === 'conversation',
      });
    }
  }

  // The previous failed Run: carrying its failure reason forward is the whole point of "retry with more context"
  const failed = await db
    .select({
      id: agentRuns.id,
      errorClass: agentRuns.errorClass,
      errorMessage: agentRuns.errorMessage,
      selfReport: agentRuns.agentSelfReport,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.workItemId, item.id), inArray(agentRuns.status, ['failed', 'timeout'])));

  for (const run of failed) {
    ctx.push({
      kind: 'previous_run',
      ref: run.id,
      title: `上次失败（${run.errorClass}）`,
      content: [run.errorMessage, run.selfReport].filter(Boolean).join('\n'),
      priority: 'must_read',
      trusted: true,
    });
  }

  for (const extra of additional ?? []) {
    ctx.push({
      kind: 'knowledge',
      ref: randomUUID(),
      title: extra.title,
      content: extra.content,
      priority: 'must_read',
      trusted: true,
    });
  }

  return ctx;
}

export { artifacts, projects };
