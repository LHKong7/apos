# 09 身份、权限与安全

*[English version / 英文版本](09-security.md)*

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

### 1.0 人类凭证与账号来源

人类身份走**邮箱 + 口令 → JWT**：`POST /api/v1/auth/login` 换一张令牌，
之后每个请求带 `Authorization: Bearer <token>`。实现在
`apps/api/src/modules/auth/`。

> **在此之前身份是一个 `X-User-Id` 头**——没有任何凭证，写上谁的 uuid 就是谁。
> 下面整套四层判定都建立在它之上，因此也全都是摆设。更麻烦的是，
> 这件事从接口清单上完全看不出来：每条路由都在认真地判角色、判成员关系，
> 只是那个"谁"是调用方自己填的。

| 环节 | 做法 | 为什么 |
| --- | --- | --- |
| 口令存储 | scrypt，参数与盐一起写进 `scrypt$N$r$p$salt$hash` | 散列参数迟早要调。写死在代码里的话，调参那天全库口令一次性作废——没人知道旧的那批用的什么参数 |
| 口令比对 | `timingSafeEqual` | 字符串 `===` 在第一个不同字节短路，耗时差异足以把散列逐位试出来 |
| 登录失败 | 账号不存在 / 没有口令 / 口令错误**回同一句话，且耗时相同** | 区分开来的每一种都是「哪个邮箱是真账号」的枚举探针，而那是撞库的第一步 |
| 令牌算法 | HS256，`verify` 只认字面量 `HS256` | `alg: none` 是 JWT 最经典的绕过方式，根因永远是「库愿意接受另一种 alg」 |
| 令牌有效期 | 默认 12 小时，无状态 | 不做撤销（要引会话表或黑名单）。代价是改口令、停用账号都要等它自然过期，所以 TTL 不能长 |
| SSE 的令牌 | query 参数 `access_token` | EventSource 带不了自定义头（同一页的 Last-Event-ID 也是因此走 query）。代价是令牌进 access log，靠短 TTL 缓解 |

**账号只有三个来源，没有第四个：**

1. **超级管理员**——来自 `.env`（`APOS_SUPERADMIN_EMAIL` / `_PASSWORD`），
   启动时幂等自举（`modules/auth/bootstrap.ts`）。
   `.env` 里那个口令是**初始**口令，只在建号那一次用——每次启动都按 `.env`
   重置的话，它就成了一个改不掉的后门。
2. **组织管理员开的号**——`POST /api/v1/admin/users`，权限
   `organization.members.manage`。

   > ★ 建号与加入组织在**同一个事务**里。分开的话，第二步失败会留下一个
   > 「存在但不属于任何组织」的账号：他能登录，但登录后每个请求都是 401
   > （`resolveCurrentOrg`），而管理员那边看到的是「加成员时说没有这个邮箱」——
   > 他其实建成了。
3. **自助注册**——`POST /api/v1/auth/register`，无需身份，
   由 `APOS_ALLOW_SIGNUP` 控制，**默认开启**。

#### 自助注册为什么不破坏多租户边界

组织边界就是多租户边界（§2.1.2）。这里要防的是**自助进入已有组织**——
那等于任何人都可以把自己放进别人的边界里。

注册干的不是那件事：**每次注册都新开一个空组织**，注册者是**那个组织**的
`org_admin`。谁也进不到别人的边界里。要进别人的组织，仍然只有一条路——
被那个组织的管理员加进去。这条线由 `auth.test.ts`「★ 新注册的人看不到别人的
组织与项目」守着。

> **这个系统里没有跨租户的全局超管。** `users` 表上没有任何全局角色列，
> 一切权限都来自 `organization_members` / `project_members`。启动时那个
> 「超级管理员」之所以叫超管，只是因为他是第一个人、并且自动拥有了一个
> 属于自己的组织——他同样看不到别人的组织。所以注册与 bootstrap 做的是
> 同一件事，只是触发方式从 `.env` 变成了表单。

三件必须记住的取舍：

| 取舍 | 为什么 |
| --- | --- |
| 建号与建组织在**同一个事务**里 | 分开的话第二步失败会留下「能登录但不属于任何组织」的账号：他之后每个请求都是 401，而注册页显示的是「注册失败」，于是他换个邮箱再注册一次 |
| 注册**明说**邮箱被占用 | 登录接口刻意不区分「邮箱不存在」和「口令错」（那是枚举探针），注册做不到同样的克制——不告诉用户邮箱被占用，他就没有任何办法完成注册。这是这类接口固有的取舍，缓解手段是限流 |
| 先算口令散列再查库 | 反过来的话，「邮箱是否存在」会在昂贵的 scrypt 之前返回，响应耗时本身就把它泄漏了 |

#### 总开关 `APOS_ALLOW_SIGNUP`

默认**开着**——不配这个变量的实例可以自助注册。绝大多数部署（自己用、演示、
小团队）要的就是「装上就能注册」；要关掉它的那类部署本来就在写部署配置。

