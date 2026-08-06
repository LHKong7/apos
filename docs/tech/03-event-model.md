# 03 事件模型

产品文档 6.9 把 Event 定义为「项目可追溯、可回放和可审计的基础」，3.2 要求系统能回答"谁做了什么、为什么这样做、用了哪些上下文"。本文档定义如何实现。

---

## 1. 定位：不是 Event Sourcing

**明确不做完整事件溯源。** 领域表保存当前状态，事件表保存变更事实，两者同事务写入。

| 方案 | 为什么不选 |
| --- | --- |
| 完整 Event Sourcing（状态由事件重放得出） | 看板、依赖图、Analytics 都需要复杂查询，投影层的开发与维护成本远超收益；状态机演进时历史事件的兼容处理是长期负担 |
| 只有状态表 + 审计日志 | 审计日志通常是事后补的、不完整的，无法支撑产品要求的因果追溯与 Policy 模拟 |
| **状态表 + 强制事件（本方案）** | 查询简单，事件完整。代价是需要纪律保证"不写事件就不能改状态" |

**纪律如何强制**：唯一允许修改领域对象状态的入口是 `flow.transition()`，它在同一事务内写状态与事件。代码审查 + 集成测试断言（任意状态变更后必须存在对应事件）保证这条规则。

---

## 2. 事件分层

系统中有两类事件，服务不同目的，**不能混为一谈**：

| | 领域事件 `events` | 运行事件 `run_events` |
| --- | --- | --- |
| 语义 | 业务事实：状态变了、决策做了、产物产生了 | 执行细节：调了什么工具、推理了什么 |
| 量级 | 单 Work Item 数十条 | 单 Run 数百至数千条 |
| 写入者 | Flow Engine（唯一） | Agent 适配器 |
| 消费者 | 审计、Analytics、通知、Flow、Policy 模拟 | Run 详情页时间线 |
| 保留 | 永久（归档） | 30 天热 + 归档 |
| 分区 | 按月 | 按月 |

**提升规则**：`run_events` 中少数关键事件会被提升为领域事件。

```
run_events.type              → events.type
─────────────────────────────────────────────────────
run_started                  → agent_run.started
artifact                     → artifact.produced
run_ended (completed)        → agent_run.completed  → 触发 flow.transition
run_ended (failed)           → agent_run.failed     → 触发 flow.transition
human_intervention           → run.intervened
policy_check (需人类)         → decision.created
其余（tool_call/reasoning…）  → 不提升
```

这个分层的价值：Analytics 聚合与审计查询只扫描量级小两个数量级的 `events` 表。

---

## 3. 事件结构

```typescript
// packages/contracts/src/events/domain-event.ts

interface DomainEvent {
  id: bigint;                    // 全局单调递增（SSE Last-Event-ID 用）
  orgId: string;
  projectId: string | null;

  type: DomainEventType;         // 见 §7 目录
  level: 'milestone' | 'detail';

  // 谁做的
  actorType: ActorType;          // human | agent | service | external | system
  actorId: string | null;

  // 对谁做的
  subjectType: SubjectType;      // work_item | requirement | plan | decision |
                                 // agent_run | project | policy | artifact | integration
  subjectId: string;

  payload: Record<string, unknown>;

  // 为什么这样做 —— 因果链
  causationId: bigint | null;    // 直接触发本事件的事件
  correlationId: string;         // 同一业务流程的所有事件共享

  // Policy 模拟回放所需的上下文快照（见 §4）
  contextSnapshot: PolicyContext | null;

  occurredAt: Date;
}
```

### 3.1 因果链（causation chain）

这是回答"为什么这样做"的机制。示例——一次因 Policy 命中而产生决策，最终人类批准后任务继续：

