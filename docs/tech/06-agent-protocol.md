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
| **Claude Code** | 通过 Agent SDK 启动会话；权限映射为 tools/allowedTools/disallowedTools + canUseTool；原生支持流式与成本上报，能力最完整。实现细节见 §9.4 |
| **MCP** | 工具通过 MCP 暴露；MCP 本身不定义"任务"概念，需要在其上包一层任务语义；工具调用可见但推理过程可能不可见 |
| **HTTP 通用** | 最小契约：`POST /tasks` + webhook 回调；适合企业自建 Agent；能力全靠 manifest 声明 |
| **Codex** | CLI 封装；权限是沙箱级而非工具级，映射时一律收紧。实现细节见 §9.5 |
| **通用 headless CLI** | pi / Gemini CLI / Aider / Goose / OpenCode / Qwen Code 共用**一个**适配器 + 一张声明式 profile 表。实现细节见 §9.6 |
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

### 9.4 Claude Code 适配器实现纪要

代码位置 `packages/agent-runtimes/src/claude-code/`，依赖 `@anthropic-ai/claude-agent-sdk`（可选 peer 依赖，运行时动态加载 —— 不接 Claude Code 的部署不必安装这个包）。

#### 权限：默认拒绝

APOS 的 `AgentPermissions` 映射到 SDK 的四个开关，组合出闭世界语义：

| APOS | SDK | 作用 |
| --- | --- | --- |
| `allowedTools` 的基础工具名 | `tools` | 决定 Agent **看得到**哪些工具 |
| `allowedTools` 原文（含作用域） | `allowedTools` | 决定什么**免确认放行** |
| `deniedTools` | `disallowedTools` | 黑名单，优先级最高 |
| 其余一切 | `canUseTool` | 落到适配器手上处置 |

两个额外约束：

- **`settingSources: []`** —— 不加载 user / project / local 配置。否则仓库里的 `.claude/settings.json` 就能把 Policy 拒绝过的工具放回来，权限模型形同虚设。
- **无 `repo:write` 范围时禁用全部写工具**（`Write` / `Edit` / `MultiEdit` / `NotebookEdit`）。只在 prompt 里写「请不要改文件」不是权限控制。

#### 未授权工具 → 人工决策

`canUseTool` 只在「既没被白名单放行、也没被黑名单拦掉」时触发，恰好就是「Agent 想要一个没给它的能力」。适配器据此分流：

- 命中显式黑名单 → 直接拒绝，不打扰人类（Policy 已经判过了）
- 未授权 → 发 `intervention_request`（`reason: permission_needed`）并以 `interrupt: true` 拒绝

第二条让 Agent 的求助落成 Decision 待办（`ingest.ts` 的提升规则），而不是让它在缺能力的情况下继续试探。想关掉这个行为可以配 `onUngrantedTool: 'deny'`，此时能力清单里的 `interventionRequest` 同步变为 `false` —— 不静默降级。

#### 凭证与环境隔离

- 凭证读 `APOS_AGENT_ANTHROPIC_API_KEY`，**与平台自用的 `ANTHROPIC_API_KEY` 分开**。未配置时直接拒绝派发，不会悄悄回退到平台 key。要复用必须显式设 `allowInheritedCredentials`，留下审计痕迹。
- 子进程环境只给 `PATH` / `HOME` / Agent 自己的 key。不做 `{ ...process.env }` —— 那等于把数据库口令和其他服务的 token 一起交给 Agent，绕开资源范围控制。

#### 接中转站：接入地址、凭证变量名、环境变量表

官方端点之外还有一大类接法：中转站、自建网关、Bedrock/Vertex 前置代理。它们要的三样东西分别落在三处：

| 要配的 | 配在哪 | 落成什么 |
| --- | --- | --- |
| 网关地址 | Agent 的「接入地址」（`agents.endpoint`） | `ANTHROPIC_BASE_URL` |
| 认证方式 | 配置项 `credentialEnv` | 凭证下发到 `ANTHROPIC_API_KEY` 还是 `ANTHROPIC_AUTH_TOKEN` |
| 其余任意变量 | 配置项 `env`（一份 JSON） | 原样下发给子进程 |

**为什么 `credentialEnv` 值得一个独立的配置项**：官方端点走 `x-api-key`，多数中转站走 `Authorization: Bearer`，认的是 `ANTHROPIC_AUTH_TOKEN`。下错变量名的表现是一句 401，而 401 里没有任何东西指向「名字错了」。做成一栏明确的选择，比让人去环境变量表里猜强。改投之后**不再同时下发 `ANTHROPIC_API_KEY`** —— 两个都给的话 SDK 会优先认 API Key，症状是「我明明改成了 AUTH_TOKEN，请求还是带着 x-api-key 打官方端点」。

