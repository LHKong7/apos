# 06 Agent Protocol

产品文档 9.3 要求「提供统一 Agent Protocol」，统一描述：Agent 能力、任务输入、执行状态、事件、产物、权限、成本、错误、人工介入请求。

本文档定义这个协议，以及如何把 Claude Code、Codex、OpenHands、MCP Server、自定义 Runtime 适配进来。

---

## 1. 为什么需要统一协议

不做统一协议的话，每接一个 Agent 就要在 Flow Engine、看板、Run 详情页、Analytics 里各写一份特判。四五个 Agent 之后就无法维护。

但统一协议有个绕不开的现实：**不同运行时的能力天差地别**。

| 能力 | Claude Code | 通用 MCP | 自建 HTTP Agent | 某些封闭 SaaS Agent |
| --- | --- | --- | --- | --- |
| 流式事件 | ✅ | ✅ | 看实现 | 常常只有最终结果 |
| 工具调用可见 | ✅ | ✅ | 看实现 | ❌ |
| 成本上报 | ✅ | 部分 | 看实现 | ❌ |
| 执行中注入约束 | ✅ | 部分 | 看实现 | ❌ |
| 主动请求人工介入 | 部分 | ❌ | 看实现 | ❌ |
| 失败原因自述 | ✅ | ❌ | 看实现 | ❌ |

**因此协议的核心设计不是"规定所有 Agent 必须做什么"，而是"协商每个 Agent 能做什么，并对缺失能力定义明确的降级行为"。**

页面文档 14 §5.4 要求界面上展示兼容性检查结果与降级说明——不静默降级，让用户知道自己的 Agent 少了什么。

---

## 2. 协议概览

```
        APOS                                        Agent Runtime
          │                                               │
          │  ① GET  /capabilities                         │
          │──────────────────────────────────────────────▶│
          │◀────────────── CapabilityManifest ────────────│
          │                                               │
          │  ② POST /tasks          TaskDispatch          │
          │──────────────────────────────────────────────▶│
          │◀────────────── { runId, accepted }────────────│
          │                                               │
          │  ③ 事件流（三选一：SSE 拉 / Webhook 推 / 轮询） │
          │◀═════════════ RunEvent* ══════════════════════│
          │                                               │
          │  ④ POST /runs/{id}/control  { pause | resume | │
          │     terminate | add_constraint }              │
          │──────────────────────────────────────────────▶│
          │                                               │
          │  ⑤ 人工介入请求（可选能力）                     │
          │◀────────────── InterventionRequest ───────────│
          │──────────────── InterventionResponse ────────▶│
          │                                               │
```

**传输**：所有消息 JSON。事件流优先 SSE，不支持则 webhook 回调，都不支持则轮询（降级，延迟高）。

---

## 3. 能力清单（Capability Manifest）

Agent 运行时接入时上报，APOS 存入 `agent_runtimes.capabilities`。

```typescript
interface CapabilityManifest {
  protocolVersion: string;          // '1.0'
  runtime: {
    name: string;                   // 'claude-code'
    version: string;
  };

  // ★ 能力协商的核心
  features: {
    streamingEvents: boolean;       // 流式事件
    toolCallVisibility: boolean;    // 工具调用可见
    reasoningVisibility: boolean;   // 推理过程可见
    costReporting: boolean;         // 成本上报
    tokenReporting: boolean;
    progressReporting: boolean;     // 步骤进度
    runtimeConstraints: boolean;    // ★ 执行中注入约束
    interventionRequest: boolean;   // ★ 主动请求人工介入
    selfReportOnFailure: boolean;   // ★ 失败原因自述
    pause: boolean;
    terminate: boolean;
    statusQuery: boolean;           // ★ 支持主动查询状态（孤儿接管需要）
    subAgentDelegation: boolean;    // 委派子 Agent
    artifactUpload: boolean;
  };

  transport: {
    eventDelivery: 'sse' | 'webhook' | 'poll';
    heartbeatIntervalSeconds: number | null;
  };

  // 该运行时声明支持的工具
  tools: Array<{
    name: string;
    description: string;
    parameters: JSONSchema;
    sideEffects: 'none' | 'read' | 'write' | 'destructive' | 'external';
  }>;

  models: string[];
  limits: {
    maxConcurrentRuns: number;
    maxRunDurationSeconds: number;
    maxContextTokens: number;
  };
}
```

