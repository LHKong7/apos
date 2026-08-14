# 11 工作区抽象

Agent 干活的地方叫「工作区」。本文档说明它为什么不是「可替换的存储后端」，
而是「一个本地目录 + 两头可换」，以及这个形状带来的约束与收益。

代码位置：后端在 `packages/workspace-providers/`，数据库适配在
`apps/api/src/modules/workspace/`，契约在 `packages/contracts/src/workspace/`。

> 术语提醒：`workspace` 在本代码库里**只指 Agent 的工作区**。产品层的顶层
> 容器叫「组织」（`organizations`），不叫 workspace。两个都叫 workspace 的话，
> 「清理 workspace」这类句子会同时指向两件毫不相干的事（见 `schema/core.ts`
> 组织表上的注释）。

---

## 1. 出发点：Git 耦合到底错在哪

改造前 `WorkspaceProvisioner` 一个类管四件事：维护 Git 镜像、挂 worktree、
跑质量核验、提交推送。对外暴露的 `RunWorkspace` 类型是纯 Git 形状：

```ts
{ repoRef, path, branch, baseBranch, baseCommit, writable, additionalPaths }
```

问题不在于「将来可能要接对象存储」这种假设，而在于**第二个实现早就存在了**：

`planning/agent-provider.ts` 里，需求规划任务不需要任何仓库（它读需求原文、
写一份 JSON），于是它自己 `mkdir` 出一个空目录，再手工捏一个假的 Git 工作区
塞进派发：

```ts
workspace: { repoRef: 'planning', branch: 'planning', baseBranch: 'planning', ... }
```

代价是可见的：治理规则 prompt 会照着这些字段生成一句

> 「你在分支 planning 上工作，它基于 planning。不要切换分支、不要 commit……」

下发给 Agent。Agent 读到只会去找一个不存在的分支。

**所以抽象的依据不是猜测，是一个已经写出来、并且已经在产生错误行为的第二实现。**

---

## 2. 形状：本地目录 + 铺料 / 交货

平台派出去的是 headless CLI Agent（claude-code / codex / aider / goose /
opencode / qwen…）。它们无一例外要 `cd` 进一个目录再 `open()` 文件 ——
**本地 POSIX 目录这一点没有可替换性**。把它做成「后端之一」是把不变的东西
做成了变量。

真正可换的是两头：

```
                    ┌─────────────────────────────┐
   铺料             │   Workspace（本地目录）      │            交货
 materialize        │                             │          publish
 ──────────────────▶│  Agent 在这里 cd / open()   │──────────────────▶
                    │                             │
  git worktree      │   mounts: 主可写 + 若干只读  │   git commit + push
  空目录            │                             │   本地归档
  本地目录复制      │                             │   对象存储上传
  对象存储同步      └─────────────────────────────┘   不交货（NonePublisher）
```

两头**独立可选**。这是本设计与「一个 `WorkspaceProvider` 管到底」那类方案的
关键分歧：后者强制 1:1 绑定，表达不了「从 Git 拉代码、把生成的报告传对象存储」
这种最常见的组合。

### 2.1 核心类型

`packages/contracts/src/workspace/index.ts`：

| 类型 | 作用 |
| --- | --- |
| `SourceKind` | `'git' \| 'empty' \| 'local' \| 'object_storage'` |
| `SourceRef` | 内容从哪来：`{ kind, identifier, label, baseVersion }` |
| `Mount` | 一个挂载点：`{ path, role, writable, source }` |
| `Workspace` | `{ id, runId, root, mounts, writable }` |
| `ChangeSet` | `{ added, modified, deleted, total, truncated }` |
| `PublishResult` | 按 `kind` 收窄的可辨识联合 |
| `WorkspaceCheckResult` | 质量核验的执行记录 |

`identifier` 与 `label` 分开：前者是后端自己的寻址键（Git 用仓库 **id**，镜像
目录按它命名），后者是给人看的名字（仓库 ref）。仓库改名不该让本地对象库作废。

### 2.2 三个接口

