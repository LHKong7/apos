import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { agentRuns, repositories, storageTargets, type Database } from '@apos/db';
import {
  NO_CHECK,
  type AgentPermissions,
  type ChangeSet,
  type Mount,
  type PublishResult,
  type ResourceScope,
  type RunWorkspace,
  type SourceKind,
  type Workspace,
  type WorkspaceCheckResult,
} from '@apos/contracts';
import {
  EmptyMaterializer,
  GitError,
  GitMaterializer,
  GitPublisher,
  LocalMaterializer,
  LocalPublisher,
  NonePublisher,
  ObjectStorageMaterializer,
  ObjectStoragePublisher,
  isMountRootAllowed,
  runDir,
  runReleasePipeline,
  workspaceRoot,
  type GitRemoteDescriptor,
  type LocalDirDescriptor,
  type ObjectStoreDescriptor,
  type Publisher,
  type ReleaseContext,
  type ReleaseOutcome,
  type SourceMaterializer,
} from '@apos/workspace-providers';
import { resolveSecret } from '../security/secrets';

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

type StoredWorkspace = NonNullable<(typeof agentRuns.$inferSelect)['workspace']>;
type StoredMount = NonNullable<StoredWorkspace['mounts']>[number];

/**
 * 允许挂载的宿主目录白名单。
 *
 * ★ 只有一处解析，供 WorkspaceService 装配与配置页探测共用。
 *   两处各自 split 一遍的代价是判据悄悄分叉 —— 而分叉的表现是
 *   「配置页说能挂，派发时说不在允许范围内」。
 *
 * ★ 空串过滤掉：`APOS_LOCAL_MOUNT_ROOTS=` 留空是「没配」，
 *   而 `['']` 会被 resolve 成进程当前目录，等于凭空多出一条白名单。
 */
