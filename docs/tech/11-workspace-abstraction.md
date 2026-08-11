# 11 工作区抽象

Agent 干活的地方叫「工作区」。本文档说明它为什么不是「可替换的存储后端」，
而是「一个本地目录 + 两头可换」，以及这个形状带来的约束与收益。

代码位置：`apps/api/src/modules/workspace/`，契约在 `packages/contracts/src/workspace/`。

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
  空目录            │                             │   不交货（NonePublisher）
  对象存储同步      └─────────────────────────────┘   对象存储上传
  （未实现）                                            （未实现）
```

两头**独立可选**。这是本设计与「一个 `WorkspaceProvider` 管到底」那类方案的
关键分歧：后者强制 1:1 绑定，表达不了「从 Git 拉代码、把生成的报告传对象存储」
这种最常见的组合。

### 2.1 核心类型

`packages/contracts/src/workspace/index.ts`：

| 类型 | 作用 |
| --- | --- |
| `SourceKind` | `'git' \| 'empty' \| 'object_storage'` |
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

| 后端 | baseVersion | diff 怎么算 |
| --- | --- | --- |
| `git` | commit sha | `git status --porcelain=v1 -z` |
| `empty` | 文件清单快照的 hash | 重新扫描，与快照逐项对比 |
| `object_storage`（未实现） | ETag 清单的 hash | 重新扫本地目录，与 ETag 清单对比 |

### 3.1 空目录后端的快照

`sources/empty.ts`。快照只记 `path → size:mtimeMs`，**不算内容 hash**：
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

---

## 6. 对象存储：接口位置已留，实现待真实需求

`SourceKind` 和 `PublishResult` 里都有 `object_storage` 这一支，但**没有实现**。

这是刻意的：目前零 caller。零 caller 的接口实现是猜测性代码 —— 要不要版本化？
要不要预签名 URL？对象多大？这些问题在第一个真实需求出现之前都没有答案，
而猜错的代价是一份没人用、也没人敢删的代码。

真要接的时候，形状是清楚的：

| 组件 | 做法 |
| --- | --- |
| `ObjectStorageMaterializer.materialize` | `ListObjects` 拉 prefix 下全部对象 → 下载到本地目录 → 基线 = `{key → ETag}` 清单的 hash |
| `.diff` | 重新扫**本地目录**，与 ETag 清单对比。不调 API —— Agent 改的是本地文件 |
| `.dispose` | 删本地目录；远端不动 |
| `ObjectStoragePublisher.publish` | 只上传 `changes.added ∪ changes.modified`，删 `changes.deleted` |
| 凭证 | 复用 `resolveSecret(credentialRef)`，与仓库凭证同一套 |

**只上传变更的那部分**就是保留 ChangeSet 概念的直接回报：不必全量重传。

同理，`packages/workspace-providers` 这个独立包**没有建**。`credentials.ts` 的
`withRepoAuth` 直接依赖 `Database` + `repositories` 表 + `resolveSecret`，
搬出去要先把凭证解析抽成注入接口 —— 那是另一笔账，等真出现第二个消费方
（比如 worker 独立进程）再还。

---

## 7. 目录结构

```
apps/api/src/modules/workspace/
├── index.ts              WorkspaceService —— 对外唯一入口
├── pipeline.ts           后端无关的收尾流水线
├── check.ts              质量核验（与后端正交）
├── paths.ts              根目录布局
├── sources/
│   ├── types.ts          SourceMaterializer / MountSpec
│   ├── git.ts            镜像 + worktree + 变更集 + 回收
│   └── empty.ts          清单快照 + 变更集
├── publishers/
│   ├── types.ts          Publisher / ReleaseContext
│   ├── git.ts            提交 + 推送 + 分支 URL
│   └── none.ts           不交货，如实说明位置
├── git.ts                git 命令封装（凭证注入）
├── ssh.ts                ssh-agent 生命周期
└── credentials.ts        凭证解析

{AGENT_WORKSPACE_ROOT}/
├── mirrors/{repoId}.git        裸镜像，仓库级共享的对象库
├── runs/{runId}/{repoRef}/     每次执行一棵独立工作树
├── planning/{runId}/           规划任务的空目录（留存供复查）
└── state/{key}.json            空目录后端的基线快照
```

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

## 9. 兼容与清理

| 项 | 状态 |
| --- | --- |
| `agent_runs.workspace` 加 `mounts` 字段 | **无需 SQL 迁移** —— `$type<>` 只是 TS 层标注，列类型仍是 `jsonb` |
| 旧结构（无 `mounts`）的 in-flight Run | `normalizeMounts()` 回退到主路径 |
| `normalizeMounts()` 何时可删 | 所有 in-flight Run 排空后（约一个发布周期），届时把 `mounts` 改成必填 |
| `RunWorkspace` 的 `repoRef/branch/...` | 已删，统一走可空的 `vcs` 子对象 |

---

## 10. 相关文档

- [06 Agent Protocol](06-agent-protocol.md) —— `TaskDispatch.workspace` 的下发契约
- [09 身份、权限与安全](09-security.md) —— 仓库凭证的注入方式（token 不进 argv、不落盘）
- [04 Flow Engine](04-flow-engine.md) —— 收尾必须在状态流转之前的理由
