import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  plans,
  projects,
  requirementClarifications,
  requirements,
  users,
  workItems,
  type Database,
} from '@apos/db';
import type { AutonomyLevel, PlanFallback } from '@apos/contracts';
import { auditPolicies, diffPlans, type PlanSide } from '@apos/domain';
import { resolveExecutor } from '../modules/agent/matching';
import { notFound } from './errors';
import { loadProjectPolicies } from './policies';

/**
 * Read side of requirement intake and plan confirmation (page docs 03 / 04 §9) /
 * 需求录入与计划确认的读取端。
 *
 * Writes reuse the existing requirement / planning services — that is where the
 * real pipeline lives; this file only reshapes their output into what the pages
 * need / 这里只负责把它们的产物拼成页面要的形状。
 */

export async function listRequirements(db: Database, projectId: string) {
  const rows = await db
    .select()
    .from(requirements)
    .where(and(eq(requirements.projectId, projectId), isNull(requirements.deletedAt)))
    .orderBy(desc(requirements.createdAt));

  const planRows = await db.select().from(plans).where(eq(plans.projectId, projectId));
  const planByReq = new Map<string, (typeof planRows)[number]>();
  for (const p of planRows) {
    if (!p.requirementId) continue;
    const seen = planByReq.get(p.requirementId);
    if (!seen || p.version > seen.version) planByReq.set(p.requirementId, p);
  }

  return {
    requirements: rows.map((r) => ({
      id: r.id,
      title: r.title ?? firstLine(r.rawInput),
      status: r.status,
      priority: r.priority,
      createdAt: r.createdAt.toISOString(),
      approvedAt: r.approvedAt?.toISOString() ?? null,
      /** A requirement that already has a plan should link straight to the plan page */
      latestPlanId: planByReq.get(r.id)?.id ?? null,
      latestPlanStatus: planByReq.get(r.id)?.status ?? null,
    })),
  };
}

/**
 * Plan detail (page doc 04 §4 / §5.2 / §5.3) / 计划详情。
 *
 * ★ "What will happen automatically after approval" reads the **snapshot**
 *   taken when the plan was generated; it is not recomputed at render time.
 *   What the user approved was the list as it stood then — policies change
 *   afterward, and answering "what exactly did they approve?" has to read that
 *   snapshot, never a list computed just now. The result under the current
 *   rules is returned alongside it, and the page calls out any mismatch.
 */
