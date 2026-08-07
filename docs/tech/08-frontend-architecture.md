# 08 前端架构

React 18 + TypeScript + Vite。对应 14 个[页面文档](../product/pages/README.md)。

---

## 1. 前端的特殊挑战

这不是一个普通的 CRUD 后台。三个特点决定了架构取舍：

| 特点 | 挑战 |
| --- | --- |
| **状态由系统事件驱动** | 界面必须实时更新且不打断用户操作。传统"提交后刷新"模式不适用 |
| **信息密度极高** | 看板卡片、决策卡片要在小面积内表达状态、执行主体、成本、时限、Gate 状态 |
| **人机混合的表达** | 每个显示执行主体的地方都要区分人与 Agent，这是产品的核心视觉差异 |

第一条最难。用户可能正在编辑某个字段，同时 Agent 更新了同一个对象。处理不好会丢用户输入，这是最不可接受的 bug 类型。

---

## 2. 技术选型

| 用途 | 选型 | 理由 |
| --- | --- | --- |
| 构建 | Vite | — |
| 路由 | React Router v6 | 嵌套路由匹配项目内 Tab 结构 |
| 服务端状态 | TanStack Query v5 | 缓存、失效、乐观更新；与 SSE 集成见 §4 |
| 客户端状态 | Zustand | 筛选条件、面板开合、键盘模式等 UI 状态 |
| 样式 | Tailwind CSS | 高信息密度界面需要精细间距控制 |
| 无样式组件 | Radix UI | 弹窗、下拉、Tooltip 的可访问性 |
| 表单 | React Hook Form + Zod | 与后端共享 schema |
| 虚拟滚动 | TanStack Virtual | 看板列、Run 事件流（可能数千条） |
| 图 | React Flow + dagre | Execution Graph |
| 图表 | Recharts | Analytics |
| 类型 | `@apos/contracts` | ★ 与后端共享，不生成 |

---

## 3. 目录结构

```
apps/web/src/
├── pages/                       与 14 个页面文档一一对应
│   ├── ProjectList/
│   ├── ProjectOverview/
│   ├── RequirementIntake/
│   ├── PlanApproval/
│   ├── Board/
│   ├── WorkItemDetail/
│   ├── ExecutionGraph/
│   ├── AgentWorkspace/
│   ├── RunDetail/
│   ├── DecisionCenter/
│   ├── DecisionDetail/
│   ├── Analytics/
│   ├── PolicyConfig/
│   └── IntegrationSettings/
├── features/                    跨页面复用的领域功能
│   ├── work-item/               卡片、状态徽标、状态机客户端校验
│   ├── decision/                决策卡片、操作栏、约束编辑器
│   ├── agent/                   Agent Chip、状态点、队列
│   ├── run/                     执行流时间线、成本明细
│   ├── policy/                  条件编辑器、自然语言解释、模拟结果
│   └── event/                   Event Timeline（三处共用）
├── components/                  通用组件（页面文档 README §5）
│   ├── HumanGateBadge.tsx
│   ├── AssigneeChip.tsx         ★ 人机视觉区分的唯一实现
│   ├── RiskBadge.tsx
│   ├── AutonomyBadge.tsx
│   ├── UpdateSourceTag.tsx
│   ├── CostMeter.tsx
│   ├── BlockedDuration.tsx
│   └── states/                  Loading / Empty / Error / NoPermission
├── lib/
│   ├── api/                     类型化 client
│   ├── sse/                     ★ SSE 连接管理与缓存同步（§4）
│   ├── query/                   TanStack Query 配置与 key 工厂
│   ├── permissions/             前端权限判定（与后端同源规则）
│   └── format/                  成本、时长、相对时间
└── stores/                      Zustand
```

**`components/` 与 `features/` 的边界**：`components/` 是页面文档全局约定中定义的原子组件，无业务逻辑；`features/` 含数据获取与业务规则。

---

## 4. 实时数据：SSE 与 Query 缓存的融合

这是前端最核心的设计。

### 4.1 单连接多频道

```typescript
// lib/sse/connection.ts
class SSEConnection {
  private es: EventSource | null = null;
  private channels = new Set<string>();
  private lastEventId: string | null = null;
  private handlers = new Map<string, Set<Handler>>();

  subscribe(channel: string, handler: Handler): Unsubscribe {
    this.channels.add(channel);
    this.addHandler(channel, handler);
    this.reconnectIfChannelsChanged();      // 防抖 100ms，避免快速切页时反复重连
    return () => this.unsubscribe(channel, handler);
  }

  private connect() {
    const url = `/api/v1/stream?channels=${[...this.channels].join(',')}`;
    this.es = new EventSource(url);

    this.es.onmessage = (e) => {
      this.lastEventId = e.lastEventId;
      const event = JSON.parse(e.data);
      applyEventToCache(event);              // §4.2
      this.dispatch(event);
    };

    this.es.onerror = () => this.scheduleReconnect();   // 指数退避
  }
}
```

**只维持一条连接**：浏览器对同域 SSE 连接数有限制（HTTP/1.1 下 6 条）。多个组件订阅不同频道，共用一条连接。

### 4.2 事件 → 缓存补丁

