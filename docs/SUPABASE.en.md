# Using Supabase

*[中文版本 / Chinese version](SUPABASE.md)*

Swap the database for Supabase (or any managed Postgres) without touching the
backend or the frontend.

For local development see the [Running guide](RUNNING.en.md); for a fully
self-hosted setup see [Single-machine deployment](DEPLOYMENT.en.md).

> **This is not "migrating to Supabase", it is letting one codebase run on
> both.** Every change below is a no-op locally and under docker-compose —
> `pnpm test` already runs against a database with every migration applied,
> including the RLS one.

---

## 1. What can and cannot be handed off

| Part | Can it be hosted elsewhere | Notes |
| --- | --- | --- |
| PostgreSQL | ✅ yes | Only standard PG16 features are used, see below |
| api / worker processes | ❌ no | Long-running loops, git subprocesses, workspace disk — see [§6](#6-why-the-backend-cannot-move-too) |
| Supabase Auth / RLS policies | not used | Identity and permissions live in the application layer, see [§4](#4-close-the-anonymous-rest-channel) |

Nothing in the database layer gets in the way: 35 tables using enums, `jsonb`,
`timestamptz`, foreign keys and `gen_random_uuid()` (built into PG13+, no
`pgcrypto` needed). No `CREATE EXTENSION`, no `LISTEN/NOTIFY`, no advisory locks.

---

## 2. Three connection strings — which one

The Supabase console's **Connect** panel gives three strings that differ only in
host and port:

| Form | Port | IPv4 | Prepared statements | Use it for |
| --- | --- | --- | --- | --- |
| Direct connection | 5432 | ❌ IPv6 only | available | Migrations (if your network has IPv6) |
| Session pooler | 5432 | ✅ | available | **Migrations**, long-running backends |
| Transaction pooler | 6543 | ✅ | **unavailable** | serverless / short-lived connections |

**★ The direct connection resolves to IPv6 only.** Most container platforms and
CI runners are IPv4-only, where that string simply cannot connect — and the
error is `ENETUNREACH`, which reads like a network fault rather than "wrong
connection string". When in doubt, use the Session Pooler.

The code works out which one you gave it; there is nothing to configure:

```
[db] aws-0-ap-northeast-1.pooler.supabase.com:6543 Transaction Pooler，TLS(自动)，预编译语句关
```

That is the first line of the startup log. ★ A wrong detection has to be visible
at a glance, because the symptom is an **intermittent**
`prepared statement "s1" does not exist`: while the pool is idle the same
backend connection is reused, so everything works locally, and the random
failures only start once production has concurrency.

The detection rules and the escape hatch live in
`packages/db/src/connection.ts`; `?prepare=true` / `?prepare=false` override it
by hand.

---

## 3. Configuration

Three entries in `.env`:

```bash
# The backend connects with this one. Leave the console's ?supa=base-pooler.x in place — the code strips it
DATABASE_URL=postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres

# ★★ Migrations get their own. DDL must not go through the Transaction Pooler
DATABASE_DIRECT_URL=postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres

# Optional. api and worker each hold a pool; mind the total on direct/session connections
APOS_DB_POOL_MAX=5
```

Then migrate:

```bash
pnpm db:migrate
```

Unset, `DATABASE_DIRECT_URL` falls back to `DATABASE_URL`; locally and under
docker-compose the two are the same anyway, so nothing changes there.

### Why DDL must not go through the Transaction Pooler

That pool assigns backend connections per **statement** rather than per session,
while a migration depends on continuity within a session (create table → create
index → add foreign key, all in one transaction). It does not necessarily fail
outright; more often it fails halfway — and a half-applied migration is the most
expensive failure mode there is.

Pointed at the wrong one, `drizzle-kit` warns in its output but will not stop
you.

### About `?supa=base-pooler.x`

★★ The pooler string from the console carries this parameter, and postgres.js
forwards it to the server **as a Postgres startup parameter**, earning a
`unrecognized configuration parameter "supa"`.

The error happens *after* TCP has connected, so it presents as "the database
rejected us", while the connection string was copied from the official console
and looks perfectly normal — nobody suspects the tail of the URL. So the code
strips it (along with the Prisma-style `pgbouncer` / `connection_limit` /
`pool_timeout`), and copy-paste just works.

---

## 4. Close the anonymous REST channel

**This is the one thing about Supabase you must do, and getting it wrong has no
symptoms at all.**

Supabase auto-generates a PostgREST API for **every table** in the `public`
schema and grants it to `anon` / `authenticated` by default. In other words, the
moment the database moves over, anyone holding the project's anon key (a key
that is meant for browsers and is therefore public) can run:

```
GET https://<ref>.supabase.co/rest/v1/users?select=*
GET https://<ref>.supabase.co/rest/v1/repositories?select=*
```

and walk off with the users table, the Agent run history, and the encrypted
repository credentials in `repositories` — entirely bypassing the JWT and RBAC
in `apps/api` ([09-security](tech/09-security.md)).

★ This hole produces no symptoms: the application runs normally, the logs are
clean, the permission matrix page looks right. It is discovered after the data
has already been taken.

Migration `0017_supabase_rls` already closes it, so **no extra action is
needed**. It does two things:

1. Enables RLS on every table in `public`, and writes **no policy at all**
2. Revokes the `anon` / `authenticated` table grants and changes the default
   privileges

### Why the application still reads and writes with RLS on

In Postgres the **table owner bypasses RLS** by nature (unless you additionally
`FORCE ROW LEVEL SECURITY`). The migration role creates the tables and the
backend connects as that role, so the backend is unaffected — not one line of
business code changes. `anon` / `authenticated` are not the owner, so with RLS on
and no policies, they see zero rows.

That is also why this migration is a no-op locally: there is no `anon` role
there, step 2 is skipped entirely, and the RLS enabled in step 1 has no effect on
the owner.

### What each of the two layers catches

| Layer | What it catches |
| --- | --- |
| Revoking default privileges | Tables added later — the next migration's tables are not auto-granted, even if their author never heard of any of this |
| RLS | The backstop after someone hand-writes a `GRANT` or clicks a button in the console: the privilege exists, but not a single row comes back |

### It is re-checked at startup

```
[db] ★ 以下表没有开启 RLS，而这个库上存在 PostgREST 角色 —— 它们可以被匿名 REST 接口直接读取：xxx
```

★ Because the consequence of missing one is symptomless, it has to shout rather
than wait for someone to think of checking (same principle as `probeGit`:
environment defects surface at startup, not at the first real call wearing a
different face). When you see this, add a migration:

```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
```

### `service_role` is deliberately left alone

Supabase has a third role, `service_role`, which carries `BYPASSRLS`; neither
layer above applies to it. That is deliberate: that key is a **server-side
secret** at the same trust level as the database password (unlike the anon key,
which ships to browsers), and revoking it would break legitimate admin tooling.

★ Which means a leaked `SUPABASE_SERVICE_ROLE_KEY` **is** a leaked database
password. Treat it accordingly, and keep it out of anywhere the frontend can
reach.

### Exposing one table through PostgREST

Write it an explicit policy and grant, rather than coming back to disable
migration 0017. "Closed by default, opened only where stated" is the only shape
that survives.

---

## 5. Free-tier limits that matter

| Limit | Value | What it means here |
| --- | --- | --- |
| Idle pause | 1 week without activity | The project is paused; wake it from the console |
| Database size | 500 MB | ★ see below |
| Active projects | 2 | A development and a production database use it up exactly |
| Direct IPv4 | paid | The free tier goes through the pooler, see [§2](#2-three-connection-strings--which-one) |

**★ Watch the `events` table against that 500 MB.** Every status change in this
product is required to write an event alongside it ([CONTRIBUTING](../CONTRIBUTING.en.md),
first constraint), so it grows much faster than intuition suggests. Decide on an
archiving strategy before production rather than discovering it when the disk
fills — a full database means writes fail outright, and a product that cannot
write events has its status flow stopped dead.

Current usage:

```sql
SELECT relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS size
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 10;
```

---

## 6. Why the backend cannot move too

With the database hosted elsewhere, `api` and `worker` still need a machine that
can run long-lived processes. This is not a configuration matter but four
architectural constraints:

| Constraint | Where |
| --- | --- |
| Five resident loops (scheduling 5s, supervisor 10s, recovery 15s, review 20s, stats 5min) | `apps/api/src/main.ts`, `workers/` |
| An in-process event bus — SSE subscriptions and status changes must share a process | `modules/event/bus.ts` |
| Long-lived SSE connections | `http/sse.ts` |
| git mirrors / worktrees plus spawned git, ssh-agent, codex | `modules/workspace/`, `packages/agent-runtimes/` |

The existing `Dockerfile` works as-is (git and openssh-client installed, roles
split by `PROCESS_ROLE`, SIGTERM handled). Drop the `postgres` service from
`docker-compose.yml` and point `DATABASE_URL` at Supabase; `redis` currently has
no reader and can go too.

---

## 7. Troubleshooting

### `unrecognized configuration parameter "supa"`

The connection string did not pass through `inspectConnection`. Check whether
something calls `postgres(url)` directly instead of going through
`createDatabase` — every database connection in the repository should use
`createDatabase` from `@apos/db`.

### Intermittent `prepared statement "s1" does not exist`

You are on the Transaction Pooler with prepared statements still on. Check
whether the first startup log line says `预编译语句关`; if not, either the port
is not 6543 (a self-hosted PgBouncer needs `?pgbouncer=true`) or `?prepare=true`
is overriding it.

### `ENETUNREACH` / cannot connect

You are using the direct connection in an environment without IPv6. Switch to
the Session Pooler.

### `remaining connection slots are reserved` / requests hang until timeout

Connections are exhausted. Lower `APOS_DB_POOL_MAX`, or move to the Transaction
Pooler (it reuses backend connections for you). Remember that `api` and `worker`
each hold their own pool.

### A migration failed halfway

`DATABASE_DIRECT_URL` was not set and the DDL went through the Transaction
Pooler. Set it and run again — drizzle migrations are single transactions, so a
failed one rolls back entirely and re-running is safe.