**为什么要有 `env` 这个自由 JSON**：平台的配置 schema 一定滞后于运行时。网关地址与 token 属于**这个 Agent**，不属于 APOS 进程 —— 用 `passthroughEnv`（给变量名、值从 APOS 环境取）表达不了，为一个 Agent 去改部署的环境变量还会波及所有共用该变量名的 Agent。

它仍然是**声明出来的一个字段**，不是「整坨配置随便填」：

- **值的形状照样校验**。键必须是合法变量名，值必须是字符串 —— 写成 `{"MAX_TOKENS": 4096}` 会在保存那一刻被拒，而不是让 Node 悄悄转成 `"4096"`。
- **敏感键照样走加密通道**。键名含 `TOKEN` / `KEY` / `SECRET` / `AUTH` 等字样时（判据 `isSecretEnvKey`，按下划线切段匹配，`GIT_AUTHOR_NAME` 不算），字面量值加密入库，接口只回占位符 `secret://saved`。把这个占位符原样存回来表示「这一项不改」—— 界面上那是一个 JSON 文本框，改网关地址时整份 JSON 会一起提交，没有这个约定的话改一个字段就会把同一份里的 token 冲掉。
- **不接受手工填写的 `secret://` 引用**。否则任何能编辑 Agent 的人都可以粘一条 `secret://env/DATABASE_URL` 进来，把 APOS 进程环境里的任意变量读给 Agent —— 那正是 `passthroughEnv` 那份白名单要挡住的事。要从进程环境取值只能写 `env:变量名`。
- **解不开的引用不下发，并在配置页上列出来**。悄悄下发空串的表现是 Agent 报一句 401，而现场没有任何东西指向「那把 key 所在的环境变量没设置」。

**叠加顺序是由平台到用户，`env` 排最后**：最小集 → 凭证 → 接入地址 → `passthroughEnv` → `env`。用户填的一定生效，哪怕代价是他能把自己的凭证覆盖掉 —— 「我填了却没生效」是配置类功能最坏的失败形态。

代价说清楚：这一栏能把上面的安全设置绕过去（比如手工给一个放开限制的变量），所以它在界面上标着「影响安全边界」。

**凭证也可以只写在 `env` 里**。此时凭证栏是空的，`dispatch` 的凭证闸门认这种形态 —— 否则一个配好了、也确实能跑的 Agent 会被拒发，而报错还理直气壮地让人去配 `APOS_AGENT_ANTHROPIC_API_KEY`。同样的规则适用于 Codex 与六个通用 CLI。

#### 成本：估算 + 权威值校正

Claude Code 只在 Run 结束时给出权威的 `total_cost_usd`，但看板需要执行过程中的成本。因此走双轨：

1. 每轮按 `message.usage` 的真实 token × 本地单价表估算，发 `cost` 事件
2. `result` 到达时发一条差额事件把累计值校正为 `total_cost_usd`，`tokens` 全填 0（ingest 对 token 是累加语义，再报一次会重复计数）

单价表过期只影响过程中的显示，不影响最终账目。另外把 `limits.maxCostUsd` 直接传给 SDK 的 `maxBudgetUsd` —— 预算是运行时侧的硬约束，不用等我们的成本事件追上。

#### 能力与降级

| 能力 | 支持 | 说明 |
| --- | --- | --- |
| `pause` | ✗ | SDK 无暂停/恢复语义。按降级矩阵，暂停退化为终止，需二次确认 |
| `runtimeConstraints` | ✓ | prompt 用 `AsyncIterable` 输入，执行中可注入约束（Approve with Constraints 真正落到运行时） |
| `terminate` | ✓ | `abortController.abort()` |
| `statusQuery` | ✓ | 仅限本进程持有的 Run。查不到即视为已终止 —— 会话是本进程的子进程，进程重启后子进程不复存在，这个回答对孤儿 Run 判定是可行动的 |
| `artifactUpload` | ✓ | Claude Code 没有产物上传通道，适配器从最终回复合成：正文存为 `document`，回复里出现的 PR 链接单列为 `pull_request` |
| `subAgentDelegation` | ✓ | `task_started` 消息翻译为 `delegation` 事件 |

#### 错误分类

优先用运行时**上报**的结构化信号（`classificationSource: 'reported'`），拿不到才退回文本启发式（标 `'inferred'`，恢复策略对它更保守）：

| 信号 | 分类 |
| --- | --- |
| `error_max_budget_usd` | `budget_exceeded`，不可重试 |
| `error_max_turns` | `timeout`，可重试 |
| `permission_denials` 非空 | `permission_denied`，不可重试 |
| `SDKAssistantMessage.error` | 按错误码映射（认证 → `permission_denied`，限流/过载 → `external_unavailable`…） |
| 模块加载失败 | `runtime_error`，不可重试 —— 部署问题重试多少次都没用 |

