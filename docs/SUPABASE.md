# 接 Supabase

把数据库换成 Supabase（或其他托管 Postgres），后端与前端不动。

本机开发见[运行指南](RUNNING.md)，整套自托管见[单机部署](DEPLOYMENT.md)。

> **这不是"迁移到 Supabase"，是让同一份代码两边都能跑。**
> 下面所有改动在本机与 docker-compose 上都是 no-op —— `pnpm test` 跑的就是
> 应用了全部迁移（含 RLS 那条）的库。

---

## 1. 能换和不能换的

| 部分 | 能不能托管出去 | 说明 |
| --- | --- | --- |
| PostgreSQL | ✅ 能 | 用的全是标准 PG16 特性，见下 |
| api / worker 进程 | ❌ 不能 | 常驻循环 + git 子进程 + 工作区磁盘，见 [§6](#6-后端为什么不能一起搬上去) |
| Supabase Auth / RLS 策略 | 不用 | 身份与权限在应用层，见 [§4](#4-把匿名-rest-通道关死) |

数据库这一层没有任何东西挡路：35 张表用的是 enum、`jsonb`、`timestamptz`、
外键、以及 `gen_random_uuid()`（PG13+ 内核自带，不需要 `pgcrypto`）。
没有 `CREATE EXTENSION`、没有 `LISTEN/NOTIFY`、没有 advisory lock。

---

## 2. 三种连接串，选哪个

Supabase 控制台的 **Connect** 里给三条串，区别只在主机与端口：

| 形态 | 端口 | IPv4 | 预编译语句 | 用在哪 |
| --- | --- | --- | --- | --- |
| Direct connection | 5432 | ❌ 仅 IPv6 | 可用 | 迁移（如果你的网络有 IPv6） |
| Session pooler | 5432 | ✅ | 可用 | **迁移**、常驻后端 |
| Transaction pooler | 6543 | ✅ | **不可用** | serverless / 短连接 |

**★ 直连只解析到 IPv6。** 多数容器平台与 CI 是纯 IPv4 环境，那条串在那里
根本连不上 —— 而报错是 `ENETUNREACH`，看起来像网络故障，不像"选错了连接串"。
拿不准就用 Session Pooler。

代码会自己认出你给的是哪一种，不用手工配：

```
[db] aws-0-ap-northeast-1.pooler.supabase.com:6543 Transaction Pooler，TLS(自动)，预编译语句关
```

这行是启动日志的第一行。★ 判定错了要能一眼看出来 —— 认错的表现是**偶发**的
`prepared statement "s1" does not exist`：池子空闲时复用同一条后端连接所以本地
怎么点都是好的，等线上有并发了才开始随机失败。

自动判定的规则与逃生口在 `packages/db/src/connection.ts`，判错时可以用
`?prepare=true` / `?prepare=false` 手工盖过去。

---

## 3. 配置

`.env` 里改这三个：

```bash
# 后端连这条。控制台复制来的 ?supa=base-pooler.x 不用删，代码会剥掉
DATABASE_URL=postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres

# ★★ 迁移单独走一条。DDL 不要过 Transaction Pooler
DATABASE_DIRECT_URL=postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres

# 可选。api 与 worker 各占一个池子，走直连/Session Pooler 时注意总数
APOS_DB_POOL_MAX=5
```

然后跑迁移：

```bash
pnpm db:migrate
```

`DATABASE_DIRECT_URL` 不设就沿用 `DATABASE_URL`；本机与 docker-compose 下
两者本来就是同一个，所以那边什么都不用改。

### 为什么 DDL 不能走 Transaction Pooler

那个池子按**语句**而不是按会话分配后端连接，而迁移依赖会话内的连续性
（建表 → 建索引 → 加外键在同一个事务里）。它不一定当场报错，更常见的是
跑到一半失败 —— 而迁移失败最贵的形态就是"一半应用了"。

指错了 `drizzle-kit` 会在输出里警告，但不会拦你。

### 关于 `?supa=base-pooler.x`

★★ 控制台给的 pooler 连接串尾巴上带这个参数，而 postgres.js 会把它
**当作 Postgres 的启动参数**发给服务端，换来一句
`unrecognized configuration parameter "supa"`。

这个错发生在 TCP 已经连上**之后**，表现为"数据库把我们拒了"，
而连接串是从官方控制台复制的、看上去完全正常 —— 没有人会怀疑到
URL 尾巴上那个参数头上。所以代码会主动剥掉它（以及 Prisma 风格的
`pgbouncer` / `connection_limit` / `pool_timeout`），复制粘贴直接能用。

---

## 4. 把匿名 REST 通道关死

**这是接 Supabase 唯一一件必须做、且做错了完全没有症状的事。**

Supabase 会给 `public` schema 下的**每一张表**自动生成一套 PostgREST 接口，
并默认把权限授给 `anon` / `authenticated`。也就是说，库一迁上去，任何拿到
项目 anon key 的人（那把 key 本来就是给浏览器用的、公开的）可以直接：

```
GET https://<ref>.supabase.co/rest/v1/users?select=*
GET https://<ref>.supabase.co/rest/v1/repositories?select=*
```

把用户表、Agent 运行记录、以及 `repositories` 里加密存放的仓库凭证整张拖走 ——
完全绕开 `apps/api` 那一侧的 JWT 与 RBAC（[09-security](tech/09-security.md)）。

★ 这个洞不会有任何症状：应用照常跑，日志干净，权限矩阵页面上一切正常。
它只有在被人拖库之后才会被发现。

迁移 `0017_supabase_rls` 已经把它关死了，**不需要额外操作**。它做两件事：

1. `public` 下所有表开 RLS，且**一条 policy 都不写**
2. 回收 `anon` / `authenticated` 的表权限，并改掉默认授权

### 为什么开了 RLS 应用还能读写

Postgres 里**表的属主天然绕过 RLS**（除非额外 `FORCE ROW LEVEL SECURITY`）。
建表的是迁移用的角色，后端连的也是它，所以后端完全不受影响 —— 一行业务代码
都不用改。而 `anon` / `authenticated` 不是属主，RLS 一开、policy 一条没有，
它们看到的就是零行。

这也是这条迁移在本机是 no-op 的原因：那边压根没有 `anon` 角色，
第 2 步整个跳过，第 1 步开的 RLS 对属主没有任何影响。

### 两层防护分别挡什么

| 层 | 挡的是 |
| --- | --- |
| 回收默认授权 | 将来新增的表 —— 下次迁移建的表不会再被自动授权，哪怕作者没听说过这件事 |
| RLS | 有人手工 `GRANT` 或在控制台点了按钮之后的兜底：权限有了，但一行也读不到 |

### 启动时还会再查一遍

```
[db] ★ 以下表没有开启 RLS，而这个库上存在 PostgREST 角色 —— 它们可以被匿名 REST 接口直接读取：xxx
```

★ 因为漏掉的后果没有症状，它必须主动喊，而不是等谁想起来去查
（和 `probeGit` 一个道理：环境缺陷要在启动时暴露，不要等第一次真实调用
才以另一种面貌炸出来）。看到这条就补一条迁移：

```sql
ALTER TABLE <表名> ENABLE ROW LEVEL SECURITY;
```

### `service_role` 是有意没碰的

Supabase 还有第三个角色 `service_role`，它带 `BYPASSRLS`，上面两层对它都无效。
这是有意的：那把 key 是**服务端密钥**，和数据库口令属于同一个信任等级
（不像 anon key 会发到浏览器里），而回收它会连带弄坏正常的管理工具。

★ 也就是说，`SUPABASE_SERVICE_ROLE_KEY` 泄露 = 数据库口令泄露。按后者的
规格保管它，别放进任何前端可达的地方。

### 想让某张表走 PostgREST

显式给它写 policy 并授权，而不是回来关掉迁移 0017。
"默认全关，要开就得写明白"是唯一能长期守住的形态。

---

## 5. 免费档的几条硬限制

| 限制 | 数值 | 对这个项目意味着什么 |
| --- | --- | --- |
| 闲置暂停 | 1 周无活动 | 项目被暂停，要去控制台手动唤醒 |
| 数据库大小 | 500 MB | ★ 见下 |
| 活跃项目数 | 2 个 | 开发库 + 生产库正好用完 |
| 直连 IPv4 | 需付费 | 免费档走 pooler，见 [§2](#2-三种连接串选哪个) |

**★ 500 MB 要留意 `events` 表。** 这个产品的每一次状态变更都强制连带写事件
（[CONTRIBUTING](../CONTRIBUTING.md) 的第一条约束），所以它涨得比直觉快得多。
上生产前先想清楚归档策略，别等写满了才发现 —— 库满的表现是写入直接失败，
而这个产品写不进事件就等于状态流转停摆。

查当前占用：

```sql
SELECT relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS size
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 10;
```

---

## 6. 后端为什么不能一起搬上去

数据库托管出去之后，`api` 与 `worker` 仍然需要一台能跑常驻进程的机器。
这不是配置问题，是四条架构约束：

| 约束 | 在哪 |
| --- | --- |
| 五个常驻循环（调度 5s、supervisor 10s、recovery 15s、review 20s、stats 5min） | `apps/api/src/main.ts`、`workers/` |
| 进程内事件总线 —— SSE 订阅与状态变更必须在同一个进程 | `modules/event/bus.ts` |
| SSE 长连接 | `http/sse.ts` |
| git 镜像 / worktree + `spawn` git、ssh-agent、codex | `modules/workspace/`、`packages/agent-runtimes/` |

现成的 `Dockerfile` 直接能用（已经装好 git 与 openssh-client、按
`PROCESS_ROLE` 分角色、处理了 SIGTERM）。把 `docker-compose.yml` 里的
`postgres` 服务去掉、`DATABASE_URL` 指向 Supabase 即可；`redis` 目前没有
代码在读，可以一并去掉。

---

## 7. 排错

### `unrecognized configuration parameter "supa"`

连接串没过 `inspectConnection`。检查是不是绕开 `createDatabase` 直接
`postgres(url)` 了 —— 全仓库的库连接都应该走 `@apos/db` 的 `createDatabase`。

### 偶发 `prepared statement "s1" does not exist`

连的是 Transaction Pooler 但预编译语句没关掉。对一下启动日志第一行说的是不是
`预编译语句关`；不是的话，要么端口不是 6543（自建 PgBouncer 加 `?pgbouncer=true`），
要么被 `?prepare=true` 盖掉了。

### `ENETUNREACH` / 连不上

用的是 Direct connection，而当前环境没有 IPv6。换 Session Pooler。

### `remaining connection slots are reserved` / 请求卡住直到超时

连接数打满了。调小 `APOS_DB_POOL_MAX`，或改走 Transaction Pooler
（它替你复用后端连接）。注意 `api` 与 `worker` 各占一个池子。

### 迁移跑到一半失败

`DATABASE_DIRECT_URL` 没设，DDL 走了 Transaction Pooler。设上再跑一次 ——
drizzle 的迁移是单条事务，失败的那条会整体回滚，重跑安全。