> ★ **认不出来的取值一律按「关闭」处理**，并在启动日志里说明原因。
> 这是安全开关，两种失败方式代价差得很远：写成 `flase` 却当成开，是运维
> 明明想关、结果一直开着且毫无迹象；写成 `ture` 却当成关，表现是「注册按钮
> 不见了」，有人会当场报上来。宁可错在关上。
> 可用取值：`1/true/yes/on/enabled` 与 `0/false/no/off/disabled`。

关掉时 `POST /auth/register` 回 **403**（不是 404）——这条路存在，只是这个
实例把它关了；回 404 会让排查的人去怀疑版本、路由、反向代理，而真正的原因
是一行环境变量。

前端靠 `GET /api/v1/auth/config`（无需身份，只回 `{ allowSignup }`）决定
要不要显示「注册」页签。**不能烤进构建**：同一份前端产物会被不同实例托管
（`http/web-app.ts` 把它挂在 API 进程里），烤进去的话，一个开着注册、
一个关着的两套部署就得出两份产物。

**限流（`modules/auth/throttle.ts`）**：注册是未鉴权的，每次调用跑一遍 scrypt
并写四张表，没有闸的话几十个并发就能把 CPU 打满——一个写错的脚本就够了。
按 IP、10 分钟 10 次。

> ⚠ 那是**进程内**的粗闸，多副本部署时真实上限是它乘以副本数。它挡的是
> 「一个客户端猛打」，不是有组织的分布式滥用——那一层该在入口
> （nginx / 云 WAF）做。写在代码里是因为「服务本身至少不能一戳就倒」，
> 不是因为它够用。


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

Run 级令牌随任务派发下发（[06 Agent Protocol](06-agent-protocol.zh.md) §4）。Run 结束立即失效。这样即使令牌泄漏，影响也限于单次执行。

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

### 2.1.1 ①② 层的实现位置

①② 在 `apps/api/src/http/routes.ts` 的**同一个 `preHandler` 钩子**里统一落地
（判定逻辑在 `apps/api/src/http/rbac.ts`，规则本身在 `packages/domain/src/rbac/`），
不在各个 handler 里分别写：

```
preHandler → 解析身份（Authorization: Bearer 里的 JWT，§1.0）
           → ② 成员关系闸门（非成员 404）
           → ① 权限矩阵（角色不够 403）
```

**② 项目成员**按 URL 形状拦截：

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

**同组织的 `org_admin` 即使不是成员也放行**（§2.2「全部权限」），
但**跨组织不行**——管理员的「全部」以组织为界，越界就是多租户隔离失效。

**① 权限矩阵**由每条路由**自己声明**（`config.auth`）：

```ts
app.post(
  '/api/v1/plans/:id/approve',
  { config: { auth: { permission: 'plan.approve' } } },
  handler,
);
```

这里不能照搬②层「按 URL 形状拦截」的办法：
「批准计划要 `tech_lead`」推不出 URL 形状，只能一条条写。

于是改用另一个保证：**写路由漏声明，服务起不来**。
`guardRouteCoverage` 在注册路由时清点，任何 `POST/PUT/PATCH/DELETE`
既没声明 `config.auth.permission`、也不在豁免清单里，`buildApp` 直接抛错。

声明贴着路由而不是集中成一张表，是因为集中表挡得住「忘了加」（启动即失败），
挡不住**「加错了」**：把隔壁那条路由的权限抄过来，在一千行外的表里
和在 handler 旁边，是两种可读性。

**但作用域不跟着挪**。②层的项目 / 资源作用域仍然从 URL 形状推断 ——
URL 形状**忘不掉**，而声明可以忘，且读路由没有启动检查兜底。
把作用域也改成声明式，等于把一条不依赖人记性的防线换成依赖人记性的。

路由 → 权限的全景对照表保留在 `rbac.test.ts` 里，作为**断言**而不是
运行时的第二个真相：它钉住每一条的取值，改动某条路由的权限时
必须连它一起改 —— 那本来就该是一次明确的决定。
豁免必须写明理由（目前七条：健康探针、Agent 回调、开发用 webhook sink、
建组织、登录、自助注册、改自己的口令），理由会出现在错误信息里。

> 登录（`POST /api/v1/auth/login`）在豁免清单里是必然的：它**就是**身份的来源，
> 要求「先登录才能登录」不成立。改口令（`/auth/password`）的作用域是
> 调用者自己，与组织角色无关，当前口令在 handler 里验。

跨项目的批量接口（`/decisions/batch-approve`）用 `deferred('理由')` 标记：
一次提交的十条决策可能属于十个项目，URL 上一个都看不出来，
只能在 handler 里按每条各自的归属逐条判。这是唯一合法的例外形态，
且同样要求写出理由。

