import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTH_USERNAME,
  hostOf,
  isHttpRemote,
  resolveAuthUsername,
} from './git';

/**
 * 凭证的 Basic 用户名占位（docs/tech/09-security.md）。
 *
 * ★★ 这一项填错的表现是 401，而 401 的报错里没有任何东西指向它 ——
 *   所以它的判定必须被钉死，不能靠「跑一次试试」。
 */

describe('resolveAuthUsername', () => {
  it('GitHub 用 x-access-token', () => {
    expect(resolveAuthUsername('https://github.com/acme/app.git')).toMatchObject({
      username: 'x-access-token',
      source: 'host',
      provider: 'GitHub',
    });
  });

  /**
   * ★★ 这条是这次修复的全部理由。
   *
   *   在此之前 `authFor` 只传 token，`git.ts` 一律回落到 GitHub 的写法 ——
   *   GitLab 私有仓库因此从来没通过，而 `GitAuth.username` 这个字段
   *   建了却从没有人传值。类型里留了口子而调用方不传，
   *   比没有这个口子更糟：它看起来是支持的。
   */
  it('★ GitLab 用 oauth2，不是 x-access-token', () => {
    expect(resolveAuthUsername('https://gitlab.com/acme/app.git').username).toBe('oauth2');
  });

  it('Bitbucket 用 x-token-auth', () => {
    expect(resolveAuthUsername('https://bitbucket.org/acme/app.git').username).toBe('x-token-auth');
  });

  /**
   * ★ 首段标签是服务商名的自建实例认得出来（gitlab.acme.com）。
   *   但 `git.acme.com` 不认 —— 那底下可能是 Gitea、Gogs、GitLab、
   *   Bitbucket Server，猜错就是 401。认不出来就如实说认不出来，
   *   比猜一个更有用。
   */
  it('★ 自建实例按首段标签认（gitlab.acme.com 是 GitLab）', () => {
    expect(resolveAuthUsername('https://gitlab.acme.com/team/app.git')).toMatchObject({
      username: 'oauth2',
      source: 'host',
      provider: 'GitLab',
    });
    expect(resolveAuthUsername('https://github.acme.com/team/app.git').username).toBe(
      'x-access-token',
    );
  });

  it('★ git.acme.com 不猜 —— 底下可能是任何一家', () => {
    expect(resolveAuthUsername('https://git.acme.com/team/app.git').source).toBe('default');
  });

  /**
   * ★ 自建 GitLab 装在 git.acme.com 上是最常见的部署形态，
   *   而它推断不出来 —— 这正是必须留一个显式字段的理由。
   *   兜底沿用 GitHub 的写法（不改默认值，否则现有 GitHub 仓库会一起变），
   *   但 source='default' 会让配置页打出警告。
   */
  it('★ 认不出的域名回落到默认值，并标明来源是兜底', () => {
    expect(resolveAuthUsername('https://git.acme.internal/team/app.git')).toEqual({
      username: DEFAULT_AUTH_USERNAME,
      source: 'default',
      provider: null,
    });
  });

  it('★ 显式指定永远优先，连域名都不看', () => {
    expect(resolveAuthUsername('https://github.com/acme/app.git', 'oauth2')).toEqual({
      username: 'oauth2',
      source: 'explicit',
      provider: null,
    });
  });

  it('显式值是空白时当没填', () => {
    expect(resolveAuthUsername('https://gitlab.com/a/b.git', '   ').source).toBe('host');
    expect(resolveAuthUsername('https://gitlab.com/a/b.git', null).source).toBe('host');
  });
});

describe('hostOf', () => {
  it('认得 https 与 scp 两种写法', () => {
    expect(hostOf('https://github.com/acme/app.git')).toBe('github.com');
    expect(hostOf('git@gitlab.com:acme/app.git')).toBe('gitlab.com');
    expect(hostOf('ssh://git@git.acme.com:2222/team/app.git')).toBe('git.acme.com');
  });

  it('大小写归一 —— 域名不区分大小写', () => {
    expect(hostOf('https://GitHub.COM/acme/app.git')).toBe('github.com');
  });

  it('认不出来返回 null，不猜', () => {
    expect(hostOf('not a url')).toBeNull();
  });

  /** scp 形态里 git@ 前面那段是用户名，别把它当成 host */
  it('★ scp 写法取冒号前的域名，不是 @ 前的用户名', () => {
    expect(hostOf('git@github.com:owner/repo.git')).toBe('github.com');
  });
});

describe('isHttpRemote', () => {
  /**
   * ★ token 对 ssh 地址没有意义。分辨这一点是为了两件事：
   *   不给 ssh 挂一个永远用不到的 Authorization 头，
   *   以及在配置页上如实说明「这里配的凭证不会被用上」。
   */
  it('只有 http/https 走 Basic 认证', () => {
    expect(isHttpRemote('https://github.com/a/b.git')).toBe(true);
    expect(isHttpRemote('http://git.internal/a/b.git')).toBe(true);
    expect(isHttpRemote('git@github.com:a/b.git')).toBe(false);
    expect(isHttpRemote('ssh://git@github.com/a/b.git')).toBe(false);
  });
});