```typescript
// lib/sse/apply-event.ts
export function applyEventToCache(event: DomainEvent) {
  const qc = queryClient;

  switch (event.type) {
    case 'work_item.status_changed': {
      const { workItemId, from, to } = event.payload;

      // 1. 更新详情缓存
      qc.setQueryData(qk.workItem(workItemId), (old) =>
        old ? { ...old, status: to, stage: stageOf(to) } : old);

      // 2. 更新看板：从原列移除、加到新列
      qc.setQueryData(qk.board(event.projectId), (old) =>
        old ? moveItemBetweenStages(old, workItemId, from, to) : old);

      // 3. 让派生数据失效（不直接改，让它重新拉）
      qc.invalidateQueries({ queryKey: qk.projectOverview(event.projectId) });
      break;
    }

    case 'agent_run.progress': {
      // 高频事件：只做局部更新，绝不 invalidate（会触发大量请求）
      qc.setQueryData(qk.run(event.payload.runId), (old) =>
        old ? { ...old, ...pick(event.payload, ['step', 'cost', 'progressNote']) } : old);
      break;
    }

    case 'decision.created':
    case 'decision.resolved':
      qc.invalidateQueries({ queryKey: qk.decisions() });
      qc.invalidateQueries({ queryKey: qk.actionItems() });   // 全局角标
      break;
  }
}
```

**原则**：

| 事件频率 | 处理 |
| --- | --- |
| 高频（progress、cost、run 事件） | `setQueryData` 局部补丁，不发请求 |
| 低频且影响面大（状态变更） | 补丁主缓存 + invalidate 派生缓存 |
| 结构性变化（任务创建/删除） | 直接 invalidate |

### 4.3 保护用户正在编辑的内容

页面文档 README §5.10 的硬性要求：**用户正在编辑的表单区域不被远端更新覆盖**。

```typescript
// stores/editing.ts —— 全局记录正在编辑的字段
export const useEditingStore = create<EditingState>((set, get) => ({
  editing: new Map<string, Set<string>>(),   // entityId → Set<field>
  startEdit: (entityId, field) => { /* ... */ },
  endEdit: (entityId, field) => { /* ... */ },
  isEditing: (entityId, field) => get().editing.get(entityId)?.has(field) ?? false,
}));

// 应用补丁时跳过正在编辑的字段
function patchEntity<T>(entityId: string, old: T, incoming: Partial<T>): T {
  const store = useEditingStore.getState();
  const safe = Object.fromEntries(
    Object.entries(incoming).filter(([field]) => !store.isEditing(entityId, field))
  );
  const conflicted = Object.keys(incoming).filter(f => store.isEditing(entityId, f));

  if (conflicted.length) {
    // 不静默丢弃：告诉用户有更新
    notifyConflict(entityId, conflicted, incoming);
    // → 顶部提示「该内容已被 Agent 更新，[查看差异] [使用最新]」
  }
  return { ...old, ...safe };
}
```

**冲突提示而非静默丢弃**：用户需要知道自己编辑的内容已经过时了，否则保存时会遇到 409 却不知道为什么。

### 4.4 动画与滚动

页面文档 05 §5.5 的约束在此实现：

```typescript
// 卡片移动动画
const MOVE_STAGGER_MS = 80;      // 多张卡片错峰

function useCardMoveQueue() {
  const queue = useRef<MoveEvent[]>([]);
  // 用户正在拖拽或打开了详情 → 延迟该卡片的动画到交互结束
  // 用户不在视口顶部 → 不自动滚动，显示"↑ 2 张卡片已移动"提示条
}
```

**不自动滚动**是反复出现的要求（看板、Run 事件流、决策列表）。统一实现：

```typescript
function useFollowTail(containerRef) {
  const [pinned, setPinned] = useState(true);   // 是否贴底
  // 用户滚动离开底部 → pinned = false，显示"↓ N 条新内容"
  // 用户滚回底部 → pinned = true，恢复自动跟随
}
```

---

## 5. 权限的前端表达

页面文档统一采用**只读降级**而非整页 403。

```typescript
// lib/permissions/use-can.ts
export function useCan(action: Action, resource?: Resource): PermissionResult {
  const { user, projectRole } = useAuth();
  const result = evaluatePermission(user, projectRole, action, resource);
  return result;   // { allowed: boolean, missingRole?: string }
}

// 用法
function ApproveButton({ plan }) {
  const can = useCan('plan.approve', plan);
  return (
    <Tooltip content={can.allowed ? undefined : `需要 ${roleLabel(can.missingRole)} 角色`}>
      <Button disabled={!can.allowed}>批准并开始执行</Button>
    </Tooltip>
  );
}
```

**前端判定不是安全边界**，后端必须独立校验。前端判定的目的是体验——让用户立刻知道自己不能做什么，而不是点了才报错。

**规则同源**：判定逻辑放在 `packages/domain/src/permissions`，前后端共用同一份实现。避免两边规则不一致导致"按钮可点但请求被拒"。

---

## 6. 性能

### 6.1 关键路径预算

| 页面 | 目标 | 手段 |
| --- | --- | --- |
| 看板首屏（200 项） | < 1.5s | 每列首屏 20 张 + 虚拟滚动；Done 列折叠 |
| Run 详情（3000 事件） | < 1s | 虚拟滚动 + 简明模式默认（只加载 milestone 事件） |
| Execution Graph（200 节点） | < 2s | 服务端预计算布局；节点 > 100 时 Canvas 渲染 |
| 决策中心 | < 800ms | 列表项自带完整信息，无二次请求 |

### 6.2 虚拟滚动的应用点

```typescript
// 看板列
const virtualizer = useVirtualizer({
  count: items.length,
  getScrollElement: () => columnRef.current,
  estimateSize: () => 140,        // 卡片高度相对一致（页面文档 05 §5.3 的设计约束）
  overscan: 5,
});
```

**卡片高度一致性**是页面设计约束，同时也是虚拟滚动的性能前提——高度差异大会导致滚动位置跳动。

