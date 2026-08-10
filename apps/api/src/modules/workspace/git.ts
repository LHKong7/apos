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

/**
 * git 认证。两种形态互斥，由 remote 地址决定 —— 一个仓库只有一个远端，
 * 所以「用 token 还是用 key」不是配置项，是推出来的。
 */
export type GitAuth =
  | {
      kind: 'basic';
      /** 明文 token；只在内存里活到本次调用结束 */
      token: string;
      /** Basic 用户名占位，见 {@link resolveAuthUsername} */
      username: string;
    }
  | {
      kind: 'ssh';
      /** ssh-agent 的 socket —— 私钥不落盘，见 workspace/ssh.ts */
      authSock: string;
      /** 完整的 ssh 命令行（含 known_hosts 与严格程度）*/
      sshCommand: string;
    };

/**
 * HTTPS token 走 Basic 认证时的用户名占位。
 *
 * ★★ 这个值不是随便填的，各家要求不一样，填错的表现是 401 ——
 *   而 401 发生在派发时（clone 那一刻），错误信息只说「认证失败」，
 *   没有任何东西指向「用户名占位不对」这个真实原因。
 *
 * ★ 在此之前这里恒为 `x-access-token`（GitHub 的写法），
 *   `GitAuth.username` 字段建了却从没有人传值 —— 也就是说
 *   GitLab 私有仓库从来没通过。类型里留了口子而调用方不传，
 *   是比没有这个口子更糟的状态：它看起来是支持的。
 *
 * ★ 按 host 推断只覆盖公有云域名。自建 GitLab 装在 git.acme.com 上
 *   是最常见的情况，推断不出来 —— 所以登记仓库时可以显式指定，
 *   显式值永远优先。推断结果会在接口里回显，用户看得到即将用哪个。
 */
interface HostRule {
  /** 公有云域名（含子域）*/
  domain: RegExp;
  /**
   * 自建实例的首段标签。`gitlab.acme.com` 几乎必然是 GitLab ——
   * 而 `git.acme.com` 不是（Gitea / Gogs / GitLab / Bitbucket Server 都可能），
   * 所以只认服务商名本身，不认 `git`。认不出来就如实说认不出来。
   *
   * 没有自建形态的服务（Azure DevOps）不给这个字段。
   */
  selfHostedLabel?: string;
  username: string;
  provider: string;
}

const HOST_AUTH_USERNAME: HostRule[] = [
  {
    domain: /(^|\.)github\.com$/i,
    selfHostedLabel: 'github',
    username: 'x-access-token',
    provider: 'GitHub',
  },
  {
    domain: /(^|\.)gitlab\.com$/i,
    selfHostedLabel: 'gitlab',
    username: 'oauth2',
    provider: 'GitLab',
  },
  {
    domain: /(^|\.)bitbucket\.org$/i,
    selfHostedLabel: 'bitbucket',
    username: 'x-token-auth',
    provider: 'Bitbucket',
  },
  {
    domain: /(^|\.)dev\.azure\.com$/i,
    // 没有自建形态，不给 selfHostedLabel
    username: 'apos',
    provider: 'Azure DevOps',
  },
  {
    domain: /(^|\.)codeberg\.org$/i,
    selfHostedLabel: 'codeberg',
    username: 'oauth2',
    provider: 'Codeberg',
  },
];

/** 兜底沿用 GitHub 的写法 —— 改默认值会让现有 GitHub 仓库一起变，风险不对等 */
export const DEFAULT_AUTH_USERNAME = 'x-access-token';

export interface ResolvedAuthUsername {
  username: string;
  /** 'explicit' = 用户填的；'host' = 按域名认出来的；'default' = 兜底 */
  source: 'explicit' | 'host' | 'default';
  /** 认出来的服务商，用于界面提示；认不出为 null */
  provider: string | null;
}

export function resolveAuthUsername(
  remoteUrl: string,
  explicit?: string | null,
): ResolvedAuthUsername {
  const trimmed = explicit?.trim();
  if (trimmed) return { username: trimmed, source: 'explicit', provider: null };

  const host = hostOf(remoteUrl);
  const firstLabel = host?.split('.')[0];
  const hit = host
    ? HOST_AUTH_USERNAME.find(
        (h) => h.domain.test(host) || (h.selfHostedLabel && firstLabel === h.selfHostedLabel),
      )
    : undefined;
  if (hit) return { username: hit.username, source: 'host', provider: hit.provider };

  return { username: DEFAULT_AUTH_USERNAME, source: 'default', provider: null };
}

/** 从 https / ssh / scp 三种 git 地址里取 host */
export function hostOf(remoteUrl: string): string | null {
  const url = remoteUrl.trim();
  const scp = url.match(/^[\w.-]+@([^:/]+):/); // git@github.com:owner/repo.git
  if (scp) return scp[1]!.toLowerCase();
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** ssh:// 与 scp 形态都不走 HTTP Basic —— token 对它们没有意义 */
export function isHttpRemote(remoteUrl: string): boolean {
  return /^https?:\/\//i.test(remoteUrl.trim());
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

  if (opts.auth?.kind === 'basic') {
    const basic = Buffer.from(`${opts.auth.username}:${opts.auth.token}`).toString('base64');
    env['GIT_CONFIG_COUNT'] = '1';
    env['GIT_CONFIG_KEY_0'] = 'http.extraHeader';
    env['GIT_CONFIG_VALUE_0'] = `Authorization: Basic ${basic}`;
  }

  /**
   * ★ SSH 走 agent，环境里只出现 socket 路径与命令行，没有任何密钥material。
   *   `GIT_SSH_COMMAND` 里带的是 known_hosts 路径和严格程度 ——
   *   都不是秘密，进 argv/日志也无所谓。
   */
  if (opts.auth?.kind === 'ssh') {
    env['SSH_AUTH_SOCK'] = opts.auth.authSock;
    env['GIT_SSH_COMMAND'] = opts.auth.sshCommand;
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

  /**
   * 列远端分支。用于登记时的连通性探测 —— 不落盘、不改任何东西。
   *
   * ★ 探测用 ls-remote 而不是 clone：一个大仓库 clone 要几分钟，
   *   而这里要验的三件事（域名通不通、凭证对不对、默认分支在不在）
   *   ls-remote 全都能答，且是秒级。
   */
  async lsRemoteHeads(remoteUrl: string, auth?: GitAuth): Promise<string[]> {
    const out = await run(['ls-remote', '--heads', remoteUrl], { auth, timeoutMs: 60_000 });
    return out
      .split('\n')
      .map((line) => line.split('\t')[1]?.replace(/^refs\/heads\//, '') ?? '')
      .filter(Boolean);
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
