import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import {
  decisions,
  events,
  policies,
  policyVersions,
  projects,
  users,
  workItems,
  type Database,
} from '@apos/db';
import {
  AUTHORED_PRIORITY_MIN,
  NEVER_AUTO_APPROVE,
  OPERATION_SWITCH_PRIORITY,
  actionLabel,
} from '@apos/contracts';
import type {
  Action,
  AutonomyLevel,
  Condition,
  Environment,
  FactKey,
  OperationType,
  Policy,
  PolicyContext,
} from '@apos/contracts';
import {
  ANY_ENVIRONMENT,
  AUTO_APPROVE_FOR_OPERATION,
  ENV_LABELS,
  OPERATION_LABELS,
  REQUIRE_HUMAN_FOR_OPERATION,
  auditPolicies,
  buildScenarios,
  compile,
  evaluate,
  explainPolicy,
  isAutoApprove,
  previewAutonomy,
  simulate,
  switchedOperationOf,
  templateById,
  type OperationOutcome,
  type HistoricalSample,
  type SimulationResult,
} from '@apos/domain';
import { fail, notFound } from './errors';

/**
 * Policy configuration (page doc 13 §9). / Policy 配置（页面文档 13 §9）。
 *
 * ★ What this page governs is "what an Agent may do on its own". Every write here is
 *   bound by two hard constraints:
 *   1. A project rule may only tighten an org rule, never loosen it (product doc,
 *      chapter 10, Permissions and Security);
 *   2. An Agent cannot modify a Policy — these endpoints accept human identity only (the
 *      JWT issued at login), while an Agent callback carries a run-scoped token and never
 *      reaches this far. If an Agent could edit its own constraints, the entire governance
 *      system would be void.
 */

/**
 * The data sources actually wired up today.
 *
 * ★ Hardcoding this is not laziness — it is an honest inventory of what we do *not* have.
 *   CI and security scanning are not connected yet, so a rule whose condition mentions
 *   testsResult can never match; the audit uses this list to tell the user outright "this
 *   rule will never fire" instead of letting it fail silently.
 */
const WIRED_FACTS: FactKey[] = ['agentReview'];

export async function getPolicies(db: Database, projectId: string) {
  const project = await loadProject(db, projectId);
  const rows = await loadProjectPolicies(db, project.orgId, projectId);
  const hits = await loadHits(db, projectId, rows);

  const audit = auditPolicies(rows, project.autonomyLevel as AutonomyLevel, hits, WIRED_FACTS);
  const hitMap = new Map(hits.map((h) => [h.policyId, h]));

  const serialize = (p: Policy) => ({
    ...p,
    /** Built from templates, not an LLM — the explanation must match execution exactly (§5.6) */
    explanation: explainPolicy(p.condition, p.action),
    hits30d: hitMap.get(p.id)?.hits30d ?? 0,
    avgWaitSeconds: hitMap.get(p.id)?.avgWaitSeconds ?? null,
    /** Org-level rules are read-only inside a project (no creation entry yet; there will be) */
    editable: p.projectId !== null,
  });

  return {
    project: { id: project.id, name: project.name, autonomyLevel: project.autonomyLevel },
    orgPolicies: rows.filter((p) => p.projectId === null).map(serialize),
    projectPolicies: rows.filter((p) => p.projectId !== null).map(serialize),
    summary: audit.summary,
    issues: audit.issues,
    /** The page has to state honestly which data sources are not wired up */
    wiredFacts: WIRED_FACTS,
  };
}

// ── Writes ────────────────────────────────────────────────────────────────

export interface PolicyDraft {
  name: string;
  description?: string;
  priority: number;
  condition: Condition;
  action: Action;
  enabled?: boolean;
}

/**
 * Save a rule (create or update).
 *
 * ★ This deliberately deviates from the API design in page doc §9: the doc asks a
 *   loosening change to carry a `simulation_id`. But that id comes from the client — a
 *   made-up string gets around it, and this gate happens to be the single most important
 *   safety valve on this page (§10, "100% of loosening rule changes go through
 *   simulation").
 *
 *   So instead the server **runs the simulation itself** at save time: when the change is
 *   judged to be a loosening and the simulation turns up historical cases where the human
 *   decided differently, it answers 422 and hands those cases back; the client must pass
 *   `acknowledgeMismatches` explicitly to continue. That makes "you must have seen the
 *   simulation" structurally true rather than dependent on the client being honest.
 */