### 3.1 降级矩阵

每个缺失能力对应一个明确的降级行为。**这张表是协议设计的核心产出**，页面文档 14 §5.4 直接展示它。

| 缺失能力 | 降级行为 | 用户可见影响 |
| --- | --- | --- |
| `streamingEvents` | 只在 Run 结束时写一条汇总事件 | Run 详情页无实时执行流；卡片无进度条 |
| `toolCallVisibility` | 执行流只有开始/结束 | 排障困难，页面提示「该 Agent 不上报执行细节」 |
| `costReporting` | 按 token × 单价估算；无 token 则按时长粗估 | 成本标注「估算值」 |
| `progressReporting` | 不显示百分比，只显示已耗时 | 卡片显示「执行中 12m」而非进度条 |
| `runtimeConstraints` | 「增加约束」按钮置灰，提示改用「终止并补充上下文重跑」 | 功能不可用但有替代路径 |
| `interventionRequest` | Agent 无法主动求助；靠超时与失败检测兜底 | 卡住的任务发现更晚 |
| `selfReportOnFailure` | 错误 Tab 只显示原始错误 | 排障效率降低 |
| `pause` | 暂停降级为终止（需二次确认说明差异） | 会丢失执行中的进度 |
| `statusQuery` | 孤儿 Run 无法探测真实状态，超时后直接判失败 | 可能误判仍在运行的 Run |
| `terminate` | 只能标记本地状态，外部可能仍在运行 | **有成本泄漏风险，页面必须红字警示** |

**`terminate` 缺失是最严重的**：意味着 APOS 无法真正停止一个失控的 Agent。这类运行时应当在注册时警告，并强制配置更严格的成本上限。

---

## 4. 任务派发

```typescript
interface TaskDispatch {
  runId: string;
  idempotencyKey: string;          // ★ 重复派发保护

  goal: {
    title: string;
    description: string;
    acceptanceCriteria: Array<{ id: string; text: string }>;
    constraints: Array<{           // 人类附加的约束
      type: string;
      value: unknown;
      description: string;         // 给 Agent 读的自然语言版本
    }>;
  };

  context: Array<{
    kind: 'requirement' | 'knowledge' | 'file' | 'previous_run' | 'decision' | 'external';
    ref: string;
    title: string;
    content?: string;              // 内联小内容
    uri?: string;                  // 大内容给 URI，让 Agent 自取
    priority: 'must_read' | 'reference';
  }>;

  // ★ 权限以显式清单下发，不依赖运行时自己的配置
  permissions: {
    allowedTools: string[];
    deniedTools: string[];
    resourceScopes: Array<{ kind: string; ref: string; access: 'read' | 'write' | 'none' }>;
  };

  limits: {
    maxCostUsd: number;
    maxDurationSeconds: number;
    maxTokens: number | null;
  };

  model: string | null;
  modelConfig: Record<string, unknown> | null;

  callback: {
    eventsUrl: string;             // webhook 模式的回调地址
    token: string;                 // 短期令牌，仅对本 Run 有效
  };
}
```

**权限显式下发**是关键安全设计。不能假设运行时侧配置正确——APOS 是权限的唯一真相来源，每次派发都带上完整清单。适配器负责把它翻译成运行时能理解的形式（MCP 的工具过滤、Claude Code 的 allowedTools 等）。

**幂等**：运行时必须对相同 `idempotencyKey` 返回已存在的 Run，而不是启动新的。不支持的运行时由适配器在 APOS 侧做去重（记录 key → runId 映射）。

---

## 5. 事件

