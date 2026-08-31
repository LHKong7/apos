# 04 Flow Engine

*[中文版本 / Chinese version](04-flow-engine.zh.md)*

Product doc §8.6 says it plainly: "the Flow Engine is responsible for advancing project state, not merely for storing it." That single sentence is what separates this product from a conventional kanban board — a kanban board waits for someone to drag a card; the Flow Engine goes looking for work to do.

---

## 1. Parts

```
┌──────────────────────────────────────────────────────────────┐
│  Flow Engine                                                 │
│                                                              │
│  ① Transition       state transitions (sync, in a txn)       │
│     · machine check · guards · policy · write state + events │
│                                                              │
│  ② Scheduler        active dispatch (worker, 5s + on event)  │
│     · find ready    · deps  · WIP  · dispatch                │
│                                                              │
│  ③ BlockerDetector  blocker detection (worker, every 60s)    │
│     · scans the nine blocker rules                           │
│                                                              │
│  ④ Recovery         recovery strategy (event-driven)         │
│     · retry / swap agent / downgrade / split / human / stop  │
│                                                              │
│  ⑤ Forecast         slip forecasting (worker, every 30 min)  │
│     · critical path + historical cycle time + wait time      │
└──────────────────────────────────────────────────────────────┘
```

① is synchronous and sits on the request path; ②③⑤ are background loops; ④ is event-driven.

---

## 2. State machine

### 2.1 Declarative definition

The state machine is data, not a `switch` buried somewhere in the code. That is what lets the front end reuse it (checking whether a drop target column is legal while a card is being dragged), lets tests enumerate it exhaustively, and lets documentation be generated from it.

```typescript
// packages/domain/src/flow/work-item-machine.ts

export const WORK_ITEM_MACHINE: Machine<WorkItemStatus, WorkItemTrigger> = {
  initial: 'draft',
  stages: {
    intake:    ['draft', 'clarifying', 'awaiting_requirement_approval'],
    planning:  ['planning', 'awaiting_plan_approval'],
    execution: ['ready', 'executing', 'blocked', 'failed'],
    review:    ['reviewing', 'changes_requested', 'awaiting_decision'],
    release:   ['waiting_for_release', 'releasing', 'released'],
    done:      ['acceptance', 'done', 'cancelled'],
  },
  transitions: [
    { from: 'draft',      trigger: 'plan_approved',       to: 'ready' },

    { from: 'ready',      trigger: 'run_dispatched',      to: 'executing',
      guards: ['dependenciesSatisfied', 'wipAvailable', 'executorAssigned'] },

    { from: 'executing',  trigger: 'agent_run_completed', to: 'reviewing',
      guards: ['hasArtifactOrOutput'] },
    { from: 'executing',  trigger: 'agent_run_failed',    to: 'failed' },
    { from: 'executing',  trigger: 'dependency_lost',     to: 'blocked' },
    { from: 'executing',  trigger: 'human_took_over',     to: 'executing',
      effects: ['switchExecutorToHuman'] },

    { from: 'failed',     trigger: 'retry_requested',     to: 'ready' },
    { from: 'failed',     trigger: 'reassigned',          to: 'ready' },
    { from: 'failed',     trigger: 'escalated_to_human',  to: 'executing',
      effects: ['switchExecutorToHuman'] },

    { from: 'blocked',    trigger: 'blocker_cleared',     to: 'ready' },

    { from: 'reviewing',  trigger: 'review_passed',       to: 'waiting_for_release',
      guards: ['acceptanceCriteriaMet', 'qualityGatePassed'] },
    { from: 'reviewing',  trigger: 'review_rejected',     to: 'changes_requested' },
    { from: 'reviewing',  trigger: 'review_conflict',     to: 'awaiting_decision' },
    { from: 'changes_requested', trigger: 'rework_started', to: 'ready' },

    { from: 'waiting_for_release', trigger: 'release_started', to: 'releasing' },
    { from: 'releasing',  trigger: 'release_completed',   to: 'acceptance' },
    { from: 'releasing',  trigger: 'release_failed',      to: 'failed',
      effects: ['createIncident'] },

    { from: 'acceptance', trigger: 'accepted',            to: 'done' },
    { from: 'acceptance', trigger: 'rejected',            to: 'changes_requested' },

    // Waiting on a decision: reachable from many states, and approval returns
    // the item to wherever it came from
    { from: '*',          trigger: 'decision_required',   to: 'awaiting_decision',
      effects: ['rememberPreviousStatus'] },
    { from: 'awaiting_decision', trigger: 'decision_approved', to: '$previous' },
    { from: 'awaiting_decision', trigger: 'decision_rejected', to: 'cancelled' },

    { from: '*',          trigger: 'cancelled',           to: 'cancelled' },
  ],
};
```

