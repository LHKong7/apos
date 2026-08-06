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
| 项目列表 | `pages/ProjectList` | 进入看板的入口 |
| 智能看板 | `pages/Board` | Kanban / List / Agent / 待决策 四视图 |
| 任务详情抽屉 | `features/work-item/WorkItemDrawer` | 概览 / 执行记录 / 时间线；含补充上下文重试 |
| 决策抽屉 | `features/decision/DecisionDrawer` | 批准（可附加约束）/ 驳回；「不可代行」在界面上体现 |
| 手动移动 | `features/work-item/ManualMoveDialog` | 强制填原因 + 分类，落到事件 |
| Run 详情 | `pages/RunDetail` + `features/run/` | 执行流 / 输入 / 产物 / 成本 / 错误五个页签，简明⇄详细切换，运行时控制 |
| 执行图 | `pages/Graph` + `features/graph/` | 分层 / 阶段泳道 / 执行者泳道三种布局，关键路径、上下游追溯、结构诊断 |
| SSE | `lib/sse/` | 单连接多频道、退避重连、事件 → 缓存补丁 |
| 编辑保护 | `stores/editing` | 远端更新不覆盖正在编辑的字段，冲突留痕 |
| 通用组件 | `components/` | AssigneeChip、Human Gate 徽标、风险、成本、阻塞时长、空/错状态 |

### 刻意没做

| 项 | 原因 |
| --- | --- |
| Analytics / Policy 配置 / 集成设置 | 后端还没有对应接口，先做出来只能是假页面 |
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

### 判定同源的两处

前端不复制后端规则，两边引用同一份实现：

- **拖拽落点**：`evaluateDrop` → `manualTargetForStage`（`@apos/domain`），后端 PATCH 用 `manualTriggerFor`，同一个状态机推导
- **卡片归属的列**：`stageFor`（`@apos/contracts`），看板 API 与 SSE 补丁用的是同一个函数

### 本地跑起来

```bash
bash scripts/dev-up.sh                                   # Postgres → 迁移 → API(:3000) → Vite(:5173)，幂等
DATABASE_URL=…/apos pnpm --filter @apos/api seed --reset # 造演示数据（走真实链路，只在空库时需要）
pnpm --filter @apos/web smoke <projectId>                # 真实浏览器冒烟（看板 / Run / 执行图）
```

`dev-up.sh` 里面就是原来那几步（`pg-dev.sh` 起库、两个库分别 `db:migrate`、
`@apos/api start`、`@apos/web dev`），拆开手动跑也一样。容器回收后重跑一遍即可。

★ `TEST_DATABASE_URL` 必须与 `DATABASE_URL` 不同 —— 测试在 `beforeEach` 里 TRUNCATE 全表。