```ts
interface SourceMaterializer {           // 铺料
  readonly kind: SourceKind;
  materialize(spec: MountSpec): Promise<Mount>;
  diff(mount: Mount): Promise<ChangeSet>;
  dispose(mount: Mount, opts?: { keep?: boolean }): Promise<void>;
}

interface Publisher {                    // 交货
  readonly kind: PublishResult['kind'];
  publish(ws: Workspace, changes: ChangeSet, ctx: ReleaseContext): Promise<PublishResult>;
  finalize?(ws: Workspace, result: PublishResult): Promise<void>;
}

// 后端无关的收尾流水线
runReleasePipeline(deps, ws, ctx, opts): Promise<ReleaseOutcome>
```

**`diff` 属于铺料方而不是交货方。** 只有铺料方知道基线是什么：Git 知道
`baseCommit`，空目录后端知道自己存过的文件清单快照，对象存储知道 ETag 清单。
交货方拿到的是算好的变更集，只负责送出去。这个分工正是两头能自由组合的原因。

---

## 3. 承重墙：`baseVersion` 与「基线 + 变更集」

这是整套抽象里最容易被做错的一处。

一个很自然的抽象写法是给每个后端一个 `scanArtifacts()`，遍历工作目录、
每个文件产一条产物记录。**这条路是错的**：

- 一个仓库检出有几万个文件，Agent 改了 3 个 —— 报出来的必须是那 3 个
- 一个 `npm install` 过的目录有几十万个文件
- 平台自己写进去的输入文件（任务书 `BRIEF.md`）会被当成「Agent 的产出」
- 靠硬编码 `IGNORED_DIRS = {node_modules, dist, ...}` 去补救，永远追不上现实
  （`.venv`、`target/`、`.next/`、`vendor/`…）

Git 版本之所以干净，正是因为它一直有基线：`status --porcelain` 报的是相对
`baseCommit` 的差异，不是目录清单。**抽象必须把这个概念抬上来。**

于是 `SourceRef.baseVersion` 是必填（可为 null，但语义是「这个后端明确没有基线」，
不是「忘了填」），每个后端各自负责怎么算：

| 后端 | 内容从哪来 | baseVersion | diff 怎么算 |
| --- | --- | --- | --- |
| `git` | 镜像 + worktree | commit sha | `git status --porcelain=v1 -z` |
| `empty` | 建一个空目录 | 文件清单快照的 hash | 重新扫描，与快照逐项对比 |
| `local` | 复制宿主机上一个已登记的目录 | 文件清单快照的 hash | 同上 |
| `object_storage` | 从 S3 兼容端点同步下来 | 本地清单 hash（另存一份 ETag 清单） | 重新扫本地目录，与快照对比 |

### 3.1 文件系统类后端的快照

`snapshot.ts`（`empty` / `local` / `object_storage` 三个后端共用）。
快照只记 `path → size:mtimeMs`，**不算内容 hash**：
一个几百 MB 的产出目录逐文件 sha256 会给每次收尾加上几十秒，而它买到的只是
「size 和 mtime 都没变但内容变了」这种情况下的准确性 —— 而 Agent 改文件必然
改 mtime。这笔账不划算。

三条防线：

1. **快照存在工作目录之外**（`{root}/state/{key}.json`）。放里面的话 Agent
   看得见它、可能顺手删掉，而且快照文件会出现在自己的 diff 里。
2. **超过 20000 个文件停下并标 `truncated`**，一路带到 `ChangeSet` 上。
   静默截断是最糟的处置：「基线不完整」会被读成「没有改动」。
3. **基线丢失时如实报告不可用，不猜**。返回空变更集 + `truncated: true`，
   而不是把整个目录报成新增 —— 后者正是上面那条错路。

### 3.2 `MountSpec.seed`：基线的时序

平台自己写进工作区的输入文件必须算进**基线**，否则它们会出现在变更集的
`added` 里。Git 那边天然没这个问题（基线就是 baseCommit），空目录后端必须把
时序显式表达出来：

```ts
materialize(spec) {
  await mkdir(spec.path);
  await spec.seed?.(spec.path);   // ★ 平台的输入文件先落盘
  const snapshot = await this.snapshot(spec.path);   // ★ 再记基线
}
```

规划任务的 `BRIEF.md` 走的就是这条路。

---

## 4. 收尾流水线：抽象的收益兑现处

`pipeline.ts`。顺序对所有后端都一样：

