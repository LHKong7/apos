# 02 领域模型与数据库设计

对应产品文档第六章十个核心对象。数据库为 PostgreSQL 16。

---

## 1. 三个贯穿全局的建模决策

在看具体表之前，先说明三个影响所有表的决策。

### 1.1 Actor 而非 User

产品文档 10.1 定义了四类身份：Human / Agent / Service / External Integration。10.3 明确要求 Agent 权限独立于人类配置。

**因此系统里没有 `user_id` 字段，只有 `(actor_type, actor_id)`。**

```sql
CREATE TYPE actor_type AS ENUM ('human', 'agent', 'service', 'external', 'system');
```

任何"谁做了这件事"的地方都用这一对字段。这看起来只是命名差异，实际影响很大：

- 审计日志天然区分人机操作，不需要事后推断
- 权限判定的入参统一，Agent 不会意外走人类的权限路径
- 页面文档要求的「状态来源标识」（🔧系统/🤖Agent/👤人类/🔗外部）直接由 `actor_type` 渲染

**代价**：无法用外键约束到单一表。做法是不加外键，靠应用层保证，并提供视图做联查：

```sql
CREATE VIEW actors AS
  SELECT 'human'::actor_type AS type, id, name, avatar_url FROM users
  UNION ALL
  SELECT 'agent', id, name, icon_url FROM agents
  UNION ALL
  SELECT 'service', id, name, NULL FROM service_accounts;
```

### 1.2 Work Item 单表 + 类型判别

产品文档 6.3 定义 Work Item 是统一工作对象，可配置 13 种类型（Requirement / Feature / Story / Task / Bug / Research / Review / Test / Incident / Decision / Approval / Release / Knowledge Item）。

**建模**：单表 + `type` 判别列 + `type_data JSONB` 存类型特有字段。

不做每类型一张表（会导致跨类型查询、依赖图、看板查询全部变成 UNION），也不做 EAV（不可查询）。共有字段是列，特有字段进 JSONB 并按需建 GIN 索引。

**注意**：产品文档把 `Decision` 和 `Approval` 也列为 Work Item 类型，但同时 6.7 又把 Decision 定义为独立核心对象。这里的处理是：**Decision 是独立表**（它有责任人、时限、方案、会签等复杂结构），Work Item 中的 `decision` 类型只是一个指向 Decision 的轻量占位，用于让决策出现在看板与依赖图上。

### 1.3 多租户与软删除

- 所有业务表带 `org_id`，启用 Row Level Security
- 领域对象**不做物理删除**，用 `deleted_at`。原因：审计要求（10.5）与事件因果链完整性——删除一个 Work Item 会让引用它的历史事件悬空
- `events` 表永不删除，只归档

---

## 2. 身份与组织

**组织**是一切数据的顶层容器：项目、工作项、Agent、代码仓库、成员、审计事件
全都挂在某一个 `org_id` 下，彼此完全隔离。对应 Plane 的 Workspace。

### 2.0 为什么不叫 Workspace

★★ `workspace` 在这个代码库里已经有一个确定含义：**Agent 干活的那个 git
工作区**（`AGENT_WORKSPACE_ROOT`、`WorkspaceProvisioner`、`agent_runs.workspace`）。
两个概念共用一个词，「清理 workspace」「workspace 权限」这类句子会同时指向
两件毫不相干的事，而这种歧义在排障时最贵——看日志的人根本不知道在说哪一个。

组织这个概念已经铺满 25 张表的 `org_id`、整套 `OrgRole` 与 `org_admin` 判定；
改名是纯字面工作，收益为零，还要正面撞车。所以：
**产品层叫「组织」，`workspace` 一词永远只指 Agent 工作区。**

