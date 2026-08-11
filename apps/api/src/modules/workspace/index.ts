import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { agentRuns, repositories, type Database } from '@apos/db';
import {
  NO_CHECK,
  type AgentPermissions,
  type Mount,
  type PublishResult,
  type RunWorkspace,
  type SourceKind,
  type ChangeSet,
  type Workspace,
  type WorkspaceCheckResult,
} from '@apos/contracts';
import { GitError } from './git';
import { mirrorDir, runDir, workspaceRoot } from './paths';
import { GitMaterializer } from './sources/git';
import { EmptyMaterializer } from './sources/empty';
import { GitPublisher } from './publishers/git';
import { NonePublisher } from './publishers/none';
import { runReleasePipeline, type ReleaseOutcome } from './pipeline';
import type { SourceMaterializer } from './sources/types';
import type { Publisher, ReleaseContext } from './publishers/types';

export interface AcquireInput {
  runId: string;
  orgId: string;
  projectId: string;
  workItemId: string;
  workItemTitle: string;
  permissions: AgentPermissions;
}

export type AcquireResult =
  | { ok: true; workspace: RunWorkspace | null; note: string }
  | { ok: false; reason: string };

export interface ReleaseInput {
  runId: string;
  outcome: 'completed' | 'failed' | 'terminated' | 'timeout';
  summary: string;
  agentName: string;
}

export interface ReleaseResult {
  committed: boolean;
  pushed: boolean;
  headCommit: string | null;
  changedFiles: number;
  branch: string | null;
  note: string;
  /** 质量核验结果 —— reviewing 阶段唯一的真实测试数据源 */
  check: WorkspaceCheckResult;
  /** 变更集：改了**哪些**文件，不只是几个 */
  changes: ChangeSet;
  /** 交货结果，按后端收窄 */
  published: PublishResult;
}

/** 一个挂载点在库里的形态 */
export interface WorkspaceMount {
  path: string;
  repoId: string;
  role: 'primary' | 'reference';
}

type StoredWorkspace = NonNullable<(typeof agentRuns.$inferSelect)['workspace']>;

/**
 * 读旧结构的工作区记录时补出 mounts。
 *
 * ★ 升级瞬间还在跑的 Run 落的是没有 mounts 的旧结构，直接读会得到 undefined，
 *   于是它们的工作树一个都回收不掉。回退到主路径至少保证主工作树被正常回收。
 *
 * ★ 所有 in-flight 的 Run 排空后（约一个发布周期）可以删掉这个函数，
 *   把 schema 里的 mounts 改成必填。
 */
export function normalizeMounts(ws: StoredWorkspace): WorkspaceMount[] {
  if (ws.mounts?.length) return ws.mounts;
  return [{ path: ws.path, repoId: ws.repoId, role: 'primary' }];
}

/**
 * 工作区服务。
 *
 * ★★ 「工作区」= 一个本地目录 + 可换的两头，而不是「可替换的存储后端」。
 *
 *   平台派出去的是 headless CLI Agent，它们无一例外要 `cd` 进一个目录再
 *   `open()` 文件 —— **本地 POSIX 目录这一点没有可替换性**。可换的是：
 *     铺料（SourceMaterializer）：目录里的初始内容从哪来
 *     交货（Publisher）：        目录里的变化送到哪去
 *   两者独立可选，所以「从 Git 拉代码、把报告传对象存储」这种组合成立。
 *
 * ★ 收尾顺序（算变更集 → 核验 → 交货 → 回收）对所有后端都一样，
 *   实现在 pipeline.ts 里一份，不在每个后端里各抄一遍。
 */
export class WorkspaceService {
  private readonly sources = new Map<SourceKind, SourceMaterializer>();
  private readonly publishers = new Map<string, Publisher>();
  private readonly gitSource: GitMaterializer;

  constructor(
    private readonly db: Database,
    private readonly options: {
      /** 所有工作区的根目录 */
      root?: string;
      onDiagnostic?: (message: string, detail?: unknown) => void;
    } = {},
  ) {
    const root = this.root;
    this.gitSource = new GitMaterializer(db, { root, onDiagnostic: options.onDiagnostic });
    this.sources.set('git', this.gitSource);
    this.sources.set('empty', new EmptyMaterializer({ root, onDiagnostic: options.onDiagnostic }));
    this.publishers.set(
      'git',
      new GitPublisher(db, this.gitSource, { onDiagnostic: options.onDiagnostic }),
    );
    this.publishers.set('none', new NonePublisher());
  }

