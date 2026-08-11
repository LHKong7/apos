# 07 API 设计

---

## 1. 约定

| 项 | 约定 |
| --- | --- |
| 风格 | REST，资源导向；复杂聚合查询用专门的只读端点（如 `/overview`） |
| 前缀 | `/api/v1` |
| 格式 | JSON；`camelCase` 字段名（与前端 TS 一致，避免两侧转换） |
| 时间 | ISO 8601 UTC 字符串 |
| 金额 | 字符串形式的十进制（`"8.2000"`），避免浮点精度问题 |
| ID | UUID v4 字符串 |
| 认证 | `Authorization: Bearer <jwt>`；Agent 回调用专用短期令牌 |
| 校验 | Zod schema，与 `packages/contracts` 共享 |

**为什么用 camelCase 而不是 snake_case**：数据库是 snake_case，API 是 camelCase，转换在 Repository 层做一次。让 API 直接匹配前端习惯，避免前端到处写 `work_item.human_gate` 这种在 TS 里别扭的访问。

---

## 2. 错误

```json
{
  "error": {
    "code": "GUARD_FAILED",
    "message": "2 个前置依赖未满足",
    "details": [
      { "id": "wi_123", "title": "数据库索引变更", "type": "finish_to_start", "status": "blocked" }
    ],
    "traceId": "req_01J..."
  }
}
```

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | 请求体不合法 |
| 401 | `UNAUTHENTICATED` | — |
| 403 | `FORBIDDEN` | 权限不足，`details` 说明所需角色 |
| 404 | `NOT_FOUND` | — |
| 409 | `VERSION_CONFLICT` | 乐观锁冲突，`details` 带最新状态 |
| 409 | `INVALID_TRANSITION` | 状态机不允许，`details` 带可用 triggers |
| 409 | `GUARD_FAILED` | Guard 未通过，`details` 带失败原因（可能含 `overridable`） |
| 422 | `POLICY_DENIED` | Policy 拒绝，`details` 带规则名与条件 |
| 429 | `RATE_LIMITED` | — |
| 503 | `RUNTIME_UNAVAILABLE` | Agent 运行时不可达 |

**403 必须说明缺什么权限**。页面文档统一采用"只读降级"而非整页 403，前端需要知道具体缺哪个角色才能渲染 tooltip。

---

## 3. 分页

游标分页，不用 offset（数据实时变动，offset 会漏读或重复）：

```
GET /api/v1/projects/{id}/work-items?cursor=eyJpZCI6...&limit=50

{
  "items": [...],
  "nextCursor": "eyJpZCI6...",
  "hasMore": true
}
```

游标编码 `(sortKey, id)`，保证稳定。

---

## 4. 幂等

所有会产生副作用且可能被重复提交的写操作支持 `Idempotency-Key` 头：

```
POST /api/v1/decisions/{id}/approve
Idempotency-Key: dec_52_approve_01J8X...
```

**必须支持幂等的端点**：决策批准/驳回、Run 派发与重试、发布触发、批量操作。

理由：这些操作要么花钱（重复派发 Agent），要么不可逆（重复批准生产发布）。网络重试导致重复执行是真实风险。

实现：`(idempotency_key, endpoint)` → 首次响应，缓存 24 小时。重复请求直接返回首次结果，
并带上 `Idempotent-Replay: true` 响应头。见 `apps/api/src/http/idempotency.ts`。

**只缓存 2xx**。把失败也缓存下来的话，一次偶发故障会被钉死 24 小时——
客户端之后每次带同一个 key 重试都拿到那个陈旧的错误，再也好不了。

**它防的不是「重复执行」**——那一层由状态机挡住（重复批准同一条决策拿 409
`VERSION_CONFLICT`，副作用不会发生第二次）。它防的是**成功了却被告知失败**：
客户端 POST 批准，响应回来的路上网络断了，它重试，这次拿到 409，
界面显示「批准失败」。用户再点还是失败，而操作第一次就成了。
这比真的失败更难排查，因为服务端日志里一切正常。

---

## 5. SSE

### 5.1 连接

```
GET /api/v1/stream?channels=project:abc:board,user:me:decisions&access_token=<jwt>
Accept: text/event-stream
Last-Event-ID: 1284531
```

★ 令牌走 **query 参数**而不是 `Authorization` 头：EventSource 带不了自定义头
（同一个原因下面 §5.3 的 `Last-Event-ID` 也要支持 query 形态）。
代价是令牌会进 access log，靠短 TTL 缓解。**不带令牌是 401** ——
这条流推的是项目全部实时事件，与 REST 那边同一份数据同样要过鉴权。

```
id: 1284532
event: work_item.status_changed
data: {"workItemId":"wi_88","from":"executing","to":"reviewing","actorType":"system",...}

id: 1284533
event: agent_run.progress
data: {"runId":"run_1284","step":7,"totalSteps":11,"cost":"8.2000",...}

: keepalive
```

