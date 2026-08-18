# 04 Flow Engine

产品文档 8.6 的原话是「Flow Engine 负责推进项目状态，而不只是保存状态」。这一句区分了本产品与传统看板——传统看板等用户拖卡片，Flow Engine 主动找活干。

---

## 1. 组成

```
┌──────────────────────────────────────────────────────────────┐
│  Flow Engine                                                 │
│                                                              │
│  ① Transition       状态流转（同步，事务内）                  │
│     · 状态机校验  · Guard 求值  · Policy 评估  · 写状态+事件  │
│                                                              │
│  ② Scheduler        主动调度（worker，每 5s + 事件触发）      │
│     · 找 ready 任务  · 依赖检查  · WIP 检查  · 派发           │
│                                                              │
│  ③ BlockerDetector  阻塞识别（worker，每 60s）                │
│     · 九类阻塞规则扫描                                        │
│                                                              │
│  ④ Recovery         恢复策略（事件触发）                      │
│     · 重试 / 换 Agent / 降级 / 拆分 / 转人工 / 终止           │
│                                                              │
│  ⑤ Forecast         延期预测（worker，每 30min）              │
│     · 关键路径 + 历史 Cycle Time + 等待时间                   │
└──────────────────────────────────────────────────────────────┘
```

①是同步的、在请求路径上；②③⑤是后台循环；④由事件驱动。

---

## 2. 状态机

### 2.1 声明式定义

状态机是数据，不是代码里的 switch。这样才能被前端复用（拖拽卡片时校验目标列是否合法）、被测试穷举、被文档自动生成。

```typescript
// packages/domain/src/flow/work-item-machine.ts

export const WORK_ITEM_MACHINE: Machine<WorkItemStatus, WorkItemTrigger> = {
  initial: 'draft',
  stages: {
    intake:    ['draft', 'clarifying', 'awaiting_requirement_approval'],
    planning:  ['planning', 'awaiting_plan_approval'],
    execution: ['ready', 'executing', 'blocked', 'failed'],
    review:    ['reviewing', 'changes_requested', 'awaiting_decision'],
    release:   ['waiting_for_release', 'releasing', 'released'],
    done:      ['acceptance', 'done', 'cancelled'],
  },
  transitions: [
    { from: 'draft',      trigger: 'plan_approved',       to: 'ready' },

    { from: 'ready',      trigger: 'run_dispatched',      to: 'executing',
      guards: ['dependenciesSatisfied', 'wipAvailable', 'executorAssigned'] },

    { from: 'executing',  trigger: 'agent_run_completed', to: 'reviewing',
      guards: ['hasArtifactOrOutput'] },
    { from: 'executing',  trigger: 'agent_run_failed',    to: 'failed' },
    { from: 'executing',  trigger: 'dependency_lost',     to: 'blocked' },
    { from: 'executing',  trigger: 'human_took_over',     to: 'executing',
      effects: ['switchExecutorToHuman'] },

    { from: 'failed',     trigger: 'retry_requested',     to: 'ready' },
    { from: 'failed',     trigger: 'reassigned',          to: 'ready' },
    { from: 'failed',     trigger: 'escalated_to_human',  to: 'executing',
      effects: ['switchExecutorToHuman'] },

    { from: 'blocked',    trigger: 'blocker_cleared',     to: 'ready' },

    { from: 'reviewing',  trigger: 'review_passed',       to: 'waiting_for_release',
      guards: ['acceptanceCriteriaMet', 'qualityGatePassed'] },
    { from: 'reviewing',  trigger: 'review_rejected',     to: 'changes_requested' },
    { from: 'reviewing',  trigger: 'review_conflict',     to: 'awaiting_decision' },
    { from: 'changes_requested', trigger: 'rework_started', to: 'ready' },

    { from: 'waiting_for_release', trigger: 'release_started', to: 'releasing' },
    { from: 'releasing',  trigger: 'release_completed',   to: 'acceptance' },
    { from: 'releasing',  trigger: 'release_failed',      to: 'failed',
      effects: ['createIncident'] },

    { from: 'acceptance', trigger: 'accepted',            to: 'done' },
    { from: 'acceptance', trigger: 'rejected',            to: 'changes_requested' },

    // 决策等待：可从多个状态进入，批准后回到原状态
    { from: '*',          trigger: 'decision_required',   to: 'awaiting_decision',
      effects: ['rememberPreviousStatus'] },
    { from: 'awaiting_decision', trigger: 'decision_approved', to: '$previous' },
    { from: 'awaiting_decision', trigger: 'decision_rejected', to: 'cancelled' },

    { from: '*',          trigger: 'cancelled',           to: 'cancelled' },
  ],
};
```