```sql
CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          text NOT NULL UNIQUE,             -- URL 里的人类可读标识
  description   text,
  settings      jsonb NOT NULL DEFAULT '{}',
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ★ 账号是**全局**的，不属于任何组织
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  name          text NOT NULL,
  avatar_url    text,
  -- 产品文档 6.5
  skills        text[] NOT NULL DEFAULT '{}',
  approval_scopes text[] NOT NULL DEFAULT '{}',   -- 可审批事项：db_change, security_exception...
  notification_prefs jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'active',   -- active | suspended | offboarded
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ★★ 归属与组织角色在这里，不在 users 上
CREATE TABLE organization_members (
  org_id        uuid NOT NULL REFERENCES organizations(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  org_role      text NOT NULL DEFAULT 'member',   -- org_admin | member
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE service_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  name          text NOT NULL,
  purpose       text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

### 2.1 为什么账号与归属是多对多

★★ 原来的 `users.org_id` + `users.org_role` 把账号和归属焊死成一对一：
一个人要参与第二个组织，只能再注册一个账号。而组织之间的边界正是多租户隔离
的边界，所以「同一个人的两个账号」在审计里是**两个不同的人**——跨组织协作的
顾问、外包、平台方全都描述不出来。

★ 组织角色跟着归属走而不是跟着账号走：同一个人可以是 A 组织的管理员、
B 组织的普通成员。放在 users 上这句话就说不出来。

★ email 因此是全局唯一。同一个邮箱此前可以在两个组织里各有一个账号，
那两行现在必须合并——迁移 0014 会显式报错列出它们，而不是让 Postgres
抛一句认不出来的约束冲突。

### 2.2 「当前是哪个组织」由请求显式带上

账号能属于多个组织之后，这件事不再能从账号上读出来，所以走 `X-Org-Id` 头
（与 `X-User-Id` 并列，见 `rbac.ts` 的 `resolveCurrentOrg`）。

★ **没带头时不能报错**：老客户端、curl 脚本、seed 之后第一次打开的页面
都不会带，那时报 400 的表现是「整个站点白屏」。所以没带就回落到确定的缺省
（按加入时间的第一个组织），并把算出来的 `currentOrgId` 回给调用方——
前端不该自己猜，猜错的表现是切换器显示 A、数据来自 B，而两边都不报错。

★ 带了但不是成员 → **404 而不是 403**。403 等于确认「这个组织存在」，
把组织 id 变成可枚举的探针，和项目那一层同一条理由。

★ URL 里带组织 id 的写路由（`PATCH /organizations/:id`）必须校验它就是
**当前**组织：权限判定拿的是当前组织的 orgRole，handler 如果转头去改
URL 里的另一个组织，那次判定就白判了。

`approval_scopes` 支撑产品文档 8.7.5 的决策责任自动识别——决策创建时按类型查找具备对应 scope 的人。

---

## 3. Project（6.1）

```sql
CREATE TYPE autonomy_level AS ENUM ('human_led', 'agent_led_approval', 'agent_autonomous');
CREATE TYPE project_status AS ENUM ('active', 'paused', 'completed', 'archived');

CREATE TABLE projects (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  name              text NOT NULL,
  goal              text,
  type              text NOT NULL DEFAULT 'development',  -- 影响默认流程与 Policy 模板
  status            project_status NOT NULL DEFAULT 'active',
  autonomy_level    autonomy_level NOT NULL DEFAULT 'agent_led_approval',
  risk_level        risk_level NOT NULL DEFAULT 'medium',

  sponsor_id        uuid REFERENCES users(id),      -- 业务负责人
  tech_lead_id      uuid REFERENCES users(id),      -- 技术负责人

  starts_at         date,
  ends_at           date,
  budget_amount     numeric(12,2),                  -- NULL = 不限
  budget_currency   text NOT NULL DEFAULT 'USD',
  cost_spent        numeric(12,2) NOT NULL DEFAULT 0,  -- 冗余累加，避免每次聚合

  stage_config      jsonb NOT NULL DEFAULT '[...]', -- 六阶段可配置
  wip_limits        jsonb NOT NULL DEFAULT '{}',    -- { "execution": 8, ... }

  paused_reason     text,
  paused_by         uuid,
  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_members (
  project_id    uuid NOT NULL REFERENCES projects(id),
  actor_type    actor_type NOT NULL,
  actor_id      uuid NOT NULL,
  role          text NOT NULL,        -- pm | tech_lead | sponsor | member | viewer
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, actor_type, actor_id)
);
```

**`project_members` 用 actor 而非 user**：Agent 加入项目走同一张表。产品文档把 Agent 称为「项目 Agent」并列在项目成员之外，但在权限判定上两者需要统一处理——Agent 是否属于本项目，与人是否属于本项目，是同一个问题。

**`cost_spent` 冗余字段**：成本要在看板、总览、卡片上高频显示，实时 SUM 聚合 agent_runs 太慢。用触发器或应用层在 Run 结束时累加，配合每日对账任务纠偏。

---

## 4. Requirement（6.2）

```sql
CREATE TYPE requirement_status AS ENUM (
  'draft', 'analyzing', 'clarifying', 'awaiting_approval',
  'approved', 'rejected', 'on_hold'
);

CREATE TABLE requirements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  project_id        uuid NOT NULL REFERENCES projects(id),
  status            requirement_status NOT NULL DEFAULT 'draft',

  -- 原始输入（永不覆盖，产品文档 8.2 要求原文可验证）
  raw_input         text NOT NULL,
  input_method      text NOT NULL,   -- manual | conversation | document | external | api
  source_ref        jsonb,           -- { system: 'jira', key: 'ORDER-142', url: ... }

  -- AI 结构化结果（8.2.2）
  title             text,
  business_context  text,
  user_problem      text,
  business_goal     text,
  user_stories      jsonb NOT NULL DEFAULT '[]',
  scope             jsonb NOT NULL DEFAULT '{}',   -- { in_scope: [], out_of_scope: [] }
  non_functional    jsonb NOT NULL DEFAULT '[]',
  success_metrics   jsonb NOT NULL DEFAULT '[]',
  constraints       jsonb NOT NULL DEFAULT '[]',
  risks             jsonb NOT NULL DEFAULT '[]',

  -- ★ 验收标准必须结构化：后续 Review 阶段要自动校验
  acceptance_criteria jsonb NOT NULL DEFAULT '[]',

  -- 字段级溯源与人工修改标记（8.2 原文对照）
  field_provenance  jsonb NOT NULL DEFAULT '{}',
  -- { "title": { "source": "raw_input", "span": [0,24], "edited_by_human": false } }

  completeness      jsonb NOT NULL DEFAULT '{}',   -- 8.2.3 六维评分
  priority          text NOT NULL DEFAULT 'medium',
  due_at            timestamptz,

  approved_by       uuid,
  approved_at       timestamptz,
  reject_reason     text,

  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- 澄清问题（8.2.4 四级分类）
