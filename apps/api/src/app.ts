import Fastify, { type FastifyInstance } from 'fastify';
import { registerRoutes, type AppDeps } from './http/routes';
import { registerIdempotency } from './http/idempotency';
import { registerWebApp } from './http/web-app';

export interface AppOptions extends AppDeps {
  logger?: boolean;
  /**
   * 前端构建产物目录。给了就由本进程一并托管（单机部署用），
   * 不给就只提供 API（开发时前端在 Vite 那边）。
   */
  webDist?: string;
  /** 反代后面取真实客户端 IP 与协议 */
  trustProxy?: boolean;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    genReqId: () => `req_${Math.random().toString(36).slice(2, 12)}`,
    trustProxy: opts.trustProxy ?? false,
  });

  // ★ 必须在 registerRoutes 之前：钩子按注册顺序跑，
  //   幂等重放要抢在业务逻辑前面短路掉
  registerIdempotency(app, opts.db);

  await registerRoutes(app, opts);

  // ★ 必须在路由之后：notFound 兜底要等 API 路由都注册完才知道什么叫「没匹配上」
  if (opts.webDist) registerWebApp(app, opts.webDist);

  return app;
}