**`$previous` 机制**：任务可能在执行中、审核中、发布前的任意时刻需要人类决策，批准后要回到原来的位置。用 `type_data.previous_status` 记录。这比为每个状态定义一个专门的 `awaiting_decision_from_X` 状态清爽得多。

### 2.2 Guard

Guard 是纯函数，输入是上下文，输出是通过与否 + 失败原因。失败原因要能直接展示给用户（页面文档 05 §5.6 要求拖拽到非法列时说明原因）。

```typescript
export const GUARDS: Record<string, Guard> = {
  dependenciesSatisfied: (ctx) => {
    const unmet = ctx.dependencies.filter(d => !isDependencyMet(d, ctx));
    return unmet.length === 0
      ? { ok: true }
      : { ok: false, reason: `${unmet.length} 个前置依赖未满足`,
          detail: unmet.map(d => ({ id: d.fromId, title: d.title, type: d.type })) };
  },

  wipAvailable: (ctx) => {
    const limit = ctx.project.wipLimits[ctx.targetStage];
    if (!limit) return { ok: true };
    return ctx.stageCount < limit
      ? { ok: true }
      : { ok: false, reason: `${ctx.targetStage} 阶段已达 WIP 上限 ${limit}` };
  },

  acceptanceCriteriaMet: (ctx) => {
    const unmet = ctx.acceptanceCriteria.filter(c => c.status !== 'passed');
    return unmet.length === 0
      ? { ok: true }
      : { ok: false, reason: `${unmet.length} 项验收标准未通过`,
          detail: unmet, overridable: true, overrideRole: 'tech_lead' };
  },
  // ...
};
```

**`overridable`** 标记哪些 guard 可以被人类强制放行（页面文档 06 §5.4 的「强制放行」）。强制放行必须填原因并记审计。

### 2.3 依赖满足判定（8.6.2 七种依赖类型）

```typescript
function isDependencyMet(dep: Dependency, ctx: Context): boolean {
  switch (dep.type) {
    case 'finish_to_start':
      return ['done', 'released', 'acceptance'].includes(dep.from.status);
    case 'start_to_start':
      return dep.from.actualStart != null;
    case 'artifact':
      return ctx.artifacts.some(a => a.workItemId === dep.fromId && a.kind === dep.artifactKind);
    case 'decision':
      return dep.decision?.status === 'approved';
    case 'permission':
      return ctx.executorPermissions.includes(dep.requiredPermission);
    case 'external':
      return ctx.externalStates[dep.externalRef]?.ready === true;
    case 'data':
      return ctx.dataReadiness[dep.dataRef] === true;
  }
}
```

`permission` 类型值得注意：它让"Agent 权限不足"成为一种**依赖**而非**失败**。这样任务会停在 `blocked` 而不是反复失败，且阻塞原因清晰指向权限问题——对应产品文档 8.6.4「权限不足」。

---

## 3. Transition：唯一的状态变更入口

```typescript
interface TransitionInput {
  subjectType: 'work_item' | 'requirement' | 'plan' | 'decision' | 'agent_run';
  subjectId: string;
  trigger: string;
  actor: Actor;
  reason?: string;               // 人类操作时必填
  overrideGuards?: string[];     // 强制放行的 guard 名，需权限
  correlationId?: string;
  causationId?: bigint;
}

interface TransitionResult {
  ok: boolean;
  from: string;
  to: string;
  policyVerdict?: PolicyVerdict;
  createdDecisionId?: string;
  blockedBy?: GuardFailure[];    // 失败时返回，供 UI 展示原因
  events: DomainEvent[];
}
```

### 3.1 执行顺序

