# 开发指南

## 环境准备

需要 Node 22+ 与 pnpm 10+。

```bash
pnpm install
docker compose up -d          # Postgres + Redis
cp .env.example .env

pnpm db:generate              # 改了 schema 后生成迁移
pnpm db:migrate               # 应用迁移
```

集成测试需要一个可用的 Postgres。默认连 `TEST_DATABASE_URL`，未设置时用
`postgres://apos@localhost:5433/apos`。

```bash
pnpm test                     # 全部测试（含集成测试）
pnpm test:watch
pnpm typecheck
pnpm lint
```

`pnpm lint` 只开会变成 bug 的规则，不管格式。重点是类型系统看不见的那些：
React Hook 依赖漏项（在 SSE 驱动的界面上表现为「后端推了但这一块没变」）、
未使用的导入、`any` 必须带理由。规则集见 `eslint.config.js`，那里写了每条为什么在。

## 仓库结构

```
packages/
  contracts/   前后端共享的领域类型与 Zod schema（唯一真相来源）
  domain/      纯逻辑：状态机、Guard、Policy 求值、恢复策略。零 IO 依赖
  db/          Drizzle schema、迁移、数据库客户端
apps/
  api/         Fastify 应用与应用层模块
docs/          产品、页面与技术文档
```

## 三条不可违反的约束

这三条来自产品定位，不是风格偏好。违反任何一条都会让产品失去核心价值。

### 1. 状态变更必须产生事件

**不允许任何代码路径直接 `UPDATE work_items SET status = ...`。**

状态变更统一走 `transition()`，它在同一事务内写状态与事件。这是产品文档 3.2
「所有行为可追溯」的实现基础，也是 Policy 模拟、Analytics、审计日志的数据来源。

```ts
// ❌ 绕开事件写入，制造审计黑洞
await db.update(workItems).set({ status: 'reviewing' }).where(...)

// ✅
await transition(db, { workItemId, trigger: 'agent_run_completed', actor, correlationId })
```

### 2. Agent 是独立身份，不是人类的代理

所有涉及操作者的字段是 `(actorType, actorId)` 而非 `userId`。Agent 有自己的
凭证与权限集，**绝不能复用人类用户的 token**——否则审计日志会显示是人做的，
权限范围会等于那个人的全部权限，且无法单独收紧 Agent 权限。

### 3. Policy 评估必须携带上下文快照

`policy.evaluated` 事件的 `contextSnapshot` 是 Policy 模拟回放的唯一数据来源。
**这个字段事后无法补**——漏记了就意味着那段时间的历史数据永远无法用于验证新规则。

新增 Policy fact 时，同步更新 `buildPolicyContext()`，并知晓该 fact 只对之后的
数据有效。

## 测试要求

| 变更内容 | 必须补的测试 |
| --- | --- |
| 状态机流转规则 | `machine.test.ts` 的穷举与可达性断言 |
| Guard | 通过与失败两种路径，失败时的 reason 可读性 |
| Policy 条件/动作 | 求值测试；涉及高风险操作时补安全底线测试 |
| 恢复策略 | 每个错误分类都要有明确决策 |
| 任何写状态的路径 | 集成测试断言「状态变了 → 有对应事件」 |

`evaluate.test.ts` 中的**安全底线测试是 CI 阻断性的**：它用对抗性规则集穷举
各种自治等级，断言 `NEVER_AUTO_APPROVE` 的三类操作永远不会被自动放行。
这个测试失败意味着治理体系被绕过，不能合并。

## 命名约定

- 事件类型：`{subject}.{过去式动词}`，如 `work_item.status_changed`
- 数据库：snake_case（Drizzle `casing: 'snake_case'` 自动转换）
- API：camelCase，与前端 TS 一致
- 金额：字符串形式的十进制，避免浮点精度问题
