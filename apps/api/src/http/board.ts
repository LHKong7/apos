import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  agentRuns,
  agents,
  artifacts,
  decisions,
  plans,
  projects,
  requirements,
  workItemDependencies,
  workItems,
  type Database,
} from '@apos/db';
import { formatRef } from '../modules/work-item/numbering';
import { notFound } from './errors';
import {
  HUMAN_GATE_PRIORITY,
  Stage,
  stageFor,
  type BlockedDetail,
  type HumanGate,
  type Stage as StageT,
  type WorkItemStatus,
} from '@apos/contracts';

/**
 * Board cards. The fields map to page doc 05 §5.3 — a card decides what to show from
 * its status, so everything any status could need is fetched here and the client
 * picks per status.
 * 看板卡片，字段对应页面文档 05 §5.3。
 */
/** One reference on the dependency chain — enough to draw "who blocks whom"; the rest is behind the card */
export interface DependencyRef {
  id: string;
  ref: string;
  title: string;
  status: string;
  /**
   * Dependency type (finish_to_start and friends). The reverse direction omits it, so
   * nobody misreads the relation as symmetric.
   * 反向那一栏不带类型，避免误读成对称关系。
   */
  type: string | null;
  met: boolean;
}

/** Statuses that count as "this dependency is met" — same rule as domain's isDependencyMet */
const MET_STATUSES = ['done', 'released', 'acceptance'];

export interface BoardCard {
  id: string;
  /**
   * Human-readable reference (`ORD-19`) / 人类可读编号。
   *
   * ★ The card has to carry it: pointing at a card in standup, mentioning a task in
   *   chat, citing one in a commit message — all of those use this, never the uuid.
   */
  ref: string;
  title: string;
  type: string;
  status: string;
  stage: StageT;
  priority: number;
  riskLevel: string;
  executor: { type: string; id: string; name: string } | null;
  owner: { id: string; name: string } | null;
  humanGate: HumanGate | null;
  humanGateRef: string | null;
  /** Minutes left on the decision; negative means it is already overdue */
  decisionDueInMinutes: number | null;
  blockedSince: string | null;
  blockedReason: string | null;
  /** Structured blocking detail. The UI reads this first; `blockedReason` is only the fallback sentence */
  blockedDetail: BlockedDetail | null;
  blockedMinutes: number | null;
  progress: { step: number; total: number | null; description: string | null } | null;
  tokens: number;
  estimatedTokens: number | null;
  runId: string | null;
  runStatus: string | null;
  consecutiveFailures: number;
  latestNote: string | null;
  artifactCount: number;
  unmetDependencies: number;
  /**
   * What blocks this card — completed ones included, because the UI has to draw the
   * whole chain, not only the unfinished tail of it.
   */
  blockedBy: DependencyRef[];
  /** What this card blocks. "Which one first?" is a question only this column answers */
  blocking: DependencyRef[];
  updatedAt: string;
}

/**
 * The "plan awaiting approval" card — the one in the Planning column of the mockup in
 * page doc 05 §5.2 / 「计划待批准」卡片。
 *
 * ★★ Why this is its own type instead of a flavor of BoardCard:
 *
 *   A plan is not a work item. It has no state machine, no executor, no dependencies,
 *   and cannot be dragged. Forcing it into BoardCard means half the fields are null,
 *   and every downstream `card.status === 'executing'` branch starts handling a shape
 *   that can never occur. Worse, `columns[].items` is shared by **four views** —
 *   Kanban, List, Agent, Decision — all of which treat its contents as work items:
 *   opening one would look up a work item that does not exist, and a bulk retry would
 *   dispatch the plan along with everything else.
 *
 *   So it hangs off {@link BoardColumn.plans} on its own: views that want to render it
 *   read it, and views that do not know about it need no change and cause no damage.
 *
 *   计划不是工作项，硬塞进 BoardCard 会让四个共用 `columns[].items` 的视图去处理一个
 *   永远不成立的形态。单独挂一栏，不认识它的视图什么都不用改。
 */