```
1. 加行锁（SELECT ... FOR UPDATE）
2. 查状态机：(from, trigger) → to？
      ✗ → 返回 InvalidTransition + 当前可用的 triggers（供 UI 提示）
3. 求值 guards
      ✗ 且不可 override → 返回 GuardFailed + 原因明细
      ✗ 但可 override 且 actor 有权限 → 记录 override 事件，继续
4. 构建 PolicyContext → policy.evaluate()
      · allow                → 继续到目标状态
      · allow_and_notify     → 继续 + 排队通知
      · require_agent_review → 转 reviewing，派发 Review Agent
      · require_human_review → 转 awaiting_decision + 创建 Decision
      · require_multi_approval → 同上，创建会签
      · pause                → 转 blocked，原因为 policy
      · deny                 → 拒绝，返回原因
      · escalate             → 创建高优先级 Decision 给上级
5. 执行 effects（切换执行主体、创建 Incident 等）
6. UPDATE 状态（带乐观锁版本号）
7. INSERT events（policy.evaluated + status_changed + 其他）
8. 提交
9. 提交后发布事件 → SSE / 通知 / Analytics / 触发下游调度检查
```

### 3.2 并发控制

两层保护：

| 层 | 手段 | 防什么 |
| --- | --- | --- |
| 悲观 | `SELECT ... FOR UPDATE` | 同一 Work Item 的并发流转（Agent 回调 + 人类操作同时到达） |
| 乐观 | `WHERE version = $expected` | 跨请求的丢失更新（用户 A 读取后编辑，期间 B 已改） |

**乐观锁冲突的处理**：不重试，直接返回 409 并携带最新状态。页面文档 05 §11 定义了 UI 表现——「张伟刚刚将其移到了 Execution」。

**避免死锁**：一次事务只锁一个 Work Item。需要同时改多个（如批量操作）时，按 ID 排序后依次单独处理，不在一个事务里锁多行。

---

## 4. Scheduler：主动调度

这是「Agent 推进」的引擎。产品文档 8.3.4 定义了调度依据。

### 4.1 主循环

```typescript
// worker: flow-scheduler，每 5s 一轮 + 收到相关事件时立即触发一轮
async function scheduleRound() {
  const candidates = await findSchedulableItems();   // §4.2

  for (const item of candidates) {
    // WIP 检查（8.6.3）
    if (!await checkWipLimits(item)) {
      await markQueued(item, 'wip_limit');
      continue;
    }

    // 执行主体解析
    const assignment = item.executorId
      ? { type: item.executorType, id: item.executorId }
      : await resolveExecutor(item);                 // §4.3

    if (!assignment) {
      await markBlocked(item, 'no_matching_executor');
      continue;
    }

    if (assignment.type === 'human') {
      await transition({ subjectId: item.id, trigger: 'assigned_to_human', ... });
      await notify(assignment.id, 'task_assigned', item);
      continue;
    }

    // Agent：预算与并发检查后派发
    const budgetOk = await checkBudget(item, assignment);
    if (!budgetOk.ok) {
      await createDecision('budget_overrun', item, budgetOk);
      continue;
    }

    await agent.dispatchRun({
      workItemId: item.id,
      agentId: assignment.id,
      idempotencyKey: `${item.id}:${item.attemptCount + 1}`,
    });
  }
}
```

### 4.2 候选查询

```sql
SELECT wi.* FROM work_items wi
WHERE wi.project_id IN (SELECT id FROM projects WHERE status = 'active')
  AND wi.status = 'ready'
  AND wi.deleted_at IS NULL
  -- 所有前置依赖已满足
  AND NOT EXISTS (
    SELECT 1 FROM work_item_dependencies d
    JOIN work_items dep ON dep.id = d.from_id
    WHERE d.to_id = wi.id
      AND NOT (
        (d.type = 'finish_to_start' AND dep.status IN ('done','released','acceptance'))
        OR (d.type = 'start_to_start' AND dep.actual_start IS NOT NULL)
        -- 其余类型由应用层二次判定（涉及 artifacts/decisions 等跨表条件）
      )
  )
ORDER BY wi.priority ASC, wi.planned_start ASC NULLS LAST
LIMIT 100
FOR UPDATE SKIP LOCKED;      -- ★ 多 worker 实例并行调度不冲突
```

