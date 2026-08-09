# 01 系统架构

## 1. 架构目标

从产品定位倒推出的四个必须满足的属性：

| 属性 | 产品来源 | 技术含义 |
| --- | --- | --- |
| **可追溯** | 3.2 所有行为可追溯 | 每次状态变更写不可变事件；因果链完整 |
| **可治理** | 8.9 Policy Engine、十 权限与安全 | Policy 在关键路径；Agent 身份独立；审计不可绕过 |
| **持续推进** | 8.6 Flow Engine「推进状态而不只是保存状态」 | 有主动调度循环，不依赖用户操作触发 |
| **可恢复** | 8.6.5 Flow Recovery | Agent Run 状态在库不在内存；进程重启后能接管孤儿任务 |

第四条经常被低估：一个 Agent Run 可能运行 30 分钟，期间部署一次、进程重启一次是常态。**如果 Run 的状态活在进程内存里，产品就不可用。**

---

## 2. 分层

```
┌───────────────────────────────────────────────────────────────┐
│ 接入层  Fastify                                                │
│  · 认证（JWT / Session）  · 授权前置检查  · 请求校验（Zod）    │
│  · SSE 连接管理与扇出     · 限流       · 幂等键                │
├───────────────────────────────────────────────────────────────┤
│ 应用层  Modules                                                │
│  每个模块导出 use case，模块间只能通过导出接口互相调用          │
│  ❌ 禁止跨模块直接查询对方的数据表                              │
├───────────────────────────────────────────────────────────────┤
│ 领域层  Domain                                                 │
│  实体、值对象、状态机定义、Policy 规则求值、不变式约束          │
│  纯函数为主，不依赖 IO —— 这一层要能脱离数据库单测              │
├───────────────────────────────────────────────────────────────┤
│ 基础设施层  Infrastructure                                     │
│  Repository（Drizzle）· 事件总线 · 队列 · LLM 客户端           │
│  Agent 运行时适配器 · 外部系统客户端 · 对象存储                 │
└───────────────────────────────────────────────────────────────┘
```

### 2.1 模块划分

| 模块 | 职责 | 关键出口 |
| --- | --- | --- |
| `identity` | 用户、Agent、Service 的统一身份；权限判定 | `can(actor, action, resource)` |
| `project` | Project 生命周期、成员、自治等级 | `getProjectContext()` |
| `requirement` | 需求录入、AI 结构化、澄清、确认 | `analyzeRequirement()` `approveRequirement()` |
| `plan` | 计划生成、版本、任务拆解、依赖构建 | `generatePlan()` `approvePlan()` |
| `work` | Work Item CRUD、依赖、产物 | `getWorkItem()` `updateWorkItem()` |
| `flow` | **状态机、调度、阻塞识别、恢复** | `transition()` `schedule()` |
| `policy` | 规则评估、模拟、继承与冲突检测 | `evaluate(context)` `simulate(draft, range)` |
| `decision` | 决策创建、责任人解析、会签、时限与升级 | `createDecision()` `resolveDecision()` |
| `agent` | Agent 注册、能力与权限、Run 生命周期 | `dispatchRun()` `handleRunEvent()` |
| `integration` | 外部系统连接、同步、冲突 | `sync()` `handleWebhook()` |
| `analytics` | 事件聚合、指标计算、洞察生成 | `getFlowMetrics()` |
| `notification` | 通知路由、升级、去重 | `notify(event)` |
| `event` | 事件写入、查询、归档 | `emit()` `query()` |

**模块边界的强制手段**：每个模块一个目录，`index.ts` 是唯一出口；ESLint 规则禁止 `import` 深入其他模块内部路径。这条规则是后续拆服务能否低成本的关键。

### 2.2 一次状态流转的完整调用链

以「Agent 完成执行 → 进入 Review」为例，展示各层协作：

