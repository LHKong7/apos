# 05 Policy Engine

*[English version / 英文版本](05-policy-engine.md)*

产品文档 3.2 的核心主张之一：「Policy 驱动，而不是每一步都审批」。Policy Engine 决定哪些事 Agent 可以自己做，哪些必须找人。

它是整个治理体系的落点——**如果 Policy Engine 不可信，用户就不敢放开自动化；不放开自动化，产品价值就归零。**

---

## 1. 三条设计约束

| 约束 | 来源 | 影响 |
| --- | --- | --- |
| **快** | 在每次状态流转的关键路径上 | 规则编译进内存，评估不查库，P99 < 10ms |
| **可模拟** | 页面文档 13 要求用历史数据验证规则 | 规则必须是纯函数；事件必须携带上下文快照 |
| **可解释** | 页面文档 13 要求自然语言解释；11 要求展示触发规则 | 规则是结构化 AST 而非代码字符串；评估返回完整 trace |

第三条决定了规则不能用 JS 表达式或嵌入式脚本——那样无法生成可靠的自然语言解释，也无法在 UI 里做可视化编辑。

---

## 2. 规则表示

### 2.1 结构

```typescript
// packages/contracts/src/policy/rule.ts

interface Policy {
  id: string;
  orgId: string;
  projectId: string | null;      // null = 组织级
  name: string;
  description: string;
  priority: number;              // 越小越先评估
  enabled: boolean;
  condition: Condition;
  action: Action;
}

type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { fact: FactKey; op: Operator; value: FactValue };

type Operator =
  | 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'
  | 'in' | 'not_in' | 'contains' | 'matches';

type Action =
  | { type: 'allow' }
  | { type: 'allow_and_notify'; notify: Recipient[] }
  | { type: 'require_agent_review'; agents: string[] }
  | { type: 'require_human_review'; assignee: Recipient; dueInHours: number }
  | { type: 'require_multiple_approvals'; approvers: Recipient[]; mode: 'all' | 'majority' }
  | { type: 'ask'; assignee: Recipient }          // 不阻断，给建议
  | { type: 'pause'; resumeCondition?: string }
  | { type: 'deny'; message: string }
  | { type: 'escalate'; to: Recipient }
  | { type: 'transfer_to_human'; assignee: Recipient };

type Recipient =
  | { kind: 'role'; role: string }               // 'dba' | 'tech_lead' | 'sponsor'
  | { kind: 'user'; userId: string }
  | { kind: 'project_role'; role: 'pm' | 'tech_lead' | 'sponsor' }
  | { kind: 'owner_of'; subject: 'work_item' | 'agent' };
```

**用角色而非具体人**：产品文档 8.7.5 的责任映射是按角色定义的（数据库变更 → DBA）。人员变动时规则不用改。

### 2.2 示例：产品文档 8.9.3 的三条规则

```json
[
  {
    "name": "低风险任务自动批准",
    "priority": 100,
    "condition": {
      "all": [
        { "fact": "riskLevel",     "op": "eq", "value": "low" },
        { "fact": "testsResult",   "op": "eq", "value": "passed" },
        { "fact": "agentReview",   "op": "eq", "value": "passed" },
        { "fact": "runCost",       "op": "lt", "value": 10 }
      ]
    },
    "action": {
      "type": "allow_and_notify",
      "notify": [{ "kind": "project_role", "role": "pm" }]
    }
  },
  {
    "name": "生产数据库变更必须由 DBA 审批",
    "priority": 1,
    "condition": {
      "all": [
        { "fact": "environment",   "op": "eq", "value": "production" },
        { "fact": "operationType", "op": "in", "value": ["db_ddl", "db_dml"] }
      ]
    },
    "action": {
      "type": "require_human_review",
      "assignee": { "kind": "role", "role": "dba" },
      "dueInHours": 4
    }
  },
  {
    "name": "Agent 连续失败 3 次转人工",
    "priority": 20,
    "condition": { "fact": "consecutiveFailures", "op": "gte", "value": 3 },
    "action": {
      "type": "pause",
      "resumeCondition": "human_decision"
    }
  }
]
```

### 2.3 Fact 清单

**这份清单是事件快照的设计依据**（[03 事件模型](03-event-model.zh.md) §4）。新增 fact 会导致该 fact 之前的历史数据无法模拟，因此首版要尽量覆盖。

对应产品文档 8.9.1 列出的十六类条件：