```
算变更集  →  跑质量核验  →  交货  →  回收挂载  →  交货方 finalize
 diff()      runCheck()    publish()   dispose()      finalize()
```

实现一次而不是让每个后端各写一遍，换来三件事：

1. **质量核验只有一份实现。** 它与铺料/交货后端**完全正交** —— 只是「在一个
   本地目录里跑一条命令」。它撑的是 reviewing 阶段唯一一处**非自述**的测试
   证据（`ingest.ts` 写进 `workItems.typeData.qualityGate`，`flow/review.ts`
   读 `testSource === 'workspace_check'`）。抄第二遍抄错了不会有人发现 ——
   核验失败与核验没跑在结果里长得很像。
2. **「核验跑在交货之前」这条时序约束只需保证一次。** 要测的是 Agent 留下的
   目录状态；而且不管核验成败都交货 ——「测试没过所以我把代码扔了」是最糟的处置。
3. **加一个后端 = 实现三个方法**，而不是把这段顺序连同它的每一个坑重新想一遍。

### 4.1 为什么 `Publisher.finalize` 是单独一个钩子

Git 交货成功后要删掉镜像里的本地分支（远端已有一份，不删就是按 Run 的速度
无上限堆积）。但 **git 拒绝删除一个正被工作树检出的分支** —— 所以这一步必须
排在 `dispose()` 之后。它跨在 publish 和 dispose 中间，塞进任何一方都不对。

---

## 5. 诚实性约定

几条刻意写进类型的约束：

| 约定 | 反面做法 | 为什么 |
| --- | --- | --- |
| `PublishResult` 是可辨识联合 | `metadata: Record<string, unknown>` | 用 unknown 换通用是抽象里最亏的买卖：消费方全部退化成不安全的字段读取，而这些字段本来是强类型的 |
| `NonePublisher` 永不报 `persisted: true` | 「本地即已发布」 | 目录收尾就回收，容器一回收更是什么都不剩。标成已发布只会让用户点开产物看到不存在的路径 |
| `ChangeSet.truncated` 与产物 metadata 的 `listTruncated` 分开 | 合成一个标记 | 「基线丢了」和「文件太多只记了前 200 个」严重程度不同 |
| 产物 metadata 记文件名列表 | 只记一个计数 | 评审时「改了哪些文件」比「改了 3 个文件」有用得多，而这个信息在算 diff 那一刻就在手上 |
| 认不出 host 就不给分支链接 | 编一个 URL | 点开 404 比没有链接更糟 |
| 变更集为 0 时不落产物 | 记一条「0 个文件」 | 只会污染评审视图 |
| 对象存储部分失败不报 `persisted` | 传了几个算几个 | 半传上去的一批对象比完全没传更危险：远端处于既不是旧也不是新的中间态，而调用方看到已持久化就不会再管它 |
| 变更集不完整时拒绝归档 / 上传 | 照着不完整的清单搬 | 产出一个看起来成功、实际缺文件的结果，而缺了什么没有任何地方说得出来 |
| 认不出的对象存储端点不给控制台链接 | 猜一个路径 | 自建 MinIO / Ceph 的控制台路径千奇百怪，与 git 那边「认不出 host 就不给链接」同一条纪律 |

---

## 6. 四个后端

### 6.1 `git`

镜像 + worktree。为什么不是「每个 Run 各 clone 一次」：clone 一个中等仓库要
几十秒到几分钟，而调度器可能一分钟派发十几个 Run。镜像只在第一次建立，
之后每个 Run 从共享对象库挂一棵独立工作树，耗时是毫秒级。

只读参考仓库挂 **detached**：内容与基线完全相同，而 `worktree remove` 不删分支
—— 建了就是按「Run 数 × 参考仓库数」在镜像里永久堆积垃圾。

### 6.2 `empty`

建一个空目录。规划、调研、纯文档产出走这条。它照样有基线（见 §3）。

### 6.3 `local`

从宿主机上一个**已登记**的目录（`storage_targets.kind = 'local'`）复制内容进来。
数据集、素材库、外部工具产出的目录都是这一类。

**复制而不是让 Agent 直接在源目录里干活**：两个并发 Run 会互相覆盖，而失败的
Run 会把源目录改坏且没有东西能还原它。代价是大目录复制要时间。

