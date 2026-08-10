# Autonomous Project OS 页面文档

本目录是[产品功能文档 V0.2](../autonomous-project-os.md) 的页面级落地说明，覆盖第十四章列出的 14 个 MVP 页面。

本文件定义**全局约定**（导航、路由、角色、通用组件、状态机、交互规范）。各页面文档只描述自身差异，通用部分引用本文件，不重复。

---

## 一、页面清单

| # | 页面 | 文档 | 路由 | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | 项目列表 | [01-project-list.md](01-project-list.md) | `/projects` | P0 |
| 2 | 项目总览 | [02-project-overview.md](02-project-overview.md) | `/projects/:projectId` | P0 |
| 3 | 需求录入与 AI 澄清 | [03-requirement-intake.md](03-requirement-intake.md) | `/projects/:projectId/requirements/:reqId` | P0 |
| 4 | 项目计划确认 | [04-plan-approval.md](04-plan-approval.md) | `/projects/:projectId/plans/:planId` | P0 |
| 5 | Autonomous Board | [05-autonomous-board.md](05-autonomous-board.md) | `/projects/:projectId/board` | P0 |
| 6 | Work Item 详情 | [06-work-item-detail.md](06-work-item-detail.md) | `/projects/:projectId/items/:itemId` | P0 |
| 7 | Execution Graph | [07-execution-graph.md](07-execution-graph.md) | `/projects/:projectId/graph` | P1 |
| 8 | Agent Workspace | [08-agent-workspace.md](08-agent-workspace.md) | `/agents/:agentId` | P0 |
| 9 | Agent Run 详情 | [09-agent-run-detail.md](09-agent-run-detail.md) | `/runs/:runId` | P0 |
| 10 | Human Decision Center | [10-decision-center.md](10-decision-center.md) | `/decisions` | P0 |
| 11 | 决策详情 | [11-decision-detail.md](11-decision-detail.md) | `/decisions/:decisionId` | P0 |
| 12 | 项目 Analytics | [12-project-analytics.md](12-project-analytics.md) | `/projects/:projectId/analytics` | P1 |
| 13 | Policy 配置 | [13-policy-config.md](13-policy-config.md) | `/projects/:projectId/settings/policies` | P0 |
| 14 | 项目集成设置 | [14-integration-settings.md](14-integration-settings.md) | `/projects/:projectId/settings/integrations` | P1 |

> Home 工作台（文档 8.1）在 MVP 中不作为独立页面开发，登录后默认跳转 `/projects`；决策入口由全局导航的 Decision Center 承担。完整 Home 见 Post-MVP。

---

## 二、页面关系图

```
                        ┌──────────────┐
                        │ 01 项目列表   │
                        └──────┬───────┘
                               │ 进入项目
                        ┌──────▼───────┐
        ┌───────────────┤ 02 项目总览   ├───────────────┐
        │               └──────┬───────┘               │
        │                      │                       │
┌───────▼────────┐    ┌────────▼────────┐    ┌─────────▼────────┐
│ 03 需求录入     │    │ 05 Autonomous   │    │ 12 项目 Analytics │
│    与 AI 澄清   │    │    Board        │    └──────────────────┘
└───────┬────────┘    └────┬───────┬────┘
        │ 需求确认          │       │ 切换视图
┌───────▼────────┐         │  ┌────▼──────────────┐
│ 04 计划确认     │         │  │ 07 Execution Graph│
└───────┬────────┘         │  └───────────────────┘
        │ 计划批准          │ 点击卡片
        └──────────────┐   │
                    ┌──▼───▼─────────┐
                    │ 06 Work Item   │
                    │    详情         │
                    └──┬──────────┬──┘
                       │          │
        ┌──────────────▼──┐   ┌───▼──────────────┐
        │ 09 Agent Run    │   │ 11 决策详情       │
        │    详情          │   └───▲──────────────┘
        └──────▲──────────┘       │
               │                  │
        ┌──────┴──────────┐   ┌───┴──────────────┐
        │ 08 Agent        │   │ 10 Decision      │
        │    Workspace    │   │    Center        │
        └─────────────────┘   └──────────────────┘

        设置类：13 Policy 配置 ─ 14 集成设置 ← 02 项目总览 / 项目设置
```

