# 09 身份、权限与安全

对应产品文档第十章。

**本文档的核心命题**：这个系统里有一类新的行为主体——它们能读代码、改数据库、发消息、部署服务，但它们不是人，不会被 HR 流程约束，也不会因为"觉得不对劲"而停下来。整个安全模型是围绕这个事实设计的。

---

## 1. 身份模型

产品文档 10.1 定义四类身份，实现上加一类 `system`：

```typescript
type ActorType = 'human' | 'agent' | 'service' | 'external' | 'system';
```

| 类型 | 谁 | 凭证 | 特点 |
| --- | --- | --- | --- |
| `human` | 用户 | SSO / 密码 + MFA | 有法律责任能力 |
| `agent` | Agent 实例 | 独立签发的 Agent Token | **权限独立配置，绝不继承人类** |
| `service` | 内部服务账号 | mTLS / 服务令牌 | 用于系统间调用 |
| `external` | 外部集成 | OAuth token / webhook 签名 | 权限受集成 scope 限制 |
| `system` | 系统自身 | 无 | Flow Engine 的自动流转、定时任务 |

**关键设计：`system` 与 `agent` 分开。** Flow Engine 按状态机自动推进状态时，操作者是 `system` 而非某个 Agent。这让审计能区分"规则驱动的自动行为"与"AI 决策的自动行为"——前者是确定性的、可预测的，后者不是。这个区分在事故复盘时非常重要。

### 1.1 Agent 凭证

```typescript
interface AgentToken {
  sub: string;              // agent id
  actorType: 'agent';
  orgId: string;
  projectIds: string[];     // 该 Agent 参与的项目
  scopes: string[];         // 能力范围
  runId?: string;           // ★ Run 级令牌：仅对该次执行有效
  exp: number;              // Run 级令牌短期（Run 超时时间 + 缓冲）
}
```

**两级令牌**：

| 令牌 | 用途 | 有效期 |
| --- | --- | --- |
| Agent 长期令牌 | 注册、能力查询、健康检查 | 90 天，可轮换 |
| Run 级令牌 | 单次执行的回调、产物上传 | Run 超时时间 + 5 分钟 |

Run 级令牌随任务派发下发（[06 Agent Protocol](06-agent-protocol.md) §4）。Run 结束立即失效。这样即使令牌泄漏，影响也限于单次执行。

### 1.2 绝对禁止的实现

```typescript
// ❌ 绝对不允许：Agent 借用人类身份
async function dispatchRun(item: WorkItem, agent: Agent) {
  const token = await getUserToken(item.ownerId);   // 严重错误
  return runtime.dispatch({ ...task, credentials: token });
}
```

产品文档 10.3 明确要求 Agent 权限独立配置。借用人类 token 会导致：审计日志显示是人做的、权限范围等于那个人的全部权限、无法单独收紧 Agent 权限。

**代码层强制**：`getUserToken` 这类函数不导出给 agent 模块；CI 加静态检查规则禁止 agent 模块引用人类凭证相关的符号。

---

## 2. 授权模型

### 2.1 四层判定

```
请求 → ① 组织角色 → ② 项目角色 → ③ 资源级 Policy → ④ 数据权限(ABAC)
                                                      ↓
                                              任一层拒绝即拒绝
```

| 层 | 判定内容 | 示例 |
| --- | --- | --- |
| ① 组织角色 | 组织内的基础能力 | `org_admin` 可管理 Policy |
| ② 项目角色 | 项目内的操作权限 | `tech_lead` 可批准计划 |
| ③ 资源级 Policy | 高风险操作的额外治理 | 生产发布需 DBA 审批 |
| ④ 数据权限 | 属性级的数据可见性 | 只能看到自己团队的成本数据 |

**③ 与 ①② 的区别**：①② 回答"你有没有资格做"，③ 回答"这件事该不该自动做"。一个 `tech_lead` 有资格批准计划（②通过），但如果计划涉及生产 DDL，Policy 仍要求 DBA 签字（③）。

### 2.1.1 ② 层的实现位置

②（项目角色）在 `apps/api/src/http/routes.ts` 里以一个 `preHandler` 钩子统一落地，
不在各个 handler 里分别写：