CREATE TYPE clarification_level AS ENUM (
  'must_confirm',        -- 🔴 必须人类确认，阻断
  'default_applicable',  -- 🟡 可用默认规则
  'assumption_ok',       -- 🔵 记录假设后继续
  'auto_resolved'        -- 🟢 知识库自动解决
);

CREATE TABLE requirement_clarifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id  uuid NOT NULL REFERENCES requirements(id),
  level           clarification_level NOT NULL,
  question        text NOT NULL,
  impact          text,                 -- "不回答会怎样"
  agent_suggestion text,                -- Agent 倾向
  suggestion_basis text,                -- 倾向依据
  options         jsonb DEFAULT '[]',   -- 快捷选项
  answer          text,
  answered_by     uuid,
  answered_at     timestamptz,
  resolved_source text,                 -- auto_resolved 时的知识来源
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 已确认假设：会传递给 Project Agent 与所有执行 Agent
CREATE TABLE requirement_assumptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id  uuid NOT NULL REFERENCES requirements(id),
  statement       text NOT NULL,
  origin          text NOT NULL,        -- clarification | agent_inferred | human_added
  confirmed_by    uuid,                 -- NULL = 未经人类确认
  invalidated_at  timestamptz,          -- 执行中被证伪时标记
  invalidated_reason text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

**`requirement_assumptions.invalidated_at`** 支撑产品文档 8.8.4「发现需求冲突」→ 触发人类介入：执行阶段发现假设不成立时标记并生成决策。

**`field_provenance`** 支撑页面文档 03 的原文对照高亮。这是需求页建立信任的核心交互，数据必须在结构化时就记录，事后无法补。

---

## 5. Work Item（6.3）

### 5.0 编号与创建路径

**编号**：`<项目前缀>-<项目内序号>`（`ORD-19`）。前缀在 `projects.identifier`
（组织内唯一），序号由 `projects.work_item_seq` 原子自增分配
（`modules/work-item/numbering.ts`）。

★★ 它存在的理由是「能用嘴说出来」。只有 uuid 的时候，站会上没法念、
聊天里没法提、提交信息里写进去也没人认得——「那个订单导出的任务」是唯一的
指代方式，而一个项目里往往有三个叫这个的。

★ 用列 + 原子自增，不用 Postgres sequence：每个项目一条 sequence 意味着建项目
要 DDL，而 DDL 不能和业务事务一起回滚。`UPDATE … SET seq = seq + n RETURNING seq`
同样原子，并发下不跳号。**一次要 n 个**（计划分解一次建十几条），
循环分配会让别人的号插进中间，同一份计划出来的任务编号不连续，
读起来像是丢了几条。

★ 只存 `number`，不冗余整个 `ORD-19`：改了项目前缀之后冗余那份要批量刷，
漏刷的表现是同一个项目里两种前缀并存——比多一次 join 贵得多。

**两条创建路径**：

| 路径 | 入口 | 落地状态 | 门禁 |
| --- | --- | --- | --- |
| 计划分解 | `POST /requirements/:id/plans` → 批准 | `draft` → `ready` | `requirement.approve` + `plan.approve` |
| 手工创建 | `POST /projects/:id/work-items` | `draft`，需人放行 | `work_item.create` + 放行时 `plan.approve` |

★★ 手工创建**不绕过 Human Gate**。

在此之前工作项只能被生成出来，那条链是产品的核心（两道 Human Gate 都在上面），
但它同时让「随手记一个 bug」在系统里做不到——而那是任何任务系统最高频的动作。

补入口的同时不能把门禁一起补没了：手工建的任务如果建完就能派发，任何能建任务
的人都可以让 Agent 去做任意事情。所以手工建的一律停在 `draft`
（接口**不接受**调用方指定状态），从 `draft` 走到 `ready` 要 `plan.approve`——
门禁的粒度从「批一份计划」变成「批一个任务」，而不是没有门禁。

★ 判定放在 handler 而不是路由表：路由表看不到任务**当前**的状态，而
`changes_requested → ready`（返工重新开始）同样落在 ready 上，那一步的计划
早就批过了，再要一次批准权限会让每次返工都惊动 tech_lead。

★ 手工建的任务在 `type_data.origin = 'manual'` 留痕——审计时
「它是怎么来的」要答得上。

