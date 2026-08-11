import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Database } from '@apos/db';
import type { ChangeSet, Mount } from '@apos/contracts';
import { git, GitError, probeGit } from '../git';
import { withRepoAuth } from '../credentials';
import { mirrorDir } from '../paths';
import type { MountSpec, RepoRow, SourceMaterializer } from './types';

/**
 * Git 铺料后端。
 *
 * ★ 为什么是「镜像 + worktree」而不是「每个 Run 各 clone 一次」：
 *   clone 一个中等仓库要几十秒到几分钟，而调度器可能一分钟派发十几个 Run。
 *   镜像只在第一次建立，之后每个 Run 从共享对象库挂一棵独立工作树，
 *   耗时是毫秒级，且**天然隔离**。
 */
export class GitMaterializer implements SourceMaterializer {
  readonly kind = 'git' as const;

  /** 每个仓库一条串行链：并发的 Run 不能同时更新同一个镜像 */
  private mirrorLocks = new Map<string, Promise<unknown>>();
  private gitReady: Promise<{ ok: boolean; problem: string | null }> | null = null;

  constructor(
    private readonly db: Database,
    private readonly options: {
      root: string;
      onDiagnostic?: (message: string, detail?: unknown) => void;
    },
  ) {}

  /** git 可用性只探一次，结果缓存 —— 每次派发都跑一遍 `git --version` 是浪费 */
  async ensureReady(): Promise<{ ok: boolean; problem: string | null }> {
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
   * 建/更新镜像 → 挂工作树。
   *
   * ★ 只读挂载走 detached，不建分支：内容与基线完全相同，而
   *   `worktree remove` 不删分支 —— 建了就是按「Run 数 × 参考仓库数」
   *   在镜像里永久堆积垃圾。
   */
  async materialize(spec: MountSpec): Promise<Mount> {
    const repo = spec.repo;
    if (!repo) throw new GitError('git 挂载缺少仓库信息', ['materialize'], '');

    const mirror = mirrorDir(this.options.root, repo.id);

    /**
     * ★ 认证上下文包住整段镜像操作。
     *
     *   SSH 那条路 ssh-agent 是个进程，起点终点必须成对；把它包在这里，
     *   clone/fetch 共用同一个 agent，也就只喂一次私钥。
     */
    const baseCommit = await withRepoAuth(this.db, repo, (auth) =>
      this.withMirrorLock(repo.id, async () => {
        if (await exists(mirror)) {
          await git.updateMirror(mirror, auth);
        } else {
          await mkdir(dirname(mirror), { recursive: true });
          await git.mirror(repo.remoteUrl, mirror, auth);
        }
        // 上一轮异常退出可能留下失效的工作树登记
        await git.pruneWorktrees(mirror);
        return git.resolveRef(mirror, repo.defaultBranch);
      }),
    );

    if (!baseCommit) {
      throw new GitError(
        `仓库 ${repo.ref} 里找不到默认分支 ${repo.defaultBranch}`,
        ['rev-parse'],
        '',
      );
    }

    await mkdir(dirname(spec.path), { recursive: true });
    await this.withMirrorLock(repo.id, () =>
      spec.branch
        ? git.addWorktree(mirror, spec.path, spec.branch, baseCommit)
        : git.addDetachedWorktree(mirror, spec.path, baseCommit),
    );

    return {
      path: spec.path,
      role: spec.role,
      writable: spec.writable,
      source: {
        kind: 'git',
        // ★ 寻址用 id：仓库改名不该让本地对象库作废（见 paths.ts）
        identifier: repo.id,
        label: repo.ref,
        baseVersion: baseCommit,
      },
    };
  }

  /**
   * 相对 baseCommit 的变更集。
   *
   * ★ 这里是「基线 + 变更集」在 Git 上的具体形态。抽象保留这个概念而不是
   *   退化成「扫描目录里有什么」，收益就在这一行：一个仓库检出有几万个文件，
   *   而 Agent 改了 3 个 —— 报出来的必须是那 3 个。
   */
  async diff(mount: Mount): Promise<ChangeSet> {
    const entries = await git.statusEntries(mount.path);
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    for (const { code, file } of entries) {
      // 两位状态码：索引态 + 工作区态。删除只要任一位是 D 且不是「删了又建」
      if (code === '??' || code[0] === 'A') added.push(file);
      else if (code.includes('D')) deleted.push(file);
      else modified.push(file);
    }

    return {
      added,
      modified,
      deleted,
      total: added.length + modified.length + deleted.length,
      truncated: false,
    };
  }

  async dispose(mount: Mount, opts: { keep?: boolean } = {}): Promise<void> {
    const mirror = mirrorDir(this.options.root, mount.source.identifier);
    try {
      await git.removeWorktree(mirror, mount.path);
    } catch {
      // 工作树登记已经没了（或从来没建成）—— 目录还在的话直接删
      if (!opts.keep) await rm(mount.path, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * 删掉镜像里的本地分支。
   *
   * ★ 只在推送成功之后调用，且必须在工作树回收**之后** —— git 拒绝删除
   *   一个正被工作树检出的分支。这就是它没有做进 dispose 或 publish
   *   任何一方的原因：它跨在两者中间。
   */
  async deleteBranch(repoId: string, branch: string): Promise<void> {
    await git.deleteBranch(mirrorDir(this.options.root, repoId), branch);
  }

  /** 仓库行，交货方要用它的 remoteUrl 与凭证 */
  async loadRepo(repoId: string): Promise<RepoRow | null> {
    const { repositories } = await import('@apos/db');
    const { eq } = await import('drizzle-orm');
    const [row] = await this.db.select().from(repositories).where(eq(repositories.id, repoId));
    return row ?? null;
  }
}

async function exists(path: string): Promise<boolean> {
  const { stat } = await import('node:fs/promises');
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
