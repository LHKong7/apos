import { isHttpRemote, resolveAuthUsername, type GitAuth } from './cli';
import { SshError, sshCommand, withSshAgent } from './ssh';
import type { GitRemoteDescriptor, HostKeyStore, SecretResolver } from '../ports';

/**
 * 在正确的认证上下文里跑一段 git 操作。
 *
 * ★★ 做成「包一段」而不是「返回一个 auth 对象」，是因为 SSH 认证有生命周期：
 *   ssh-agent 是一个进程，必须有明确的起点和终点。返回对象的写法会让
 *   「谁负责 kill 它」变成每个调用方各自回答的问题 —— 而漏掉一次的表现是
 *   一个握着私钥的进程永远留在那里。
 *
 * ★ HTTP 那条路没有生命周期，但也走同一个函数：两条路径分叉的话，
 *   总有一处只改了其中一条。
 *
 * ★ 首次 SSH 连接会 TOFU 学到主机公钥，结束时固定进 HostKeyStore。
 *
 * ★ 依赖收在 deps 里（凭证解析、公钥存放），不再直接吃一个数据库连接 ——
 *   这是这个包能被单独测、也能服务于非 git 后端的前提（见 ports.ts）。
 */
export async function withRemoteAuth<T>(
  deps: { secrets: SecretResolver; hostKeys?: HostKeyStore },
  remote: GitRemoteDescriptor,
  fn: (auth: GitAuth | undefined) => Promise<T>,
): Promise<T> {
  const secret = deps.secrets.resolve(remote.credentialRef);

  if (isHttpRemote(remote.remoteUrl)) {
    if (!secret) return fn(undefined);
    return fn({
      kind: 'basic',
      token: secret,
      username: resolveAuthUsername(remote.remoteUrl, remote.authUsername).username,
    });
  }

  /**
   * ★ ssh 地址没配私钥时不报错，交给宿主机的 SSH 配置。
   *
   *   部署在有 ssh-agent / ~/.ssh 的机器上是合法用法，此前也一直是
   *   唯一能用的方式。这里只负责「配了私钥就用私钥」。
   */
  if (!secret) return fn(undefined);

  const pinned = Boolean(remote.sshKnownHosts?.trim());

  return withSshAgent({ privateKey: secret, knownHosts: remote.sshKnownHosts }, async (session) => {
    const result = await fn({
      kind: 'ssh',
      authSock: session.authSock,
      sshCommand: sshCommand(session, pinned),
    });

    /**
     * 连上之后立刻固定 —— TOFU 的窗口只应该有第一次那一下。
     *
     * ★★ 不固定的话 `accept-new` 等于 `no`：每次连接都用一个全新的临时
     *   known_hosts，「未知主机」这个条件就永远成立，accept-new 于是每次
     *   都放行 —— 中间人换掉主机公钥也照连不误。
     */
    if (!pinned && deps.hostKeys) {
      const learned = (await session.readKnownHosts()).trim();
      if (learned) await deps.hostKeys.pin(remote.id, learned);
    }

    return result;
  });
}

/** 判定这个远端用哪种认证 —— 界面上要按它渲染不同的字段 */
export function authKindOf(remoteUrl: string): 'token' | 'ssh_key' {
  return isHttpRemote(remoteUrl) ? 'token' : 'ssh_key';
}

export { SshError };