export interface PlanCard {
  id: string;
  requirementId: string | null;
  /** Requirement title; falls back to a truncated raw input before the requirement is structured */
  title: string;
  version: number;
  /** How many tasks approval brings along — the "+6 tasks" on the card */
  taskCount: number;
  /**
   * Who should approve. ★ `plan.approve` is a tech_lead permission (rbac/catalog.ts),
   * so this is the project's tech lead, not whoever raised the requirement.
   */
  approver: { id: string; name: string } | null;
  estimatedHours: string | null;
  estimatedTokens: number | null;
  /**
   * How long it has been waiting, in minutes / 已经等了多久（分钟）。
   *
   * ★ This is elapsed waiting time, not the "⏳ within 4h" countdown from the mockup.
   *   A plan has no deadline field, and inventing one means the UI is lying. Waiting
   *   time is real data and carries the same message — "this has been sitting here
   *   with nobody on it" — which is exactly what this spot is for.
   */
  waitingMinutes: number;
  createdAt: string;
}

export interface BoardColumn {
  key: StageT;
  name: string;
  wipLimit: number | null;
  count: number;
  items: BoardCard[];
  hasMore: boolean;
  /**
   * Plans awaiting approval. Only the planning column is ever non-empty today; the
   * rest are a fixed `[]` rather than omitted, so no consumer has to test for
   * undefined.
   */
  plans: PlanCard[];
}

const STAGE_NAMES: Record<StageT, string> = {
  intake: 'Intake',
  planning: 'Planning',
  execution: 'Execution',
  review: 'Review',
  release: 'Release',
  done: 'Done',
};

/** Done is collapsed by default, so a long-running project's Done column cannot grow without bound */
const DONE_LIMIT = 5;
const COLUMN_LIMIT = 20;

export interface BoardFilters {
  onlyMine?: string;
  riskLevel?: string[];
  executorType?: string;
  humanGateOnly?: boolean;
  blockedOnly?: boolean;
  /**
   * Unclaimed: tasks marked for human execution that have no executor.
   *
   * ★★ This filter has to exist, or "confirm at approval time that these go out
   *   unassigned" is an empty promise. Those tasks reach ready and then stop there:
   *   the scheduler does not touch human tasks, and nobody was ever told one is
   *   theirs. Without this entry point they look exactly like every other card on
   *   the board.
   *
   *   待认领 = 标为人工执行但没有执行者的任务，没有这个入口它们会静静停在 ready。
   */
  unclaimedOnly?: boolean;
}

export async function getBoard(
  db: Database,
  projectId: string,
  filters: BoardFilters = {},
): Promise<{ columns: BoardColumn[]; summary: BoardSummary }> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  // A plain Error would be classified as a 500 by the error handler, telling the
  // caller the server broke when in fact the project simply does not exist
  if (!project) throw notFound('project');

  const conditions = [eq(workItems.projectId, projectId), isNull(workItems.deletedAt)];
  if (filters.riskLevel?.length) {
    conditions.push(inArray(workItems.riskLevel, filters.riskLevel as never[]));
  }
  if (filters.executorType) {
    conditions.push(eq(workItems.executorType, filters.executorType as never));
  }
  if (filters.blockedOnly) conditions.push(sql`${workItems.blockedSince} IS NOT NULL`);
  if (filters.unclaimedOnly) {
    /**
     * ★ Backward compatibility: executionMode was split out of requiresHuman, and
     *   older work items only carry the latter in their typeData. Accept both, using
     *   exactly the rule executionModeOf uses.
     */
    conditions.push(
      sql`${workItems.executorId} IS NULL
          AND (${workItems.typeData}->>'executionMode' = 'human'
               OR (${workItems.typeData}->>'executionMode' IS NULL
                   AND ${workItems.typeData}->>'requiresHuman' = 'true'))`,
    );
  }
  if (filters.humanGateOnly) conditions.push(sql`${workItems.humanGate} IS NOT NULL`);
  if (filters.onlyMine) {
    conditions.push(
      sql`(${workItems.ownerId} = ${filters.onlyMine} OR ${workItems.executorId} = ${filters.onlyMine})`,
    );
  }

  const rows = await db
    .select()
    .from(workItems)
    .where(and(...conditions))
    .orderBy(workItems.priority, desc(workItems.updatedAt));

  const enriched = await enrich(db, rows, project.identifier);
  const pendingPlans = await loadPendingPlans(db, projectId, project.techLeadId, filters);

  const columns: BoardColumn[] = Stage.options.map((stage) => {
    const all = enriched.filter((c) => c.stage === stage);
    const limit = stage === 'done' ? DONE_LIMIT : COLUMN_LIMIT;
    /**
     * ★ Plan cards land in the planning column only.
     *
     *   That placement is decided server-side rather than leaving the client to work
     *   out "which column do plans belong in" — the composition of the columns is
     *   defined right here anyway (STAGE_NAMES, WIP limits, the collapse cap), and
     *   splitting the decision across two places eventually drifts into "the backend
     *   sent them and the frontend never drew them".
     */
    const plans = stage === 'planning' ? pendingPlans : [];
    return {
      key: stage,
      name: STAGE_NAMES[stage],
      wipLimit: project.wipLimits?.[stage] ?? null,
      // The column count must include plans, or Planning shows 0 while a card hangs under it
      count: all.length + plans.length,
      items: all.slice(0, limit),
      hasMore: all.length > limit,
      plans,
    };
  });

  return { columns, summary: summarize(enriched) };
}

