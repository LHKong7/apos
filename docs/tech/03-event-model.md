# 03 Event Model

*[中文版本 / Chinese version](03-event-model.zh.md)*

Product spec §6.9 defines the Event as "the foundation that makes a project traceable, replayable, and auditable," and §3.2 requires the system to answer *who did what, why they did it, and what context they had*. This document defines how that gets implemented.

---

## 1. Positioning: this is not Event Sourcing

**We explicitly do not do full event sourcing.** Domain tables hold current state, the event table holds the facts of change, and both are written in the same transaction.

| Approach | Why not |
| --- | --- |
| Full Event Sourcing (state derived by replaying events) | The board, the dependency graph, and Analytics all need non-trivial queries; building and maintaining a projection layer costs far more than it returns. And every time the state machine evolves, keeping old events compatible becomes a permanent tax |
| State tables + an audit log | Audit logs are typically bolted on afterward and incomplete, which is not enough to support the causal tracing and Policy simulation the product requires |
| **State tables + mandatory events (this design)** | Queries stay simple and the event record stays complete. The price is the discipline of "you cannot change state without writing an event" |

**How the discipline is enforced**: the only entry point permitted to change the state of a domain object is `flow.transition()`, which writes state and event inside one transaction. Code review plus an integration-test assertion (every state change must have a corresponding event) keeps the rule honest.

---

## 2. Event layers

There are two kinds of events in the system. They serve different purposes and **must not be conflated**:

| | Domain events `events` | Run events `run_events` |
| --- | --- | --- |
| Meaning | Business facts: state changed, decision made, artifact produced | Execution detail: which tool was called, what was reasoned |
| Volume | Tens per Work Item | Hundreds to thousands per Run |
| Writer | Flow Engine (sole writer) | Agent adapters |
| Consumers | Audit, Analytics, notifications, Flow, Policy simulation | The Run detail page timeline |
| Retention | Forever (archived) | 30 days hot + archive |
| Partitioning | Monthly | Monthly |

**Promotion rule**: a small number of significant `run_events` are promoted to domain events.

```
run_events.type                  → events.type
──────────────────────────────────────────────────────────────
run_started                      → agent_run.started
artifact                         → artifact.produced
run_ended (completed)            → agent_run.completed  → triggers flow.transition
run_ended (failed)               → agent_run.failed     → triggers flow.transition
human_intervention               → run.intervened
policy_check (human required)    → decision.created
all others (tool_call/reasoning) → not promoted
```

What the split buys us: Analytics aggregation and audit queries only ever scan the `events` table, which is two orders of magnitude smaller.

---

## 3. Event structure

```typescript
// packages/contracts/src/events/domain-event.ts

interface DomainEvent {
  id: bigint;                    // Globally monotonic (used as the SSE Last-Event-ID)
  orgId: string;
  projectId: string | null;

  type: DomainEventType;         // see the catalog in §7
  level: 'milestone' | 'detail';

  // who did it
  actorType: ActorType;          // human | agent | service | external | system
  actorId: string | null;

  // what it was done to
  subjectType: SubjectType;      // work_item | requirement | plan | decision |
                                 // agent_run | project | policy | artifact | integration
  subjectId: string;

  payload: Record<string, unknown>;

  // why it happened — the causation chain
  causationId: bigint | null;    // the event that directly triggered this one
  correlationId: string;         // shared by every event in the same business flow

  // context snapshot required to replay a Policy simulation (see §4)
  contextSnapshot: PolicyContext | null;

  occurredAt: Date;
}
```

### 3.1 The causation chain

This is the mechanism that answers "why did this happen." Example — a Policy match produces a decision, and the task resumes once a human approves it:

```
#1001  agent_run.completed        actor=agent:code-1     subject=run:1284
   │   causation=null  correlation=c-7f3a
   ▼
#1002  work_item.transition_attempted   actor=system     subject=work_item:88
   │   causation=1001  correlation=c-7f3a
   │   payload: { from: 'executing', to: 'reviewing' }
   ▼
#1003  policy.evaluated            actor=system          subject=work_item:88
   │   causation=1002  correlation=c-7f3a
   │   payload: { matched: 'policy-7', action: 'require_human_review', trace: [...] }
   │   contextSnapshot: { risk:'high', env:'production', cost:8.2, tests:'passed', ... }
   ▼
#1004  decision.created            actor=system          subject=decision:52
   │   causation=1003  correlation=c-7f3a
   ▼
#1005  work_item.status_changed    actor=system          subject=work_item:88
   │   causation=1003  correlation=c-7f3a
   │   payload: { from:'executing', to:'awaiting_decision' }
   ▼   …… (the human approves, two hours later)
#1090  decision.approved           actor=human:wangqiang subject=decision:52
   │   causation=null (human-initiated, no preceding event)  correlation=c-7f3a
   │   payload: { option:'A', constraints:[{type:'time_window',value:'02:00-05:00'}] }
   ▼
#1091  work_item.status_changed    actor=system          subject=work_item:88
       causation=1090  correlation=c-7f3a
       payload: { from:'awaiting_decision', to:'reviewing' }
```

**Questions this can answer**:

- "Why did this task sit idle for two hours?" → walk back up the causation chain to the Policy verdict at #1003
- "Who approved it, and what conditions did they attach?" → #1090
- "What happened across the whole episode?" → query by `correlation_id`

The `correlation_id` is generated at the start of a business flow (a user action, a scheduler dispatch, an incoming webhook) and passed down the call chain.

### 3.2 payload conventions

- State changes: must carry `{ from, to }`
- Manual actions: must carry `{ reason }` (product spec §8.4.4 requires a recorded reason for every human override)
- External sync: must carry `{ origin: 'sync:{integration_id}' }` (to prevent sync loops)
- Cost-related: must carry `{ cost_delta, cost_total }`

Payloads do not hold large objects. Artifacts, reports, and the like live in the `artifacts` table; the event stores only a reference.

---

## 4. Context snapshots: the precondition for Policy simulation

Page spec 13 requires "validating a rule against historical data" — take a draft rule, run it over the last 30 days of data, and see how many times it would have acted automatically and how often that would have disagreed with the human judgment at the time.

**Whether that feature is possible at all comes down to whether the events stored enough context.** It cannot be reconstructed after the fact.

### 4.1 Snapshot contents

Record a `context_snapshot` on **every event that can trigger a Policy evaluation**. Its fields map one-to-one onto the fact list defined in [05 Policy Engine](05-policy-engine.md):

```typescript
interface PolicyContext {
  // object attributes
  projectType: string;
  workItemType: WorkItemType;
  riskLevel: RiskLevel;
  reversible: boolean;
  externalFacing: boolean;

  // environment and data
  environment: 'dev' | 'test' | 'staging' | 'production' | null;
  dataSensitivity: 'public' | 'internal' | 'confidential' | 'restricted' | null;
  impactScope: { tasks: number; services: string[] };

  // Agent
  agentType: string | null;
  agentConfidence: number | null;
  agentSuccessRate: number | null;
  consecutiveFailures: number;

  // cost
  runCost: number;
  projectCostSpent: number;
  projectBudget: number | null;

  // quality
  testsResult: 'passed' | 'failed' | 'not_run';
  testCoverage: number | null;
  securityScan: 'passed' | 'failed' | 'not_run';
  agentReview: 'passed' | 'concerns' | 'failed' | 'not_run';

  // operation
  operationType: string;   // db_ddl | deploy | delete_resource | send_external | ...
}
```

### 4.2 Storage trade-off

Storing a snapshot on everything would bloat the event table. The policy:

| Event type | Snapshot |
| --- | --- |
| Anything that triggers a Policy evaluation (state transitions, Run dispatch, releases) | Full snapshot |
| Decision created / resolved | Full snapshot (the baseline a simulation compares against) |
| Everything else | None |

Estimate: a full snapshot is roughly 800 bytes of JSON, and Policy-triggering events are about 20% of total volume. See the capacity estimate in §6.

### 4.3 Limits of simulation

Users have to be told this plainly: a simulation runs against **the snapshot recorded at the time**. If a new rule references a fact that was not being recorded back then, that rule cannot be simulated reliably.