**The `$previous` mechanism**: a task can need a human decision at any moment — mid-execution, mid-review, just before release — and once approved it has to return to where it was. `type_data.previous_status` records that. It is far cleaner than defining a dedicated `awaiting_decision_from_X` state for every state that can ask.

### 2.2 Guards

A guard is a pure function: context in, pass/fail plus a failure reason out. The failure reason has to be showable to the user directly (page doc 05 §5.6 requires that dragging a card to an illegal column explains why it was refused).

```typescript
export const GUARDS: Record<string, Guard> = {
  dependenciesSatisfied: (ctx) => {
    const unmet = ctx.dependencies.filter(d => !isDependencyMet(d, ctx));
    return unmet.length === 0
      ? { ok: true }
      : { ok: false, reason: `${unmet.length} 个前置依赖未满足`,
          detail: unmet.map(d => ({ id: d.fromId, title: d.title, type: d.type })) };
  },

  wipAvailable: (ctx) => {
    const limit = ctx.project.wipLimits[ctx.targetStage];
    if (!limit) return { ok: true };
    return ctx.stageCount < limit
      ? { ok: true }
      : { ok: false, reason: `${ctx.targetStage} 阶段已达 WIP 上限 ${limit}` };
  },

  acceptanceCriteriaMet: (ctx) => {
    const unmet = ctx.acceptanceCriteria.filter(c => c.status !== 'passed');
    return unmet.length === 0
      ? { ok: true }
      : { ok: false, reason: `${unmet.length} 项验收标准未通过`,
          detail: unmet, overridable: true, overrideRole: 'tech_lead' };
  },
  // ...
};
```

(The `reason` strings above are the Chinese sentences the domain layer actually produces — "N upstream dependencies unmet", "stage X is at its WIP limit of N", "N acceptance criteria have not passed.")

**`overridable`** marks which guards a human may force past (the "force through" action in page doc 06 §5.4). Forcing through requires a written reason and is recorded in the audit trail.

### 2.3 Deciding whether a dependency is met (§8.6.2, the seven dependency types)

```typescript
function isDependencyMet(dep: Dependency, ctx: Context): boolean {
  switch (dep.type) {
    case 'finish_to_start':
      return ['done', 'released', 'acceptance'].includes(dep.from.status);
    case 'start_to_start':
      return dep.from.actualStart != null;
    case 'artifact':
      return ctx.artifacts.some(a => a.workItemId === dep.fromId && a.kind === dep.artifactKind);
    case 'decision':
      return dep.decision?.status === 'approved';
    case 'permission':
      return ctx.executorPermissions.includes(dep.requiredPermission);
    case 'external':
      return ctx.externalStates[dep.externalRef]?.ready === true;
    case 'data':
      return ctx.dataReadiness[dep.dataRef] === true;
  }
}
```

The `permission` type is the interesting one: it makes "the Agent lacks a permission" a **dependency** rather than a **failure**. The task parks in `blocked` instead of failing over and over, and the blocker points squarely at the permission gap — this is product doc §8.6.4, "insufficient permission."

---

## 3. Transition: the one and only way state changes

```typescript
interface TransitionInput {
  subjectType: 'work_item' | 'requirement' | 'plan' | 'decision' | 'agent_run';
  subjectId: string;
  trigger: string;
  actor: Actor;
  reason?: string;               // required when a human is acting
  overrideGuards?: string[];     // names of guards to force past; requires permission
  correlationId?: string;
  causationId?: bigint;
}

interface TransitionResult {
  ok: boolean;
  from: string;
  to: string;
  policyVerdict?: PolicyVerdict;
  createdDecisionId?: string;
  blockedBy?: GuardFailure[];    // returned on failure so the UI can explain why
  events: DomainEvent[];
}
```

### 3.1 Order of operations