`FOR UPDATE SKIP LOCKED` 让多个 scheduler 实例可以同时跑而不重复派发同一任务。

### 4.3 执行主体匹配（8.3.4）

```typescript
function scoreAgent(agent: Agent, item: WorkItem, ctx: Context): Score | null {
  // 硬性条件：不满足直接淘汰
  if (!agent.applicableTypes.includes(item.type)) return null;
  if (agent.status !== 'active') return null;
  if (ctx.agentLoad[agent.id] >= agent.maxConcurrency) return null;
  if (!hasRequiredPermissions(agent, item)) return null;      // 权限范围
  if (agent.costLimitPerRun && item.estimatedCost > agent.costLimitPerRun) return null;

  // 加权评分
  const skillMatch   = jaccard(agent.skills, item.requiredSkills);       // 0–1
  const successRate  = agent.stats.successRate ?? 0.7;                   // 样本不足给中性值
  const loadFactor   = 1 - ctx.agentLoad[agent.id] / agent.maxConcurrency;
  const contextMatch = ctx.agentContextAffinity[agent.id] ?? 0.5;        // 是否做过同模块
  const costFactor   = 1 - normalize(agent.stats.avgCost, ctx.costRange);

  const score =
      0.30 * skillMatch
    + 0.25 * successRate
    + 0.15 * contextMatch
    + 0.15 * loadFactor
    + 0.15 * costFactor;

  return {
    agentId: agent.id,
    score,
    // ★ 理由必须可解释——页面文档 04 §5.4 要求改派下拉展示匹配依据
    reasons: [
      `Skill 匹配 ${(skillMatch * 100).toFixed(0)}%（${intersect(agent.skills, item.requiredSkills).join(', ')}）`,
      `历史成功率 ${(successRate * 100).toFixed(0)}%（${agent.stats.sampleSize} 次）`,
      `当前负载 ${ctx.agentLoad[agent.id]}/${agent.maxConcurrency}`,
    ],
  };
}
```

**需要人类经验的任务**：产品文档 8.3.4 提到"是否需要人类经验"是分配依据之一。实现上由 Plan 生成时在 `type_data.requires_human` 标记，或由 Policy 规则强制（如"涉及生产 DDL 的任务必须分配给人类"）。

**权重不是硬编码**：存在项目配置里，允许调整。默认值来自上表，需要真实数据验证后校准。

### 4.4 WIP 控制（8.6.3）

五类限制：

```typescript
async function checkWipLimits(item: WorkItem): Promise<WipCheck> {
  const checks = [
    // 阶段 WIP
    { key: 'stage', limit: project.wipLimits[targetStage],
      current: await countByStage(project.id, targetStage) },
    // Agent 并发
    { key: 'agent', limit: agent.maxConcurrency,
      current: await countRunningRuns(agent.id) },
    // 人类待处理决策数
    { key: 'human_decisions', limit: project.wipLimits.humanPendingDecisions,
      current: await countPendingDecisions(assigneeId) },
    // 项目运行成本
    { key: 'project_cost', limit: project.budgetAmount,
      current: project.costSpent },
    // 任务类型并发
    { key: 'type', limit: project.wipLimits[`type:${item.type}`],
      current: await countRunningByType(project.id, item.type) },
  ];
  const violated = checks.filter(c => c.limit != null && c.current >= c.limit);
  return { ok: violated.length === 0, violated };
}
```

**WIP 满时不挤占**：产品文档页面文档 05 §11 定义了行为——生成决策「WIP 已满，是否提升上限或暂停低优先级任务」，而不是自动踢掉低优先级任务。自动挤占会让用户失去对系统行为的预期。

---

## 5. BlockerDetector（8.6.4）

九类阻塞，每 60 秒扫描一次：