| 形状 | 判定 |
| --- | --- |
| `/api/v1/projects/{id}/...` | 按 URL 里的项目 id 查成员关系 |
| `/api/v1/{work-items,runs,decisions,plans,requirements,clarifications,policies,integrations,sync-conflicts}/{id}/...` | 先由资源 id 反查所属项目，再查成员关系 |
| 列表类（`/projects`、`/decision-inbox`、`/agents`） | 查询本身按成员关系 / 组织收窄 |

**为什么是钩子而不是每个 handler 各写一行**：这类漏洞的成因就是「漏了一处」。
钩子按 URL 形状统一拦截，以后新增的项目路由默认是关着的。
**新增资源路由时必须在 `projectOfResource` 里登记**——没登记就等于那条路由不设防。

**非成员返回 404 而不是 403**：403 等于确认「这个项目存在」，
会把项目 id 变成可枚举的探针。文案用「不存在**或**没有权限」，
既不确认存在性，又能让被分享链接的人知道该去切换身份。

### 2.2 角色定义

| 角色 | 层级 | 关键权限 |
| --- | --- | --- |
| `org_admin` | 组织 | 全部；身份管理、组织级 Policy、模型接入、审计查看 |
| `sponsor` | 项目 | 需求确认、预算超限审批、业务验收、结项 |
| `tech_lead` | 项目 | 计划批准、架构决策、Agent 权限调整、Policy 配置、强制放行 |
| `pm` | 项目 | 项目设置、计划批准、调度调整、WIP 配置 |
| `member` | 项目 | 执行任务、接管 Agent、发起决策、重试 |
| `agent_owner` | 资源 | 所属 Agent 的配置（跨项目） |
| `viewer` | 项目 | 只读 |

### 2.3 权限矩阵（关键操作）

| 操作 | 要求 | 附加要求 |
| --- | --- | --- |
| 批准需求 | `sponsor` / `pm` | — |
| 批准计划 | `tech_lead` | 高风险项目需 + `sponsor` 双签 |
| 修改自治等级 | `tech_lead` / `pm` | 二次确认 + 审计 |
| **扩大 Agent 权限** | `tech_lead` | 审计 + 影响预演 |
| 收紧 Agent 权限 | `agent_owner` | — |
| 授予生产环境权限 | `org_admin` | 审计 + 双人确认 |
| **放宽 Policy** | `tech_lead` | **必须携带模拟结果** |
| 收紧 Policy | `pm` | — |
| 强制放行验收标准 | `tech_lead` | 必填原因 + 审计 |
| 处理决策 | 该决策的责任人 | **不可代行**，见 §2.4 |
| 终止 Agent Run | `tech_lead` / `pm` / `agent_owner` | — |
| 查看 Run 详细模式 | `tech_lead` / `agent_owner` | 可能含敏感上下文 |
| 导出审计日志 | `org_admin` | 导出行为本身记审计 |

**不对称设计**：收紧权限比放宽权限要求低。收紧总是安全的，放宽需要更高门槛与额外证据（模拟结果、影响预演）。

### 2.4 决策责任不可代行

```typescript
// ❌ 即使是 org_admin 也不能直接批准他人的决策
async function approveDecision(decisionId: string, actor: Actor) {
  const decision = await getDecision(decisionId);

  const isAssignee = decision.assigneeId === actor.id;
  const isCoSigner = decision.coSigners.includes(actor.id);

  if (!isAssignee && !isCoSigner) {
    throw new Forbidden('DECISION_NOT_ASSIGNED',
      '决策责任不可代行。如需变更责任人，请使用改派功能。');
  }
  // ...
}
```

产品文档 10.5 要求审计能回答"谁批准了关键决策"。如果管理员能代任何人批准，这个问题就没有可靠答案。**改派是可以的，代行是不行的**——改派本身也记审计。

---

## 3. Agent 权限

产品文档 10.3 的示例：

```
Review Agent
允许：读取代码、读取 PR、创建 Review Comment
禁止：合并代码、修改生产配置
```

### 3.1 三个维度

```typescript
interface AgentPermissions {
  allowedTools: string[];       // 白名单
  deniedTools: string[];        // ★ 黑名单，优先级高于白名单
  resourceScopes: Array<{
    kind: 'repo' | 'env' | 'database' | 'external_service' | 'dataset';
    ref: string;                // 'order-service' | 'production'
    access: 'none' | 'read' | 'write';
  }>;
}
```

**黑名单优先**：`deniedTools` 中的工具无论如何都不可用，不能被模板、继承或批量配置覆盖。用于表达"这个 Agent 绝对不能合并代码"这类硬约束。