### 6.3 Execution Graph 的渲染切换

```typescript
const renderer = nodeCount > 100 ? 'canvas' : 'svg';
```

SVG 便于交互（悬停、点击）但 100+ 节点后卡顿。Canvas 需要自己实现命中检测，但性能好得多。切换阈值需实测校准。

> 现状：只实现了 SVG 一条路。超过 100 节点时页面顶部提示改用「关键路径」高亮聚焦主链，等真出现这么大的图再按实测换渲染器（§11 刻意没做）。

### 6.4 代码分割

```typescript
const ExecutionGraph = lazy(() => import('./pages/ExecutionGraph'));
const Analytics = lazy(() => import('./pages/Analytics'));
const PolicyConfig = lazy(() => import('./pages/PolicyConfig'));
```

React Flow 与 Recharts 体积较大，只在对应页面加载。核心路径（项目列表 → 看板 → Work Item）不做分割，保证跳转即时。

---

## 7. 关键组件的实现要点

### 7.1 AssigneeChip（人机区分）

产品最核心的视觉差异，必须只有一处实现：

```tsx
export function AssigneeChip({ actor, size = 'md' }: Props) {
  if (actor.type === 'human') {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Avatar src={actor.avatarUrl} shape="circle" size={size} />
        <span>{actor.name}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-dashed px-1.5">
      <AgentIcon shape="square" size={size} />
      <span className="font-mono text-sm">{actor.name}</span>
      <StatusDot state={actor.state} />   {/* 空闲/执行中(呼吸)/阻塞/失败 */}
    </span>
  );
}
```

区分手段是**形状 + 边框 + 字体**三重，不只靠颜色（色觉障碍可访问性）。

### 7.2 Event Timeline（三处共用）

Work Item 详情、Run 详情、决策详情共用。差异通过 props 控制：

```tsx
<EventTimeline
  source={{ kind: 'work_item', id }}
  defaultLevel="milestone"          // Run 详情用 'detail'
  groupConsecutive                  // 合并连续同类工具调用
  followTail={isRunning}
  renderDetail={renderRunEventDetail}
/>
```

**合并连续同类事件**（`read_file × 6` 折叠为一行）是页面文档 09 §5.3 的简明模式要求。

### 7.3 Policy 条件编辑器

MVP 只做模板化配置（[05 Policy Engine](05-policy-engine.md) §10），但自然语言解释组件要做：

```tsx
function PolicyExplanation({ condition, action }: Props) {
  // ★ 调后端接口生成，不在前端重复实现模板逻辑
  const { data } = useQuery(qk.policyExplain(condition, action), ...);
  return <div className="rounded bg-muted p-3 text-sm">{data?.text}</div>;
}
```

**解释在后端生成**：前端重复实现一遍模板逻辑，两边会漂移。解释与实际执行逻辑必须绝对一致。

---

## 8. 状态与错误的统一处理

```tsx
// components/states/QueryBoundary.tsx
export function QueryBoundary({ query, empty, children }: Props) {
  if (query.isLoading) return <Skeleton layout={empty.skeletonLayout} />;
  if (query.isError)   return <ErrorState error={query.error} onRetry={query.refetch} />;
  if (isEmpty(query.data)) return <EmptyState {...empty} />;   // 必带主行动按钮
  return children(query.data);
}
```

页面文档 README §5.9 要求空状态必须带主行动按钮，不做纯插画。`EmptyState` 的 props 强制要求 `action`：

```typescript
interface EmptyStateProps {
  icon: ReactNode;
  message: string;
  action: { label: string; onClick: () => void };   // 必填，不是可选
}
```

用类型系统强制设计规范，比写在文档里靠自觉更可靠。

---

## 9. 测试

| 层次 | 内容 | 工具 |
| --- | --- | --- |
| 单元 | 格式化、权限判定、状态机客户端校验 | Vitest |
| 组件 | 通用组件的各状态快照 | Testing Library |
| 集成 | SSE 事件 → 缓存更新的正确性 | Vitest + MSW |
| 集成 | 编辑保护：远端更新不覆盖用户输入 | Testing Library |
| E2E | 三条核心路径 | Playwright |

**三条 E2E 路径**：

1. 需求录入 → 澄清 → 确认 → 计划批准 → 看板出现任务
2. 决策中心处理一条决策 → 看板卡片状态变化
3. Agent 失败 → Work Item 详情 → 补充上下文重试 → 成功

**SSE 集成测试是重点**：这是最容易出 bug 且最难手工验证的部分。用 MSW 模拟事件流，断言缓存状态与渲染结果。

---

## 10. 待确认问题

1. **卡片自动移动的动画在大量卡片时可能干扰**。页面文档 05 §12 提出「安静模式」开关，需确认是否 MVP 就做。倾向于做，成本低。
2. **Execution Graph 的 Canvas 实现工作量不小**（命中检测、文本渲染、缩放）。MVP 是否先只支持 SVG + 100 节点上限，超出提示"任务过多，请使用筛选"？倾向于是。
3. **移动端支持范围**：决策处理是移动端最有价值的场景（随时随地批准）。是否 MVP 就做移动端优化的决策中心？倾向于做响应式的决策中心与详情页，其余页面桌面优先。
4. **离线与弱网**：SSE 断开时页面显示缓存数据 + 断线提示。是否需要更强的离线能力（如离线查看已加载数据）？倾向于不需要，这是协作型产品。
5. **`@apos/contracts` 的体积**：Zod schema 会被打进前端包。如果 schema 很大需要考虑 tree-shaking 或只导出类型（`import type`）+ 运行时校验只在后端。倾向于前端只在表单校验处使用 Zod，其余用 `import type`。