```
#1001  agent_run.completed        actor=agent:code-1     subject=run:1284
   │   causation=null  correlation=c-7f3a
   ▼
#1002  work_item.transition_attempted   actor=system     subject=work_item:88
   │   causation=1001  correlation=c-7f3a
   │   payload: { from: 'executing', to: 'reviewing' }
   ▼
#1003  policy.evaluated            actor=system          subject=work_item:88
   │   causation=1002  correlation=c-7f3a
   │   payload: { matched: 'policy-7', action: 'require_human_review', trace: [...] }
   │   contextSnapshot: { risk:'high', env:'production', cost:8.2, tests:'passed', ... }
   ▼
#1004  decision.created            actor=system          subject=decision:52
   │   causation=1003  correlation=c-7f3a
   ▼
#1005  work_item.status_changed    actor=system          subject=work_item:88
   │   causation=1003  correlation=c-7f3a
   │   payload: { from:'executing', to:'awaiting_decision' }
   ▼   ……（人类批准，2 小时后）
#1090  decision.approved           actor=human:wangqiang subject=decision:52
   │   causation=null（人类主动发起，无前序事件）  correlation=c-7f3a
   │   payload: { option:'A', constraints:[{type:'time_window',value:'02:00-05:00'}] }
   ▼
#1091  work_item.status_changed    actor=system          subject=work_item:88
       causation=1090  correlation=c-7f3a
       payload: { from:'awaiting_decision', to:'reviewing' }
```

**能回答的问题**：

- 「为什么这个任务停了 2 小时？」→ 沿 causation 链回溯到 #1003 的 Policy 判定
- 「谁批准的、批准时附加了什么？」→ #1090
- 「这一整件事的全过程？」→ 按 `correlation_id` 查

`correlation_id` 在业务流程起点生成（用户操作、调度器派发、webhook 到达），沿调用链透传。

### 3.2 payload 约定

- 状态变更类：必须含 `{ from, to }`
- 人工操作类：必须含 `{ reason }`（产品文档 8.4.4 要求人类覆盖必须记录原因）
- 外部同步类：必须含 `{ origin: 'sync:{integration_id}' }`（防同步循环）
- 成本相关：必须含 `{ cost_delta, cost_total }`

payload 不存大对象。产物、报告等放 `artifacts` 表，事件里只存引用。

---

## 4. 上下文快照：Policy 模拟的前提

页面文档 13 要求"用历史数据验证规则"——把一条草稿规则拿到过去 30 天的数据上跑，看会自动处理多少次、其中多少次与人类当时的判断不一致。

**这个功能能否实现，完全取决于事件里有没有存足够的上下文。** 事后无法补。

### 4.1 快照内容

在**所有会触发 Policy 评估的事件**上记录 `context_snapshot`，字段与 [05 Policy Engine](05-policy-engine.md) 定义的 fact 清单一一对应：

```typescript
interface PolicyContext {
  // 对象属性
  projectType: string;
  workItemType: WorkItemType;
  riskLevel: RiskLevel;
  reversible: boolean;
  externalFacing: boolean;

  // 环境与数据
  environment: 'dev' | 'test' | 'staging' | 'production' | null;
  dataSensitivity: 'public' | 'internal' | 'confidential' | 'restricted' | null;
  impactScope: { tasks: number; services: string[] };

  // Agent
  agentType: string | null;
  agentConfidence: number | null;
  agentSuccessRate: number | null;
  consecutiveFailures: number;

  // 成本
  runCost: number;
  projectCostSpent: number;
  projectBudget: number | null;

  // 质量
  testsResult: 'passed' | 'failed' | 'not_run';
  testCoverage: number | null;
  securityScan: 'passed' | 'failed' | 'not_run';
  agentReview: 'passed' | 'concerns' | 'failed' | 'not_run';

  // 操作
  operationType: string;   // db_ddl | deploy | delete_resource | send_external | ...
}
```

### 4.2 存储权衡

全量存储会让事件表膨胀。策略：

| 事件类型 | 快照 |
| --- | --- |
| 会触发 Policy 评估的（状态流转、Run 派发、发布） | 完整快照 |
| 决策创建/解决 | 完整快照（模拟对比的基准） |
| 其余 | 不存 |

估算：完整快照约 800 字节 JSON，触发 Policy 的事件约占总量 20%。见 §6 容量估算。

### 4.3 模拟的局限

必须向用户说明：模拟基于**当时记录的快照**，如果新规则引用了当时未记录的 fact，该规则无法被可靠模拟。