**默认拒绝**：未在 `resourceScopes` 中列出的资源默认 `none`。不允许通配符授权（`repo: *`）——每个仓库要显式列出。

### 3.2 双重执行点

```
① 派发时：权限清单随任务下发给运行时（06 文档 §4）
   → 运行时据此过滤工具
② 回调时：APOS 对破坏性操作二次校验
   → 防运行时实现有 bug 或被绕过
```

```typescript
// 二次校验：即使运行时放行了，APOS 也要拦
async function validateToolCall(runId: string, tool: string, params: unknown) {
  const run = await getRun(runId);
  const perms = run.permissionSnapshot;          // ★ 用派发时的快照，不是当前配置

  if (perms.deniedTools.includes(tool)) {
    await emitSecurityEvent('agent.permission_violation', { runId, tool });
    throw new Forbidden('TOOL_DENIED');
  }

  const toolMeta = getToolMeta(tool);
  if (toolMeta.sideEffects === 'destructive') {
    const scope = resolveTargetScope(tool, params);
    if (!hasAccess(perms.resourceScopes, scope, 'write')) {
      await emitSecurityEvent('agent.permission_violation', { runId, tool, scope });
      throw new Forbidden('RESOURCE_DENIED');
    }
  }
}
```

**用权限快照而非当前配置**：Run 派发后权限可能被修改。执行中的 Run 应当使用启动时的权限——中途变更会导致行为不一致，且难以审计。收紧权限对执行中的 Run 不立即生效（页面文档 08 §11 已说明）。

**权限违规是安全事件**：`agent.permission_violation` 触发高优先级告警给 `org_admin` 与 `agent_owner`。连续违规自动暂停该 Agent。

### 3.3 权限变更预演

页面文档 08 §5.5 要求 [模拟影响]：

```typescript
async function simulatePermissionChange(agentId: string, changes: PermissionChanges) {
  return {
    affectedPolicies: await findPoliciesReferencingAgent(agentId, changes),
    queuedTasksImpact: await findQueuedTasksRequiring(agentId, changes.removed),
    runningRunsImpact: await findRunningRunsUsing(agentId, changes.removed),
    newlyRequiringApproval: await countTasksThatWillNeedApproval(agentId, changes),
  };
}
```

输出如："此变更将使 3 个 Policy 的判定结果改变，2 个正在排队的任务将转为需要审批"。

---

## 4. 高风险操作

产品文档 10.4 列出九类需要额外治理的操作：

| 操作 | 默认治理 | 组织级规则可否放宽 |
| --- | --- | --- |
| 修改生产数据 | 需 DBA 审批 | 否 |
| 删除资源 | 需多人会签 | 否 |
| 修改权限 | 需 `org_admin` | 否 |
| 访问敏感数据 | 需数据 owner 审批 + 脱敏 | 否 |
| 对外发送信息 | 需人工确认 | 有条件（如仅限内部通知渠道） |
| 执行付款 | 需多人会签 + `sponsor` | 否 |
| 发布生产环境 | 需发布负责人审批 | 有条件（成熟流程可自动化，产品文档 8.8.6） |
| 修改安全策略 | 需 `org_admin` + 审计 | 否 |
| 使用高成本资源 | 需 `tech_lead` 审批 | 是（可设阈值） |

**实现为不可删除的组织级基线 Policy**（[05 Policy Engine](05-policy-engine.md) §4）。优先级 1–20 保留给这些规则，项目级规则（100+）永远排在后面，无法绕过。

**测试保证**（[05](05-policy-engine.md) §9）：穷举各种自治等级与对抗性项目规则组合，断言这九类操作永远不会得到 `allow`。这是 CI 中的阻断性测试。

---

## 5. 数据安全

### 5.1 数据分级

```typescript
type DataSensitivity = 'public' | 'internal' | 'confidential' | 'restricted';
```

| 级别 | 示例 | Agent 可访问 |
| --- | --- | --- |
| `public` | 公开文档 | ✅ |
| `internal` | 内部代码、需求 | ✅（需项目范围内） |
| `confidential` | 客户数据、财务 | 需显式授权 + 脱敏 |
| `restricted` | PII、密钥、支付信息 | ❌ 默认禁止 |

### 5.2 上下文脱敏

Agent 上下文是最容易泄漏敏感数据的地方——它把各处的信息聚合起来送给外部运行时。