`dereference: false` —— 不跟进符号链接。跟进的话一条指向 `/etc` 的链接就会把
宿主机配置复制进 Agent 的工作区，而白名单挡的是挂载点，不是挂载点里的链接目标。

**两道闸**：

| 闸 | 在哪 | 挡什么 |
| --- | --- | --- |
| `storage_targets` 登记 | 库里 | 管理员的意图：哪些目录允许被任务引用 |
| `APOS_LOCAL_MOUNT_ROOTS` | 环境变量 | 部署方的底线：一条填成 `/` 的登记等于把整台机器交给 Agent |

白名单比的是**解析后**的绝对路径且要求边界对齐，否则 `/data/public` 会连
`/data/public-secrets` 一起放行。

交货走 `LocalPublisher`：把变更集复制到 `APOS_ARCHIVE_ROOT/{runId}/`。
不配归档根就退回「不交货」并如实说明 —— LocalPublisher 的全部价值就是把东西
搬到工作区之外，没有归档目录它搬不到任何地方。

> ★ 归档根必须与 `AGENT_WORKSPACE_ROOT` **不同**，而且在一个真正持久的卷上。
> 落在工作区根下面的话，`pruneOrphans` 会连同工作树一起把它删掉 ——
> 而那时用户已经在产物页上看到「已归档」了。

### 6.4 `object_storage`（S3 兼容）

同步 `bucket/prefix` 下的对象到本地目录。**Agent 拿到的仍然是一个本地目录** ——
headless CLI 不会说 S3 协议，所以这里干的是「同步下来」，不是「让 Agent 直接读 bucket」。

交货只上传 `changes.added ∪ changes.modified`、删除 `changes.deleted`。
**这是保留 ChangeSet 概念最直接的回报**：一个 20GB 的数据集挂进来、Agent 改了
3 个文件 —— 传那 3 个。退化成「全量上传」的话每次收尾都是一次 20GB 的出网流量。

#### 为什么手写 SigV4 而不是引 `@aws-sdk/client-s3`

只用到四个操作（List / Get / Put / Delete），而 SDK 会带进来几十个传递依赖。
更实际的一条：**SDK 在这里也没法被集成测试**（环境里没有真的 S3），所以
「用成熟 SDK 换正确性」这笔账并不成立。

手写版的正确性靠两层测试锚定：

| 层 | 测什么 | 凭什么 |
| --- | --- | --- |
| `sigv4.test.ts` | 派生密钥 → 规范请求 → 待签串 → 最终签名 | AWS 公布的签名文档与通用测试套件的公布值 |
| `s3.test.ts` | 请求怎么发、响应怎么解 | 进程内假 S3，逐条断言 URL / 方法 / 头 / 体 |

几处容易错、且错了极难诊断的地方：

- **`encodeURIComponent` 不能用**：它保留 `!'()*`，而 AWS 要求把它们也编码。
  差一个字符签名就对不上，表现是「某些文件名的对象传不上去」。
- **寻址风格是显式配置**：MinIO / Ceph / 自建网关基本只支持 path-style。
  默认成 virtual-host 的话，自建端点的表现是 DNS 解析失败 ——
  完全不指向「寻址风格」这件事。
- **列举要翻页到底**：只取第一页的话超过 1000 个对象的 bucket 会静默少算，
  而少算的表现是「基线里没有这些对象」，收尾时它们全都成了新增。
- **XML 实体要还原**：对象键里合法地出现 `&` 与 `<`，不还原的话这些键会被当成
  「与本地不同」，每次收尾都报成修改。
- **部分失败不算已持久化**：半传上去的一批对象比完全没传更危险 —— 远端处于
  既不是旧状态也不是新状态的中间态，而调用方看到 `persisted: true` 就不会再管它。

---

## 7. 包与目录结构

