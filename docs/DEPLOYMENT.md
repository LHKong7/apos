# 单机部署

把 APOS 完整跑在一台机器上：一条命令、一个对外端口。

本机开发环境见[运行指南](RUNNING.md)，两者用的是**不同的 compose 文件**，互不干扰。

---

## 1. 部署了什么

```
                        ┌──────────── 宿主机唯一对外端口 :8080 ────────────┐
                        │                                                │
  ┌──────────┐   ┌──────┴───────┐   ┌───────────────┐                     │
  │ postgres │←──│ api          │   │ worker        │                     │
  │ (不发布)  │   │ HTTP + SSE   │   │ 调度循环       │                     │
  ├──────────┤   │ + 前端静态资源 │   │ 通知投递       │                     │
  │ redis    │←──│ PROCESS_ROLE │   │ PROCESS_ROLE  │                     │
  │ (不发布)  │   │  = api       │   │  = worker     │                     │
  └──────────┘   └──────────────┘   └───────────────┘                     │
                        ↑                   ↑                             │
                        └── migrate（一次性，跑完退出）──┘                    │
```

| 服务 | 说明 |
| --- | --- |
| `postgres` | 数据。命名卷持久化，**不发布端口** |
| `redis` | 预留给后续的队列与多实例扇出，当前没有代码读它 |
| `migrate` | 一次性容器，跑完迁移退出。api/worker 等它成功才启动 |
| `api` | HTTP + SSE，**并托管前端构建产物**。唯一对外的服务 |
| `worker` | Flow 调度与通知投递循环，不监听端口 |

api 与 worker 是**同一个镜像**，靠 `PROCESS_ROLE` 区分
（[架构文档 §3.1](tech/01-architecture.md)：API 要能随时重启，worker 承载长循环，
混在一起会让部署时正在跑的调度被打断）。

### 为什么前端由 API 进程托管，而不是另起 nginx

因为 SSE。前端的 `EventSource` 不支持自定义请求头，认证只能靠同源 ——
开发环境为此专门配了 Vite 代理。如果生产上把静态资源和 API 拆成两个 origin，
同一个问题会原样回来，还要再配一遍反向代理与 CORS。同进程托管让「同源」
不需要任何配置就成立，单机上也少一个容器。

代价是静态文件走 Node 的事件循环。单机规模下不是瓶颈；真要扩起来，
前面本来就会有 CDN 或网关那一层。

---

## 2. 前置要求

- Docker（含 Compose v2）
- 约 2GB 磁盘：镜像 683MB + 数据卷
- 一个空闲端口，默认 `8080`

不需要在宿主机装 Node、pnpm 或 Postgres —— 全在镜像里。

---

## 3. 起

```bash
docker compose -f compose.deploy.yml up -d --build
```

首次构建要几分钟（装依赖 + 构建前端）。完成后：

```bash
curl localhost:8080/health          # {"ok":true}
```

浏览器打开 <http://localhost:8080> 即是完整产品。

### 灌一份演示数据（可选）

空库的界面上什么都没有。想先看看产品长什么样：

```bash
pnpm deploy:seed
```

会打印看板链接与三个可切换身份。**生产环境不要跑这个** —— 它造的是演示数据。

### 常用命令

```bash
pnpm deploy:up        # = docker compose -f compose.deploy.yml up -d --build
pnpm deploy:logs      # 跟踪 api 与 worker 日志
pnpm deploy:down      # 停止并删除容器（数据卷保留）
```

---

## 4. 配置

所有配置走环境变量。Compose 会自动读项目根目录的 `.env`，也可以
`docker compose --env-file <文件> -f compose.deploy.yml up -d`。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `APOS_PUBLIC_PORT` | `8080` | 宿主机对外端口 |
| `APOS_PUBLIC_URL` | `http://localhost:8080` | **用户实际访问的地址**，见下 |
| `LOG_LEVEL` | `info` | |
| `ANTHROPIC_API_KEY` | 空 | 平台自身用（需求结构化）。不配时用 `StubPlanningProvider`，闭环照样跑通 |
| `APOS_AGENT_ANTHROPIC_API_KEY` | 空 | **Agent 专用凭证，与平台分开**。不配时 Claude Code 运行时拒绝派发 |
| `AGENT_WORKSPACE_ROOT` | 空 | Agent 可写的目录根。不配时 `claude_code` 运行时拒绝派发 |
| `GITHUB_INTEGRATION_TOKEN` | 空 | 不配时 GitHub 集成显示未连接 |
| `INTEGRATION_MEMORY_ADAPTERS` | 空 | 设 `all` 则所有集成走进程内适配器，不发任何外部请求 |