### 5.2 频道

| 频道 | 授权要求 | 内容 |
| --- | --- | --- |
| `project:{id}:board` | 项目成员 | Work Item 状态、进度、阻塞 |
| `work_item:{id}` | 项目成员 | 该任务全部事件 |
| `run:{id}` | 项目成员 | 执行流（高频） |
| `agent:{id}` | 组织成员 | Agent 状态与队列 |
| `user:me:decisions` | 本人 | 决策创建/解决/升级 |

**订阅时逐频道鉴权**，无权限的频道从订阅列表中剔除并在首帧告知客户端（不整体拒绝连接）。

### 5.3 断线续传

`Last-Event-ID` 携带最后收到的事件 ID。重连时：

```sql
SELECT * FROM events
WHERE id > $lastEventId AND <频道过滤>
ORDER BY id LIMIT 500;
```

超过 500 条未读时，发一条 `resync` 事件让客户端全量刷新，而不是补发全部——积压太多说明客户端离线很久，增量补发不如重新拉取。

### 5.4 背压

- 同一实体 200ms 内的多次 `progress` 事件合并为最后一条
- 单连接待发队列 > 1000 时降级：只发 `level=milestone` 事件 + 一条 `degraded` 通知
- 客户端断开立即清理订阅

---

## 6. 端点

按页面文档组织。仅列关键端点与非显然的设计点。

### 6.0 登录与账号