**Implementation constraint**: the Policy condition editor only offers facts already defined in `PolicyContext`. When a new fact is added, simulation coverage for it begins on the day it ships, and the page must say so explicitly: "this condition has data from 2026-08-06 onward."

---

## 5. Write path

### 5.1 Write inside the transaction, publish outside it

```typescript
async function transition(input: TransitionInput): Promise<TransitionResult> {
  const outbox: DomainEvent[] = [];

  const result = await db.transaction(async (tx) => {
    // 1. Row lock, to serialize concurrent transitions
    const item = await tx.selectForUpdate(workItems, input.subjectId);

    // 2. State-machine check + guards
    const target = resolveTransition(item.status, input.trigger);
    if (!target) throw new InvalidTransition(item.status, input.trigger);

    // 3. Policy evaluation — inside the transaction, since the verdict decides where we go
    const ctx = await buildPolicyContext(tx, item, input);
    const verdict = policy.evaluate(ctx);

    // 4. Act on the verdict
    const finalStatus = verdict.requiresHuman ? 'awaiting_decision' : target;
    if (verdict.requiresHuman) {
      const decision = await createDecision(tx, item, verdict, ctx);
      outbox.push(event('decision.created', decision, { causation: ... }));
    }

    // 5. Write the state
    await tx.update(workItems).set({ status: finalStatus, version: item.version + 1 })
      .where(and(eq(workItems.id, item.id), eq(workItems.version, item.version)));

    // 6. Write the events, in the same transaction
    outbox.push(
      event('policy.evaluated', item, { payload: verdict, contextSnapshot: ctx }),
      event('work_item.status_changed', item, {
        payload: { from: item.status, to: finalStatus },
      }),
    );
    await tx.insert(events).values(outbox);

    return { finalStatus, verdict };
  });

  // 7. ★ Publish only after the commit — subscribers never see uncommitted state
  for (const e of outbox) await bus.publish(e);

  return result;
}
```

**Why publishing must wait for the commit**: publish inside the transaction and SSE may tell the browser "this moved to Review" — and then the transaction rolls back, leaving the front end permanently wrong.

**What if publishing fails**: use a transactional outbox — the events are already durable, so a background worker scans for unpublished ones and re-sends them. Add a `published_at` column to the event table (or a separate outbox table). For the MVP, "publish synchronously after commit, retry on failure" is enough; bring in the outbox worker once volume demands it.

### 5.2 Events are immutable

The `events` table only accepts INSERT. Enforce it at the database level: the role the application connects with has no UPDATE or DELETE privilege.

```sql
REVOKE UPDATE, DELETE ON events FROM apos_app;
```

When history needs "correcting," write a new compensating event rather than editing the old one.

---

## 6. Capacity and partitioning

### 6.1 Estimate (MVP scale)

Assume 50 active projects, each with 20 Work Item state transitions and 5 Agent Runs per day, and an average of 200 run_events per Run.

| Table | Per day | Per month | Row size | Monthly volume |
| --- | --- | --- | --- | --- |
| `events` | 50 × 60 = 3,000 | 90,000 | ~1.2 KB (with snapshot) | ~110 MB |
| `run_events` | 50 × 5 × 200 = 50,000 | 1,500,000 | ~0.6 KB | ~900 MB |

Conclusion: **PostgreSQL handles this comfortably; no Kafka needed**. Revisit at 10× the scale (around 500 projects).

### 6.2 Partitioning strategy

```sql
-- Monthly RANGE partitions
CREATE TABLE events (...) PARTITION BY RANGE (occurred_at);

CREATE TABLE events_2026_08 PARTITION OF events
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- Create next month's partition automatically, via pg_partman or a scheduled job
```

**Hot/cold split**:

| Data | Location | Access |
| --- | --- | --- |
| `events`, last 12 months | PostgreSQL | Queried directly |
| `events`, older than 12 months | S3 (Parquet) | Loaded on demand; the page shows "loading from archive" |
| `run_events`, last 30 days | PostgreSQL | Queried directly |
| `run_events`, older than 30 days | S3 (one JSONL file per Run) | Pulled on demand by the Run detail page |