**判定规则本身在 `packages/domain/src/rbac/`，前后端共用**：
前端用 `GET /api/v1/projects/{id}/permissions` 一次拿全权限与拒绝理由，
据此灰按钮并显示「该找谁」。灰按钮不是权限——服务端仍然独立判一遍。

#### 2.1.2 「当前是哪个组织」

账号与组织是**多对多**（`organization_members`，见 02-domain-model §2.1），
所以四层判定的第①层需要先知道「这次请求属于哪个组织」。答案由 `X-Org-Id`
头显式带上，解析在 `rbac.ts` 的 `resolveCurrentOrg`：

| 情况 | 行为 | 理由 |
| --- | --- | --- |
| 没带头 | 回落到确定的缺省（按加入时间第一个），并把 `currentOrgId` 回给调用方 | 报错的表现是整个站点白屏；前端猜缺省值会导致「显示 A、数据来自 B」 |
| 带了但不是成员 | **404**，不是 403 | 403 等于确认这个组织存在，把 id 变成可枚举的探针 |
| 一个组织都不属于 | 401 并说明要先建/加入一个组织 | 这时任何操作都没有作用域 |

★★ URL 里带组织 id 的写路由必须校验它就是**当前**组织
（`assertCurrentOrg`）。权限判定拿的是当前组织的 orgRole，handler 如果照着
URL 去改另一个组织，那次判定就白判了——在自己是管理员的 A 组织里发一个指向
B 组织的请求，就能拿 A 的管理员身份去改 B。这是最典型的一类越权。

★ `POST /api/v1/organizations`（建组织）在豁免清单里：这一刻还不存在
「在哪个组织里」，第①层没有输入。它的门槛只有「是不是一个登录账号」。

### 2.2 角色定义

**角色是数据，不是枚举。** 下面这几个是每个组织建立时预置的**内置角色**，
组织可以在它们之外自定义（研发、运营、测试、安全、数据…），见 §2.2.1。

| 角色 | 层级 | 关键权限 | 谁能担任 |
| --- | --- | --- | --- |
| `org_admin` | 组织 | 全部；身份管理、定义角色、组织级 Policy、模型接入、审计查看 | 人 |
| `sponsor` | 项目 | 需求确认、预算超限审批、业务验收、结项 | 人 |
| `tech_lead` | 项目 | 计划批准、架构决策、Agent 权限调整、Policy 配置、强制放行 | 人 |
| `pm` | 项目 | 项目设置、收紧 Policy、调度调整、成员管理 | 人 |
| `member` | 项目 | 执行任务、接管 Agent、处理决策、重试 | 人 |
| `executor` | 项目 | **只执行任务，不参与任何决策与审批** | 人 / **Agent** |
| `agent_owner` | 资源 | 所属 Agent 的配置（跨项目） | 人 |
| `viewer` | 项目 | 只读 | 人 / Agent |

内置角色的权限集合由**权限目录反推**（`packages/domain/src/rbac/roles.ts` 的
`BUILTIN_ROLE_PERMISSIONS`），不手写第二份 —— 手写反向表意味着改矩阵时要记得同步，
而漏同步的表现是「矩阵里写着 pm 能做，实际 pm 做不了」，没有任何报错。
服务启动时把库里的内置角色对齐到当前代码（`syncBuiltinRoles`），
库里那几行退化成一份缓存。

内置角色**不可修改也不可删除** —— 它们就是 §2.3 的权限矩阵本身。
每个组织都能改的话，「tech_lead 能批准计划」这句话在文档、审计、支持里
就失去了共同语义。要不一样，就自定义一个新角色。

#### 2.2.1 自定义角色

`org_admin` 可以定义组织自己的角色（`/api/v1/admin/roles`，
实现在 `apps/api/src/http/roles.ts`）。一个角色 = 一个名字 + 一组权限 +
**谁能担任**。三条限制，每一条都堵一条提权路径：

| 限制 | 堵掉的路径 |
| --- | --- |
| 不认识的权限名当场拒 | 「我明明给了他权限」的幽灵故障 —— 那条权限永远不生效 |
| **组织级权限不能下放** | 造一个「能创建角色的角色」发出去，拿到的人再造一个更宽的，一步走到组织管理员 |
| **`humanOnly` 权限不能进 Agent 角色** | 自定义一个叫「研发」的角色，把「改 Policy」塞进去，再指派给 Agent（§7.2 的绕法） |

#### 2.2.2 角色由人担任还是由 Agent 担任

这是本产品的基本形状：「测试」这个岗位上可能坐着一个人，也可能是
`test-agent-1`，还可能两者都有。所以 `project_members` 里人与 Agent 同表，
担任**同一套角色**，走同一个指派接口（`PUT /projects/{id}/members/{memberId}`
带 `actorType`）。

但 Agent 能担任的角色有硬边界：**带 `humanOnly` 权限的角色永远给不了 Agent**。
这些权限是「人类始终掌握目标、风险与最终决策权」这句话的全部落点：