| Fact | 类型 | 来源 |
| --- | --- | --- |
| `projectType` | string | project.type |
| `workItemType` | enum | work_item.type |
| `riskLevel` | enum | work_item.risk_level |
| `reversible` | boolean | 操作元数据 |
| `externalFacing` | boolean | 是否影响外部客户 |
| `environment` | enum | 操作目标环境 |
| `dataSensitivity` | enum | 涉及数据的分级 |
| `impactScope.tasks` | number | 影响的下游任务数 |
| `impactScope.services` | string[] | 涉及的服务 |
| `operationType` | string | db_ddl / deploy / delete_resource / send_external / payment / … |
| `agentType` | string | agent.type |
| `agentConfidence` | number | Agent 上报的置信度 |
| `agentSuccessRate` | number | agent.stats |
| `consecutiveFailures` | number | 该 Work Item 连续失败次数 |
| `runCost` | number | 本次 Run 成本 |
| `projectCostSpent` | number | 项目累计成本 |
| `projectBudget` | number\|null | 项目预算 |
| `budgetUsedPct` | number | 派生：spent / budget |
| `testsResult` | enum | passed / failed / not_run |
| `testCoverage` | number\|null | CI 上报 |
| `securityScan` | enum | passed / failed / not_run |
| `agentReview` | enum | passed / concerns / failed / not_run |
| `autonomyLevel` | enum | project.autonomy_level |

**派生 fact**（如 `budgetUsedPct`）在上下文构建时计算，不让规则编写者自己算——降低出错概率。

---

## 3. 评估

### 3.1 算法

```typescript
function evaluate(ctx: PolicyContext, rules: CompiledRule[]): PolicyVerdict {
  const trace: TraceEntry[] = [];

  for (const rule of rules) {          // 已按 priority 升序排列
    const matched = matchCondition(rule.condition, ctx);
    trace.push({
      policyId: rule.id,
      name: rule.name,
      matched,
      // 未命中时记录哪个子条件失败，供 UI 展示"为什么没走这条"
      failedAt: matched ? null : firstFailingLeaf(rule.condition, ctx),
    });

    if (matched) {
      return {
        action: rule.action,
        matchedPolicyId: rule.id,
        trace,                          // 含已评估的所有规则
        contextSnapshot: ctx,           // ★ 写入事件，供后续模拟
      };
    }
  }

  return { action: defaultAction(ctx), matchedPolicyId: null, trace, contextSnapshot: ctx };
}
```

**首次命中即停止**。这是最容易被误解的语义，因此页面文档 13 §5.7 要求在模拟测试里展示完整匹配过程，让用户看到"被高优先级规则拦截了"。

**同优先级时更严的先评估**。命中即停意味着两条优先级相同、又都能匹配同一上下文的规则，谁排前面谁说了算。不定序的话这个"谁"由数据库返回行的顺序决定——同一份配置在两台机器上可能给出相反的判定，而这种问题几乎不可能复现。平局倒向更严的那一条：并列意味着用户没有表态哪条更重要，而在治理配置上，没表态时选安全的那一侧是唯一说得过去的默认。

### 3.2 默认动作

无规则命中时，按项目自治等级决定（产品文档 8.9.4）：

```typescript
function defaultAction(ctx: PolicyContext): Action {
  switch (ctx.autonomyLevel) {
    case 'human_led':
      return { type: 'require_human_review',
               assignee: { kind: 'project_role', role: 'pm' }, dueInHours: 8 };
    case 'agent_led_approval':
      return ctx.riskLevel === 'low' || ctx.riskLevel === 'medium'
        ? { type: 'allow' }
        : { type: 'require_human_review',
            assignee: { kind: 'project_role', role: 'tech_lead' }, dueInHours: 4 };
    case 'agent_autonomous':
      return { type: 'allow' };
  }
}
```

**安全底线**：无论自治等级与项目规则如何，这三类操作永远不会得到 `allow`：

删除资源 · 修改权限 · 执行付款

它们**硬编码在求值器里**（`NEVER_AUTO_APPROVE`，`enforceSafetyFloor`），不是一条可以被删掉或改写的规则——一条能被配置绕过的底线不是底线。产品文档 10.4 的另外六类高风险操作由用户自己配规则管住；一条都没配时，体检会把"这类操作现在走的是自治等级默认"如实说出来（`coverage_gap`）。

