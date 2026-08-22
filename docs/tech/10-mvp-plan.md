# 10 MVP Implementation Plan

*[中文版本 / Chinese version](10-mvp-plan.zh.md)*

Corresponds to chapters 12 and 13 of the product documentation.

---

## 1. The hypothesis the MVP has to prove

Quoting product doc 12.1 verbatim:

> After a user enters a requirement, the Project Agent can turn it into an executable plan, assign the work to people or agents, request a human decision at the critical moments, and ultimately drive the requirement to completion.

**Technically, that sentence decomposes into four loops that all have to close**:

| Loop | What it proves | What failure means |
| --- | --- | --- |
| ① Requirement → plan | Whether an LLM can turn a vague description into an executable task breakdown | The very top of the product doesn't hold, and nothing downstream matters |
| ② Plan → dispatch → execution | Whether an agent can actually finish a task and hand back a verifiable artifact | We shipped a task manager |
| ③ Execution → decision → resume | Whether Policy stops at the right moment to find a human, and whether work resumes once they act | Human-in-the-loop doesn't hold |
| ④ Failure → recovery | Whether the system recovers automatically or semi-automatically after a failure | One agent failure stalls the project — not usable in practice |

**④ is the one that gets underestimated.** In a demo the agent always succeeds; in real use the first-attempt success rate may be only 60–70%. Without solid recovery, the user experience is "firefighting by hand every day" — more work than the traditional tools they left.

---

## 2. Phasing

Four phases; each one ends with something you can run.

```
Phase 0  Foundation         3 wks   Domain model + events + state machine + auth
Phase 1  Single-agent loop  4 wks   Requirement → plan → single-agent execution → board (no Policy)
Phase 2  Governance loop    4 wks   Policy + Decision Center + recovery
Phase 3  Usable product     4 wks   Integrations + Analytics + agent management + polish
                           ─────
                           15 wks
```

Estimated for a team of 3–4 (2 backend + 1 frontend + 1 full-stack).

---

## 3. Phase 0: foundation (3 weeks)

**Goal**: land [02 Domain Model](02-domain-model.md), [03 Event Model](03-event-model.md), and [04 Flow Engine](04-flow-engine.md) §2–3. Everything built afterward sits on top of them.

| Task | Deliverable |
| --- | --- |
| Project scaffolding | Monorepo, CI, Docker Compose local environment |
| `packages/contracts` | Domain types and Zod schemas |
| Database schema + migrations | All core tables (partitioning included) |
| Event write and query | `emit()` / `query()` / causal-chain tracing |
| **Transition engine** | State machine, guards, transactionality, concurrency control |
| Auth and authorization skeleton | JWT, actor model, `can()` |
| SSE infrastructure | Connection management, Redis fan-out, resume after disconnect |
| Frontend skeleton | Routing, Query configuration, SSE client, shared components (§5 component spec) |

**Acceptance**: you can create a project and a work item through the API, trigger a status transition by hand, see the events written correctly, and watch the change arrive in the frontend over SSE.

**Why three weeks is worth it**: the transition engine and the event model are the common path under every feature. Cut corners here and every later feature has to route around the damage. In particular, the rule that *a status change must write an event* has to be enforced in code on day one, not by review afterward.

**Risk**: this phase ships nothing a user can see, which makes it easy to compress. Tell stakeholders that explicitly, and pay them back with the Phase 1 demo.

---

## 4. Phase 1: single-agent loop (4 weeks)

**Goal**: prove hypotheses ① and ②. **This phase should end with a demo that convinces people.**

| Task | Reference doc |
| --- | --- |
| Requirement intake (text + attachments) | Page 03 |
| **AI requirement structuring** (LLM streaming) | Page 03 §5.4 |
| Clarifying-question generation and answers | Page 03 §5.5 |
| Requirement-confirmation human gate | Page 03 §5.7 |
| **Plan generation** (task breakdown + dependencies) | Page 04 |
| Plan-confirmation page (no auto-actions) | Page 04 |
| **Agent Protocol + Claude Code adapter** | [06](06-agent-protocol.md) |
| Run dispatch, event stream, artifact return | [06](06-agent-protocol.md) §4–5 |
| Flow Scheduler (dependency checks + dispatch) | [04](04-flow-engine.md) §4 |
| **Board** (six columns + cards that move themselves) | Page 05 |
| Work item detail + run detail | Pages 06, 09 |
| GitHub integration (minimum: read repo, open PR, report CI status) | Page 14 |

**Not in scope**: Policy Engine (Phase 1 executes everything automatically), Decision Center, multi-agent, Analytics.

**Acceptance (end-to-end demo script)**:

```
1. Create the project "Order Lookup Optimization"
2. Paste a conversational requirement → AI structures it → answer 3 clarifying questions → confirm
3. Plan generation (about 2 minutes) → see the breakdown into 8 tasks with dependencies → approve
4. Tasks move themselves from Ready to Executing on the board
5. The Claude Code agent really edits code, runs tests, opens a PR
6. The card moves itself to Review; the PR link opens
7. Nobody dragged a single card at any point
```