```sql
CREATE TYPE work_item_type AS ENUM (
  'requirement','feature','story','task','bug','research',
  'review','test','incident','decision','approval','release','knowledge'
);

CREATE TYPE work_item_status AS ENUM (
  -- Intake
  'draft','clarifying','awaiting_requirement_approval',
  -- Planning
  'planning','awaiting_plan_approval',
  -- Execution
  'ready','executing','blocked','failed',
  -- Review
  'reviewing','changes_requested','awaiting_decision',
  -- Release
  'waiting_for_release','releasing','released',
  -- Done
  'acceptance','done','cancelled'
);

CREATE TYPE risk_level AS ENUM ('low','medium','high','critical');

CREATE TABLE work_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  project_id      uuid NOT NULL REFERENCES projects(id),
  requirement_id  uuid REFERENCES requirements(id),
  plan_id         uuid REFERENCES plans(id),

  type            work_item_type NOT NULL,
  status          work_item_status NOT NULL DEFAULT 'draft',
  stage           text NOT NULL,          -- 冗余：由 status 映射，便于看板按列查询
  title           text NOT NULL,
  description     text,
  priority        smallint NOT NULL DEFAULT 2,   -- 0=P0 .. 3=P3
  risk_level      risk_level NOT NULL DEFAULT 'low',

  -- 层级：parent 指针 + path 便于子树查询
  parent_id       uuid REFERENCES work_items(id),
  path            ltree,                  -- 'root.backend.api'
  position        integer NOT NULL DEFAULT 0,

  -- ★ 责任人与执行主体分离（产品文档 8.3.4 支持"Agent 执行、人类审核"）
  owner_id        uuid,                   -- 人类负责人（问责）
  executor_type   actor_type,             -- 执行主体类型
  executor_id     uuid,                   -- 执行主体 ID

  planned_start   timestamptz,
  planned_end     timestamptz,
  actual_start    timestamptz,
  actual_end      timestamptz,
  estimated_hours numeric(6,2),

  estimated_cost  numeric(10,4),
  actual_cost     numeric(10,4) NOT NULL DEFAULT 0,

  -- 验收标准：从 requirement 继承或由 plan 生成
  acceptance_criteria jsonb NOT NULL DEFAULT '[]',
  -- [{ id, text, verification: 'auto'|'agent'|'human', status, evidence_ref, verified_at }]

  -- 人类附加约束（来自 Approve with Constraints）
  constraints     jsonb NOT NULL DEFAULT '[]',
  -- [{ type, value, enforcement: 'system'|'agent'|'manual', decision_id }]

  -- Human Gate 当前状态（页面文档 §5.1 八态）
  human_gate      text,
  human_gate_ref  uuid,                   -- 关联的 decision_id

  blocked_since   timestamptz,
  blocked_reason  text,
  blocked_detail  jsonb,

  type_data       jsonb NOT NULL DEFAULT '{}',   -- 类型特有字段
  external_refs   jsonb NOT NULL DEFAULT '[]',   -- [{ system, key, url }]

  version         integer NOT NULL DEFAULT 1,    -- 乐观锁
  deleted_at      timestamptz,
  merged_into     uuid REFERENCES work_items(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON work_items (project_id, stage, status) WHERE deleted_at IS NULL;
CREATE INDEX ON work_items (executor_type, executor_id, status) WHERE deleted_at IS NULL;
CREATE INDEX ON work_items (owner_id) WHERE deleted_at IS NULL;
CREATE INDEX ON work_items USING gist (path);
CREATE INDEX ON work_items (project_id, blocked_since) WHERE blocked_since IS NOT NULL;
```

### 5.1 依赖（6.3 依赖关系 / 8.6.2）

```sql
CREATE TYPE dependency_type AS ENUM (
  'finish_to_start',   -- FS：默认
  'start_to_start',    -- SS
  'artifact',          -- 产物依赖
  'decision',          -- 人类决策依赖
  'permission',        -- 权限依赖
  'external',          -- 外部系统依赖
  'data'               -- 数据准备依赖
);

CREATE TABLE work_item_dependencies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL,
  from_id       uuid NOT NULL REFERENCES work_items(id),  -- 前置
  to_id         uuid NOT NULL REFERENCES work_items(id),  -- 后置
  type          dependency_type NOT NULL DEFAULT 'finish_to_start',
  lag_minutes   integer NOT NULL DEFAULT 0,
  created_by_type actor_type NOT NULL,
  created_by_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_id, to_id, type),
  CHECK (from_id <> to_id)
);

CREATE INDEX ON work_item_dependencies (to_id);
CREATE INDEX ON work_item_dependencies (from_id);
```

**环检测**在应用层做（插入前用递归 CTE 检查），不用数据库约束——PostgreSQL 无法用约束表达无环图。

```sql
-- 检测从 to_id 是否能回到 from_id（若能，则新增该边会成环）
WITH RECURSIVE reachable AS (
  SELECT to_id AS node FROM work_item_dependencies WHERE from_id = $to_id
  UNION
  SELECT d.to_id FROM work_item_dependencies d
    JOIN reachable r ON d.from_id = r.node
)
SELECT EXISTS (SELECT 1 FROM reachable WHERE node = $from_id);
```

---

## 6. Plan（6.6）