```
packages/workspace-providers/          ← 后端，不认识数据库
├── ports.ts              注入口：SecretResolver / RemoteResolver / HostKeyStore
├── types.ts              SourceMaterializer / MountSpec
├── publisher-types.ts    Publisher / ReleaseContext
├── pipeline.ts           后端无关的收尾流水线
├── check.ts              质量核验（与后端正交）
├── snapshot.ts           文件清单快照（empty / local / object_storage 共用）
├── paths.ts              根目录布局
├── git/                  cli · ssh · auth · source · publisher
├── empty/                source · none-publisher
├── local/                source · publisher
└── object-storage/       sigv4 · s3 · source · publisher

apps/api/src/modules/workspace/
├── index.ts              WorkspaceService —— 只做数据库适配
└── workspace.test.ts

{AGENT_WORKSPACE_ROOT}/
├── mirrors/{repoId}.git        裸镜像，仓库级共享的对象库
├── runs/{runId}/{ref}/         每次执行一棵独立工作树 / 一份同步下来的副本
├── planning/{runId}/           规划任务的空目录（留存供复查）
└── state/{key}.json            文件系统类后端的基线快照

{APOS_ARCHIVE_ROOT}/{runId}/    本地归档（必须是另一个持久卷）
```

### 7.1 为什么后端要独立成包

`git/auth.ts` 原先叫 `credentials.ts`，签名是 `withRepoAuth(db, repoRow, fn)` ——
直接吃一个 drizzle `Database` 和一行 `repositories`。也就是说这段逻辑要跑起来，
就得先有一个 Postgres、一套业务表、以及那套表里恰好有这一行。

它真正需要的只有三件事，写成 `ports.ts` 里的三个接口：

| 注入口 | 干什么 | 宿主怎么实现 |
| --- | --- | --- |
| `SecretResolver` | `secret://…` → 明文 | `resolveSecret`（`modules/security/secrets.ts`） |
| `RemoteResolver` | 按 id 回查远端描述 | 查 `repositories` |
| `HostKeyStore` | 存 TOFU 学到的主机公钥 | 写 `repositories.sshKnownHosts` |

**第二个消费方就是这些新后端**：对象存储与本地目录同样要解凭证，而它们和
`repositories` 表毫无关系 —— 继续走老路的话，一个 S3 bucket 得先伪装成一个
git 仓库才能拿到自己的 access key。

### 7.2 登记表：`storage_targets`

非 Git 的来源登记在这张表里，而不是塞进 `repositories`。那张表的每一列都是
git 概念（`remoteUrl` / `defaultBranch` / `branchPrefix` / `sshKnownHosts`），
一个 S3 bucket 塞进去要给这些列填占位符，而占位符会一路流到界面上
（「默认分支：main」）—— 这正是规划任务曾经用 `branch:'planning'` 假装自己是
git 仓库时踩过的坑（§1）。

库级约束卡住两类各自的必填列：少一个 `bucket` 的对象存储登记写不进去。
不卡的话现象是派发时报「挂载失败」，而管理员看着那条登记觉得一切正常。

`ResourceScope` 里用 `kind: 'dataset'` 引用它，与仓库的 `kind: 'repo'` 分开 ——
「授权了什么」在权限快照里因此是自解释的。

登记入口在**设置 → 存储目标**（导航里独立的一格，
`/projects/:projectId/settings/storage`；`POST/PATCH/DELETE /api/v1/admin/storage-targets`，
权限 `storage_target.manage`）。
与 `repository.manage` 分开是因为风险面不同：登记一个仓库最坏是让 Agent 往一个
仓库里写代码，而登记一个 `local` 目标是把宿主机上的一个目录交给 Agent。

它曾经是「Agent 配置」下面的第四个标签页，而那个位置说错了归属：存储目标不是某个
Agent 的属性，是与代码仓库同级的**项目（或组织）级资源登记** —— 一个 bucket 被三个
Agent 引用是常态，删它要看的是「有没有 Agent 授权指向它」，不是某一个 Agent 的配置。
藏在别的页面里还有一个更实际的代价：想挂一个数据目录的人脑子里没有 Agent，
不会去点「Agent 配置」的第四个标签。**授权**仍然在 Agent 配置里（`resourceScopes`
的 `kind: 'dataset'`），所以存储目标那一页显式指回去。

那一页上有两件在别处看不到的事，都是「不说就要等第一次派发才炸」的：

- **`APOS_LOCAL_MOUNT_ROOTS` 的当前取值**。它是部署环境的变量，管理员在界面上
  改不动也看不到，而一条 `local` 登记过不过闸完全由它决定 —— 不显示的话，
  被闸掉的登记在页面上和正常的一模一样。