> **它们曾经是十条硬编码的组织级基线规则**（`BASELINE_POLICIES`），无论库里有没有规则都参与求值。删掉的理由不是它们管得不对，是它们让"这个项目现在到底按什么规则跑"这个问题在界面上答不出来：用户看得见的规则列表和实际生效的规则不是同一份。现在**生效规则 = 库里用户录入的那些，一条都没有就是零条**；真正不能商量的那三类，改由求值器直接兜住。

**读不懂的 fact 取值一律拒收**。`operationType` / `environment` / `dataSensitivity` 从工作项的 `typeData` 里读出来时逐个按枚举解析，认不出就抛错，而不是兜底成一个近似值。兜底往宽的一侧猜的代价是：`"delete_resrouce"`（拼错一个字母）会原样进到上下文里，`NEVER_AUTO_APPROVE` 认不出它，安全底线就被一个拼写错误整条绕过去——而现场毫无迹象，任务照常跑完，规则一条都没命中。计划输出侧同样是严格枚举，拒收发生在解析那一步，也就是重试与澄清还来得及的地方。

### 3.3 编译与缓存

```typescript
class PolicyCache {
  private compiled = new Map<string, CompiledRule[]>();   // key: `${orgId}:${projectId}`

  get(orgId: string, projectId: string): CompiledRule[] {
    const key = `${orgId}:${projectId}`;
    let rules = this.compiled.get(key);
    if (!rules) {
      rules = this.compile(orgId, projectId);
      this.compiled.set(key, rules);
    }
    return rules;
  }

  private compile(orgId: string, projectId: string): CompiledRule[] {
    const org = loadOrgPolicies(orgId);        // 组织级
    const proj = loadProjectPolicies(projectId);
    return [...org, ...proj]
      .filter(p => p.enabled)
      .sort((a, b) => a.priority - b.priority)
      .map(p => ({ ...p, condition: compileCondition(p.condition) }));
      // compileCondition 把 AST 编译成闭包，避免每次评估遍历 JSON
  }

  // 规则变更时通过 Redis Pub/Sub 广播失效，所有实例同步
  invalidate(orgId: string, projectId?: string) { /* ... */ }
}
```

**缓存失效的一致性**：规则变更到全部实例生效有几百毫秒延迟。页面文档 13 §7 要求明确提示生效时间，且**进行中的 Run 使用启动时的规则快照**——避免任务跑到一半规则变了导致行为不一致。

---

## 4. 组织级与项目级的继承

产品文档隐含要求（第十章权限与安全）：企业治理底线不能被单个项目绕过。

### 4.1 规则

| 规则 | 实现 |
| --- | --- |
| 组织级规则优先评估 | priority 区间划分：组织级 1–99，项目级 100+ |
| 项目不能删除组织规则 | UI 与 API 双重限制 |
| 项目**只能收紧，不能放宽** | 见 §4.2 |

项目级那一段（100+）内部再分两格：

| 区间 | 谁占 | 分配方式 |
| --- | --- | --- |
| 100 | 操作开关矩阵（每个操作类型至多一条） | 固定 |
| 101+ | 手写规则 | 服务端往后追加（`nextAuthoredPriority`） |

开关排在手写规则**前面**：开关是用户刚刚做出的表态，被一条半年前写的规则默默盖掉是最难查的一类问题。同格内不会冲突——每条开关各锁一个 `operationType`，两条永远不会同时命中。

优先级不再出现在编辑界面上。它要求用户同时理解"越小越先""命中即停""组织规则占了前面那一段"三件事才填得对，而填错的表现是规则安静地不生效——一个填错了不报错、还看不出来的输入框，换来的是一次困惑，不是一次配置。真要手动排的人在编辑器的"高级"里仍然改得到。

### 4.2 "只能收紧"如何强制

严格的形式化验证（对任意上下文证明项目规则不会比组织规则更宽松）计算上不可行。实际采用两层保护：

**第一层（运行时，硬保证）**：组织规则先评估且命中即终止。因此如果组织规则说"生产 DDL 需 DBA 审批"，项目规则无论怎么写都不可能让这个场景自动通过——它根本走不到项目规则。

**第二层（保存时，静态检查）**：保存项目规则时，做有限的静态分析：

```typescript
function checkPermissiveness(draft: Policy, orgRules: Policy[]): Warning[] {
  // 找出与该草稿条件有交集、且动作更严格的组织规则
  const overlapping = orgRules.filter(o =>
    conditionsMayOverlap(o.condition, draft.condition) &&
    strictness(o.action) > strictness(draft.action)
  );

  return overlapping.map(o => ({
    level: 'info',
    message: `组织规则「${o.name}」在部分场景下更严格，那些场景将由它处理，此规则不会生效`,
    orgPolicyId: o.id,
  }));
}
```