export function localMountRootsFromEnv(): string[] {
  return (process.env['APOS_LOCAL_MOUNT_ROOTS'] ?? '')
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface WorkspaceServiceOptions {
  /** 所有工作区的根目录 */
  root?: string;
  /**
   * 本地目录归档根。不配则 local 类工作区退回「不交货」——
   * 产出还在工作区里，但收尾就会被回收，所以要如实说明。
   */
  archiveRoot?: string;
  /** 允许挂载的宿主目录白名单。不配表示不限制 */
  localMountRoots?: string[];
  onDiagnostic?: (message: string, detail?: unknown) => void;
}

/**
 * 工作区服务 —— 后端在 `@apos/workspace-providers` 里，这一层只做**数据库适配**。
 *
 * ★★ 「工作区」= 一个本地目录 + 可换的两头。平台派出去的是 headless CLI Agent，
 *   它们无一例外要 `cd` 进一个目录再 `open()` 文件 —— 本地 POSIX 目录这一点
 *   没有可替换性。可换的是铺料（内容从哪来）与交货（变化送到哪去），
 *   两者独立可选。
 *
 * ★ 这一层负责的三件事，恰好就是 providers 包声明的三个注入口：
 *   把 `secret://…` 引用解成明文、按 id 回查远端描述、存 SSH 主机公钥。
 *   除此之外它不掺和任何后端细节。
 */
export class WorkspaceService {
  private readonly sources = new Map<SourceKind, SourceMaterializer>();
  private readonly publishers = new Map<string, Publisher>();
  private readonly gitSource: GitMaterializer;
  private readonly objectSource: ObjectStorageMaterializer;
  private readonly hasArchive: boolean;

  constructor(
    private readonly db: Database,
    private readonly options: WorkspaceServiceOptions = {},
  ) {
    const root = this.root;
    const secrets = { resolve: resolveSecret };
    const onDiagnostic = options.onDiagnostic;

    this.gitSource = new GitMaterializer({
      root,
      secrets,
      remotes: { byId: (id) => this.loadRemote(id) },
      hostKeys: { pin: (id, knownHosts) => this.pinHostKey(id, knownHosts) },
      ...(onDiagnostic ? { onDiagnostic } : {}),
    });
    this.objectSource = new ObjectStorageMaterializer({
      root,
      secrets,
      ...(onDiagnostic ? { onDiagnostic } : {}),
    });

    this.sources.set('git', this.gitSource);
    this.sources.set('empty', new EmptyMaterializer({ root, ...(onDiagnostic ? { onDiagnostic } : {}) }));
    this.sources.set(
      'local',
      new LocalMaterializer({
        root,
        // ★ 空数组 = 没配 = 不限制；LocalMaterializer 里也按「空则放行」处理，
        //   两处保持一致，免得「配了个空值」变成「全部拒绝挂载」
        ...(options.localMountRoots?.length ? { allowedRoots: options.localMountRoots } : {}),
        ...(onDiagnostic ? { onDiagnostic } : {}),
      }),
    );
    this.sources.set('object_storage', this.objectSource);

    this.publishers.set('git', new GitPublisher(this.gitSource, { ...(onDiagnostic ? { onDiagnostic } : {}) }));
    this.publishers.set('none', new NonePublisher());

    this.hasArchive = Boolean(options.archiveRoot);
    if (options.archiveRoot) {
      this.publishers.set(
        'local',
        new LocalPublisher({ archiveRoot: options.archiveRoot, ...(onDiagnostic ? { onDiagnostic } : {}) }),
      );
    }
  }

  private get root(): string {
    return workspaceRoot(this.options.root);
  }

  registerSource(source: SourceMaterializer): void {
    this.sources.set(source.kind, source);
  }

  registerPublisher(publisher: Publisher): void {
    this.publishers.set(publisher.kind, publisher);
  }

  /**
   * 派发前调用。返回 null 的 workspace 表示「这个任务不需要任何外部资源」，
   * 是合法情况（调研、纯文档类任务），不是错误。
   */
  async acquire(input: AcquireInput): Promise<AcquireResult> {
    const repoScopes = input.permissions.resourceScopes.filter(
      (s) => s.kind === 'repo' && s.access !== 'none',
    );
    const dataScopes = input.permissions.resourceScopes.filter(
      (s) => s.kind === 'dataset' && s.access !== 'none',
    );
    if (repoScopes.length === 0 && dataScopes.length === 0) {
      return { ok: true, workspace: null, note: '该 Agent 未授予任何仓库或数据集范围，本次不供给工作区' };
    }

    if (repoScopes.length > 0) {
      const ready = await this.gitSource.ensureReady();
      if (!ready.ok) return { ok: false, reason: `工作区供给不可用：${ready.problem}` };
    }

    const repos = await this.loadRepos(input, repoScopes);
    const stores = await this.loadStores(input, dataScopes);

    const missingRepos = repoScopes.filter((s) => !repos.has(s.ref)).map((s) => s.ref);
    const missingStores = dataScopes.filter((s) => !stores.has(s.ref)).map((s) => s.ref);
    const missing = [...missingRepos, ...missingStores];
    const resolvable = repoScopes.length + dataScopes.length - missing.length;

    if (resolvable === 0) {
      /**
       * ★ 「授权了资源但资源没登记」必须是硬失败。
       *   放行的话 Agent 会在一个空目录里开工，然后信心十足地报告
       *   「未找到相关代码，已创建新实现」—— 这种失败比报错难查十倍。
       *
       * ★ 报错要指到**具体哪个登记页**去补。笼统说一句「资源没登记」，
       *   管理员还得自己猜是去代码仓库那页还是存储目标那页。
       */
      const parts: string[] = [];
      if (missingRepos.length) {
        parts.push(`${missingRepos.join('、')} 没有在「代码仓库」里登记`);
      }
      if (missingStores.length) {
        parts.push(`${missingStores.join('、')} 没有在「存储目标」里登记`);
      }
      return { ok: false, reason: `准备工作区失败：${parts.join('；')}` };
    }

    /**
     * 主挂载：优先可写的仓库，其次可写的数据集，再次任意可解析的。
     *
     * ★ 仓库优先于数据集，是因为「交货」这件事只对主挂载做 —— 一个既挂了
     *   代码仓库又挂了数据集的任务，产出该进仓库的分支，而不是覆盖数据集。
     */
    const candidates: Array<{ scope: ResourceScope; kind: 'repo' | 'dataset' }> = [
      ...repoScopes.filter((s) => repos.has(s.ref)).map((s) => ({ scope: s, kind: 'repo' as const })),
      ...dataScopes.filter((s) => stores.has(s.ref)).map((s) => ({ scope: s, kind: 'dataset' as const })),
    ];
    const primary =
      candidates.find((c) => c.kind === 'repo' && c.scope.access === 'write') ??
      candidates.find((c) => c.scope.access === 'write') ??
      candidates[0]!;

    const writable = primary.scope.access === 'write';
    const runRoot = runDir(this.root, input.runId);

    let branch: string | null = null;
    if (primary.kind === 'repo') {
      branch = buildBranchName(repos.get(primary.scope.ref)!.branchPrefix, input.workItemTitle, input.runId);
    }

    try {
      const primaryMount = await this.mountFor(
        primary,
        repos,
        stores,
        runRoot,
        input.runId,
        'primary',
        writable,
        branch,
      );
      const mounts: Array<Mount & { targetId: string }> = [primaryMount];
      const additionalPaths: string[] = [];

      for (const candidate of candidates) {
        if (candidate.scope.ref === primary.scope.ref && candidate.kind === primary.kind) continue;
        try {
          const mount = await this.mountFor(
            candidate,
            repos,
            stores,
            runRoot,
            input.runId,
            'reference',
            false,
            null,
          );
          mounts.push(mount);
          additionalPaths.push(mount.path);
        } catch (err) {
          // 附属资源挂不上不该拖垮整个 Run，但要留痕
          this.diagnose(`附属资源 ${candidate.scope.ref} 准备失败`, err);
        }
      }

      const repo = primary.kind === 'repo' ? repos.get(primary.scope.ref)! : null;
      const workspace: RunWorkspace = {
        path: primaryMount.path,
        writable,
        additionalPaths,
        vcs:
          repo && branch
            ? {
                repoRef: repo.ref,
                branch,
                baseBranch: repo.defaultBranch,
                baseCommit: primaryMount.source.baseVersion,
              }
            : null,
      };

      await this.db
        .update(agentRuns)
        .set({
          workspace: {
            repoRef: repo?.ref ?? primary.scope.ref,
            repoId: repo?.id ?? primaryMount.targetId,
            branch: branch ?? '',
            baseBranch: repo?.defaultBranch ?? '',
            baseCommit: primaryMount.source.baseVersion,
            path: primaryMount.path,
            mounts: mounts.map((m) => ({
              path: m.path,
              role: m.role,
              writable: m.writable,
              source: m.source,
              targetId: m.targetId,
            })),
          },
        })
        .where(eq(agentRuns.id, input.runId));

      const label = primaryMount.source.label + (branch ? `@${branch}` : '');
      const note =
        (missing.length
          ? `工作区就绪（${label}）；${missing.join('、')} 未登记，已跳过`
          : `工作区就绪（${label}${writable ? '，可写' : '，只读'}）`) +
        (mounts.length > 1 ? `，另挂 ${mounts.length - 1} 个只读参考` : '');

      return { ok: true, workspace, note };
    } catch (err) {
      await this.cleanupRunDir(input.runId).catch(() => undefined);
      const message = err instanceof GitError ? err.message : errText(err);
      return { ok: false, reason: `准备工作区失败：${message}` };
    }
  }

  /**
   * Run 结束后调用：算变更集 → 核验 → 交货 → 回收挂载。
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
        branch: ws.branch || null,
      };
    }

    if (!(await exists(ws.path))) {
      await this.finishWorkspace(input.runId, ws, { headCommit: null, pushed: false, changedFiles: 0 });
      return { ...emptyRelease('工作区目录已不存在，跳过收尾'), branch: ws.branch || null };
    }

    const workspace = toWorkspace(ws, input.runId);
    const primary = workspace.mounts.find((m) => m.role === 'primary');
    const check = primary?.source.kind === 'git' ? await this.checkConfigFor(ws) : null;
    const delivery = await this.deliveryFor(ws, primary);

    const outcome = await runReleasePipeline(
      {
        sources: this.sources,
        publishers: delivery.publishers,
        ...(this.options.onDiagnostic ? { onDiagnostic: this.options.onDiagnostic } : {}),
      },
      workspace,
      {
        runId: input.runId,
        outcome: input.outcome,
        summary: input.summary,
        agentName: input.agentName,
        goal: run.goal,
      },
      {
        publisher: delivery.key,
        checkCommand: check?.command ?? null,
        checkTimeoutSeconds: check?.timeoutSeconds ?? 600,
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
      branch: git?.branch || ws.branch || null,
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
   *   （agent_runs.work_item_id 是 NOT NULL 且带外键，而规划发生在工作项
   *   存在之前，完整理由见 planning/agent-provider.ts 顶部）。而上面的
   *   acquire/release 把状态写进 agent_runs.workspace，对它没有一行可写。
   *
   *   这是抽象里唯一一处真实的耦合点，所以显式开一条路，而不是让调用方
   *   自己 mkdir 然后手工捏一个 workspace 对象 —— 后者正是此前的做法，
   *   代价是规划任务拿到一个 branch:'planning' 的假 Git 工作区。
   */
  async acquireLocal(input: {
    id: string;
    runId: string;
    path: string;
    seed?: (path: string) => Promise<void>;
    /**
     * 额外挂进来的**只读**参考资源。
     *
     * ★★ 规划 Agent 靠它才能真的读到项目文件。
     *
     *   在此之前规划 Run 只有一个空目录：写一份 BRIEF.md 进去、读一份
     *   apos-output.json 出来。也就是说「分析这个项目的需求」时，
     *   Agent 手上**没有这个项目的任何代码** —— 它只能照着需求原文编，
     *   而界面上写着「基于项目上下文分析」。
     *
     *   挂成只读是刻意的：规划不该改代码。产出仍然写在可写的主挂载
     *   （planning workspace）里，两者分开。
     */
    readOnly?: { orgId: string; projectId: string; scopes: ResourceScope[] };
  }): Promise<{ workspace: Workspace; dispatch: RunWorkspace }> {
    const source = this.sources.get('empty')!;
    const mount = await source.materialize({
      role: 'primary',
      writable: true,
      path: input.path,
      workspaceId: input.id,
      ...(input.seed ? { seed: input.seed } : {}),
    });

    const mounts: Mount[] = [mount];
    const additionalPaths: string[] = [];

    const ro = input.readOnly;
    if (ro && ro.scopes.length > 0) {
      const repoScopes = ro.scopes.filter((s) => s.kind === 'repo' && s.access !== 'none');
      const dataScopes = ro.scopes.filter((s) => s.kind === 'dataset' && s.access !== 'none');
      const loadInput = {
        runId: input.runId,
        orgId: ro.orgId,
        projectId: ro.projectId,
        workItemId: '',
        workItemTitle: '',
        permissions: { allowedTools: [], deniedTools: [], resourceScopes: ro.scopes },
      } satisfies AcquireInput;

      const repos = await this.loadRepos(loadInput, repoScopes);
      const stores = await this.loadStores(loadInput, dataScopes);
      const runRoot = runDir(this.root, input.runId);

      const candidates: Array<{ scope: ResourceScope; kind: 'repo' | 'dataset' }> = [
        ...repoScopes.filter((s) => repos.has(s.ref)).map((s) => ({ scope: s, kind: 'repo' as const })),
        ...dataScopes
          .filter((s) => stores.has(s.ref))
          .map((s) => ({ scope: s, kind: 'dataset' as const })),
      ];

      for (const candidate of candidates) {
        try {
          const extra = await this.mountFor(
            candidate,
            repos,
            stores,
            runRoot,
            input.runId,
            'reference',
            // ★ 一律 false —— 即便这个 Agent 对该资源有写权限。
            //   规划要的是「看得见」，不是「改得动」。
            false,
            null,
          );
          mounts.push(extra);
          additionalPaths.push(extra.path);
        } catch (err) {
          /**
           * ★ 参考资源挂不上不该让整次规划失败，但必须留痕 ——
           *   否则表现是「Agent 又没看代码」，而没有任何地方说得出为什么。
           */
          this.diagnose(`规划参考资源 ${candidate.scope.ref} 准备失败`, err);
        }
      }
    }

    return {
      workspace: { id: input.id, runId: input.runId, root: input.path, mounts, writable: true },
      // ★ vcs 为 null —— 这次执行真的不在版本控制下，prompt 会据此换一套说法
      dispatch: { path: input.path, writable: true, additionalPaths, vcs: null },
    };
  }

  /** 与 acquireLocal 配对。keep=true 保留目录供人事后复查 */
  async releaseLocal(
    workspace: Workspace,
    ctx: ReleaseContext,
    opts: { keep?: boolean } = {},
  ): Promise<ReleaseOutcome> {
    return runReleasePipeline(
      { sources: this.sources, publishers: this.publishers, ...(this.options.onDiagnostic ? { onDiagnostic: this.options.onDiagnostic } : {}) },
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

  // ── 后端选择 ────────────────────────────────────────────────────────

  /**
   * 交货后端由**主挂载**的来源种类决定。
   *
   * ★ local 缺归档目录时退回「不交货」而不是假装成功：LocalPublisher 的
   *   全部价值就是把东西搬到工作区之外，没有归档目录它搬不到任何地方。
   */
  private publisherFor(primary: Mount | undefined): string {
    switch (primary?.source.kind) {
      case 'git':
        return 'git';
      case 'object_storage':
        return 'object_storage';
      case 'local':
        return this.hasArchive ? 'local' : 'none';
      default:
        return 'none';
    }
  }

  /**
   * 本次收尾用哪个交货后端。
   *
   * ★★ 这里兑现的是抽象里「两头独立可选」那半边。在 `deliveryTargetId`
   *   出现之前，交货后端**只能**由主挂载的种类决定，于是
   *   「从 Git 拉代码、把生成的报告传对象存储」这种组合表达不了 ——
   *   而那正是 docs/tech/11 §2 用来说明这个设计的例子。
   *
   * ★ 配了却没生效的每一种情况都要给出**原因**（目标不存在 / 已停用 /
   *   只读 / 被挂载白名单挡住）。不给的话，用户看到的收尾说明与
   *   「本来就没配」一模一样 —— 而这两者一个是配置没生效、一个是符合预期。
   */
  private async deliveryFor(
    ws: StoredWorkspace,
    primary: Mount | undefined,
  ): Promise<{ key: string; publishers: Map<string, Publisher> }> {
    const publishers = this.publishersFor(ws);
    const fallback = { key: this.publisherFor(primary), publishers };
    if (!primary) return fallback;

    const targetId = await this.deliveryTargetIdFor(ws, primary);
    if (!targetId) return fallback;

    /**
     * ★ 指向自己 = 写回原处，就是默认语义。当成「配了个交货目标」去走
     *   deliver 那条路的话，产出会落进自己 bucket 的 `{runId}/` 子目录里，
     *   而用户的本意只是把这一栏填明确。
     */
    if (targetId === primaryTargetId(ws)) return fallback;

    const [target] = await this.db
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.id, targetId));

    const blocked = (reason: string) => {
      this.diagnose(`交货目标未生效：${reason}`);
      const map = new Map(publishers);
      map.set('none', new NonePublisher(reason));
      return { key: 'none', publishers: map };
    };

    if (!target) return blocked('配置的交货目标已不存在，产出未投递');
    if (target.status !== 'active') return blocked(`交货目标 ${target.ref} 已停用，产出未投递`);
    if (!target.writable) {
      return blocked(`交货目标 ${target.ref} 登记为只读，产出未投递`);
    }

    if (target.kind === 'object_storage') {
      const map = new Map(publishers);
      map.set(
        'object_storage',
        new ObjectStoragePublisher(this.objectSource, {
          // ★ deliver 语义下目标与挂载无关，直接给出本次的目标
          resolveStore: async () => toStore(target),
          mode: 'deliver',
          ...(this.options.onDiagnostic ? { onDiagnostic: this.options.onDiagnostic } : {}),
        }),
      );
      return { key: 'object_storage', publishers: map };
    }

    const rootPath = target.rootPath?.trim();
    if (!rootPath) return blocked(`交货目标 ${target.ref} 没有配置路径，产出未投递`);

    /**
     * ★★ 投递到宿主机目录同样要过 APOS_LOCAL_MOUNT_ROOTS。
     *
     *   那道闸此前只挡「挂进来」，而「写出去」的破坏力只大不小 ——
     *   一条指向 /etc 的登记，挂进来是泄露，写出去是覆盖。
     *   库里存意图，环境里存闸门，这一条对两个方向都成立。
     */
    if (!isMountRootAllowed(rootPath, this.options.localMountRoots)) {
      return blocked(
        `交货目标 ${target.ref} 的路径不在 APOS_LOCAL_MOUNT_ROOTS 允许的范围内，产出未投递`,
      );
    }

    const map = new Map(publishers);
    map.set(
      'local',
      new LocalPublisher({
        archiveRoot: rootPath,
        ...(this.options.onDiagnostic ? { onDiagnostic: this.options.onDiagnostic } : {}),
      }),
    );
    return { key: 'local', publishers: map };
  }

  /** 主挂载对应的那条登记上配的交货目标 */
  private async deliveryTargetIdFor(
    ws: StoredWorkspace,
    primary: Mount,
  ): Promise<string | null> {
    const registrationId = primaryTargetId(ws);
    if (!registrationId) return null;

    if (primary.source.kind === 'git') {
      const [repo] = await this.db
        .select({ deliveryTargetId: repositories.deliveryTargetId })
        .from(repositories)
        .where(eq(repositories.id, registrationId));
      return repo?.deliveryTargetId ?? null;
    }

    if (primary.source.kind === 'object_storage' || primary.source.kind === 'local') {
      const [row] = await this.db
        .select({ deliveryTargetId: storageTargets.deliveryTargetId })
        .from(storageTargets)
        .where(eq(storageTargets.id, registrationId));
      return row?.deliveryTargetId ?? null;
    }

    // empty 工作区没有登记，也就没有可配的交货目标
    return null;
  }

  // ── DB 适配（providers 包声明的三个注入口）────────────────────────

  private async loadRemote(id: string): Promise<GitRemoteDescriptor | null> {
    const [row] = await this.db.select().from(repositories).where(eq(repositories.id, id));
    return row ? toRemote(row) : null;
  }

  private async pinHostKey(id: string, knownHosts: string): Promise<void> {
    await this.db
      .update(repositories)
      .set({ sshKnownHosts: knownHosts, updatedAt: new Date() })
      .where(eq(repositories.id, id));
  }

  /**
   * 本次收尾用的交货后端。
   *
   * ★★ 对象存储那一支必须**按次构造**，不能像 git 那样全局注册一个。
   *
   *   交货时挂载点上只剩快照键，要拿它换回 endpoint 与凭证就得知道
   *   `targetId` —— 而那个映射在本次 Run 落库的挂载清单里。做成全局单例
   *   就得往实例上挂一个「当前是哪个 Run」的可变字段，而 supervisor 判超时
   *   与事件流报 run_ended 本来就会并发进来：两次收尾一交错，
   *   一个 Run 的产出就会传到另一个 Run 的 bucket 里。
   *
   *   闭包捕获本次的挂载清单，天然没有这个问题。
   */
  private publishersFor(ws: StoredWorkspace): Map<string, Publisher> {
    const byIdentifier = new Map(
      (ws.mounts ?? [])
        .filter((m) => m.source?.identifier && m.targetId)
        .map((m) => [m.source!.identifier, m.targetId!] as const),
    );

    const perRun = new Map(this.publishers);
    perRun.set(
      'object_storage',
      new ObjectStoragePublisher(this.objectSource, {
        resolveStore: async (mount) => {
          const targetId = byIdentifier.get(mount.source.identifier);
          if (!targetId) return null;
          const [row] = await this.db
            .select()
            .from(storageTargets)
            .where(eq(storageTargets.id, targetId));
          return row ? toStore(row) : null;
        },
        ...(this.options.onDiagnostic ? { onDiagnostic: this.options.onDiagnostic } : {}),
      }),
    );
    return perRun;
  }

  // ── 内部 ────────────────────────────────────────────────────────────

  private async loadRepos(input: AcquireInput, scopes: ResourceScope[]) {
    if (scopes.length === 0) return new Map<string, typeof repositories.$inferSelect>();
    const rows = await this.db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.orgId, input.orgId),
          inArray(repositories.ref, scopes.map((s) => s.ref)),
          eq(repositories.status, 'active'),
          // 项目级仓库只对本项目可见；org 级（projectId 为空）对全组织可见
          or(isNull(repositories.projectId), eq(repositories.projectId, input.projectId)),
        ),
      );
    return new Map(rows.map((r) => [r.ref, r]));
  }

  private async loadStores(input: AcquireInput, scopes: ResourceScope[]) {
    if (scopes.length === 0) return new Map<string, typeof storageTargets.$inferSelect>();
    const rows = await this.db
      .select()
      .from(storageTargets)
      .where(
        and(
          eq(storageTargets.orgId, input.orgId),
          inArray(storageTargets.ref, scopes.map((s) => s.ref)),
          eq(storageTargets.status, 'active'),
          or(isNull(storageTargets.projectId), eq(storageTargets.projectId, input.projectId)),
        ),
      );
    return new Map(rows.map((r) => [r.ref, r]));
  }

  private async mountFor(
    candidate: { scope: ResourceScope; kind: 'repo' | 'dataset' },
    repos: Map<string, typeof repositories.$inferSelect>,
    stores: Map<string, typeof storageTargets.$inferSelect>,
    runRoot: string,
    runId: string,
    role: 'primary' | 'reference',
    writable: boolean,
    branch: string | null,
  ): Promise<Mount & { targetId: string }> {
    const path = join(runRoot, candidate.scope.ref);
    const source = this.sources;

    if (candidate.kind === 'repo') {
      const repo = repos.get(candidate.scope.ref)!;
      // ★ 不给 branch = 挂 detached：参考挂载的内容与基线相同，分支纯属垃圾
      const mount = await source.get('git')!.materialize({
        role,
        writable,
        path,
        remote: toRemote(repo),
        ...(branch ? { branch } : {}),
        workspaceId: runId,
      });
      return { ...mount, targetId: repo.id };
    }

    const target = stores.get(candidate.scope.ref)!;
    if (target.kind === 'object_storage') {
      const mount = await source.get('object_storage')!.materialize({
        role,
        writable: writable && target.writable,
        path,
        store: toStore(target),
        workspaceId: runId,
      });
      return { ...mount, targetId: target.id };
    }

    const mount = await source.get('local')!.materialize({
      role,
      writable: writable && target.writable,
      path,
      dir: toLocalDir(target),
      workspaceId: runId,
    });
    return { ...mount, targetId: target.id };
  }

  /** 质量核验命令来自仓库登记；非 git 的主挂载没有这个概念 */
  private async checkConfigFor(
    ws: StoredWorkspace,
  ): Promise<{ command: string | null; timeoutSeconds: number } | null> {
    const targetId = primaryTargetId(ws);
    if (!targetId) return null;
    const [repo] = await this.db.select().from(repositories).where(eq(repositories.id, targetId));
    if (!repo) return null;
    return { command: repo.checkCommand, timeoutSeconds: repo.checkTimeoutSeconds };
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

  private diagnose(message: string, detail?: unknown) {
    this.options.onDiagnostic?.(message, detail);
  }

}

