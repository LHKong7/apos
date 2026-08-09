import { ProxyAgent, fetch as undiciFetch } from 'undici';

/**
 * 走出网代理的 fetch。
 *
 * ★ 这不是为了迁就某个沙箱环境，是企业部署的常态：
 *   APOS 装在内网、出网必须过代理，是比「直连公网」更常见的情况。
 *   Node 的内置 fetch **不认 HTTPS_PROXY 环境变量**（undici 默认不读），
 *   所以不显式处理的话，装在内网的实例会表现为「所有集成都连不上」，
 *   而运维查半天会发现 curl 是通的 —— 这个差异极难自己想到。
 *
 * ★ no_proxy 要照顾到：本机的 API 与数据库不能走代理，
 *   否则连自己都连不上。
 */
export function proxyAwareFetch(env: NodeJS.ProcessEnv = process.env): typeof fetch | undefined {
  const proxyUrl =
    env['HTTPS_PROXY'] ?? env['https_proxy'] ?? env['HTTP_PROXY'] ?? env['http_proxy'];
  if (!proxyUrl) return undefined;

  const noProxy = (env['NO_PROXY'] ?? env['no_proxy'] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const agent = new ProxyAgent(proxyUrl);

  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    if (bypasses(url.hostname, noProxy)) {
      return fetch(input, init);
    }
    return undiciFetch(url, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher: agent,
    }) as unknown as Response;
  }) as typeof fetch;
}

/** 支持 `example.com`、`.example.com`、`*.example.com` 三种写法 */
export function bypasses(hostname: string, noProxy: string[]): boolean {
  const host = hostname.toLowerCase();
  return noProxy.some((entry) => {
    if (entry === '*') return true;
    const bare = entry.replace(/^\*?\./, '');
    return host === bare || host.endsWith(`.${bare}`);
  });
}
