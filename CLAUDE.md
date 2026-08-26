# CLAUDE.md

*[中文版本 / Chinese version](CLAUDE.zh.md)*

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

APOS (Autonomous Project OS) — a project operating system for mixed human–agent teams. A pnpm workspace monorepo, Node 22 + TypeScript, modular monolith.

## Language Conventions (Bilingual)

This repository is **bilingual, English and Chinese**. Follow the table below when you write anything — don't go by instinct:

| Content | Rule |
| --- | --- |
| Code comments | Both languages in parallel. **English first, Chinese after**, and **not a literal translation** — each side has to read on its own |
| Docs (`docs/`, README) | English is canonical: `X.md` is the English document, `X.zh.md` is the Chinese mirror, and the two link to each other at the top |
| UI copy | Always through i18n, **never a literal string**. Messages are split by area under `apps/web/src/lib/i18n/messages/{en,zh}/` |
| Commit messages | English, with an optional Chinese line in the body |
| User-visible server copy | A **reason code plus params**, not a pre-assembled sentence (see below). The Chinese sentence stays as the fallback for logs and existing rows |

**A short comment may be written in one language only** (things like `/** Test-only helper */`); the test is whether someone who doesn't read Chinese would fail to understand the code because of it. ★ comments — the ones that explain *why* the code is written this way — are always bilingual, because those are exactly what an outside reader needs most.

Three hard constraints on frontend i18n:

1. **English is the default language**, Chinese is an explicit choice (the reason is written down in `apps/web/src/lib/i18n/locale.ts`: someone who can't read Chinese also can't read the button labeled 「切换语言」, "Switch language").
2. **The English side is the single source of truth for keys**, and the Chinese side's types are pinned to it — a missing key is a compile error, not an empty label at runtime. The pinning is per module (`messages/zh/board.ts` is pinned to `messages/en/board.ts`), so the error points at the specific chunk that's short a key instead of at one 2,600-entry object.
3. **Never assemble a sentence from fragments.** The two languages order words differently; `{'共 '}{n}{' 条'}` only works in Chinese. Use a whole sentence with placeholders: `t('x', { count: n })`.

Module-level constants store **message keys**, not translated text (`Record<string, MessageKey>`): a constant can't reach a hook, and it isn't recomputed when the locale changes, so a translated string freezes in whatever language was active at first render.

**User-visible copy produced by the server travels as a reason code**, not as a finished sentence. The shape is the same everywhere:

- **Every HTTP error** (`ErrorReason`, `packages/contracts/src/common/error-reason.ts`) — throw through `fail(code, reason, <Chinese sentence>, { params })` (`apps/api/src/http/errors.ts`); the envelope carries `reason` / `params` alongside `message`
- "Not found" is its own axis (`NotFoundEntity`) — `notFound('project')` passes an **entity key**, not Chinese. Chinese puts the noun first and English puts `not found` last, so `${what}不存在` only composes in Chinese
- Scheduling rejection reasons (`RejectionCode` / `RejectionScope`, `work-item/blocked.ts`) — stored in `work_items.blocked_detail`
- A decision's "why you're needed / what happens if you don't act" (`DecisionReason`, `decision-reason.ts`) — stored in `decisions.reason_detail`
- Analytics findings and metrics (`Insight.code` / `Contribution.key` / `QualityMetric.key` / `BenefitLine.key`), policy health-check conclusions (`PolicyIssue.type`), and credential failures (`CredentialProblemCode`)

Each of these keeps the original Chinese sentence as a fallback: existing rows have nothing else, and for logs and notifications a ready-made sentence is still less work. **The UI reads the code; the log reads the sentence.**

**Enum wording belongs to the UI.** Task types, error classifications, decision types, policy facts / actions / environments, runtime capability items — all of these are **codes**, and their messages live in the `xxxLabel()` functions in `apps/web/src/lib/format/index.ts`. The `XXX_LABELS` Chinese tables in domain are there for the server to build log lines; a frontend that `import`s a Chinese table has hard-coded the server's language into the interface, and switching locale won't change it.

The test is "how many consumers does this sentence have": the moment it serves two out of the three — the Chinese UI, the English UI, and some button (「一键修复」 "Fix it", 「去授权」 "Grant access") — it has to be a code. A finished sentence serves only the first; the other two are left regex-matching it, and matching a sentence that can be reworded at any time is a time bomb.

