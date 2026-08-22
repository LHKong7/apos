import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { agentRuns, agents, projectMembers, users, workItems, type Database } from '@apos/db';
import { ACTIVE_RUN_STATUSES, ExecutionMode } from '@apos/contracts';
import type { RuntimeRegistry } from '@apos/agent-runtimes';
import { executionModeOf, resolveExecutor } from '../modules/agent/matching';
import { mergeTypeData } from '../modules/work-item/json-merge';
import { fail, notFound } from './errors';

/**
 * Executor assignment — "who does it" and "when it starts" are two separate things.
 *
 * ★★ Why they had to be split.
 *
 *   There used to be only `POST /work-items/:id/assign`, and it dispatched the Run in
 *   the same call that saved the executor. That made the entirely ordinary act of
 *   "park this card on an Agent now, run it later" impossible: the user believed they
 *   had picked a name from a dropdown, while the Agent immediately started editing
 *   files and burning budget. A *selection* should not have side effects, least of
 *   all irreversible ones.
 *
 *   After the split:
 *     PATCH /work-items/:id/assignee   writes the executor only; no status, no dispatch
 *     POST  /work-items/:id/start      actually begins execution (a person, or the scheduler)
 *
 *   The old /assign stays as the combined "set the executor and start right now"
 *   (see routes.ts) so existing callers do not break, but new UI always uses the two
 *   separate endpoints.
 */

/**
 * What to do with a running execution when the work item is reassigned.
 *
 * ★★ Without this choice, a reassignment is **silent**: the Run keeps going while the
 *   card already names somebody else. That execution goes on editing files and
 *   spending money, its output ends up attached to a card that is no longer its own,
 *   and the new executor knows nothing about any of it. All three dispositions are
 *   reasonable, but a person has to pick one — every possible default is wrong in some
 *   real scenario, so there is no default.
 */
export const TakeoverMode = z.enum([
  /** Terminate the current Run and hand over to the new executor immediately */
  'terminate',
  /** Let it finish; the reassignment applies to the **next** execution only */
  'wait',
  /** Hand over to a human: terminate the Run and give the card to a person */
  'handover',
]);
export type TakeoverMode = z.infer<typeof TakeoverMode>;

export const AssigneeInput = z
  .object({
    /** One or the other; passing neither clears the executor back to "unassigned" */
    agentId: z.string().uuid().nullable().optional(),
    userId: z.string().uuid().nullable().optional(),
    /**
     * Optionally change the execution mode too. Omitted, it is inferred from the
     * executor: an Agent means agent, a person means human, clearing both means auto.
     */
    executionMode: ExecutionMode.optional(),
    /**
     * Required while a Run is active. Omitting it is refused — see TakeoverMode for why.
     */
    takeover: TakeoverMode.optional(),
  })
  .refine((v) => !(v.agentId && v.userId), {
    message: '不能同时指定 agentId 与 userId',
  });

export type AssigneeInputType = z.infer<typeof AssigneeInput>;

/**
 * Save the executor only; do not start executing.
 *
 * ★ This does not go through transition(), because no status transition happens here —
 *   a ready card is still ready after its executor changes. Forcing a transition would
 *   manufacture an "entered ready" in the event stream that never actually occurred,
 *   and the event stream is the only data source audit and Analytics have. The
 *   executor change itself is emitted as its own domain event by the caller (see
 *   routes.ts).
 */