**`subtype: 'success'` 不等于任务成功。** 认证失败这类错误会以 `subtype='success'` + `is_error=true` 回来，`result` 文本就是那句报错。只看 subtype 会把彻底失败的 Run 记成 `completed`，任务随即流转到 reviewing，还带上一条以报错为正文的产物。适配器因此用三个信号判定失败：`subtype !== 'success'`、`is_error`、执行中出现过致命错误。`queryStatus` 的终态也直接取 `run_ended` 的 outcome，不各判一次 —— 两处独立判断迟早会打架。

> 这两条都是拿真实 SDK 跑一遍才暴露的，单测里的假 SDK 不会自己造出这种组合。

#### 事件顺序

`subscribe` 把投递串成一条 Promise 链，保证订阅者严格按 `seq` 收到事件。`(runId, seq)` 是 `run_events` 的主键，乱序会让去重和增量更新都失效。`run_started` 在会话真正启动前就发出 —— 会话起不来时也要能看到 Run 开始过。

### 9.5 Codex 适配器实现纪要

代码位置 `packages/agent-runtimes/src/codex/`。它压出了协议里一个此前没被验证的假设：**权限模型未必是工具级的**。Codex 只有沙箱级（`read-only` / `workspace-write`），表达不了「Bash 可用但 rm 不可用」。映射一律**收紧**，表达不了的规则列进 `unenforceable` 并在 Run 详情里显示 —— 静默吞掉的话，用户会以为 `deniedTools` 在这里也生效了。

### 9.6 通用 headless CLI 适配器

代码位置 `packages/agent-runtimes/src/cli/`。**一个** `GenericCliRuntime` + 一张声明式 profile 表覆盖六个 CLI：

| kind | 二进制 | prompt 投递 | 输出形态 | 流式 | 工具可见 | token |
| --- | --- | --- | --- | --- | --- | --- |
| `pi` | `pi` | `-p <prompt>` | 纯文本 | ✓ | ✗ | ✗ |
| `gemini_cli` | `gemini` | `-p <prompt>` | **单个 JSON** | ✗ | ✗ | ✓ |
| `aider` | `aider` | `-m <prompt>` | 纯文本 | ✓ | ✗ | ✗ |
| `goose` | `goose` | stdin | stream-json | ✓ | ✓ | ✓ |
| `opencode` | `opencode` | 位置参数 | 纯文本 | ✓ | ✗ | ✗ |
| `qwen_code` | `qwen` | `-p <prompt>` | stream-json | ✓ | ✓ | ✓ |

**为什么共用一个适配器**：把 Codex 那个抄六遍，抄的是同一份东西 —— 起子进程、设 cwd、给最小环境、超时后 SIGTERM 再补 SIGKILL、留 stderr 尾巴、事件按 seq 串行投递。这些对所有 CLI 一模一样，而且是**已经踩过一遍坑**的部分。真正不同的只有五件事（二进制名、argv、prompt 从哪进、输出形态、凭证环境变量），它们是数据不是逻辑。

**为什么解析是防御式的**：这六个的输出格式来自各自的文档，不是实测。照文档写逐字段映射，字段名一变事件流就**静默变空** —— Run 在跑、界面上什么都没有、没有任何报错。所以 `translate.ts` 反过来做：只认结构上认得出的（用量数字、错误、文本、工具调用），**认不出来的原样透出成 note**。代价是事件流不如 Claude Code 精细，收益是永远不丢东西，下一个人能照着 note 把映射补上。

**三处对所有 CLI 都成立的降级**，如实写进能力清单：

1. **权限是沙箱级的** —— 复用 §9.5 的 `mapSandbox`，表达不了的规则在 Run 详情里列出来
2. **没有 system prompt 通道** —— 治理规则只能折进用户消息最前面（`buildInlinePreamble`），权重低于真正的 system prompt
3. **单次执行、无中途注入** —— `runtimeConstraints` / `interventionRequest` 均为 false

几条针对性的处理：Aider 强制 `--no-auto-commits`（提交由工作区供给统一负责，两边都提交会让一个 Run 产出一堆零碎提交）；自动批准（`--yolo` / `--approval-mode yolo`）只在可写沙箱下给；Gemini CLI 在 `subscribe` 时先发一条 note 说明「要跑完才有输出」，否则用户会对着不动的执行流以为卡死。

**加第七个 CLI**：在 `cli/profile.ts` 加一条 profile、在 `contracts/runtime-config.ts` 加一条 spec。适配器与 factory 一个字不用改，配置界面自动长出表单。

这六个也各自带一份 `env` 环境变量表（§9.4 的规则原样适用）。profile 里的 `baseUrlEnv` 为 `null` 的那几个（pi / gemini_cli / goose / opencode）没有声明式的接入地址通道，接自建端点只能走 `env` —— 这正是那个口子存在的意义：不必等平台先给每个 CLI 补一条 `baseUrlEnv`。

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