/**
 * Plans awaiting approval / 待批准的计划。
 *
 * ★ Same criterion overview.ts uses (`status = 'awaiting_approval'`). An overview
 *   banner announcing "a plan is waiting for approval" while the board shows no such
 *   card is about the hardest inconsistency there is to explain to a user.
 */
async function loadPendingPlans(
  db: Database,
  projectId: string,
  techLeadId: string | null,
  filters: BoardFilters,
): Promise<PlanCard[]> {
  /**
   * ★★ The filters were designed for work items and mostly mean nothing for a plan.
   *   The default cannot be "keep it when it does not match" — that leaves the plan
   *   card sitting unmoved in the Planning column after a user ticks "blocked only",
   *   which reads as a broken filter.
   *
   *   So each filter is judged on whether it even applies to a plan:
   *   - blocked / executor / risk: a plan has none of these properties → hide plans
   *     whenever that filter is on
   *   - Human Gate: a plan awaiting approval **is** waiting on a human → keep it
   *   - only mine: am I the approver → decided separately just below
   */
  if (filters.blockedOnly || filters.executorType || filters.riskLevel?.length) return [];
  if (filters.onlyMine && filters.onlyMine !== techLeadId) return [];

  const rows = await db
    .select({
      id: plans.id,
      requirementId: plans.requirementId,
      version: plans.version,
      estimatedHours: plans.estimatedHours,
      estimatedTokens: plans.estimatedTokens,
      createdAt: plans.createdAt,
      requirementTitle: requirements.title,
      requirementRaw: requirements.rawInput,
    })
    .from(plans)
    .leftJoin(requirements, eq(requirements.id, plans.requirementId))
    .where(and(eq(plans.projectId, projectId), eq(plans.status, 'awaiting_approval')))
    .orderBy(desc(plans.createdAt));

  if (rows.length === 0) return [];

  /**
   * Task count. ★ Tasks are already created as drafts when the plan is generated
   * (planning/service.ts), so this counts rows that actually exist rather than the
   * length of the list inside the plan. The two diverge as soon as someone deletes one
   * by hand, and what the card should report is how many there are now.
   */
  const counts = await db
    .select({ planId: workItems.planId, n: sql<number>`count(*)::int` })
    .from(workItems)
    .where(
      and(
        inArray(workItems.planId, rows.map((r) => r.id)),
        isNull(workItems.deletedAt),
      ),
    )
    .groupBy(workItems.planId);
  const taskCount = new Map(counts.map((c) => [c.planId, c.n]));

  const approver = techLeadId ? await lookupUser(db, techLeadId) : null;
  const now = Date.now();

  return rows.map((r) => ({
    id: r.id,
    requirementId: r.requirementId,
    title: planTitle(r.requirementTitle, r.requirementRaw),
    version: r.version,
    taskCount: taskCount.get(r.id) ?? 0,
    approver,
    estimatedHours: r.estimatedHours,
    estimatedTokens: r.estimatedTokens,
    waitingMinutes: Math.round((now - r.createdAt.getTime()) / 60_000),
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * ★ Before it is structured, a requirement has no title — only the raw text the user
 *   pasted in. A card with an empty title at that point says "there is something for
 *   you to approve, but not what it is". Falling back to the first line of the raw
 *   input at least lets them recognize which one this is.
 */
function planTitle(title: string | null, rawInput: string | null): string {
  if (title?.trim()) return title;
  const raw = rawInput?.trim().split('\n')[0] ?? '';
  if (!raw) return '未命名需求';
  return raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
}

async function lookupUser(db: Database, id: string): Promise<{ id: string; name: string } | null> {
  const { users } = await import('@apos/db');
  const [row] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, id));
  return row ?? null;
}

export interface BoardSummary {
  pendingDecisions: number;
  overdueDecisions: number;
  blocked: number;
  executing: number;
  failed: number;
}

function summarize(cards: BoardCard[]): BoardSummary {
  return {
    pendingDecisions: cards.filter((c) => c.humanGateRef).length,
    overdueDecisions: cards.filter(
      (c) => c.decisionDueInMinutes !== null && c.decisionDueInMinutes < 0,
    ).length,
    blocked: cards.filter((c) => c.blockedSince).length,
    executing: cards.filter((c) => c.status === 'executing').length,
    failed: cards.filter((c) => c.status === 'failed').length,
  };
}

type WorkItemRow = typeof workItems.$inferSelect;

/**
 * Batch-load everything the cards need alongside the work items.
 *
 * Deliberately one set of bulk queries rather than a query per card: a board can hold
 * hundreds of cards, and an N+1 leaves no room at all inside the 1.5s first-paint
 * budget.
 */
async function enrich(
  db: Database,
  rows: WorkItemRow[],
  identifier: string,
): Promise<BoardCard[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);

  const runs = await db
    .select()
    .from(agentRuns)
    .where(inArray(agentRuns.workItemId, ids))
    .orderBy(desc(agentRuns.attempt));
  const latestRun = new Map<string, (typeof runs)[number]>();
  for (const r of runs) {
    // ★ Planning runs have no work item, so they do not belong in this by-work-item map
    if (!r.workItemId) continue;
    if (!latestRun.has(r.workItemId)) latestRun.set(r.workItemId, r);
  }

  const agentRows = await db.select().from(agents);
  const agentName = new Map(agentRows.map((a) => [a.id, a.name]));

  const { users } = await import('@apos/db');
  const userRows = await db.select().from(users);
  const userName = new Map(userRows.map((u) => [u.id, u.name]));

  const decisionRows = await db
    .select()
    .from(decisions)
    .where(and(inArray(decisions.workItemId, ids), eq(decisions.status, 'pending')));
  const decisionByItem = new Map(decisionRows.map((d) => [d.workItemId!, d]));

  const artifactRows = await db
    .select({ workItemId: artifacts.workItemId })
    .from(artifacts)
    .where(inArray(artifacts.workItemId, ids));
  const artifactCount = new Map<string, number>();
  for (const a of artifactRows) {
    if (!a.workItemId) continue;
    artifactCount.set(a.workItemId, (artifactCount.get(a.workItemId) ?? 0) + 1);
  }

  /**
   * Dependencies / 依赖。
   *
   * ★★ Beyond "how many are unfinished", say **which ones**.
   *
   *   The card used to show a bare "🔗 1": the user knew they were blocked but not by
   *   what — working out that TEST-11 is holding up TEST-12 meant opening five cards
   *   and reassembling the topology by hand (issue log #21). A number answers none of
   *   the follow-up questions.
   *
   * ★ Both directions travel: upstream (what blocks me) and downstream (what I block).
   *   Upstream alone still cannot answer "which one first" — the item blocking five
   *   others is the one that should be done first.
   */
  const depRows = await db
    .select({
      toId: workItemDependencies.toId,
      fromId: workItemDependencies.fromId,
      type: workItemDependencies.type,
      fromStatus: workItems.status,
      fromTitle: workItems.title,
      fromNumber: workItems.number,
    })
    .from(workItemDependencies)
    .innerJoin(workItems, eq(workItems.id, workItemDependencies.fromId))
    .where(inArray(workItemDependencies.toId, ids));

  /** What I block — the reverse query, the rows whose `from` is in ids */
  const blockingRows = await db
    .select({
      fromId: workItemDependencies.fromId,
      toId: workItemDependencies.toId,
      toStatus: workItems.status,
      toTitle: workItems.title,
      toNumber: workItems.number,
    })
    .from(workItemDependencies)
    .innerJoin(workItems, eq(workItems.id, workItemDependencies.toId))
    .where(inArray(workItemDependencies.fromId, ids));

  const unmetDeps = new Map<string, number>();
  const blockedBy = new Map<string, DependencyRef[]>();
  for (const d of depRows) {
    const met = MET_STATUSES.includes(d.fromStatus);
    if (!met) unmetDeps.set(d.toId, (unmetDeps.get(d.toId) ?? 0) + 1);
    blockedBy.set(d.toId, [
      ...(blockedBy.get(d.toId) ?? []),
      {
        id: d.fromId,
        ref: formatRef(identifier, d.fromNumber),
        title: d.fromTitle,
        status: d.fromStatus,
        type: d.type,
        met,
      },
    ]);
  }

  const blocking = new Map<string, DependencyRef[]>();
  for (const d of blockingRows) {
    blocking.set(d.fromId, [
      ...(blocking.get(d.fromId) ?? []),
      {
        id: d.toId,
        ref: formatRef(identifier, d.toNumber),
        title: d.toTitle,
        status: d.toStatus,
        type: null,
        met: MET_STATUSES.includes(d.toStatus),
      },
    ]);
  }

  const now = Date.now();

  return rows.map((r) => {
    const run = latestRun.get(r.id);
    const decision = decisionByItem.get(r.id);

    return {
      id: r.id,
      ref: formatRef(identifier, r.number),
      title: r.title,
      type: r.type,
      status: r.status,
      stage: stageFor(r.status as WorkItemStatus, r.previousStatus),
      priority: r.priority,
      riskLevel: r.riskLevel,
      executor:
        r.executorType && r.executorId
          ? {
              type: r.executorType,
              id: r.executorId,
              name:
                (r.executorType === 'agent'
                  ? agentName.get(r.executorId)
                  : userName.get(r.executorId)) ?? '未知',
            }
          : null,
      owner: r.ownerId ? { id: r.ownerId, name: userName.get(r.ownerId) ?? '未知' } : null,
      /**
       * ★ Whenever a pending decision exists, the gate must read "waiting on a human".
       *
       * `work_items.human_gate` is whatever the last transition left behind, and it
       * lags: a task can carry two decisions at once, and approving one of them writes
       * the field to `approved` while the other is still waiting — so the card claims
       * "approved" and still shows a "Handle →" button. The pending decision is the
       * present fact; the stored field is only history.
       */
      humanGate: decision ? 'waiting_for_decision' : r.humanGate,
      humanGateRef: decision?.id ?? null,
      decisionDueInMinutes: decision?.dueAt
        ? Math.round((decision.dueAt.getTime() - now) / 60_000)
        : null,
      blockedSince: r.blockedSince?.toISOString() ?? null,
      blockedReason: r.blockedReason,
      blockedDetail: r.blockedDetail ?? null,
      blockedMinutes: r.blockedSince
        ? Math.round((now - r.blockedSince.getTime()) / 60_000)
        : null,
      progress:
        run && run.stepCurrent !== null
          ? { step: run.stepCurrent, total: run.stepTotal, description: run.stepDescription }
          : null,
      tokens: r.actualTokens,
      estimatedTokens: r.estimatedTokens,
      runId: run?.id ?? null,
      runStatus: run?.status ?? null,
      consecutiveFailures: r.consecutiveFailures,
      latestNote: run?.progressNote ?? null,
      artifactCount: artifactCount.get(r.id) ?? 0,
      unmetDependencies: unmetDeps.get(r.id) ?? 0,
      blockedBy: blockedBy.get(r.id) ?? [],
      blocking: blocking.get(r.id) ?? [],
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}


/** Human Gate display priority: decision_overdue outranks every other state */
export function effectiveHumanGate(gates: HumanGate[]): HumanGate | null {
  if (gates.length === 0) return null;
  return gates.reduce((a, b) => (HUMAN_GATE_PRIORITY[a] >= HUMAN_GATE_PRIORITY[b] ? a : b));
}
