# Autonomous Project OS Technical Documentation

*[中文版本 / Chinese version](README.zh.md)*

This directory is the technical implementation plan behind the [product feature doc](../product/autonomous-project-os.md) and the [page docs](../product/pages/README.md).

---

## 1. Document index

| # | Document | Contents | Language-dependent? |
| --- | --- | --- | --- |
| — | [Technology choices](#2-technology-choices) | Below, in this document | ✅ |
| 01 | [System architecture](01-architecture.md) | Service breakdown, deployment topology, data flow, concurrency model | Partly |
| 02 | [Domain model and database](02-domain-model.md) | Table structures and constraints for the 10 core objects | ❌ |
| 03 | [Event model](03-event-model.md) | Event definitions, causal chains, audit, replay | ❌ |
| 04 | [Flow Engine](04-flow-engine.md) | State machine, dependencies, scheduling, blocker detection and recovery | ❌ |
| 05 | [Policy Engine](05-policy-engine.md) | Rule representation, evaluation, simulation replay, inheritance and conflicts | ❌ |
| 06 | [Agent Protocol](06-agent-protocol.md) | The unified agent integration protocol and its adapters | ❌ |
| 07 | [API design](07-api-design.md) | REST conventions, the SSE contract, idempotency and concurrency | ❌ |
| 08 | [Front-end architecture](08-frontend-architecture.md) | React layering, live data, performance | ✅ |
| 09 | [Identity, permissions, and security](09-security.md) | Identity model, RBAC/ABAC, audit, secrets | ❌ |
| 10 | [MVP delivery plan](10-mvp-plan.md) | Phased delivery, milestones, risks | ❌ |
| 11 | [Workspace abstraction](11-workspace-abstraction.md) | Separating setup from delivery in an agent's working directory; baselines and changesets; the four backends | ❌ |
| 12 | [Internationalization](12-i18n.md) ([ZH](12-i18n.zh.md)) | Message catalogs, server-side reason codes, enum ownership, the three tests that guard it | ✅ |
| 13 | [One localization pipeline](13-i18n-unified.md) ([ZH](13-i18n-unified.zh.md)) | The shared catalog package, the text descriptor, where the locale comes from, the five-phase migration | ✅ |

---

## 2. Technology choices

### 2.1 The short answer

| Layer | Choice |
| --- | --- |
| Front end | React 18 + TypeScript + Vite |
| Back end | **Node.js 22 + TypeScript** (Fastify) |
| Database | PostgreSQL 16 (primary store + JSONB + partitioning) |
| Cache / messaging | Redis 7 (Pub/Sub + BullMQ queues) |
| Object storage | S3-compatible (artifacts, archived events) |
| Deployment | Containerized, monolith first, split along the seams in §2.4 as it grows |

### 2.2 Why Node on the back end rather than Python

**The shape of the load decides it.** This is an orchestration control plane, not a compute system:

| Main work | Shape |
| --- | --- |
| Supervising agent runs | A single run may last 30 minutes, spent waiting on streamed LLM output the whole way |
| Receiving webhooks | GitHub / Jira / CI events arriving at high frequency |
| SSE fan-out | 1–3 long-lived connections per online user; board and run detail update live |
| Syncing external APIs | Many concurrent HTTP calls, bounded by rate limits |
| Policy evaluation | In-memory rule matching, microseconds |
| Advancing flow state | Database transactions |

Nearly all of it is I/O-bound work and state management; none of it is CPU-bound. Node's event loop maps straight onto that shape.

**Four concrete reasons:**

1. **Domain types shared across front end and back end.** Ten core objects, fourteen data-dense pages. `WorkItem`, `Decision`, the condition AST of `Policy`, the event union in the Agent Protocol — these structures are most naturally expressed as discriminated unions in TypeScript, and the front end consumes the same definition rather than a generated copy of it. Type drift is the biggest single source of bugs in a system like this.

2. **The agent ecosystem.** MCP and the Claude Agent SDK are TypeScript-first. The agent runtime adapter layer ([06](06-agent-protocol.md)) is the highest-risk integration surface in the system; a first-class SDK means fewer holes to fall into.

3. **Long-lived connections and stream forwarding.** An agent run's event stream has to flow in from the agent runtime, land in the database, and flow back out to the browser. Node's streaming primitives keep that path short.

4. **One language, one team's velocity.** The target users are small teams and one-person companies, and the team building this is probably small too. One language fewer means one fewer toolchain, CI setup, dependency manager, and hiring requirement.

### 2.3 When you should pick Python instead

Honestly, there are two cases where I'd go the other way:

| Case | Notes |
| --- | --- |
| **The team is already strong in Python** | This outweighs every technical argument above. The cost of building an orchestration system in a language you don't know well dwarfs the difference in how well the language fits the problem |
| **Knowledge retrieval / analytics have to run in-process early** | For the Knowledge Center's semantic retrieval (product doc 8.12) and Analytics' heavier computation, the Python ecosystem is clearly better |

**If you do choose Python**: FastAPI + SQLAlchemy 2.0 + Pydantic v2 + asyncio, with front-end types generated from OpenAPI. Eight of the documents here — 02–07, 09, 10 — apply as-is; only this section and the runtime portion of [01 Architecture](01-architecture.md) need rewriting.

**The middle road**: Node for the main control plane, with knowledge retrieval and analytics computation split out into a standalone Python service called over an internal API. [01 Architecture](01-architecture.md) §5 reserves that seam.

### 2.4 Why a modular monolith rather than microservices

At the MVP stage, nobody has validated where the service boundaries belong. In the product docs, the Flow Engine, the Policy Engine, and agent orchestration interact constantly — every state transition goes through Policy, every agent event drives Flow. Splitting too early turns those calls into network calls and buys distributed transactions in exchange.

**How it works**: one deployment unit, with strict internal module boundaries (no module reaches into another module's tables; calls go through exported interfaces only) and worker processes separated by responsibility. That way, splitting later means moving code rather than untangling it.

The triggers for splitting are written down in [01 Architecture](01-architecture.md) §5.

### 2.5 Key dependencies

| Purpose | Choice | Why |
| --- | --- | --- |
| HTTP framework | Fastify | Fast, schema-driven validation and serialization, native SSE support |
| ORM / queries | Drizzle ORM | Type-safe and close to SQL; this system runs a lot of complex queries and CTEs, where a heavy ORM gets in the way |
| Validation | Zod | Infers both ways with TS types; one schema serves API validation, Policy conditions, and the Agent Protocol |
| Queue | BullMQ (Redis) | Delayed jobs, retries, concurrency limits (WIP control uses that directly) |
| Migrations | Drizzle Kit | — |
| LLM | `@anthropic-ai/sdk` | Project Agent and requirement structuring |
| MCP | `@modelcontextprotocol/sdk` | Agent and tool integration |
| Testing | Vitest + Testcontainers | The state machine and Policy have to be tested against a real PG |
| Front-end state | TanStack Query + Zustand | Keeps server state and UI state apart |
| Front-end graphs | React Flow + dagre | Execution Graph |

**Deliberately left out:**

- **Temporal / workflow engines**: the Flow Engine *is* a domain-specific workflow engine, and the product requirements (WIP control, Policy gates, human decision nodes) are not something a general-purpose engine satisfies directly. Using one turns into "writing an engine on top of an engine."
- **GraphQL**: the mapping from pages to endpoints is clear, so REST plus a few aggregate endpoints is enough; for the real-time requirement, GraphQL Subscriptions are heavier than SSE, not lighter.
- **Microservice frameworks / service meshes**: see §2.4.
- **Kafka**: PostgreSQL + Redis handle the MVP's event volume with room to spare (estimate in [03 Event model](03-event-model.md) §6).

---

## 3. Three technical constraints that run through the whole system

These three come from what the product is, not from technical taste. Break any one of them and the product loses its core value.

### 3.1 Every state change must produce an Event

Product doc 3.2, "every action is traceable," requires the system to answer: who did what, why they did it, what context they used, and who approved the critical decisions.

**What that means technically**: no code path may `UPDATE` a domain table without writing an Event. State changes all go through the Flow Engine's transition interface, which writes the state and the event inside the same transaction. See [03](03-event-model.md).

### 3.2 An agent is an identity of its own, not a stand-in for a human

Product doc 10.3 explicitly requires agent permissions to be configured independently of human users'.

**What that means technically**: every field that names an actor is `(actor_type, actor_id)`, never `user_id`; agents carry their own credentials and permission sets; an implementation where "the agent runs using somebody's token" is forbidden. See [09](09-security.md).

### 3.3 Policy evaluation sits on the critical path, and must be simulatable

Every scheduling pass, every state transition, and every high-risk operation goes through Policy. At the same time, page doc 13 requires validating rules by replaying them against historical data.

**What that means technically**:
- Evaluation has to be fast (P99 < 10ms) → rules are compiled into memory, never queried from the database
- Replay requires every Event to carry **a snapshot sufficient to rebuild the evaluation context**, which is a hard constraint on event design

See [05](05-policy-engine.md).

---

## 4. System at a glance

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser (React SPA)                                                │
│  REST + SSE                                                         │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────┐
│  API Layer (Fastify)   AuthN · AuthZ · Validation · SSE fan-out     │
├─────────────────────────────────────────────────────────────────────┤
│  Application Modules                                                │
│  ┌──────────┐┌──────────┐┌──────────┐┌──────────┐┌───────────────┐ │
│  │Requirement││  Plan    ││  Flow    ││  Policy  ││   Decision    │ │
│  │  Module  ││ Module   ││  Engine  ││  Engine  ││    Module     │ │
│  └──────────┘└──────────┘└──────────┘└──────────┘└───────────────┘ │
│  ┌──────────┐┌──────────┐┌──────────┐┌──────────┐┌───────────────┐ │
│  │  Agent   ││Integration││Analytics ││Knowledge ││   Identity    │ │
│  │Orchestr. ││  Module  ││ Module   ││ (P1)     ││   & Access    │ │
│  └──────────┘└──────────┘└──────────┘└──────────┘└───────────────┘ │
├─────────────────────────────────────────────────────────────────────┤
│  Event Bus (in-process + Redis Pub/Sub)                             │
└──────┬──────────────────────────────────────────────┬───────────────┘
       │                                              │
┌──────▼────────────────────┐              ┌──────────▼───────────────┐
│  Workers (BullMQ)         │              │  PostgreSQL / Redis / S3 │
│  · Run Supervisor         │              └──────────────────────────┘
│  · Flow Scheduler         │
│  · Blocker Detector       │              ┌──────────────────────────┐
│  · Integration Sync       │◀────────────▶│  External systems        │
│  · Analytics Aggregator   │              │  GitHub / Jira / Feishu  │
│  · Notification Dispatcher│              │  Agent Runtimes (MCP…)   │
└───────────────────────────┘              └──────────────────────────┘
```

---

## 5. Suggested reading order

**To understand how the system runs**: [01 Architecture](01-architecture.md) → [03 Event model](03-event-model.md) → [04 Flow Engine](04-flow-engine.md)

**To start writing code**: [02 Domain model](02-domain-model.md) → [07 API](07-api-design.md) → [10 Delivery plan](10-mvp-plan.md)

**To integrate an agent**: [06 Agent Protocol](06-agent-protocol.md) → [11 Workspace abstraction](11-workspace-abstraction.md) → [09 Security](09-security.md)

**To work on the front end**: [08 Front-end architecture](08-frontend-architecture.md) → [07 API](07-api-design.md) → the matching [page docs](../product/pages/README.md)
