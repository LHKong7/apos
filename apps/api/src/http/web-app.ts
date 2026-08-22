import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { fail, sendError } from './errors';

/**
 * On a single-box deployment the API process serves the frontend build itself /
 * 单机部署时由 API 进程直接托管前端构建产物。
 *
 * ★ Why not stand up a separate nginx: SSE.
 *   The frontend's EventSource cannot send custom request headers, so authentication has to
 *   ride on same-origin — which is exactly why dev has a dedicated Vite proxy (see the comment
 *   in apps/web/vite.config.ts). Split static assets and the API onto two origins in
 *   production and the same problem comes straight back, plus a reverse proxy and CORS to
 *   configure all over again. Serving from the same process makes "same origin" true with zero
 *   configuration, and saves a container on a single box.
 *
 *   The price is that static files go through Node's event loop. At single-box scale that is
 *   not the bottleneck; anything scaling horizontally would already have a CDN or gateway in
 *   front.
 *   为什么不另起一个 nginx：SSE。
 *   前端的 EventSource 不支持自定义请求头，认证只能靠同源 —— 开发环境为此
 *   专门配了 Vite 代理（见 apps/web/vite.config.ts 的注释）。生产上如果把
 *   静态资源和 API 拆成两个 origin，同一个问题会原样回来，还要再配一遍
 *   反向代理与 CORS。同进程托管让「同源」这件事不需要任何配置就成立，
 *   单机上也少一个容器。代价是静态文件走 Node 的事件循环。单机规模下这不是瓶颈；
 *   真要横向扩起来，前面本来就会有一层 CDN 或网关。
 */
export function registerWebApp(app: FastifyInstance, distDir: string) {
  const indexFile = join(distDir, 'index.html');
  if (!existsSync(indexFile)) {
    app.log.warn(
      { distDir },
      '前端构建产物不存在，只提供 API。构建：pnpm --filter @apos/web build',
    );
    return false;
  }

  app.register(fastifyStatic, {
    root: distDir,
    // Let the notFound handler below take it, so a frontend route can be told apart from a
    // mistyped API path
    wildcard: false,
    // Build output filenames carry a content hash, so a change always changes the name — safe
    // to cache for a long time
    maxAge: '1y',
    immutable: true,

    /**
     * ★ index.html must be the exception, and it can **only** be changed here.
     *
     *   It is the one file without a hash, and its contents hard-code the asset filenames of
     *   the current build. Caching it for a year along with the `immutable` above means that
     *   after a redeploy, an existing user's browser keeps using the cached old index.html and
     *   requests a set of asset names the new build already deleted — a blank page, blank until
     *   they hard-refresh, while the server log shows nothing wrong.
     *
     *   `reply.header(...)` in the route does nothing: by the time sendFile reaches
     *   @fastify/static's internals, the plugin overwrites cache-control with its own value.
     *   Only the plugin's setHeaders can touch the copy that actually goes out.
     *
     * ★★ Do not trust @fastify/static's declared parameter type: it says ServerResponse, but at
     *   runtime what arrives is a Fastify reply (v10's index.js calls `setHeaders?.(reply, …)`).
     *   Writing `res.setHeader(...)` as the type suggests compiles fine under tsc and then 500s
     *   on every page request in production — a green typecheck does not catch this class of
     *   error, so this code follows the real runtime shape and casts explicitly.
     *   index.html 必须例外，而且**只能在这里**改。
     *   它是唯一没有 hash 的文件，内容里写死了当前这版资源的文件名。
     *   跟着上面那条 immutable 一起被缓存一年的后果是：重新部署之后，
     *   老用户的浏览器继续用缓存里的旧 index.html，去请求一批已经被
     *   新构建删掉的资源名 —— 页面白屏，且强刷之前一直白，
     *   而服务端日志上一切正常。
     *   在路由里 `reply.header(...)` 是没用的：sendFile 走到
     *   @fastify/static 内部时会用自己算的 cache-control 覆盖掉。
     *   只有插件的 setHeaders 能改到最终发出去的那一份。
     *   参数类型别信 @fastify/static 的声明：它写的是 ServerResponse，
     *   运行时传进来的却是 Fastify 的 reply（v10 index.js 里是
     *   `setHeaders?.(reply, ...)`）。照着类型写 `res.setHeader(...)`
     *   能通过 tsc，一上线每个页面请求都 500 —— typecheck 绿灯也挡不住
     *   这类错，所以这里按运行时的真实形状写，并显式转型。
     */
    setHeaders(res: unknown, filePath: string) {
      if (!filePath.endsWith('index.html')) return;
      (res as FastifyReply).header('cache-control', 'no-cache, no-store, must-revalidate');
    },
  });

  /**
   * SPA fallback: frontend routes such as /projects/:id/board have no matching file on the
   * server, so index.html goes back and react-router takes over.
   *
   * ★ Anything under /api/ must still 404 as itself, never index.html.
   *   Otherwise the frontend JSON.parses a chunk of HTML and reports "Unexpected token '<'" —
   *   an error that points nowhere near "you mistyped the path", and mistyping an API path is
   *   one of the most common slips there is.
   *   SPA 兜底：/projects/:id/board 这类前端路由在服务端没有对应文件，
   *   要回 index.html 交给 react-router。但 /api/ 开头的必须原样 404，
   *   不能吐 index.html —— 否则前端拿到一段 HTML 去 JSON.parse，报的是
   *   「Unexpected token '<'」，这个报错完全指不到「路径写错了」，
   *   而打错 API 路径恰恰是最常见的失误之一。
   */
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return sendError(reply, fail(
        'NOT_FOUND',
        'request.no_such_endpoint',
        `没有这个接口：${req.method} ${req.url}`,
        { params: { method: req.method, url: req.url } },
      ));
    }

    // Cache headers are handled once, in setHeaders above; setting them here would be both
    // redundant and overwritten
    return reply.type('text/html').sendFile('index.html');
  });

  app.log.info({ distDir }, '已托管前端构建产物');
  return true;
}