```
1. Take a row lock (SELECT ... FOR UPDATE)
2. Consult the machine: does (from, trigger) → to exist?
      ✗ → return InvalidTransition + the triggers currently available (for UI hints)
3. Evaluate guards
      ✗ and not overridable → return GuardFailed + the detailed reasons
      ✗ but overridable and the actor has the permission → record an override event, continue
4. Build the PolicyContext → policy.evaluate()
      · allow                → continue to the target state
      · allow_and_notify     → continue + queue a notification
      · require_agent_review → move to reviewing, dispatch a Review Agent
      · require_human_review → move to awaiting_decision + create a Decision
      · require_multi_approval → same, but create a co-signed decision
      · pause                → move to blocked, reason = policy
      · deny                 → refuse, return the reason
      · escalate             → create a high-priority Decision for the escalation target
5. Run effects (switch executor, create an Incident, …)
6. UPDATE the state (with the optimistic-lock version number)
7. INSERT events (policy.evaluated + status_changed + whatever else)
8. Commit
9. Publish events after commit → SSE / notifications / Analytics / downstream scheduling checks
```

### 3.2 Concurrency control

Two layers of protection:

| Layer | Mechanism | Guards against |
| --- | --- | --- |
| Pessimistic | `SELECT ... FOR UPDATE` | Concurrent transitions on one Work Item (an Agent callback and a human action arriving together) |
| Optimistic | `WHERE version = $expected` | Lost updates across requests (user A reads, then edits; B changed it in between) |

**Handling an optimistic-lock conflict**: do not retry — return 409 with the latest state attached. Page doc 05 §11 defines the UI behavior: 「张伟刚刚将其移到了 Execution」("Zhang Wei just moved this to Execution").

**Avoiding deadlock**: one transaction locks exactly one Work Item. When several have to change (a bulk action, say), sort by ID and process them one at a time rather than locking multiple rows in a single transaction.

---

## 4. Scheduler: active dispatch

This is the engine behind "the Agent moves things forward." Product doc §8.3.4 defines what dispatch decisions are based on.

### 4.1 Main loop

```typescript
// worker: flow-scheduler — one round every 5s, plus an immediate round
// whenever a relevant event arrives
async function scheduleRound() {
  const candidates = await findSchedulableItems();   // §4.2

  for (const item of candidates) {
    // WIP check (§8.6.3)
    if (!await checkWipLimits(item)) {
      await markQueued(item, 'wip_limit');
      continue;
    }

    // Resolve the executor
    const assignment = item.executorId
      ? { type: item.executorType, id: item.executorId }
      : await resolveExecutor(item);                 // §4.3

    if (!assignment) {
      await markBlocked(item, 'no_matching_executor');
      continue;
    }

    if (assignment.type === 'human') {
      await transition({ subjectId: item.id, trigger: 'assigned_to_human', ... });
      await notify(assignment.id, 'task_assigned', item);
      continue;
    }

    // Agent: dispatch once the budget and concurrency checks pass
    const budgetOk = await checkBudget(item, assignment);
    if (!budgetOk.ok) {
      await createDecision('budget_overrun', item, budgetOk);
      continue;
    }

    await agent.dispatchRun({
      workItemId: item.id,
      agentId: assignment.id,
      idempotencyKey: `${item.id}:${item.attemptCount + 1}`,
    });
  }
}
```

### 4.2 Candidate query

```sql
SELECT wi.* FROM work_items wi
WHERE wi.project_id IN (SELECT id FROM projects WHERE status = 'active')
  AND wi.status = 'ready'
  AND wi.deleted_at IS NULL
  -- every upstream dependency is satisfied
  AND NOT EXISTS (
    SELECT 1 FROM work_item_dependencies d
    JOIN work_items dep ON dep.id = d.from_id
    WHERE d.to_id = wi.id
      AND NOT (
        (d.type = 'finish_to_start' AND dep.status IN ('done','released','acceptance'))
        OR (d.type = 'start_to_start' AND dep.actual_start IS NOT NULL)
        -- the other types get a second pass in the application layer
        -- (they need cross-table conditions: artifacts, decisions, …)
      )
  )
ORDER BY wi.priority ASC, wi.planned_start ASC NULLS LAST
LIMIT 100
FOR UPDATE SKIP LOCKED;      -- ★ multiple worker instances can schedule in parallel without colliding
```

`FOR UPDATE SKIP LOCKED` is what lets several scheduler instances run at once without dispatching the same task twice.

### 4.3 Matching an executor (§8.3.4)