**实现约束**：Policy 条件编辑器只允许选择 `PolicyContext` 中已定义的 fact。新增 fact 时，模拟能力从新增之日起生效，页面需明确提示「此条件从 2026-08-06 起有数据」。

---

## 5. 写入路径

### 5.1 事务内写入 + 事务外发布

```typescript
async function transition(input: TransitionInput): Promise<TransitionResult> {
  const outbox: DomainEvent[] = [];

  const result = await db.transaction(async (tx) => {
    // 1. 行锁，防止并发流转
    const item = await tx.selectForUpdate(workItems, input.subjectId);

    // 2. 状态机校验 + guard
    const target = resolveTransition(item.status, input.trigger);
    if (!target) throw new InvalidTransition(item.status, input.trigger);

    // 3. Policy 评估（在事务内，结果决定走向）
    const ctx = await buildPolicyContext(tx, item, input);
    const verdict = policy.evaluate(ctx);

    // 4. 按判定执行
    const finalStatus = verdict.requiresHuman ? 'awaiting_decision' : target;
    if (verdict.requiresHuman) {
      const decision = await createDecision(tx, item, verdict, ctx);
      outbox.push(event('decision.created', decision, { causation: ... }));
    }

    // 5. 写状态
    await tx.update(workItems).set({ status: finalStatus, version: item.version + 1 })
      .where(and(eq(workItems.id, item.id), eq(workItems.version, item.version)));

    // 6. 写事件（同事务）
    outbox.push(
      event('policy.evaluated', item, { payload: verdict, contextSnapshot: ctx }),
      event('work_item.status_changed', item, {
        payload: { from: item.status, to: finalStatus },
      }),
    );
    await tx.insert(events).values(outbox);

    return { finalStatus, verdict };
  });

  // 7. ★ 事务提交后才发布 —— 订阅者不会看到未提交的状态
  for (const e of outbox) await bus.publish(e);

  return result;
}
```

**为什么必须提交后发布**：如果在事务内发布，SSE 可能把「已进入 Review」推给浏览器，而事务随后回滚，前端状态就永久错了。

**发布失败怎么办**：用 transactional outbox——事件已在库里，一个后台 worker 扫描未发布的事件补发。事件表加 `published_at` 字段（或单独的 outbox 表）。MVP 可以先用「提交后同步发布 + 失败重试」，量大了再上 outbox worker。

### 5.2 事件不可变

`events` 表只允许 INSERT。数据库层面用权限限制：应用连接的角色没有 UPDATE/DELETE 权限。

```sql
REVOKE UPDATE, DELETE ON events FROM apos_app;
```

需要"更正"历史事件时，写一条新的补偿事件，不改旧的。

---

## 6. 容量与分区

### 6.1 估算（MVP 规模）

假设：50 个活跃项目，每项目每天 20 个 Work Item 状态流转，5 次 Agent Run，每 Run 平均 200 条 run_events。

| 表 | 日增 | 月增 | 单行 | 月体积 |
| --- | --- | --- | --- | --- |
| `events` | 50 × 60 = 3,000 | 90,000 | ~1.2 KB（含快照） | ~110 MB |
| `run_events` | 50 × 5 × 200 = 50,000 | 1,500,000 | ~0.6 KB | ~900 MB |

结论：**PostgreSQL 完全够用，不需要 Kafka**。到达 10 倍规模（约 500 项目）时再评估。

### 6.2 分区策略

```sql
-- 按月 RANGE 分区
CREATE TABLE events (...) PARTITION BY RANGE (occurred_at);

CREATE TABLE events_2026_08 PARTITION OF events
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- 用 pg_partman 或定时任务自动创建下月分区
```

**热冷分离**：

| 数据 | 位置 | 访问方式 |
| --- | --- | --- |
| `events` 近 12 个月 | PostgreSQL | 直接查询 |
| `events` 12 个月以上 | S3（Parquet） | 按需加载，页面提示"正在从归档加载" |
| `run_events` 近 30 天 | PostgreSQL | 直接查询 |
| `run_events` 30 天以上 | S3（每 Run 一个 JSONL 文件） | Run 详情页按需拉取 |

