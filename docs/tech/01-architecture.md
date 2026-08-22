# 01 System Architecture

*[中文版本 / Chinese version](01-architecture.zh.md)*

## 1. Architecture goals

Four properties fall out of the product positioning; all four are non-negotiable:

| Property | Product source | Technical implication |
| --- | --- | --- |
| **Traceable** | 3.2 Every action is traceable | Every state change writes an immutable event; the causal chain stays complete |
| **Governable** | 8.9 Policy Engine, §10 Permissions and security | Policy sits on the critical path; agents carry their own identity; the audit trail cannot be bypassed |
| **Always advancing** | 8.6 Flow Engine, "advance state, don't merely store it" | An active scheduling loop drives the work; nothing waits on a user click |
| **Recoverable** | 8.6.5 Flow Recovery | Agent Run state lives in the database, not in memory; orphaned runs get reclaimed after a process restart |

The fourth one is routinely underestimated: an Agent Run can take 30 minutes, and a deploy or a process restart inside that window is normal, not exceptional. **If run state lives in process memory, the product is unusable.**

---

## 2. Layering

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Ingress layer  Fastify                                                       │
│  · Authentication (JWT / session)   · Pre-flight authorization checks        │
│  · SSE connections and fan-out   · Rate limiting   · Idempotency keys        │
│  · Request validation (Zod)                                                  │
├──────────────────────────────────────────────────────────────────────────────┤
│ Application layer  Modules                                                   │
│  Every module exports use cases; modules reach each other only through those │
│  ❌ No module may query another module's tables directly                     │
├──────────────────────────────────────────────────────────────────────────────┤
│ Domain layer  Domain                                                         │
│  Entities, value objects, state machine definitions, policy rule evaluation, │
│  invariants. Mostly pure functions, no IO — unit-testable without a database │
├──────────────────────────────────────────────────────────────────────────────┤
│ Infrastructure layer  Infrastructure                                         │
│  Repositories (Drizzle) · event bus · queues · LLM clients                   │
│  Agent runtime adapters · external system clients · object storage           │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Module breakdown

| Module | Responsibility | Key exports |
| --- | --- | --- |
| `identity` | One identity model for users, agents, and services; permission decisions | `can(actor, action, resource)` |
| `project` | Project lifecycle, membership, autonomy level | `getProjectContext()` |
| `requirement` | Requirement intake, AI structuring, clarification, confirmation | `analyzeRequirement()` `approveRequirement()` |
| `plan` | Plan generation, versions, task breakdown, dependency graph | `generatePlan()` `approvePlan()` |
| `work` | Work Item CRUD, dependencies, artifacts | `getWorkItem()` `updateWorkItem()` |
| `flow` | **State machine, scheduling, blocker detection, recovery** | `transition()` `schedule()` |
| `policy` | Rule evaluation, simulation, inheritance and conflict detection | `evaluate(context)` `simulate(draft, range)` |
| `decision` | Decision creation, owner resolution, co-signing, deadlines and escalation | `createDecision()` `resolveDecision()` |
| `agent` | Agent registration, capabilities and permissions, Run lifecycle | `dispatchRun()` `handleRunEvent()` |
| `integration` | External system connections, sync, conflicts | `sync()` `handleWebhook()` |
| `analytics` | Event aggregation, metric computation, insight generation | `getFlowMetrics()` |
| `notification` | Notification routing, escalation, deduplication | `notify(event)` |
| `event` | Event writes, queries, archival | `emit()` `query()` |

**How the boundaries are enforced**: one directory per module, with `index.ts` as its only door; an ESLint rule forbids any `import` that reaches into another module's internals. This rule is what decides whether pulling a service out later is cheap or expensive.

### 2.2 One state transition, end to end

Take "agent finishes executing → work item enters review" and follow it down through every layer:

```
Agent runtime
  │ POST /api/agent-callback/runs/{id}/events  { type: 'completed', artifacts: [...] }
  ▼
Ingress: verify agent credentials → validate payload
  ▼
agent.handleRunEvent()
  ├─ write run_events (raw, immutable)
  ├─ update the agent_runs status
  └─ call flow.transition({
        subject: workItem, trigger: 'agent_run_completed', actor: agent })
     ▼
flow.transition()  ── one database transaction ──────────────────
  ├─ take a row lock: SELECT ... FOR UPDATE (guards against concurrent transitions)
  ├─ ask the state machine: executing --agent_run_completed--> reviewing ?
  ├─ evaluate guards: are acceptance criteria met, are dependencies satisfied
  ├─ call policy.evaluate(context)
  │    matches #7 "auto-approve low risk" → allow_and_notify
  │    or matches #1 "production change" → require_human_review
  ├─ if a human is required: decision.createDecision() (same transaction)
  ├─ UPDATE work_items SET status='reviewing'
  ├─ INSERT events (the status-change event, carrying the policy trace)
  └─ commit
     ▼
Event bus (publishes after commit, so uncommitted state never escapes)
  ├─▶ SSE fan-out: project:{id}:board, work_item:{id}
  ├─▶ notification: route to Feishu per the rules
  ├─▶ analytics: update the pre-aggregates
  └─▶ flow.schedule(): check whether this unblocked anything downstream
```

**The points that matter**:

1. **State and event are written in the same transaction** — otherwise you get audit black holes: the status changed and nothing recorded why
2. **The event bus publishes only after the commit** — through a transactional outbox or an `AFTER COMMIT` hook, so no subscriber ever sees state that then rolls back
3. **Policy evaluation happens inside the transaction** — its verdict decides where this transition goes, so it has to be atomic with the state change

---

## 3. Process and deployment topology

### 3.1 Process roles

```
┌─────────────────────────────────┐   ┌───────────────────────┐
│  api (N instances)              │   │  worker (M instances) │
│  · HTTP + SSE                   │   │  · Run Supervisor     │
│  · Synchronous business logic   │   │  · Flow Scheduler     │
│  · No long-running work         │   │  · Blocker Detector   │
│                                 │   │  · Integration Sync   │
│  Scale out on:                  │   │  · Analytics Agg.     │
│  live users and SSE connections │   │  · Notification       │
└─────────────────────────────────┘   └───────────────────────┘
         One codebase; PROCESS_ROLE decides which components start
```

**Why they are separate**: the API process has to answer fast and tolerate a restart at any moment; the worker carries long tasks and periodic loops and needs to hand off gracefully when it restarts. Fold them together and every deploy cuts a scheduling loop off mid-stride.

### 3.2 Worker inventory

| Worker | Trigger | Responsibility | Idempotency |
| --- | --- | --- | --- |
| `run-supervisor` | poll every 10s + event-driven | Watch running Runs: timeout detection, missed heartbeats, **orphan reclamation** | Required |
| `flow-scheduler` | every 5s + event-driven | Find `ready` Work Items whose dependencies are satisfied, check WIP and Policy, dispatch | Required |
| `blocker-detector` | every 60s | Scan for blockers using the nine categories from 8.6.4 | Naturally idempotent |
| `decision-escalator` | every 60s | Decision deadline reminders and three-tier escalation (product doc §11) | Needs dedup |
| `integration-sync` | scheduled + webhook | Two-way sync with external systems, conflict detection | Required |
| `analytics-aggregator` | every 5 min | Event stream → hourly and daily pre-aggregates | Required |
| `notification-dispatcher` | queue consumer | Notification routing, channel adapters, dedup, do-not-disturb | Required |
| `event-archiver` | daily | Aged-out hot data → object storage | Required |

### 3.3 Orphan Run reclamation (the heart of recoverability)

```
The Agent Run state machine (persisted in agent_runs)
  queued → dispatching → running → (completed | failed | timeout | terminated)

run-supervisor, every 10s:

  1. Find Runs where status='running' and last_heartbeat_at < now() - 90s
     → these are the Runs that have gone silent

  2. For each silent Run, probe its real state according to its runtime type:
     ├─ runtime supports status queries (MCP / HTTP) → ask it directly
     │   ├─ still running → refresh the heartbeat, carry on
     │   └─ already finished → pull the final result, backfill the events
     └─ no query support → decide by Policy: mark failed(reason='heartbeat_lost')
                            → trigger Flow Recovery (retry / switch agent / hand to a human)

  3. Find Runs stuck in status='dispatching' for more than 60s
     → the process died mid-dispatch → dispatch again (idempotency_key prevents double execution)
```

