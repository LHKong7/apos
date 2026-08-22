import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  agentRuns,
  decisionOptions,
  decisions,
  projects,
  users,
  workItems,
  type Database,
} from '@apos/db';
import { decisionLabel } from '@apos/domain';
import { notFound } from './errors';

/**
 * Decision Center (page doc 10) / 决策中心。
 *
 * ★ This is where the product's core promise is kept: *you do not have to
 *   watch the agents; I will come find you when you are needed.* If users
 *   still feel "I don't know when I'm supposed to step in", this page failed.
 *
 * ★ The design target is "clear the day's queue in five minutes", and that
 *   target dictates the shape of the endpoint: one response carries everything
 *   a decision card needs (options, impact, related task, the agent's
 *   recommendation) so the user can decide straight from the list instead of
 *   opening each one — every extra navigation adds a minute to clearing the
 *   queue.
 */

export type DecisionScope = 'mine' | 'all' | 'watching';

export async function getDecisionInbox(
  db: Database,
  userId: string | null,
  scope: DecisionScope,
  projectId: string | null,
  /**
   * ★ The projects the caller is a member of; the inbox is narrowed by them.
   *   Without this the inbox serves up pending decisions from every project,
   *   other organizations included. An empty array means "they can see no
   *   project at all" and the result must be empty — it must never degrade
   *   into "no filtering".
   */
  visibleProjectIds: string[],
) {
  const now = Date.now();

  if (visibleProjectIds.length === 0) {
    return emptyInbox();
  }

  const conditions = [
    eq(decisions.status, 'pending'),
    inArray(decisions.projectId, visibleProjectIds),
  ];
  if (projectId) conditions.push(eq(decisions.projectId, projectId));

  const rows = await db
    .select()
    .from(decisions)
    .where(and(...conditions))
    .orderBy(decisions.dueAt);

  /**
   * ★ "Mine" = assigned to me + assigned to nobody. Hide the unassigned ones
   *   and nobody ever picks them up — and "nobody picks it up" is precisely
   *   what this page exists to eliminate.
   */
  const mine = userId
    ? rows.filter((d) => d.assigneeId === userId || d.assigneeId === null)
    : [];
  const visible = scope === 'mine' ? mine : rows;

  const ids = visible.map((d) => d.id);
  const options =
    ids.length > 0
      ? await db.select().from(decisionOptions).where(inArray(decisionOptions.decisionId, ids))
      : [];

  const itemIds = visible.map((d) => d.workItemId).filter((x): x is string => x !== null);
  const items =
    itemIds.length > 0
      ? await db.select().from(workItems).where(inArray(workItems.id, itemIds))
      : [];
  const itemById = new Map(items.map((i) => [i.id, i]));

  const runIds = visible.map((d) => d.runId).filter((x): x is string => x !== null);
  const runs =
    runIds.length > 0
      ? await db.select().from(agentRuns).where(inArray(agentRuns.id, runIds))
      : [];
  const runById = new Map(runs.map((r) => [r.id, r]));

  const projectRows = await db.select({ id: projects.id, name: projects.name }).from(projects);
  const projectName = new Map(projectRows.map((p) => [p.id, p.name]));

  const userRows = await db.select({ id: users.id, name: users.name }).from(users);
  const userName = new Map(userRows.map((u) => [u.id, u.name]));

  const cards = visible.map((d) => {
    const opts = options
      .filter((o) => o.decisionId === d.id)
      .sort((a, b) => a.position - b.position);
    const item = d.workItemId ? itemById.get(d.workItemId) : undefined;
    const run = d.runId ? runById.get(d.runId) : undefined;

    return {
      id: d.id,
      projectId: d.projectId,
      projectName: projectName.get(d.projectId) ?? '未知项目',
      type: d.type,
      typeLabel: decisionLabel(d.type),
      title: d.title,
      /** ★ What happens if it is ignored — urgency as a concrete consequence, not "high priority" */
      consequence: d.consequence,
      whyHuman: d.whyHuman,
      /** ★ The UI reads this structured form first, falling back to the Chinese sentence above */
      reasonDetail: d.reasonDetail ?? null,
      riskLevel: d.riskLevel,
      reversible: d.reversible,
      assigneeId: d.assigneeId,
      assigneeName: d.assigneeId ? (userName.get(d.assigneeId) ?? '未知') : null,
      /** ★ Decisions cannot be made on someone's behalf: not the assignee means view-only */
      canAct: userId !== null && (d.assigneeId === null || d.assigneeId === userId),
      createdAt: d.createdAt.toISOString(),
      dueAt: d.dueAt?.toISOString() ?? null,
      overdueMinutes:
        d.dueAt && d.dueAt.getTime() < now ? Math.round((now - d.dueAt.getTime()) / 60_000) : null,
      dueInMinutes:
        d.dueAt && d.dueAt.getTime() >= now
          ? Math.round((d.dueAt.getTime() - now) / 60_000)
          : null,
      waitingMinutes: Math.round((now - d.createdAt.getTime()) / 60_000),
      workItemId: d.workItemId,
      workItemTitle: item?.title ?? null,
      runId: d.runId,
      agentSelfReport: run?.agentSelfReport ?? null,
      options: opts.map((o) => ({
        id: o.id,
        name: o.name,
        description: o.description,
        isRecommended: o.isRecommended,
        rationale: o.rationale,
        uncertainties: o.uncertainties,
      })),
    };
  });

  /**
   * ★ The ordering is the priority judgment; the user should not have to scan
   *   the list and sort it themselves. Overdue first, then by time remaining,
   *   then by risk — get the order wrong in a queue of "waiting on my call"
   *   and the user has to read it end to end, and the five-minute target dies
   *   on the spot.
   */
  cards.sort((a, b) => {
    if ((b.overdueMinutes ?? -1) !== (a.overdueMinutes ?? -1)) {
      return (b.overdueMinutes ?? -1) - (a.overdueMinutes ?? -1);
    }
    if (a.dueInMinutes !== null && b.dueInMinutes !== null) return a.dueInMinutes - b.dueInMinutes;
    if (a.dueInMinutes !== null) return -1;
    if (b.dueInMinutes !== null) return 1;
    return (RISK_ORDER[b.riskLevel] ?? 0) - (RISK_ORDER[a.riskLevel] ?? 0);
  });

  /**
   * Repeated-decision hint (§2, question 3: "is there a recurring decision that
   * could become a rule?"). Surfaced in the queue itself, so the user does not
   * have to go over to Analytics to notice it.
   */
  const byType = new Map<string, number>();
  for (const c of cards) byType.set(c.type, (byType.get(c.type) ?? 0) + 1);
  const repeated = [...byType.entries()]
    .filter(([, n]) => n >= 3)
    .map(([type, count]) => ({ type, label: decisionLabel(type), count }))
    .sort((a, b) => b.count - a.count);

  /**
   * ★★ Break the count out per project.
   *
   *   The header badge "8 decisions waiting on you" counts **across projects**
   *   (the inbox is a cross-project inbox by design), while the board's
   *   "2 pending decisions" counts the current project only. Two numbers side
   *   by side on one screen with nothing naming their differing scopes — what
   *   the user sees is the system contradicting itself, and contradicting
   *   itself in the alarming direction (issue log #24).
   *
   *   Broken out, the header can say "8, 2 of them in this project".
   *
   *   两个数字并排出现在同一屏上，中间没有任何东西说明它们的范围不同。
   */
  const byProject: Record<string, { mine: number; overdue: number }> = {};
  for (const d of mine) {
    const bucket = (byProject[d.projectId] ??= { mine: 0, overdue: 0 });
    bucket.mine += 1;
    if (d.dueAt && d.dueAt.getTime() < now) bucket.overdue += 1;
  }

  return {
    stats: {
      total: rows.length,
      mine: mine.length,
      overdue: cards.filter((c) => c.overdueMinutes !== null).length,
      dueSoon: cards.filter((c) => c.dueInMinutes !== null && c.dueInMinutes <= 240).length,
      actionable: cards.filter((c) => c.canAct).length,
      byProject,
    },
    repeated,
    decisions: cards,
  };
}

