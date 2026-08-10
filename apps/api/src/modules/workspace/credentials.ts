import { eq } from 'drizzle-orm';
import { repositories, type Database } from '@apos/db';
import { resolveSecret } from '../security/secrets';
import { isHttpRemote, resolveAuthUsername, type GitAuth } from './git';
import { SshError, sshCommand, withSshAgent } from './ssh';

type RepoRow = typeof repositories.$inferSelect;

/** 认证需要用到的那几列 —— 探测与派发共用，别各查各的 */
export type AuthRepo = Pick<
  RepoRow,
  'id' | 'credentialRef' | 'remoteUrl' | 'authUsername' | 'sshKnownHosts'
>;

/**
 * 在正确的认证上下文里跑一段 git 操作。
 *
 * ★★ 做成「包一段」而不是「返回一个 auth 对象」，是因为 SSH 认证有生命周期：
 *   ssh-agent 是一个进程，必须有明确的起点和终点。返回对象的写法会让
 *   「谁负责 kill 它」变成每个调用方各自回答的问题 —— 而漏掉一次的表现是
 *   一个握着私钥的进程永远留在那里。
 *
 * ★ HTTP 那条路没有生命周期，但也走同一个函数：两条路径分叉的话，
 *   总有一处只改了其中一条（这次修 GitLab 就是在还这笔债）。
 *
 * ★ 首次 SSH 连接会 TOFU 学到主机公钥，结束时固定进库（见 pinHostKey）。
 */
export async function withRepoAuth<T>(
  db: Database,
  repo: AuthRepo,
  fn: (auth: GitAuth | undefined) => Promise<T>,
): Promise<T> {
  const secret = resolveSecret(repo.credentialRef);

  if (isHttpRemote(repo.remoteUrl)) {
    if (!secret) return fn(undefined);
    return fn({
      kind: 'basic',
      token: secret,
      username: resolveAuthUsername(repo.remoteUrl, repo.authUsername).username,
    });
  }

  /**
   * ★ ssh 地址没配私钥时不报错，交给宿主机的 SSH 配置。
   *
   *   部署在有 ssh-agent / ~/.ssh 的机器上是合法用法，此前也一直是
   *   唯一能用的方式。这里只负责「配了私钥就用私钥」。
   */
  if (!secret) return fn(undefined);

  const pinned = Boolean(repo.sshKnownHosts?.trim());

  return withSshAgent({ privateKey: secret, knownHosts: repo.sshKnownHosts }, async (session) => {
    const result = await fn({
      kind: 'ssh',
      authSock: session.authSock,
      sshCommand: sshCommand(session, pinned),
    });

    // 连上之后立刻固定 —— TOFU 的窗口只应该有第一次那一下
    if (!pinned) await pinHostKey(db, repo.id, await session.readKnownHosts());

    return result;
  });
}

/**
 * 把首次连接学到的主机公钥固定下来。
 *
 * ★★ 不固定的话 `accept-new` 等于 `no`。
 *
 *   每次连接都用一个全新的临时 known_hosts，"未知主机" 这个条件
 *   就永远成立，accept-new 于是每次都放行 —— 中间人换掉主机公钥
 *   也照连不误。TOFU 要成立，第一次学到的东西必须留下来。
 *
 * ★ 只在没固定过时写，且写完之后这个仓库就转入严格校验。
 *   管理员也可以在配置页上预先填好（更强），或者清空以重新学习
 *   （比如服务器真的换了密钥）。
 */
async function pinHostKey(db: Database, repoId: string, learned: string): Promise<void> {
  const content = learned.trim();
  if (!content) return;

  await db
    .update(repositories)
    .set({ sshKnownHosts: content, updatedAt: new Date() })
    .where(eq(repositories.id, repoId));
}

/** 判定这个远端用哪种认证 —— 界面上要按它渲染不同的字段 */
export function authKindOf(remoteUrl: string): 'token' | 'ssh_key' {
  return isHttpRemote(remoteUrl) ? 'token' : 'ssh_key';
}

export { SshError };
