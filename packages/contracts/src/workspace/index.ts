import { z } from 'zod';

/**
 * 工作区抽象。
 *
 * ★★ 为什么工作区不是「可替换的存储后端」，而是「本地目录 + 两头可换」。
 *
 *   平台派出去的是 headless CLI Agent —— claude-code / codex / aider /
 *   goose 无一例外要 `cd` 进一个目录再 `open()` 文件。**本地 POSIX 目录
 *   这一点没有可替换性**，把它做成「后端之一」是把不变的东西做成了变量。
 *
 *   真正可换的是两头：
 *     铺料（materialize）：目录里的初始内容从哪来 —— git worktree / 空目录 /
 *                          将来的对象存储同步
 *     交货（publish）：    目录里的变化送到哪去 —— git commit+push /
 *                          不送 / 将来的对象存储上传
 *
 *   两头**独立可选**：从 Git 拉代码、把生成的报告传对象存储是最常见的组合，
 *   而把它们捆进一个 Provider 接口就表达不了。
 *
 * The workspace abstraction.
 *
 * ★★ Why a workspace is not "a swappable storage backend" but "a local
 *   directory with swappable ends".
 *
 *   What the platform dispatches are headless CLI Agents — claude-code,
 *   codex, aider, goose. Every one of them `cd`s into a directory and then
 *   `open()`s files. **The local POSIX directory is the part with no
 *   alternatives**; modelling it as "one backend among several" turns the
 *   constant into a variable.
 *
 *   What actually varies is the two ends:
 *     materialize — where the directory's initial contents come from: a git
 *                   worktree, an empty directory, later an object-storage sync
 *     publish     — where changes in the directory go: git commit+push,
 *                   nowhere, later an object-storage upload
 *
 *   The two ends are **independently selectable**: pulling code from Git and
 *   uploading a generated report to object storage is the common combination,
 *   and a single Provider interface cannot express it.
 */

/**
 * 铺料后端种类 / Materialisation backends.
 *
 * | 种类 Kind | 内容从哪来 Contents from | 基线 Baseline |
 * | --- | --- | --- |
 * | `git` | 镜像 + worktree | commit sha |
 * | `empty` | 建一个空目录 | 文件清单快照 |
 * | `local` | 复制宿主机上一个已登记的目录 | 文件清单快照 |
 * | `object_storage` | 从 S3 兼容端点同步下来 | ETag 清单 |
 */
export const SourceKind = z.enum(['git', 'empty', 'local', 'object_storage']);
export type SourceKind = z.infer<typeof SourceKind>;

/**
 * 资源引用 —— 「这份目录内容从哪来、基线是什么」。
 *
 * ★★ `baseVersion` 是整个抽象的承重墙。
 *
 *   它让「变更集」这个概念在所有后端都成立：git 用 commit sha，
 *   empty 用文件清单快照的 hash，对象存储用 ETag 清单。
 *
 *   没有它，收尾就只剩「扫描目录里有什么」这一条路 —— 而那对一个仓库检出
 *   意味着几万条产物记录，对一个 `npm install` 过的目录意味着几十万条。
 *   Git 版本之所以干净，正是因为它一直有基线：`status --porcelain` 报的是
 *   相对 baseCommit 的差异，不是目录清单。抽象必须把这个概念抬上来，
 *   而不是丢掉它。
 *
 * A resource reference — "where this directory's contents come from, and what
 * the baseline is".
 *
 * ★★ `baseVersion` is the load-bearing wall of the whole abstraction.
 *
 *   It makes "changeset" meaningful on every backend: git uses a commit sha,
 *   empty uses the hash of a file-listing snapshot, object storage uses an
 *   ETag listing.
 *
 *   Without it, finishing a run leaves only one option — scan whatever is in
 *   the directory — which for a repository checkout means tens of thousands of
 *   artifact rows, and for a directory that has run `npm install`, hundreds of
 *   thousands. The git implementation stays clean precisely because it always
 *   had a baseline: `status --porcelain` reports differences against
 *   baseCommit, not a directory listing. The abstraction has to lift that idea
 *   up rather than lose it.
 */