```
Agent 运行时
  │ POST /api/agent-callback/runs/{id}/events  { type: 'completed', artifacts: [...] }
  ▼
接入层：验证 Agent 凭证 → 校验 payload
  ▼
agent.handleRunEvent()
  ├─ 写 run_events（原始事件，不可变）
  ├─ 更新 agent_runs 状态
  └─ 调用 flow.transition({
        subject: workItem, trigger: 'agent_run_completed', actor: agent })
     ▼
flow.transition()  ── 单个数据库事务 ──────────────────────
  ├─ 加行锁 SELECT ... FOR UPDATE（防并发流转）
  ├─ 查状态机：executing --agent_run_completed--> reviewing ?
  ├─ 求值 guard：验收标准是否满足、依赖是否 OK
  ├─ 调 policy.evaluate(context)
  │    命中 #7「低风险自动批准」→ allow_and_notify
  │    或命中 #1「生产变更」→ require_human_review
  ├─ 若需人类：decision.createDecision()（同事务）
  ├─ UPDATE work_items SET status='reviewing'
  ├─ INSERT events（状态变更事件，含 policy trace）
  └─ 事务提交
     ▼
事件总线（事务提交后发布，保证不发出未提交的状态）
  ├─▶ SSE 扇出：project:{id}:board、work_item:{id}
  ├─▶ notification：按规则发飞书
  ├─▶ analytics：更新预聚合
  └─▶ flow.schedule()：检查是否有下游任务因此解除阻塞
```

**关键点**：

1. **状态与事件同事务写入**——否则会出现"状态变了但没有事件"的审计黑洞
2. **事件总线在事务提交后才发布**——用 transactional outbox 或 `AFTER COMMIT` 钩子，避免订阅者读到未提交状态
3. **Policy 评估在事务内**——它的判定结果决定了这次流转的走向，必须与状态变更原子

---

## 3. 进程与部署拓扑

### 3.1 进程角色

```
┌──────────────────────┐   ┌──────────────────────┐
│  api (N 实例)         │   │  worker (M 实例)      │
│  · HTTP + SSE        │   │  · Run Supervisor    │
│  · 同步业务逻辑        │   │  · Flow Scheduler    │
│  · 无长任务           │   │  · Blocker Detector  │
│                      │   │  · Integration Sync  │
│  水平扩展依据：        │   │  · Analytics Agg.    │
│  在线用户数与 SSE 连接 │   │  · Notification      │
└──────────────────────┘   └──────────────────────┘
         同一份代码，靠 PROCESS_ROLE 环境变量决定启动哪些组件
```

**为什么分开**：API 进程要快速响应且可随时重启；worker 承载长任务与定时循环，重启需要优雅接管。混在一起会让部署时正在跑的调度循环被打断。

### 3.2 Worker 清单

| Worker | 触发方式 | 职责 | 幂等要求 |
| --- | --- | --- | --- |
| `run-supervisor` | 每 10s 轮询 + 事件触发 | 监控执行中的 Run：超时判定、心跳丢失检测、**孤儿 Run 接管** | 必须 |
| `flow-scheduler` | 每 5s + 事件触发 | 找出 `ready` 且依赖满足的 Work Item，检查 WIP 与 Policy，派发 | 必须 |
| `blocker-detector` | 每 60s | 按 8.6.4 的九类规则扫描阻塞 | 天然幂等 |
| `decision-escalator` | 每 60s | 决策时限提醒与三级升级（产品文档十一） | 需去重 |
| `integration-sync` | 定时 + webhook | 外部系统双向同步与冲突检测 | 必须 |
| `analytics-aggregator` | 每 5min | 事件流 → 小时/天粒度预聚合 | 必须 |
| `notification-dispatcher` | 队列消费 | 通知路由、渠道适配、去重、免打扰 | 必须 |
| `event-archiver` | 每日 | 热数据超期 → 对象存储 | 必须 |

### 3.3 孤儿 Run 接管（可恢复性的核心）

```
Agent Run 的状态机（持久化在 agent_runs 表）
  queued → dispatching → running → (completed | failed | timeout | terminated)

run-supervisor 每 10s 执行：

  1. 找出 status='running' 且 last_heartbeat_at < now() - 90s 的 Run
     → 这些是失联的 Run

  2. 对每个失联 Run，按其 runtime 类型探测真实状态：
     ├─ 运行时支持状态查询（MCP / HTTP）→ 主动查询
     │   ├─ 仍在运行 → 更新心跳，继续
     │   └─ 已结束 → 拉取最终结果，补齐事件
     └─ 不支持查询 → 按 Policy 判定：标记 failed(reason='heartbeat_lost')
                      → 触发 Flow Recovery（重试 / 换 Agent / 转人工）

  3. 找出 status='dispatching' 超过 60s 的 Run
     → 派发过程中进程崩溃 → 重新派发（用 idempotency_key 防重复执行）
```