- **连通性探测**（`POST …/probe`）。对象存储列一页对象、本地目录 stat 一下，
  且**复用 `isMountRootAllowed` 这同一个判据函数**。抄第二遍的代价是界面上说
  「可以挂」而派发时报「不在允许范围内」，而管理员看着那条绿色的探测结果，
  根本不会想到去查环境变量。

### 7.3 主挂载与交货后端的选择

一次执行可以同时挂多个资源。**交货只对主挂载做**：

1. 优先可写的仓库
2. 其次可写的数据集
3. 再次任意可解析的

仓库优先于数据集，是因为一个既挂了代码仓库又挂了数据集的任务，产出该进仓库的
分支，而不是覆盖数据集。其余挂载一律是只读参考。

交货后端**先看登记里配的交货目标，没配才按主挂载的种类推断**：

```
repositories.delivery_target_id / storage_targets.delivery_target_id
  ├── 配了 → 按目标的种类：object_storage → ObjectStoragePublisher（deliver 语义）
  │                        local          → LocalPublisher（归档根 = 目标的 rootPath）
  └── 没配 → 按主挂载：git → GitPublisher、object_storage → ObjectStoragePublisher
                      （sync 语义）、local → LocalPublisher（归档根来自
                      APOS_ARCHIVE_ROOT，没配则退回 none）、empty → NonePublisher
```

这一列兑现的是 §2 承诺的「两头独立可选」。在它出现之前交货后端**只能**由主挂载
决定，于是 §2 用来说明这个设计的那个例子 ——「从 Git 拉代码、把生成的报告传
对象存储」—— 恰恰是表达不了的。

**是覆盖不是追加。** 配了交货目标就不再推分支。要「既推分支又传一份到 S3」
得让 `pipeline` 支持多个 publisher、`PublishResult` 变数组、artifacts 落多行，
是另一个量级的改动。

### 7.4 `sync` 与 `deliver` 是两种语义，必须在类型上分开

| | 目标 | `changes.deleted` | 落点 |
| --- | --- | --- | --- |
| `sync` | 就是主挂载的来源 | **删除**远端对象 | `{prefix}` 原位置 |
| `deliver` | 另一个目标 | **不动** | `{prefix}{runId}/` |

★★ 不分开的后果是**数据丢失**：deliver 时 `changes.deleted` 说的是「Agent 在
工作区里删了这些文件」，而目标 bucket 里同名的 key 属于别人 —— 照着删就是拿
一次 Run 的变更集去删一个不相干的 bucket。这是整套交货逻辑里唯一可能毁掉
别人数据的操作，所以它被关在 `if (!deliver)` 后面。

按 `runId` 分目录同理：不分的话两次 Run 都产出 `report.md` 时后一次静默覆盖
前一次，而产物页上两条记录指向同一个 key。

deliver 时**不看主挂载的 `writable`** —— 主挂载可能是一棵只读的 git 工作树，
那与「能不能往目标写」毫无关系；目标自身的可写性由 `WorkspaceService` 在挑
后端时就判过了。

**投递到宿主机目录同样要过 `APOS_LOCAL_MOUNT_ROOTS`。** 那道闸此前只挡
「挂进来」，而「写出去」的破坏力只大不小 —— 一条指向 `/etc` 的登记，挂进来
是泄露，写出去是覆盖。

**配了却没生效的每一种情况都要给出原因**（目标不存在 / 已停用 / 只读 /
被白名单挡住），经 `NonePublisher(reason)` 带进收尾说明。不给的话，用户看到的
文字与「本来就没配交货目标」一模一样 —— 而这两者一个是配置没生效、
一个是符合预期。

> ★ `ObjectStoragePublisher` 必须**按次构造**，不能像 git 那样全局注册一个。
> 交货时挂载点上只剩快照键，要换回 endpoint 与凭证就得知道 `targetId` ——
> 而那个映射在本次 Run 落库的挂载清单里。做成全局单例就得往实例上挂一个
> 「当前是哪个 Run」的可变字段，而 supervisor 判超时与事件流报 `run_ended`
> 本来就会并发进来：两次收尾一交错，一个 Run 的产出就会传到另一个 Run 的
> bucket 里。闭包捕获本次的挂载清单，天然没有这个问题。

---

## 8. 两条通道

### 8.1 落库通道（执行 Run）