export const SourceRef = z.object({
  kind: SourceKind,
  /**
   * 后端自己的寻址键：仓库 id（镜像目录按它命名）/ bucket 名 / 目录路径。
   *
   * ★ 与 label 分开，是因为「机器拿它去找东西」和「人拿它认东西」是两个需求：
   *   仓库的 ref（order-service）可以被管理员改名，而镜像目录不能跟着改，
   *   否则改一次名就等于丢掉整个本地对象库。
   *
   * The backend's own addressing key: repository id (mirror directories are
   * named after it), bucket name, or directory path.
   *
   * ★ Kept apart from `label` because "what a machine looks something up by"
   *   and "what a person recognises it by" are different needs: an
   *   administrator can rename a repository's ref (order-service), but the
   *   mirror directory must not follow — one rename would otherwise throw away
   *   the entire local object store.
   */
  identifier: z.string(),
  /**
   * 给人看的名字：仓库 ref / bucket/prefix / 'planning'。
   * The name a person reads: a repository ref, bucket/prefix, or 'planning'.
   */
  label: z.string(),
  baseVersion: z.string().nullable(),
});
export type SourceRef = z.infer<typeof SourceRef>;

/**
 * 一个挂载点。
 *
 * ★ 复数 —— 一次执行可以同时挂主仓库（可写）与若干参考仓库（只读），
 *   这是现在就存在的事实（RunWorkspace.additionalPaths）。把资源引用做成
 *   单数字段会在抽象的第一步就丢掉它。
 *
 * One mount point.
 *
 * ★ Plural, because a single run already mounts the main repository (writable)
 *   alongside several reference repositories (read-only) — see
 *   `RunWorkspace.additionalPaths`. Modelling the resource reference as a
 *   singular field would lose that at the abstraction's very first step.
 */
export const Mount = z.object({
  /** 绝对路径，Agent 直接用 / An absolute path, used by the Agent as-is */
  path: z.string(),
  /**
   * primary 是 Agent 的主战场，交货只看它；reference 是只读参考。
   * `primary` is where the Agent works and the only mount publishing looks at;
   * `reference` mounts are read-only.
   */
  role: z.enum(['primary', 'reference']),
  writable: z.boolean(),
  source: SourceRef,
});
export type Mount = z.infer<typeof Mount>;

export const Workspace = z.object({
  /**
   * 工作区标识。
   *
   * ★ 与 runId 分开而不是直接复用。目前两者取值相同，但「一个工作区
   *   服务于一次执行」是当下的实现选择，不是概念上的必然 —— 同一工作项
   *   多次执行接力、恢复重跑复用工作区都会打破它。现在拆开零成本。
   *
   * The workspace identifier.
   *
   * ★ Kept separate from runId rather than reusing it. They currently hold the
   *   same value, but "one workspace serves one run" is today's implementation
   *   choice, not a conceptual necessity — relay runs on the same work item,
   *   or a recovery rerun reusing the workspace, both break it. Separating
   *   them now costs nothing.
   */
  id: z.string(),
  runId: z.string(),
  /** Agent 的 cwd / The Agent's working directory */
  root: z.string(),
  mounts: z.array(Mount),
  /** = primary 挂载的 writable / Mirrors the primary mount's `writable` */
  writable: z.boolean(),
});
export type Workspace = z.infer<typeof Workspace>;

/**
 * 变更集 —— 相对 baseVersion 的增 / 改 / 删。
 *
 * ★ 存文件名而不只存计数。评审时「改了哪些文件」比「改了 3 个文件」有用
 *   得多，而这个信息在算 diff 的那一刻本来就在手上，扔掉纯属浪费。
 *
 * The changeset — additions / modifications / deletions relative to baseVersion.
 *
 * ★ It stores filenames, not just counts. At review time "which files changed"
 *   is far more useful than "3 files changed", and the information is already
 *   in hand at the moment the diff is computed; discarding it is pure waste.
 */
export const ChangeSet = z.object({
  added: z.array(z.string()),
  modified: z.array(z.string()),
  deleted: z.array(z.string()),
  total: z.number().int().nonnegative(),
  /**
   * 目录过大时变更集是不完整的 —— 必须说出来，静默截断会被当成「没有改动」。
   * On a very large directory the changeset is incomplete. That has to be
   * stated: silent truncation reads as "nothing changed".
   */
  truncated: z.boolean().default(false),
});
export type ChangeSet = z.infer<typeof ChangeSet>;

export const EMPTY_CHANGE_SET: ChangeSet = {
  added: [],
  modified: [],
  deleted: [],
  total: 0,
  truncated: false,
};

