import Fastify, { type FastifyInstance } from 'fastify';
import { registerRoutes, type AppDeps } from './http/routes';

export interface AppOptions extends AppDeps {
  logger?: boolean;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    genReqId: () => `req_${Math.random().toString(36).slice(2, 12)}`,
  });

  await registerRoutes(app, opts);
  return app;
}