```typescript
type RunEvent = {
  runId: string;
  seq: number;                     // 单 Run 内单调递增
  ts: string;                      // ISO8601
} & RunEventBody;

type RunEventBody =
  | { type: 'run_started'; model: string; toolsAvailable: string[] }
  | { type: 'context_loaded'; items: Array<{ ref: string; tokens: number; used: boolean }> }
  | { type: 'progress'; step: number; totalSteps: number | null; description: string }
  | { type: 'reasoning'; summary: string; detail?: string }
  | { type: 'tool_call'; toolCallId: string; tool: string; params: unknown }
  | { type: 'tool_result'; toolCallId: string; ok: boolean; summary: string; detail?: unknown }
  | { type: 'artifact'; artifact: ArtifactPayload }
  | { type: 'delegation'; childRunId: string; agentRef: string; goal: string }
  | { type: 'cost'; deltaUsd: number; totalUsd: number;
      tokens: { input: number; output: number; cacheRead: number } }
  | { type: 'intervention_request'; request: InterventionRequest }
  | { type: 'note'; text: string }              // Agent 的自然语言进展摘要
  | { type: 'error'; error: AgentError }
  | { type: 'run_ended'; outcome: 'completed' | 'failed' | 'terminated';
      summary: string; selfReport?: string };
```

### 5.1 事件提升规则

哪些 `run_events` 提升为领域 `events`（[03 事件模型](03-event-model.md) §2）：

| RunEvent | → DomainEvent | 后续动作 |
| --- | --- | --- |
| `run_started` | `agent_run.started` | — |
| `artifact` | `artifact.produced` | 写 artifacts 表 |
| `cost`（累计触及阈值） | `agent_run.cost_threshold_reached` | 可能触发 Policy |
| `intervention_request` | `decision.created` | 创建决策 |
| `run_ended: completed` | `agent_run.completed` | **触发 flow.transition** |
| `run_ended: failed` | `agent_run.failed` | **触发 flow.transition → Recovery** |
| 其余 | 不提升 | 只写 run_events |

### 5.2 事件顺序与丢失

- 运行时保证 `seq` 单调递增
- APOS 收到乱序事件时按 seq 排序落库；发现空洞（收到 5 但没收到 4）时等待 2 秒后标记该 seq 为 `lost` 并继续
- **`run_ended` 是终态标志**：收到后忽略后续事件（除非 seq 更小的补发）

### 5.3 心跳

```typescript
// 运行时每 N 秒发一次（N 来自 manifest.transport.heartbeatIntervalSeconds）
{ type: 'heartbeat', runId, seq, ts, alive: true }
```

APOS 更新 `agent_runs.last_heartbeat_at`。超过 `3 × N`（最少 90s）无心跳视为失联，交给 run-supervisor 处理（[01 架构](01-architecture.md) §3.3）。

不支持心跳的运行时：用最后一条事件的时间代替，阈值放宽到 5 分钟。

---

## 6. 错误分类

**这是整个协议里对产品行为影响最大的部分。** [04 Flow Engine](04-flow-engine.md) §6.1 的恢复策略完全依赖错误分类——分类错了，恢复策略就是无差别重试，既烧钱又解决不了问题。

```typescript
type ErrorClass =
  | 'context_insufficient'    // 缺少必要信息，补充上下文后可能成功
  | 'capability_mismatch'     // 任务超出 Agent 能力，换 Agent
  | 'tool_failure'            // 工具调用失败，可重试
  | 'permission_denied'       // 权限不足，重试无用，需人类决策
  | 'external_unavailable'    // 外部服务不可用，退避重试
  | 'timeout'                 // 超时，考虑拆分任务
  | 'budget_exceeded'         // 成本超限，需人类决策
  | 'invalid_task'            // 任务描述自相矛盾/不可执行，回到需求或计划
  | 'runtime_error'           // 运行时自身故障
  | 'unknown';

interface AgentError {
  class: ErrorClass;
  message: string;             // 面向工程师
  detail?: unknown;            // 堆栈等
  retriable: boolean;          // 运行时的建议
  // ★ 面向人类的自述：为什么卡住、需要什么
  selfReport?: string;
}
```

**`selfReport` 的价值**（页面文档 09 §5.7）：

> "我需要 orders 表的结构定义来设计查询索引，但在 order-service 仓库中未找到 migration 或 schema 文件。可能在其他仓库或由 DBA 单独维护。"

这一段比堆栈有用得多——它直接告诉人类该补什么。