/**
 * 交货结果。
 *
 * ★★ 可辨识联合，不是 `Record<string, unknown>`。
 *
 *   用 unknown 换「通用」是抽象里最亏的买卖：消费方（产物落库要拼分支 URL、
 *   前端要渲染产物卡片）全部退化成不安全的字段读取，而这些字段本来是强类型的。
 *   按 kind 收窄既通用又不丢类型。
 *
 * The result of publishing.
 *
 * ★★ A discriminated union, not `Record<string, unknown>`.
 *
 *   Trading types for "generality" via `unknown` is the worst bargain in an
 *   abstraction: every consumer (persisting an artifact needs to build a
 *   branch URL, the frontend renders an artifact card) degrades into unsafe
 *   field access, on fields that were strongly typed to begin with. Narrowing
 *   by `kind` is both general and type-preserving.
 */
export type PublishResult =
  | {
      kind: 'git';
      branch: string;
      headCommit: string | null;
      pushed: boolean;
      /**
   * 认不出 host 时为 null —— 不编一个打不开的链接。
   * null when the host is unrecognised — we do not invent a link that fails
   * to open.
   */
      url: string | null;
      note: string;
    }
  | {
      kind: 'object_storage';
      bucket: string;
      prefix: string;
      /** 上传的对象数 / Objects uploaded */
      uploaded: number;
      /** 删除的对象数 / Objects deleted */
      removed: number;
      /**
   * 认不出可点开的控制台地址时为 null —— 不编一个打不开的链接。
   * null when no clickable console URL can be derived — we do not invent one.
   */
      url: string | null;
      persisted: boolean;
      note: string;
    }
  | {
      kind: 'local';
      /** 归档落在哪 / Where the archive landed */
      archivePath: string;
      files: number;
      persisted: boolean;
      note: string;
    }
  | {
      kind: 'none';
      /**
       * ★ 没有 `published: true` 这种字段。
       *
       *   「本地目录即已发布」是自欺：工作区收尾后目录会被回收，容器回收后
       *   更是什么都不剩。标成已发布只会让用户点开产物看到一个不存在的路径。
       *   这里如实说明改动留在哪、有没有持久化。
       *
       * ★ There is deliberately no `published: true` field.
       *
       *   "A local directory counts as published" is self-deception: the
       *   directory is reclaimed when the workspace is torn down, and nothing
       *   at all survives a container being recycled. Marking it published
       *   only means a user clicking the artifact lands on a path that does
       *   not exist. This states plainly where the changes are and whether
       *   anything was persisted.
       */
      persisted: boolean;
      note: string;
    };

/**
 * 产出到底有没有落到工作区之外。
 *
 * ★★ git 变体刻意没有 `persisted` 字段，因为它的判据不一样：只提交没推送时，
 *   那个 commit 跟着工作树一起被删掉，等于没留下。所以对 git 来说
 *   「持久化」就是 pushed。
 *
 * ★ 有了这个统一判据，调用方才能回答「这次的东西还在不在」——
 *   而那正是「要不要保留工作区目录」唯一该依据的事实。
 */
export function isPersisted(result: PublishResult): boolean {
  return result.kind === 'git' ? result.pushed : result.persisted;
}

/**
 * 质量核验结果 —— 与铺料/交货后端**正交**：它只是「在一个本地目录里跑一条命令」。
 *
 * ★ 名字带 Workspace 前缀是为了和 common/enums 里那个 CheckResult
 *   （'passed' | 'failed' | 'not_run'，Policy 门禁用的枚举）区分开。
 *   两者是不同层面的东西：那个是门禁的判定，这个是一次执行的记录。
 *
 * The quality-check result — **orthogonal** to the materialise/publish
 * backends: it is simply "run a command in a local directory".
 *
 * ★ The Workspace prefix distinguishes it from `CheckResult` in common/enums
 *   ('passed' | 'failed' | 'not_run', the enum the policy gate uses). They sit
 *   at different levels: that one is a gate's verdict, this one is the record
 *   of a single execution.
 */
export const WorkspaceCheckResult = z.object({
  ran: z.boolean(),
  passed: z.boolean(),
  command: z.string().nullable(),
  /**
   * 失败时的输出尾部，进 Run 详情供人排查。
   * The tail of the output on failure, surfaced in the run detail page for
   * diagnosis.
   */
  output: z.string(),
  durationMs: z.number().int().nonnegative(),
});
export type WorkspaceCheckResult = z.infer<typeof WorkspaceCheckResult>;

export const NO_CHECK: WorkspaceCheckResult = {
  ran: false,
  passed: false,
  command: null,
  output: '',
  durationMs: 0,
};