  private get root(): string {
    return workspaceRoot(this.options.root);
  }

  /** 让子类/Stage 3 的空目录后端接进来 */
  registerSource(source: SourceMaterializer): void {
    this.sources.set(source.kind, source);
  }

  registerPublisher(publisher: Publisher): void {
    this.publishers.set(publisher.kind, publisher);
  }

  /**
   * 派发前调用。返回 null 的 workspace 表示「这个任务不需要代码仓库」，
   * 是合法情况（调研、文档类任务），不是错误。
   */
  async acquire(input: AcquireInput): Promise<AcquireResult> {
    const scopes = input.permissions.resourceScopes.filter(
      (s) => s.kind === 'repo' && s.access !== 'none',
    );
    if (scopes.length === 0) {
      return { ok: true, workspace: null, note: '该 Agent 未授予任何仓库范围，本次不供给工作区' };
    }

    const ready = await this.gitSource.ensureReady();
    if (!ready.ok) {
      return { ok: false, reason: `工作区供给不可用：${ready.problem}` };
    }

    const refs = scopes.map((s) => s.ref);
    const rows = await this.db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.orgId, input.orgId),
          inArray(repositories.ref, refs),
          eq(repositories.status, 'active'),
          // 项目级仓库只对本项目可见；org 级（projectId 为空）对全组织可见
          or(isNull(repositories.projectId), eq(repositories.projectId, input.projectId)),
        ),
      );

    const byRef = new Map(rows.map((r) => [r.ref, r]));
    const missing = refs.filter((r) => !byRef.has(r));
    if (missing.length === refs.length) {
      /**
       * ★ 「授权了仓库但仓库没登记」必须是硬失败。
       *   放行的话 Agent 会在一个空目录里开工，然后信心十足地报告
       *   「未找到相关代码，已创建新实现」—— 这种失败比报错难查十倍。
       */
      return {
        ok: false,
        reason: `Agent 被授予了仓库 ${missing.join('、')}，但这些仓库没有在「代码仓库」里登记，无法准备工作区`,
      };
    }

    const writableScope = scopes.find((s) => s.access === 'write' && byRef.has(s.ref));
    const primaryScope = writableScope ?? scopes.find((s) => byRef.has(s.ref))!;
    const primary = byRef.get(primaryScope.ref)!;
    const writable = primaryScope.access === 'write';

    const branch = buildBranchName(primary.branchPrefix, input.workItemTitle, input.runId);
    const path = join(runDir(this.root, input.runId), primary.ref);

    try {
      const primaryMount = await this.gitSource.materialize({
        role: 'primary',
        writable,
        path,
        repo: primary,
        branch,
      });
      const mounts: Mount[] = [primaryMount];

      // 其余可读仓库各挂一棵只读工作树，供 Agent 查阅
      const additionalPaths: string[] = [];
      for (const scope of scopes) {
        if (scope.ref === primaryScope.ref) continue;
        const repo = byRef.get(scope.ref);
        if (!repo) continue;
        const extraPath = join(runDir(this.root, input.runId), repo.ref);
        try {
          // ★ 不给 branch = 挂 detached：参考挂载的内容与基线相同，分支纯属垃圾
          mounts.push(
            await this.gitSource.materialize({
              role: 'reference',
              writable: false,
              path: extraPath,
              repo,
            }),
          );
          additionalPaths.push(extraPath);
        } catch (err) {
          // 附属仓库挂不上不该拖垮整个 Run，但要留痕
          this.diagnose(`附属仓库 ${repo.ref} 准备失败`, err);
        }
      }

      const baseCommit = primaryMount.source.baseVersion;
      const workspace: RunWorkspace = {
        path,
        writable,
        additionalPaths,
        vcs: { repoRef: primary.ref, branch, baseBranch: primary.defaultBranch, baseCommit },
        // 过渡期：deprecated 字段与 vcs 同时填，让还没跟上的适配器继续工作
        repoRef: primary.ref,
        branch,
        baseBranch: primary.defaultBranch,
        baseCommit,
      };

      await this.db
        .update(agentRuns)
        .set({
          workspace: {
            repoRef: primary.ref,
            repoId: primary.id,
            branch,
            baseBranch: primary.defaultBranch,
            baseCommit,
            path,
            mounts: mounts.map((m) => ({
              path: m.path,
              repoId: m.source.identifier,
              role: m.role,
            })),
          },
        })
        .where(eq(agentRuns.id, input.runId));

      const note = missing.length
        ? `工作区就绪（${primary.ref}@${branch}）；${missing.join('、')} 未登记，已跳过`
        : `工作区就绪（${primary.ref}@${branch}${writable ? '，可写' : '，只读'}）`;

      return { ok: true, workspace, note };
    } catch (err) {
      await this.cleanupRunDir(input.runId).catch(() => undefined);
      const message = err instanceof GitError ? err.message : String(err);
      return { ok: false, reason: `准备工作区失败：${message}` };
    }
  }

  /**
   * Run 结束后调用：算变更集 → 核验 → 交货 → 回收工作树。
   *
   * ★ 幂等：重复调用不会重复提交，也不会因为工作树已经没了而抛异常。
   *   run-supervisor 判超时和事件流报 run_ended 可能同时到达。
   */
  async release(input: ReleaseInput): Promise<ReleaseResult> {
    const [run] = await this.db.select().from(agentRuns).where(eq(agentRuns.id, input.runId));
    const ws = run?.workspace;

    if (!run || !ws) return emptyRelease('本次执行没有工作区');

    if (ws.headCommit !== undefined) {
      // 已经收过尾了
      return {
        ...emptyRelease('工作区此前已收尾'),
        committed: Boolean(ws.headCommit),
        pushed: ws.pushed === true,
        headCommit: ws.headCommit ?? null,
        changedFiles: ws.changedFiles ?? 0,
        branch: ws.branch,
      };
    }

    if (!(await exists(ws.path))) {
      await this.finishWorkspace(input.runId, ws, {
        headCommit: null,
        pushed: false,
        changedFiles: 0,
      });
      return { ...emptyRelease('工作区目录已不存在，跳过收尾'), branch: ws.branch };
    }

    const [repo] = await this.db.select().from(repositories).where(eq(repositories.id, ws.repoId));

    const outcome = await runReleasePipeline(
      { sources: this.sources, publishers: this.publishers, onDiagnostic: this.options.onDiagnostic },
      toWorkspace(ws, input.runId),
      {
        runId: input.runId,
        outcome: input.outcome,
        summary: input.summary,
        agentName: input.agentName,
        goal: run.goal,
      },
      {
        publisher: 'git',
        checkCommand: repo?.checkCommand ?? null,
        checkTimeoutSeconds: repo?.checkTimeoutSeconds ?? 600,
      },
    );

    await this.cleanupRunDir(input.runId).catch(() => undefined);

    const git = outcome.published.kind === 'git' ? outcome.published : null;
    const headCommit = git?.headCommit ?? null;
    const pushed = git?.pushed ?? false;

    await this.finishWorkspace(input.runId, ws, {
      headCommit,
      pushed,
      changedFiles: outcome.changes.total,
    });

    return {
      committed: headCommit !== null,
      pushed,
      headCommit,
      changedFiles: outcome.changes.total,
      branch: git?.branch || ws.branch,
      note: outcome.notes.join('；'),
      check: outcome.check,
      changes: outcome.changes,
      published: outcome.published,
    };
  }

  /**
   * 不落库的本地工作区。
   *
   * ★★ 为什么需要这条通道：规划 Run **刻意不在 agent_runs 里**
   *   （理由见 planning/agent-provider.ts 顶部那段 —— agent_runs.work_item_id
   *   是 NOT NULL 且带外键，而规划发生在工作项存在之前）。而上面的
   *   acquire/release 把状态写进 agent_runs.workspace，对它没有一行可写。
   *
   *   这是抽象里唯一一处真实的耦合点，所以显式开一条路，而不是让调用方
   *   自己 mkdir 然后手工捏一个 workspace 对象 —— 后者正是此前的做法，
   *   代价是规划任务拿到一个 branch:'planning' 的假 Git 工作区。
   */
  async acquireLocal(input: {
    /** 工作区标识，快照按它命名 */
    id: string;
    runId: string;
    /** 目标目录，调用方决定放哪 */
    path: string;
    /** 记基线之前放平台自己的输入文件（任务书之类） */
    seed?: (path: string) => Promise<void>;
  }): Promise<{ workspace: Workspace; dispatch: RunWorkspace }> {
    const source = this.sources.get('empty')!;
    const mount = await source.materialize({
      role: 'primary',
      writable: true,
      path: input.path,
      workspaceId: input.id,
      ...(input.seed ? { seed: input.seed } : {}),
    });

    return {
      workspace: {
        id: input.id,
        runId: input.runId,
        root: input.path,
        mounts: [mount],
        writable: true,
      },
      // ★ vcs 为 null —— 这次执行真的不在版本控制下，prompt 会据此换一套说法
      dispatch: { path: input.path, writable: true, additionalPaths: [], vcs: null },
    };
  }

  /** 与 acquireLocal 配对。keep=true 保留目录供人事后复查 */
  async releaseLocal(
    workspace: Workspace,
    ctx: ReleaseContext,
    opts: { keep?: boolean } = {},
  ): Promise<ReleaseOutcome> {
    return runReleasePipeline(
      { sources: this.sources, publishers: this.publishers, onDiagnostic: this.options.onDiagnostic },
      workspace,
      ctx,
      {
        publisher: 'none',
        checkCommand: null,
        checkTimeoutSeconds: 0,
        ...(opts.keep === undefined ? {} : { keepMounts: opts.keep }),
      },
    );
  }

  private async finishWorkspace(
    runId: string,
    ws: StoredWorkspace,
    result: { headCommit: string | null; pushed: boolean; changedFiles: number },
  ) {
    await this.db
      .update(agentRuns)
      .set({ workspace: { ...ws, ...result } })
      .where(eq(agentRuns.id, runId));
  }

  private async cleanupRunDir(runId: string) {
    await rm(runDir(this.root, runId), { recursive: true, force: true });
  }

  /** 进程重启后清掉没人认领的工作树目录 */
  async pruneOrphans(activeRunIds: string[]): Promise<number> {
    const { readdir } = await import('node:fs/promises');
    const dir = join(this.root, 'runs');
    let removed = 0;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return 0;
    }
    const active = new Set(activeRunIds);
    for (const entry of entries) {
      if (active.has(entry)) continue;
      await rm(join(dir, entry), { recursive: true, force: true }).catch(() => undefined);
      removed++;
    }
    return removed;
  }

  /** 镜像目录，供诊断与运维脚本定位 */
  mirrorPathFor(repoId: string): string {
    return mirrorDir(this.root, repoId);
  }

  private diagnose(message: string, detail?: unknown) {
    this.options.onDiagnostic?.(message, detail);
  }
}