**This demo is the product's core proof of value.** Line 7 matters most — it is the line that separates this from a traditional board.

**Technical risks**:

| Risk | Response |
| --- | --- |
| Poor plan-generation quality (unreasonable task breakdown) | Invest in prompt engineering early; assemble 3–5 real requirements as a benchmark set |
| Low agent success rate | Prove the loop on simple task types in Phase 1; push complex tasks to Phase 3 |
| Bad dependency judgment causing out-of-order execution | Unit tests for guards covering all seven dependency types |

---

## 5. Phase 2: governance loop (4 weeks)

**Goal**: prove hypotheses ③ and ④. This is the core of the product's differentiation.

| Task | Reference doc |
| --- | --- |
| **Policy Engine** (condition AST, evaluation, caching) | [05](05-policy-engine.md) §2–3 |
| Template-based Policy configuration UI (no free-form editor) | Page 13, [05](05-policy-engine.md) §10 |
| **Operation toggle matrix** (the summary *is* the control panel) | Page 13 §5.1 |
| First-run wizard for the zero-rules state | Page 13 §5.12 |
| **Policy simulation and replay** | [05](05-policy-engine.md) §5 |
| Natural-language explanations | [05](05-policy-engine.md) §6 |
| Safety floor (delete resource / change permissions / execute payment hard-coded in the evaluator) | [09](09-security.md) §4.1 |
| **Decision creation and owner resolution** | Page 11, [02](02-domain-model.md) §9 |
| **Decision Center** (inbox, cards, bulk actions, keyboard mode) | Page 10 |
| Decision detail (option comparison, attached constraints) | Page 11 |
| Decision deadlines, reminders, and three-level escalation | Product doc ch. 11 |
| **BlockerDetector** (nine blocker classes) | [04](04-flow-engine.md) §5 |
| **Recovery strategies** (by error class) | [04](04-flow-engine.md) §6 |
| Human takeover and hand-back | Page 06 §5.2 |
| "What will happen automatically once you approve" on the plan page | Page 04 §5.3 |
| Notification channel (Feishu or Slack — pick one) | Page 14 §5.5 |

**Acceptance**:

```
1. Configure a rule: production database changes require DBA approval
2. The agent reaches the database-change task → stops on its own → an item appears in the Decision Center
3. The DBA gets a Feishu notification → clicks straight through to the decision detail
4. Approves and attaches the constraint "off-peak hours only" → the constraint is written onto the task
5. The task resumes, and the agent honors the constraint
6. Force an agent failure → the system adds context and retries automatically per the error class → succeeds
7. Force 3 consecutive failures → the system pauses automatically and escalates to the tech lead
8. Simulate a new rule against historical data → see "would have auto-handled 12 times, 2 of which a human rejected at the time"
```

**Line 8 is the most persuasive feature in this phase**, and it is what makes users willing to loosen the reins on automation.

**Technical risks**:

| Risk | Response |
| --- | --- |
| Incomplete event-snapshot fields making simulation inaccurate | **Record snapshots from Phase 0 against the fact list in [05](05-policy-engine.md) §2.3** — do not wait until Phase 2 |
| Unreliable error classification defeating recovery strategies | The Agent Protocol requires an error class; runtimes that don't support it fall back to a conservative strategy |
| Wrong decision owner resolved (the request reaches the wrong person) | Make the responsibility mapping configurable; track reassignment rate as a monitored metric |

**⚠ Critical dependency**: Policy simulation depends on `context_snapshot` being recorded starting in Phase 0. Skip it there and by Phase 2 the historical data holds no snapshots — simulation has nothing to work with, and you have to wait another month for data to accumulate. **This is the easiest trap to fall into in the entire plan.**

---

## 6. Phase 3: usable product (4 weeks)

**Goal**: get from "demoable" to "actually usable."

| Task | Reference doc |
| --- | --- |
| Agent management (registration, capability/permission configuration, dry run) | Page 08 |
| Multi-agent support (parallelism, Review Agent) | Page 08 §5.4 |
| Permission-change preview | [09](09-security.md) §3.3 |
| **Analytics** (Flow + Agent + cost) | Page 12, product doc 12.2 |
| System findings (insight generation) | Page 12 §5.1 |
| Jira or Plane integration (one-way import + status write-back) | Page 14 §5.3 |
| Execution Graph (read-only) | Page 07 |
| Full project-overview page | Page 02 |
| Project list + "needs me" | Page 01 |
| Delay prediction | [04](04-flow-engine.md) §7 |
| Orphaned-run takeover, graceful restart | [01](01-architecture.md) §3.3 |
| Performance work (virtual scrolling, aggregate endpoints, indexes) | [08](08-frontend-architecture.md) §6 |
| Security hardening (redaction, audit views, rate limiting) | [09](09-security.md) |

**Acceptance**: two weeks of real internal use, running our own development work on it. That is the most honest bar there is — **if the team won't use it, we shouldn't ship it to customers.**

---

## 7. Explicitly out of scope for the MVP