---

## 11. 已实现范围（apps/web）

MVP 只做了看板闭环需要的部分。这里如实记录做了什么、没做什么，避免把设计当成现状。

### 已实现

| 模块 | 文件 | 说明 |
| --- | --- | --- |
| 项目列表 | `pages/ProjectList` | 进入项目的入口，落点是总览而不是看板 |
| 项目总览 | `pages/Overview` | 五个指标卡（健康度 / 进度 / 延期风险 / 待决策 / 成本），健康度与延期可展开成逐项明细；需要你处理、阻塞、Agent、成员、活动流 |
| 需求录入与澄清 | `pages/Requirement` | 原文左右对照、四类澄清分级、完整度评分、确认 → 生成计划 |
| 计划确认 | `pages/Plan` | 五项概览、★「批准后将自动发生」、任务拆解、要求修改（生成新版本）|
| 智能看板 | `pages/Board` | Kanban / List / Agent / 待决策 四视图 |
| 任务详情抽屉 | `features/work-item/WorkItemDrawer` | 概览 / 执行记录 / 时间线；含补充上下文重试 |
| 决策抽屉 | `features/decision/DecisionDrawer` | 批准（可附加约束）/ 驳回；「不可代行」在界面上体现 |
| 手动移动 | `features/work-item/ManualMoveDialog` | 强制填原因 + 分类，落到事件 |
| Run 详情 | `pages/RunDetail` + `features/run/` | 执行流 / 输入 / 产物 / 成本 / 错误五个页签，简明⇄详细切换，运行时控制 |
| 执行图 | `pages/Graph` + `features/graph/` | 分层 / 阶段泳道 / 执行者泳道三种布局，关键路径、上下游追溯、结构诊断 |
| Analytics | `pages/Analytics` + `features/analytics/` | 系统发现 + Flow / Agent / HITL / 成本四个 Tab，环比默认开启 |
| Policy 配置 | `pages/Policies` | 摘要 + 规则集体检 + 模板化新建 + 历史回放模拟 + 场景测试 |
| 决策中心 | `pages/Decisions` | 队列按「超时 → 剩余时间 → 风险」排序，卡片内就地批准/驳回，低风险可逆的可批量批准，重复决策就地给出配规则入口 |
| Agent Workspace | `pages/Agents` | 花名册（负载/成功率/首次成功/人工覆盖/成本/负责人）+ 详情（效能、在办队列、权限边界、运行时能力、执行记录、暂停）|
| 集成设置 | `pages/Settings/Integrations` | 四类集成一页：代码 / 项目管理 / Agent 运行时 / 协同通知。字段级 Source of Truth + 三种预设、同步冲突就地处理、权限允许项与禁止项并列、通知按「需要行动」配置 |
| Source of Truth 配置 | `pages/Settings/SotPanel` | 逐字段选谁说了算，每格标出为什么默认是这个；改动先摆差异与后果再确认 |
| 同步冲突 | `pages/Settings/ConflictPanel` | 两侧的值 / 时间 / 谁改的，SoT 提示，「以后同类自动处理」 |
| 运行时能力报告 | `pages/Agents/CapabilityPanel` | 先说做不到什么（降级行为 + 用户影响 + 严重程度），再说支持什么。Agent 详情与集成设置共用 |
| SSE | `lib/sse/` | 单连接多频道、退避重连、事件 → 缓存补丁 |
| 编辑保护 | `stores/editing` | 远端更新不覆盖正在编辑的字段，冲突留痕 |
| 通用组件 | `components/` | AssigneeChip、Human Gate 徽标、风险、成本、阻塞时长、空/错状态 |

### 刻意没做

