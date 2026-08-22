# Contributing

*[中文版本 / Chinese version](CONTRIBUTING.md)*

## Getting set up

Node 22+ and pnpm 10+.

```bash
pnpm install
docker compose up -d postgres redis   # dependencies only — an unqualified `up -d` starts the whole product
cp .env.example .env

pnpm db:generate              # generate a migration after changing the schema
pnpm db:migrate               # apply migrations
```

Integration tests need a working Postgres. They connect to `TEST_DATABASE_URL`,
defaulting to `postgres://apos@localhost:5433/apos_test` — **note `apos_test`,
not `apos`**. The tests TRUNCATE every table in `beforeEach`, so pointing them at
the development database wipes whatever you were debugging.

Full setup and troubleshooting: [Running guide](docs/RUNNING.md).

```bash
pnpm test                     # everything, including integration tests
pnpm test:watch
pnpm typecheck
pnpm lint
```

`pnpm lint` only enables rules that catch bugs; it says nothing about
formatting. The focus is what the type system cannot see: missing React Hook
dependencies (which show up on SSE-driven screens as "the backend pushed but
this part did not change"), unused imports, and `any` without a stated reason.
The rule set is in `eslint.config.js`, where each rule carries the reason it is
switched on.

## Repository layout

```
packages/
  contracts/   Domain types and Zod schemas shared by both sides (single source of truth)
  domain/      Pure logic: state machine, guards, policy evaluation, recovery. Zero IO
  db/          Drizzle schema, migrations, database client
apps/
  api/         Fastify application and the application-layer modules
docs/          Product, page and technical documentation
```

## Three constraints that must not be broken

These come from the product's positioning, not from taste. Breaking any one of
them costs the product its core value.

### 1. A status change must produce an event

**No code path may run `UPDATE work_items SET status = ...` directly.**

Status changes go through `transition()`, which writes the status and the event
in one transaction. It is the implementation of "every action is traceable"
(product doc 3.2) and the data source behind policy simulation, analytics and
the audit log.

```ts
// ❌ Bypasses the event write and manufactures an audit black hole
await db.update(workItems).set({ status: 'reviewing' }).where(...)

// ✅
await transition(db, { workItemId, trigger: 'agent_run_completed', actor, correlationId })
```

### 2. An Agent is an identity of its own, not a proxy for a person

Every field naming an operator is `(actorType, actorId)`, never `userId`. Agents
hold their own credentials and their own permission set and **must never reuse a
human token** — otherwise the audit log claims a person did it, the permission
scope silently becomes that person's full scope, and Agent permissions can no
longer be tightened on their own.

### 3. Policy evaluation must carry a context snapshot

The `contextSnapshot` on a `policy.evaluated` event is the only data policy
simulation can replay from. **This field cannot be filled in afterward** —
omitting it means the history from that period can never be used to validate a
new rule.

When you add a policy fact, update `buildPolicyContext()` in the same change,
and understand that the fact only holds for data recorded after it.

## Testing requirements

| What you changed | What you must test |
| --- | --- |
| State machine transitions | The exhaustive and reachability assertions in `machine.test.ts` |
| A guard | Both the passing and the failing path; the failure reason must be readable |
| Policy conditions / actions | Evaluation tests; add a safety-floor test when high-risk operations are involved |
| Recovery strategy | Every error class needs an explicit decision |
| Any path that writes status | An integration test asserting "the status changed → the matching event exists" |

**The safety-floor test in `evaluate.test.ts` blocks CI.** It runs an
adversarial rule set across every autonomy level and asserts that the three
`NEVER_AUTO_APPROVE` operation classes are never let through automatically. If
it fails, the governance model has been bypassed and the change cannot merge.

## Naming conventions

- Event types: `{subject}.{past-tense verb}`, e.g. `work_item.status_changed`
- Database: snake_case (Drizzle converts automatically via `casing: 'snake_case'`)
- API: camelCase, matching the frontend TypeScript
- Money: decimal as a string, to avoid floating-point error

## Language

The repository is bilingual — see [CLAUDE.md](CLAUDE.md#语言约定双语) for the
rules. In short: code comments carry both languages, UI strings go through i18n
(`apps/web/src/lib/i18n`) and never appear as literals, the UI defaults to
English, and documents come in pairs (`X.md` / `X.en.md`) that link to each other
from their first line.

A short comment may stay in one language. The test is whether someone who does
not read Chinese would be unable to follow the code without it; the ★ comments
that explain *why* something is the way it is always carry both, because those
are exactly what an outside reader needs.