`conditionsMayOverlap` 用区间/枚举集合的粗略相交判断——宁可误报（提示了实际不重叠的），不可漏报。

这不是拒绝保存，只是提示。因为**运行时已经有硬保证**，静态检查的作用是帮用户理解为什么自己的规则不生效。

---

## 5. 模拟：本模块最重要的功能

页面文档 13 §5.7 把模拟称为"让用户敢于配置 Policy 的关键"。

### 5.1 原理

```
从 events 表取出历史上所有 policy.evaluated 事件（含 context_snapshot）
      ↓
用草稿规则对每个快照重新评估
      ↓
与当时的实际结果对比
      ↓
输出：会自动处理多少次 / 其中多少次与人类判断不一致
```

```typescript
async function simulate(draft: Policy, projectId: string, range: string): Promise<SimResult> {
  // 只取带完整快照的评估事件
  const samples = await db.query`
    SELECT e.id, e.context_snapshot, e.payload,
           d.status AS human_decision, d.resolved_at, d.resolution_note
    FROM events e
    LEFT JOIN decisions d ON d.id = (e.payload->>'decision_id')::uuid
    WHERE e.project_id = ${projectId}
      AND e.type = 'policy.evaluated'
      AND e.occurred_at > now() - ${range}::interval
      AND e.context_snapshot IS NOT NULL
  `;

  const applicable: Sample[] = [];
  const mismatches: Mismatch[] = [];

  for (const s of samples) {
    // 检查草稿规则引用的 fact 在快照里是否都有
    const missing = requiredFacts(draft.condition)
      .filter(f => !(f in s.context_snapshot));
    if (missing.length) continue;                 // 跳过，并在结果中统计

    if (!matchCondition(draft.condition, s.context_snapshot)) continue;
    applicable.push(s);

    // 关键对比：草稿会自动放行，但人类当时驳回了
    const draftAutoApproves = isAutoApprove(draft.action);
    const humanRejected = s.human_decision === 'rejected'
                       || s.human_decision === 'revision_requested';

    if (draftAutoApproves && humanRejected) {
      mismatches.push({
        eventId: s.id,
        context: s.context_snapshot,
        humanDecision: s.human_decision,
        humanNote: s.resolution_note,
        workItemTitle: s.payload.work_item_title,
      });
    }
  }

  return {
    totalSamples: samples.length,
    skippedForMissingFacts: samples.length - evaluated,
    wouldAutoHandle: applicable.length,
    mismatches,
    suggestions: deriveSuggestions(mismatches),   // §5.2
    confidence: computeConfidence(samples.length, range),
  };
}
```

### 5.2 从不一致案例推导条件补充建议

页面文档 13 §4.2 展示的效果：

```
⚠ 其中 2 次人类当时是「驳回」的：
   · 08-02 修改支付文案（人类认为需法务确认）
   · 07-28 删除废弃接口（人类认为影响外部调用）
→ 建议：增加条件「不涉及对外接口」「不涉及支付相关」
```

推导方法：找出不一致样本与一致样本之间**取值分布差异最大的 fact**：

```typescript
function deriveSuggestions(mismatches: Mismatch[], matched: Sample[]): Suggestion[] {
  const suggestions: Suggestion[] = [];

  for (const fact of ALL_FACTS) {
    const mismatchValues = mismatches.map(m => m.context[fact]);
    const okValues = matched.map(s => s.context[fact]);

    // 该 fact 在不一致样本中高度集中，且在一致样本中罕见
    const dominant = mode(mismatchValues);
    const concentration = count(mismatchValues, dominant) / mismatchValues.length;
    const baseRate = count(okValues, dominant) / Math.max(okValues.length, 1);

    if (concentration >= 0.8 && baseRate < 0.2) {
      suggestions.push({
        addCondition: { fact, op: 'ne', value: dominant },
        rationale: `${count(mismatchValues, dominant)} 个不一致案例的 ${factLabel(fact)} 都是「${dominant}」`,
        wouldEliminate: count(mismatchValues, dominant),
      });
    }
  }
  return suggestions.sort((a, b) => b.wouldEliminate - a.wouldEliminate);
}
```