| 项 | 原因 |
| --- | --- |
| 真实 provider 的 HTTP 传输层（GitHub / Jira / Slack 的 OAuth 与 API 调用）| 需要真实凭证与能连出去的网络，两样都拿不到。写一个从未跑通、第一次真实调用才发现签名错的客户端，比不写更糟 —— 它看起来是完成的。所以定义了 `IntegrationAdapter` 接口，用进程内适配器把它下游的一切（SoT 判定、冲突生成与去重、循环抑制、权限校验、断开影响）端到端验证到位，页面上如实标注「这个 provider 还没有传输层」 |
| 大批量导入（Jira 几百条 Issue）| 页面文档 §11 要求异步任务 + 进度显示 + 导入前预览。当前 `linkObject` 是逐条建立映射，够用；批量导入等真接上 provider 再做，现在做的是一个没有数据源的进度条 |
| 通知里的「直接批准」按钮 | 页面文档 §12.3 倾向 MVP 只做深链，照做了。在第三方平台内确认「点按钮的人真的是决策责任人」各平台机制都不同 —— 做不到这一点的直接批准，会把不可代行的决策变成谁点谁算，那比不做更糟 |
| 真的把通知发出去 | 通知配置（发什么、免打扰、升级规则）存下来了，但没有投递端 —— 投递端就是上面那条传输层。配置先存着，接上就能用 |
| 组织级集成管理（`/admin/integrations`）| 与组织级 Policy 管理同因：需要组织级身份与权限模型。项目页如实说明数据连接器必须组织管理员配置 |
| 企业数据系统连接器 | 产品文档十三明确「全量 ERP / CRM 集成」暂不实现。页面只做占位说明与权限提示，不放能点的按钮 |
| 需求的对话式录入 / 文档上传 / 外部导入 | 三样都不是小工程（多轮状态同步、文档解析、集成配置），而它们解决的是「录入更顺手」，不是「录入之后 AI 理解得对不对」。后者才是这条链路的价值所在，力气先花在澄清与完整度上 |
| 需求字段的内联编辑 | `PATCH /requirements/:id` 已经通了并会标记「已由人类修改」，但界面上还只读。等真出现「AI 总把某个字段写歪」再做 |
| 计划的版本对比视图 | 重新规划会生成新版本、旧版标 superseded、两版都留着，数据齐了。差一个 diff 视图 |
| 计划里改派 / 调工期 / 拆分任务 | 与执行图的依赖编辑同理：计划是要被批准的东西，在上面随手改等于绕过批准。改动应走「要求修改」让 Agent 重新规划 |
| Policy 的自由条件编辑器 | 页面文档 13 §12.1 的建议，照做了。真正需要设定 Agent 边界的是项目负责人，给他一个条件表达式编辑器，他要么不敢配、要么配错 —— 两种结果都比「只有六个模板」糟糕。省下的力气全投给了模拟 |
| Policy 的高级模式（表达式编辑）| 同上。等真有人被模板卡住再做，而不是先建一套没人用的规则语言 IDE |
| 组织级 Policy 管理页（`/admin/policies`）| 需要组织级身份与权限模型，当前只有 `X-User-Id`。项目页如实显示「组织级规则不可修改，如需例外请联系管理员」 |
| 组织规则例外申请流程 | 页面文档 §12.3 倾向 MVP 不做，用「联系管理员」占位 |
| 命中明细页 | 「近 30 天命中 N 次」可点，但落地页（按 Policy 预筛的决策/Run 列表）还没做 |
| Analytics 的「质量」Tab | 核心指标（自动测试通过率、覆盖率趋势、发布后 Incident）全都要 CI / 事故系统接进来，而这两样都没有。一个六成写着「未接入」的 Tab 不是页面，是占位符。能算的两项（返工率、首次通过率）已经在 Flow Tab 里 |
| Analytics 的「成本效益」视角 | 需要人力成本基准（页面文档 12 §12.3 列为待确认）。硬编一个时薪算出来的「本月为你省了 $12,400」看起来最像成果，也最经不起追问 —— 被问一次「这个数怎么来的」就再也没人信这一页了 |
| Analytics 导出（PDF / CSV）| 页面文档把它放在「周会准备」流程里，但当前分享一个带筛选参数的链接（`?tab=&range=&compare=`）比导出一张死图有用。真要塞进周报再说 |
| Analytics 的预聚合表 | 页面文档 §9 要求按小时/天预聚合。项目级窗口内事件量在几千条量级，实时算完的代价远低于维护一套聚合管道加上它的延迟与回补。数据量真涨上来再做，而不是现在假装做了 |
| 跨项目 Analytics | 页面文档 §11 明确 MVP 不支持，属于组织级分析 |
| 执行图的 Canvas 渲染（§6.3）| 演示数据 8 个节点，SVG 毫无压力。100 节点以上再换，现在换等于自己实现命中检测却测不出收益。超过 100 时页面顶部提示改用「关键路径」高亮聚焦 |
| 执行图上直接改依赖 | 页面文档 07 §12.1 倾向只读：依赖是计划的一部分，在图上随手一拖就改掉，等于绕过计划批准。诊断给的动作是「让 Agent 重新规划」，改动仍走批准流程 |
| 时间轴（甘特）布局 | 页面文档 07 §12.4 未定：任务没有真实排期字段，画出来的时间轴是编的 |
| 执行图导出 | 图是活的，导出的是死的截图。真要分享，链接（`?layout=&highlight=&focus=`）比图片有用 |
| 虚拟滚动 | 每列首屏 20 张，实测无需虚拟化。列内超过 50 张再引入 TanStack Virtual |
| Radix UI / React Hook Form | 当前只有两个弹窗、三个表单字段，引入组件库的收益不抵体积 |
| 权限判定同源（`packages/domain/src/permissions`） | 后端目前只有 `X-User-Id`，还没有角色模型，前端无从判起 |

### Run 详情的三个取舍

**简明 / 详细不是「返回哪些事件」，是「每条事件的深度」。**
一度用 `run_events.level` 来分（简明只回 `milestone`），结果简明模式只剩
「启动 / 产出 / 结束」三行 —— 中间做了什么全没了，而这一页存在的理由
恰恰是回答「它做了什么」。现在简明模式返回全部事件但不带 `payload`：
省掉的正是体积的大头（推理全文、工具原始参数、上下文明细），
也正是页面文档要求隐藏的东西。`level` 那个字段是给 SSE 降级和低成本扫表用的。

**执行细节走轮询，不走 SSE。**
`run_events` 比领域事件多两个数量级，全推上去会把 Analytics 和审计要扫的表撑爆
（[03 事件模型](03-event-model.md) §2）。所以分两路：SSE 负责「Run 状态变了」
这种低频信号，高频的执行细节用 `after` 游标增量拉，只在 Run 活跃时轮询。

**能力不足如实报，不悄悄降级。**
Claude Code 没有暂停语义，点「暂停」实际会变成终止。暂停可恢复、终止不可，
这个差别对用户是决定性的。后端返回 `501 UNSUPPORTED_FEATURE` 并带上替代动作，
界面把它连同「下一步能做什么」一起显示，而不是替用户做决定。

### 执行图的三个取舍

**关键路径、布局、诊断都在服务端算，前端只负责画。**
三者互相咬合：主因归因要先有关键路径，「伪串行」诊断要反复重算去掉某条边之后的
关键路径，泳道分层要先有拓扑序。放到前端就得把这套算法连同环检测一起搬过去，
而它同时还要喂 `GET /graph` 的 `metrics.primaryCause`。现在一次请求把
`nodes / edges / layout / metrics / diagnostics` 一起返回，客户端不存在
「算了一半」的中间态，`@apos/domain/graph` 也只有一份实现。

