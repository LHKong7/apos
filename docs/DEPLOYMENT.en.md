# Single-machine deployment

*[中文版本 / Chinese version](DEPLOYMENT.md)*

Run all of APOS on one host: one command, one exposed port.

For a local development environment see the [Running guide](RUNNING.en.md). Both
share the **same** `docker-compose.yml`: deployment starts every service, while
development starts only `postgres redis` and runs the rest on the host.

---

## 1. What gets deployed

```
                        ┌────────── the host's only exposed port :8080 ──────────┐
                        │                                                        │
  ┌──────────┐   ┌──────┴───────┐   ┌───────────────┐                             │
  │ postgres │←──│ api          │   │ worker        │                             │
  │ (local)  │   │ HTTP + SSE   │   │ scheduling    │                             │
  ├──────────┤   │ + static UI  │   │ notifications │                             │
  │ redis    │←──│ PROCESS_ROLE │   │ PROCESS_ROLE  │                             │
  │ (local)  │   │  = api       │   │  = worker     │                             │
  └──────────┘   └──────────────┘   └───────────────┘                             │
                        ↑                   ↑                                     │
                        └── migrate (one-shot, exits when done) ──┘               │
```

| Service | What it is |
| --- | --- |
| `postgres` | The data. Persisted in a named volume; the port binds to **`127.0.0.1` only** (see [§6](#6-security)) |
| `redis` | Reserved for the queue and multi-instance fan-out; no code reads it yet. Also `127.0.0.1` only |
| `migrate` | One-shot container; runs the migrations and exits. api/worker wait for it to succeed |
| `api` | HTTP + SSE, **and serves the frontend build**. The only externally reachable service |
| `worker` | Flow scheduling and notification delivery loops; listens on no port |

api and worker are the **same image**, told apart by `PROCESS_ROLE`
([architecture §3.1](tech/01-architecture.md): the API must be restartable at
any time while the worker carries long-running loops, and mixing them means a
deployment interrupts scheduling that is mid-flight).

### Why the API process serves the frontend instead of a separate nginx

Because of SSE. The frontend's `EventSource` cannot send custom headers, so
authentication depends on same-origin — development configures a Vite proxy
purely for this. Splitting static assets and API into two origins in production
brings the same problem straight back, plus a reverse proxy and CORS to
configure. Serving both from one process makes "same origin" true with no
configuration at all, and saves a container on a single host.

The cost is that static files go through Node's event loop. At single-host scale
that is not the bottleneck; anything larger already has a CDN or gateway in
front.

---

## 2. Prerequisites

- Docker (with Compose v2)
- Around 2GB of disk: a 683MB image plus the data volume
- One free port, `8080` by default

Node, pnpm and Postgres are not needed on the host — they are all in the image.

---

## 3. Starting it

```bash
docker compose up -d --build
```

With no service names this is the full set: postgres, redis, migrate, api and
worker all start. There is only **one** compose file in the repository, so no
`-f` is needed.

The first build takes a few minutes (dependencies plus the frontend build).
Then:

```bash
curl localhost:8080/health          # {"ok":true}
```

Open <http://localhost:8080> for the complete product.

### Load demo data (optional)

An empty database gives an empty UI. To see what the product looks like first:

```bash
pnpm deploy:seed
```

It prints a board link and three identities you can switch between. **Do not run
this in production** — it creates demo data.

### Everyday commands

```bash
pnpm deploy:up        # = docker compose up -d --build
pnpm deploy:logs      # follow the api and worker logs
pnpm deploy:down      # stop and remove containers (volumes are kept)
```

---

## 4. Configuration

Everything is configured through environment variables. Compose reads `.env`
from the repository root automatically, or use
`docker compose --env-file <file> up -d`. The full table is in the
[Chinese version](DEPLOYMENT.md#4-配置); the entries worth calling out:

| Variable | Default | Notes |
| --- | --- | --- |
| `APOS_PUBLIC_PORT` | `8080` | The host port |
| `APOS_PUBLIC_URL` | `http://localhost:8080` | **The address users actually visit** — see below |
| `AGENT_WORKSPACE_ROOT` | `/var/lib/apos/workspaces` | The root Agents may write to. Compose supplies this default and backs it with the `workspaces` volume, so leaving it unset still dispatches; moving it means moving the volume too |
| `APOS_DB_POOL_MAX` | `10` | Pool size per process. `api` and `worker` take one each; lower it when a managed database is short on connections |

> **Getting `APOS_PUBLIC_URL` wrong fails quietly**: the product works fine, but
> links in Feishu/Slack notifications do not open — those links are built from
> this variable. Update it when you deploy to another host or add a domain.

> **Model credentials are not configured here.** Register them per Agent under
> Settings → Agent settings. An environment variable would be one key for the
> whole deployment: no per-Agent rotation, no way to disable one key, and no
> audit trail of which Agent used it. Product doc 10.2 — an Agent is an identity
> of its own and does not reuse a human or platform token. See
> [RUNNING.en.md § Model credentials](RUNNING.en.md#model-credentials-configured-in-the-ui-not-here).

---

## 5. Operations

### Upgrading

```bash
git pull
docker compose up -d --build
```

`migrate` runs first and must succeed before api/worker come up on the new
image. Migrations are idempotent, so redeploying does not re-run them.

### Backup and restore

All data lives in the `apos_pgdata` volume.

```bash
# backup
docker compose exec -T postgres pg_dump -U apos apos > apos-$(date +%F).sql

# restore
docker compose exec -T postgres psql -U apos -d apos < apos-2026-08-09.sql
```

### Logs

```bash
pnpm deploy:logs                       # api + worker
docker compose logs migrate            # what this migration run did
```

### Getting into the database

```bash
docker compose exec postgres psql -U apos -d apos
```

With psql on the host, `psql -h 127.0.0.1 -p 5433 -U apos -d apos` also works —
the port is published on the loopback address, which is what local development
and `pnpm test` rely on.

### Wiping everything, data included

```bash
docker compose down -v
```

---

## 6. Security

This configuration targets **a single machine on an internal network**, not
direct exposure to the internet. What is already in place:

- Postgres and Redis ports bind to **`127.0.0.1` only**, so other machines on
  the segment cannot reach them
- Containers run as the non-root `node` user
- `.dockerignore` excludes `.env`, so local credentials never enter the image

> **Why the database publishes a port at all.** Development and `pnpm test`
> connect to it directly from the host, and one compose file serving both uses
> cannot avoid it. The cost is that any process on the host can connect without
> a password (`trust` authentication) — which is exactly why it binds to
> loopback rather than `0.0.0.0`. The latter would hand a password-free database
> to the entire network segment.

Before exposing this publicly you need **at least**:

1. **Authentication.** Identity is email + password exchanged for a JWT (see
   [09 Identity, permissions & security §1.0](tech/09-security.md#10-人类凭证与账号来源)).
   Three things are mandatory before going public:
   - **Set `APOS_JWT_SECRET`.** Unset, each process generates a random key, so
     in a multi-replica deployment a token signed by replica A fails on replica
     B — which presents as random disconnects.
   - **Change the super administrator's initial password** in `.env`, or change
     it in the UI after signing in.
   - Understand that tokens are **stateless**: changing a password or disabling
     an account does not invalidate already-issued tokens; that takes up to
     `APOS_JWT_TTL_SECONDS` (12 hours by default). Forcing everyone out
     immediately means rotating `APOS_JWT_SECRET` and restarting, which signs
     out every user at once.

   Not yet present: MFA, SSO, login rate limiting, session revocation.
2. **HTTPS.** Terminate TLS with Caddy / nginx / Traefik in front, and set
   `TRUST_PROXY=true` on the api, otherwise the client IP in the logs is the
   proxy's.
3. Postgres currently uses `trust` authentication. Switch it to password
   authentication before binding it anywhere beyond loopback.

---

## 7. Troubleshooting

### It starts but the page is blank, console cannot find `/assets/xxx.js`

The browser cached an old `index.html`. This should not normally happen —
`index.html` is `no-cache` while hashed assets are cached long-term. If you put
a reverse proxy in front, check whether it is adding cache headers to HTML on
its own initiative.

### Hitting the API returns HTML

Wrong path. Anything under `/api/` always returns JSON, including 404s; getting
HTML back means the request never matched the `/api/` prefix (a missing `/v1`,
for instance).

### api restarts in a loop

```bash
docker compose logs api | tail -30
```

First check that `migrate` shows `Exited (0)`. api does not start until the
migration succeeds; `docker compose ps -a` shows it stuck at `Created`.

### "Adapter not registered in this process" on the Agent page

The runtime registry disagrees with the database. api/worker rescan and
re-register every 15 seconds (the log shows `[runtime] 新注册 N 个运行时`). Wait
a moment; no restart is needed.

### Port already in use

```bash
APOS_PUBLIC_PORT=9090 docker compose up -d
```

---

## 8. Known trade-offs

| Trade-off | Why |
| --- | --- |
| The backend runs TypeScript source via tsx rather than compiled output | Every workspace package exposes `"main": "./src/index.ts"`; producing a `dist` would mean changing the entry point and cross-references of five packages. tsx is esbuild underneath and strips types at load, so runtime overhead is negligible; the cost is source in the image and a slightly slower cold start |
| 683MB image | Full dependencies, including build-time ones. A `--prod` pruning layer is possible but buys little at single-host scale |
| Single instance, no HA | Consistent with the architecture doc: when this system goes down, in-flight Agent runs **do not** stop (they live in external runtimes), so what matters is not "restart fast" but "take over correctly after restarting" |