> **`APOS_PUBLIC_URL` 配错的表现很隐蔽**：产品跑得好好的，但飞书/Slack 通知里的
> 链接点进去打不开 —— 因为通知链接是按这个变量拼的。部署到别的机器或加了域名，
> 记得一起改。

> **凭证为什么分两个**：产品文档 10.2 —— Agent 是独立身份，权限独立配置，
> 不复用人类或平台的 token。缺 `APOS_AGENT_ANTHROPIC_API_KEY` 时适配器会
> **明确拒绝派发**，而不是悄悄回退到平台那个 key。这是有意的。

---

## 5. 运维

### 升级

```bash
git pull
docker compose -f compose.deploy.yml up -d --build
```

`migrate` 会先跑并等它成功，api/worker 才会用新镜像起来。迁移是幂等的，
重复部署不会重复执行。

### 备份与恢复

数据全部在 `apos_pgdata` 卷里。

```bash
# 备份
docker compose -f compose.deploy.yml exec -T postgres pg_dump -U apos apos > apos-$(date +%F).sql

# 恢复
docker compose -f compose.deploy.yml exec -T postgres psql -U apos -d apos < apos-2026-08-09.sql
```

### 看日志

```bash
pnpm deploy:logs                                             # api + worker
docker compose -f compose.deploy.yml logs migrate            # 迁移这次做了什么
```

### 连进数据库

Postgres 有意不发布端口，从容器里进：

```bash
docker compose -f compose.deploy.yml exec postgres psql -U apos -d apos
```

### 彻底清掉（含数据）

```bash
docker compose -f compose.deploy.yml down -v
```

---

## 6. 安全

这套配置的定位是**内网单机**，不是公网直接暴露。已经做到的：

- Postgres 与 Redis 都不发布端口，只在 compose 内网可达
- 容器以非 root 的 `node` 用户运行
- `.dockerignore` 排除了 `.env`，本机凭证不会被打进镜像

公网暴露前**至少**还要处理：

1. **认证。** MVP 用 `X-User-Id` 头标识身份（见
   [09 身份、权限与安全](tech/09-security.md)），这**不是**可以对公网开放的认证方式 ——
   任何人改一个头就能变成任何人。上公网必须先接真实身份体系。
2. **HTTPS。** 前面放一层 Caddy / nginx / Traefik 终止 TLS，
   并给 api 设 `TRUST_PROXY=true`，否则日志里的客户端 IP 是反代的地址。
3. Postgres 目前是 `trust` 认证（因为不发布端口）。若要改为发布，先改成密码认证。

---

## 7. 排错

### 起来了但页面白屏，控制台报找不到 `/assets/xxx.js`

浏览器缓存了旧版 `index.html`。正常情况下不该发生 —— `index.html` 是
`no-cache` 而带 hash 的资源才长缓存。如果你在前面加了反代，检查它有没有
自作主张给 HTML 加缓存头。

### 打 API 返回的是一段 HTML

路径写错了。`/api/` 开头的路径永远返回 JSON，包括 404；
返回 HTML 说明请求没走到 `/api/` 前缀（比如少了 `/v1`）。

### api 反复重启

```bash
docker compose -f compose.deploy.yml logs api | tail -30
```

先确认 `migrate` 是 `Exited (0)`。迁移没成功时 api 不会启动，
`docker compose ps -a` 里会看到它卡在 `Created`。

### Agent 页面显示「适配器没有在当前进程注册」

运行时注册表与数据库对不上。api/worker 每 15 秒会自动重扫补注册
（日志里出现 `[runtime] 新注册 N 个运行时`），等一下即可，不必重启。

### 端口被占

```bash
APOS_PUBLIC_PORT=9090 docker compose -f compose.deploy.yml up -d
```

---

## 8. 已知取舍

| 取舍 | 说明 |
| --- | --- |
| 后端跑 TS 源码（tsx）而非 tsc 产物 | 仓库的 workspace 包全部以 `"main": "./src/index.ts"` 暴露，要出 dist 得改 5 个包的入口与互相引用。tsx 底层是 esbuild，加载时剥类型，运行时开销可忽略；代价是镜像里带着源码，冷启动略慢 |
| 镜像 683MB | 装了完整依赖（含构建期用到的）。可以再做一层 `--prod` 裁剪，但单机场景收益有限 |
| 单实例，无高可用 | 符合架构文档的判断：本系统挂掉时正在运行的 Agent Run **不会**停止（它们在外部运行时里），所以关键不是「快速重启」而是「重启后正确接管」 |
| Redis 已起但没被使用 | 留给后续 BullMQ 队列与多实例 SSE 扇出。当前事件扇出走进程内 EventBus |