这是**统计启发，不是因果推断**。因此建议要标注"基于 N 个案例的模式，请人工确认是否合理"，绝不自动应用。

### 5.3 模拟的诚实性

模拟必须明确告知局限，否则用户会过度信任：

| 情况 | 提示 |
| --- | --- |
| 样本 < 20 | 「样本量较小（N=12），结果仅供参考」 |
| 部分样本缺 fact | 「N 个历史样本缺少条件所需数据，未纳入模拟」 |
| 引用了新增 fact | 「条件「Agent 置信度」自 2026-08-06 起才有数据，此前样本无法模拟」 |
| 无不一致但样本少 | 不显示"零风险"，显示"在有限样本中未发现不一致" |

**放宽类规则变更强制要求模拟**：API 层校验 `PATCH /api/policies/{id}` 在 direction=loosen 时必须携带有效的 `simulation_id`（[02 领域模型](02-domain-model.zh.md) `policy_versions.simulation_id`）。

---

## 6. 自然语言解释

页面文档 13 §5.6 要求规则编辑时实时生成人话解释。

**必须用模板拼接，不能用 LLM。** 理由：解释与实际执行逻辑必须严格一致，LLM 生成会有偏差，而这个偏差会直接导致用户误配规则——治理功能上的偏差是不可接受的。

```typescript
function explain(policy: Policy): string {
  const cond = explainCondition(policy.condition);
  const act = explainAction(policy.action);
  return `当${cond}时，${act}。`;
}

function explainCondition(c: Condition): string {
  if ('all' in c) return c.all.map(explainCondition).join('且');
  if ('any' in c) return c.any.map(explainCondition).join('或');
  if ('not' in c) return `不满足（${explainCondition(c.not)}）`;

  const label = FACT_LABELS[c.fact];          // "风险等级"
  const value = formatValue(c.fact, c.value); // "低"
  const op = OP_PHRASES[c.op];                // { eq: '是', lt: '低于', ... }
  return `${label}${op}${value}`;
}
```

对应示例规则生成：

> 当风险等级是低、且自动测试结果是通过、且 Review Agent 结论是通过、且本次执行成本低于 $10 时，系统会自动批准并在飞书通知项目负责人。你不需要手动审批。

**模板覆盖度是实现成本的主要来源**：23 个 fact × 8 个操作符 × 10 种动作。需要一套结构化的短语表，而不是逐组合写模板。

---

## 7. 成本护栏

产品文档多处提到成本控制（8.6.3 WIP 的"每个项目最大运行成本"、8.9.1 的模型成本与累计预算）。成本检查在两个位置：

### 7.1 派发前（预防）

```typescript
// Scheduler 派发 Agent Run 前
const projected = project.costSpent + estimatedRunCost;
if (project.budgetAmount && projected > project.budgetAmount) {
  return createDecision('budget_overrun', {
    assignee: { kind: 'project_role', role: 'sponsor' },   // 8.7.5：预算超限 → Sponsor
    consequence: `将超出预算 $${(projected - project.budgetAmount).toFixed(2)}`,
  });
}
```

### 7.2 执行中（中断）

Agent Run 的成本实时累加，触及阈值时按 Policy 处理：

```
成本达到单 Run 上限 80%  → 事件 + 页面警示
成本达到单 Run 上限 100% → 按 agent.cost_limit 配置的动作：
                            pause_and_ask（默认）/ terminate / allow_overrun
项目累计成本达预算 100%  → 停止调度新任务（执行中的允许跑完，避免半成品）
```

**执行中的 Run 允许跑完**是刻意选择：中途杀掉一个跑了 20 分钟、改了一半代码的 Run，产生的烂摊子比多花几美元更贵。

---

## 8. 与 Agent 权限的关系

两者容易混淆：

| | Agent 权限（[09 安全](09-security.zh.md)） | Policy |
| --- | --- | --- |
| 回答 | Agent **能不能**做（能力边界） | 做这件事**要不要**人批准（治理判断） |
| 违反后果 | 工具调用直接被拒绝 | 生成决策，等人 |
| 配置位置 | Agent Workspace | Policy 配置页 |
| 时机 | 工具调用时 | 状态流转时 |

举例：
- Agent 没有 `merge_pr` 工具权限 → 它根本无法合并代码，这是**权限**
- Agent 有 `deploy` 权限，但部署到生产需要审批 → 这是 **Policy**

**两者都要有**。只有权限没有 Policy，Agent 要么完全不能做要么完全自由；只有 Policy 没有权限，Agent 可能通过意外路径绕过治理。