`run_events` 归档按 Run 打包成单文件，因为查询模式总是"看某一次 Run 的全部事件"，不需要跨 Run 检索。

**归档后的操作限制**：归档 Run 不能重试（页面文档 09 §11 已说明）。

---

## 7. 事件类型目录

命名规范：`{subject}.{past_tense_verb}`。事件是已发生的事实，动词用过去式。

### 7.1 Project

| 类型 | level | payload 要点 |
| --- | --- | --- |
| `project.created` | milestone | type, autonomy_level, budget |
| `project.autonomy_changed` | milestone | from, to, reason |
| `project.paused` / `project.resumed` | milestone | reason |
| `project.budget_threshold_reached` | milestone | threshold_pct, spent, budget |
| `project.completed` | milestone | — |

### 7.2 Requirement

| 类型 | level | payload 要点 |
| --- | --- | --- |
| `requirement.created` | milestone | input_method, source_ref |
| `requirement.analyzed` | milestone | completeness, question_count, cost |
| `requirement.clarification_answered` | detail | question_id, level, used_suggestion |
| `requirement.field_edited` | detail | field, by_human |
| `requirement.approved` | milestone | approver, completeness_at_approval |
| `requirement.rejected` | milestone | reason |
| `requirement.assumption_invalidated` | milestone | assumption_id, reason |

### 7.3 Plan

| 类型 | level | payload 要点 |
| --- | --- | --- |
| `plan.generated` | milestone | version, task_count, cost_estimate, duration_ms |
| `plan.item_modified` | detail | item_id, field, from, to（人工调整计划） |
| `plan.approved` | milestone | approvers[], acknowledged_overrun |
| `plan.revision_requested` | milestone | feedback |
| `plan.superseded` | milestone | by_version |

### 7.4 Work Item

| 类型 | level | payload 要点 |
| --- | --- | --- |
| `work_item.created` | milestone | type, parent_id, executor |
| `work_item.status_changed` | milestone | from, to, reason?, origin? |
| `work_item.assigned` | milestone | executor_type, executor_id, match_reasons |
| `work_item.blocked` | milestone | reason, blocking_ref |
| `work_item.unblocked` | milestone | blocked_duration_s |
| `work_item.taken_over` | milestone | **reason（必填）**, agent_handling |
| `work_item.handed_back` | milestone | handover_note |
| `work_item.acceptance_updated` | detail | criterion_id, passed, verification |
| `work_item.force_passed` | milestone | **reason（必填）**, criteria[] |
| `work_item.dependency_added` / `removed` | detail | from, to, type |
| `work_item.split` | milestone | into[] |
| `work_item.merged` | milestone | into |

### 7.5 Agent Run

| 类型 | level | payload 要点 |
| --- | --- | --- |
| `agent_run.dispatched` | milestone | agent_id, idempotency_key, context_size |
| `agent_run.started` | milestone | model, tools[] |
| `agent_run.completed` | milestone | cost, tokens, duration_s, artifacts[] |
| `agent_run.failed` | milestone | error_class, error_message, attempt |
| `agent_run.timeout` | milestone | timeout_s |
| `agent_run.terminated` | milestone | by_actor, reason |
| `agent_run.heartbeat_lost` | milestone | last_heartbeat_at |
| `agent_run.constraint_added` | milestone | constraint, by_actor |
| `agent_run.cost_threshold_reached` | milestone | pct, cost, limit |

### 7.6 Decision

| 类型 | level | payload 要点 |
| --- | --- | --- |
| `decision.created` | milestone | type, risk, assignee, due_at, policy_id |
| `decision.approved` | milestone | option_id, constraints[], resolution_time_s |
| `decision.rejected` | milestone | reason |
| `decision.revision_requested` | milestone | feedback |
| `decision.delegated` | milestone | from, to, note |
| `decision.escalated` | milestone | level, to, wait_duration_s |
| `decision.reminded` | detail | to |
| `decision.expired` | milestone | wait_duration_s |
| `decision.outcome_recorded` | milestone | outcome, note |

### 7.7 Policy