Archived `run_events` are packed one file per Run, because the query pattern is always "show me everything from this one Run" — there is no need to search across Runs.

**What archiving forecloses**: an archived Run cannot be retried (as page spec 09 §11 already states).

---

## 7. Event type catalog

Naming convention: `{subject}.{past_tense_verb}`. An event is a fact that has already happened, so the verb is past tense.

### 7.1 Project

| Type | level | payload highlights |
| --- | --- | --- |
| `project.created` | milestone | type, autonomy_level, budget |
| `project.autonomy_changed` | milestone | from, to, reason |
| `project.paused` / `project.resumed` | milestone | reason |
| `project.budget_threshold_reached` | milestone | threshold_pct, spent, budget |
| `project.completed` | milestone | — |

### 7.2 Requirement

| Type | level | payload highlights |
| --- | --- | --- |
| `requirement.created` | milestone | input_method, source_ref |
| `requirement.analyzed` | milestone | completeness, question_count, cost |
| `requirement.clarification_answered` | detail | question_id, level, used_suggestion |
| `requirement.field_edited` | detail | field, by_human |
| `requirement.approved` | milestone | approver, completeness_at_approval |
| `requirement.rejected` | milestone | reason |
| `requirement.assumption_invalidated` | milestone | assumption_id, reason |

### 7.3 Plan

| Type | level | payload highlights |
| --- | --- | --- |
| `plan.generated` | milestone | version, task_count, cost_estimate, duration_ms |
| `plan.item_modified` | detail | item_id, field, from, to (manual plan edits) |
| `plan.approved` | milestone | approvers[], acknowledged_overrun |
| `plan.revision_requested` | milestone | feedback |
| `plan.superseded` | milestone | by_version |

### 7.4 Work Item

| Type | level | payload highlights |
| --- | --- | --- |
| `work_item.created` | milestone | type, parent_id, executor |
| `work_item.status_changed` | milestone | from, to, reason?, origin? |
| `work_item.assigned` | milestone | executor_type, executor_id, match_reasons |
| `work_item.blocked` | milestone | reason, blocking_ref |
| `work_item.unblocked` | milestone | blocked_duration_s |
| `work_item.taken_over` | milestone | **reason (required)**, agent_handling |
| `work_item.handed_back` | milestone | handover_note |
| `work_item.acceptance_updated` | detail | criterion_id, passed, verification |
| `work_item.force_passed` | milestone | **reason (required)**, criteria[] |
| `work_item.dependency_added` / `removed` | detail | from, to, type |
| `work_item.split` | milestone | into[] |
| `work_item.merged` | milestone | into |

### 7.5 Agent Run

| Type | level | payload highlights |
| --- | --- | --- |
| `agent_run.dispatched` | milestone | agent_id, idempotency_key, context_size |
| `agent_run.started` | milestone | model, tools[] |
| `agent_run.completed` | milestone | cost, tokens, duration_s, artifacts[] |
| `agent_run.failed` | milestone | error_class, error_message, attempt |
| `agent_run.timeout` | milestone | timeout_s |
| `agent_run.terminated` | milestone | by_actor, reason |
| `agent_run.heartbeat_lost` | milestone | last_heartbeat_at |
| `agent_run.constraint_added` | milestone | constraint, by_actor |
| `agent_run.cost_threshold_reached` | milestone | pct, cost, limit |

### 7.6 Decision

| Type | level | payload highlights |
| --- | --- | --- |
| `decision.created` | milestone | type, risk, assignee, due_at, policy_id |
| `decision.approved` | milestone | option_id, constraints[], resolution_time_s |
| `decision.rejected` | milestone | reason |
| `decision.revision_requested` | milestone | feedback |
| `decision.delegated` | milestone | from, to, note |
| `decision.escalated` | milestone | level, to, wait_duration_s |
| `decision.reminded` | detail | to |
| `decision.expired` | milestone | wait_duration_s |
| `decision.outcome_recorded` | milestone | outcome, note |

### 7.7 Policy