---

## 9. 测试策略

| 层次 | 内容 |
| --- | --- |
| 单元 | 条件 AST 求值：每个操作符、嵌套组合、类型不匹配 |
| 单元 | 优先级顺序与首次命中语义 |
| 单元 | 默认动作在三种自治等级下的行为 |
| 单元 | 自然语言解释：快照测试覆盖所有 fact × 操作符组合 |
| 集成 | 组织规则不可被项目规则绕过（构造尝试绕过的项目规则，断言仍被拦截） |
| 集成 | 缓存失效：规则变更后 N 毫秒内所有实例生效 |
| 集成 | 模拟：构造已知的历史事件，断言模拟结果 |
| 性能 | 100 条规则 × 10000 次评估的 P99 延迟 |

**安全底线测试**（最重要）：

```typescript
// 对 NEVER_AUTO_APPROVE 的三类操作，穷举各种自治等级与对抗性项目规则组合，
// 断言永远不会得到 allow —— 底线在求值器里，不依赖库里有没有规则
for (const op of NEVER_AUTO_APPROVE) {
  for (const autonomy of ALL_AUTONOMY_LEVELS) {
    for (const projectRules of ADVERSARIAL_RULE_SETS) {
      const verdict = evaluate(contextFor(op, autonomy), compile(projectRules));
      expect(verdict.action.type).not.toBe('allow');
    }
  }
}
```

配套还要断言**拼错的取值绕不过它**：`typeData.operationType` 写成 `"delete_resrouce"` 时评估必须停下来报错，而不是当成 `code_change` 放过去。这条与上面那条是一对——少了它，上面那条只证明了"拼对时拦得住"。

---

## 10. MVP 范围收敛

产品文档 12.2 对 Policy Engine 基础版只要求四类配置：

- 哪些任务自动执行
- 哪些任务需要审批
- 失败多少次后请求人工
- 哪些环境必须审批

**建议 MVP 实现**：

| 做 | 不做 |
| --- | --- |
| 完整的条件 AST 与求值器（内部） | 自由条件编辑器（UI） |
| **模板化配置界面**（选场景 → 填几个参数） | 高级表达式模式 |
| **模拟回放**（最高优先级） | 建议推导（§5.2 可后置） |
| 自然语言解释 | — |
| 组织/项目继承与优先级 | 复杂的静态冲突检测 |
| 成本护栏 | — |

**理由**：模拟比灵活性重要。给用户一个能自由组合 23 个 fact 但无法验证效果的编辑器，比给他 6 个经过验证的模板更危险。灵活性可以后加，信任丢了很难挽回。

模板示例：

```
场景：低风险任务自动放行
  风险等级不高于  [低 ▾]
  必须通过        [☑ 自动测试] [☑ Agent Review] [☐ 安全扫描]
  成本上限        [$10]
  通过后          [☑ 通知项目负责人]
                                              [模拟验证] [启用]
```

---

## 11. 待确认问题

1. **Fact 清单必须在实现事件快照前锁定。** 遗漏的 fact 在补上之前的历史数据里不存在，模拟能力有断层。建议实现前专门评审一次这份清单。
2. **`agentConfidence` 的可比性**：不同 Agent 运行时的置信度定义不同，直接用于规则条件可能不可靠。是否需要按 Agent 做校准映射？还是 MVP 先不把它放进 fact 清单？倾向于保留字段但在模板中不暴露。
3. **规则数量上限**：目前设想 30 条以内。超过后首次命中语义会让规则关系难以理解。是否需要引入规则分组或决策表形式？
4. **模拟的 fact 缺失处理**：目前是跳过样本。如果某规则引用的 fact 在 80% 样本中缺失，模拟基本无意义。是否应该在这种情况下直接拒绝展示模拟结果，而不是给一个基于 20% 样本的结论？倾向于拒绝。
5. **Policy 与 Agent 建议的关系**：产品文档 8.7.1 提到「Agent 建议自动化的重复决策」。这个建议由谁生成——Analytics 的统计检测（确定性）还是 LLM（灵活）？倾向于统计检测，理由同 §6：治理相关的功能不引入不确定性。
6. **进行中 Run 的规则快照**：需要确认快照粒度——是整套编译后的规则，还是只记录 policy 版本号？前者存储大但绝对可靠，后者需要保证规则版本不被物理删除。倾向于记版本号 + 规则表软删除。
