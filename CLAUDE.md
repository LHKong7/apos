# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

APOS（Autonomous Project OS）—— 面向 Human–Agent 混合团队的项目操作系统。pnpm workspace 单体仓库，Node 22 + TypeScript，模块化单体架构。

仓库内文档与代码注释一律用中文，提交信息也是。跟着写。

## 常用命令

```bash
pnpm install
bash scripts/dev-up.sh          # 一键：容器 → 建两个库 → 迁移 → 空库时灌种子 → API → Vite
                                # 端口被占时换：APOS_API_PORT=3001 bash scripts/dev-up.sh

pnpm test                       # 全部测试（含集成测试，需要 Postgres）
pnpm test apps/api/src/http/routes.test.ts     # 单个文件
pnpm test -t "viewer 不能改状态"                # 按用例名
pnpm typecheck                  # pnpm -r typecheck
pnpm lint                       # 只开会变成 bug 的规则，不管格式（理由写在 eslint.config.js）

pnpm dev:api                    # tsx watch，改后端自动重启
pnpm --filter @apos/web dev     # 前端；API 换了端口要跟上：API_URL=http://localhost:3001 …
pnpm --filter @apos/web smoke <projectId>   # Playwright 冒烟，需要 API + dev server 都起着

pnpm db:generate                # 改了 schema/core.ts 之后生成迁移
DATABASE_URL=postgres://apos@localhost:5433/apos pnpm db:migrate
DATABASE_URL=postgres://apos@localhost:5433/apos pnpm --filter @apos/api seed
```

只起依赖容器要**点名**：`docker compose up -d postgres redis`。不点名的 `docker compose up -d` 起的是完整产品（api / worker / migrate），会和本机 dev 进程抢同一个库里的任务，出现两套调度循环重复派发。完整部署是 `docker compose up -d --build`，对外只有一个端口（默认 8080，同时提供前端与 API）。

集成测试连 `TEST_DATABASE_URL`（默认 `postgres://apos@localhost:5433/apos_test`），每个文件 `beforeEach` 里 TRUNCATE 全表 —— **不能指到开发库**。vitest 关掉了文件级并行（共用一个测试库）。

Postgres 用 **5433** 不是 5432：5432 上常蹲着系统自带的实例，Docker 端口冲突不报错，连接会静默落到那个实例上，症状是 `role "apos" does not exist`。全仓库默认值都是 5433。

## 三条不可违反的约束

细节与理由见 [CONTRIBUTING.md](CONTRIBUTING.md)，这里是给改代码前的提醒：

1. **状态变更必须产生事件**。不允许任何代码路径直接 `UPDATE work_items SET status = ...`，统一走 `apps/api/src/modules/flow/transition.ts` 的 `transition()`，它在同一事务里写状态 + 写事件。这是审计、Policy 模拟、Analytics 的全部数据来源。
2. **Agent 是独立身份**。涉及操作者的字段一律是 `(actorType, actorId)` 而非 `userId`，Agent 有自己的凭证与权限集，绝不复用人类 token。
3. **Policy 评估必须携带上下文快照**。`policy.evaluated` 事件的 `contextSnapshot` 事后补不了。新增 Policy fact 时同步改 `buildPolicyContext()`（`modules/flow/context.ts`）。

`packages/domain/src/policy/evaluate.test.ts` 里的安全底线测试是阻断性的：它穷举各自治等级，断言 `NEVER_AUTO_APPROVE` 的操作永远不被自动放行。它红了说明治理体系被绕过。

## 仓库结构与依赖方向

```
packages/contracts/            前后端共享的类型与 Zod schema —— 唯一真相来源，零依赖
packages/domain/               纯逻辑：状态机、Guard、Policy 求值、RBAC 目录、Analytics、恢复策略
                               零 IO，能脱离数据库单测。改判定规则改这里，不是改 http/
packages/db/                   Drizzle schema、迁移、连接串形态推断、RLS 审计
packages/agent-runtimes/       Agent 运行时适配器（claude-code / codex / cli / mock）
packages/workspace-providers/  工作区来源与交货（git / local / object-storage / empty）
packages/integrations/         外部系统适配（GitHub 真实 HTTP、内存适配器、Slack/飞书 webhook）
apps/api/src/http/             接入层：路由、鉴权闸门、SSE、幂等键、错误信封
apps/api/src/modules/          应用层，按领域分目录，模块间只经导出接口互调
apps/api/src/workers/          定时循环（scheduler / supervisor / recovery / review / stats / notify）
apps/web/                      React 18 + Vite + TanStack Query + zustand + shadcn
```

依赖只能往下：`http → modules → domain → contracts`。domain 里出现 `import ... from '@apos/db'` 就是走错方向了。

路径别名 `@apos/*` 与 `@/*` 必须在**三处**保持一致：`vitest.config.ts`、`apps/web/vite.config.ts`、各 tsconfig。缺一处的表现是「类型检查过了但浏览器里解析失败」或「测试跑不起来」。

## 必须知道的机制

**Fastify 启动顺序有硬约束**（`apps/api/src/app.ts`）：幂等钩子要在路由之前注册（钩子按注册顺序跑，重放要抢在业务逻辑前短路），静态前端托管要在路由之后（notFound 兜底得等 API 路由注册完）。