```sql
CREATE TABLE plans (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id),
  requirement_id    uuid REFERENCES requirements(id),
  version           integer NOT NULL,
  status            text NOT NULL DEFAULT 'draft',
                    -- draft | awaiting_approval | approved | superseded | rejected

  scope             jsonb,
  phases            jsonb NOT NULL DEFAULT '[]',
  critical_path     uuid[] NOT NULL DEFAULT '{}',
  milestones        jsonb NOT NULL DEFAULT '[]',
  risks             jsonb NOT NULL DEFAULT '[]',
  release_plan      jsonb,
  rollback_plan     jsonb,

  estimated_hours   numeric(8,2),
  estimated_cost    numeric(10,2),
  estimated_end     date,

  -- ★ 批准前展示的"将自动发生的行为"，由 Policy 预演生成并快照
  auto_actions      jsonb NOT NULL DEFAULT '[]',
  human_gates       jsonb NOT NULL DEFAULT '[]',

  -- 生成元信息
  generated_by      uuid,              -- agent_id
  generation_run_id uuid,
  model             text,
  generation_cost   numeric(10,4),
  generation_ms     integer,

  approved_by       uuid[],            -- 支持双签
  approved_at       timestamptz,
  revision_feedback text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, requirement_id, version)
);
```

**`auto_actions` 必须快照存储**，不能每次展示时重新计算。理由：用户批准的是**当时那份清单**，如果 Policy 后来变了，追溯"他到底批准了什么"必须看快照。这是治理可追溯性的要求。

---

## 7. Agent（6.4）

```sql
CREATE TABLE agents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  name              text NOT NULL,
  type              text NOT NULL,      -- code | test | review | research | data | browser
  description       text,

  runtime_id        uuid NOT NULL REFERENCES agent_runtimes(id),
  runtime_ref       text NOT NULL,      -- 运行时内的标识
  model             text,

  skills            text[] NOT NULL DEFAULT '{}',
  applicable_types  work_item_type[] NOT NULL DEFAULT '{}',

  -- ★ 权限：独立配置，不继承任何人类用户
  allowed_tools     text[] NOT NULL DEFAULT '{}',
  denied_tools      text[] NOT NULL DEFAULT '{}',   -- 显式禁止，优先于 allowed
  resource_scopes   jsonb NOT NULL DEFAULT '[]',
  -- [{ kind: 'repo', ref: 'order-service', access: 'write' },
  --  { kind: 'env',  ref: 'production',    access: 'none'  }]

  -- 成本与限制
  max_concurrency   integer NOT NULL DEFAULT 3,
  timeout_seconds   integer NOT NULL DEFAULT 1800,
  cost_limit_per_run numeric(10,4),
  cost_limit_daily  numeric(10,2),
  retry_policy      jsonb NOT NULL DEFAULT '{"max_attempts":2,"backoff_seconds":[60,300]}',

  owner_id          uuid NOT NULL REFERENCES users(id),   -- 人类负责人，不可为空

  status            text NOT NULL DEFAULT 'active',  -- active | paused | offline | retired
  paused_reason     text,

  -- 冗余统计（由 analytics 定期回写，避免实时聚合）
  stats             jsonb NOT NULL DEFAULT '{}',
  -- { success_rate, first_pass_rate, takeover_rate, avg_cost, avg_duration_s, sample_size }

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_runtimes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  name            text NOT NULL,
  kind            text NOT NULL,   -- claude_code | mcp | http | codex | openhands | builtin
  endpoint        text,
  credential_ref  text,            -- 指向密钥管理，不存明文
  protocol_version text,
  capabilities    jsonb NOT NULL DEFAULT '{}',   -- 协议能力协商结果，见 06 文档
  status          text NOT NULL DEFAULT 'active',
  last_check_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 权限变更审计（10.5 要求）
CREATE TABLE agent_permission_changes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      uuid NOT NULL REFERENCES agents(id),
  changed_by    uuid NOT NULL REFERENCES users(id),
  direction     text NOT NULL,     -- tighten | loosen
  before        jsonb NOT NULL,
  after         jsonb NOT NULL,
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

**`denied_tools` 优先于 `allowed_tools`**：显式禁止不可被继承或模板覆盖。页面文档 08 要求界面上显式展示禁止项，数据模型必须支持。

**`owner_id NOT NULL`**：每个 Agent 必须有人类负责人。这不是可选项——出问题时的问责链条不能断。

---

## 8. Agent Run（8.5.3）

```sql
CREATE TYPE run_status AS ENUM (
  'queued','dispatching','running','paused',
  'completed','failed','timeout','terminated'
);