- `requirement.approve` —— 产品的第一个 Human Gate
- `plan.approve` —— 批准计划 = 批准一批自动化行为
- `decision.act` —— 决策**就是**被升级给人的那些事；Agent 拿到它，Human Gate 会变成自问自答的环
- `policy.*` / `agent.permissions.*` / 成员与角色管理 —— §7.2

`appliesTo` 由这条规则算出下限（`assignableBy`），管理员可以在范围内再收窄
（「研发我们只给人」），但放不宽。指派时还会再判一次 ——
「把决策塞进研发角色」和「把研发角色指派给 Agent」是两次独立操作，
任何一次都可能是最后一步。

★ Agent 担任角色**不等于** Agent 继承人类权限（§1.2）。角色管的是
「能调哪些产品操作」，Agent 的工具与资源权限（§3.1 的 allowedTools /
deniedTools / resourceScopes）另在 Agent 档案里独立配置，两者不互相推导。

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
| 建任务（手工） | `work_item.create`（执行角色） | 一律落成 `draft`，不可派发 |
| **放行手工任务去执行** | `tech_lead`（`plan.approve`） | 见下 |
| 建组织 | 任何登录账号 | 创建者成为该组织的 `org_admin` |
| **开账号** | `org_admin`（`organization.members.manage`） | 审计（`user.created`）；账号进入系统的唯一入口，见 §1.0 |
| 改组织信息 / 成员归属 | `org_admin` | 审计 |
| 处理决策 | 该决策的责任人 | **不可代行**，见 §2.4 |
| 终止 Agent Run | `tech_lead` / `pm` / `agent_owner` | — |
| 查看 Run 详细模式 | `tech_lead` / `agent_owner` | 可能含敏感上下文 |
| 导出审计日志 | `org_admin` | 导出行为本身记审计 |

**不对称设计**：收紧权限比放宽权限要求低。收紧总是安全的，放宽需要更高门槛与额外证据（模拟结果、影响预演）。

★★ **手工建的任务不绕过 Human Gate。**

工作项原本只能由「需求 → 计划 → 批准 → 分解」生成，两道 Human Gate
（`requirement.approve` / `plan.approve`）都在那条链上。补上手工创建入口之后，
如果建完就能派发，那么任何能建任务的人都可以让 Agent 去做任意事情——
两道门就都被绕开了，而且绕开的方式在接口清单上完全看不出来。

所以手工建的任务一律停在 `draft`（接口**不接受**调用方指定状态），
`draft → ready` 这一步要 `plan.approve`。门禁的粒度从「批一份计划」变成
「批一个任务」，而不是没有门禁。

★ 这条判定在 handler 里（`routes.ts` 的状态路由）而不是路由表：路由表看不到
任务**当前**的状态，而 `changes_requested → ready`（返工重新开始）同样落在
ready 上，那一步的计划早就批过了，再要一次批准权限会让每次返工都惊动
tech_lead，而返工是执行者的日常动作。

#### 2.3.1 「这次改动算收紧还是放宽」怎么判

不对称设计只有在能**可靠区分**两个方向时才成立。判据在
`packages/domain/src/rbac/change-direction.ts`，两条都是**看结果不看写法**：

- **Policy**：把新旧规则集各在场景网格上跑一遍。只要存在一个场景从
  「要人确认」变成「自动放行」，整次改动就算放宽。
  比较两条规则谁更严会漏掉「插一条更高优先级的宽松规则把严格规则挡在后面」——
  规则本身没被改动，生效的却已经是新的那条。
- **Agent 权限**：白名单变长、`deniedTools` **变短**、资源 scope 升级，
  三者任一即为扩大。黑名单那条最容易判反：从里面拿掉一项是撤掉一条硬约束，
  按「列表变短 = 收紧」的直觉会判成收紧，于是 owner 就能自己把
  「绝对不能合并代码」这条撤了。

判定发生在路由层之后、副作用之前。路由表只挡掉「连收紧都不够格」的人；
方向算出来之后再判一次（`savePolicy` / `updateAgent` 的 `assertCan` 回调）。
**顺序不能反**：Policy 的模拟要扫 90 天历史评估，
放在权限判定之前等于让没资格放宽的人白跑一遍，
还把「哪些历史任务会被自动放行」送给了不该看到它的人。

#### 2.3.2 角色怎么改

- 定义角色：`/api/v1/admin/roles`（`org_admin`），见 §2.2.1
- 指派角色：`/api/v1/projects/{id}/members/{memberId}`（带 `project.members.manage` 的角色）
- 组织身份：`PATCH /api/v1/admin/users/{id}/org-role`（`org_admin`）

全部记审计（§6.3）。一套改不了的权限体系，实践中的结局是
「所有人共用一个账号」—— 因为换角色比换个人麻烦。三条防自伤的约束：