| 类型 | level | payload 要点 |
| --- | --- | --- |
| `policy.evaluated` | detail | matched_policy, action, trace[] + **contextSnapshot** |
| `policy.created` / `updated` | milestone | direction, simulation_id, diff |
| `policy.disabled` | milestone | **reason（必填）** |

### 7.8 Artifact / Integration

| 类型 | level | payload 要点 |
| --- | --- | --- |
| `artifact.produced` | milestone | kind, ref, metadata |
| `integration.connected` / `disconnected` | milestone | provider, scopes |
| `integration.synced` | detail | direction, entity_count, **origin** |
| `integration.conflict_detected` | milestone | field, local, remote |
| `integration.conflict_resolved` | milestone | winner, apply_to_similar |
| `integration.error` | milestone | provider, error |

---

## 8. 消费者

```
events 写入
   │
   ├──▶ SSE 扇出          实时更新浏览器（按 §4.3 频道映射）
   ├──▶ Flow Engine       某些事件触发下游状态检查（如依赖完成 → 检查后置任务）
   ├──▶ Notification      按产品文档十一的通知类型路由
   ├──▶ Analytics         增量更新预聚合表
   ├──▶ Audit             高敏感事件额外写入不可变审计存储
   └──▶ Knowledge (P1)    从事件中提取可复用经验
```

**订阅者必须幂等**：同一事件可能被重复投递（重试、outbox 补发）。做法是记录 `(consumer, event_id)` 已处理表，或让处理逻辑天然幂等。

**订阅者失败不影响主流程**：事件已经落库，消费失败只影响衍生功能（通知没发出、聚合延迟），不影响业务状态正确性。这是把事件写入放在事务内、消费放在事务外的直接收益。

---

## 9. 查询模式

| 场景 | 查询 |
| --- | --- |
| Work Item 时间线 | `WHERE subject_type='work_item' AND subject_id=? ORDER BY occurred_at` |
| 项目最近活动（默认里程碑级） | `WHERE project_id=? AND level='milestone' ORDER BY id DESC LIMIT 20` |
| 追溯某次变更的原因 | 递归 CTE 沿 `causation_id` 向上 |
| 一次完整业务流程 | `WHERE correlation_id=? ORDER BY id` |
| Policy 模拟数据源 | `WHERE type='policy.evaluated' AND occurred_at > ? AND context_snapshot IS NOT NULL` |
| 审计：某人的所有操作 | `WHERE actor_type='human' AND actor_id=? ORDER BY occurred_at DESC` |
| 审计：某 Agent 的所有操作 | `WHERE actor_type='agent' AND actor_id=?` |

递归追溯示例：

```sql
WITH RECURSIVE chain AS (
  SELECT * FROM events WHERE id = $target
  UNION ALL
  SELECT e.* FROM events e JOIN chain c ON e.id = c.causation_id
)
SELECT * FROM chain ORDER BY id;
```

---

## 10. 待确认问题

1. **`context_snapshot` 的字段范围**需要与 [05](05-policy-engine.md) 的 fact 清单锁定后再实现。一旦上线，新增 fact 只对之后的数据有效，因此**首版要尽量把可能用到的 fact 都记上**，宁可多存。
2. **Outbox 是 MVP 就做还是后置？** 「提交后同步发布」在进程崩溃的窄窗口内会丢事件（业务状态正确，但 SSE/通知丢失）。建议 MVP 接受这个风险，用「客户端定期全量刷新」兜底，P1 再上 outbox。
3. **审计存储是否需要独立于业务库？** 合规严格的场景可能要求审计日志写入 WORM 存储。MVP 用 PostgreSQL 权限限制 + 定期归档到 S3（开启对象锁）应该够，需与合规确认。
4. **事件 schema 版本演进**：payload 结构变化时如何兼容旧事件？建议事件加 `schema_version` 字段，读取侧做版本适配。MVP 可先不加，但要预留字段位置。
5. **`run_events` 的 seq 生成**：跨进程如何保证单调？目前设想由 Agent 适配器在单个 Run 内递增（一个 Run 只被一个适配器实例处理）。需要确认孤儿接管后 seq 不冲突。