CREATE TABLE agent_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  project_id        uuid NOT NULL,
  work_item_id      uuid NOT NULL REFERENCES work_items(id),
  agent_id          uuid NOT NULL REFERENCES agents(id),
  attempt           integer NOT NULL DEFAULT 1,
  previous_run_id   uuid REFERENCES agent_runs(id),

  status            run_status NOT NULL DEFAULT 'queued',
  idempotency_key   text NOT NULL UNIQUE,   -- 防重复派发

  -- 输入快照（★ 排障与审计的核心）
  goal              text NOT NULL,
  input_context     jsonb NOT NULL DEFAULT '[]',
  -- [{ kind:'knowledge'|'file'|'previous_run'|'requirement', ref, tokens, used }]
  model             text,
  model_config      jsonb,
  tools_snapshot    text[],                 -- 派发时的工具集
  permission_snapshot jsonb,                -- ★ 派发时的权限快照

  -- 进度
  step_current      integer,
  step_total        integer,
  step_description  text,
  progress_note     text,                   -- Agent 自然语言进展摘要

  -- 计量
  tokens_input      bigint NOT NULL DEFAULT 0,
  tokens_output     bigint NOT NULL DEFAULT 0,
  tokens_cache_read bigint NOT NULL DEFAULT 0,
  cost              numeric(10,4) NOT NULL DEFAULT 0,
  tool_call_count   integer NOT NULL DEFAULT 0,

  -- 失败
  error_class       text,   -- 见 06 文档错误分类
  error_message     text,
  error_detail      jsonb,
  agent_self_report text,   -- ★ Agent 用自然语言解释为什么卡住

  started_at        timestamptz,
  ended_at          timestamptz,
  last_heartbeat_at timestamptz,
  timeout_at        timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON agent_runs (status, last_heartbeat_at)
  WHERE status IN ('running','dispatching');   -- 孤儿检测专用
CREATE INDEX ON agent_runs (work_item_id, attempt DESC);
CREATE INDEX ON agent_runs (agent_id, created_at DESC);
```

**`permission_snapshot`**：Agent 权限可能在 Run 之后被修改。审计回溯时必须知道执行当时的权限状态，页面文档 09 §5.4 明确要求展示。

**`agent_self_report`**：页面文档 09 §5.7 的关键设计——让 Agent 用人话解释失败原因，比堆栈有用得多。需要 Agent Protocol 支持，不支持的运行时此字段为空。

### 8.1 Run 事件（高频，与领域事件分开）

```sql
CREATE TABLE run_events (
  run_id        uuid NOT NULL REFERENCES agent_runs(id),
  seq           integer NOT NULL,
  ts            timestamptz NOT NULL DEFAULT now(),
  type          text NOT NULL,
  -- run_started | context_loaded | tool_call | tool_result | reasoning
  -- | delegation | artifact | human_intervention | policy_check | error | run_ended
  level         text NOT NULL DEFAULT 'detail',   -- milestone | detail
  summary       text NOT NULL,                    -- 简明模式显示
  payload       jsonb,                            -- 详细模式显示
  cost_delta    numeric(10,6),
  PRIMARY KEY (run_id, seq)
) PARTITION BY RANGE (ts);
```

`level` 字段直接支撑页面文档 09 的「简明 ⇄ 详细」切换：简明模式只查 `level='milestone'`。

---

## 9. Decision（6.7）

```sql
CREATE TYPE decision_status AS ENUM (
  'pending','approved','rejected','revision_requested',
  'delegated','taken_over','expired','cancelled'
);

CREATE TABLE decisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  project_id        uuid NOT NULL REFERENCES projects(id),
  work_item_id      uuid REFERENCES work_items(id),
  run_id            uuid REFERENCES agent_runs(id),

  type              text NOT NULL,
  -- requirement_approval | plan_approval | high_risk_operation | release_approval
  -- | budget_overrun | scope_change | conflict_arbitration | agent_failure
  status            decision_status NOT NULL DEFAULT 'pending',
  risk_level        risk_level NOT NULL,
  reversible        boolean NOT NULL DEFAULT true,

  title             text NOT NULL,
  background        text,
  why_human         text NOT NULL,        -- 为什么需要人决定
  consequence       text,                 -- ★ 不处理会怎样
  impact            jsonb NOT NULL DEFAULT '{}',
  -- { blocked_tasks: 5, critical_path_delay_hours: 8.2, projected_delay_days: 1 }

  -- 触发来源
  triggered_by_policy uuid REFERENCES policies(id),
  policy_trace      jsonb,                -- 完整评估轨迹，页面要展示

  -- 责任
  assignee_id       uuid REFERENCES users(id),
  assignee_role     text,                 -- 按角色解析时记录原始角色
  delegated_from    uuid,
  requires_cosign   boolean NOT NULL DEFAULT false,

  due_at            timestamptz,
  escalation_level  smallint NOT NULL DEFAULT 0,   -- 0/1/2/3 对应产品文档十一
  escalated_at      timestamptz,
  reminded_at       timestamptz,          -- 催办冷却

  -- 结果
  selected_option_id uuid,
  resolution_note   text,
  resolved_by       uuid,
  resolved_at       timestamptz,
  applied_constraints jsonb NOT NULL DEFAULT '[]',

  -- 结果回填（用于 11 页"历史类似决策"的"结果如何"）
  outcome           text,                 -- succeeded | failed | rolled_back
  outcome_note      text,
  outcome_at        timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON decisions (assignee_id, status, due_at) WHERE status = 'pending';
CREATE INDEX ON decisions (project_id, status);
CREATE INDEX ON decisions (type, status, created_at DESC);  -- 重复决策检测

