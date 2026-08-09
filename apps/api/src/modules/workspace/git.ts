import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitAuth {
  /** 明文 token；只在内存里活到本次调用结束 */
  token: string | null;
  /** HTTPS token 的用户名占位，GitHub 用 x-access-token，GitLab 用 oauth2 */
  username?: string;
}

/**
 * git 调用封装。
 *
 * ★ 凭证通过 `GIT_CONFIG_*` 环境变量注入，不是三种更常见的做法：
 *
 *   - 拼进 remote URL → 会被 `git remote -v` 读出来、会写进 .git/config，
 *     而 .git/config 就在 Agent 的工作目录里，等于把 token 交给了 Agent
 *   - `-c http.extraHeader=…` → 出现在 argv，同机任何进程 `ps` 可见
 *   - credential helper 脚本 → 要落盘，清理时机难保证
 *
 *   环境变量这条路 token 既不进 argv 也不落盘，且子进程环境是我们自己
 *   构造的最小集合（见 provisioner 的 childEnv）。要求 git ≥ 2.31。
 */
async function run(
  args: string[],
  opts: { cwd?: string; auth?: GitAuth; timeoutMs?: number } = {},
): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    // 非交互：凭证不对时立刻失败，而不是挂在那里等人输密码
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
  };

  if (opts.auth?.token) {
    const user = opts.auth.username ?? 'x-access-token';
    const basic = Buffer.from(`${user}:${opts.auth.token}`).toString('base64');
    env['GIT_CONFIG_COUNT'] = '1';
    env['GIT_CONFIG_KEY_0'] = 'http.extraHeader';
    env['GIT_CONFIG_VALUE_0'] = `Authorization: Basic ${basic}`;
  }

  try {
    const { stdout } = await exec('git', args, {
      cwd: opts.cwd,
      env,
      timeout: opts.timeoutMs ?? 300_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const stderr = (e.stderr ?? '').trim();
    // ★ 报错里绝不能带上 env —— 那里有 token
    throw new GitError(
      `git ${args[0]} 失败：${redact(stderr) || e.message || '未知错误'}`,
      args,
      redact(stderr),
    );
  }
}

/** 万一 remote URL 里真的带了凭证（用户手填的），别让它进日志 */
function redact(text: string): string {
  return text.replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//***:***@');
}

export const git = {
  run,

  async version(): Promise<string> {
    return run(['--version']);
  },

  /** 裸镜像，作为本地对象缓存。已存在时只更新 */
  async mirror(remoteUrl: string, dir: string, auth?: GitAuth): Promise<void> {
    await run(['clone', '--mirror', remoteUrl, dir], { auth, timeoutMs: 600_000 });
  },

  async updateMirror(dir: string, auth?: GitAuth): Promise<void> {
    await run(['remote', 'update', '--prune'], { cwd: dir, auth, timeoutMs: 600_000 });
  },

  async resolveRef(dir: string, ref: string): Promise<string | null> {
    try {
      return await run(['rev-parse', ref], { cwd: dir });
    } catch {
      return null;
    }
  },

  /** 从镜像挂一个独立工作树；每个 Run 一个，互不干扰 */
  async addWorktree(
    mirrorDir: string,
    path: string,
    branch: string,
    startPoint: string,
  ): Promise<void> {
    await run(['worktree', 'add', '-b', branch, path, startPoint], { cwd: mirrorDir });
  },

  async removeWorktree(mirrorDir: string, path: string): Promise<void> {
    await run(['worktree', 'remove', '--force', path], { cwd: mirrorDir });
  },

  async pruneWorktrees(mirrorDir: string): Promise<void> {
    await run(['worktree', 'prune'], { cwd: mirrorDir });
  },

  /** 改动的文件数。0 表示 Agent 什么都没改 */
  async changedFileCount(dir: string): Promise<number> {
    const out = await run(['status', '--porcelain'], { cwd: dir });
    return out === '' ? 0 : out.split('\n').length;
  },

  async commitAll(dir: string, message: string, author: { name: string; email: string }): Promise<string | null> {
    await run(['add', '-A'], { cwd: dir });
    if ((await git.changedFileCount(dir)) === 0) return null;

    await run(
      [
        '-c',
        `user.name=${author.name}`,
        '-c',
        `user.email=${author.email}`,
        'commit',
        '--no-verify',
        '-m',
        message,
      ],
      { cwd: dir },
    );
    return run(['rev-parse', 'HEAD'], { cwd: dir });
  },

  /**
   * 推送。
   *
   * ★ 显式带上远端 URL，不走 `origin` 这个名字。
   *   工作树是从**镜像**克隆挂出来的，而 `clone --mirror` 会设
   *   `remote.origin.mirror=true` —— 这时 `git push origin a:b` 会被拒：
   *   「--mirror can't be combined with refspecs」。
   *   而这个错误发生在收尾阶段，表现是「任务成功了但远端没有分支」，
   *   极难联想到是克隆方式带来的。
   */
  async push(dir: string, remoteUrl: string, branch: string, auth?: GitAuth): Promise<void> {
    await run(['push', remoteUrl, `${branch}:${branch}`], {
      cwd: dir,
      auth,
      timeoutMs: 300_000,
    });
  },

  async head(dir: string): Promise<string | null> {
    try {
      return await run(['rev-parse', 'HEAD'], { cwd: dir });
    } catch {
      return null;
    }
  },
};

/** git 是否可用 —— 部署环境没装 git 要在启动时就说清楚，而不是第一次派发才炸 */
export async function probeGit(): Promise<{ ok: boolean; version: string | null; problem: string | null }> {
  try {
    const v = await git.version();
    const m = v.match(/(\d+)\.(\d+)/);
    const major = m ? Number(m[1]) : 0;
    const minor = m ? Number(m[2]) : 0;
    if (major < 2 || (major === 2 && minor < 31)) {
      return {
        ok: false,
        version: v,
        // 低于 2.31 没有 GIT_CONFIG_* 环境变量注入，凭证就只能进 argv 或落盘
        problem: `git 版本过低（${v}），凭证注入需要 2.31 以上`,
      };
    }
    return { ok: true, version: v, problem: null };
  } catch {
    return { ok: false, version: null, problem: '未找到 git 可执行文件' };
  }
}