**不支持分类的运行时**：适配器用启发式规则从错误消息推断（正则匹配常见模式），并标注 `classificationSource: 'inferred'`。推断结果不可靠，因此这类 Agent 的恢复策略应当更保守（更早转人工）。

---

## 7. 人工介入请求

产品文档 9.3 明确列出「人工介入请求」是协议要素。这是 Agent 主动说"我需要人帮忙"的通道。

```typescript
interface InterventionRequest {
  runId: string;
  reason: 'ambiguous_requirement' | 'permission_needed' | 'risky_operation'
        | 'conflicting_information' | 'low_confidence' | 'external_blocker';
  question: string;
  options?: Array<{
    id: string;
    label: string;
    description: string;
    consequence: string;
  }>;
  recommendation?: { optionId: string; confidence: number; rationale: string };
  urgency: 'blocking' | 'can_continue';   // 是否阻塞执行
  context: unknown;
}

interface InterventionResponse {
  requestId: string;
  resolution: 'answered' | 'constraint_added' | 'terminated' | 'taken_over';
  answer?: string;
  selectedOptionId?: string;
  additionalConstraints?: Array<{ type: string; value: unknown; description: string }>;
}
```

**APOS 侧处理**：收到请求 → 创建 Decision（type 由 reason 映射）→ 进入决策中心 → 人类处理 → 把结果作为 `InterventionResponse` 回传。

`urgency: 'can_continue'` 时 Agent 继续执行（比如"我用了默认值，你确认下"），`blocking` 时 Run 进入 `paused`。

---

## 8. 控制指令

```typescript
type ControlCommand =
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'terminate'; reason: string }
  | { action: 'add_constraint'; constraint: { type: string; value: unknown; description: string } };
```

**`add_constraint` 的语义**（页面文档 09 §11 待确认问题 3 的答案）：

约束注入到 Agent 的下一轮上下文，**不重启 Run、不回滚已完成的步骤**。运行时收到后应当：

1. 在当前步骤结束后应用
2. 回一条 `note` 事件确认已接收（让用户看到"Agent 收到了"）
3. 后续行为遵守该约束

页面明确提示「Agent 将在当前步骤结束后应用该约束（约 40s 后生效），已完成的步骤不会回滚」。

---

## 9. 适配器

```
packages/agent-runtimes/
├── base/
│   ├── adapter.ts          抽象接口
│   ├── event-normalizer.ts 各家事件 → RunEvent
│   ├── error-classifier.ts 启发式错误分类（降级用）
│   └── idempotency.ts      运行时不支持时的本地去重
├── claude-code/
├── mcp/
├── http-generic/
└── builtin/                内置的简单 Agent（如需求结构化）
```

### 9.1 抽象接口

```typescript
interface AgentRuntimeAdapter {
  getCapabilities(): Promise<CapabilityManifest>;
  dispatch(task: TaskDispatch): Promise<{ externalRunId: string; accepted: boolean }>;
  subscribe(runId: string, onEvent: (e: RunEvent) => Promise<void>): Promise<Unsubscribe>;
  queryStatus(runId: string): Promise<RunStatus>;        // statusQuery 能力
  control(runId: string, cmd: ControlCommand): Promise<void>;
  respondIntervention(runId: string, resp: InterventionResponse): Promise<void>;
}
```

### 9.2 各适配器要点

| 适配器 | 关键实现点 |
| --- | --- |
| **Claude Code** | 通过 Agent SDK 启动会话；权限映射为 allowedTools/deniedTools；原生支持流式与成本上报，能力最完整 |
| **MCP** | 工具通过 MCP 暴露；MCP 本身不定义"任务"概念，需要在其上包一层任务语义；工具调用可见但推理过程可能不可见 |
| **HTTP 通用** | 最小契约：`POST /tasks` + webhook 回调；适合企业自建 Agent；能力全靠 manifest 声明 |
| **Codex / OpenHands** | 各自 CLI/API 封装；重点是事件归一化与错误分类 |
| **内置** | 需求结构化、计划生成这类 APOS 自己调 LLM 的场景，走同一套 Run 记录以保证可追溯性 |

**内置 Agent 也走协议**这点值得强调：需求结构化和计划生成也是 Agent 行为，也需要 Run 记录、成本统计、可追溯。不能因为"是我们自己调的 LLM"就走后门——那样 Analytics 里的成本统计就是不完整的。

