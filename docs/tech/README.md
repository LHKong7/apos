# Autonomous Project OS 技术实现文档

本目录是[产品功能文档](../product/autonomous-project-os.md)与[页面文档](../product/pages/README.md)的技术落地方案。

---

## 一、文档清单

| # | 文档 | 内容 | 是否与语言相关 |
| --- | --- | --- | --- |
| — | [技术选型](#二技术选型) | 见本文档下方 | ✅ |
| 01 | [系统架构](01-architecture.md) | 服务划分、部署拓扑、数据流、并发模型 | 部分 |
| 02 | [领域模型与数据库](02-domain-model.md) | 10 个核心对象的表结构与约束 | ❌ |
| 03 | [事件模型](03-event-model.md) | 事件定义、因果链、审计、回放 | ❌ |
| 04 | [Flow Engine](04-flow-engine.md) | 状态机、依赖、调度、阻塞识别与恢复 | ❌ |
| 05 | [Policy Engine](05-policy-engine.md) | 规则表示、评估、模拟回放、继承与冲突 | ❌ |
| 06 | [Agent Protocol](06-agent-protocol.md) | 统一 Agent 接入协议与适配器 | ❌ |
| 07 | [API 设计](07-api-design.md) | REST 约定、SSE 契约、幂等与并发 | ❌ |
| 08 | [前端架构](08-frontend-architecture.md) | React 分层、实时数据、性能 | ✅ |
| 09 | [身份、权限与安全](09-security.md) | Identity 模型、RBAC/ABAC、审计、密钥 | ❌ |
| 10 | [MVP 实施计划](10-mvp-plan.md) | 分阶段交付、里程碑、风险 | ❌ |
| 11 | [工作区抽象](11-workspace-abstraction.md) | Agent 工作目录的铺料 / 交货分离、基线与变更集、四个后端 | ❌ |
| 12 | [多语言](12-i18n.md)（[EN](12-i18n.en.md)） | 词条表、服务端原因码、枚举归属、守门的三条测试 | ✅ |

---

## 二、技术选型

### 2.1 结论

| 层 | 选型 |
| --- | --- |
| 前端 | React 18 + TypeScript + Vite |
| 后端 | **Node.js 22 + TypeScript**（Fastify） |
| 数据库 | PostgreSQL 16（主库 + JSONB + 分区） |
| 缓存 / 消息 | Redis 7（Pub/Sub + BullMQ 队列） |
| 对象存储 | S3 兼容（产物、归档事件） |
| 部署 | 容器化，单体优先，按 §2.4 拆分点演进 |

### 2.2 后端为什么选 Node 而不是 Python

**负载形状决定的。** 这是一个编排控制面，不是计算系统：

| 主要工作 | 特征 |
| --- | --- |
| 监督 Agent Run | 单个 Run 可运行 30 分钟，全程等待 LLM 流式输出 |
| 接收 webhook | GitHub / Jira / CI 事件高频涌入 |
| SSE 扇出 | 每个在线用户 1–3 条长连接，看板与 Run 详情实时更新 |
| 外部 API 同步 | 大量并发 HTTP 调用，受限流约束 |
| Policy 评估 | 内存中的规则匹配，微秒级 |
| Flow 状态推进 | 数据库事务 |

几乎全是 I/O 密集与状态管理，没有一处是 CPU 密集。Node 的事件循环直接对上这个形状。

**四条具体理由：**

1. **前后端共享领域类型。** 10 个核心对象、14 个数据密集页面。`WorkItem`、`Decision`、`Policy` 的条件 AST、Agent Protocol 的事件联合类型——这些结构在 TypeScript 里用判别联合（discriminated union）表达最自然，前端拿到的是同一份定义而非生成产物。类型漂移是这类系统最大的 bug 来源。

2. **Agent 生态。** MCP 与 Claude Agent SDK 是 TypeScript 优先的。Agent 运行时适配层（[06](06-agent-protocol.md)）是整个系统风险最高的集成面，用一等公民 SDK 减少踩坑。

3. **长连接与流式转发。** Agent Run 的事件流需要从 Agent 运行时流入、落库、再流出到浏览器。Node 的流式原语让这条链路很短。

4. **单语言的团队速度。** 目标用户是小团队与 OPC，实现团队大概率也不大。少一门语言 = 少一套工具链、CI、依赖管理、招人要求。

### 2.3 什么情况下应该改选 Python

诚实地说，有两种情况我会反过来：

| 情况 | 说明 |
| --- | --- |
| **团队已经是 Python 强项** | 这条压过上面所有技术论证。用不熟的语言写编排系统的代价，远大于语言本身的适配度差异 |
| **知识检索/分析要早期进程内做** | Knowledge Center（产品文档 8.12）的语义检索、Analytics 的复杂计算，Python 生态明显更好 |

**如果选 Python**：FastAPI + SQLAlchemy 2.0 + Pydantic v2 + asyncio，用 OpenAPI 生成前端类型。本目录 02–07、09、10 共 8 份文档完全适用，只需改写本节与 [01 架构](01-architecture.md) 的运行时部分。

**折中方案**：主控制面用 Node，把知识检索与分析计算做成独立 Python 服务，通过内部 API 调用。[01 架构](01-architecture.md) §5 预留了这个拆分点。

### 2.4 为什么是模块化单体而不是微服务

MVP 阶段的服务边界还没被验证过。产品文档里 Flow Engine、Policy Engine、Agent 编排三者的交互密度很高（每次状态流转都要过 Policy，每次 Agent 事件都要驱动 Flow），过早拆分会把这些调用变成网络调用，换来分布式事务的麻烦。

**做法**：一个部署单元，内部模块边界严格（禁止跨模块直接访问数据表，只能走模块导出的接口），worker 进程按职责分开。这样拆分时是搬代码而不是拆纠缠。

拆分触发条件写在 [01 架构](01-architecture.md) §5。

### 2.5 关键依赖

| 用途 | 选型 | 理由 |
| --- | --- | --- |
| HTTP 框架 | Fastify | 性能好，schema 驱动的校验与序列化，原生支持 SSE |
| ORM / 查询 | Drizzle ORM | 类型安全且贴近 SQL；这个系统有大量复杂查询与 CTE，重 ORM 会碍事 |
| 校验 | Zod | 与 TS 类型双向推导，同一份 schema 用于 API 校验、Policy 条件、Agent Protocol |
| 队列 | BullMQ (Redis) | 延迟任务、重试、并发限制（WIP 控制直接用得上） |
| 迁移 | Drizzle Kit | — |
| LLM | `@anthropic-ai/sdk` | Project Agent 与需求结构化 |
| MCP | `@modelcontextprotocol/sdk` | Agent 与工具接入 |
| 测试 | Vitest + Testcontainers | 状态机与 Policy 必须对真实 PG 测 |
| 前端状态 | TanStack Query + Zustand | 服务端状态与 UI 状态分离 |
| 前端图 | React Flow + dagre | Execution Graph |

**刻意不引入的**：

- **Temporal / 工作流引擎**：Flow Engine 本身就是领域特定的工作流引擎，产品需求（WIP 控制、Policy 门禁、人类决策节点）没有通用引擎能直接满足。用通用引擎会变成"在引擎上再写一个引擎"。
- **GraphQL**：页面与接口的对应关系清晰，REST + 少量聚合端点足够；SSE 的实时需求 GraphQL Subscription 反而更重。
- **微服务框架 / 服务网格**：见 §2.4。
- **Kafka**：MVP 的事件量用 PostgreSQL + Redis 完全够（估算见 [03 事件模型](03-event-model.md) §6）。

---

## 三、三条贯穿全系统的技术约束

这三条来自产品定位，不是技术偏好，违反任何一条都会让产品失去核心价值。

### 3.1 一切状态变更都必须产生 Event

产品文档 3.2「所有行为可追溯」要求系统能回答：谁做了什么、为什么这样做、用了哪些上下文、谁批准了关键决策。

**技术含义**：不允许任何代码路径直接 `UPDATE` 领域表而不写 Event。状态变更统一走 Flow Engine 的 transition 接口，由它在同一事务内写状态与事件。详见 [03](03-event-model.md)。

### 3.2 Agent 是独立身份，不是人类的代理

产品文档 10.3 明确要求 Agent 权限独立于人类用户配置。

**技术含义**：所有涉及操作者的字段是 `(actor_type, actor_id)` 而非 `user_id`；Agent 有自己的凭证与权限集；禁止"Agent 使用某人的 token 执行"这种实现。详见 [09](09-security.md)。

### 3.3 Policy 评估在关键路径上，且必须可模拟

每次调度、每次状态流转、每次高风险操作都要过 Policy。同时页面文档 13 要求用历史数据回放验证规则。

**技术含义**：
- 评估必须快（P99 < 10ms）→ 规则编译进内存，不查库
- 回放要求 Event 携带**足够重建评估上下文的快照**，这是对事件设计的硬约束

详见 [05](05-policy-engine.md)。

---

## 四、系统全景

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser (React SPA)                                                │
│  REST + SSE                                                         │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────┐
│  API Layer (Fastify)   认证 · 授权 · 校验 · SSE 扇出                │
├─────────────────────────────────────────────────────────────────────┤
│  Application Modules                                                │
│  ┌──────────┐┌──────────┐┌──────────┐┌──────────┐┌───────────────┐ │
│  │Requirement││  Plan    ││  Flow    ││  Policy  ││   Decision    │ │
│  │  Module  ││ Module   ││  Engine  ││  Engine  ││    Module     │ │
│  └──────────┘└──────────┘└──────────┘└──────────┘└───────────────┘ │
│  ┌──────────┐┌──────────┐┌──────────┐┌──────────┐┌───────────────┐ │
│  │  Agent   ││Integration││Analytics ││Knowledge ││   Identity    │ │
│  │Orchestr. ││  Module  ││ Module   ││ (P1)     ││   & Access    │ │
│  └──────────┘└──────────┘└──────────┘└──────────┘└───────────────┘ │
├─────────────────────────────────────────────────────────────────────┤
│  Event Bus (进程内 + Redis Pub/Sub)                                 │
└──────┬──────────────────────────────────────────────┬───────────────┘
       │                                              │
┌──────▼────────────────────┐              ┌──────────▼───────────────┐
│  Workers (BullMQ)         │              │  PostgreSQL / Redis / S3 │
│  · Run Supervisor         │              └──────────────────────────┘
│  · Flow Scheduler         │
│  · Blocker Detector       │              ┌──────────────────────────┐
│  · Integration Sync       │◀────────────▶│  外部系统                 │
│  · Analytics Aggregator   │              │  GitHub / Jira / 飞书     │
│  · Notification Dispatcher│              │  Agent Runtimes (MCP…)   │
└───────────────────────────┘              └──────────────────────────┘
```

---

## 五、阅读顺序建议

**要理解系统怎么运转**：[01 架构](01-architecture.md) → [03 事件模型](03-event-model.md) → [04 Flow Engine](04-flow-engine.md)

**要开始写代码**：[02 领域模型](02-domain-model.md) → [07 API](07-api-design.md) → [10 实施计划](10-mvp-plan.md)

**要接入 Agent**：[06 Agent Protocol](06-agent-protocol.md) → [11 工作区抽象](11-workspace-abstraction.md) → [09 安全](09-security.md)

**要做前端**：[08 前端架构](08-frontend-architecture.md) → [07 API](07-api-design.md) → 对应[页面文档](../product/pages/README.md)