export async function savePolicy(
  db: Database,
  projectId: string,
  draft: PolicyDraft,
  actorId: string,
  opts: {
    policyId?: string;
    acknowledgeMismatches?: boolean;
    /**
     * Authorization callback (the asymmetric design of 09-security §2.3).
     *
     * ★ Tightening and loosening are two different permissions, and which one this change
     *   counts as is only known after running the old and new rule sets against each
     *   other — the route layer can only stop someone not even entitled to tighten. So the
     *   check has to happen here, after the direction is computed, by asking back through
     *   this callback.
     */
    assertCan?: (permission: 'policy.tighten' | 'policy.loosen') => void;
  } = {},
) {
  const project = await loadProject(db, projectId);
  const existing = await loadProjectPolicies(db, project.orgId, projectId);

  if (opts.policyId) {
    const target = existing.find((p) => p.id === opts.policyId);
    if (!target) throw notFound('policy');
    assertEditable(target);
  }

  const candidate: Policy = {
    id: opts.policyId ?? randomUUID(),
    orgId: project.orgId,
    projectId,
    name: draft.name,
    description: draft.description ?? '',
    priority: draft.priority,
    enabled: draft.enabled ?? true,
    condition: draft.condition,
    action: draft.action,
  };

  const next = [...existing.filter((p) => p.id !== candidate.id), candidate];
  const level = project.autonomyLevel as AutonomyLevel;

  assertNotLooseningOrgRules(existing, next, level);

  const loosened = loosenedScenarios(existing, next, level);
  let simulation: SimulationResult | null = null;

  /**
   * ★★ Authorization has to happen **before** the simulation runs.
   *
   *   The simulation scans 90 days of historical evaluation records and is the most
   *   expensive step on this path. Checking permission after it would let someone with no
   *   right to loosen a rule run it anyway — burning database time for nothing, and
   *   handing "which historical tasks would have been auto-approved" to a person who
   *   should not see it. The order here is not merely an efficiency matter.
   *
   *   The direction test matches the audit's (see the note on `direction` below): a rule
   *   that auto-approves counts as a loosening even when the scenario grid did not get
   *   any looser.
   */
  if (opts.assertCan) {
    const willAutoApprove = isAutoApprove(candidate.action) && candidate.enabled;
    opts.assertCan(loosened > 0 || willAutoApprove ? 'policy.loosen' : 'policy.tighten');
  }

  /**
   * ★ Run the simulation whenever this rule auto-approves — the test is *not* "did the
   *   scenario grid get looser".
   *
   *   The two are not equivalent, and the gap is the kind that causes incidents: a rule
   *   like "auto-approve low- and medium-risk deploys" may loosen not a single cell of
   *   the grid (those scenarios were already passed by another rule or by the default
   *   policy), and yet it will auto-approve 10 tasks that humans rejected historically.
   *   Judged by the grid, such a rule sails through save, and the most important safety
   *   valve on this page (§10, "100% of loosening rule changes go through simulation")
   *   becomes decorative.
   *
   *   The cost is one extra historical query every time an auto-approving rule is saved.
   *   That cost is worth paying.
   */
  if (isAutoApprove(candidate.action) && candidate.enabled) {
    simulation = await runSimulation(db, projectId, candidate, '90d');
    if (simulation.mismatches.length > 0 && !opts.acknowledgeMismatches) {
      throw fail(
        'POLICY_DENIED',
        'policy.loosening_contradicts_history',
        `这条规则会自动放行 ${simulation.wouldAutoHandle} 次评估，` + `而其中 ${simulation.mismatches.length} 个任务，人类当时是驳回或要求修改的。请先看看这些案例。`,
        { params: { approvals: simulation.wouldAutoHandle, mismatches: simulation.mismatches.length }, details: { simulation, loosenedScenarios: loosened, requiresAcknowledgment: true } },
      );
    }
  }

  /**
   * ★ The direction recorded in the audit follows *what the rule does*, not merely whether
   *   the scenario grid got looser. An auto-approving rule may loosen no cell at all
   *   (those scenarios were already automatic), and recording it as "tighten" is a lie in
   *   the audit trail — which is the one thing anybody can go back and check afterward.
   */
  const direction = loosened > 0 || (isAutoApprove(candidate.action) && candidate.enabled)
    ? 'loosen'
    : 'tighten';
  const before = existing.find((p) => p.id === candidate.id) ?? null;

  await db.transaction(async (tx) => {
    if (opts.policyId) {
      await tx
        .update(policies)
        .set({
          name: candidate.name,
          description: candidate.description,
          priority: candidate.priority,
          enabled: candidate.enabled,
          condition: candidate.condition,
          action: candidate.action,
          version: sql`${policies.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(policies.id, candidate.id));
    } else {
      await tx.insert(policies).values({
        id: candidate.id,
        orgId: candidate.orgId,
        projectId,
        name: candidate.name,
        description: candidate.description,
        priority: candidate.priority,
        enabled: candidate.enabled,
        condition: candidate.condition,
        action: candidate.action,
        createdBy: actorId,
      });
    }

    // ★ Policy changes are highly sensitive and must be fully audited (product doc 10.5)
    const [row] = await tx.select().from(policies).where(eq(policies.id, candidate.id));
    await tx.insert(policyVersions).values({
      policyId: candidate.id,
      version: row?.version ?? 1,
      snapshot: { before, after: candidate },
      changedBy: actorId,
      direction,
    });
  });

  return { policy: candidate, direction, loosenedScenarios: loosened, simulation };
}

/**
 * The operation switch matrix — one row per operation type, one switch on the right
 * (page doc 13).
 *
 * ★★ This is the main entry point of the page, because it removes a layer of translation.
 *
 *   What a user thinks is "deploying — can the Agent do that on its own?". The old path
 *   made them first translate that into "a rule whose condition is operationType ==
 *   deploy and whose action is allow", then go back to the summary to check whether they
 *   translated it right. The row they could see (the summary) and the row they could
 *   change (the rule) were not the same row — that gap was the largest cost on this page.
 *   The switch fuses them into one row: what you see is what you change.
 *
 * ★★ One toggle = **one rule**, not a merge.
 *
 *   The tempting move is to rewrite existing rules too, so the row lands "cleanly" in the
 *   state the user asked for. We do not: a hand-written rule is intent the user already
 *   expressed, and a single click should not quietly rewrite it. The switch only adds one
 *   rule at the **front** (or edits the one it added last time) and leaves every existing
 *   rule untouched. So "delete that rule to undo" always holds — which is the precondition
 *   for a one-click action being trustworthy.
 *
 * ★★ And precisely because of that, a toggle **may not take effect** — an existing rule or
 *   the safety floor can still win. So the outcome is re-audited after saving and what
 *   this row's state truly is now is reported honestly. Answering "saved" without
 *   reporting the outcome is exactly the kind of lie this page must avoid: the user
 *   believes they opened something up when they did not.
 *
 *   一次切换只加一条规则、不改用户手写的规则，所以「删掉这条规则即还原」永远成立；
 *   也因此切换可能不生效，保存后必须重新体检并如实返回结果。
 */
export interface OperationSwitchInput {
  operationType: OperationType;
  verdict: 'auto' | 'human';
  /** Set it to govern one environment only; omitted = all environments (no environment in the condition) */
  environment?: Environment | typeof ANY_ENVIRONMENT;
  /** Who confirms, when verdict = human */
  approver?: string;
  dueInHours?: number;
  /**
   * The rule name, composed by the UI in the user's current language. The name is **data
   * that gets stored**: if the server composed a Chinese sentence, an English UI would
   * show a Chinese rule name forever.
   */
  name?: string;
}

export async function setOperationSwitch(
  db: Database,
  projectId: string,
  input: OperationSwitchInput,
  actorId: string,
  opts: {
    acknowledgeMismatches?: boolean;
    assertCan?: (permission: 'policy.tighten' | 'policy.loosen') => void;
  } = {},
) {
  const project = await loadProject(db, projectId);
  const existing = await loadProjectPolicies(db, project.orgId, projectId);

  const templateId =
    input.verdict === 'auto' ? AUTO_APPROVE_FOR_OPERATION : REQUIRE_HUMAN_FOR_OPERATION;
  const template = templateById(templateId);
  /* c8 ignore next — the template id is a constant; a miss can only mean a broken template table */
  if (!template) throw notFound('template');

  const built = template.build({
    operationType: input.operationType,
    environment: input.environment ?? ANY_ENVIRONMENT,
    approver: input.approver ?? 'tech_lead',
    dueInHours: input.dueInHours ?? 8,
  });

  const current = findOperationSwitch(existing, input.operationType);
  const label = OPERATION_LABELS[input.operationType] ?? input.operationType;

  const saved = await savePolicy(
    db,
    projectId,
    {
      name: input.name?.trim() || defaultSwitchName(input.verdict, label),
      description: '',
      /**
       * ★ Reuse the priority of the rule it wrote last time rather than allocating a new
       *   one — reordering would mean "this click also changed the ordering of several
       *   other rules" while the user believes they only flipped one switch.
       */
      priority: current?.priority ?? OPERATION_SWITCH_PRIORITY,
      condition: built.condition,
      action: built.action,
    },
    actorId,
    {
      ...(current ? { policyId: current.id } : {}),
      ...(opts.acknowledgeMismatches !== undefined
        ? { acknowledgeMismatches: opts.acknowledgeMismatches }
        : {}),
      ...(opts.assertCan ? { assertCan: opts.assertCan } : {}),
    },
  );

  /**
   * ★ Re-audit after saving.
   *   This is not a nicety: the result of a toggle depends on how the whole rule set is
   *   ordered, and that answer is only known by running the set again. Skip it and the UI
   *   can say nothing but "saved".
   */
  const after = await loadProjectPolicies(db, project.orgId, projectId);
  const { summary } = auditPolicies(after, project.autonomyLevel as AutonomyLevel);
  const outcome = findOutcome(summary, input.operationType);
  const applied = outcome?.verdict === input.verdict;

  /**
   * When it did not take effect, which rule is standing in front — reporting only "did not
   * take effect" hands the whole investigation back to the user.
   */
  const shadowedBy = applied
    ? []
    : (outcome?.matchedPolicyIds ?? [])
        .filter((id) => id !== saved.policy.id)
        .map((id) => after.find((p) => p.id === id))
        .filter((p): p is Policy => Boolean(p))
        .map((p) => ({ id: p.id, name: p.name, scope: p.projectId === null ? 'org' : 'project' }));

  return {
    ...saved,
    outcome,
    applied,
    shadowedBy,
    /**
     * ★ The two causes of "did not take effect" must be reported separately.
     *   "Shadowed by another rule" is something the user can fix (go look at that rule);
     *   "the safety floor forbids it" is not — no configuration will ever auto-approve
     *   deleting resources, changing permissions, or making payments. Collapsed into one
     *   "did not take effect", the first user cannot tell where to look and the second
     *   keeps trying forever — both waste time.
     */
    blockedBy: applied
      ? null
      : shadowedBy.length > 0
        ? ('other_rules' as const)
        : input.verdict === 'auto' &&
            (NEVER_AUTO_APPROVE as readonly string[]).includes(input.operationType)
          ? ('safety_floor' as const)
          : ('autonomy_default' as const),
  };
}

/** Turning the switch off = deleting the rule it created; the row falls back to the other rules */
export async function clearOperationSwitch(
  db: Database,
  projectId: string,
  operationType: OperationType,
  actorId?: string,
) {
  const project = await loadProject(db, projectId);
  const existing = await loadProjectPolicies(db, project.orgId, projectId);
  const current = findOperationSwitch(existing, operationType);
  if (!current) throw notFound('policy');

  // Deleting passes the same two gates: "cannot loosen an org rule" and "unresolved decisions"
  return deletePolicy(db, projectId, current.id, actorId);
}

/**
 * Which rule is this row's switch.
 *
 * ★ Only **project-level** rules count: an org rule cannot be edited from inside a
 *   project, so treating one as this row's switch means the user clicks and gets back
 *   "org-level rules cannot be modified" — while what they saw was plainly a clickable
 *   switch.
 */
function findOperationSwitch(policies: Policy[], operationType: OperationType): Policy | undefined {
  return policies.find(
    (p) => p.projectId !== null && switchedOperationOf(p.condition) === operationType,
  );
}

function findOutcome(
  summary: { auto: OperationOutcome[]; human: OperationOutcome[]; depends: OperationOutcome[] },
  operationType: OperationType,
): OperationOutcome | null {
  return (
    [...summary.auto, ...summary.human, ...summary.depends].find(
      (o) => o.operationType === operationType,
    ) ?? null
  );
}

/** Fallback for when the UI sends no name. Chinese, matching the other server-side fallbacks */
function defaultSwitchName(verdict: 'auto' | 'human', label: string): string {
  return verdict === 'auto' ? `${label}：自动执行` : `${label}：需人确认`;
}

/**
 * The next priority for a hand-written project rule.
 *
 * ★★ Priority is the most expensive concept on this page: to fill in one number correctly
 *   a user has to hold three things at once — "smaller goes first", "first match wins",
 *   and "org rules occupy the front band". And almost nobody ever comes back to change
 *   what they typed — that input box buys one moment of confusion, not one act of
 *   configuration. So it disappeared from the editor and the server appends instead.
 *
 * ★ Numbering starts at AUTHORED_PRIORITY_MIN, leaving the 100 slot to the switch matrix:
 *   a switch is a statement the user just made, and it belongs ahead of a rule they wrote
 *   six months ago.
 */
export function nextAuthoredPriority(existing: Policy[]): number {
  const used = existing
    .filter((p) => p.projectId !== null)
    .map((p) => p.priority)
    .filter((n) => n >= AUTHORED_PRIORITY_MIN);
  return used.length === 0 ? AUTHORED_PRIORITY_MIN : Math.max(...used) + 1;
}

export async function togglePolicy(
  db: Database,
  projectId: string,
  policyId: string,
  enabled: boolean,
  reason: string,
  actorId: string,
) {
  const project = await loadProject(db, projectId);
  const existing = await loadProjectPolicies(db, project.orgId, projectId);
  const target = existing.find((p) => p.id === policyId);
  if (!target) throw notFound('policy');
  assertEditable(target);

  // Disabling a tightening rule is a loosening, so it goes through the simulation gate too
  const next = existing.map((p) => (p.id === policyId ? { ...p, enabled } : p));
  const level = project.autonomyLevel as AutonomyLevel;
  assertNotLooseningOrgRules(existing, next, level);

  await db.transaction(async (tx) => {
    await tx
      .update(policies)
      .set({
        enabled,
        disabledBy: enabled ? null : actorId,
        disabledReason: enabled ? null : reason,
        version: sql`${policies.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(policies.id, policyId));

    const [row] = await tx.select().from(policies).where(eq(policies.id, policyId));
    await tx.insert(policyVersions).values({
      policyId,
      version: row?.version ?? 1,
      snapshot: { before: target, after: { ...target, enabled }, reason },
      changedBy: actorId,
      direction: enabled ? 'tighten' : 'loosen',
    });
  });

  return { ok: true as const, enabled };
}

export async function getPolicyHistory(db: Database, policyId: string) {
  const rows = await db
    .select()
    .from(policyVersions)
    .where(eq(policyVersions.policyId, policyId))
    .orderBy(desc(policyVersions.version));

  return {
    history: rows.map((r) => ({
      version: r.version,
      direction: r.direction,
      changedBy: r.changedBy,
      changedAt: r.changedAt.toISOString(),
      snapshot: r.snapshot,
    })),
  };
}

// ── Simulation & scenarios ────────────────────────────────────────────────

/**
 * Historical replay (§5.7 — the most important feature on this page).
 *
 * The data comes from the `contextSnapshot` carried on `policy.evaluated` events. That is
 * exactly why the iron rule "every policy evaluation must carry a 23-fact snapshot"
 * exists: without it there is nothing to replay, and a user who cannot replay will never
 * dare open up automation.
 */
export async function runSimulation(
  db: Database,
  projectId: string,
  draft: Pick<Policy, 'condition' | 'action'>,
  range: '7d' | '30d' | '90d',
): Promise<SimulationResult> {
  const days = { '7d': 7, '30d': 30, '90d': 90 }[range];
  const since = new Date(Date.now() - days * 86_400_000);

  const rows = await db
    .select({
      id: events.id,
      subjectId: events.subjectId,
      contextSnapshot: events.contextSnapshot,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .where(
      and(
        eq(events.projectId, projectId),
        eq(events.type, 'policy.evaluated'),
        gte(events.occurredAt, since),
      ),
    )
    .orderBy(desc(events.id))
    .limit(500);

  const withContext = rows.filter((r) => r.contextSnapshot !== null);
  const itemIds = [...new Set(withContext.map((r) => r.subjectId))];
  if (itemIds.length === 0) return simulate(draft, []);

  const titles = new Map(
    (await db
      .select({ id: workItems.id, title: workItems.title })
      .from(workItems)
      .where(inArray(workItems.id, itemIds))).map((i) => [i.id, i.title]),
  );

  // What the human decided at the time — the resolved decision on the same task closest to
  // that evaluation
  const decisionRows = await db
    .select()
    .from(decisions)
    .where(inArray(decisions.workItemId, itemIds));

  const samples: HistoricalSample[] = withContext.map((r) => {
    const at = r.occurredAt.getTime();
    const candidates = decisionRows
      .filter((d) => d.workItemId === r.subjectId && d.resolvedAt !== null)
      .sort((a, b) => Math.abs(a.createdAt.getTime() - at) - Math.abs(b.createdAt.getTime() - at));
    const decision = candidates[0];

    return {
      eventId: String(r.id),
      workItemId: r.subjectId,
      occurredAt: r.occurredAt.toISOString(),
      context: r.contextSnapshot as PolicyContext,
      humanDecision:
        decision && ['approved', 'rejected', 'revision_requested'].includes(decision.status)
          ? (decision.status as HistoricalSample['humanDecision'])
          : null,
      humanNote: decision?.resolutionNote ?? null,
      workItemTitle: titles.get(r.subjectId) ?? '（已删除的任务）',
    };
  });

  return simulate(draft, samples);
}

/**
 * Hand-built scenario testing (§5.7).
 *
 * ★ Returns the full matching process, not only the verdict.
 *   "I configured auto-approval, so why is it still asking me?" is the question this page
 *   gets asked most, and the answer is always "a higher-priority rule caught it first" —
 *   draw the priority chain and the user works it out for themselves.
 */
export async function evaluateScenario(
  db: Database,
  projectId: string,
  overrides: Partial<PolicyContext>,
) {
  const project = await loadProject(db, projectId);
  const rows = await loadProjectPolicies(db, project.orgId, projectId);
  const base = buildScenarios(project.autonomyLevel as AutonomyLevel)[0]!.context;
  const ctx: PolicyContext = { ...base, ...overrides, autonomyLevel: project.autonomyLevel as AutonomyLevel };

  const compiled = compile(rows);
  const verdict = evaluate(ctx, compiled);
  const byId = new Map(rows.map((p) => [p.id, p]));

  // Rules after the match were never evaluated at all; mark them as such
  const matchedIndex = verdict.trace.findIndex((t) => t.matched);
  const evaluatedIds = new Set(
    verdict.trace.slice(0, matchedIndex === -1 ? undefined : matchedIndex + 1).map((t) => t.policyId),
  );

  return {
    context: ctx,
    action: verdict.action,
    requiresHuman: verdict.requiresHuman,
    matchedPolicyId: verdict.matchedPolicyId,
    matchedPolicyName: verdict.matchedPolicyName,
    explanation: explainPolicy(
      { fact: 'operationType', op: 'eq', value: ctx.operationType },
      verdict.action,
    ),
    trace: compiled.map((rule) => {
      const entry = verdict.trace.find((t) => t.policyId === rule.id);
      return {
        policyId: rule.id,
        name: rule.name,
        priority: rule.priority,
        scope: byId.get(rule.id)?.projectId === null ? ('org' as const) : ('project' as const),
        state: !evaluatedIds.has(rule.id)
          ? ('not_evaluated' as const)
          : entry?.matched
            ? ('matched' as const)
            : ('missed' as const),
        failedAt: entry?.failedAt ?? null,
      };
    }),
  };
}

export async function autonomyPreview(db: Database, projectId: string, to: AutonomyLevel) {
  const project = await loadProject(db, projectId);
  const rows = await loadProjectPolicies(db, project.orgId, projectId);
  return previewAutonomy(rows, project.autonomyLevel as AutonomyLevel, to);
}

// ── Internals ────────────────────────────────────────────────────────────

async function loadProject(db: Database, projectId: string) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw notFound('project');
  return project;
}

export async function loadProjectPolicies(
  db: Database,
  orgId: string,
  projectId: string,
): Promise<Policy[]> {
  const rows = await db
    .select()
    .from(policies)
    .where(
      and(
        eq(policies.orgId, orgId),
        sql`(${policies.projectId} IS NULL OR ${policies.projectId} = ${projectId})`,
      ),
    )
    .orderBy(policies.priority);

  return rows
    .map((r) => ({
      id: r.id,
      orgId: r.orgId,
      projectId: r.projectId,
      name: r.name,
      description: r.description,
      priority: r.priority,
      enabled: r.enabled,
      condition: r.condition,
      action: r.action,
    }))
    .sort((a, b) => a.priority - b.priority);
}

/**
 * Hits in the last 30 days, plus how long each rule has existed.
 *
 * Nothing maintains the `policies.hitCount30d` column, so reading it only ever yields 0.
 * Counting straight from the event stream is the only truthful answer — and the event
 * stream is the one history that never gets overwritten anyway.
 */
async function loadHits(db: Database, projectId: string, all: Policy[]) {
  const now = Date.now();
  const since = new Date(now - 30 * 86_400_000);
  const rows = await db
    .select({ payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.projectId, projectId),
        eq(events.type, 'policy.evaluated'),
        gte(events.occurredAt, since),
      ),
    );

  const counts = new Map<string, number>();
  for (const r of rows) {
    const id = (r.payload as { matchedPolicyId?: string | null }).matchedPolicyId;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const created = new Map(
    (await db
      .select({ id: policies.id, createdAt: policies.createdAt })
      .from(policies)
      .where(inArray(policies.id, all.map((p) => p.id)))
    ).map((r) => [r.id, r.createdAt.getTime()]),
  );

  // Cover every rule, not just the ones that were hit — zero-hit detection is looking for
  // exactly the rules that never showed up in the counts
  return all.map((p) => ({
    policyId: p.id,
    hits30d: counts.get(p.id) ?? 0,
    ageDays: (now - (created.get(p.id) ?? now)) / 86_400_000,
    avgWaitSeconds: null,
  }));
}

function assertEditable(policy: Policy): void {
  if (policy.projectId === null) {
    throw fail(
      'FORBIDDEN',
      'policy.org_scoped_readonly',
      `「${policy.name}」是组织级规则，项目内不可修改或删除。如需例外，请联系组织管理员申请。`,
      { params: { name: policy.name }, details: { policyId: policy.id, scope: 'org' } },
    );
  }
}

/**
 * ★ "Tighten only, never loosen" is a hard constraint of the whole governance system.
 *
 *   The test is not a comparison of how strict two rules' actions are — that misses the
 *   dodge of "put a looser, higher-priority rule in front of the org rule". What is
 *   compared here is the **outcome**: run every scenario and see whether any scenario the
 *   org rule used to stop now auto-approves. That cannot be worked around, because the
 *   outcome is precisely what ends up in effect.
 */
function assertNotLooseningOrgRules(before: Policy[], after: Policy[], level: AutonomyLevel): void {
  const orgOnly = compile(before.filter((p) => p.projectId === null));
  const nextAll = compile(after);

  for (const scenario of buildScenarios(level)) {
    const org = evaluate(scenario.context, orgOnly);
    // The org rules say nothing about this scenario, so the project may configure it freely
    if (org.matchedPolicyId === null || isAutoApprove(org.action)) continue;

    const next = evaluate(scenario.context, nextAll);
    if (!isAutoApprove(next.action)) continue;

    /**
     * ★ Named and unnamed are two separate messages, not one message with an empty slot.
     *   `matchedPolicyName` is nullable by type (null when no rule matched). Substituting
     *   an empty string yields 'the org rule "" requires…' — a sentence that reads like a
     *   bug. In neither language can "some org rule" be produced by punching a hole in the
     *   named sentence, so it has to be a sentence of its own.
     */
    throw org.matchedPolicyName
      ? fail(
          'POLICY_DENIED',
          'policy.org_rule_cannot_be_loosened',
          `组织规则「${org.matchedPolicyName}」要求这类操作必须人工确认，项目级规则不能放宽它。` +
            `冲突场景：${describe(scenario.context)}。如需例外，请联系组织管理员申请。`,
          {
            params: { name: org.matchedPolicyName },
            details: { orgPolicyId: org.matchedPolicyId, scenario: scenario.key },
          },
        )
      : fail(
          'POLICY_DENIED',
          'policy.org_rule_cannot_be_loosened_unnamed',
          `一条组织规则要求这类操作必须人工确认，项目级规则不能放宽它。` +
            `冲突场景：${describe(scenario.context)}。如需例外，请联系组织管理员申请。`,
          { details: { orgPolicyId: org.matchedPolicyId, scenario: scenario.key } },
        );
  }
}

/** How many scenarios went from "needs a human" to "automatic" after the change */
function loosenedScenarios(before: Policy[], after: Policy[], level: AutonomyLevel): number {
  const b = compile(before);
  const a = compile(after);
  let count = 0;

  for (const scenario of buildScenarios(level)) {
    const wasAuto = isAutoApprove(evaluate(scenario.context, b).action);
    const nowAuto = isAutoApprove(evaluate(scenario.context, a).action);
    if (!wasAuto && nowAuto) count++;
  }
  return count;
}

/**
 * Uses the Chinese labels rather than raw enum values — this line is read by the project
 * lead, not by an engineer.
 */
function describe(ctx: PolicyContext): string {
  const risk: Record<string, string> = { low: '低', medium: '中', high: '高', critical: '极高' };
  return [
    OPERATION_LABELS[ctx.operationType] ?? ctx.operationType,
    `风险${risk[ctx.riskLevel] ?? ctx.riskLevel}`,
    ctx.environment ? (ENV_LABELS[ctx.environment] ?? ctx.environment) : '不涉及特定环境',
  ].join(' · ');
}

export async function deletePolicy(
  db: Database,
  projectId: string,
  policyId: string,
  actorId?: string,
) {
  const project = await loadProject(db, projectId);
  const rows = await loadProjectPolicies(db, project.orgId, projectId);
  const target = rows.find((p) => p.id === policyId);
  if (!target) throw notFound('policy');
  assertEditable(target);

  // A deletion is a loosening, so it passes the org-rule gate too
  assertNotLooseningOrgRules(
    rows,
    rows.filter((p) => p.id !== policyId),
    project.autonomyLevel as AutonomyLevel,
  );

  const pending = await db
    .select({ id: decisions.id, title: decisions.title })
    .from(decisions)
    .where(and(eq(decisions.triggeredByPolicy, policyId), eq(decisions.status, 'pending')));

  if (pending.length > 0) {
    throw fail(
      'POLICY_DENIED',
      'policy.has_pending_decisions',
      `还有 ${pending.length} 个由这条规则触发的决策没处理完，先处理完再删除。`,
      { params: { count: pending.length }, details: { pending } },
    );
  }

  await db.transaction(async (tx) => {
    /**
     * ★★ The deletion itself gets an audit entry.
     *
     *   Deleting a rule is the highest-consequence action on this page — it takes a whole
     *   gate away. Delete without recording and the only later clue to "was there once a
     *   rule stopping this?" is that rule's last **edit** record, which looks perfectly
     *   normal. A deletion would then look, in the history, exactly like nothing happened.
     *
     * ★ `after: null` is how "it is gone" is written. The change history can therefore be
     *   read all the way to its end instead of breaking off at the last edit.
     *
     *   删除本身也要留审计：只删不记的话，历史上一次删除长得和什么都没发生一样。
     */
    const [row] = await tx.select().from(policies).where(eq(policies.id, policyId));
    await tx.delete(policies).where(eq(policies.id, policyId));
    await tx.insert(policyVersions).values({
      policyId,
      version: (row?.version ?? 1) + 1,
      snapshot: { before: target, after: null },
      changedBy: actorId ?? target.orgId,
      direction: 'loosen',
    });
  });

  return { ok: true as const };
}

export { isNull };

/**
 * The hit detail for one rule (page doc 13).
 *
 * ★ "47 hits in the last 30 days" is a dead number. A rule whose 47 hits cannot be
 *   inspected is a rule that cannot be audited — and nobody dares touch a rule they
 *   cannot audit, so it either stays forever (even once it is wrong) or gets deleted
 *   outright.
 *
 * ★ What this page really answers is not "how often did it fire" but **"did it stop the
 *   right things"**: the rule demands human confirmation and the human approves every
 *   time → it is wasting everyone's time and can be relaxed; the human rejects often → it
 *   is catching the right things, leave it alone. That judgment is only possible with the
 *   **outcome** of every hit laid out, which is why the decision result is a primary
 *   column here rather than a footnote.
 */
export async function getPolicyHits(db: Database, projectId: string, policyId: string) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw notFound('project');

  const all = await loadProjectPolicies(db, project.orgId, projectId);
  const policy = all.find((p) => p.id === policyId);
  if (!policy) throw notFound('policy');

  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.projectId, projectId),
        eq(events.type, 'policy.evaluated'),
        gte(events.occurredAt, since),
      ),
    )
    .orderBy(desc(events.occurredAt));

  const mine = rows.filter(
    (r) => (r.payload as { matchedPolicyId?: string | null }).matchedPolicyId === policyId,
  );

  const itemIds = [...new Set(mine.map((r) => r.subjectId))];
  const items =
    itemIds.length > 0
      ? await db.select().from(workItems).where(inArray(workItems.id, itemIds))
      : [];
  const itemById = new Map(items.map((i) => [i.id, i]));

  /**
   * The decisions this rule triggered, and how they ended.
   *
   * ★ Rule ids are all UUIDs now, so `decisions.triggered_by_policy` matches directly.
   *   (The hardcoded baselines used readable ids like `baseline-xxx`, which cannot go into
   *   a foreign-key column, so the join once had to go back through the work item — that
   *   fallback was removed along with the baselines.)
   */
  const decisionRows = itemIds.length > 0
    ? await db.select().from(decisions).where(inArray(decisions.workItemId, itemIds))
    : [];
  const relevant = decisionRows.filter((d) => d.triggeredByPolicy === policyId);
  const decisionByItem = new Map<string, typeof relevant>();
  for (const d of relevant) {
    if (!d.workItemId) continue;
    const list = decisionByItem.get(d.workItemId) ?? [];
    list.push(d);
    decisionByItem.set(d.workItemId, list);
  }

  const userRows = await db.select({ id: users.id, name: users.name }).from(users);
  const userName = new Map(userRows.map((u) => [u.id, u.name]));

  const hits = mine.map((r) => {
    const payload = r.payload as { action?: { type?: string } };
    const snapshot = r.contextSnapshot as PolicyContext | null;
    const item = itemById.get(r.subjectId);
    // When one task was hit several times, take the decision closest in time
    const candidates = decisionByItem.get(r.subjectId) ?? [];
    const decision = nearestDecision(candidates, r.occurredAt.getTime());

    return {
      eventId: String(r.id),
      at: r.occurredAt.toISOString(),
      action: payload.action?.type ?? 'unknown',
      actionLabel: actionLabel(payload.action?.type ?? '未知'),
      workItemId: r.subjectId,
      workItemTitle: item?.title ?? '（已删除）',
      /** The context at trigger time — without these, the user cannot see why this hit matched */
      context: snapshot
        ? {
            operationType: snapshot.operationType,
            riskLevel: snapshot.riskLevel,
            environment: snapshot.environment,
          }
        : null,
      decision: decision
        ? {
            id: decision.id,
            status: decision.status,
            statusLabel: DECISION_STATUS_LABELS[decision.status] ?? decision.status,
            resolvedBy: decision.resolvedBy ? (userName.get(decision.resolvedBy) ?? '未知') : null,
            waitMinutes:
              decision.resolvedAt === null
                ? null
                : Math.round((decision.resolvedAt.getTime() - decision.createdAt.getTime()) / 60_000),
          }
        : null,
    };
  });

  /**
   * ★ Were the auto-approved tasks changed by hand afterward.
   *
   *   A pass-through rule produces no decisions, so judging it by "approval rate" is
   *   meaningless. The only place it can be falsified is whether the things it let through
   *   were later corrected by a human. If they were, it is letting too much through — and
   *   that is the only evidence there is that a pass-through rule is wrong.
   */
  const overrideRows = itemIds.length > 0
    ? await db
        .select({ subjectId: events.subjectId, payload: events.payload })
        .from(events)
        .where(
          and(
            eq(events.projectId, projectId),
            eq(events.type, 'work_item.status_changed'),
            inArray(events.subjectId, itemIds),
            gte(events.occurredAt, since),
          ),
        )
    : [];
  const overridden = new Set(
    overrideRows
      .filter((r) => (r.payload as { manual?: boolean }).manual === true)
      .map((r) => r.subjectId),
  );

  const resolved = hits.filter((h) => h.decision && h.decision.status !== 'pending');
  const approved = resolved.filter((h) => h.decision!.status === 'approved').length;
  const waits = resolved
    .map((h) => h.decision!.waitMinutes)
    .filter((w): w is number => w !== null);

  return {
    policy: {
      id: policy.id,
      name: policy.name,
      enabled: policy.enabled,
      editable: policy.projectId !== null,
    },
    stats: {
      hits: hits.length,
      /**
       * ★ Grouped by the **action enum**, not by the Chinese label.
       *   Using the label as a grouping key hurts twice: the UI receives Chinese (still
       *   Chinese on an English UI), and changing a single character of a label splits the
       *   historical statistics into two groups.
       */
      byAction: countBy(hits.map((h) => h.action)),
      decisionsCreated: hits.filter((h) => h.decision).length,
      resolved: resolved.length,
      approved,
      /** ★ The page's verdict rests on this: all approved = wasted time; often rejected = it works */
      approvalRate: resolved.length === 0 ? null : Math.round((approved / resolved.length) * 100) / 100,
      avgWaitMinutes:
        waits.length === 0 ? null : Math.round(waits.reduce((a, b) => a + b, 0) / waits.length),
    },
    /**
     * ★ Give a verdict, not just numbers. "23 of 23 approved" and "9 of 23 rejected" point
     *   to opposite actions, and making the user re-derive that from a percentage is a
     *   step nobody needs.
     */
    /** How many passed tasks were later changed by hand — a pass-through rule's only falsifier */
    overriddenAfterPass: hits.filter((h) => !h.decision && overridden.has(h.workItemId)).length,
    verdict: verdictOf({
      hits: hits.length,
      resolved: resolved.length,
      approved,
      gating: hits.filter((h) => h.decision).length,
      overriddenAfterPass: hits.filter((h) => !h.decision && overridden.has(h.workItemId)).length,
    }),
    hits: hits.slice(0, 100),
    truncated: hits.length > 100,
  };
}