CREATE TABLE decision_options (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id   uuid NOT NULL REFERENCES decisions(id),
  name          text NOT NULL,
  description   text,
  is_recommended boolean NOT NULL DEFAULT false,
  confidence    numeric(4,3),             -- 0.000–1.000
  rationale     text,
  uncertainties text[],                   -- ★ Agent 说明自己哪里没把握
  attributes    jsonb NOT NULL DEFAULT '{}',  -- 对比表的维度值
  reversible    boolean,
  position      smallint NOT NULL DEFAULT 0
);

CREATE TABLE decision_approvals (           -- 会签
  decision_id   uuid NOT NULL REFERENCES decisions(id),
  approver_id   uuid NOT NULL REFERENCES users(id),
  status        text NOT NULL DEFAULT 'pending',
  opinion       text,
  decided_at    timestamptz,
  PRIMARY KEY (decision_id, approver_id)
);

CREATE TABLE decision_evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id   uuid NOT NULL REFERENCES decisions(id),
  kind          text NOT NULL,     -- artifact | external_link | metric | report
  title         text NOT NULL,
  ref           text,
  produced_by_type actor_type,
  produced_by_id uuid,
  is_live       boolean NOT NULL DEFAULT false,   -- 实时数据（如监控面板）
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

**`outcome` 字段是最容易被漏掉但价值最高的**：页面文档 11 §5.7「历史类似决策」的核心价值在于展示"当时怎么决的、结果如何"。这个字段需要在关联任务完成/失败/回滚时自动回填。

---

## 10. Artifact（6.8）

```sql
CREATE TABLE artifacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  project_id    uuid NOT NULL,
  work_item_id  uuid REFERENCES work_items(id),
  run_id        uuid REFERENCES agent_runs(id),

  kind          text NOT NULL,
  -- code | pull_request | test_report | document | design | data_analysis
  -- | screenshot | deployment | release_note | meeting_notes
  title         text NOT NULL,
  storage       text NOT NULL,     -- external | s3 | inline
  external_url  text,
  storage_key   text,
  content       text,              -- storage='inline' 时
  metadata      jsonb NOT NULL DEFAULT '{}',
  -- PR: { repo, number, branch, additions, deletions, ci_status, review_status }

  produced_by_type actor_type NOT NULL,
  produced_by_id uuid,
  from_incomplete_run boolean NOT NULL DEFAULT false,  -- 来自被终止的 Run

  created_at    timestamptz NOT NULL DEFAULT now()
);
```

---

## 11. Policy（6.10）

```sql
CREATE TABLE policies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  project_id    uuid REFERENCES projects(id),   -- NULL = 组织级
  name          text NOT NULL,
  description   text,
  priority      integer NOT NULL,               -- 越小越先匹配
  enabled       boolean NOT NULL DEFAULT true,

  condition     jsonb NOT NULL,   -- 条件 AST，见 05 文档
  action        jsonb NOT NULL,   -- 动作，见 05 文档

  -- 统计（analytics 回写）
  hit_count_30d integer NOT NULL DEFAULT 0,
  avg_wait_seconds integer,

  created_by    uuid NOT NULL,
  disabled_by   uuid,
  disabled_reason text,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON policies (org_id, project_id, priority) WHERE enabled;

CREATE TABLE policy_versions (       -- 变更历史，审计要求
  policy_id     uuid NOT NULL REFERENCES policies(id),
  version       integer NOT NULL,
  snapshot      jsonb NOT NULL,
  changed_by    uuid NOT NULL,
  direction     text,                -- tighten | loosen | neutral
  simulation_id uuid,                -- 放宽类变更必须关联模拟结果
  changed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (policy_id, version)
);
```

---

## 12. Event（6.9）

事件表设计见 [03 事件模型](03-event-model.md)。此处只列结构：

```sql
CREATE TABLE events (
  id            bigserial,
  org_id        uuid NOT NULL,
  project_id    uuid,
  type          text NOT NULL,
  level         text NOT NULL DEFAULT 'milestone',

  actor_type    actor_type NOT NULL,
  actor_id      uuid,
  subject_type  text NOT NULL,
  subject_id    uuid NOT NULL,

  payload       jsonb NOT NULL DEFAULT '{}',
  context_snapshot jsonb,        -- ★ Policy 模拟回放所需

  causation_id  bigint,          -- 直接原因事件
  correlation_id uuid,           -- 同一业务流程

  occurred_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
```

---

## 13. 集成（第九章）