`dispatching` 这个中间态是必要的：没有它就无法区分"还没派发"和"派发了但不知道结果"，后者重试会导致 Agent 重复执行同一任务。

---

## 4. 数据流

### 4.1 三条主要数据流

```
① 需求 → 计划 → 任务（人机协作，同步为主）
   用户输入 ─▶ requirement.analyze（LLM 流式）─▶ SSE 回传结构化字段
            ─▶ 人类确认 ─▶ plan.generate（LLM，1–3min，异步任务）
            ─▶ 人类批准 ─▶ work items 落库 + 依赖图构建

② 执行（事件驱动，异步）
   flow-scheduler ─▶ agent.dispatchRun ─▶ Agent 运行时
                                          │ 事件流（SSE/webhook）
   run_events ◀──────────────────────────┘
      │
      ├─▶ 实时转发到浏览器（SSE）
      ├─▶ 里程碑事件 ─▶ flow.transition ─▶ 状态变更 ─▶ events
      └─▶ 成本累加 ─▶ 预算检查 ─▶ 可能触发 Policy

③ 外部同步（双向，最易出错）
   GitHub webhook ─▶ integration.handleWebhook
                  ─▶ 映射到 Work Item ─▶ flow.transition（PR merged → done）
   Work Item 变更 ─▶ 出站队列 ─▶ Jira API（按 Source of Truth 决定是否推送）
```

### 4.2 事件的双重身份

系统里有两类"事件"，**不要混淆**：

| | `run_events` | `events` |
| --- | --- | --- |
| 含义 | Agent 执行过程的细粒度日志 | 领域事件（业务事实） |
| 量级 | 单 Run 可达数千条 | 单 Work Item 数十条 |
| 消费者 | Run 详情页时间线 | 审计、Analytics、Flow、通知 |
| 保留 | 30 天热 + 归档 | 长期（审计要求） |
| 写入者 | Agent 适配器 | Flow Engine（唯一） |

**关系**：`run_events` 中的少数关键事件（产物提交、执行完成、失败）会被提升为领域 `events`。这个提升规则在 [06 Agent Protocol](06-agent-protocol.md) §5 定义。

区分它们的价值：Analytics 与审计只需扫描量级小得多的 `events` 表，而不必在数百万条工具调用日志里做聚合。

### 4.3 SSE 扇出

```
worker/api 发布事件
     │
     ▼ Redis Pub/Sub  channel: project:{id}
┌────┴────┬─────────┐
▼         ▼         ▼
api-1    api-2    api-3      每个实例持有部分浏览器连接
  │        │        │
  ▼        ▼        ▼
浏览器    浏览器    浏览器
```

**频道设计**（与页面文档一致）：

| 频道 | 订阅者 | 内容 |
| --- | --- | --- |
| `project:{id}:board` | 看板、总览 | Work Item 状态与进度 |
| `work_item:{id}` | Work Item 详情 | 该任务的全部事件 |
| `run:{id}` | Run 详情 | 执行流事件（高频） |
| `agent:{id}` | Agent Workspace | 队列与状态 |
| `user:{id}:decisions` | 决策中心、全局角标 | 决策创建/解决/升级 |

**背压处理**：`run:{id}` 频道事件密集（工具调用可能每秒多条）。做法：
- 服务端按 200ms 窗口合并同类事件
- 客户端断开时立即取消订阅
- 单连接积压超过 1000 条时降级为「仅推送里程碑事件 + 提示刷新」

**断线续传**：SSE 的 `Last-Event-ID` 头携带序号，重连时补发缺失事件。事件序号由数据库序列保证单调，见 [07 API](07-api-design.md) §5。

---

## 5. 演进路径与拆分点

模块化单体不是终点。以下是预设的拆分点与触发条件：

| 拆分候选 | 触发条件 | 拆分难度 |
| --- | --- | --- |
| **Agent Orchestrator** | Agent 数量 > 50 或 Run 并发 > 200；需要独立扩缩容 | 低（模块边界清晰，通信已是异步） |
| **Analytics** | 聚合任务影响主库性能 | 低（只读 + 独立聚合库） |
| **Knowledge / 语义检索** | 引入向量检索与 RAG 时 | 低——**且这是引入 Python 服务最自然的位置** |
| **Integration** | 集成方数量增长、限流与重试逻辑复杂化 | 中（与 Flow 有双向调用） |
| **Flow + Policy** | 几乎不应拆——两者与领域数据耦合最深 | 高 |