/** The empty inbox when no project is visible. Same shape as a normal response, so the UI needs no special case */
function emptyInbox() {
  return {
    stats: { total: 0, mine: 0, overdue: 0, dueSoon: 0, actionable: 0, byProject: {} },
    repeated: [],
    decisions: [],
  };
}

const RISK_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * Batch approval (page doc 10 §2, "clear the day's queue in five minutes").
 *
 * ★ Only batch approval exists; there is no batch rejection. A rejection has
 *   to carry a reason, and every rejection's reason is different — batch
 *   rejection either forces a one-size-fits-all platitude or skips the reason
 *   altogether. Both break the floor rule that every override leaves behind a
 *   why.
 *
 * ★ Each item runs through **the very same function** a single approval uses;
 *   not one shortcut is left in. What batching saves is clicks, not rules:
 *   no-deciding-on-someone-else's-behalf, the state machine, and policy all
 *   still run. Writing a separate fast path for the batch case is the most
 *   common way this kind of feature causes an incident.
 */
export async function batchApprove(
  ids: string[],
  approveOne: (id: string) => Promise<unknown>,
) {
  const results: { id: string; ok: boolean; error?: string }[] = [];

  for (const id of ids) {
    try {
      await approveOne(id);
      results.push({ id, ok: true });
    } catch (e) {
      results.push({ id, ok: false, error: e instanceof Error ? e.message : '处理失败' });
    }
  }

  return {
    approved: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok),
    results,
  };
}

void desc;
void notFound;
