# Running guide

*[中文版本 / Chinese version](RUNNING.zh.md)*

Get projectOS running locally, and confirm that it really is running.

Development conventions — the three constraints, testing requirements, naming —
are in [CONTRIBUTING](../CONTRIBUTING.md).

---

## 1. Prerequisites

| Dependency | Version | Notes |
| --- | --- | --- |
| Node | ≥ 22 | `node -v` |
| pnpm | ≥ 10 | pinned via `packageManager`; `corepack enable` is enough |
| Docker | any recent | runs Postgres and Redis |

Without Docker, see [§6](#6-without-docker).

---

## 2. Fastest path

```bash
pnpm install
bash scripts/dev-up.sh
```

`dev-up.sh` does all of this, and every step is idempotent so it can be re-run:

```
Postgres/Redis containers → create the apos and apos_test databases → migrate
→ seed if empty → start the API → start Vite → print an openable board link
```

Output looks like:

```
就绪  API :3000   Web :5173   Postgres :5433   日志 /tmp/apos-dev
项目  订单系统重构  http://localhost:5173/projects/<id>/board
登录  admin@example.com（口令见 .env 的 APOS_SUPERADMIN_PASSWORD）
```

Paste that link into a browser and sign in with the super administrator.

> **Configure the super administrator before the first run.** After
> `cp .env.example .env`, at least these two lines need changing. Self-service
> registration creates a **new empty organization belonging to the registrant**
> and cannot join an existing one, so the first account that can actually
> administer anything has to come from here:
>
> ```
> APOS_SUPERADMIN_EMAIL=admin@example.com
> APOS_SUPERADMIN_PASSWORD=change-me-please
> ```
>
> Without it, the startup log carries `[auth] 没有配置 APOS_SUPERADMIN_EMAIL，且库里没有任何可登录的账号`
> while the UI merely fails to sign in over and over — the frontend gives no
> hint of the cause.

**If a port is taken**, use another one. The script detects the clash and prints
this command for you:

```bash
APOS_API_PORT=3001 bash scripts/dev-up.sh
```

---

## 3. Step by step

Use this when you want to know what each step does, or to start only part of it.

### 3.1 Database

```bash
docker compose up -d postgres redis
```

Postgres listens on **5433**, Redis on 6379, both bound to `127.0.0.1` only.

> **Name those two services explicitly.** `docker-compose.yml` also contains
> api / worker / migrate — an unqualified `docker compose up -d` starts the
> **whole product** (that is the [single-machine deployment](DEPLOYMENT.md)
> path). With both running during development you get two scheduling loops
> competing for the same tasks in the same database.

> **Why 5433 and not 5432**: 5432 usually already has a system or Homebrew
> Postgres sitting on it. A Docker published-port clash **is not reported as an
> error**; the connection silently lands on that unrelated instance and shows up
> as `role "apos" does not exist` — a symptom that points nowhere near the port.
> 5433 is also the default throughout the codebase.

### 3.2 Test database and migrations

The `apos` development database is created by the container. The test database
has to be created separately. **The two must be separate**: tests TRUNCATE every
table in `beforeEach`, so sharing one database means a single test run wipes the
board you were debugging.

```bash
docker compose exec -T postgres psql -U apos -d postgres -c "CREATE DATABASE apos_test"

DATABASE_URL=postgres://apos@localhost:5433/apos      pnpm db:migrate
DATABASE_URL=postgres://apos@localhost:5433/apos_test pnpm db:migrate
```

### 3.3 Seed data

An empty database gives you an empty UI, which looks like nothing started. The
seed builds a project mid-flight: 66 work items, cards awaiting decisions, a
failed card waiting to retry, standalone draggable tasks, roughly 60 days of
history (for analytics), and a Jira/Slack integration.

```bash
DATABASE_URL=postgres://apos@localhost:5433/apos pnpm --filter @apos/api seed
```

> Seeding **appends**, it does not reset. Running it repeatedly accumulates
> projects with the same name; to start clean see [§7](#7-stopping-and-cleaning-up).

**The seed no longer creates accounts.** Every role in the demo data is held by
the super administrator from `.env`. A seed script that can grow ownerless
accounts in the database — no password, nobody responsible, yet a real member of
an organization — is far worse than having no demo data.

The cost is that the demo contains only one person, so "only what needs me",
"decisions cannot be made on someone's behalf" and "what a viewer can see" are
not visible — each needs a second person. To exercise them, sign in and go to
**Project → Members & roles → Accounts → Create account**, create a few with the
pm / sponsor / viewer roles, then sign out and back in as one of them.

### 3.4 API and frontend

```bash
# API
DATABASE_URL=postgres://apos@localhost:5433/apos PORT=3000 pnpm --filter @apos/api start

# Frontend (separate terminal)
pnpm --filter @apos/web dev
```

If the API moved ports, the frontend proxy has to follow, otherwise every page
returns 500 while the API log stays empty:

```bash
API_URL=http://localhost:3001 pnpm --filter @apos/web dev
```

For auto-restart on backend changes, use `pnpm dev:api` (`tsx watch`).

---

## 4. Environment variables

`cp .env.example .env` gives you a commented template. The defaults work; the
table in the [Chinese version](RUNNING.md#4-environment-variables) lists the ones worth
changing, and `.env.example` itself carries the reasoning inline.

The two that most often cause confusion:

- **`APOS_JWT_SECRET`** — unset means each process generates a random key, so
  everyone is signed out on restart, and a multi-replica deployment shows up as
  random disconnects with nothing pointing at configuration.
- **`AGENT_WORKSPACE_ROOT`** — the root for every run's work tree. `.env.example`
  ships it blank, and `source`-ing that gives you an empty string rather than an
  unset variable, so
  [`workspaceRoot()`](../packages/workspace-providers/src/paths.ts) treats empty
  as unset and falls back to `/tmp/apos-workspaces` (`/var/lib/apos/workspaces`
  under Compose). Dispatch is unaffected — but `resolve('')` would have returned
  the process's current directory, which is the repository itself, so the guard
  is what keeps bare mirrors and work trees from growing inside your checkout.
  Read the resolved root off the startup line, not off the variable:
  `[workspace] git version 2.50.1，根目录 /tmp/apos-workspaces`. `/tmp` gets
  swept, which costs a full re-clone of every mirror; point it somewhere
  persistent for anything long-lived.

A dispatch rejected with 「未准备出可用的工作目录」 is unrelated to this
variable: that message comes from the `claude_code` adapter and means the Agent
has no repo resource scope, or the repository was never registered under Code
repositories.

### Model credentials: configured in the UI, not here

Go to **Settings → Agent settings** and register the credential on each Agent.
It is stored on the `agents` row, encrypted when `APOS_SECRET_KEY` is set, and
never echoed back by the API.

Putting it in an environment variable means one key for the whole deployment:
you cannot swap one Agent's key, cannot disable a single key, and the audit
trail cannot tell you which Agent used it. That is why `.env.example` does not
list those variables.

Two levels of environment fallback remain in the code, for a deployment that has
not created any Agent yet — see the table in
[RUNNING.md](RUNNING.md#model-credentials-configured-in-the-ui-not-here).

Requirement structuring and plan generation use the same mechanism: the platform
calls no model API of its own. It picks one of the **project's own agent members**
and uses that Agent's credential. Order of preference: the agent named on the
requirement (the "PRD author" dropdown on the requirement page) → the project's
planner binding (primary, then fallbacks) → any agent member of the project, the
runnable ones first and then in creation order. Nothing an agent declares about
itself takes part in the choice: membership decides who is eligible, and the
planner binding decides who is preferred.

---

## 5. Confirming it actually works

### 5.1 Static checks and tests

```bash
pnpm typecheck
pnpm lint
pnpm test        # includes integration tests against a real database
pnpm build
```

`pnpm test` needs no environment variables — the defaults line up with the
database `docker compose` starts.

### 5.2 Browser smoke test

Everything unit tests cannot reach lives here: SSE-driven card movement, drop
validity, how "decisions cannot be delegated" behaves in the UI, the real
execution-graph layout. 111 checks.

```bash
npx playwright install chromium      # once

API_URL=http://localhost:3000 \
APOS_SUPERADMIN_EMAIL=admin@example.com \
APOS_SUPERADMIN_PASSWORD=change-me-please \
CHROMIUM_PATH="$(node -e "console.log(require('playwright').chromium.executablePath())")" \
node apps/web/scripts/smoke.mjs <projectId>
```

> The smoke script signs in for a fresh token and writes it into the browser's
> localStorage. Without credentials it simply stops at the login page, and every
> assertion then fails with "board not found" — pointing in entirely the wrong
> direction. Credentials can also be given separately via `APOS_SMOKE_EMAIL` /
> `APOS_SMOKE_PASSWORD`.

Use the `<projectId>` printed by `dev-up.sh` or the seed. All green is
`111/111 项通过`.

> **Smoke tests need fresh seed data.** These checks really do approve
> decisions, approve plans and edit requirements — they mutate their own
> fixture. Running twice against the same project fails the second time on
> "critical path banner reports duration and main cause": the first run already
> approved the blocking decision, so the graph genuinely has no main cause left
> to report. That is not a bug; seed a new project and run again.

---

## 6. Without Docker

`scripts/pg-dev.sh` starts a development instance using the host's Postgres,
**Linux only** (it depends on `useradd` / `runuser` /
`/usr/lib/postgresql/16/bin`). `dev-up.sh` falls back to it when it cannot find
a Docker daemon.

macOS has no such fallback — install Docker Desktop or OrbStack.

---

## 7. Stopping and cleaning up

```bash
pkill -f "cli.mjs src/main.ts"     # stop the API (matches tsx's real command line, not the script name)
pkill -f vite                      # stop the frontend

docker compose stop                # stop containers, keep the data
docker compose down -v             # drop the volumes too; the next dev-up.sh rebuilds and re-seeds
```

---

## 8. Troubleshooting

### `role "apos" does not exist` on startup

Whatever is on 5433 is not this project's Postgres. Usually another instance has
the port — a Docker published-port clash is not reported, and the connection
silently lands there.

```bash
lsof -nP -iTCP:5433 -sTCP:LISTEN
APOS_PGPORT=5434 bash scripts/dev-up.sh     # use another port
```

### Every page returns 500 but the API log is empty

The requests never reached the API. Usually the API moved ports while the Vite
proxy still points at 3000:

```bash
API_URL=http://localhost:<actual port> pnpm --filter @apos/web dev
```

### The API will not start, or health checks pass but nothing works

Check whether an unrelated service holds the port. This is the hardest case to
diagnose: the API exits in the background with `EADDRINUSE`, while the health
check connects to whatever else is on that port and **passes**, so the error
only surfaces much later.

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN
APOS_API_PORT=3001 bash scripts/dev-up.sh
```

`dev-up.sh` now checks before starting and tells you which port to switch to.
Logs are in `/tmp/apos-dev/`.

### "Adapter not registered in this process" on the Agent page, nothing dispatches

The runtime registry disagrees with the database. `seed` inserts a fresh
`agent_runtimes` row (new UUID) each time.

The API rescans and re-registers every 15 seconds; the log shows
`[runtime] 新注册 N 个运行时`. **Wait a moment — no restart needed.** Restart the
API to make it immediate. If you turn the sync off with
`RUNTIME_SYNC_INTERVAL_MS=0`, adding a runtime does require a restart.

### Claude Code Agent returns 401 / cannot reach the official endpoint

To use a relay or a self-hosted gateway, configure it under **Agent settings →
Runtime**. The credential and the endpoint each have their own field; everything
else goes into the single **Runtime configuration (JSON)** box:

```json
{
  "model": "claude-opus-5",
  "credentialEnv": "ANTHROPIC_AUTH_TOKEN",
  "env": {
    "ANTHROPIC_BASE_URL": "https://gw.example.com",
    "ANTHROPIC_AUTH_TOKEN": "sk-…"
  }
}
```

- **Endpoint** (its own field) → injected as `ANTHROPIC_BASE_URL`
- **`credentialEnv`** → which variable the credential is delivered in. The
  official endpoint wants `ANTHROPIC_API_KEY`; most relays want
  `ANTHROPIC_AUTH_TOKEN`. **Getting this wrong is a 401, and nothing in the 401
  points at it.**
- **`env`** → any other variables, passed through to the child process,
  overriding platform defaults of the same name

Keys the platform does not recognize are **stored and passed through unchanged**
rather than dropped, so a new runtime switch does not have to wait for a
platform release. After saving, the UI lists the unrecognized keys so you can
confirm none of them is a typo. The "Configurable options" reference below the
box lists the keys the platform knows, with ranges and defaults.

Values under `env` whose key looks like a credential (containing `TOKEN` / `KEY`
/ `SECRET` / `AUTH`) echo back as `secret://saved` — storing that placeholder
unchanged means "leave this one alone". With `APOS_SECRET_KEY` set they are
encrypted at rest; without it they are stored in plaintext (the API never echoes
either). To keep a value out of the database entirely, write `env:VARIABLE_NAME`.

If an Agent shows red with "environment variable X: variable Y is not set", an
`env:` reference cannot be resolved — that variable **will not** be delivered.
Set it first.

### Lots of "not connected" in the UI

That is **deliberate**, not broken. CI results and security scans genuinely are
not wired up, so those metrics read "not connected" rather than 0 — showing 0
would be taken as "it really is zero", which is misleading. The policy health
section separately flags which rules depend on a disconnected source and can
therefore never fire.

### An integration cannot connect, but `curl` works

This happens when outbound traffic goes through a proxy: Node's built-in `fetch`
**does not honor `HTTPS_PROXY`**. The code already handles it via
`proxyAwareFetch()`; just make sure the process can see the proxy environment
variables.

### Running fully offline

```bash
INTEGRATION_MEMORY_ADAPTERS=all pnpm --filter @apos/api start
```

Every integration goes through an in-process adapter and no external request is
made.