| # | 阻塞类型 | 判据 | 检测方式 |
| --- | --- | --- | --- |
| 1 | 任务超时 | `now > planned_end + grace` 且未完成 | SQL |
| 2 | 依赖未满足 | 停在 `ready` 超过阈值且依赖未满足 | SQL + 应用层 |
| 3 | Agent 连续失败 | 同一 Work Item 连续 N 次 Run 失败 | SQL |
| 4 | 等待决策过久 | `decision.created_at < now - threshold` | SQL |
| 5 | 外部服务不可用 | 集成健康检查失败且有任务依赖它 | 健康检查表 |
| 6 | 成本超限 | `project.cost_spent >= budget` 或 Run 超单次上限 | SQL |
| 7 | 权限不足 | Agent 缺少任务所需权限（依赖判定已覆盖） | 派发前检查 |
| 8 | 多 Agent 结果冲突 | Review 结论不一致且无人裁决 | 应用层 |
| 9 | 长期无事件 | Work Item 最后事件时间 > 阈值且状态为进行中 | SQL |

```sql
-- 类型 9：长期无事件（最容易发现"Agent 悄悄卡住"的情况）
SELECT wi.id, wi.title, wi.status, MAX(e.occurred_at) AS last_event
FROM work_items wi
LEFT JOIN events e ON e.subject_type='work_item' AND e.subject_id=wi.id
WHERE wi.status IN ('executing','reviewing','releasing')
  AND wi.deleted_at IS NULL
GROUP BY wi.id
HAVING MAX(e.occurred_at) < now() - interval '30 minutes'
    OR MAX(e.occurred_at) IS NULL;
```

检测到阻塞后：写 `blocked_since` / `blocked_reason` / `blocked_detail`，发 `work_item.blocked` 事件，交给 Recovery 决定下一步。

**阈值可配置**，且不同阻塞类型阈值不同（等待决策 4h vs 长期无事件 30min）。

### 5.x 写之前先判「变了没有」

调度器每轮都会对同一个工作项重新推出同一个结论（这个 Agent 还是没被加进项目）。**无条件写的代价有两处**：

1. 事件表里堆出几十条一模一样的 `work_item.blocked`，把真正的状态变更淹掉 —— Timeline 从「发生了什么」退化成一段日志；
2. `blocked_since` 每轮被刷新，于是卡片上的「已阻塞 8h12m」恒等于「0m」—— 而那一栏本来是用来判断「卡了多久」的。

所以 `markBlocked()` 只在**首次阻塞或原因变化**时写库与发事件，判等走 `sameBlockedDetail()`（与原因码定义在同一个文件里，改码时跟着改）。判等按 `agentId` 排序后比对：候选顺序取决于查询计划，不是语义的一部分。

### 5.y 拒绝理由是**码**不是句子

`matchExecutors()` 的每条拒绝带 `code`（为什么被淘汰）、`scope`（这条限制配在哪一层）与 `params`（插值参数），定义在 `packages/contracts/src/work-item/blocked.ts`。中文句子保留在 `reason` 里，只服务日志与存量数据。

`scope` 存在的唯一理由是消灭一类自相矛盾的展示：Agent 档案页写着「允许 write_file」而看板说「缺少 write_file」—— 两句都对，一个是组织级上限，一个是项目级授权。不标层级，用户看到的是系统在自打嘴巴，然后跑去改错地方。

`FIX_FOR_CODE` 是原因码到修复入口的**唯一**映射表。界面各处各猜一套的下场是同一条原因在两个页面上跳到两个地方。

---

## 6. Recovery（8.6.5）

阻塞或失败发生后，按 Policy 决定恢复动作。**这是产品"自主恢复"能力的落点。**

```typescript
const RECOVERY_ACTIONS = {
  retry:            (ctx) => transition(ctx.item, 'retry_requested'),
  switch_agent:     (ctx) => reassign(ctx.item, pickAlternativeAgent(ctx)),
  downgrade_model:  (ctx) => retryWith(ctx.item, { model: cheaperModel(ctx.agent.model) }),
  add_reviewer:     (ctx) => attachReviewAgent(ctx.item),
  split_task:       (ctx) => requestPlanAgentToSplit(ctx.item),
  rollback_step:    (ctx) => transition(ctx.item, 'rework_started'),
  request_decision: (ctx) => createDecision('agent_failure', ctx.item, ctx),
  transfer_to_human:(ctx) => transition(ctx.item, 'escalated_to_human'),
  terminate:        (ctx) => transition(ctx.item, 'cancelled'),
};
```