The `dispatching` intermediate state earns its keep: without it there is no way to tell "not dispatched yet" from "dispatched, outcome unknown", and retrying the second case makes the agent run the same task twice.

---

## 4. Data flow

### 4.1 The three main flows

```
① Requirement → plan → tasks (human–agent collaboration, mostly synchronous)
   user input ─▶ requirement.analyze (LLM streaming) ─▶ structured fields back over SSE
             ─▶ human confirms ─▶ plan.generate (LLM, 1–3 min, async job)
             ─▶ human approves ─▶ work items persisted + dependency graph built

② Execution (event-driven, asynchronous)
   flow-scheduler ─▶ agent.dispatchRun ─▶ Agent runtime
                                          │ event stream (SSE/webhook)
   run_events ◀──────────────────────────┘
      │
      ├─▶ forwarded live to the browser (SSE)
      ├─▶ milestone events ─▶ flow.transition ─▶ status change ─▶ events
      └─▶ cost accrual ─▶ budget check ─▶ may trigger Policy

③ External sync (bidirectional, and the easiest thing to get wrong)
   GitHub webhook ─▶ integration.handleWebhook
                  ─▶ map onto a Work Item ─▶ flow.transition (PR merged → done)
   Work Item change ─▶ outbound queue ─▶ Jira API (pushed or not, per source of truth)
```

### 4.2 Two things both called "events"

There are two kinds of "event" in this system, and **they must not be conflated**:

| | `run_events` | `events` |
| --- | --- | --- |
| Meaning | Fine-grained log of an agent's execution | Domain events (business facts) |
| Volume | Thousands for a single Run | Dozens for a single Work Item |
| Consumers | The Run detail timeline | Audit, Analytics, Flow, notifications |
| Retention | 30 days hot + archive | Long term (audit requirement) |
| Writer | Agent adapters | Flow Engine (sole writer) |

**How they relate**: a handful of key `run_events` — artifact submitted, execution completed, failure — get promoted to domain `events`. The promotion rule is defined in [06 Agent Protocol](06-agent-protocol.md) §5.

Keeping them apart pays off directly: Analytics and audit only ever scan the far smaller `events` table, instead of aggregating across millions of tool-call log lines.

### 4.3 SSE fan-out

```
worker/api publishes an event
     │
     ▼ Redis Pub/Sub  channel: project:{id}
┌────┴────┬─────────┐
▼         ▼         ▼
api-1     api-2     api-3      each instance holds some of the browser connections
  │         │         │
  ▼         ▼         ▼
browser   browser   browser
```

**Channel design** (matching the page docs):

| Channel | Subscribers | Contents |
| --- | --- | --- |
| `project:{id}:board` | Board, overview | Work Item status and progress |
| `work_item:{id}` | Work Item detail | Every event for that task |
| `run:{id}` | Run detail | The execution stream (high frequency) |
| `agent:{id}` | Agent Workspace | Queue and status |
| `user:{id}:decisions` | Decision center, global badge | Decision created / resolved / escalated |

**Backpressure**: the `run:{id}` channel is dense — tool calls can fire several times a second. The handling:
- the server coalesces same-type events over a 200 ms window
- the client unsubscribes the moment it disconnects
- once a single connection backs up past 1000 events, it degrades to "milestone events only, plus a prompt to refresh"

**Resuming after a disconnect**: SSE's `Last-Event-ID` header carries the sequence number, and a reconnect replays whatever was missed. Sequence numbers are monotonic by database sequence — see [07 API](07-api-design.md) §5.

---

## 5. Evolution path and split points

The modular monolith is not the destination. These are the split points we have designed for in advance, and what would trigger each:

| Split candidate | Trigger | Difficulty |
| --- | --- | --- |
| **Agent Orchestrator** | More than 50 agents, or more than 200 concurrent Runs; needs to scale on its own | Low (clean module boundary, communication is already asynchronous) |
| **Analytics** | Aggregation jobs start hurting the primary database | Low (read-only + its own aggregation store) |
| **Knowledge / semantic search** | When vector search and RAG arrive | Low — **and this is the most natural place to introduce a Python service** |
| **Integration** | More integrations, and rate-limit and retry logic gets complicated | Medium (calls into Flow in both directions) |
| **Flow + Policy** | Should almost never be split — these two are coupled most deeply to domain data | High |