**诊断宁可少报，不可滥报。**
「伪串行依赖」第一版在 6 条边里报了 5 条 —— 任何两个前后相接的任务在结构上
都像可以并行，说了等于没说。改成必须同时满足三个条件才报：去掉这条边后关键路径
真的缩短、缩短幅度 ≥ 1h、两端执行者不同；再按收益排序取前 2 条。诊断区是这一页
唯一的「智能」，它一旦变成噪音，用户连带会忽略真正重要的阻塞告警。

**★ 图缩成一个点，问题不在图上。**
执行图一度渲染在 17%，数据全对却像坏了。根因是 App 外壳用了 `min-h-screen`：
高度不确定，`flex-1` 就无从结算，画布容器的 `clientHeight` 接近 0，
「适应窗口」老老实实算出了缩放下限。修法是外壳改 `h-screen overflow-hidden`
（高度确定，`min-h-0` 一路传下去），并用 ResizeObserver 等尺寸稳定后再 fit ——
比 `setTimeout` 猜一个延时可靠。这类 bug 单元测试永远碰不到，冒烟里固定了一条
「适应窗口后缩放 ≥ 40%」来兜。

### 入口链路的三个取舍

**确认需求后直接进计划页，中间不停留。**
用户刚做完一个判断，此刻最该看到的是这个判断导致了什么，
而不是被丢回一个列表再自己去找。所以「确认」这一个动作在后台串了
两步：approve → generatePlan，成功后直接跳转。

**★ 计划页的人机拆分不能数 `work_items.executorType`。**
批准之前任务还没被调度，`executorType` 全是 null —— 按它数出来永远是
「🤖 0　👤 0」，而同一页的快照正写着「4 个任务将由 Agent 自动执行」。
更糟的是这个数字会出现在批准弹窗里，也就是用户让渡执行权的那一刻。
正确的来源是计划生成时的 `humanGates` 快照：不在里面的就是 Agent 干的。
任务行也因此显示「👤 需要人 / 🤖 Agent」而不是「未分配」——
后者会被读成「漏排了」，而实际是「等调度时再挑」。

**「批准后将自动发生」用快照，不用展示时重算。**
用户批准的是**当时那份清单**。Policy 后来改了，追溯「他到底批准了什么」
必须看快照 —— 静默用新规则替换掉它，等于事后修改了用户签过字的东西。
页面同时给出按当前规则重算的边界供对照，两者不一致时明说。

### Analytics 的四个取舍

**指标口径必须写在指标旁边，而不是文档里。**
「流动效率 55%」这种数字，用户第一反应是「怎么算的」。答不上来他就不会
照着它做任何事，这一页也就白做了。所以每个指标卡都带 ⓘ 说明口径
（有效工作 = 有人或 Agent 正在推进；排队、阻塞、等批准都算等待），
每条系统发现都能展开「凭什么这么说」，里面写着判据本身 ——
包括阈值是多少。这些阈值来自页面文档 §5.1 的判据表，是产品设定的经验值，
不是行业统计（§12.2 把「基准值从哪来」列为待确认），所以更要让用户能反驳。

**数据源没接通就说「未接入」，绝不显示 0。**
按时交付率没有排期字段时返回 `null`，页面显示「未接入 · 计划里没有排期字段」。
显示 0% 会让人立刻去追责，而真相只是没人填过计划完成时间 ——
一个会导致错误行动的数字，比没有这个数字糟糕得多。预算消耗、
预算可用天数同理。

**★ 同一个词在两个页面上必须指同一件事。**
「被阻塞」在这个产品里有两种表达：`blocked` 状态，和 `blockedSince` 标记
（卡片还在 ready，但挂着「在等外部依赖」）——看板的「⛔ N 项阻塞」按后者算。
Analytics 起初只统计前者，于是看板说「1 项阻塞」、Analytics 说「阻塞 0h」。
两个数都对，放在一起就是错的。现在两个来源都算，重叠区间只算一次。

**必须给得出正面发现。**
这不是为了讨好用户。一个只会报警的分析页，用户第三次就不点了；
而一个没人看的分析页比没有分析页更糟，因为它让人以为这件事已经有人在管。
所以 `findInsights` 最后一定尝试找一条改善信号 —— 有上期就比环比，
没有就从绝对值里挑够好的那个说一句。

### 图表的做法

不引图表库。这一页全是「带标签的条」和「一条线」，Recharts 的体积换不来任何东西，
而 tooltip、直接标注、表格视图这些真正要紧的行为反而要绕开它的默认样式重做。
四个原语在 `features/analytics/charts.tsx`：`BarChart`、`TrendChart`、
`StatTile`、`NotWired`。

配色是**跑过校验的**，不是挑出来的（`features/analytics/palette.ts` 记了完整结果）：

- 两类序列 `#2a78d6` / `#eb6834` —— 色盲区分 ΔE 24.7、正常视觉 ΔE 33.6、对比度 ≥3:1，全通过
- 有序色阶在白底上**只放得下 5 级**。再加一级要么相邻两步分不开，要么最浅那级糊进背景。
  这个上限直接改变了设计：需要 6 类的图（按阶段的累积流图）因此没有用色阶画，
  而不是硬凑第六个颜色 —— 那正是「用生成的第 9 个色相」这类错误的开头。