export async function setAssignee(
  db: Database,
  workItemId: string,
  input: AssigneeInputType,
  deps: { registry?: RuntimeRegistry } = {},
) {
  const [item] = await db.select().from(workItems).where(eq(workItems.id, workItemId));
  if (!item) throw notFound('work_item');

  /**
   * ★★ No silent reassignment while a Run is active.
   *
   *   The Run is still executing while the card already names somebody else: it keeps
   *   editing files, keeps spending money, and its output lands on a card that is no
   *   longer its own — with the new executor unaware of any of it. Stop here and make
   *   the caller choose a disposition explicitly. All three are reasonable; none of
   *   them can be the default.
   */
  const active = await db
    .select({ id: agentRuns.id, agentId: agentRuns.agentId })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.workItemId, workItemId),
        inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
      ),
    );

  const changingExecutor =
    (input.agentId ?? input.userId ?? null) !== item.executorId;

  if (active.length > 0 && changingExecutor && !input.takeover) {
    throw fail(
      'VALIDATION_FAILED',
      'work_item.reassign_needs_run_disposition',
      '这张卡还有执行中的 Run。改派前要说明怎么处置它：terminate（终止后立刻交接）、' + 'wait（让它跑完，改派对下一次生效）、handover（终止并转人工接管）。',
      { details: { runIds: active.map((r) => r.id), currentExecutorId: item.executorId } },
    );
  }

  if (input.agentId) await assertAgentAssignable(db, item.projectId, input.agentId);
  if (input.userId) await assertUserAssignable(db, item.projectId, input.userId);

  /**
   * ★ handover requires a person to hand over to. Handing to another Agent while
   *   calling it "human takeover" leaves the two disagreeing in the event stream — and
   *   the event stream is the sole basis for audit.
   */
  if (input.takeover === 'handover' && !input.userId) {
    throw fail('VALIDATION_FAILED', 'work_item.takeover_needs_user', '转人工接管必须指定接手的人（userId）');
  }

  /**
   * ★★ Under `wait` the running Run is **left alone**: the reassignment applies to the
   *   next execution. The other two must stop the Run first, or it keeps editing files
   *   and spending money on a card that is no longer its own.
   */
  const terminated: string[] = [];
  if (active.length > 0 && (input.takeover === 'terminate' || input.takeover === 'handover')) {
    for (const run of active) {
      await terminateRun(db, deps.registry, run, input.takeover);
      terminated.push(run.id);
    }
  }

  const executorType = input.agentId ? 'agent' : input.userId ? 'human' : null;
  const executorId = input.agentId ?? input.userId ?? null;
  const mode =
    input.executionMode ??
    (executorType === 'agent' ? 'agent' : executorType === 'human' ? 'human' : 'auto');

  await db
    .update(workItems)
    .set({
      executorType,
      executorId,
      /**
       * ★ executionMode lives inside typeData, next to requiredSkills / requiredTools.
       *   Merge that one key rather than writing the whole typeData we read back:
       *   between the SELECT above and this point, qualityGate may have been updated by
       *   CI or by an Agent finishing up, and a whole-column overwrite erases it. See
       *   work-item/json-merge.ts.
       */
      typeData: mergeTypeData({ executionMode: mode }),
      updatedAt: new Date(),
    })
    .where(eq(workItems.id, workItemId));

  return {
    ok: true as const,
    workItemId,
    executorType,
    executorId,
    executionMode: mode,
    /** ★ Report exactly which Runs were terminated — the caller has to be able to show this */
    terminatedRuns: terminated,
  };
}

/**
 * Terminate one execution as part of a reassignment.
 *
 * ★ Send the control command before writing the database. Write first and let the
 *   command fail, and the Run is terminated in the database while still running in the
 *   runtime — an inconsistency nothing anywhere would ever detect.
 *
 * ★ The runtime not recognizing the Run (the process restarted, the adapter is not
 *   registered) is not a failure: once it is marked terminated in the database, the
 *   supervisor's heartbeat-timeout path already covers the rest.
 */
async function terminateRun(
  db: Database,
  registry: RuntimeRegistry | undefined,
  run: { id: string; agentId: string },
  mode: TakeoverMode,
): Promise<void> {
  if (registry?.has(run.agentId)) {
    await registry
      .get(run.agentId)
      .control(run.id, {
        action: 'terminate',
        reason: mode === 'handover' ? '改派：转人工接管' : '改派：更换执行者',
      })
      .catch(() => undefined);
  }

  await db
    .update(agentRuns)
    .set({
      status: 'terminated',
      endedAt: new Date(),
      errorClass: 'runtime_error',
      errorMessage: mode === 'handover' ? '改派：转人工接管' : '改派：更换执行者',
    })
    .where(eq(agentRuns.id, run.id));
}