设计理由见 [09-security §1.0](09-security.md#10-人类凭证与账号来源)。

```
POST   /auth/login                      ★ 唯一不需要身份的写路由 —— 它就是身份的来源
       ← { email, password }
       → { token, user }
       401 时「账号不存在」「没有口令」「口令错」回同一句话且耗时相同，
          分开说等于给出一个通讯录枚举探针

GET    /auth/me
       → { user, currentOrgId, orgRole }
       前端启动时先问一次：令牌可能过期、可能属于已删除的账号。
       401 → 前端当场退出登录（而不是让每个页面各自报错）

POST   /auth/password                   改自己的口令，作用域是调用者自己
       ← { currentPassword, newPassword }
       → { ok, token }                  ★ 换一张新令牌回去

POST   /admin/users                     开账号，需 organization.members.manage
       ← { email, name, password, orgRole? }
       → 201 { id, name, email, orgRole }
       ★ 建号与加入本组织在同一个事务里 —— 分开的话第二步失败会留下一个
         「能登录但不属于任何组织」的账号，他的每个请求都是 401
       409 表示邮箱已有账号：那时正确的动作是「添加成员」而不是新建，
       同一个人两个账号在审计里就是两个人
```

```
POST   /auth/register            无需身份
       ← { email, name, password, orgName? }
       → 200 { token, user, organization }
       ★ 每次注册**新开一个空组织**，注册者是那个组织的 org_admin ——
         不是加入某个已有组织。要进别人的组织仍然只有「被管理员加进去」
       ★ 与登录不同，409 会明说「邮箱已注册」：不说的话用户没法完成注册。
         缓解手段是限流（按 IP，10 分钟 10 次），不是把话说糊
       429 表示触发限流
```

**注册不破坏多租户边界。** 组织边界就是多租户边界，要防的是**自助进入
已有组织**；而注册开的是一个谁也看不见的新组织。详见 09-security §1。

### 6.1 项目

```
GET    /projects?scope=mine|all&status=&risk=&autonomy=
       → 含预计算指标，指标带 metricsUpdatedAt

POST   /projects
       ← { name, goal, type, autonomyLevel, budget, sponsorId, techLeadId }
       → { projectId, requirementDraftId }   ★ 直接返回需求草稿 ID，前端可直接跳转

GET    /projects/{id}/overview
       → 一次返回总览页全部数据（指标/阻塞/Agent/成员/摘要/流动）
         页面文档 02 的所有区域，避免 8 个并发请求

PATCH  /projects/{id}
       ← { autonomyLevel? , status? }
       高危变更需 header: X-Confirm-Token（前端二次确认后获取）

GET    /me/action-items?limit=5
       → 跨项目的"待我处理"，项目列表页与总览页共用
```

### 6.2 需求

```
POST   /projects/{id}/requirements                   创建草稿

POST   /requirements/{id}/analyze                    ★ SSE 流式返回
       → event: field_updated  { field, value, sources }
       → event: question_added { id, level, question, impact, suggestion, options }
       → event: score_updated  { total, dimensions }
       → event: done           { cost, durationMs }

POST   /requirements/{id}/questions/{qid}/answer
POST   /requirements/{id}/approve   { note? }        → 触发计划生成（异步）
POST   /requirements/{id}/reject    { reason }       reason 必填
POST   /requirements/{id}/delegate  { assigneeId, note }
```

**`analyze` 用 SSE 而不是轮询**：结构化过程 20–60 秒，逐字段流式填充是页面文档 03 §7 明确要求的体验。

### 6.3 计划

```
POST   /requirements/{id}/plans          触发生成（异步任务）
       → { taskId }  轮询或订阅 SSE 获取完成通知

GET    /plans/{id}
       → { plan, workItems, criticalPath, milestones, risks,
           costEstimate, autoActions, requiredApprovals }

GET    /plans/{id}/auto-actions          ★ Policy 预演结果
       → [{ description, policyId, policyName, reversible, externalVisible }]

GET    /plans/{id}/diff?from=v1&to=v2

PATCH  /plans/{id}/work-items/{itemId}
       ← { assignee? | durationHours? | delete? }
       → { affectedItems[], newCriticalPath, newDuration }   ★ 返回影响

GET    /work-items/{id}/assignee-candidates
       → [{ type, id, name, matchScore, matchReasons[], successRate, load, costEstimate }]
       ★ matchReasons 必须可读，页面直接展示

POST   /plans/{id}/approve   { note?, acknowledgedOverrun? }
POST   /plans/{id}/revise    { feedback }
```

### 6.4 看板与 Work Item

```
GET    /projects/{id}/board?view=kanban&filters=...
       → { stages: [{ key, name, wipLimit, count, items[], hasMore }] }
       每列独立分页，Done 列默认只返回 5 条

PATCH  /work-items/{id}/status
       ← { toStatus, reason, reasonCategory, terminateRunningRun? }
       ★ reason 必填（人类覆盖必须记录原因）
       → 409 INVALID_TRANSITION 时返回 allowedTriggers 供 UI 提示

POST   /work-items/{id}/takeover     { agentHandling, reason }   reason 必填
POST   /work-items/{id}/handback     { handoverNote }
POST   /work-items/{id}/reassign     { assigneeType, assigneeId, reason }
POST   /work-items/{id}/retry        { additionalContext? }
POST   /work-items/{id}/split        { subtasks[] }
POST   /work-items/{id}/force-pass   { reason, criteria[] }      需 tech_lead

GET    /work-items/{id}/events?level=milestone|detail&source=&cursor=
```

### 6.5 Agent 与 Run

```
GET    /agents?scope=&type=&status=
GET    /agents/{id}
       → { agent, metrics, queue: { executing, pending, waitingDep,
           waitingDecision, failed }, trends }

PATCH  /agents/{id}
       权限扩大类变更需 header: X-Audit-Reason

POST   /agents/{id}/permissions/simulate     ★ 权限变更影响预演
       ← { changes }
       → { affectedPolicies[], queuedTasksImpact[], runningRunsImpact[] }

POST   /agents/{id}/pause    { reason, runningRunHandling }
POST   /agents/{id}/trial-run { sampleTaskId }

GET    /runs/{id}
       → { run, agentSnapshot, permissionSnapshot, input, metrics,
           artifacts, interventions, error?, related }
GET    /runs/{id}/events?level=brief|detailed&cursor=
GET    /runs/{id}/cost-breakdown?groupBy=step
POST   /runs/{id}/constraints  { constraint }     执行中追加约束
POST   /runs/{id}/terminate    { reason }
POST   /runs/{id}/retry        { additionalContext[], agentId? }
```

### 6.6 决策

```
GET    /decisions?scope=mine&category=&project=&type=&sort=urgency&cursor=
       → { stats: { overdue, dueSoon, pending, coSign, delegated, completedWeek },
           decisions: [...] }
       ★ 列表项必须自带页面文档 10 §5.3 的八个字段（whyYou/consequence/
         recommendation/alternatives/evidence），避免逐条再请求详情

GET    /decisions/{id}
       → 完整详情，含 options 对比、evidence、similarDecisions、discussion

POST   /decisions/{id}/approve
       ← { optionId, constraints: [{ type, value, enforcement }], note? }
       Idempotency-Key 必需
POST   /decisions/{id}/reject            { reason }   必填
POST   /decisions/{id}/request-revision  { feedback }
POST   /decisions/{id}/delegate          { assigneeId, note }
POST   /decisions/batch                  { ids[], action, note }
       ★ 服务端校验：仅低风险同类型可批量；高风险自动排除并在响应中说明

GET    /decisions/{id}/similar           历史相似决策 + 结果
GET    /decisions/automation-suggestions 可自动化的重复决策
POST   /decisions/{id}/comments          { body, mentions[] }
```

### 6.7 Policy

```
GET    /projects/{id}/policies
       → { orgPolicies[], projectPolicies[], summary: { autoActions[], humanRequired[] },
           conflicts[] }
       ★ summary 是"14 类自动执行、6 类需确认"的数据来源

POST   /policies
PATCH  /policies/{id}
       ★ direction=loosen 时必须携带有效 simulationId，否则 422

POST   /policies/simulate                历史回放
       ← { policyDraft, projectId, range }
       → { totalSamples, skippedForMissingFacts, wouldAutoHandle,
           mismatches[], suggestions[], confidence }

POST   /policies/evaluate                手动构造场景测试
       ← { context }
       → { result, matchedPolicy, evaluationTrace[] }
       ★ trace 展示"被哪条高优先级规则拦截"

GET    /policies/{id}/history
```

### 6.8 Analytics

```
GET /projects/{id}/analytics/flow?range=30d&compare=true
GET /projects/{id}/analytics/agents?range=30d
GET /projects/{id}/analytics/hitl?range=30d
GET /projects/{id}/analytics/cost?range=30d&groupBy=
GET /projects/{id}/analytics/quality?range=30d
GET /projects/{id}/analytics/insights?range=30d
    → [{ severity, type, message, evidence, actions[] }]
    ★ actions 带可直接调用的端点与预填参数
```

**所有 Analytics 端点返回 `dataAsOf` 字段**（预聚合的截止时间），页面展示"数据截至 15:00"。

### 6.9 集成与 Agent 回调

```
GET    /projects/{id}/integrations
POST   /integrations/oauth/start        { provider, projectId }
PATCH  /integrations/{id}/sync-mapping  { field, sourceOfTruth, conflictStrategy }
GET    /projects/{id}/sync-conflicts
POST   /sync-conflicts/{id}/resolve     { winner, applyToSimilar? }

# 外部 webhook 入口（独立认证）
POST   /webhooks/github     签名验证
POST   /webhooks/jira
POST   /webhooks/{provider}

# Agent 回调（专用短期令牌，见 06 文档 §10）
POST   /agent-callback/runs/{runId}/events
       Authorization: Bearer <run-scoped-token>
       ← RunEvent | RunEvent[]
POST   /agent-callback/runs/{runId}/artifacts
```

---

## 7. 聚合端点的取舍

有几个端点（`/overview`、`/board`、决策列表）刻意做成"一次返回一屏所需的全部数据"，违反了纯 REST 的资源导向。

**理由**：这些页面的信息密度很高。`/projects/{id}/overview` 如果拆成 8 个资源端点，首屏就是 8 个往返，移动网络下体验很差。而且这些数据天然一起消费，没有独立复用价值。

**边界**：只有页面文档明确定义的高密度页面做聚合端点，其余走标准资源端点。聚合端点不接受任意字段选择参数（那会变成半个 GraphQL），返回结构固定。

---

## 8. 长任务

需求分析、计划生成、模拟、导出这类耗时操作：

| 时长 | 方式 |
| --- | --- |
| < 3s | 同步返回 |
| 3–60s，需要过程可见 | SSE 流式（需求分析） |
| > 60s | 异步任务 + 轮询/通知（计划生成、大批量导入） |

异步任务统一形式：

```
POST /requirements/{id}/plans   → 202 { taskId }
GET  /tasks/{taskId}            → { status, progress, result?, error? }
                                  或订阅 SSE user:me:tasks
```

---

## 9. 限流

| 对象 | 限制 |
| --- | --- |
| 普通读接口 | 300 req/min/user |
| 写接口 | 60 req/min/user |
| LLM 触发接口（analyze/plan/simulate） | 10 req/min/user + 项目成本上限 |
| Agent 回调 | 1000 req/min/run（事件密集） |
| Webhook | 按 provider 配置 |

LLM 触发接口的限流不只为了保护服务，也是**成本护栏**——防止用户反复点击"重新分析"烧钱。前端按钮上显示的成本预估配合这个限流一起工作。

---

## 10. 待确认问题

1. **API 版本策略**：目前用 `/v1` 路径前缀。考虑到 MVP 期间前后端同步发布，是否需要版本？倾向于保留前缀但 MVP 期间不承诺兼容性。
2. **聚合端点的缓存**：`/overview` 数据变化频繁但计算不便宜。是否加短 TTL 缓存（10s）？会导致操作后刷新看不到最新结果，需要配合 SSE 补偿。
3. **批量操作的响应形式**：部分成功时返回 200 带每项结果，还是 207 Multi-Status？倾向于 200 + 明确的每项结果，前端处理更简单。
4. **Agent 回调的令牌泄漏风险**：令牌随任务下发给外部运行时。如果运行时环境被攻破，令牌可用于伪造事件。是否需要额外的事件内容签名？倾向于 MVP 用短期令牌 + IP 白名单（自建运行时可行），SaaS 运行时接受风险。
5. **SSE 在企业代理环境下的可靠性**：部分企业代理会缓冲 SSE 流。是否需要 WebSocket 降级路径？建议 MVP 先用 SSE + 定期全量刷新兜底，遇到实际问题再加。
