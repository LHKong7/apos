import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ApiError, sendError } from './errors';

/**
 * 单机部署时由 API 进程直接托管前端构建产物。
 *
 * ★ 为什么不另起一个 nginx：SSE。
 *   前端的 EventSource 不支持自定义请求头，认证只能靠同源 —— 开发环境为此
 *   专门配了 Vite 代理（见 apps/web/vite.config.ts 的注释）。生产上如果把
 *   静态资源和 API 拆成两个 origin，同一个问题会原样回来，还要再配一遍
 *   反向代理与 CORS。同进程托管让「同源」这件事不需要任何配置就成立，
 *   单机上也少一个容器。
 *
 *   代价是静态文件走 Node 的事件循环。单机规模下这不是瓶颈；
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
    // 交给下面的 notFound 处理，才能区分「前端路由」和「打错的 API 路径」
    wildcard: false,
    // 构建产物的文件名带内容 hash，改了必然换名，所以可以放心长缓存
    maxAge: '1y',
    immutable: true,

    /**
     * ★ index.html 必须例外，而且**只能在这里**改。
     *
     *   它是唯一没有 hash 的文件，内容里写死了当前这版资源的文件名。
     *   跟着上面那条 immutable 一起被缓存一年的后果是：重新部署之后，
     *   老用户的浏览器继续用缓存里的旧 index.html，去请求一批已经被
     *   新构建删掉的资源名 —— 页面白屏，且强刷之前一直白，
     *   而服务端日志上一切正常。
     *
     *   在路由里 `reply.header(...)` 是没用的：sendFile 走到
     *   @fastify/static 内部时会用自己算的 cache-control 覆盖掉。
     *   只有插件的 setHeaders 能改到最终发出去的那一份。
     *
     * ★★ 参数类型别信 @fastify/static 的声明：它写的是 ServerResponse，
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
   * SPA 兜底：/projects/:id/board 这类前端路由在服务端没有对应文件，
   * 要回 index.html 交给 react-router。
   *
   * ★ 但 /api/ 开头的必须原样 404，不能吐 index.html。
   *   否则前端拿到一段 HTML 去 JSON.parse，报的是
   *   「Unexpected token '<'」—— 这个报错完全指不到「路径写错了」，
   *   而打错 API 路径恰恰是最常见的失误之一。
   */
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return sendError(reply, new ApiError('NOT_FOUND', `没有这个接口：${req.method} ${req.url}`));
    }

    // 缓存头由上面的 setHeaders 统一负责，这里不重复设（设了也会被覆盖）
    return reply.type('text/html').sendFile('index.html');
  });

  app.log.info({ distDir }, '已托管前端构建产物');
  return true;
}