```typescript
async function buildAgentContext(item: WorkItem, agent: Agent): Promise<ContextItem[]> {
  const raw = await gatherContext(item);

  return raw
    .filter(c => canAgentAccess(agent, c.sensitivity))    // 过滤
    .map(c => ({
      ...c,
      content: redactSensitive(c.content, {                // 脱敏
        patterns: SENSITIVE_PATTERNS,   // 手机号、身份证、密钥、token
        onRedact: (kind) => recordRedaction(item.id, kind),
      }),
    }));
}
```

页面文档 09 §11 要求界面标注「已脱敏，共 3 处」——脱敏要可见，否则排障时会困惑于"为什么 Agent 说找不到这个值"。

**查看原文**：仅 `org_admin` 可申请，查看行为记审计。

### 5.3 密钥管理

| 类型 | 存储 | 访问 |
| --- | --- | --- |
| 集成 OAuth token | KMS 信封加密 | 仅 integration 模块，按需解密 |
| Agent 运行时凭证 | 同上 | 仅 agent 模块 |
| LLM API Key | 环境变量 / Secret Manager | 仅服务端 |
| Run 级令牌 | 不持久化（JWT 自包含） | — |

**永不回显**：API 返回时只给后四位（`****1234`）。数据库中的加密字段不进日志、不进事件 payload。

---

## 6. 审计日志

产品文档 10.5 要求记录：操作者、身份类型、时间、输入、操作、目标资源、Policy 判断、审批记录、执行结果、失败原因、关联项目和任务。

### 6.1 实现

审计日志**不是独立系统**，而是 `events` 表的一个视图——因为事件模型（[03](03-event-model.md)）已经记录了全部要素：

| 审计要素 | 事件字段 |
| --- | --- |
| 操作者 + 身份类型 | `actor_type`, `actor_id` |
| 时间 | `occurred_at` |
| 操作 | `type` |
| 目标资源 | `subject_type`, `subject_id` |
| 输入 | `payload` |
| Policy 判断 | `payload`（policy.evaluated 事件）+ `context_snapshot` |
| 审批记录 | decision.* 事件 |
| 执行结果 | agent_run.* 事件 |
| 失败原因 | `payload.error` |
| 关联项目任务 | `project_id`, `correlation_id` |

```sql
CREATE VIEW audit_log AS
SELECT id, occurred_at, actor_type, actor_id, type AS action,
       subject_type, subject_id, project_id, payload, correlation_id
FROM events
WHERE level = 'milestone' OR type IN (
  'policy.evaluated', 'agent.permission_violation',
  'work_item.force_passed', 'policy.updated', 'agent.permissions_changed'
);
```

**这是把事件模型做扎实的直接回报**：不需要在每个操作点额外写审计代码，也就不会出现"某个路径忘了写审计"的漏洞。

### 6.2 不可篡改

```sql
REVOKE UPDATE, DELETE ON events FROM apos_app;
```

应用连接的数据库角色没有修改权限。归档到 S3 时开启对象锁（WORM）。

### 6.3 必须记审计的操作

除常规事件外，以下操作强制额外标记 `audit: true`：

- 权限变更（人类与 Agent）
- Policy 创建/修改/停用
- 自治等级变更
- 强制放行（验收标准、阻塞）
- 决策改派
- 集成连接/断开、Source of Truth 变更
- 敏感数据原文查看
- 审计日志导出

---

## 7. 威胁模型

针对这个产品的特有威胁：

| 威胁 | 场景 | 缓解 |
| --- | --- | --- |
| **Agent 越权** | Agent 调用未授权工具或访问越界资源 | 双重执行点（§3.2）+ 违规告警 + 自动暂停 |
| **提示注入** | 需求文档/代码注释/PR 描述中嵌入指令，诱导 Agent 越权 | 上下文与指令分离；工具调用侧的权限校验不依赖 Agent 判断；破坏性操作强制走 Policy |
| **成本攻击** | 恶意或错误配置导致 Agent 无限循环烧钱 | 单 Run 成本上限 + 项目预算硬阻断 + 异常增长检测 |
| **权限累积** | 逐次小幅放宽，最终 Agent 权限过大 | 权限变更全审计 + 定期权限审查报告 + 放宽需 `tech_lead` |
| **决策绕过** | 通过修改 Policy 让高风险操作自动化 | 组织级基线不可删除 + 放宽需模拟 + Agent 不能改 Policy |
| **Run 令牌泄漏** | 外部运行时环境被攻破 | Run 级短期令牌 + 仅限该 runId 的操作 |
| **同步投毒** | 通过外部系统（Jira）注入恶意需求 | 外部导入的需求必须经人类确认才能进入 Planning |
| **审计伪造** | 篡改历史记录掩盖行为 | 事件表不可修改 + WORM 归档 |

