import type { repositories } from '@apos/db';
import { resolveSecret } from '../security/secrets';
import { isHttpRemote, resolveAuthUsername, type GitAuth } from './git';

type RepoRow = typeof repositories.$inferSelect;

/**
 * 仓库行 → git 认证。
 *
 * ★★ 用户名占位必须跟着走，不能恒为 `x-access-token`。
 *
 *   在此之前 provisioner 只传 token，`git.ts` 一律回落到 GitHub 的写法 ——
 *   GitLab 私有仓库因此从来没通过。而失败发生在派发那一刻，
 *   报错只说「认证失败」，没有任何东西指向真实原因。
 *
 * ★ ssh:// 与 git@ 形态不返回认证：token 对它们没有意义，
 *   传了只会在 http.extraHeader 里挂一个永远用不到的头。
 *   那类地址走宿主机的 SSH 配置 —— 平台目前不管理 SSH key，
 *   这一点会在配置页上如实说出来。
 *
 * ★ 单独一个文件而不是留在 provisioner 里：配置页的连通性探测
 *   也要用它，而两处各写一份的话，「探测通过但派发失败」
 *   会是最难解释的一种故障 —— 用户刚刚看到绿灯。
 */
export function gitAuthFor(
  repo: Pick<RepoRow, 'credentialRef' | 'remoteUrl' | 'authUsername'>,
): GitAuth | undefined {
  const token = resolveSecret(repo.credentialRef);
  if (!token) return undefined;
  if (!isHttpRemote(repo.remoteUrl)) return undefined;
  return { token, username: resolveAuthUsername(repo.remoteUrl, repo.authUsername).username };
}