- 图表框架用 app 自己的 slate 灰阶，不用配色表里的暖灰。一页之内出现两套中性色，
  图表会看起来像贴上去的。

几条一直守着的规矩：条形数据端 4px 圆角、基线端方角；线宽 2px；网格是实线发丝，
不用虚线；值为 0 就画成 0（留一条细缝会被读成「有一点」，那是假的）；
状态色永远配图标 + 文字，颜色不做唯一线索；趋势图只直接标注峰值与最新值，
其余交给 hover，并且 hover 不是读到数字的唯一途径 —— 每张趋势图都有「看数据」表格。

### Policy 配置的四个取舍

**摘要那一行是整页最重要的东西。**
用户不会去读 12 条规则再自己推导边界，他要的就是「N 类自动执行、M 类需要人确认」。
难点在「视情况而定」那一类：真实的分界往往是**析取**的（「生产环境，或者风险高」），
只在单个轴上找分界会一个都找不到，退化成「12 / 20 种情况需要人确认」——
一句正确但毫无用处的话。现在的做法是先找出「只要满足它就一定需要人」的单值条件，
再看它们的并集能不能盖住全部需要人的场景，能盖住就直接说出来。

**摘要与体检共用同一次场景枚举。**
「这两条规则会冲突吗」在一般情况下是个约束求解问题。真去写个小型求解器，
代价大、结果还难以向用户解释 —— 而用户要的不是「已证明无冲突」，
是「给我看那个会出问题的场景」。把有限的真实场景跑一遍，得到的正是能直接展示的反例。
代价也说清楚了：网格覆盖不到的组合检测不出来，所以页面写的是「检测到 N 个问题」
而不是「没有问题」，并明说这是抽样不是证明。

**★ 安全阀放在服务端，判据是「会不会自动放行」而不是「网格有没有变松」。**
页面文档 §9 要求放宽类变更携带 `simulation_id`。那个 id 是客户端给的，
伪造一个字符串就能绕过 —— 而这道闸恰恰是本页最重要的东西
（§10「放宽类规则变更 100% 经过模拟验证」）。改成服务端在保存时自己跑一遍模拟，
发现与人类判断不一致的历史案例就返回 422 并把案例带回去，客户端必须显式
`acknowledgeMismatches` 才能继续。
判据也从「场景网格变松了吗」改成了「这条规则会不会自动放行」：两者不等价，
一条「中低风险部署自动放行」在网格上可能一个场景都没放宽（那些场景本来就是自动的），
却照样会自动批准历史上 10 个被人驳回过的任务 —— 按网格判，它一路绿灯。

**规则列表只显示人话，条件表达式留在编辑器里。**
`risk == 'low' && cost < 10` 项目负责人看不懂，也就不会去管，
最后治理配置只剩工程师一个人维护。解释用模板拼接生成，**不用大模型** ——
解释与实际执行逻辑必须严格一致，模型的偏差会直接导致用户误配规则。
模板 → 条件/动作的映射也只在后端有一份实现，前端跟着算一遍就有两份，
迟早出现「界面上写的规则」和「实际执行的规则」不是同一条。

### 总览、决策中心、Agent、运行时的四个取舍

**总览上的每个数字都能展开成它的来源。** 健康度不是一个「综合评分」，是
100 分起扣的减分制，每一分丢在哪里都点得开；延期概率不是模型输出，是七条
写死的经验规则，页面上直接标明「这不是统计模型」。一个说不清来源的分数有两种下场
—— 被当成事实引用，或被当成玄学忽略，两种都不好。知道它怎么算的，
用户才知道什么时候该忽略它。

**决策中心只提供批量批准，不提供批量驳回。** 驳回必须写原因，而每条的原因各不相同：
批量驳回要么逼用户写一句放之四海皆准的废话，要么干脆不写，两种都在破坏
「每次覆盖都要留下为什么」这条底线 —— 而那正是 Analytics「重复决策 → 可自动化」
唯一的数据来源。批量批准也只对**可逆且非高风险**的决策开放：页面文档要 5 分钟清空队列，
但队列里混着「合并 PR」和「删生产库数据」时，一个全选框就是事故本身。
批量省的是点击，不是阅读。后端逐条走单条批准的**同一个函数**，
不可代行、状态机、Policy 一个都不绕（`decisions/batch-approve` → `approveDecisionById`）。

**Agent 详情按人事口径组织，不按服务配置组织。** 顺序是「它是谁 → 在做什么 →
做得怎么样 → 被允许做什么 → 出问题怎么干预」。把权限表放最上面，这一页就退化成
一个 YAML 编辑器。「任务队列」只算没做完的：`executorId` 是永久归属不是队列，
直接列出来会让一个干了半年的 Agent 显示「队列 200」，而它其实闲着。

**运行时能力先说做不到什么。** 一个把 14 个能力项打满绿勾、把缺失折叠到底部的面板，
等于把降级又藏回去了。每条缺失都摊开三段：降级后的行为、对用户的影响、严重程度 ——
只写「不支持 pause」用户没法据此做决定，写「暂停降级为终止，会丢失执行中的进度」才行。
用户在派高风险任务之前，有权先看见「这个 Agent 的暂停其实是终止」。

### 身份与缓存

后端有一整类响应按 `X-User-Id` 计算（决策收件箱的「待我处理」、总览的「需要你处理」、
决策卡片的 `canAct`），而这些查询的 key 里没有用户 id。因此：

- **身份一变就整体作废缓存**（`stores/auth` → `queryClient.invalidateQueries()`）。
  不作废的话，切换身份后页面会拿上一个人的答案接着显示，而且看起来完全正常 ——
  一个声称「决策不可代行」的系统，在界面上把张三的待办摆给李四看。