/** 落库的工作区记录 → 抽象的 Workspace */
function toWorkspace(ws: StoredWorkspace, runId: string): Workspace {
  const stored = ws.mounts?.length
    ? ws.mounts
    : // 滚动发布窗口里可能还有老进程写的老结构行（迁移 0020 已回填历史数据）
      [{ path: ws.path, repoId: ws.repoId, role: 'primary' as const }];

  const mounts: Mount[] = stored.map((m) => ({
    path: m.path,
    role: m.role,
    writable: m.writable ?? m.role === 'primary',
    source: m.source ?? {
      kind: 'git' as const,
      identifier: m.repoId ?? m.targetId ?? ws.repoId,
      label: ws.repoRef,
      baseVersion: m.role === 'primary' ? ws.baseCommit : null,
    },
  }));
  return { id: runId, runId, root: ws.path, mounts, writable: true };
}

function primaryTargetId(ws: StoredWorkspace): string | null {
  const primary = ws.mounts?.find((m) => m.role === 'primary');
  return primary?.targetId ?? primary?.repoId ?? ws.repoId ?? null;
}

function toRemote(repo: typeof repositories.$inferSelect): GitRemoteDescriptor {
  return {
    id: repo.id,
    ref: repo.ref,
    remoteUrl: repo.remoteUrl,
    defaultBranch: repo.defaultBranch,
    credentialRef: repo.credentialRef,
    authUsername: repo.authUsername,
    sshKnownHosts: repo.sshKnownHosts,
  };
}

function toStore(row: typeof storageTargets.$inferSelect): ObjectStoreDescriptor {
  return {
    id: row.id,
    ref: row.ref,
    endpoint: row.endpoint ?? '',
    region: row.region,
    bucket: row.bucket ?? '',
    prefix: row.prefix,
    forcePathStyle: row.forcePathStyle,
    credentialRef: row.credentialRef,
  };
}

function toLocalDir(row: typeof storageTargets.$inferSelect): LocalDirDescriptor {
  return { id: row.id, ref: row.ref, rootPath: row.rootPath ?? '' };
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

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type { StoredMount };