```typescript
function scoreAgent(agent: Agent, item: WorkItem, ctx: Context): Score | null {
  // Hard requirements: fail one and you are out.
  // ★ Note what is NOT here: the agent's own declaration of what work it takes
  //   on. That gate is gone — see "What an agent takes on" below.
  if (!agent.inProject) return null;                          // authorization, not preference
  if (agent.status !== 'active') return null;
  if (!agent.registered) return null;                         // no adapter in this process
  if (ctx.agentLoad[agent.id] >= agent.maxConcurrency) return null;
  if (!hasRequiredPermissions(agent, item)) return null;      // permission scope
  if (agent.costLimitPerRun && item.estimatedCost > agent.costLimitPerRun) return null;

  // Weighted score — every input is a fact observable from actual runs
  const successRate  = agent.stats.successRate ?? 0.7;                   // neutral value when the sample is thin
  const loadFactor   = 1 - ctx.agentLoad[agent.id] / agent.maxConcurrency;
  const contextMatch = ctx.agentContextAffinity[agent.id] ?? 0.5;        // has it worked this module before?
  const costFactor   = 1 - normalize(agent.stats.avgCost, ctx.costRange);

  // The four weights are the old ones renormalized after skill's 0.30 was removed
  const score =
      0.25/0.70 * successRate
    + 0.15/0.70 * contextMatch
    + 0.15/0.70 * loadFactor
    + 0.15/0.70 * costFactor;

  return {
    agentId: agent.id,
    score,
    // ★ The reasoning has to be legible — page doc 04 §5.4 requires the reassign
    //   dropdown to show what each candidate matched on
    reasons: [
      `历史成功率 ${(successRate * 100).toFixed(0)}%（${agent.stats.sampleSize} 次）`,
      `当前负载 ${ctx.agentLoad[agent.id]}/${agent.maxConcurrency}`,
    ],
  };
}
```

(The `reasons` strings are the Chinese UI copy: historical success rate with sample size, and current load.)

**What an agent takes on.** Scoring deliberately has no skill term, and there is no
`applicableTypes` gate. Both were self-declared tags on the agent's profile, and
neither had any causal relationship to what the agent could actually do — an agent
perfectly able to write TypeScript lost to one that had never tried, because a word
was missing from a text box. Worse, `applicableTypes` defaulted to the empty array,
whose meaning is "takes on no work at all": every freshly created agent was silently
unemployable, and nothing in the UI said so.

What an agent takes on is now decided in exactly two places:

- **Ordinary work** — the scheduler picks any agent that clears the hard gates above.
- **Special duties** (planner, reviewer, policy manager) — the project's agent role
  bindings (`project_agent_bindings`) name one explicitly.

`agents.skills` and `agents.applicable_types` still exist as columns, but nothing
reads them. They are scheduled for removal once no historical rows depend on them.

**Tasks that need human judgment**: product doc §8.3.4 lists "does this need human experience" as one basis for assignment. In practice that is marked as `type_data.requires_human` when the Plan is generated, or forced by a Policy rule (e.g. "any task touching production DDL must go to a human").

**The weights are not hard-coded**: they live in project configuration and can be adjusted. The defaults above are starting points and need calibration against real data.

### 4.4 WIP control (§8.6.3)

Five kinds of limit:

```typescript
async function checkWipLimits(item: WorkItem): Promise<WipCheck> {
  const checks = [
    // stage WIP
    { key: 'stage', limit: project.wipLimits[targetStage],
      current: await countByStage(project.id, targetStage) },
    // Agent concurrency
    { key: 'agent', limit: agent.maxConcurrency,
      current: await countRunningRuns(agent.id) },
    // decisions pending on one human
    { key: 'human_decisions', limit: project.wipLimits.humanPendingDecisions,
      current: await countPendingDecisions(assigneeId) },
    // project run cost
    { key: 'project_cost', limit: project.budgetAmount,
      current: project.costSpent },
    // concurrency per task type
    { key: 'type', limit: project.wipLimits[`type:${item.type}`],
      current: await countRunningByType(project.id, item.type) },
  ];
  const violated = checks.filter(c => c.limit != null && c.current >= c.limit);
  return { ok: violated.length === 0, violated };
}
```

**A full WIP limit does not evict anything**: page doc 05 §11 defines the behavior — raise a decision, 「WIP 已满，是否提升上限或暂停低优先级任务」("WIP is full — raise the limit, or pause the low-priority tasks?"), rather than silently kicking out lower-priority work. Automatic eviction costs the user their ability to predict what the system will do.