`acquire()` / `release()`。状态写进 `agent_runs.workspace`（jsonb）——
进程重启后要能回答「这个孤儿 Run 在哪个分支上留了什么」。

### 8.2 不落库通道（规划 Run）

`acquireLocal()` / `releaseLocal()`。

**这是整套抽象里唯一一处真实的耦合点，值得写清楚**：规划 Run **刻意不在
`agent_runs` 里** —— `agent_runs.work_item_id` 是 NOT NULL 且带外键，而规划
发生在工作项存在之前（完整理由见 `planning/agent-provider.ts` 顶部）。
所以落库通道对它没有一行可写。

显式开一条不落库的路，而不是让调用方自己 `mkdir` 再手工捏一个 workspace ——
后者正是改造前的做法，代价写在 §1。

---

## 9. 迁移与清理

| 迁移 | 内容 |
| --- | --- |
| `0019_storage_targets` | 建 `storage_targets` 表（drizzle-kit 由 schema 生成） |
| `0020_workspace_mounts_backfill` | 给它补 RLS；回填 `agent_runs.workspace.mounts` |
| `0021_delivery_target` | 给 `repositories` 与 `storage_targets` 加 `delivery_target_id` |

`delivery_target_id` **刻意没有外键**：两张表指向同一处要建两条约束，而删除
语义也不是级联（删掉目标不该悄悄把依赖它的登记改成「不交货」）。把关放在
`deleteStorageTarget` 里 —— 还有登记交货到它就拒绝删除。少了这道检查，删除会
成功，而那些登记的产出在下一次收尾时静默落回「不交货」：任务照样成功、
产物页照样有记录，只是东西哪儿都没到。

**为什么 RLS 要单独补**：`0017_supabase_rls` 是「遍历当时存在的所有表」，
管不到之后新建的表。而 `storage_targets` 里存的是对象存储的凭证引用 ——
正是最不该出现在匿名 REST 接口上的那一类数据。漏掉的后果没有任何症状：
应用照常跑、日志干净，只有被拖库之后才会知道。

**为什么回填要单独一条**：`0019` 是 drizzle-kit 由 schema 生成的，
下次改 schema 会被重新生成覆盖。手写的东西必须待在自己的文件里。

**`mounts` 为什么曾经不需要迁移**：它是在 `workspace` 这个 jsonb 列**内部**加的
字段，`$type<>` 只是 TS 层标注，列类型仍是 `jsonb` —— `drizzle-kit generate`
不产出任何 diff。代价是老行里没有这个键，而没有它，那些 Run 的参考仓库工作树
一个都回收不掉。`0020` 把数据补齐之后，代码里那个「读不到 mounts 就退回主路径」
的回退从**正确性依赖**降级成**滚动发布窗口的保险**（迁移跑完仍可能有老进程在
写老结构的行）。

回填只补形状完整的行：`path` 或 `repoId` 缺失的行本来就是坏的，给它编一个
`mounts` 只会把「坏数据」伪装成「好数据」。

---

### 9.1 环境变量

| 变量 | 作用 | 不配的后果 |
| --- | --- | --- |
| `AGENT_WORKSPACE_ROOT` | 工作区根目录 | 用 `/tmp/apos-workspaces` |
| `APOS_ARCHIVE_ROOT` | 本地归档根 | `local` 类工作区退回「不交货」，并如实标 `persisted: false` |
| `APOS_LOCAL_MOUNT_ROOTS` | 允许挂载的宿主目录白名单（`:` 分隔） | 不限制 —— 任何被登记的路径都能挂 |
| `APOS_WORKSPACE_PUSH_ON_FAILURE` | 失败的 Run 也推送分支 | 失败改动只留在镜像的本地分支上 |
| `APOS_WORKSPACE_KEEP_LOCAL_BRANCHES` | 推送成功后保留镜像里的本地分支 | 推送成功即删除（远端已有一份） |

---

## 10. 相关文档

- [06 Agent Protocol](06-agent-protocol.md) —— `TaskDispatch.workspace` 的下发契约
- [09 身份、权限与安全](09-security.md) —— 仓库凭证的注入方式（token 不进 argv、不落盘）
- [04 Flow Engine](04-flow-engine.md) —— 收尾必须在状态流转之前的理由