export async function getPlanDetail(db: Database, planId: string) {
  const [plan] = await db.select().from(plans).where(eq(plans.id, planId));
  if (!plan) throw notFound('plan');

  const [project] = await db.select().from(projects).where(eq(projects.id, plan.projectId));
  if (!project) throw notFound('project');

  const tasks = await db
    .select()
    .from(workItems)
    .where(eq(workItems.planId, planId))
    .orderBy(workItems.position);

  const requirement = plan.requirementId
    ? (await db.select().from(requirements).where(eq(requirements.id, plan.requirementId)))[0]
    : undefined;

  const assumptions = requirement
    ? (
        await db
          .select()
          .from(requirementClarifications)
          .where(eq(requirementClarifications.requirementId, requirement.id))
      ).filter((c) => c.level === 'assumption_ok' || c.answer === null)
    : [];

  const userRows = await db.select({ id: users.id, name: users.name }).from(users);
  const userName = new Map(userRows.map((u) => [u.id, u.name]));

  /** ★ null = never estimated (not "estimated at 0"). The UI shows "not estimated", not a number */
  const estimatedTokens = plan.estimatedTokens;
  const budget = project.tokenBudget;
  const spent = project.tokensSpent;

  // The boundary under the current rules, to hold against the snapshot
  const policies = await loadProjectPolicies(db, project.orgId, plan.projectId);
  const current = auditPolicies(policies, project.autonomyLevel as AutonomyLevel);

  /**
   * ★ The human/agent split has to come from the "will happen automatically"
   *   snapshot, not from counting work_items.executorType.
   *
   *   Nothing is scheduled before a plan is approved, so executorType is null
   *   everywhere — counting it always yields "🤖 0　👤 0" while the snapshot
   *   right beside it says "4 tasks will be executed automatically by agents".
   *   That number appears in the approval dialog, the very moment the user
   *   hands over execution authority; a wrong automation ratio there is worse
   *   than none at all. 在那里给一个错的自动化比例，比不给还糟。
   */
  const gates = plan.humanGates as { taskTitle: string }[];
  const gatedTitles = new Set(gates.map((g) => g.taskTitle));
  const humanTasks = tasks.filter((t) => gatedTitles.has(t.title)).length;
  const agentTasks = tasks.length - humanTasks;

  /**
   * ★★ "This runs automatically" is a **checkable** promise, so check it
   *   before approval.
   *
   *   The page used to say "N tasks will be executed automatically by agents",
   *   where N was merely "tasks with no human gate" — it never once asked
   *   whether any agent in this project can take them. What that looked like in
   *   practice: 3 tasks in the plan marked automatic, while the project's only
   *   agent accepts requirement / research work only, so the feature and test
   *   tasks sit in `ready` forever after approval and nothing says a word.
   *
   *   The system does run the same check **after** approval — the overview line
   *   "no agent in this project can take this (1 checked)" is exactly it. It
   *   just runs too late: the user has already signed off on the promise.
   *
   *   So the **same** resolveExecutor is used here to pull the check ahead of
   *   approval. The cost of a second implementation is not duplicated code, it
   *   is two answers that disagree.
   *
   *   两份实现的代价不是重复代码，是两个对不上的答案。
   */
  const unrunnable: { id: string; title: string }[] = [];
  for (const task of tasks) {
    if (gatedTitles.has(task.title)) continue;
    const match = await resolveExecutor(db, task);
    if (match.candidates.length === 0) unrunnable.push({ id: task.id, title: task.title });
  }

  return {
    plan: {
      id: plan.id,
      version: plan.version,
      status: plan.status,
      projectId: plan.projectId,
      requirementId: plan.requirementId,
      model: plan.model,
      /**
       * ★★ null = this runtime reported no cost, **not "it cost nothing"**.
       *
       *   This used to be `Number(plan.generationCost ?? 0)`, so a runtime that
       *   does not report usage (opencode is one) could finish a real planning
       *   run and the page would read $0.00 — indistinguishable from "this
       *   planning genuinely was free". The tokens side has followed this
       *   convention for a long time (see format/tokens); cost was the one that
       *   got missed. 与「这次规划确实免费」完全无法区分。
       */
      generationCost: plan.generationCost === null ? null : Number(plan.generationCost),
      generationMs: plan.generationMs,
      /** Non-null = this plan is a generic template, not generated from the requirement. See PlanFallback */
      fallback: (plan.generationFallback as PlanFallback | null) ?? null,
      estimatedHours: Number(plan.estimatedHours ?? 0),
      estimatedTokens,
      createdAt: plan.createdAt.toISOString(),
      approvedAt: plan.approvedAt?.toISOString() ?? null,
      approvedBy: plan.approvedBy.map((id) => userName.get(id) ?? id),
      revisionFeedback: plan.revisionFeedback,
      risks: plan.risks,
      phases: plan.phases,
    },
    metrics: {
      taskCount: tasks.length,
      agentTasks,
      humanTasks,
      estimatedHours: Number(plan.estimatedHours ?? 0),
      estimatedTokens,
      budget,
      spent,
      /** ★ Over budget blocks approval, so the server decides it — not each client on its own */
      /** ★ No estimate means no over-budget verdict — substituting 0 fakes a "definitely fine" */
      overBudget: budget !== null && estimatedTokens !== null && spent + estimatedTokens > budget,
      humanGateCount: (plan.humanGates as unknown[]).length,
      /** Tasks no qualified agent can take — once approved they sit in `ready` and never move */
      tasksWithoutAgent: unrunnable,
      highRiskTasks: tasks.filter((t) => t.riskLevel === 'high' || t.riskLevel === 'critical').length,
    },
    /** The snapshot taken at approval time */
    autoActions: plan.autoActions,
    humanGates: plan.humanGates,
    /** The boundary recomputed under the current policies, for comparison */
    currentBoundary: {
      auto: current.summary.auto.map((o) => o.label),
      human: current.summary.human.map((o) => o.label),
      depends: current.summary.depends.map((o) => ({ label: o.label, when: o.when })),
    },
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      type: t.type,
      status: t.status,
      stage: t.stage,
      riskLevel: t.riskLevel,
      estimatedHours: t.estimatedHours === null ? null : Number(t.estimatedHours),
      estimatedTokens: t.estimatedTokens,
      executorType: t.executorType,
      executorName:
        t.executorType === 'human' && t.executorId ? (userName.get(t.executorId) ?? '未知') : null,
      /**
       * Before approval no executor is bound yet, so all this can say is
       * "will this step come and ask a human". Rendering it as "unassigned"
       * reads as "somebody forgot to staff it", when the truth is "an agent
       * gets picked at scheduling time".
       */
      requiresHuman: gatedTitles.has(t.title),
      ownerName: t.ownerId ? (userName.get(t.ownerId) ?? '未知') : null,
      position: t.position,
    })),
    /**
     * Which unconfirmed assumptions this plan rests on (page doc 04 §5,
     * answering 03 §12.2). The questions the user waved past with "record the
     * assumption and continue" on the requirement page get restated here — the
     * plan was built on them, and the user may well have simply scrolled by.
     */
    assumptions: assumptions.map((c) => ({
      id: c.id,
      question: c.question,
      answer: c.answer,
      level: c.level,
      confirmed: c.answer !== null,
    })),
  };
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 40 ? `${line.slice(0, 40)}…` : line || '（无标题）';
}

