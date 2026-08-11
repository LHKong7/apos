import type { Database } from '@apos/db';
import type { ChangeSet, PublishResult, Workspace } from '@apos/contracts';
import { git } from '../git';
import { withRepoAuth } from '../credentials';
import type { GitMaterializer } from '../sources/git';
import type { Publisher, ReleaseContext } from './types';

const OUTCOME_LABEL: Record<ReleaseContext['outcome'], string> = {
  completed: '成功',
  failed: '失败',
  terminated: '被终止',
  timeout: '超时',
};

/**
 * Git 交货后端：提交 →（成功才）推送。
 *
 * ★ 失败的 Run 会本地提交但不推送：改动留在镜像的分支里可以事后捞，
 *   远端不会被半成品分支淹没。想推的话设 APOS_WORKSPACE_PUSH_ON_FAILURE=true。
 */
export class GitPublisher implements Publisher {
  readonly kind = 'git' as const;

  constructor(
    private readonly db: Database,
    private readonly source: GitMaterializer,
    private readonly options: { onDiagnostic?: (message: string, detail?: unknown) => void } = {},
  ) {}

  async publish(ws: Workspace, changes: ChangeSet, ctx: ReleaseContext): Promise<PublishResult> {
    const primary = ws.mounts.find((m) => m.role === 'primary');
    if (!primary) {
      return { kind: 'git', branch: '', headCommit: null, pushed: false, url: null, note: '没有主挂载' };
    }

    /**
     * ★ 分支名从工作树自己读，而不是从落库的状态里取。
     *   工作树的 HEAD 是这件事的**事实来源**；存的那份只是副本，
     *   而副本和事实不一致时（比如收尾逻辑改过一轮）按副本推会推错分支。
     */
    const branch = (await git.currentBranch(primary.path)) ?? '';
    const repo = await this.source.loadRepo(primary.source.identifier);
    const notes: string[] = [];

    let headCommit: string | null = null;
    let pushed = false;

    if (changes.total > 0) {
      headCommit = await git.commitAll(
        primary.path,
        commitMessage(ctx, changes.total),
        // ★ 提交署名标成 Agent，不是平台也不是某个人 ——
        //   `git log` 里必须一眼看出这是机器改的
        { name: `${ctx.agentName} (APOS Agent)`, email: 'agent@apos.local' },
      );
      notes.push(`已提交 ${changes.total} 处改动`);
    } else {
      notes.push('Agent 未改动任何文件');
    }

    const shouldPush =
      headCommit !== null &&
      (ctx.outcome === 'completed' || process.env['APOS_WORKSPACE_PUSH_ON_FAILURE'] === 'true');

    if (shouldPush && repo && branch) {
      try {
        await withRepoAuth(this.db, repo, (auth) =>
          git.push(primary.path, repo.remoteUrl, branch, auth),
        );
        pushed = true;
        notes.push(`已推送分支 ${branch}`);
      } catch (err) {
        // 推送失败不能让 Run 从成功翻成失败 —— 改动还在镜像里，可以人工补推
        notes.push(`推送失败（改动已保留在本地分支 ${branch}）：${errText(err)}`);
        this.options.onDiagnostic?.('推送失败', err);
      }
    } else if (headCommit !== null && !pushed) {
      notes.push(`执行未成功，改动只保留在本地分支 ${branch}，未推送`);
    }

    return {
      kind: 'git',
      branch,
      headCommit,
      pushed,
      url: repo ? branchUrl(repo.remoteUrl, branch) : null,
      note: notes.join('；'),
    };
  }

  /**
   * 推送成功后删掉镜像里的本地分支：远端已有一份，本地这份没有留存价值，
   * 而不删就是按 Run 的速度无上限堆积。未推送的**不删** —— 那是失败改动
   * 唯一的载体。逃生阀 APOS_WORKSPACE_KEEP_LOCAL_BRANCHES=true。
   */
  async finalize(ws: Workspace, result: PublishResult): Promise<void> {
    if (result.kind !== 'git' || !result.pushed || !result.branch) return;
    if (process.env['APOS_WORKSPACE_KEEP_LOCAL_BRANCHES'] === 'true') return;

    const primary = ws.mounts.find((m) => m.role === 'primary');
    if (!primary) return;

    await this.source.deleteBranch(primary.source.identifier, result.branch).catch((err) => {
      this.options.onDiagnostic?.(`镜像分支 ${result.branch} 未能清理`, err);
    });
  }
}

function commitMessage(ctx: ReleaseContext, changedFiles: number): string {
  const status = ctx.outcome === 'completed' ? '' : `（执行${OUTCOME_LABEL[ctx.outcome]}，改动未完成）`;
  return [
    `${ctx.goal}${status}`,
    '',
    ctx.summary.slice(0, 2000),
    '',
    `Run: ${ctx.runId}`,
    `Files: ${changedFiles}`,
    `Co-Authored-By: ${ctx.agentName} <agent@apos.local>`,
  ].join('\n');
}

/**
 * git remote → 可点开的分支页面。认不出来的 host 就不给链接，不编。
 *
 * ★ 这段知识属于 Git 交货方，此前散在产物落库那一侧 —— 于是「产物落库」
 *   这个后端无关的步骤里混着 GitHub/GitLab 的 URL 拼法。
 */
export function branchUrl(remoteUrl: string, branch: string): string | null {
  if (!branch) return null;
  const m = remoteUrl.match(/(?:https?:\/\/|git@)([^/:]+)[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (!m) return null;
  const [, host, owner, repo] = m;
  if (host?.includes('github')) return `https://${host}/${owner}/${repo}/tree/${branch}`;
  if (host?.includes('gitlab')) return `https://${host}/${owner}/${repo}/-/tree/${branch}`;
  return null;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