**Knowledge 服务的位置**：如果团队后续要用 Python 做语义检索、决策相似度匹配（页面文档 11 §5.7）、复杂分析，把它做成独立服务，通过内部 HTTP + 共享 PG 只读副本接入。这条路径让「Node 主控制面 + Python 数据侧」的混合架构成为可能，而不需要一开始就做这个决定。

---

## 6. 关键技术风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| **Agent 运行时行为不一致** | 协议能力参差（有的不支持中途注入约束、有的不上报成本），导致产品功能在不同 Agent 上表现不同 | [06](06-agent-protocol.md) 定义能力协商 + 显式降级；页面明确告知用户缺失能力 |
| **Policy 模拟不准** | 用户依据模拟结果放开自动化，实际行为不符 → 信任崩塌 | 事件必须携带评估上下文快照（[03](03-event-model.md) §4）；模拟结果标注置信度 |
| **长 Run 的进程重启** | 任务丢失、重复执行 | 状态全部持久化；`dispatching` 中间态 + 幂等键；孤儿接管（§3.3） |
| **双向同步循环** | 无限同步风暴 | 同步产生的变更打 `origin` 标记，同步器跳过自身来源；见 [02](02-domain-model.md) `sync_mappings` |
| **事件表膨胀** | 查询变慢 | 按月分区 + 热冷分离（[03](03-event-model.md) §6） |
| **LLM 调用成本失控** | 项目预算超支 | 成本在 Run 级实时累加 + Policy 硬阈值中断（[05](05-policy-engine.md) §7） |
| **并发状态流转** | 同一 Work Item 被 Agent 回调与人类操作同时改 | 行锁 + 版本号乐观锁；状态机拒绝非法流转（[04](04-flow-engine.md) §5） |

---

## 7. 非功能指标

| 指标 | 目标 | 说明 |
| --- | --- | --- |
| API P99 延迟 | < 300ms | 不含 LLM 调用的端点 |
| Policy 评估 P99 | < 10ms | 在状态流转关键路径上 |
| 看板首屏 | < 1.5s | 200 个 Work Item 规模 |
| SSE 事件端到端延迟 | < 500ms | Agent 事件产生到浏览器渲染 |
| Flow 调度延迟 | < 10s | 依赖满足到任务派发 |
| 单实例 SSE 连接数 | 2000 | 超出则扩容 api 实例 |
| 事件写入吞吐 | 500 events/s | MVP 规模，见 [03](03-event-model.md) §6 容量估算 |
| 可用性 | 99.5% | MVP 目标；Agent 运行时不可用不计入 |

**关于可用性的说明**：本系统的特殊性在于，它挂掉时正在运行的 Agent Run 不会停止（它们在外部运行时里）。因此恢复的关键不是「快速重启」而是「重启后正确接管」——§3.3 的孤儿接管机制比高可用部署更重要。

---

## 8. 目录结构

```
apps/
  api/                    Fastify 应用（api + worker 共用）
    src/
      routes/             HTTP 路由（薄，只做校验与调用）
      sse/                SSE 连接管理与扇出
      workers/            各 worker 的入口与循环
      main.ts             按 PROCESS_ROLE 启动
  web/                    React SPA
    src/
      pages/              对应 14 个页面文档
      features/           按领域组织的组件与 hooks
      lib/                api client、SSE client、query 配置
packages/
  domain/                 领域层（纯逻辑，零 IO 依赖）
    src/
      work-item/          实体 + 状态机定义
      policy/             条件 AST 与求值器
      flow/               转移规则表
      decision/           责任人解析规则
  db/                     Drizzle schema + 迁移 + Repository
  contracts/              ★ 前后端共享：Zod schema + 推导的 TS 类型
    src/
      api/                请求/响应 schema
      events/             领域事件与 Run 事件的判别联合
      agent-protocol/     Agent Protocol 类型定义
  integrations/           GitHub / Jira / 飞书 / Slack 适配器
  agent-runtimes/         Claude Code / MCP / HTTP 适配器
docs/                     本文档目录
```

**`packages/contracts` 是选择 TypeScript 的最大收益点**：前端 `import { WorkItem, PolicyCondition } from '@apos/contracts'` 拿到的就是后端校验用的同一份定义。这个包应当零运行时依赖（只有 Zod），保证前端打包体积可控。