/**
 * An Agent must be a **member of this project** to be assignable.
 *
 * ★★ Same criterion the scheduler uses (modules/agent/matching.ts). Two independent
 *   implementations produce the self-contradictory state where manual assignment
 *   succeeds while the scheduler insists the Agent is not even a candidate.
 */
async function assertAgentAssignable(db: Database, projectId: string, agentId: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) throw notFound('agent');

  const [member] = await db
    .select({ actorId: projectMembers.actorId })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.actorType, 'agent'),
        eq(projectMembers.actorId, agentId),
      ),
    );
  if (!member) {
    throw fail(
      'VALIDATION_FAILED',
      'agent.not_project_member',
      `${agent.name} 不是这个项目的成员 —— 先在「成员与角色」里把它加进来`,
      { params: { name: agent.name }, details: { agentId } },
    );
  }
  if (agent.status !== 'active') {
    throw fail(
      'VALIDATION_FAILED',
      'agent.not_available',
      `${agent.name} 当前状态是 ${agent.status}`,
      { params: { name: agent.name, status: agent.status }, details: { agentId } },
    );
  }
}

async function assertUserAssignable(db: Database, projectId: string, userId: string) {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  if (!user) throw notFound('user');

  const [member] = await db
    .select({ actorId: projectMembers.actorId })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.actorType, 'human'),
        eq(projectMembers.actorId, userId),
      ),
    );
  if (!member) {
    throw fail(
      'VALIDATION_FAILED',
      'user.not_project_member',
      '这个人不是项目成员，不能被指派',
      { details: { userId } },
    );
  }
}

/**
 * Candidate executors — who can be picked, and why the others cannot.
 *
 * ★★ The ineligible ones are returned too, each with its reason.
 *
 *   Return only the eligible ones and the user faces an empty dropdown with no way
 *   forward: is no Agent configured? not added to the project? at capacity? Those
 *   causes call for completely different next steps. Page doc 04 §5.4 requires the
 *   reassignment dropdown to show the matching rationale; this returns the
 *   *non*-matching rationale alongside it.
 */
export async function listCandidates(
  db: Database,
  registry: RuntimeRegistry,
  workItemId: string,
) {
  const [item] = await db.select().from(workItems).where(eq(workItems.id, workItemId));
  if (!item) throw notFound('work_item');

  const match = await resolveExecutor(db, item, { registry });

  const agentRows = await db.select().from(agents).where(eq(agents.orgId, item.orgId));
  const byId = new Map(agentRows.map((a) => [a.id, a]));

  const humanRows = await db
    .select({ id: users.id, name: users.name, email: users.email, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.actorId))
    .where(
      and(eq(projectMembers.projectId, item.projectId), eq(projectMembers.actorType, 'human')),
    );

  const decorate = (agentId: string) => {
    const a = byId.get(agentId);
    return {
      runtimeKind: a?.runtimeKind ?? null,
      status: a?.status ?? null,
      registered: registry.has(agentId),
      maxConcurrency: a?.maxConcurrency ?? null,
    };
  };

  return {
    executionMode: executionModeOf(item.typeData),
    current: { executorType: item.executorType, executorId: item.executorId },
    agents: {
      eligible: match.candidates.map((c) => ({
        agentId: c.agentId,
        name: c.agentName,
        score: c.score,
        reasons: c.reasons,
        ...decorate(c.agentId),
      })),
      /**
       * ★★ The code, scope, and params all travel — not just the Chinese `reason`
       *   sentence.
       *
       *   The matcher already computes `code` / `scope` / `params` (the board's "why is
       *   this blocked" renders from exactly those), but this endpoint used to pick up
       *   only the Chinese string. The result: one and the same reason renders in the
       *   viewer's language on the board and is permanently Chinese in the executor
       *   dropdown. `reason` stays as the fallback, so an unrecognized new code still
       *   has a readable sentence behind it.
       */
      ineligible: match.rejected.map((r) => ({
        agentId: r.agentId,
        name: r.agentName,
        code: r.code,
        scope: r.scope,
        params: r.params,
        reason: r.reason,
        ...decorate(r.agentId),
      })),
    },
    humans: humanRows.map((h) => ({
      userId: h.id,
      name: h.name,
      email: h.email,
      role: h.role,
    })),
  };
}