---

## 三、全局导航

对应产品文档第七章信息架构。MVP 实现加粗部分。

```
顶部栏：[Logo] [项目切换器 ▾]          [搜索] [决策角标 🔔3] [成本预警] [用户 ▾]

左侧主导航：
├── Home              （MVP：重定向到 Projects）
├── **Projects**      /projects
├── **Decisions**     /decisions        ← 带未处理数量角标
├── **Agents**        /agents
├── Knowledge         （Post-MVP）
├── Analytics         （MVP 仅项目级，入口在项目内）
└── Administration    （MVP 仅 Policy / 集成，入口在项目设置内）

项目内二级导航（进入某项目后显示）：
总览 | 看板 | 计划 | 执行图 | 需求 | Agent 团队 | 决策记录 | Analytics | 设置
```

**决策角标**：Decision Center 未处理数是全局最高优先级的提示，任何页面都可见。数量 > 0 时显示红点；存在"即将超时"决策时角标闪烁一次并变为橙色。

---

## 四、角色与权限

**角色是数据不是枚举**：下面是预置的内置角色，组织管理员可以在
「角色定义」页（`/projects/{id}/settings/roles`）自定义研发、运营、测试等角色。

| 角色 | 说明 | 典型权限 | 谁能担任 |
| --- | --- | --- | --- |
| `org_admin` | 组织管理员 | 全部；管理身份、**定义角色**、模型接入、全局 Policy | 人 |
| `sponsor` | 项目 Sponsor / 业务负责人 | 需求确认、预算超限审批、业务验收、结项 | 人 |
| `tech_lead` | 技术负责人 | 计划批准、架构决策、Agent 连续失败处理、Policy 配置 | 人 |
| `pm` | 项目负责人 / 项目经理 | 项目设置、收紧 Policy、调度调整、成员管理 | 人 |
| `member` | 项目成员（开发者等） | 认领与执行任务、提交产物、接管 Agent、处理决策 | 人 |
| `executor` | 执行者 | 只执行任务，不参与任何决策与审批 | 人 / **Agent** |
| `agent_owner` | Agent 负责人 | 配置所属 Agent 的能力、权限、成本上限 | 人 |
| `viewer` | 观察者 | 只读 | 人 / Agent |

**同一个角色可以由人担任，也可以由 Agent 担任** —— 这是混合团队的基本形状：
「测试」这个岗位上可能坐着一个人，也可能是 `test-agent-1`。
成员页把两者分组显示但共用一套角色。

但带 Human Gate 权限的角色（确认需求、批准计划、处理决策）**永远给不了 Agent**。
角色编辑器里这些权限标着「仅人类」，勾上就会锁掉「允许 Agent 担任」，
并说明是哪几条 —— 而不是等提交后被服务端驳回。

**权限判定顺序**：`组织角色 → 项目角色 → 资源级 Policy → 数据权限（ABAC）`。任一环节拒绝即拒绝。

**只读降级原则**：无操作权限时，页面**仍然可见**（除非数据权限禁止），但所有写操作控件置灰并显示 tooltip「需要 `tech_lead` 角色」。不做整页 403，避免用户不知道自己缺什么权限。

**实现**：`GET /api/v1/projects/{id}/permissions` 一次返回当前身份在这个项目里的
全部权限与拒绝理由；前端用 `<GatedButton permission="...">`
（`apps/web/src/components/Gated.tsx`）灰按钮并把理由挂在 tooltip 上。
判定规则来自服务端（`packages/domain/src/rbac/`），前端不重算——
两份实现的偏差要么是「能点但做不了」，要么是「做得了但点不到」。