const DECISION_STATUS_LABELS: Record<string, string> = {
  pending: '待处理',
  approved: '已批准',
  rejected: '已驳回',
  expired: '已超时',
};

function nearestDecision<T extends { createdAt: Date }>(list: T[], at: number): T | undefined {
  let best: T | undefined;
  let bestGap = Infinity;
  for (const d of list) {
    const gap = Math.abs(d.createdAt.getTime() - at);
    if (gap < bestGap) {
      bestGap = gap;
      best = d;
    }
  }
  // More than an hour apart is probably not the same judgment; better to claim no match
  return bestGap <= 3600_000 ? best : undefined;
}

function countBy(values: string[]): { label: string; count: number }[] {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

/** No verdict when the sample is too small — three approvals out of three prove nothing */
const MIN_SAMPLE = 5;

/**
 * ★ Gating rules and pass-through rules have to be judged by completely different
 *   standards.
 *
 *   A gating rule is read through its approval rate: all approved = it is asking a
 *   question whose answer is already known; often rejected = it is catching the right
 *   things. A pass-through rule produces no decisions at all, so "approval rate" says
 *   nothing about it — the only place it can be falsified is whether what it let through
 *   was later corrected by a human. Judging both kinds with one vocabulary guarantees
 *   that half of what gets said is noise.
 */
function verdictOf(input: {
  hits: number;
  resolved: number;
  approved: number;
  gating: number;
  overriddenAfterPass: number;
}): string {
  const { hits, resolved, approved, gating, overriddenAfterPass } = input;

  if (hits === 0) {
    return '近 30 天没有命中。规则可能写错了条件，或者它防的那类操作确实没发生过';
  }

  // Pass-through: it never produced a decision
  if (gating === 0) {
    if (overriddenAfterPass === 0) {
      return `自动放行 ${hits} 次，放行的任务事后没有一次被人工纠正 —— 这条规则在按预期省掉人工确认`;
    }
    return `自动放行 ${hits} 次，其中 ${overriddenAfterPass} 个任务事后被人手动改过 —— 这条规则可能放得太松，值得看看那几次`;
  }

  if (resolved === 0) {
    return `命中 ${hits} 次并要求了人工确认，但还没有一次被处理完 —— 现在看不出它拦得对不对`;
  }
  if (resolved < MIN_SAMPLE) {
    return `只有 ${resolved} 条决策已处理，样本还不够判断这条规则拦得对不对`;
  }
  const rate = approved / resolved;
  if (rate === 1) {
    return `${resolved} 次人工确认全部批准 —— 这条规则每次都在问一个答案已知的问题，可以考虑放开或收窄条件`;
  }
  if (rate >= 0.9) {
    return `${resolved} 次里批准了 ${approved} 次（${Math.round(rate * 100)}%）—— 绝大多数是走流程，值得看看能不能收窄条件`;
  }
  return `${resolved} 次里驳回了 ${resolved - approved} 次 —— 这条规则确实拦下了不该做的事，别动它`;
}