The list from chapter 13 of the product documentation, plus the technical additions:

| Out of scope | Why |
| --- | --- |
| Agent Marketplace | Prove the value of a single agent first |
| Complex financial budgeting | A per-project budget cap is enough |
| Multi-level enterprise org structure | One org level + projects |
| Knowledge graph / Knowledge Center | Only valuable once there is enough history |
| Custom BI | Fixed metrics + CSV export |
| Cross-project resource scheduling | Scheduling within one project is already hard enough |
| ERP / CRM integration | — |
| Low-code workflow designer | Six fixed stages + bounded configuration |
| Fully autonomous production releases | Safety floor |
| Agents editing Policy | **A safety floor, not merely a scope call** ([09](09-security.md) §7.2) |
| **Free-form Policy condition editor** | Templates + simulation matter more than flexibility ([05](05-policy-engine.md) §10) |
| **Full two-way sync** | Import + status write-back only (Page 14 §12) |
| **Editing the Execution Graph** | Read-only; dependency changes go through replanning |
| **Timeline / Calendar / Risk / Delivery views** | Board + list + Agent View + decision view cover it |
| **A standalone Home workspace page** | The project list does that job |
| Microservice decomposition | Modular monolith ([01](01-architecture.md) §2.4) |
| Kafka / event-streaming platform | PostgreSQL + Redis is enough ([03](03-event-model.md) §6) |
| Multi-region deployment | — |

---

## 8. Work that runs across all phases

These don't belong to any one phase; they need sustained investment starting in Phase 0:

### 8.1 Prompt engineering and benchmarking

Requirement structuring, plan generation, and clarifying-question generation set the ceiling on product quality. Recommended practice:

- Collect 10–20 real requirements as a benchmark set
- Run the whole set on every prompt change and score by hand (structuring completeness, breakdown soundness, how pointed the clarifying questions are)
- Record a baseline for cost and latency

**This is the highest-return investment on the list**: if plan generation is weak, every feature downstream is operating on a bad foundation.

### 8.2 Testing

| Type | Starts in | Coverage requirement |
| --- | --- | --- |
| Exhaustive state-machine tests | Phase 0 | 100% |
| Policy evaluation tests | Phase 2 | 100% |
| Safety-floor tests (nine high-risk operations) | Phase 2 | 100%, blocking in CI |
| Transition transactionality and concurrency | Phase 0 | Critical paths |
| SSE → cache synchronization | Phase 1 | Major event types |
| E2E on the three core paths | Phase 1 onward | — |

### 8.3 Observability

Needed from Phase 0, or debugging after Phase 2 becomes miserable:

- Structured logs (including `correlationId`, matching the correlation on events)
- Traces (latency breakdown across LLM calls, agent dispatch, status transitions)
- Key metrics: Policy evaluation latency, scheduling latency, SSE connection count, run success rate, LLM cost

---

## 9. Milestones and decision points

| Point in time | What to check | What to do if it misses |
| --- | --- | --- |
| End of Phase 0 | Whether the transition engine handles concurrency correctly; whether the event-snapshot fields are complete | Incomplete snapshot fields must be filled in before moving on |
| End of Phase 1 | **Plan-generation quality: is the task breakdown directly executable?** | If the breakdown is weak, pause further development and focus on prompt and context engineering |
| End of Phase 1 | Agent first-attempt success rate | Below 50% means task granularity or context has a systemic problem |
| End of Phase 2 | Whether Policy simulation works; whether the decision-response path flows smoothly | Without working simulation, loosening a rule can't be done safely — fill the gap |
| Mid Phase 3 | Manual-intervention rate in internal use (share of cards dragged by hand) | Above 30% means automatic status inference is off — go back and fix Flow |
| End of Phase 3 | Whether the team wants to keep using it | If they don't, don't release |

**The Phase 1 checkpoint matters most.** Plan-generation quality sets the product's ceiling; if it isn't there by then, building more features on top only amplifies the problem.

---

## 10. Open questions

1. **Team composition and language choice.** This plan is estimated for a TypeScript full stack. If the team's strength is Python, switching the backend to Python leaves the schedule roughly unchanged ([README](README.md) §2.3), but frontend type generation needs extra handling.
2. **Which code agent goes first?** The plan assumes Claude Code (most complete protocol support, lowest adaptation cost). If the target customers require a different agent, Phase 1 adapter work grows by 1–2 weeks.
3. **Feishu or Slack for notifications?** This drives the Phase 2 integration work. Decide by the first cohort of target customers, and build only one.
4. **Do we need self-hosted deployment?** It affects architecture (outbound LLM calls, object storage, secret management). Recommendation: SaaS only for the MVP, self-hosting in a later release.
5. **Will Phase 0's three weeks get compressed?** This is the biggest execution risk. Recommendation: write "event-snapshot fields are complete" into the Phase 0 acceptance criteria as non-negotiable — Phase 2 hard-depends on it.
6. **Where does the benchmark requirement set come from?** We need product to supply 10–20 real, representative requirement descriptions. That work should start in Phase 0, not wait for Phase 1 development.