判定还没回来时按钮**保持灰的**，不是先亮着：乐观的默认会让手快的人
在加载的半秒里点下去，然后收到一个 403 弹窗。

**灰按钮不是权限**。服务端对每个写操作独立判一遍，
直接打 API 或用一个旧版本的前端照样会被 403 挡回去。
角色在「成员与角色」页（`/projects/{id}/settings/members`）调整。

---

## 五、通用组件规范

### 5.1 Human Gate Badge

对应文档 8.4.3。所有卡片、列表行、详情页头部统一使用。

| 状态 | 文案 | 颜色 | 图标 |
| --- | --- | --- | --- |
| `approval_required` | 待审批 | 橙 | ⚠ |
| `waiting_for_decision` | 等待决策 | 橙 | ⏳ |
| `human_reviewing` | 人类审核中 | 蓝 | 👁 |
| `human_took_over` | 已人工接管 | 紫 | 🙋 |
| `approved` | 已批准 | 绿 | ✓ |
| `rejected` | 已驳回 | 红 | ✕ |
| `escalated` | 已升级 | 红 | ↑ |
| `decision_overdue` | 决策超时 | 深红（闪烁） | ⏰ |

**规则**：一个对象同时只显示一个 Human Gate 状态；`decision_overdue` 优先级最高，覆盖其他状态显示。

### 5.2 Assignee Chip（执行主体）

人类与 Agent 在视觉上必须可区分——这是本产品与传统看板最核心的界面差异。

```
人类：  (👤 张伟)          圆形头像 + 姓名
Agent： [🤖 code-agent-1]  方形图标 + 名称 + 状态点
混合：  (👤 张伟) ← [🤖 code-agent-1]   人类审核 / Agent 执行
```

Agent 状态点：`● 空闲`（灰）`● 执行中`（蓝，呼吸动效）`● 阻塞`（橙）`● 失败`（红）

### 5.3 Risk Badge（风险等级）

`低`（灰）`中`（黄）`高`（橙）`极高`（红）。高及以上在卡片上常驻显示，低风险不显示以降噪。

### 5.4 Autonomy Badge（自治等级）

对应文档 8.9.4，显示在项目头部：

- `Human-led` — 人类主导（灰）
- `Agent-led + Approval` — Agent 主导 + 关键批准（蓝，默认）
- `Agent-autonomous` — Agent 自治（紫）

### 5.5 Update Source Tag（状态来源）

文档 8.3.5 明确要求区分状态更新来源。所有状态变更在时间线中标注：

`🔧 系统` / `🤖 Agent` / `👤 人类` / `🔗 外部同步`

人类手动改状态时**必须填写原因**（文档 8.4.4），原因记入 Event。

### 5.6 Cost Meter（成本与 Token）

统一格式：`$1.24 · 82.3k tok`。超过项目预算 80% 时数字变橙，100% 变红并附「已超限」标签。悬停显示明细（模型 / 输入 / 输出 / 缓存）。

### 5.7 Blocked Duration（阻塞时长）

`⛔ 阻塞 4h 12m`。阈值：< 2h 灰，2–8h 橙，> 8h 红。阻塞原因作为 tooltip（对应文档 8.6.4 的九类）。

### 5.8 Event Timeline（事件流）

Work Item 详情、Agent Run 详情、决策详情共用同一组件。

```
│ ● 14:32  🤖 code-agent-1   调用工具 read_file(src/api.ts)      [展开]
│ ● 14:33  🤖 code-agent-1   提交产物 PR #42                     [查看]
│ ● 14:35  🔧 系统            自动测试通过 (48/48)                [报告]
│ ● 14:36  🔧 系统            Policy #7 命中 → 需要人类审批
│ ● 15:02  👤 张伟            批准并附加约束「仅限灰度 10%」       [详情]
```