| Type | level | payload highlights |
| --- | --- | --- |
| `policy.evaluated` | detail | matched_policy, action, trace[] + **contextSnapshot** |
| `policy.created` / `updated` | milestone | direction, simulation_id, diff |
| `policy.disabled` | milestone | **reason (required)** |

### 7.8 Artifact / Integration

| Type | level | payload highlights |
| --- | --- | --- |
| `artifact.produced` | milestone | kind, ref, metadata |
| `integration.connected` / `disconnected` | milestone | provider, scopes |
| `integration.synced` | detail | direction, entity_count, **origin** |
| `integration.conflict_detected` | milestone | field, local, remote |
| `integration.conflict_resolved` | milestone | winner, apply_to_similar |
| `integration.error` | milestone | provider, error |

---

## 8. Consumers

```
event written
   │
   ├──▶ SSE fan-out       Live updates to browsers (channel mapping per §4.3)
   ├──▶ Flow Engine       Some events trigger downstream state checks
   │                      (e.g. a dependency completes → check the tasks behind it)
   ├──▶ Notification      Routed by the notification types in product spec §11
   ├──▶ Analytics         Incremental updates to pre-aggregated tables
   ├──▶ Audit             Highly sensitive events also written to immutable audit storage
   └──▶ Knowledge (P1)    Extract reusable experience from the event stream
```

**Subscribers must be idempotent**: the same event may be delivered more than once (retries, outbox re-sends). Either keep a `(consumer, event_id)` processed table, or make the handler naturally idempotent.

**A failing subscriber does not break the main flow**: the event is already durable, so a consumption failure only degrades derived features (a notification never went out, an aggregate lags) — business state stays correct. That is the direct payoff of writing events inside the transaction and consuming them outside it.

---

## 9. Query patterns

| Scenario | Query |
| --- | --- |
| Work Item timeline | `WHERE subject_type='work_item' AND subject_id=? ORDER BY occurred_at` |
| Recent project activity (milestone level by default) | `WHERE project_id=? AND level='milestone' ORDER BY id DESC LIMIT 20` |
| Trace why some change happened | Recursive CTE walking up `causation_id` |
| One complete business flow | `WHERE correlation_id=? ORDER BY id` |
| Policy simulation data source | `WHERE type='policy.evaluated' AND occurred_at > ? AND context_snapshot IS NOT NULL` |
| Audit: everything one person did | `WHERE actor_type='human' AND actor_id=? ORDER BY occurred_at DESC` |
| Audit: everything one Agent did | `WHERE actor_type='agent' AND actor_id=?` |

Recursive trace example:

```sql
WITH RECURSIVE chain AS (
  SELECT * FROM events WHERE id = $target
  UNION ALL
  SELECT e.* FROM events e JOIN chain c ON e.id = c.causation_id
)
SELECT * FROM chain ORDER BY id;
```

---

## 10. Open questions

1. **The field set of `context_snapshot`** should be locked against the fact list in [05](05-policy-engine.md) before implementation. Once it ships, a newly added fact only applies to data from that day forward, so **the first version should record every fact we might plausibly need** — err on the side of storing too much.
2. **Outbox now or later?** "Publish synchronously after commit" loses events in the narrow window where the process crashes (business state stays correct, but the SSE update or notification is gone). The recommendation is to accept that risk for the MVP, backstopped by periodic full refreshes on the client, and add the outbox in P1.
3. **Does audit storage need to live outside the business database?** Strict compliance regimes may require audit logs in WORM storage. For the MVP, PostgreSQL privilege restrictions plus periodic archival to S3 (with object lock enabled) should be sufficient — to be confirmed with compliance.
4. **Event schema evolution**: how do we stay compatible with old events when the payload structure changes? The suggestion is a `schema_version` field on events, with version adaptation on the read side. The MVP can skip it, but should reserve the slot.
5. **Generating `seq` for `run_events`**: how do we guarantee monotonicity across processes? The current thinking is that the Agent adapter increments it within a single Run (a Run is only ever handled by one adapter instance). We need to confirm that seq values do not collide after an orphaned Run is taken over.