---

## 5. BlockerDetector (§8.6.4)

Nine kinds of blocker, scanned once every 60 seconds:

| # | Blocker type | Criterion | How it is detected |
| --- | --- | --- | --- |
| 1 | Task overdue | `now > planned_end + grace` and not finished | SQL |
| 2 | Dependency unmet | Sitting in `ready` past a threshold with a dependency still unmet | SQL + application layer |
| 3 | Agent failing repeatedly | N consecutive failed Runs on the same Work Item | SQL |
| 4 | Decision waiting too long | `decision.created_at < now - threshold` | SQL |
| 5 | External service down | An integration health check fails and some task depends on it | Health-check table |
| 6 | Over cost limit | `project.cost_spent >= budget`, or a Run over its per-run cap | SQL |
| 7 | Insufficient permission | The Agent lacks a permission the task needs (already covered by dependency evaluation) | Pre-dispatch check |
| 8 | Conflicting Agent results | Review conclusions disagree and nobody has adjudicated | Application layer |
| 9 | No events for a long time | The Work Item's last event is older than the threshold while the status is in-flight | SQL |

```sql
-- Type 9: no events for a long time (the surest way to catch "the Agent quietly got stuck")
SELECT wi.id, wi.title, wi.status, MAX(e.occurred_at) AS last_event
FROM work_items wi
LEFT JOIN events e ON e.subject_type='work_item' AND e.subject_id=wi.id
WHERE wi.status IN ('executing','reviewing','releasing')
  AND wi.deleted_at IS NULL
GROUP BY wi.id
HAVING MAX(e.occurred_at) < now() - interval '30 minutes'
    OR MAX(e.occurred_at) IS NULL;
```

Once a blocker is detected: write `blocked_since` / `blocked_reason` / `blocked_detail`, emit `work_item.blocked`, and hand it to Recovery to decide what happens next.

**Thresholds are configurable**, and they differ by blocker type (4h for a waiting decision vs. 30min for no events at all).

### 5.x Check whether anything changed before you write

Every round, the scheduler re-derives the same conclusion about the same work item (this Agent still has not been added to the project). **Writing unconditionally costs you in two places**:

1. The event table fills with dozens of identical `work_item.blocked` rows that bury the real state changes — the Timeline degrades from "what happened" into a log file;
2. `blocked_since` gets refreshed every round, so the card's 「已阻塞 8h12m」("blocked for 8h12m") is permanently 「0m」— and that field exists precisely to tell you how long something has been stuck.

So `markBlocked()` writes to the database and emits an event only on **the first block, or when the reason changes**; equality is decided by `sameBlockedDetail()` (defined in the same file as the reason codes, so changing a code drags the comparison along with it). The comparison sorts by `agentId` first: candidate ordering comes from the query plan and is not part of the meaning.

### 5.y A rejection reason is a **code**, not a sentence

Every rejection out of `matchExecutors()` carries a `code` (why this candidate was eliminated), a `scope` (which layer that restriction is configured at), and `params` (interpolation values), defined in `packages/contracts/src/work-item/blocked.ts`. The Chinese sentence stays in `reason`, serving only logs and existing rows.

`scope` exists for exactly one reason: to kill a class of self-contradictory display. The Agent's profile page says "write_file allowed" while the board says "missing write_file" — both are true, one is the organization-level ceiling and the other is the project-level grant. Without the layer labeled, what the user sees is the system contradicting itself, and then they go fix the wrong thing.

`FIX_FOR_CODE` is the **single** map from reason code to remediation entry point. When each part of the UI guesses its own, the same reason lands the user in two different places on two different pages.

---

## 6. Recovery (§8.6.5)

After a block or a failure, Policy decides the recovery action. **This is where the product's "autonomous recovery" claim actually lands.**

```typescript
const RECOVERY_ACTIONS = {
  retry:            (ctx) => transition(ctx.item, 'retry_requested'),
  switch_agent:     (ctx) => reassign(ctx.item, pickAlternativeAgent(ctx)),
  downgrade_model:  (ctx) => retryWith(ctx.item, { model: cheaperModel(ctx.agent.model) }),
  add_reviewer:     (ctx) => attachReviewAgent(ctx.item),
  split_task:       (ctx) => requestPlanAgentToSplit(ctx.item),
  rollback_step:    (ctx) => transition(ctx.item, 'rework_started'),
  request_decision: (ctx) => createDecision('agent_failure', ctx.item, ctx),
  transfer_to_human:(ctx) => transition(ctx.item, 'escalated_to_human'),
  terminate:        (ctx) => transition(ctx.item, 'cancelled'),
};
```