- **首次落定身份（匿名 → 有人）同样要作废**。应用启动时 `/users` 还没回来，
  期间发出的请求是匿名的，后端会如实返回「没有需要你处理的事」并被缓存下来。
- **身份相关的页面 `enabled: Boolean(userId)`**，不在身份未定时先问一遍。

### 集成的四个取舍

**Source of Truth 是这一层唯一真正难的地方，难点不在代码量。** 两个系统都能改同一个字段，
就必然有一方的修改会被丢掉。一个集成能不能被信任，取决于它能不能回答三个问题 ——
谁说了算、另一边怎么办、被丢掉的那次修改去哪了。答不上来的集成，
用完一阵子的结果是两边的数据都没人敢信。所以：判定（`resolveSync`）与写入分开，
判定只返回一个可被审计的 `Resolution`；每个字段的默认归属都带一句「为什么」；
改 SoT 先摆出差异与后果再确认，并写事件留痕。

**状态字段默认「记录冲突」而不是默认「回写」。** 状态是唯一一个会驱动流程往下走的字段：
悄悄把它回写回去，外部系统里那个人会看到自己刚点的「Done」被弹回 Review，
而且没有任何解释。别的字段被覆盖只是数据不一致，状态被覆盖是「这个系统在跟我较劲」。

**同一个字段的未处理冲突只留一条。** 冲突未解决时同步基准不推进（这是对的），
于是每一轮同步都会重新判出同一个冲突。不去重的话，一个每 5 分钟拉一次的集成
会在一天里堆出近三百条一模一样的记录，用户处理完第一条之后还剩两百九十九条 ——
功能在测试里是好的，在生产上没法用。已存在的那条要更新快照，
因为外部可能又改了一次，给用户看的必须是现在的值。

**权限的允许项与禁止项必须并列，且禁止项由集成层写死。** 与 08 Agent Workspace 同一条原则：
用户要确认的往往是「这个连接**不能**合并我的代码」。`NEVER_GRANTED_SCOPES` 不是
「默认关掉、想开可以开」，而是集成层根本不提供这条路径 —— 提供了它就迟早会被打开。
服务端在建立连接时会复核适配器返回的 allowed，即便适配器有 bug 也拦得住。
另外「能连上」和「能让它改我的代码」分两档权限：pm 能连，开写权限要 tech_lead。

### 假的外部系统，真的同步引擎

真实 provider 的 HTTP 传输层没有做（需要 OAuth 凭证与能连出去的网络）。
做法不是画一套点了没反应的授权按钮，而是：

- 定义 `IntegrationAdapter` 接口（按同步引擎需要什么定义，不按各家 API 长什么样定义）
- 写一个**进程内适配器**，拉取、回写、来源标记、外部删除、限流报错都真的发生
- 它下游的一切 —— SoT 判定、冲突生成与去重、循环抑制、权限校验、断开影响 ——
  都被端到端跑通并写进冒烟
- 页面上如实标注「这个 provider 还没有传输层」

进程内适配器的存储是可插拔的：测试用 Map，开发环境注入 DB 后端（`dev_external_objects`），
因为种子脚本和 API 是两个进程 —— 假外部系统只活在种子进程里的话，
页面上点「立即同步」什么也不会发生，而那正是最该被看见能工作的一步。
真实 provider 接上之后那张表可以直接删。

★ `IntegrationAdapter` 刻意不提供 `delete`。外部对象的删除由对方系统负责，
我们只在拉取时发现「它不见了」并打标 —— 一个能删外部对象的集成，出错时的代价不可逆。

### 判定同源的几处

前端不复制后端规则，两边引用同一份实现：

- **拖拽落点**：`evaluateDrop` → `manualTargetForStage`（`@apos/domain`），后端 PATCH 用 `manualTriggerFor`，同一个状态机推导
- **卡片归属的列**：`stageFor`（`@apos/contracts`），看板 API 与 SSE 补丁用的是同一个函数
- **集成权限**：`canIntegration` / `denyReason`（`@apos/domain` permissions/integration）。
  前端用它灰掉按钮，后端用它真正拦住请求 —— 界面上能点但服务端不让做（体验差），
  或服务端让做但界面点不了（等于没做），两种偏差在「谁能给外部系统开写权限」这件事上都不能接受。
  共用一份实现不等于信任前端：服务端每个写接口都独立判一次
- **状态与决策类型的中文名**：`STATUS_LABELS`（`@apos/contracts`）、`decisionLabel`（`@apos/domain`）。
  后端也要拼给人看的句子（决策卡片上的「不处理会怎样」），各写一份的下场已经见过：
  决策类型的标签表按页面文档的词汇写，而运行时发出的是另一套，
  于是界面上一直印着 `high_risk_operation` 这样的裸 key

### 本地跑起来

```bash
bash scripts/dev-up.sh                                   # Postgres → 迁移 → API(:3000) → Vite(:5173)，幂等
DATABASE_URL=…/apos pnpm --filter @apos/api seed --reset # 造演示数据（走真实链路，只在空库时需要）
pnpm --filter @apos/web smoke <projectId>                # 真实浏览器冒烟，99 项（全部页面）
```

`dev-up.sh` 里面就是原来那几步（`pg-dev.sh` 起库、两个库分别 `db:migrate`、
`@apos/api start`、`@apos/web dev`），拆开手动跑也一样。容器回收后重跑一遍即可。

★ `TEST_DATABASE_URL` 必须与 `DATABASE_URL` 不同 —— 测试在 `beforeEach` 里 TRUNCATE 全表。