**写路由不登记权限则进程起不来**。`apps/api/src/http/rbac.ts` 的 `ROUTE_PERMISSIONS` 是一张路由 → 权限的表，`guardRouteCoverage()` 用 `onRoute` 钩子逐条清点，发现未登记的写路由就在启动时抛错。新增 POST/PATCH/PUT/DELETE 路由**必须**同步登记，确实不需要鉴权的（Agent 回调、探针、登录）加进 `EXEMPT` 并写明理由。权限判定本身在 `@apos/domain` 的权限目录里，rbac.ts 只负责查「谁在调用」和登记「这条路要什么」。

**事件总线只能在事务提交后 publish**（`modules/event/bus.ts`）。事务内发布会把「已进入 Review」推给浏览器而事务随后回滚。`transition()` 自己管 outbox；不涉及状态流转的事件用 `emitAndPublish()`。频道映射由 `channelsFor()` 统一算出（`project:{id}:board`、`work_item:{id}`、`run:{id}`、`agent:{id}`、`user:{id}:decisions`）。

**两类事件不要混**：`run_events` 是 Agent 执行的细粒度日志（单 Run 数千条，只喂 Run 详情页），`events` 是领域事件（唯一写入者是 Flow Engine，喂审计 / Analytics / 通知）。少数关键 run_event 会被提升为领域事件。

**PROCESS_ROLE 决定启动哪些组件**（`apps/api/src/main.ts`）。同一份代码：`api` 只起 HTTP，`worker` 只起循环，`all` 都起（本机默认）。循环之间不重叠 —— 上一轮没跑完就跳过本次 tick，否则慢查询会堆积成重复派发。

**Run 的状态活在库里不在内存**。进程重启后由 run-supervisor 按心跳超时接管孤儿 Run（`modules/agent/supervisor.ts`）。`dispatching` 这个中间态是必要的：没有它无法区分「还没派发」和「派发了但不知道结果」。

**运行时与工作区都是接口**：新增 Agent 运行时实现 `AgentRuntimeAdapter`（`packages/agent-runtimes/src/adapter.ts`），新增工作区后端实现 `packages/workspace-providers/src/ports.ts` 里那几个口子（该包不 import `@apos/db`，宿主注入凭证解析与远端回查）。调用方不区分具体运行时。

**前端 SSE 补丁靠 query key 精确命中**。所有 key 走 `apps/web/src/lib/query/keys.ts` 的 `qk` 工厂，手写字符串数组迟早和读取处对不上，症状是「后端推了但界面不动」。切换身份或组织时整体作废缓存 —— 组织是多租户边界。React Hook 依赖漏项在 SSE 驱动的界面上是同一种症状，所以 `react-hooks/exhaustive-deps` 开着。

**数据库连接形态是从连接串推断的**（`packages/db/src/connection.ts`）。Transaction Pooler（:6543）下不能用预编译语句，认错了的表现是上线后随机报 `prepared statement does not exist`。迁移不要走 Transaction Pooler，用 `DATABASE_DIRECT_URL`。启动日志里那行 `[db] …` 就是给对这个用的。

**账号来源只有三条**：`.env` 里的超管（启动时自举，幂等，不会覆盖改过的口令）、组织管理员开的号、自助注册（默认关，每次注册长出一个**新的空组织**）。种子脚本不造账号，且是追加不是重置。

## 约定

- 事件类型：`{subject}.{过去式动词}`，如 `work_item.status_changed`
- 数据库 snake_case（Drizzle `casing: 'snake_case'` 自动转），API 与前端 camelCase
- 金额一律字符串形式的十进制，不用浮点
- `any` 要带理由（eslint 里是 error），有意不用的变量用 `_` 前缀
- 环境变量认不出来的取值要在启动时喊出来，不要静默回退 —— 配置没生效而现场毫无迹象是这个仓库反复吃过的亏

## 测试要求

| 变更内容 | 必须补的测试 |
| --- | --- |
| 状态机流转规则 | `machine.test.ts` 的穷举与可达性断言 |
| Guard | 通过与失败两条路径，失败时 reason 要可读 |
| Policy 条件/动作 | 求值测试；高风险操作补安全底线测试 |
| 恢复策略 | 每个错误分类都要有明确决策 |
| 任何写状态的路径 | 集成测试断言「状态变了 → 有对应事件」 |

测试夹具（`apps/api/src/test/db.ts`）走**真实认证路径**（`signToken` 签真令牌），没有测试模式旁路。夹具身份是组织管理员 + tech_lead，功能测试用它；**权限断言一律用 `createMember()` 造明确角色的人**，用夹具身份去测「viewer 不能改」永远是绿的。夹具也不能比真实数据宽松 —— 它一旦宽松就会把漏洞焊死。

## 文档

改动前先看对应的设计文档，它们解释了「为什么是这样」：

- [docs/RUNNING.md](docs/RUNNING.md)：本机怎么跑、环境变量、排错
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)、[docs/SUPABASE.md](docs/SUPABASE.md)：单机部署、换托管 Postgres
- [docs/tech/](docs/tech/README.md)：01 架构 / 02 领域模型 / 03 事件模型 / 04 Flow Engine / 05 Policy Engine / 06 Agent Protocol / 07 API 设计 / 08 前端架构 / 09 安全 / 10 MVP 计划 / 11 工作区抽象
- [docs/product/pages/](docs/product/pages/README.md)：14 个页面的结构、交互、状态、权限与数据依赖