- 项目里至少留一个**带 `project.members.manage` 的人**，否则这个项目的权限
  只有组织管理员能修。★ 判据是权限不是角色名 —— 角色可自定义之后，
  「负责人」可能叫「运营主管」，按名字判会让这条保护静默失效；
- 组织里至少留一个 `org_admin`，否则再没有人能管身份、定义角色、看审计；
- 有人（或 Agent）正在担任的角色删不掉，也不能把 `appliesTo` 改窄到
  把他们排除在外 —— 否则会留下一批权限说不清算不算数的成员。

角色取值由**外键**保证（`project_members(org_id, role) → roles(org_id, key)`，
迁移 `0011_custom_roles`）。外键比 CHECK 强的地方不在写入侧而在删除侧：
它让「正在被人担任的角色」删不掉，而「角色被删了、成员权限静默归零」
正是最难查的那种故障。`users.org_role` 仍是 CHECK（组织角色不可自定义）。

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

### 3.0 语义能力（授权的说法）

**用户配置的是能力，不是工具名。** 这一层在 `packages/contracts` 定义清单（`AGENT_CAPABILITIES`），在 `packages/domain/src/capabilities/` 定义解释、档案与求值。

在它出现之前，「这个 Agent 能干什么」只能用运行时的工具名表达（`Read` / `Edit` / `Bash`），代价有三条，最后一条是致命的：

1. 用户被迫先懂某个 CLI。「要让它能跑测试」的正确答案是 `Bash(npm test:*)`，而这件事没有任何地方写着。
2. 换运行时等于重配一遍 —— `Edit` 在 Codex 那边根本不存在。
3. **`repo:write` 一个词同时表示三件风险差两个数量级的事**：在隔离工作区里改文件、把分支推到远端、把改动合进主干。授权界面上它们长得一模一样，于是「让 Agent 能改代码」顺手把「让 Agent 能合并代码」也授了出去。

能力目录把第三条拆开：

```
workspace.write     在隔离工作区里改文件，改动不会自己离开工作区
repository.push     把分支推到远端仓库
pull_request.merge  合进目标分支 —— 这一步之后没有任何人工复核
```

翻译成某个运行时的工具名是**适配器**的事（`CapabilityTranslator`）。适配器可以做不到，但不可以不说：翻译不出来的部分必须作为 `CapabilityDegradation` 返回并显示在界面上。一个「看起来限制住了、运行时其实不限制」的授权界面，比一个难用的授权界面糟得多。

### 3.0.1 能力档案：没配置 ≠ 没权限

```
No explicit configuration does not mean "no permissions".
It means "use the safe, useful default profile".
```

刚建出来的 Agent 权限为空数组（「什么都不能干」）的系统里，**真正的默认值是用户从别处抄来的那份配置**。所以进项目没指定档案时落到 `standard_executor`：能在隔离工作区里改代码、跑测试、交产物；不能推送、合并、部署、读凭证、改治理。判据是「后果出不出得了工作区」。

内置档案见 `packages/domain/src/capabilities/profiles.ts`。要更多能力必须是一次明确的、要写理由的决定。

**档案带版本，且展开结果落库**（`project_agent_permissions.allowed_capabilities`）。只存 `profileKey` 指针的话，平台哪天给 `standard_executor` 加一条能力，所有在跑的 Agent 会在没有任何人做过决定的情况下一起变宽 —— 这正是 §7 权限累积最典型的发生方式。档案出新版只在界面上提示，不自动升级。

### 3.0.2 项目级授权

权限挂在 `project_agent_permissions(project_id, agent_id)` 上，不是挂在 `agents` 上。

旧模型把 `allowedTools` / `resourceScopes` 挂在 Agent 自身，于是给某个项目放宽一次，全组织的项目跟着放宽；绕开它的唯一办法是同一份配置建两个 Agent —— 而那两个的凭证、预算、统计从此各算各的，「这把 key 被谁在用」也再答不上来。

数据库用一条**复合外键**保证「有权限记录的 Agent 一定是本项目成员」。放在应用层的话，先删成员再删权限之间有一个窗口，而那个窗口里的 Agent 拿着一份没人管的授权。

求值（`resolveEffectiveAgentAccess`）：

```
平台安全基线
  ∩ 组织给这个 Agent 的能力上限（agents.capability_ceiling）
  ∩ 项目里的能力授予（project_agent_permissions）
  ∩ 运行时真正做得到的
  + 项目资源范围
  = 不可变的 Run 权限快照
```

任一层的**显式拒绝永远压过允许**。能力上限那一层是多项目隔离的另一半：项目管理员能在自己项目里选档案，但选不出组织没打算给这个 Agent 的能力 —— 没有它，谁能建项目谁就能给任意 Agent 任意权限。

**一份求值器，四处调用**：调度器选候选、派发前冻结快照、界面显示生效权限、保存前的影响预览。分成两份实现的代价不是重复代码，是两个对不上的答案 —— 而它们只在分歧的那些输入上出现，正是没有人在看的地方。