**Where a Knowledge service would sit**: if the team later wants Python for semantic search, decision similarity matching (page doc 11 §5.7), or heavier analysis, build it as a standalone service reached over internal HTTP with a read-only PG replica. That path keeps the "Node control plane + Python data side" hybrid on the table without having to commit to it on day one.

---

## 6. Key technical risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| **Agent runtimes behave inconsistently** | Protocol support is uneven (some can't take constraints injected mid-run, some don't report cost), so the same product feature behaves differently depending on the agent | [06](06-agent-protocol.md) defines capability negotiation plus explicit degradation; the UI tells the user exactly which capabilities are missing |
| **Policy simulation is inaccurate** | A user loosens automation based on the simulation, real behavior differs → trust collapses | Events must carry a snapshot of the evaluation context ([03](03-event-model.md) §4); simulation results are labeled with a confidence level |
| **Process restart during a long Run** | Lost tasks, duplicate execution | All state persisted; the `dispatching` intermediate state + idempotency keys; orphan reclamation (§3.3) |
| **Bidirectional sync loops** | An endless sync storm | Changes produced by a sync carry an `origin` tag and the syncer skips its own; see `sync_mappings` in [02](02-domain-model.md) |
| **Event table bloat** | Queries slow down | Monthly partitions + hot/cold separation ([03](03-event-model.md) §6) |
| **Runaway LLM cost** | The project blows its budget | Cost accrues per Run in real time + a hard Policy threshold cuts it off ([05](05-policy-engine.md) §7) |
| **Concurrent state transitions** | An agent callback and a human action change the same Work Item at once | Row lock + optimistic version number; the state machine rejects illegal transitions ([04](04-flow-engine.md) §5) |

---

## 7. Non-functional targets

| Metric | Target | Notes |
| --- | --- | --- |
| API P99 latency | < 300 ms | Endpoints that don't call an LLM |
| Policy evaluation P99 | < 10 ms | It sits on the state-transition critical path |
| Board first paint | < 1.5 s | At a scale of 200 Work Items |
| SSE end-to-end event latency | < 500 ms | From agent event to browser render |
| Flow scheduling latency | < 10 s | From dependency satisfied to task dispatched |
| SSE connections per instance | 2000 | Past that, add api instances |
| Event write throughput | 500 events/s | MVP scale; capacity estimate in [03](03-event-model.md) §6 |
| Availability | 99.5% | MVP target; agent runtime outages don't count against it |

**A note on availability**: what makes this system unusual is that when it goes down, the Agent Runs already in flight do not stop — they are running inside external runtimes. So recovery hinges not on "restart quickly" but on "reclaim correctly after the restart" — the orphan reclamation in §3.3 matters more here than a high-availability deployment does.

---

## 8. Directory structure

```
apps/
  api/                    Fastify app (shared by api and worker)
    src/
      routes/             HTTP routes (thin: validate and delegate, nothing else)
      sse/                SSE connection management and fan-out
      workers/            entry point and loop for each worker
      main.ts             starts components according to PROCESS_ROLE
  web/                    React SPA
    src/
      pages/              one per page doc (14 of them)
      features/           components and hooks grouped by domain
      lib/                api client, SSE client, query configuration
packages/
  domain/                 domain layer (pure logic, zero IO dependencies)
    src/
      work-item/          entities + state machine definition
      policy/             condition AST and evaluator
      flow/               transition rule table
      decision/           owner resolution rules
  db/                     Drizzle schema + migrations + repositories
  contracts/              ★ shared front and back: Zod schemas + inferred TS types
    src/
      api/                request/response schemas
      events/             discriminated unions for domain events and run events
      agent-protocol/     Agent Protocol type definitions
  integrations/           GitHub / Jira / Feishu / Slack adapters
  agent-runtimes/         Claude Code / MCP / HTTP adapters
docs/                     this documentation tree
```

**`packages/contracts` is the single biggest payoff of choosing TypeScript**: when the frontend writes `import { WorkItem, PolicyCondition } from '@apos/contracts'`, what it gets is the very same definition the backend validates against. This package should carry zero runtime dependencies beyond Zod, which keeps the frontend bundle size under control.