### 6.1 Default recovery strategy

The fallback when no Policy says otherwise (project Policy can override it):

```
Agent Run failed
├─ error_class = context_insufficient
│    1st time → retry (automatically fold the relevant knowledge and the last
│                      failure into the context)
│    2nd time → request_decision (ask a human to supply the missing context)
├─ error_class = capability_mismatch
│    immediately → switch_agent; no candidate → transfer_to_human
├─ error_class = tool_failure / external_unavailable
│    retry ×3 with exponential backoff → still failing → request_decision
├─ error_class = timeout
│    1st time → split_task (have the Project Agent break it down)
│    2nd time → transfer_to_human
├─ error_class = permission_denied
│    no retry → request_decision (the decision: widen the Agent's permissions or not)
├─ error_class = budget_exceeded
│    no retry → request_decision (decision owner = Sponsor)
└─ 3 or more consecutive failures (any cause)
     → pause + escalate to the tech lead (spelled out in product doc §8.9.3)
```

**The key design point**: different error classes must recover differently. Blindly retrying three times is the worst possible implementation — `permission_denied` will not succeed on the hundredth attempt either, it will just burn money. All of this depends on the Agent Protocol delivering trustworthy error classification ([06](06-agent-protocol.md) §6).

### 6.2 Cost guardrail on recovery

Every recovery action checks cumulative cost first:

```typescript
if (item.actualCost + estimatedRetryCost > item.estimatedCost * 3) {
  // Already spent 3× the estimate — stop retrying automatically
  return createDecision('cost_overrun_on_retry', item);
}
```

---

## 7. Forecast: predicting slip (§8.6.6)

Page doc 02 §5.2 requires the forecast to be explainable — the user has to see how much each of the seven inputs contributed, or they will not trust the number.

### 7.1 Method

The MVP uses no machine learning; it uses an explainable additive model:

```typescript
function forecast(project: Project): Forecast {
  const cp = criticalPath(project);              // the critical-path task sequence
  const remaining = cp.filter(t => !isDone(t));

  let expectedDays = 0;
  const factors: Factor[] = [];

  for (const task of remaining) {
    // Baseline: the planned duration
    let taskDays = task.estimatedHours / WORK_HOURS_PER_DAY;

    // Factor 1: historical cycle-time correction (actual/planned ratio for this task type)
    const cycleRatio = history.cycleTimeRatio(project, task.type) ?? 1.0;
    taskDays *= cycleRatio;

    // Factor 2: Agent success-rate correction (failures mean re-runs)
    if (task.executorType === 'agent') {
      const sr = agentStats(task.executorId).successRate ?? 0.85;
      taskDays *= (1 / sr);                      // 80% success rate → expect 1.25 attempts
    }

    // Factor 3: decision wait (does this task contain a human gate?)
    if (task.hasHumanGate) {
      const avgWait = history.avgDecisionWaitHours(project, task.decisionType);
      taskDays += avgWait / 24;
    }

    expectedDays += taskDays;
  }

  // Factor 4: the immediate impact of current blockers
  const blockedImpact = currentBlockers(cp)
    .reduce((sum, b) => sum + hoursSince(b.blockedSince) / 24, 0);
  expectedDays += blockedImpact;

  const drift = expectedDays - daysUntil(project.endsAt);

  return {
    probability: sigmoid(drift / SCALE),         // probability of slipping
    driftDays: drift,
    // ★ Attribution: ranked by contribution, rendered straight onto the page
    factors: rankFactors([
      { name: '决策等待时间', contribution: decisionWaitDays, ... },
      { name: 'Agent 重试损耗', contribution: retryDays, ... },
      { name: '当前阻塞', contribution: blockedImpact, ... },
      { name: '历史工期偏差', contribution: cycleDriftDays, ... },
    ]),
    primaryCause: topFactor.name,                // "主因：决策等待 8h12m"
  };
}
```

(The four factor names are the Chinese UI strings: decision wait time, Agent retry overhead, current blockers, and historical duration drift. `primaryCause` renders as "primary cause: decision wait, 8h12m.")

