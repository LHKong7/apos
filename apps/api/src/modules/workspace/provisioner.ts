import { mkdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { agentRuns, repositories, type Database } from '@apos/db';
import type { AgentPermissions, RunWorkspace } from '@apos/contracts';
import { resolveSecret } from '../security/secrets';
import { git, GitError, probeGit, type GitAuth } from './git';

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

export interface CheckResult {
  ran: boolean;
  passed: boolean;
  command: string | null;
  /** 失败时的输出尾部，进 Run 详情供人排查 */
  output: string;
  durationMs: number;
}

export interface ReleaseResult {
  committed: boolean;
  pushed: boolean;
  headCommit: string | null;
  changedFiles: number;
  branch: string | null;
  note: string;
  /** 质量核验结果 —— reviewing 阶段唯一的真实测试数据源 */
  check: CheckResult;
}

/**
 * 工作区供给。
 *
 * ★ 为什么是「镜像 + worktree」而不是「每个 Run 各 clone 一次」：
 *   clone 一个中等仓库要几十秒到几分钟，而调度器可能一分钟派发十几个 Run。
 *   镜像只在第一次建立，之后每个 Run 从共享对象库挂一棵独立工作树，
 *   耗时是毫秒级，且**天然隔离** —— 这正是当前实现（所有 Run 共用一个
 *   AGENT_WORKSPACE_ROOT）最要命的那个问题的解法。
 *
 * ★ 失败的 Run 会本地提交但不推送：改动留在镜像的分支里可以事后捞，
 *   远端不会被半成品分支淹没。想推的话设 APOS_WORKSPACE_PUSH_ON_FAILURE=true。
 */
export class WorkspaceProvisioner {
  /** 每个仓库一条串行链：并发的 Run 不能同时更新同一个镜像 */
  private mirrorLocks = new Map<string, Promise<unknown>>();
  private gitReady: Promise<{ ok: boolean; problem: string | null }> | null = null;

  constructor(
    private readonly db: Database,
    private readonly options: {
      /** 所有工作区的根目录 */
      root?: string;
      onDiagnostic?: (message: string, detail?: unknown) => void;
    } = {},
  ) {}

  private get root(): string {
    return resolve(this.options.root ?? process.env['AGENT_WORKSPACE_ROOT'] ?? '/tmp/apos-workspaces');
  }

  private mirrorDir(repoId: string): string {
    return join(this.root, 'mirrors', `${repoId}.git`);
  }

  private runDir(runId: string): string {
    return join(this.root, 'runs', runId);
  }

  /** git 可用性只探一次，结果缓存 —— 每次派发都跑一遍 `git --version` 是浪费 */
  private async ensureGit(): Promise<{ ok: boolean; problem: string | null }> {
    this.gitReady ??= probeGit().then((r) => ({ ok: r.ok, problem: r.problem }));
    return this.gitReady;
  }

  /** 串行化同一仓库上的镜像操作 */
  private async withMirrorLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.mirrorLocks.get(repoId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // 只用来排队，不让上一个的失败污染下一个
    this.mirrorLocks.set(
      repoId,
      next.catch(() => undefined),
    );
    return next;
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

    const ready = await this.ensureGit();
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
    const path = join(this.runDir(input.runId), primary.ref);

    try {
      const baseCommit = await this.prepareWorktree(primary, path, branch);

      // 其余可读仓库各挂一棵只读工作树，供 Agent 查阅
      const additionalPaths: string[] = [];
      for (const scope of scopes) {
        if (scope.ref === primaryScope.ref) continue;
        const repo = byRef.get(scope.ref);
        if (!repo) continue;
        const extraPath = join(this.runDir(input.runId), repo.ref);
        try {
          await this.prepareWorktree(repo, extraPath, `${branch}-ref-${repo.ref}`);
          additionalPaths.push(extraPath);
        } catch (err) {
          // 附属仓库挂不上不该拖垮整个 Run，但要留痕
          this.diagnose(`附属仓库 ${repo.ref} 准备失败`, err);
        }
      }

      const workspace: RunWorkspace = {
        repoRef: primary.ref,
        path,
        branch,
        baseBranch: primary.defaultBranch,
        baseCommit,
        writable,
        additionalPaths,
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

  /** 建/更新镜像 → 挂工作树，返回基线 commit */
  private async prepareWorktree(
    repo: typeof repositories.$inferSelect,
    path: string,
    branch: string,
  ): Promise<string | null> {
    const auth = authFor(repo.credentialRef);
    const mirror = this.mirrorDir(repo.id);

    const baseCommit = await this.withMirrorLock(repo.id, async () => {
      if (await exists(mirror)) {
        await git.updateMirror(mirror, auth);
      } else {
        await mkdir(join(this.root, 'mirrors'), { recursive: true });
        await git.mirror(repo.remoteUrl, mirror, auth);
      }
      // 上一轮异常退出可能留下失效的工作树登记
      await git.pruneWorktrees(mirror);
      return git.resolveRef(mirror, repo.defaultBranch);
    });

    if (!baseCommit) {
      throw new GitError(
        `仓库 ${repo.ref} 里找不到默认分支 ${repo.defaultBranch}`,
        ['rev-parse'],
        '',
      );
    }

    await mkdir(this.runDir(''), { recursive: true }).catch(() => undefined);
    await mkdir(join(this.root, 'runs'), { recursive: true });
    await this.withMirrorLock(repo.id, () => git.addWorktree(mirror, path, branch, baseCommit));

    return baseCommit;
  }

  /**
   * Run 结束后调用：提交 → （成功才）推送 → 回收工作树。
   *
   * ★ 幂等：重复调用不会重复提交，也不会因为工作树已经没了而抛异常。
   *   run-supervisor 判超时和事件流报 run_ended 可能同时到达。
   */
  async release(input: ReleaseInput): Promise<ReleaseResult> {
    const [run] = await this.db.select().from(agentRuns).where(eq(agentRuns.id, input.runId));
    const ws = run?.workspace;

    const noCheck: CheckResult = {
      ran: false,
      passed: false,
      command: null,
      output: '',
      durationMs: 0,
    };
    const empty: ReleaseResult = {
      committed: false,
      pushed: false,
      headCommit: null,
      changedFiles: 0,
      branch: null,
      note: '本次执行没有工作区',
      check: noCheck,
    };
    if (!run || !ws) return empty;
    if (ws.headCommit !== undefined) {
      // 已经收过尾了
      return {
        committed: Boolean(ws.headCommit),
        pushed: ws.pushed === true,
        headCommit: ws.headCommit ?? null,
        changedFiles: ws.changedFiles ?? 0,
        branch: ws.branch,
        note: '工作区此前已收尾',
        check: noCheck,
      };
    }

    if (!(await exists(ws.path))) {
      await this.finishWorkspace(input.runId, ws, { headCommit: null, pushed: false, changedFiles: 0 });
      return { ...empty, branch: ws.branch, note: '工作区目录已不存在，跳过收尾' };
    }

    const [repo] = await this.db.select().from(repositories).where(eq(repositories.id, ws.repoId));

    let changedFiles = 0;
    let headCommit: string | null = null;
    let pushed = false;
    let check: CheckResult = noCheck;
    const notes: string[] = [];

    try {
      changedFiles = await git.changedFileCount(ws.path);

      /**
       * ★ 核验在提交**之前**跑，而且不管成败都提交。
       *
       *   跑在提交前，是因为要测的是 Agent 留下的工作树状态；
       *   失败也提交，是因为失败的改动同样需要被人看到 ——
       *   「测试没过所以我把代码扔了」是最糟的处置。
       */
      if (repo?.checkCommand && changedFiles > 0) {
        check = await this.runCheck(ws.path, repo.checkCommand, repo.checkTimeoutSeconds);
        notes.push(check.passed ? `质量核验通过（${repo.checkCommand}）` : `质量核验未通过（${repo.checkCommand}）`);
      }

      if (changedFiles > 0) {
        headCommit = await git.commitAll(
          ws.path,
          commitMessage(input, run.goal, changedFiles),
          // ★ 提交署名标成 Agent，不是平台也不是某个人 ——
          //   `git log` 里必须一眼看出这是机器改的
          { name: `${input.agentName} (APOS Agent)`, email: 'agent@apos.local' },
        );
        notes.push(`已提交 ${changedFiles} 处改动`);
      } else {
        notes.push('Agent 未改动任何文件');
      }

      const shouldPush =
        headCommit !== null &&
        (input.outcome === 'completed' || process.env['APOS_WORKSPACE_PUSH_ON_FAILURE'] === 'true');

      if (shouldPush && repo) {
        try {
          await git.push(ws.path, repo.remoteUrl, ws.branch, authFor(repo.credentialRef));
          pushed = true;
          notes.push(`已推送分支 ${ws.branch}`);
        } catch (err) {
          // 推送失败不能让 Run 从成功翻成失败 —— 改动还在镜像里，可以人工补推
          notes.push(`推送失败（改动已保留在本地分支 ${ws.branch}）：${errText(err)}`);
          this.diagnose('推送失败', err);
        }
      } else if (headCommit !== null && !pushed) {
        notes.push(`执行未成功，改动只保留在本地分支 ${ws.branch}，未推送`);
      }
    } catch (err) {
      notes.push(`收尾出错：${errText(err)}`);
      this.diagnose('工作区收尾出错', err);
    }

    // 无论成败都回收工作树，否则磁盘会被慢慢吃光
    try {
      await git.removeWorktree(this.mirrorDir(ws.repoId), ws.path);
    } catch {
      await rm(ws.path, { recursive: true, force: true }).catch(() => undefined);
    }
    await this.cleanupRunDir(input.runId).catch(() => undefined);

    await this.finishWorkspace(input.runId, ws, { headCommit, pushed, changedFiles });

    return {
      committed: headCommit !== null,
      pushed,
      headCommit,
      changedFiles,
      branch: ws.branch,
      note: notes.join('；'),
      check,
    };
  }

  /**
   * 在工作区里跑质量核验命令。
   *
   * ★ 命令来自仓库登记（管理员配置），与 CI 的信任模型一致。
   *   环境同样是最小集合 —— 核验脚本没有理由需要平台的数据库口令。
   */
  private async runCheck(cwd: string, command: string, timeoutSeconds: number): Promise<CheckResult> {
    const started = Date.now();
    const { spawn } = await import('node:child_process');

    return new Promise<CheckResult>((resolve) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        env: { PATH: process.env['PATH'], HOME: process.env['HOME'], CI: 'true' },
      });

      const chunks: string[] = [];
      const collect = (b: Buffer) => {
        chunks.push(b.toString());
        // 只留尾部，测试输出可能有几十兆
        if (chunks.length > 200) chunks.splice(0, chunks.length - 200);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, timeoutSeconds * 1000);

      const done = (passed: boolean, extra = '') => {
        clearTimeout(timer);
        resolve({
          ran: true,
          passed,
          command,
          output: (chunks.join('') + extra).slice(-8000),
          durationMs: Date.now() - started,
        });
      };

      child.on('close', (code) => done(code === 0));
      child.on('error', (err) => done(false, `\n无法执行核验命令：${err.message}`));
    });
  }

  private async finishWorkspace(
    runId: string,
    ws: NonNullable<typeof agentRuns.$inferSelect['workspace']>,
    result: { headCommit: string | null; pushed: boolean; changedFiles: number },
  ) {
    await this.db
      .update(agentRuns)
      .set({ workspace: { ...ws, ...result } })
      .where(eq(agentRuns.id, runId));
  }

  private async cleanupRunDir(runId: string) {
    await rm(this.runDir(runId), { recursive: true, force: true });
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

  private diagnose(message: string, detail?: unknown) {
    this.options.onDiagnostic?.(message, detail);
  }
}

function authFor(credentialRef: string | null): GitAuth | undefined {
  const token = resolveSecret(credentialRef);
  return token ? { token } : undefined;
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

function commitMessage(input: ReleaseInput, goal: string, changedFiles: number): string {
  const status = input.outcome === 'completed' ? '' : `（执行${OUTCOME_LABEL[input.outcome]}，改动未完成）`;
  return [
    `${goal}${status}`,
    '',
    input.summary.slice(0, 2000),
    '',
    `Run: ${input.runId}`,
    `Files: ${changedFiles}`,
    `Co-Authored-By: ${input.agentName} <agent@apos.local>`,
  ].join('\n');
}

const OUTCOME_LABEL: Record<ReleaseInput['outcome'], string> = {
  completed: '成功',
  failed: '失败',
  terminated: '被终止',
  timeout: '超时',
};

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
