# 运行指南

把 projectOS 在本机跑起来，并确认它真的跑起来了。

开发约定（三条不可违反的约束、测试要求、命名）见 [CONTRIBUTING](../CONTRIBUTING.md)。

---

## 1. 前置要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node | ≥ 22 | `node -v` |
| pnpm | ≥ 10 | 仓库用 `packageManager` 锁定，`corepack enable` 即可 |
| Docker | 任意近期版本 | 用来跑 Postgres 与 Redis |

没有 Docker 也能跑，见 [§6 没有 Docker 的情况](#6-没有-docker-的情况)。

---

## 2. 最快路径

```bash
pnpm install
bash scripts/dev-up.sh
```

`dev-up.sh` 依次做完这些，每一步都幂等，可以反复跑：

```
Postgres/Redis 容器 → 建 apos 与 apos_test 两个库 → 迁移 → 空库时灌种子数据
→ 启动 API → 启动 Vite → 打印可直接打开的看板链接
```

跑完输出：

```
就绪  API :3000   Web :5173   Postgres :5433   日志 /tmp/apos-dev
项目  订单系统重构  http://localhost:5173/projects/<id>/board
登录  admin@example.com（口令见 .env 的 APOS_SUPERADMIN_PASSWORD）
```

把那个链接贴进浏览器，用超管账号登录。

> **先配超管再跑。** `cp .env.example .env` 之后至少要改这两行 ——
> 自助注册开的是注册者**自己的新空组织**，进不到已有组织里，
> 所以第一个能管事的账号只能来自这里（[§4](#4-环境变量)、
> [09-security §1.0](tech/09-security.md#10-人类凭证与账号来源)）：
>
> ```
> APOS_SUPERADMIN_EMAIL=admin@example.com
> APOS_SUPERADMIN_PASSWORD=change-me-please
> ```
>
> 没配的话，启动日志里会有一条
> `[auth] 没有配置 APOS_SUPERADMIN_EMAIL，且库里没有任何可登录的账号`，
> 而界面上只是登录反复失败 —— 从前端完全看不出原因。

**端口被占时**换一个，脚本会在检测到占用时直接告诉你这条命令：

```bash
APOS_API_PORT=3001 bash scripts/dev-up.sh
```

---

## 3. 手动分步

想知道每一步在做什么，或者只想起其中一部分时用。

### 3.1 起数据库

```bash
docker compose up -d postgres redis
```

Postgres 在 **5433**，Redis 在 6379，都只绑 `127.0.0.1`。

> **要点名这两个服务。** `docker-compose.yml` 里还有 api / worker / migrate ——
> 不带服务名的 `docker compose up -d` 起的是**完整产品**（那是
> [单机部署](DEPLOYMENT.md) 的用法）。开发时两边都跑着，会有两套调度循环
> 抢同一个数据库里的任务。

> **为什么是 5433 而不是 5432**：5432 上通常已经蹲着一个系统自带或 Homebrew 装的
> Postgres。Docker 发布端口冲突时**不会报错**，连接会静默落到那个不相干的实例上，
> 表现为 `role "apos" does not exist` —— 这个症状完全不指向端口。
> 5433 也是全仓库代码里的默认值。

### 3.2 建测试库并迁移

开发库 `apos` 由容器自动创建，测试库要单独建。
**两个库必须分开**：测试在 `beforeEach` 里 TRUNCATE 全表，共用一个库的话，
跑一次测试就会把正在调试的看板数据清空。

```bash
docker compose exec -T postgres psql -U apos -d postgres -c "CREATE DATABASE apos_test"

DATABASE_URL=postgres://apos@localhost:5433/apos      pnpm db:migrate
DATABASE_URL=postgres://apos@localhost:5433/apos_test pnpm db:migrate
```

### 3.3 灌种子数据

空库的界面上什么都没有，看起来像没跑起来。种子数据造的是一个进行中的项目：
66 个任务、待决策的卡片、失败待重试的卡片、可拖拽的独立任务、
近 60 天的历史数据（供 Analytics）、以及一套 Jira/Slack 集成。

```bash
DATABASE_URL=postgres://apos@localhost:5433/apos pnpm --filter @apos/api seed
```

> 种子是**追加**不是重置。反复跑会攒出多个同名项目，要干净重来见 [§7 清理](#7-停止与清理)。

**种子不再造账号。** 演示数据里所有角色都由 `.env` 里那个超管担任 ——
一个能在库里长出无主账号（没有口令、没人管、却是真实组织成员）的种子脚本，
比没有演示数据糟得多。

代价是演示里只有一个人，于是「只看需我处理」「决策不可代行」「viewer 的只读」
这几类行为看不出来 —— 它们都需要第二个人。要验证的话，登录后到
**项目 → 成员与角色 → 账号 → 开账号** 建几个号，分别给 pm / sponsor / viewer
角色，再退出登录换人进来。

### 3.4 起 API 与前端

```bash
# API
DATABASE_URL=postgres://apos@localhost:5433/apos PORT=3000 pnpm --filter @apos/api start

# 前端（另开一个终端）
pnpm --filter @apos/web dev
```

API 换了端口的话，前端的代理要跟上，否则页面会全线 500 而 API 日志里什么都没有：

```bash
API_URL=http://localhost:3001 pnpm --filter @apos/web dev
```

改后端代码想自动重启用 `pnpm dev:api`（`tsx watch`）。

---

## 4. 环境变量

`cp .env.example .env` 拿到一份带注释的模板。默认值就能跑，下面这些是需要改时才动的。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://apos@localhost:5433/apos` | 开发库 |
| `TEST_DATABASE_URL` | `postgres://apos@localhost:5433/apos_test` | **必须与上面不同**，测试会清表 |
| `PORT` | `3000` | API 端口 |
| `API_URL` | `http://localhost:3000` | Vite `/api` 代理指向哪儿 |
| `APOS_SUPERADMIN_EMAIL` | — | **必填**。第一个账号。进已有组织只能靠管理员拉人（自助注册只会开新组织），而第一个管理员只能来自这里 |
| `APOS_SUPERADMIN_PASSWORD` | — | **必填**。**初始**口令，只在建号那一次用；之后在界面上改了，重启不会被打回去 |
| `APOS_SUPERADMIN_NAME` | `超级管理员` | 显示名 |
| `APOS_SUPERADMIN_ORG` | `默认组织` | 自举时他还不属于任何组织的话，用这个名字建一个 |
| `APOS_ALLOW_SIGNUP` | 开 | 自助注册总开关。注册开的是注册者**自己的新空组织**。认不出来的取值一律按**关**处理，并在启动日志里说明 |
| `APOS_JWT_SECRET` | — | 令牌签名密钥。不设置就每进程随机生成：**重启后所有人要重新登录**，多副本部署会表现为随机掉线 |
| `APOS_JWT_TTL_SECONDS` | `43200` | 令牌有效期。令牌无状态，改口令 / 停用账号都要等它自然过期，所以不宜太长 |
| `RUNTIME_SYNC_INTERVAL_MS` | `15000` | 多久重新扫一次数据库里的 Agent 运行时，`0` 关闭 |
| `INTEGRATION_MEMORY_ADAPTERS` | — | 设成 `all` 强制所有集成走进程内适配器（离线开发／演示） |
| `REDIS_URL` | `redis://localhost:6379` | 目前**还没有代码读它**，留给后续的 BullMQ 队列与多实例 SSE 扇出 |
| `ANTHROPIC_API_KEY` | — | 平台自身用（需求结构化）。不设时用 `StubPlanningProvider`，闭环照样跑通 |
| `APOS_AGENT_ANTHROPIC_API_KEY` | — | **Agent 专用**，与平台分开。不设时 Claude Code 运行时拒绝派发，不会悄悄回退到上面那个 key |
| `AGENT_WORKSPACE_ROOT` | — | Agent 可写的目录根。不设时 `claude_code` 运行时拒绝派发 |
| `APOS_ARCHIVE_ROOT` | — | 本地目录类工作区的归档根。**必须与上面不同且不在它下面**（否则 `pruneOrphans` 会连产物一起删）。不设时这类工作区退回「不交货」 |

`dev-up.sh` 另外认这几个：`APOS_PGPORT`(5433)、`APOS_API_PORT`(3000)、
`APOS_WEB_PORT`(5173)、`APOS_REDIS_PORT`(6379)、`APOS_LOG_DIR`(`/tmp/apos-dev`)。

---

## 5. 确认它真的跑起来了

### 5.1 静态检查与测试

```bash
pnpm typecheck
pnpm lint
pnpm test        # 941 个，含跑真数据库的集成测试
pnpm build
```

`pnpm test` 不需要设任何环境变量 —— 默认值与 `docker compose` 起的库是对齐的。

### 5.2 浏览器冒烟

单元测试碰不到的东西都在这里：SSE 推动的卡片移动、拖拽落点判定、
「决策不可代行」在界面上的表现、执行图的真实布局。111 项检查。

```bash
npx playwright install chromium      # 只需一次

API_URL=http://localhost:3000 \
APOS_SUPERADMIN_EMAIL=admin@example.com \
APOS_SUPERADMIN_PASSWORD=change-me-please \
CHROMIUM_PATH="$(node -e "console.log(require('playwright').chromium.executablePath())")" \
node apps/web/scripts/smoke.mjs <projectId>
```

> 冒烟脚本自己先登录换一张令牌，再把它写进浏览器的 localStorage ——
> 不给凭证的话它只会停在登录页，而那时所有断言都失败在「找不到看板」上，
> 指向完全错误的方向。凭证也可以用 `APOS_SMOKE_EMAIL` / `APOS_SMOKE_PASSWORD`
> 单独指定。

`<projectId>` 用 `dev-up.sh` 或 seed 输出里的那个。全绿是 `111/111 项通过`。

> **冒烟要用新鲜的种子数据。** 这套检查会真的批准决策、批准计划、修改需求 ——
> 它改的是自己的夹具。同一个项目连跑两次，第二次「关键路径信息条给出工期与主因」
> 会失败：第一次已经把那条阻塞的决策批掉了，图上确实不再有「主因」可报。
> 这不是 bug，重新 seed 一个项目再跑即可。

---

## 6. 没有 Docker 的情况

`scripts/pg-dev.sh` 用宿主机的 Postgres 起一个开发实例，**仅限 Linux**
（依赖 `useradd` / `runuser` / `/usr/lib/postgresql/16/bin`）。
`dev-up.sh` 在检测不到 Docker daemon 时会自动走它。

macOS 上没有这条退路，请装 Docker Desktop 或 OrbStack。

---

## 7. 停止与清理

```bash
pkill -f "cli.mjs src/main.ts"     # 停 API（匹配的是 tsx 的真实命令行，不是脚本名）
pkill -f vite                      # 停前端

docker compose stop                # 停容器，数据留着
docker compose down -v             # 连数据卷一起删，下次 dev-up.sh 会重新建库并灌种子
```

---

## 8. 排错

### 起服务时报 `role "apos" does not exist`

5433 上不是这个项目的 Postgres。多半是端口被别的实例占了 —— Docker 发布端口
冲突时不报错，连接会静默落到那一个上。

```bash
lsof -nP -iTCP:5433 -sTCP:LISTEN
APOS_PGPORT=5434 bash scripts/dev-up.sh     # 换一个
```

### 页面全线 500，但 API 日志里什么都没有

请求根本没到 API。通常是 API 换了端口而 Vite 代理还指着 3000：

```bash
API_URL=http://localhost:<实际端口> pnpm --filter @apos/web dev
```

### API 起不来 / 健康检查通过但功能不对

先看端口是不是被无关服务占了。这种情况最难查：API 以 `EADDRINUSE` 在后台退出，
而健康检查会连上那个占着端口的服务并**通过**，错误一路传到很后面才暴露。

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN
APOS_API_PORT=3001 bash scripts/dev-up.sh
```

`dev-up.sh` 现在会先检查再启动，直接告诉你换哪个端口。日志在 `/tmp/apos-dev/`。

### Agent 页面显示「适配器没有在当前进程注册」，任务派不出去

运行时注册表与数据库对不上。`seed` 每次都会插一条新的 `agent_runtimes`（新 UUID）。

API 会每 15 秒自动重扫一次并补注册，日志里会出现 `[runtime] 新注册 N 个运行时`，
**等一下即可，不需要重启**。想立刻生效就重启 API；
把 `RUNTIME_SYNC_INTERVAL_MS=0` 关掉自动同步的话，加运行时就必须重启。

### 界面上一堆「未接入」

这是**故意的**，不是坏了。CI 测试结果、安全扫描这些数据源确实没接，
所以相关指标显示「未接入」而不是显示 0 —— 显示 0 会被当成「真的是 0」，那是误导。
Policy 体检区会单独标出哪些规则依赖了没接的数据源，因而永远不会命中。

### 集成连不上，但 `curl` 是通的

出网要过代理时会这样：Node 内置 `fetch` **不认 `HTTPS_PROXY`**。
代码里已经用 `proxyAwareFetch()` 处理，确认进程能读到代理环境变量即可。

### 想完全离线跑

```bash
INTEGRATION_MEMORY_ADAPTERS=all pnpm --filter @apos/api start
```

所有集成走进程内适配器，不发任何外部请求。