### 3.0.3 组织级记录只保留「上限」

Agent 这一层现在只回答「这个 Agent **最多**能被授权到什么程度」：

| 留在 `agents` 上 | 移到 `project_agent_permissions` |
| --- | --- |
| 运行时配置与凭证、负责人 | 实际生效的能力 |
| `capability_ceiling`（NULL = 不设上限） | 资源范围 |
| `denied_capabilities`（组织级硬拒绝） | 选中的能力档案 |
| 模型、预算、并发、超时 | |

`allowed_tools` / `denied_tools` / `resource_scopes` 三列**已退役**：不再写入、不再读取。列留着不删，理由有两条，都不是「以防万一」——它们是迁移前那份配置的唯一记录（0031 的回填正是从这里反推的，删掉就再也无法核对推得对不对），而删列是不可回滚的 DDL。

> **NULL 与空数组含义相反。** `capability_ceiling` 为 NULL 是「不设上限」，空数组是「一条都不给」——后者会让这个 Agent 在所有项目里都干不了活。这个区别在类型上是显式的（`AgentCapability[] | null`），保存时也会被拦（给空清单直接报错，并说明「不设上限」该怎么写）。

### 3.1 三个维度（运行时层）

能力翻译之后落到的仍然是这三个维度，它们是**下发给运行时**的协议形态，不再是用户配置的形态：

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

**资源范围跟着能力收窄**：只读档案配上一条 `access:'write'` 的仓库范围是自相矛盾的两句话，而运行时只看得到后者。求值时让能力那一侧说了算。

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

**快照有两代，且永不迁移**。v1 只有上面那三个运行时字段；v2（`AgentPermissionSnapshot`）另外记下语义能力、档案键与版本、以及每条能力的出处。半年后翻审计的人问的是「它当时**被授权做什么**」，而工具名回答不了 —— 同一串 `['Read','Edit']` 在适配器改版前后不是一回事。历史快照原样保留：它们是当时那次执行的凭证，改写等于伪造证据。读取侧靠 `version` 分辨（缺省即 v1）。

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

**预览与保存必须共用同一个判定。** 两边各算一套的话，「保存前告诉你会发生什么」这个承诺就失效了，而它失效的方式最难发现：预览说「不会有变化」，保存之后权限变了，两条记录都各自自洽。项目级授权那条路径上，preview 与 save 的差别仅仅是「写不写库」。

### 3.4 受治理的变更：固定顺序

`apps/api/src/http/governed-mutation.ts` 把这条流水线固定下来：

```
读当前状态 → 判方向 → 授权 → 校验原因/模拟/双签 → 事务 → 审计
```

顺序不能换，这才是这个函数存在的理由（而不是代码复用）：

- **先判方向再授权**。不知道方向就不知道该判哪一条权限，于是各处实现只能挑一条，通常挑宽的那条（`agent.permissions.restrict`）—— §2.3 的不对称设计当场作废，一个只能收紧的人也能放宽。
- **原因/模拟/双签在事务之前**。放进事务里意味着一次本该被拒的放宽已经写进去过，靠回滚兜底。
- **审计在事务之后**。事务内发布会把一条随后被回滚的变更推给浏览器（与事件总线同一条约定）。

`PermissionSpec.governance` 在此之前是**描述性**的：目录里写着「这条要填原因」，而真正的判定散落在各 handler 里，写没写全靠自觉。现在目录说要，就一定要。

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

### 4.1 底线在哪儿

这九类里，**三类硬编码在求值器里**（`NEVER_AUTO_APPROVE`，[05 Policy Engine](05-policy-engine.zh.md) §3.2）：

删除资源 · 修改权限 · 执行付款

无论自治等级、无论项目规则怎么写，它们永远不会得到 `allow`。硬编码不是偷懒——一条能被配置绕过的底线不是底线。

**其余六类由用户自己配规则管住**。平台不替他配：一条都没配时，Policy 页的体检会把"这类操作现在走的是自治等级默认"如实说出来（`coverage_gap`），零规则的新项目还会先看到一份引导向导。

> **这一段曾经是十条硬编码的组织级基线 Policy**（`BASELINE_POLICIES`，优先级 1–20），无论库里有没有规则都参与求值、不可删也不可放宽。删掉的理由不是它们管得不对，是它们让"这个项目现在到底按什么规则跑"这个问题在界面上答不出来：用户看得见的规则列表和实际生效的规则不是同一份。而一份读不到全貌的治理配置，比配置得少更危险——它给的是虚假的安全感。现在**生效规则 = 库里用户录入的那些**，真正不能商量的那三类改由求值器直接兜住。