### 7.2 No forecast when the sample is too thin

Page doc 02 §11 is explicit: when the project is under 3 days old or has fewer than 5 completed tasks, show 「样本不足，暂不预测」("not enough data — no forecast yet") instead of a low-confidence number.

**Why**: a wrong forecast is worse than no forecast — users act on it, and then they stop trusting the system.

### 7.3 Computing the critical path

Standard CPM (critical path method) run over the dependency graph:

```
1. Topological sort
2. Forward pass for earliest start/finish (ES/EF)
3. Backward pass for latest start/finish (LS/LF)
4. Float = LS - ES; the tasks with zero float form the critical path
```

O(V+E), which finishes in milliseconds for a 200-node project. The result is cached in `plans.critical_path` and invalidated for recomputation whenever dependencies or durations change.

**Several equally long critical paths**: mark all of them (page doc 07 §11 already defines the UI treatment).

---

## 8. The boundary with the Policy Engine

The two are easy to confuse, so here is the division of labor:

| | Flow Engine | Policy Engine |
| --- | --- | --- |
| Answers | **Can** we go from A to B (structural legality) | **Should** this happen automatically (governance judgment) |
| Based on | State machine, dependencies, WIP | Risk, cost, environment, quality |
| Result | Allow / refuse + reason | allow / require_review / deny / … |
| Configurability | The machine is defined by the product; enterprises can configure stages | Enterprises and projects configure rules freely |

**Direction of calls**: Flow calls Policy, never the reverse. Policy is a pure function (context in, verdict out) with no awareness that a state machine exists — which is what makes it independently testable and replayable in simulation.

---

## 9. Testing strategy

The state machine and the scheduling logic are the heart of the system; the testing bar is higher here than elsewhere.

| Level | What | Tooling |
| --- | --- | --- |
| Unit | State machine, exhaustively: the expected result for every (from, trigger) pair | Vitest, table-driven |
| Unit | Guards as pure functions | Vitest |
| Unit | All seven dependency-satisfaction types | Vitest |
| Unit | CPM critical path (multiple paths, cycle detection) | Vitest |
| Integration | Transition atomicity: state and event are written together or not at all | Testcontainers + real PG |
| Integration | Concurrent transitions: two requests changing one Work Item at once | Concurrency test |
| Integration | Scheduler `SKIP LOCKED`: multiple instances never double-dispatch | Multi-process test |
| Scenario | The full chain: requirement → plan → dispatch → failure → recovery → done | Integration test + mock Agent |

**Invariant assertions** (checked globally in the integration tests):

```typescript
// Any state change must have a matching event
assert(eventsFor(workItem).some(e => e.type === 'work_item.status_changed'
  && e.payload.to === workItem.status));

// A task in blocked must have a blocked_reason
assert(workItem.status !== 'blocked' || workItem.blockedReason != null);

// A task in awaiting_decision must have an unresolved decision
assert(workItem.status !== 'awaiting_decision'
  || pendingDecisions(workItem).length > 0);
```

---

## 10. Open questions

1. **The initial scheduling weights need calibration against real data.** Today's 0.30/0.25/0.15/0.15/0.15 are guesses. The suggestion is to collect 2–4 weeks of data after the MVP ships and run one regression calibration, using "assignments that actually succeeded and were cheap" as the label.
2. **How `$previous` should behave when nesting**: a task goes from executing into awaiting_decision, and during that decision a second decision is raised — where should it return to? A stack rather than a single value is the right answer, but it adds complexity. The MVP can restrict things to "only one open decision at a time."
3. **Scheduler fairness**: today it sorts by priority + planned_start, which can starve low-priority tasks indefinitely. Should waiting time be weighted in? Probably yes, but the MVP can watch first.
4. **Scheduling human tasks**: right now this is only "assign + notify," with no real scheduling semantics (people do not start work just because the system dispatched it). What moves a human task into `executing` — a manual mark, or an external signal such as a commit? Leaning toward supporting both.
5. **The forecast's factor weights and sigmoid parameters** need calibration. The MVP can emit only `driftDays` and the attribution, without a probability — a wrong probability is worse than none.
6. **`split_task` in the recovery strategy** has to call the Project Agent to replan, which is an LLM call with real cost and latency. Should the trigger rate for automatic splitting be capped?