支持按来源过滤、按类型过滤、跳转到原始 Run / 产物。

### 5.9 页面状态

每个页面必须定义四种状态，各页面文档中的「状态设计」章节只写差异：

| 状态 | 默认处理 |
| --- | --- |
| 加载中 | 骨架屏（保持布局不跳动），> 3s 显示进度说明 |
| 空 | 图标 + 一句话说明 + **主行动按钮**（不做纯插画空状态） |
| 错误 | 错误原因 + 重试按钮 + 「查看事件日志」链接 |
| 无权限 | 见 §4 只读降级原则 |

### 5.10 实时更新

本产品状态由系统事件驱动（文档 8.4.4），页面不能依赖手动刷新。

- 传输：SSE（订阅 `project:{id}` / `run:{id}` / `user:{id}:decisions` 频道）
- 更新动效：新增/变更元素高亮 1.5s 后淡出，**不自动滚动**打断用户阅读
- 用户正在编辑的表单区域不被远端更新覆盖，改为顶部提示「该内容已被 Agent 更新，[查看差异] [使用最新]」
- 断线：顶部黄条「实时连接已断开，正在重连…」，恢复后拉取增量

---

## 六、状态机

### 6.1 六阶段与 Work Item 状态映射

| 阶段 | 包含状态 | 谁推进 |
| --- | --- | --- |
| **Intake** | `draft` `clarifying` `awaiting_requirement_approval` | Agent 结构化 → 人类确认 |
| **Planning** | `planning` `awaiting_plan_approval` | Project Agent 生成 → 人类批准 |
| **Execution** | `ready` `executing` `blocked` `failed` | Agent / Human 执行 |
| **Review** | `reviewing` `changes_requested` `awaiting_decision` | Review Agent / 人类 |
| **Release** | `waiting_for_release` `releasing` `released` | Policy 决定是否需审批 |
| **Done** | `acceptance` `done` `cancelled` | 人类业务验收 |

### 6.2 自动流转（文档 8.4.4）

```
创建 Work Item            → ready
Agent Run 启动            → executing
Agent 输出完成            → reviewing
自动测试 + Review 通过     → waiting_for_release
发布完成                  → acceptance
人类业务验收通过           → done
```

### 6.3 异常流转（文档 8.6.5）

```
Agent Run 失败            → failed →（Policy）自动重试 / 换 Agent / 转人工
依赖未满足                → blocked
命中需审批 Policy          → awaiting_decision（生成 Decision 对象）
决策超时                  → escalated →（升级规则）通知上级 / 暂停关键路径
人类接管                  → executing（执行主体切换为 Human）
```

---

## 七、页面文档模板

新增页面文档时遵循以下结构：

```
1. 页面信息（路由 / 角色 / 优先级 / 对应产品文档章节）
2. 页面目标（一句话 + 要回答的核心问题）
3. 入口与出口
4. 页面结构（ASCII 线框）
5. 区域详解（字段 / 数据来源 / 交互）
6. 核心交互流程
7. 状态设计（仅写与全局约定的差异）
8. 权限
9. 数据依赖（领域对象 + 接口）
10. 埋点与指标
11. 边界与异常
12. 待确认问题
```

---

## 八、贯穿全部页面的设计原则

1. **先回答"要我做什么"，再展示"发生了什么"**。所有页面顶部优先放待人类处理的事项，执行详情次之。
2. **人类与 Agent 视觉必须可区分**。任何显示执行主体的地方都用 §5.2 规范。
3. **每个自动化结果都可追溯**。状态、产物、结论旁必须有链接指向产生它的 Run / Event / Policy。
4. **不制造无行动的通知**。页面上的每个警示都要带一个可点击的下一步。
5. **手动操作要留痕**。人类覆盖系统判断时记录原因，进入 Event 与审计日志。
6. **成本始终可见**。凡是触发 Agent 执行的按钮，旁边给出预估成本。