**测试保证**（[05](05-policy-engine.zh.md) §9）：穷举各种自治等级与对抗性项目规则组合，断言那三类操作永远不会得到 `allow`；再断言**拼错的取值同样绕不过它**——`operationType` 写成 `"delete_resrouce"` 时评估会停下来报错，而不是当成"改代码"放过去。两条都是 CI 中的阻断性测试。

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

### 5.4 代码仓库凭证（GitHub / GitLab / …）

登记在「Agent 配置 → 代码仓库」（`/api/v1/admin/repositories`，需 `repository.manage`）。
凭证三种形态（`modules/security/secrets.ts`）：

- `env:GITHUB_TOKEN` —— 库里只存变量名，明文只在进程环境。**生产首选**
- 直接粘贴 + 配了 `APOS_SECRET_KEY` —— AES-256-GCM 加密入库，钥匙在库外
- 直接粘贴 + 没配 `APOS_SECRET_KEY` —— 明文入库（`secret://plain/…`），本机开发与演示环境

★ 主密钥决定的是**存成什么样**，不是**能不能存**。此前没配主密钥时接口直接
拒绝一切粘贴进来的值；但 Agent 的运行时配置是一份用户自己写的 JSON，
键名带 `TOKEN` / `KEY` / `AUTH` 的值都会走同一条判定 —— 于是「配一下中转站」
变成了「先去改部署的环境变量再重启」。一个把常规配置挡在门外的安全措施，
换来的是用户绕开这一页。现在改为永远存得下，并在配置页上如实标注当前是哪一种
（`encryptsInlineSecrets`）。三种形态都带 `secret://` 前缀，因此
「接口永不回显」那条纪律对它们一视同仁。

Token 需要的权限就是 clone / fetch / push
（GitHub fine-grained PAT 给 Contents: Read and write 即可）——
平台不调 GitHub / GitLab 的 API。

#### 5.4.1 凭证用户名占位

HTTPS token 走 Basic 认证，用户名那一段各家要求不同：

| 服务 | 用户名占位 |
| --- | --- |
| GitHub / GHE | `x-access-token` |
| GitLab（含自建） | `oauth2` |
| Bitbucket | `x-token-auth` |

留空时按域名推断（`resolveAuthUsername`）：公有云域名与**首段标签是服务商名**
的自建实例（`gitlab.acme.com`）都认得出来；`git.acme.com` 认不出来
—— 底下可能是 Gitea、Gogs、GitLab、Bitbucket Server，猜错就是 401，
所以如实回落到默认值并在配置页上打警告，让人手填。

★ 这一项填错的表现是 401，而 401 的报错里没有任何东西指向它。
所以配置页会把**即将使用的占位值以及它的来源**（手填 / 按域名推断 / 兜底）
直接显示出来，探测失败时也会连同占位值一起说。

#### 5.4.2 SSH 私钥（`ssh://` 与 `git@` 形态）

同一个凭证字段，ssh 地址填的是**私钥全文**，两种形态共用
`env:` / 加密内联那套存储。登记时就会验形态（`inspectPrivateKey`）。

**★★ 私钥不落盘，走 ssh-agent。**

OpenSSH 的 `ssh -i` 只接受文件路径，所以「写个临时 key 文件」是最容易
想到的做法，但在这个平台上它不成立：容器里同时跑着别的 Run 的 Agent，
它们是**同一个 OS 用户**的进程，只要 key 在磁盘上，任何一个 Agent 的
Bash 工具都能 `cat` 到它 ——「跑之前写、跑完删」挡不住这一点，因为并发的
Run 里总有别人的 Agent 正在跑。这和 §5.4 已有的两条纪律是同一条：
token 不拼进 remote URL（`.git/config` 就在 Agent 的工作目录里），
不用 credential helper（要落盘）。私钥比 token 更值钱，标准不该更低。

所以：key 从 stdin 喂给 `ssh-add -`，只活在 agent 进程的内存里；
`SSH_AUTH_SOCK` 只进 **git 子进程**的环境（Agent 的运行时环境另外构造，
拿不到）；socket 在 0700 的临时目录里；agent 的生命周期严格包在
`withSshAgent` 里，`finally` 里 kill + 删目录。

**★★ 不支持带密码短语的私钥，且在保存那一刻就拒。**

无人值守场景没法输入密码，所以它注定用不了。放进库的话失败会推迟到
第一次派发，而且**不是报错**——是 `ssh-add` 挂在那里等密码，表现成
「任务一直在执行中」。运行时另外用 `SSH_ASKPASS_REQUIRE=never` 兜底，
保证任何漏网的情况也是当场失败而不是挂住。

**★★ 主机公钥 TOFU 之后固定。**

`repositories.ssh_known_hosts` 存主机公钥（明文——它本来就是要公开比对
的那一份）。为空时首次连接用 `accept-new`，**连上之后立刻把学到的公钥
写回库**，此后转 `StrictHostKeyChecking=yes`。