/**
 * Plan version comparison (page doc 04) / 计划版本对比。
 *
 * ★ The user is approving v2 while remembering v1. Without a diff their only
 *   option is to re-read all thirty lines of the task list — and what actually
 *   happens then is that they don't read it and approve anyway. A diff is not a
 *   convenience feature; it is what makes the act of approving mean something
 *   again.
 *
 * ★ Both sides' human/agent split has to be derived from their own humanGates
 *   snapshot. Before approval work_items.executorType is null everywhere, so
 *   counting it renders both versions as "👤 0" — and the one change that most
 *   needs to be seen ("this revision turned three human checkpoints into
 *   automatic ones") disappears from the diff entirely.
 */
export async function comparePlans(db: Database, planId: string, againstVersion?: number) {
  const [plan] = await db.select().from(plans).where(eq(plans.id, planId));
  if (!plan) throw notFound('plan');

  const siblings = await db
    .select()
    .from(plans)
    .where(eq(plans.projectId, plan.projectId))
    .orderBy(desc(plans.version));
  const sameRequirement = siblings.filter((p) => p.requirementId === plan.requirementId);

  const previous =
    againstVersion !== undefined
      ? sameRequirement.find((p) => p.version === againstVersion)
      : sameRequirement.find((p) => p.version < plan.version);

  const versions = sameRequirement.map((p) => ({
    id: p.id,
    version: p.version,
    status: p.status,
    createdAt: p.createdAt.toISOString(),
    isCurrent: p.id === plan.id,
  }));

  if (!previous) {
    // v1 has nothing to compare against: say so, rather than diffing an empty plan into "all added"
    return { versions, diff: null, against: null, feedback: plan.revisionFeedback };
  }

  const [beforeSide, afterSide] = await Promise.all([
    planSide(db, previous),
    planSide(db, plan),
  ]);

  return {
    versions,
    against: { id: previous.id, version: previous.version },
    /**
     * ★ Take the previous version's feedback only. The current version's
     *   revisionFeedback means "this version was later asked to change", so
     *   using it as "how this version came about" pins it on the wrong revision.
     */
    feedback: previous.revisionFeedback,
    diff: diffPlans(beforeSide, afterSide),
  };
}

async function planSide(db: Database, row: typeof plans.$inferSelect): Promise<PlanSide> {
  const tasks = await db
    .select()
    .from(workItems)
    .where(eq(workItems.planId, row.id))
    .orderBy(workItems.position);

  const gates = (row.humanGates as { taskTitle: string }[]) ?? [];
  const gated = new Set(gates.map((g) => g.taskTitle));

  return {
    version: row.version,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    estimatedHours: Number(row.estimatedHours ?? 0),
    estimatedTokens: row.estimatedTokens ?? 0,
    autoActions: (row.autoActions as { title: string; detail?: string }[]) ?? [],
    humanGates: gates,
    risks: (row.risks as { title?: string; description?: string }[]) ?? [],
    tasks: tasks.map((t) => ({
      title: t.title,
      type: t.type,
      riskLevel: t.riskLevel,
      estimatedHours: t.estimatedHours === null ? null : Number(t.estimatedHours),
      estimatedTokens: t.estimatedTokens,
      requiresHuman: gated.has(t.title),
    })),
  };
}