### 6.1 默认恢复策略

Policy 未特别配置时的兜底（可被项目 Policy 覆盖）：

```
Agent Run 失败
├─ error_class = context_insufficient
│    第 1 次 → retry（自动补充相关知识与上次失败信息到上下文）
│    第 2 次 → request_decision（让人补充上下文）
├─ error_class = capability_mismatch
│    立即 → switch_agent；无候选 → transfer_to_human
├─ error_class = tool_failure / external_unavailable
│    指数退避 retry ×3 → 仍失败 → request_decision
├─ error_class = timeout
│    第 1 次 → split_task（让 Project Agent 拆细）
│    第 2 次 → transfer_to_human
├─ error_class = permission_denied
│    不重试 → request_decision（决策内容：是否扩大 Agent 权限）
├─ error_class = budget_exceeded
│    不重试 → request_decision（决策责任人 = Sponsor）
└─ 连续失败 ≥ 3（任意原因）
     → pause + escalate 到技术负责人（产品文档 8.9.3 明确示例）
```

**关键设计**：不同错误类型的恢复策略必须不同。无差别重试三次是最糟的实现——`permission_denied` 重试 100 次也不会成功，只是烧钱。这依赖 Agent Protocol 提供可靠的错误分类（[06](06-agent-protocol.md) §6）。

### 6.2 恢复的成本护栏

每次恢复动作都要检查累计成本：

```typescript
if (item.actualCost + estimatedRetryCost > item.estimatedCost * 3) {
  // 已花到预估的 3 倍，不再自动重试
  return createDecision('cost_overrun_on_retry', item);
}
```

---

## 7. Forecast：延期预测（8.6.6）

页面文档 02 §5.2 要求预测结果可解释——用户必须能看到七项输入各自的贡献度，否则不会信任预测。

### 7.1 方法

MVP 不用机器学习，用可解释的加法模型：

```typescript
function forecast(project: Project): Forecast {
  const cp = criticalPath(project);              // 关键路径任务序列
  const remaining = cp.filter(t => !isDone(t));

  let expectedDays = 0;
  const factors: Factor[] = [];

  for (const task of remaining) {
    // 基准：计划工期
    let taskDays = task.estimatedHours / WORK_HOURS_PER_DAY;

    // 因子 1：历史 Cycle Time 修正（该类型任务的实际/计划比值）
    const cycleRatio = history.cycleTimeRatio(project, task.type) ?? 1.0;
    taskDays *= cycleRatio;

    // 因子 2：Agent 成功率修正（失败要重跑）
    if (task.executorType === 'agent') {
      const sr = agentStats(task.executorId).successRate ?? 0.85;
      taskDays *= (1 / sr);                      // 成功率 80% → 期望 1.25 次
    }

    // 因子 3：决策等待（该任务是否含人类节点）
    if (task.hasHumanGate) {
      const avgWait = history.avgDecisionWaitHours(project, task.decisionType);
      taskDays += avgWait / 24;
    }

    expectedDays += taskDays;
  }

  // 因子 4：当前阻塞的即时影响
  const blockedImpact = currentBlockers(cp)
    .reduce((sum, b) => sum + hoursSince(b.blockedSince) / 24, 0);
  expectedDays += blockedImpact;

  const drift = expectedDays - daysUntil(project.endsAt);

  return {
    probability: sigmoid(drift / SCALE),         // 延期概率
    driftDays: drift,
    // ★ 归因：按贡献度排序，页面直接展示
    factors: rankFactors([
      { name: '决策等待时间', contribution: decisionWaitDays, ... },
      { name: 'Agent 重试损耗', contribution: retryDays, ... },
      { name: '当前阻塞', contribution: blockedImpact, ... },
      { name: '历史工期偏差', contribution: cycleDriftDays, ... },
    ]),
    primaryCause: topFactor.name,                // "主因：决策等待 8h12m"
  };
}
```

### 7.2 样本不足时不预测

页面文档 02 §11 明确要求：项目 < 3 天或完成任务 < 5 时显示「样本不足，暂不预测」，而不是给一个低置信度数字。

**理由**：一个错误的预测比没有预测更有害——用户会据此做决策，然后失去对系统的信任。