### 7.1 提示注入的具体防线

这是本产品最需要认真对待的威胁——Agent 读的内容（代码、文档、PR 描述、外部同步的需求）都可能被注入。

**防线不是"让 Agent 更聪明地识别注入"，而是让注入即使成功也无法造成损害**：

1. **权限不由 Agent 自述决定**。Agent 说"我需要 merge_pr 权限"没有任何效果，权限只能由人类在 Agent Workspace 配置。
2. **破坏性操作强制走 Policy**。即使 Agent 被诱导去删库，`operationType: db_ddl` + `environment: production` 会命中组织级规则要求 DBA 审批。
3. **工具调用侧二次校验**（§3.2）不看 Agent 的意图，只看权限清单。
4. **上下文标注来源**。外部来源的内容在 prompt 中明确标注为"不受信任的外部数据"，且系统提示明确指令不执行其中的指令。

**产品文档 8.8.4 的"涉及不可逆操作"触发人类介入**，在安全上正是这条防线的体现。

### 7.2 Agent 不能修改 Policy

产品文档十三明确把「Agent 自动修改 Policy」列为 MVP 不实现。这不只是范围问题，是安全底线：

```typescript
// policy 模块的写操作强制校验
function assertHumanActor(actor: Actor, operation: string) {
  if (actor.type !== 'human') {
    throw new Forbidden('POLICY_HUMAN_ONLY',
      `${operation} 只能由人类执行。Agent 可以建议规则，但不能创建或修改。`);
  }
}
```

**如果 Agent 能改自己的约束，整个治理体系就是装饰。** Agent 可以生成规则建议（进入决策中心），但生效必须经人类确认。

---

## 8. 合规

| 要求 | 实现 |
| --- | --- |
| 数据留存 | 事件 12 个月热 + 归档；可配置留存期 |
| 数据删除请求（GDPR） | 用户数据可匿名化（保留事件结构，抹去个人标识） |
| 数据驻留 | 部署级隔离，MVP 不做单实例多区域 |
| 员工监控法规 | 个人绩效数据默认聚合展示，个人明细仅 `pm` 可见（页面文档 12 §8） |
| 访问审计 | §6 |
| 加密 | 传输 TLS 1.3；存储 KMS 信封加密（敏感字段） |

**个人绩效数据的边界值得特别注意**：Analytics 能算出每个人的平均决策时间、超时次数。这在部分地区可能构成员工监控。页面文档 12 已定义只做聚合展示，实现上要在 API 层强制——而不是靠前端不显示。

---

## 9. 待确认问题

1. **提示注入的防线是否足够？** §7.1 的四条防线依赖 Policy 配置正确。如果用户把某类操作配成自动放行，注入就有可乘之机。是否需要一类"不可被 Policy 放行"的操作（硬编码）？倾向于需要：删除资源、修改权限、执行付款三类硬编码为永远需要人类。
2. **Agent 长期令牌的轮换机制**：90 天轮换需要运行时配合。不支持轮换的运行时怎么办？
3. **权限审查报告**：定期（季度）生成"哪些 Agent 权限被放宽了、当前权限是否仍必要"的报告。是否 MVP 就做？倾向于 P1，但权限变更审计（数据基础）MVP 必须有。
4. **多租户隔离强度**：MVP 是单实例多租户（RLS + 应用层）。金融/医疗客户可能要求物理隔离。这是部署形态问题，需产品确认目标客户。
5. **敏感数据检测的准确性**：正则匹配会有漏报。是否需要接入专门的 DLP 服务？MVP 建议先用正则 + 用户可标注字段敏感级别。
6. **`system` actor 的责任归属**：Flow Engine 自动流转出问题时，责任在谁？技术上是"规则执行了配置的行为"，但配置是人做的。审计上应当能追溯到"是谁配置了这条规则"——需要在 `system` 事件中附带触发规则的 `policy_id` 与该规则的创建者。