When you add a new piece of server copy: words the platform wrote itself (baseline policy names, the wording of a recovery strategy) become message keys; words the user wrote (their own policy names, an agent's reason for asking for help) are passed through verbatim as `params` — "translating" a name the user chose is renaming it.

**Remaining gaps** (all of them **deliberate**, not oversights):

- **Guard failure reasons and policy denial explanations** still surface the domain's Chinese sentence as-is (the codes are `guard.failed` / `policy.denied`, and they **intentionally have no message entry**). What they carry is "which preconditions didn't pass" and "what that rule says about itself" — collapsing that into one generic translated sentence throws away every bit of the information. The list and the reasoning live in `REASONS_WITHOUT_CATALOG` in `apps/web/src/lib/api/errors.ts`, and the i18n tests honor that list, so "deliberately untranslated" and "forgot to translate" stay distinguishable in the test suite. A real fix means giving each of those reasons in `flow/guards.ts` a code of its own.
- Strings like `analysisModel` have exactly one consumer, which by the test above doesn't yet justify splitting them out.

Four tests stand guard:

| Test | What it guards |
| --- | --- |
| `lib/i18n/i18n.test.ts` | The two tables' keys correspond one to one; no empty messages; placeholders match across both languages |
| `lib/api/errors.test.ts` | Every `ErrorReason` has a message (unless it's on the list above); no orphan messages; an unrecognized code falls back to the original sentence instead of a blank |
| `lib/i18n/no-literals.test.ts` | No Chinese literals in UI code; exceptions must state a reason |
| `lib/i18n/messages/structure.test.ts` | Every key lives in the file its prefix says it should; the English and Chinese sides are structurally identical; no stale prefixes in the ownership table |

All four are watching for **silent failure** — breaking any of them looks perfectly fine in the Chinese UI. Full write-up in [docs/tech/12-i18n.md](docs/tech/12-i18n.md).

## Common Commands

```bash
pnpm install
bash scripts/dev-up.sh          # One shot: containers → create both databases → migrate → seed if empty → API → Vite
                                # If the port is taken: APOS_API_PORT=3001 bash scripts/dev-up.sh

pnpm test                       # Everything, integration tests included (needs Postgres)
pnpm test apps/api/src/http/routes.test.ts     # A single file
pnpm test -t "viewer 不能改状态"                # By test name
pnpm typecheck                  # pnpm -r typecheck
pnpm lint                       # Only rules that catch real bugs, nothing about formatting (reasoning in eslint.config.js)

pnpm dev:api                    # tsx watch; the backend restarts on change
pnpm --filter @apos/web dev     # Frontend; if the API moved ports, follow it: API_URL=http://localhost:3001 …
pnpm --filter @apos/web smoke <projectId>   # Playwright smoke test; needs both the API and the dev server running

pnpm db:generate                # Generate a migration after editing schema/core.ts
DATABASE_URL=postgres://apos@localhost:5433/apos pnpm db:migrate
DATABASE_URL=postgres://apos@localhost:5433/apos pnpm --filter @apos/api seed
```

To bring up only the dependency containers you have to **name them**: `docker compose up -d postgres redis`. A bare `docker compose up -d` starts the full product (api / worker / migrate), which then competes with your local dev processes over work in the same database — two scheduler loops dispatching the same items twice. The full deployment is `docker compose up -d --build`, which exposes a single port (8080 by default, serving both the frontend and the API).

Integration tests connect to `TEST_DATABASE_URL` (default `postgres://apos@localhost:5433/apos_test`) and TRUNCATE every table in each file's `beforeEach` — so it **must not point at your dev database**. vitest has file-level parallelism turned off (all files share one test database).

Postgres runs on **5433**, not 5432: a system-installed instance is often already squatting on 5432, Docker doesn't complain about the port conflict, and the connection silently lands on that instance instead — the symptom is `role "apos" does not exist`. Every default in the repo is 5433.

## The Three Inviolable Constraints

Details and reasoning in [CONTRIBUTING.md](CONTRIBUTING.md); this is the reminder to read before you touch code:

1. **A status change must produce an event.** No code path may `UPDATE work_items SET status = ...` directly; everything goes through `transition()` in `apps/api/src/modules/flow/transition.ts`, which writes the status and the event in the same transaction. This is the entire data source for auditing, policy simulation, and analytics.
2. **An agent is an identity of its own.** Any field that refers to an actor is `(actorType, actorId)`, never `userId`. Agents have their own credentials and their own permission sets, and never reuse a human's token.
3. **Policy evaluation must carry a context snapshot.** The `contextSnapshot` on a `policy.evaluated` event cannot be reconstructed after the fact. When you add a policy fact, update `buildPolicyContext()` (`modules/flow/context.ts`) in the same change.

The safety-floor test in `packages/domain/src/policy/evaluate.test.ts` is a blocker: it enumerates every autonomy level and asserts that `NEVER_AUTO_APPROVE` actions are never let through automatically. If it goes red, the governance system has been bypassed.

## Repository Layout and Dependency Direction

```
packages/contracts/            Types and Zod schemas shared by frontend and backend — the single source of truth, zero deps
packages/domain/               Pure logic: state machine, guards, policy evaluation, RBAC catalog, agent capability
                               catalog and profiles, analytics, recovery strategies. Zero IO, unit-testable
                               without a database. Decision rules change here, not in http/
packages/db/                   Drizzle schema, migrations, connection-shape inference, RLS auditing
packages/agent-runtimes/       Agent runtime adapters (claude-code / codex / cli / mock)
packages/workspace-providers/  Workspace sources and delivery (git / local / object-storage / empty)
packages/integrations/         External system adapters (real GitHub HTTP, in-memory adapters, Slack/Feishu webhooks)
apps/api/src/http/             Entry layer: routes, auth gates, SSE, idempotency keys, error envelopes
apps/api/src/modules/          Application layer, one directory per domain; modules call each other only through exported interfaces
apps/api/src/workers/          Periodic loops (scheduler / supervisor / recovery / review / stats / notify)
apps/web/                      React 18 + Vite + TanStack Query + zustand + shadcn
```

Dependencies only point downward: `http → modules → domain → contracts`. An `import ... from '@apos/db'` inside domain means you've gone the wrong way.

The path aliases `@apos/*` and `@/*` must agree in **three places**: `vitest.config.ts`, `apps/web/vite.config.ts`, and the tsconfigs. Missing one shows up as either "typecheck passes but the browser can't resolve it" or "the tests won't run at all".

## Mechanisms You Have to Know About

**Fastify's startup order is a hard constraint** (`apps/api/src/app.ts`): the idempotency hook has to be registered before the routes (hooks run in registration order, and a replay has to short-circuit ahead of the business logic), and static frontend hosting has to come after them (the notFound fallback can't be installed until the API routes exist).

**A write route with no declared permission won't let the process start.** The permission lives on the route itself: `{ config: { auth: { permission: 'plan.approve' } } }`. `guardRouteCoverage()` counts every route through an `onRoute` hook and throws at startup the moment it finds an undeclared write route. Routes that genuinely need no auth (agent callbacks, probes, login) go into `EXEMPT` in `rbac.ts` with a stated reason; cross-project routes that must be judged one resource at a time use `deferred('reason')`. The permission decision itself lives in the permission catalog in `@apos/domain`; rbac.ts only answers "who is calling".

**Scope is still inferred from URL shape — it did not move along with the permission declarations.** `PROJECT_SCOPED_URL` / `RESOURCE_SCOPED_URL` decide which layer the membership gate stops a request at. A URL shape **can't be forgotten**; a declaration can, and read routes have no startup check to catch them. The full route → permission table is kept in `rbac.test.ts` as **assertions**: now that the declarations have moved onto the routes, someone still has to be able to look at "which route needs which permission" all in one place.

**The event bus may only publish after the transaction commits** (`modules/event/bus.ts`). Publishing inside the transaction pushes "moved into Review" to the browser and then rolls the transaction back. `transition()` manages its own outbox; events that aren't state transitions use `emitAndPublish()`. Channel mapping is computed in one place by `channelsFor()` (`project:{id}:board`, `work_item:{id}`, `run:{id}`, `agent:{id}`, `user:{id}:decisions`).

**Don't mix the two kinds of events**: `run_events` is fine-grained logging of agent execution (thousands of rows per run, feeding only the run detail page), while `events` is domain events (the Flow Engine is the sole writer, feeding audit / analytics / notifications). A few key run_events get promoted into domain events.

**PROCESS_ROLE decides which components start** (`apps/api/src/main.ts`). One codebase, three modes: `api` runs HTTP only, `worker` runs the loops only, `all` runs both (the local default). Loops never overlap themselves — if the previous round hasn't finished, this tick is skipped; otherwise a slow query piles up into duplicate dispatches.

**A periodic loop checks "did anything change?" before it writes.** The scheduler re-derives the same conclusion every round (this agent still hasn't been added to the project), and writing unconditionally costs you twice over: the event table fills with dozens of identical rows that bury the real state changes, and "since when" fields like `blockedSince` get refreshed every round, so the duration shown in the UI is permanently 0. The equality function lives next to the reason codes (`sameBlockedDetail`) — when you change a reason code, change it too.

**A run's state lives in the database, not in memory.** After a process restart, the run supervisor takes over orphaned runs by heartbeat timeout (`modules/agent/supervisor.ts`). The intermediate `dispatching` state is necessary: without it there is no way to tell "not dispatched yet" from "dispatched, outcome unknown".

**Runtimes and workspaces are both interfaces**: a new agent runtime implements `AgentRuntimeAdapter` (`packages/agent-runtimes/src/adapter.ts`); a new workspace backend implements the ports in `packages/workspace-providers/src/ports.ts` (that package does not import `@apos/db` — the host injects credential resolution and remote lookups). Callers don't care which runtime they're talking to. **A new runtime also has to implement `CapabilityTranslator`** (`capability-translators.ts`) — an unrecognized runtime falls back to the coarsest tier, rather than reading "unknown" as "supports everything".

**Agent permissions are about capabilities, not tool names.** What the user configures are semantic capabilities like `workspace.write` / `repository.push` / `pull_request.merge` (`AGENT_CAPABILITIES`); translating those into `Read` / `Edit` / `Bash(npm test:*)` is the adapter's job. These three used to be a single `repo:write`, and the risk between them differs by two orders of magnitude — "let the agent edit code" was quietly handing out "let the agent merge code" as well. Whatever the translator can't express must be shown as a downgrade warning; it must never be swallowed.

**Grants are per project, and "not configured" ≠ "no permission".** Permissions live in `project_agent_permissions(project_id, agent_id)`, so the same agent can have two different sets in two projects. The org-level `agents` row keeps only the **ceiling** (`capability_ceiling`; NULL = no ceiling, which means the opposite of an empty array) plus hard denials. The `allowed_tools` / `denied_tools` / `resource_scopes` columns are retired — never written, never read; they survive only because they are the sole record of pre-migration configuration. With nothing configured, an agent falls back to the `full_project` default profile — everything inside the project (edit the workspace, build, test, submit artifacts, push branches, open PRs), and nothing on the other side of the `critical` risk tier (merge, deploy, write to a database, read secrets, change permissions or governance). Not an empty array, and no longer the narrower `standard_executor`: in a system whose default is unusable, the real default becomes whatever config the user copied from somewhere else. The profile's boundary is **derived from the capability catalog's risk tiers**, so a capability added later lands on the correct side without anyone remembering `profiles.ts`. Profiles are **expanded before they're stored**: store just a pointer and one platform-side edit to a profile widens every running agent at once.

**Effective permissions have exactly one evaluator** (`resolveEffectiveAgentAccess`). The scheduler picking candidates, dispatch freezing a snapshot, the UI display, and the pre-save preview all go through it. The cost of a second implementation isn't duplicated code, it's two answers that disagree — "the scheduler says there are no candidates, but dispatching by hand works fine" is close to impossible to reproduce. Permission changes go through `executeGovernedMutation`: read state → determine direction → authorize → validate the reason → transaction → audit, and the order can't be rearranged (authorize first and you don't yet know which permission to require, so the implementation has to demand the broader one, which voids §2.3's asymmetric design on the spot).

**Frontend SSE patching depends on hitting query keys exactly.** Every key comes from the `qk` factory in `apps/web/src/lib/query/keys.ts`; hand-written string arrays eventually drift from the read sites, and the symptom is "the backend pushed but the UI doesn't move". Switching identity or organization invalidates the whole cache — the organization is the multi-tenant boundary. A missing React hook dependency produces the same symptom in an SSE-driven UI, which is why `react-hooks/exhaustive-deps` is on.

**The database connection shape is inferred from the connection string** (`packages/db/src/connection.ts`). Prepared statements can't be used behind the Transaction Pooler (:6543), and guessing wrong shows up in production as random `prepared statement does not exist` errors. Don't run migrations through the Transaction Pooler — use `DATABASE_DIRECT_URL`. The `[db] …` line in the startup log is there so you can check this.

**There are exactly three sources of accounts**: the superadmin from `.env` (bootstrapped at startup, idempotent, and it never overwrites a password that has been changed), accounts opened by an org admin, and self-service signup (`APOS_ALLOW_SIGNUP`, **on by default**, where every signup grows a **new empty organization**). The seed script creates no accounts, and it appends rather than resets.

## Conventions

- Event types: `{subject}.{past tense verb}`, e.g. `work_item.status_changed`
- snake_case in the database (Drizzle's `casing: 'snake_case'` converts automatically), camelCase in the API and the frontend
- Money is always a decimal in string form, never a float
- `any` needs a stated reason (it's an error in eslint); deliberately unused variables take a `_` prefix
- An unrecognized environment variable value has to be shouted about at startup, never silently defaulted — configuration that didn't take effect with no sign of it anywhere is a mistake this repo has made more than once

## Testing Requirements

| What you changed | Tests you must add |
| --- | --- |
| State machine transition rules | The exhaustive and reachability assertions in `machine.test.ts` |
| Agent capability catalog / profiles | Expansion is deterministic; denial beats allowance; a project grant never exceeds the ceiling; project A never leaks into project B |
| A new runtime | The translator has to report the limits it can't cover (downgrade warnings) rather than staying silent |
| Guards | Both the passing and the failing path; on failure the reason has to be readable |
| Policy conditions/actions | Evaluation tests; high-risk actions get a safety-floor test as well |
| Recovery strategies | Every error classification needs an explicit decision |
| Any path that writes status | An integration test asserting "status changed → the matching event exists" |
| A new server reason code | Every code needs wording for how to fix it (including "nothing to fix"); when the UI doesn't recognize a code it falls back to the fallback sentence, not a blank. `ErrorReason` message coverage is backstopped by `errors.test.ts`, so adding a code without a message goes red |
| New UI copy | Use a message key, in `messages/{en,zh}/<area>.ts`. Hard-coded Chinese gets caught by `no-literals.test.ts`; the wrong file gets caught by `structure.test.ts` (which tells you which file it belongs in) |
| A new user-visible sentence from the server | Assert on the **code and the params**, not on the Chinese sentence — an assertion written against the Chinese goes red when you change a comma, while a wrong code is the actual bug |
| A loop that keeps re-deriving the same conclusion | Assert both "reason unchanged → no duplicate event, start time not reset" and "reason changed → a new row recorded" |

The test fixture (`apps/api/src/test/db.ts`) goes through the **real auth path** (`signToken` signs a real token); there is no test-mode bypass. The fixture identity is an org admin + tech_lead, and functional tests use it; **permission assertions always build a person with an explicit role via `createMember()`**, because testing "a viewer can't change this" with the fixture identity is green forever. The fixture must also never be more permissive than real data — the moment it is, it welds the hole permanently open.

## Docs

Read the matching design doc before you change anything; they explain *why* it is the way it is:

- [docs/RUNNING.md](docs/RUNNING.md): running it locally, environment variables, troubleshooting
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), [docs/SUPABASE.md](docs/SUPABASE.md): single-host deployment, moving to a hosted Postgres
- [docs/tech/](docs/tech/README.md): 01 Architecture / 02 Domain Model / 03 Event Model / 04 Flow Engine / 05 Policy Engine / 06 Agent Protocol / 07 API Design / 08 Frontend Architecture / 09 Security / 10 MVP Plan / 11 Workspace Abstraction
- [docs/product/pages/](docs/product/pages/README.md): structure, interaction, state, permissions, and data dependencies across all 14 pages