/** 落库的工作区记录 → 抽象的 Workspace */
function toWorkspace(ws: StoredWorkspace, runId: string): Workspace {
  const mounts: Mount[] = normalizeMounts(ws).map((m) => ({
    path: m.path,
    role: m.role,
    writable: m.role === 'primary',
    source: {
      kind: 'git' as const,
      identifier: m.repoId,
      label: m.role === 'primary' ? ws.repoRef : m.repoId,
      baseVersion: m.role === 'primary' ? ws.baseCommit : null,
    },
  }));
  return { id: runId, runId, root: ws.path, mounts, writable: true };
}

function emptyRelease(note: string): ReleaseResult {
  return {
    committed: false,
    pushed: false,
    headCommit: null,
    changedFiles: 0,
    branch: null,
    note,
    check: NO_CHECK,
    changes: { added: [], modified: [], deleted: [], total: 0, truncated: false },
    published: { kind: 'none', persisted: false, note },
  };
}

/** `apos/add-login-a1b2c3` —— 带任务信息，人在 PR 列表里能认出来 */
export function buildBranchName(prefix: string, title: string, runId: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9一-龥]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'task';
  return `${prefix}${slug}-${runId.slice(0, 8)}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export { GitMaterializer } from './sources/git';
export { EmptyMaterializer } from './sources/empty';
export { GitPublisher, branchUrl } from './publishers/git';
export { NonePublisher } from './publishers/none';
export { runCheck } from './check';
export { runReleasePipeline } from './pipeline';
export type { ReleaseOutcome } from './pipeline';
export type { SourceMaterializer, MountSpec } from './sources/types';
export type { Publisher, ReleaseContext } from './publishers/types';