不固定的话 `accept-new` 等于 `no`：每次连接都是一个全新的临时
known_hosts，「未知主机」这个条件永远成立，于是每次都放行 ——
中间人换掉主机公钥也照连不误。TOFU 要成立，第一次学到的东西必须留下来。
任何时候都不用 `StrictHostKeyChecking=no`。管理员也可以用
`ssh-keyscan` 预先填好（更强），或清空以重新学习（服务器真换了密钥时）。

**★ 用 `IdentityAgent` + `IdentityFile=none` 限定身份，不能用 `IdentitiesOnly=yes`。**

`IdentitiesOnly` 的语义是「只用配置/命令行里指定的身份**文件**」，
它会把 agent 提供的身份一并排除掉 —— 而我们的 key 只存在于 agent 里。
加上它的表现是 `Permission denied (publickey)`：看起来像仓库没授权，
实际上 key 根本没被拿出来试过。

★ 没配私钥的 ssh 仓库仍然回退到宿主机的 `~/.ssh`（历史行为，部署在有
SSH 配置的机器上是合法用法），配置页会说明容器里通常没有这份配置。

#### 5.4.3 连通性探测

`POST /api/v1/admin/repositories/{id}/probe` 跑一次 `git ls-remote --heads`，
验三件事：域名通不通、凭证对不对、默认分支在不在。只读、不落盘、不建镜像。

★ 存在的理由是「配错了要在配置页上知道」。没有它，验证凭证的唯一办法
是派一个任务，然后看它以「准备工作区失败：… 401」告终 ——
那条报错分不清是 token 过期、scope 不够，还是用户名占位不对，
而这三种原因的下一步动作完全不同。

用 `ls-remote` 不用 `clone`：要验的三件事它全能答且是秒级，
而 clone 一个大仓库要几分钟 —— 贵到没人愿意点第二次的检查等于没有检查。

#### 5.4.4 质量核验命令

`checkCommand`（如 `pnpm test`）在 Agent 收工后、**提交之前**于工作区执行，
失败也照样提交（失败的改动同样需要被人看到）。

★★ 它是 reviewing 阶段唯一的**真实**测试数据源。不配的话，
`qualityGatePassed` 这道门禁只能依据「Agent 说它跑过测试了」——
那是一句自述，不是证据。所以未配置时配置页会把这句话直接说出来。

★ 它是在服务端 shell 里执行的任意命令，配置权限就是 `repository.manage`
（组织管理员），与登记仓库同一档 —— 能登记仓库的人本来就能让 Agent
往里写代码，不设更高的门槛没有意义。

---

## 6. 审计日志

产品文档 10.5 要求记录：操作者、身份类型、时间、输入、操作、目标资源、Policy 判断、审批记录、执行结果、失败原因、关联项目和任务。

### 6.1 实现

审计日志**不是独立系统**，而是 `events` 表的一个视图——因为事件模型（[03](03-event-model.zh.md)）已经记录了全部要素：

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

对应的事件类型见 `packages/contracts/src/events/index.ts` 的 `AUDIT_EVENTS`。
授权变更分两类：

- **谁担任什么角色**（subject 是被改的那个人 / Agent）：
  `project.member_added` / `project.member_role_changed` /
  `project.member_removed` / `user.org_role_changed`
- **角色本身是什么**（subject 是角色）：
  `role.created` / `role.updated` / `role.deleted`

**为什么这两类都要有**：§7 把「权限累积」列为本产品的特有威胁，
它的第一条缓解手段就是「权限变更全审计」。只记第一类的话，
「谁给研发这个角色加上了放宽规则的权限」查不到 ——
而逐个人翻授权记录也拼不出真相，每个人的记录都只会显示「他一直是研发」。

---

## 7. 威胁模型

针对这个产品的特有威胁：

| 威胁 | 场景 | 缓解 |
| --- | --- | --- |
| **Agent 越权** | Agent 调用未授权工具或访问越界资源 | 双重执行点（§3.2）+ 违规告警 + 自动暂停 |
| **提示注入** | 需求文档/代码注释/PR 描述中嵌入指令，诱导 Agent 越权 | 上下文与指令分离；工具调用侧的权限校验不依赖 Agent 判断；破坏性操作强制走 Policy |
| **成本攻击** | 恶意或错误配置导致 Agent 无限循环烧钱 | 单 Run 成本上限 + 项目预算硬阻断 + 异常增长检测 |
| **权限累积** | 逐次小幅放宽，最终 Agent 权限过大 | 权限变更全审计 + 定期权限审查报告 + 放宽需 `tech_lead` |
| **决策绕过** | 通过修改 Policy 让高风险操作自动化 | 三类操作的底线硬编码在求值器里（§4.1）+ 放宽需模拟 + Agent 不能改 Policy |
| **拼写绕过** | 用一个认不出来的 `operationType` 让安全底线匹配不上 | fact 取值按枚举严格解析，认不出即拒收，绝不兜底成近似值（§4.1） |
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