### 7.3 关键路径计算

标准 CPM（关键路径法）在依赖图上跑：

```
1. 拓扑排序
2. 正向遍历算最早开始/结束（ES/EF）
3. 反向遍历算最晚开始/结束（LS/LF）
4. 浮动时间 = LS - ES，浮动为 0 的任务构成关键路径
```

复杂度 O(V+E)，200 节点的项目毫秒级完成。结果缓存到 `plans.critical_path`，依赖或工期变化时失效重算。

**多条等长关键路径**：全部标注（页面文档 07 §11 已定义 UI 表现）。

---

## 8. 与 Policy Engine 的边界

两者容易混淆，明确分工：

| | Flow Engine | Policy Engine |
| --- | --- | --- |
| 回答 | **能不能**从 A 到 B（结构合法性） | **该不该**自动做（治理判断） |
| 依据 | 状态机、依赖、WIP | 风险、成本、环境、质量 |
| 结果 | 允许 / 拒绝 + 原因 | allow / require_review / deny / … |
| 可配置性 | 状态机由产品定义，企业可配阶段 | 企业与项目自由配置规则 |

**调用关系**：Flow 调 Policy，不反向。Policy 是纯函数（输入 context，输出 verdict），不感知状态机的存在——这让它可以被独立测试和模拟回放。

---

## 9. 测试策略

状态机与调度逻辑是系统的心脏，测试要求高于其他模块。

| 层次 | 内容 | 工具 |
| --- | --- | --- |
| 单元 | 状态机穷举：所有 (from, trigger) 组合的期望结果 | Vitest，表驱动 |
| 单元 | Guard 纯函数 | Vitest |
| 单元 | 依赖满足判定的七种类型 | Vitest |
| 单元 | CPM 关键路径（含多路径、环检测） | Vitest |
| 集成 | Transition 的事务性：状态与事件同时写入或同时不写 | Testcontainers + 真实 PG |
| 集成 | 并发流转：两个请求同时改同一 Work Item | 并发测试 |
| 集成 | Scheduler 的 SKIP LOCKED：多实例不重复派发 | 多进程测试 |
| 场景 | 完整链路：需求 → 计划 → 派发 → 失败 → 恢复 → 完成 | 集成测试 + Mock Agent |

**不变式断言**（在集成测试中全局校验）：

```typescript
// 任何状态变更后必须存在对应事件
assert(eventsFor(workItem).some(e => e.type === 'work_item.status_changed'
  && e.payload.to === workItem.status));

// 处于 blocked 的任务必须有 blocked_reason
assert(workItem.status !== 'blocked' || workItem.blockedReason != null);

// awaiting_decision 的任务必须有未解决的 decision
assert(workItem.status !== 'awaiting_decision'
  || pendingDecisions(workItem).length > 0);
```

---

## 10. 待确认问题

1. **调度权重的初始值需要真实数据校准。** 目前 0.30/0.25/0.15/0.15/0.15 是拍的。建议 MVP 上线后收集 2–4 周数据，用"实际成功且低成本的分配"作为标签做一次回归校准。
2. **`$previous` 机制在多层嵌套时的行为**：任务从 executing 进入 awaiting_decision，决策期间又产生第二个决策，回退时应该回到哪？建议用栈而非单值，但会增加复杂度。MVP 可限制为"同一时刻只允许一个未决决策"。
3. **Scheduler 的公平性**：当前按 priority + planned_start 排序，可能导致低优先级任务长期饿死。是否需要引入等待时间加权？倾向于需要，但 MVP 可先观察。
4. **人类任务的调度**：目前只是"分配 + 通知"，没有真正的调度语义（人不会因为系统派发就开始做）。人类任务的 `executing` 状态如何触发？靠人手动标记还是靠外部信号（如 commit）？倾向于两者都支持。
5. **延期预测的因子权重与 sigmoid 参数**需要标定。MVP 可先只输出 `driftDays` 与归因，不输出概率——概率给错了比不给更糟。
6. **恢复策略中的 `split_task`** 需要调用 Project Agent 重新规划，这是一次 LLM 调用，成本与延迟都不低。是否应该限制自动拆分的触发频率？