```sql
CREATE TABLE integrations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  project_id    uuid REFERENCES projects(id),   -- NULL = 组织级连接
  provider      text NOT NULL,   -- github | jira | plane | slack | feishu | ...
  status        text NOT NULL DEFAULT 'active',
  config        jsonb NOT NULL DEFAULT '{}',
  credential_ref text NOT NULL,                 -- 指向密钥管理
  scopes        text[] NOT NULL DEFAULT '{}',
  last_sync_at  timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ★ Source of Truth 按字段配置（产品文档 9.1 明确要求）
CREATE TABLE sync_mappings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id  uuid NOT NULL REFERENCES integrations(id),
  entity_type     text NOT NULL,     -- work_item | requirement
  field           text NOT NULL,     -- status | assignee | due_at | comments | ...
  source_of_truth text NOT NULL,     -- apos | external | merge
  conflict_strategy text NOT NULL DEFAULT 'record',  -- overwrite | record | accept_notify
  UNIQUE (integration_id, entity_type, field)
);

CREATE TABLE sync_links (         -- 本地对象 ↔ 外部对象
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id  uuid NOT NULL,
  entity_type     text NOT NULL,
  entity_id       uuid NOT NULL,
  external_key    text NOT NULL,
  external_url    text,
  last_pushed_at  timestamptz,
  last_pulled_at  timestamptz,
  UNIQUE (integration_id, entity_type, entity_id),
  UNIQUE (integration_id, external_key)
);

CREATE TABLE sync_conflicts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id  uuid NOT NULL,
  entity_type     text NOT NULL,
  entity_id       uuid NOT NULL,
  field           text NOT NULL,
  local_value     jsonb,
  local_changed_at timestamptz,
  local_changed_by jsonb,        -- { actor_type, actor_id, name }
  remote_value    jsonb,
  remote_changed_at timestamptz,
  remote_changed_by text,
  status          text NOT NULL DEFAULT 'open',
  resolved_winner text,
  resolved_by     uuid,
  resolved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

**防同步循环**：所有由同步产生的写入，在 `events.payload` 中带 `origin: 'sync:{integration_id}'`。同步器出站时跳过 origin 为自身的变更。

---

## 14. 实体关系总览

```
organizations
 ├── users ─────────────────┐
 ├── agents ────────────┐   │
 │    └── agent_runs ───┼───┼──▶ run_events
 ├── agent_runtimes     │   │
 └── projects           │   │
      ├── project_members ──┘   （actor: human | agent）
      ├── requirements
      │    ├── requirement_clarifications
      │    └── requirement_assumptions
      ├── plans ──────────▶ work_items
      ├── work_items ◀────┬─ work_item_dependencies
      │    ├── artifacts ─┘
      │    └── decisions
      │         ├── decision_options
      │         ├── decision_approvals
      │         └── decision_evidence
      ├── policies ── policy_versions
      ├── integrations
      │    ├── sync_mappings
      │    ├── sync_links
      │    └── sync_conflicts
      └── events  （引用一切，被一切引用，但不加外键）
```

---

## 15. 索引与性能要点

| 查询场景 | 索引 |
| --- | --- |
| 看板按列加载 | `work_items (project_id, stage, status) WHERE deleted_at IS NULL` |
| 我的决策队列 | `decisions (assignee_id, status, due_at) WHERE status='pending'` |
| Agent 队列 | `work_items (executor_type, executor_id, status)` |
| 孤儿 Run 检测 | `agent_runs (status, last_heartbeat_at) WHERE status IN (...)` |
| 阻塞扫描 | `work_items (project_id, blocked_since) WHERE blocked_since IS NOT NULL` |
| 事件时间线 | `events (subject_type, subject_id, occurred_at DESC)` |
| 重复决策检测 | `decisions (type, status, created_at DESC)` |
| 依赖遍历 | `work_item_dependencies (to_id)` / `(from_id)` |
| 子树查询 | `work_items USING gist (path)` |

**分区**：`events` 与 `run_events` 按月分区。其余表 MVP 阶段不分区。

**冗余字段与对账**：`projects.cost_spent`、`agents.stats`、`work_items.stage` 是冗余的。每日跑对账任务校验并纠偏，差异记日志——冗余字段的正确性靠对账保证，不靠代码纪律。

---

## 16. 待确认问题

1. **`work_items.path` 用 ltree 还是闭包表？** ltree 更简单但重新挂载父节点需要更新整棵子树的 path。考虑到 Project Agent 会动态调整任务拆解（8.3.2），移动操作可能不罕见。建议先用 ltree，若移动频繁再换闭包表。
2. **Decision 与 Work Item 的关系**：本文档把 Decision 建为独立表，Work Item 中的 `decision` 类型作为占位。需要确认这个占位是否真的必要——它让依赖图能表达"等待决策"，但也带来两处数据同步。
3. **`acceptance_criteria` 存在 requirement 还是 work_item？** 目前两处都有（work_item 从 requirement 继承）。需要确认继承后是否允许分别演化，以及需求变更时如何处理已通过的验收项。
4. **多租户隔离级别**：RLS 还是应用层过滤？RLS 更安全但调试困难且对连接池有要求。建议 MVP 用应用层强制 + RLS 作为第二道防线。
5. **`events` 的 `context_snapshot` 存多少？** 存全了表膨胀快，存少了 Policy 模拟不准。需要根据 [05](05-policy-engine.md) 定义的 fact 清单精确确定字段范围。
6. **Knowledge 相关表**未在本文档定义（MVP 不实现）。引入时需要考虑是否走独立服务与独立存储（可能需要向量库）。
