import { and, eq, gt } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { idempotencyKeys, type Database } from '@apos/db';
import { ApiError } from './errors';

/**
 * Idempotency-Key（docs/tech/07-api-design.md §4）。
 *
 * ★ 要解决的不是「重复执行」—— 那一层已经由状态机挡住了：重复批准同一条
 *   决策会拿到 409 VERSION_CONFLICT，副作用不会发生第二次。
 *
 *   真正的问题是**成功了却被告知失败**：客户端 POST 批准，网络在响应回来的
 *   路上断了，它重试，这次拿到 409，于是界面显示「批准失败」。用户再点，
 *   还是失败。操作其实第一次就成了。这比真的失败更难排查，
 *   因为服务端日志里一切正常。
 *
 * ★ 只缓存 2xx。把失败也缓存下来的话，一次偶发故障会被钉死 24 小时 ——
 *   客户端之后每次带同一个 key 重试都拿到那个陈旧的错误，再也好不了。
 */

/** 文档 §4 点名「必须支持幂等」的那几类端点 */
const IDEMPOTENT_PATHS = [
  /^\/api\/v1\/decisions\/[0-9a-f-]{36}\/(approve|reject)$/i,
  /^\/api\/v1\/decisions\/batch-approve$/i,
  /^\/api\/v1\/runs\/[0-9a-f-]{36}\/control$/i,
  /^\/api\/v1\/work-items\/[0-9a-f-]{36}\/(retry|takeover)$/i,
  /^\/api\/v1\/plans\/[0-9a-f-]{36}\/approve$/i,
  /^\/api\/v1\/requirements\/[0-9a-f-]{36}\/(approve|reject)$/i,
];

const TTL_MS = 24 * 60 * 60 * 1000;

interface Pending {
  key: string;
  endpoint: string;
  actorId: string | null;
}

/** 挂在 request 上传给 onSend —— Fastify 没有别的地方放请求级状态 */
const pendingByRequest = new WeakMap<FastifyRequest, Pending>();

export function registerIdempotency(app: FastifyInstance, db: Database) {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method !== 'POST') return;

    const raw = req.headers['idempotency-key'];
    if (typeof raw !== 'string' || raw.trim() === '') return;
    const key = raw.trim();
    if (key.length > 255) {
      throw new ApiError('VALIDATION_FAILED', 'Idempotency-Key 过长（上限 255）');
    }

    const endpoint = (req.url.split('?')[0] ?? '').toLowerCase();
    if (!IDEMPOTENT_PATHS.some((re) => re.test(endpoint))) return;

    const actorId = typeof req.headers['x-user-id'] === 'string' ? req.headers['x-user-id'] : null;

    const [hit] = await db
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.key, key),
          eq(idempotencyKeys.endpoint, endpoint),
          gt(idempotencyKeys.createdAt, new Date(Date.now() - TTL_MS)),
        ),
      );

    if (!hit) {
      pendingByRequest.set(req, { key, endpoint, actorId });
      return;
    }

    /**
     * ★ 换个人拿同一个 key 重放，不能拿到上一个人的响应。
     *   key 是客户端自己生成的，撞车（或被猜到）都不是不可能，
     *   而这些响应里带着决策内容。
     */
    if (hit.actorId && hit.actorId !== actorId) {
      throw new ApiError('VALIDATION_FAILED', 'Idempotency-Key 已被另一个身份使用', {
        key,
      });
    }

    // 让调用方能分辨「这次是重放」，排查重复提交时很有用
    void reply.header('idempotent-replay', 'true').code(hit.statusCode).send(hit.response);
  });

  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const pending = pendingByRequest.get(req);
    if (!pending) return payload;
    pendingByRequest.delete(req);

    // 只记成功的（见文件头注释）
    if (reply.statusCode < 200 || reply.statusCode >= 300) return payload;

    let body: unknown = null;
    if (typeof payload === 'string') {
      try {
        body = JSON.parse(payload);
      } catch {
        return payload; // 非 JSON 响应（SSE 等）不参与幂等
      }
    } else {
      return payload;
    }

    await db
      .insert(idempotencyKeys)
      .values({
        key: pending.key,
        endpoint: pending.endpoint,
        statusCode: reply.statusCode,
        response: body,
        actorId: pending.actorId,
      })
      /**
       * ★ 并发重复提交时两个请求都会 miss 缓存、都会执行 —— 第二个会被
       *   状态机拦下（409），不会写到这里。真撞上就当没写过，
       *   绝不能让写缓存这一步把一个已经成功的响应变成 500。
       */
      .onConflictDoNothing();

    return payload;
  });
}