### 9.3 事件归一化示例

```typescript
// Claude Code SDK 事件 → RunEvent
function normalize(raw: SDKMessage, ctx: RunContext): RunEvent[] {
  switch (raw.type) {
    case 'assistant':
      return raw.message.content.flatMap(block => {
        if (block.type === 'text')
          return [{ type: 'reasoning', summary: truncate(block.text, 120), detail: block.text }];
        if (block.type === 'tool_use')
          return [{ type: 'tool_call', toolCallId: block.id, tool: block.name, params: block.input }];
        return [];
      }).map(withSeq(ctx));

    case 'result':
      return [
        { type: 'cost', deltaUsd: raw.total_cost_usd - ctx.lastCost,
          totalUsd: raw.total_cost_usd, tokens: raw.usage },
        { type: 'run_ended',
          outcome: raw.subtype === 'success' ? 'completed' : 'failed',
          summary: raw.result },
      ].map(withSeq(ctx));
    // ...
  }
}
```

---

## 10. 安全

| 关注点 | 措施 |
| --- | --- |
| 回调认证 | 每个 Run 派发时生成短期令牌，仅对该 runId 有效，Run 结束即失效 |
| 事件伪造 | 回调验签（HMAC）+ runId 与令牌绑定校验 |
| 权限逃逸 | 权限清单每次派发下发；APOS 侧对高危工具调用做二次校验，不完全信任运行时执行 |
| 凭证隔离 | Agent 使用自己的凭证，绝不复用人类用户 token（[09 安全](09-security.md) §4） |
| 上下文泄漏 | 下发上下文前按数据分级过滤；敏感数据不进 Agent 上下文 |
| 成本攻击 | 硬性成本上限；异常增长检测；运行时不可控时（无 terminate 能力）强制更低上限 |

**"不完全信任运行时执行"的具体做法**：即使给 Agent 下发了 `allowedTools`，涉及破坏性操作的工具调用（`sideEffects: 'destructive'`）在 APOS 侧再校验一次权限与 Policy。防的是运行时实现有 bug 或被绕过。

---

## 11. 版本演进

- `protocolVersion` 语义化版本
- 向后兼容原则：新增事件类型必须可被旧版本忽略；新增能力字段默认 `false`
- APOS 支持同时对接多个协议版本的运行时
- 破坏性变更需要大版本号，且提供至少一个版本的过渡期

---

## 12. 待确认问题

1. **`selfReport` 是否强制要求？** 它对排障效率影响很大（页面文档 09），但不是所有运行时都能提供。建议：协议规定为 `SHOULD`，不支持时适配器用最后几条事件让 APOS 自己的 LLM 生成一段推测性说明，并明确标注「由 APOS 推断，非 Agent 自述」。
2. **MCP 之上的任务语义如何定义？** MCP 是工具协议不是 Agent 协议。需要确认是在 MCP 之上包一层（APOS 自己驱动对话循环），还是要求 MCP 服务端提供任务级接口。前者控制力强但 APOS 要承担 agent loop 的复杂度。
3. **子 Agent 委派的成本与权限归属**：子 Run 的成本计入父 Run 还是独立？子 Agent 的权限是继承父 Agent 还是独立配置？倾向于成本累计到父 Run（便于用户理解总花费），权限取父子交集（最小权限）。
4. **无 `terminate` 能力的运行时是否应该允许接入？** 从治理角度这是重大缺陷。建议：允许接入但强制标记为「受限运行时」，禁止用于高风险任务，且成本上限强制设为组织默认值的一半。
5. **事件的 `seq` 在孤儿接管后如何续接？** 接管的实例不知道上一个实例处理到哪。方案：seq 由运行时生成而非 APOS，APOS 只负责去重（`(runId, seq)` 主键天然去重）。需要确认所有运行时都能保证 seq 全局单调。
6. **协议是否需要支持"任务取消后的清理"？** Agent 可能已经创建了分支、开了 PR。终止时是否要求运行时清理？倾向于不要求（清理逻辑复杂且易出错），改为 APOS 记录未清理资源并提示人工处理。
