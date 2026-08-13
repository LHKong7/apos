import { and, gt, inArray, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { events, type Database } from '@apos/db';
import { channelsFor, type EventBus, type PublishedEvent } from '../modules/event/bus';

/** 单连接积压上限；超出后降级为只推里程碑事件 */
const BACKLOG_LIMIT = 1000;
/** 断线续传时补发的上限；超出则让客户端全量刷新 */
const RESYNC_THRESHOLD = 500;
const KEEPALIVE_MS = 25_000;

export interface SseOptions {
  /** 已经过鉴权的频道。鉴权在 sse-channels.ts，这里只负责推送 */
  channels: string[];
  /**
   * 被剔除的频道。原样回给客户端 —— 前端要能分辨「没订上」与
   * 「订上了但暂时没事件」，否则它会对着一条永远不推数据的频道干等。
   */
  denied?: string[];
  lastEventId?: string;
}

/**
 * SSE 连接处理。
 *
 * 三个约束（docs/tech/07-api-design.md §5）：
 * 1. 逐频道鉴权，无权限的剔除而不是整体拒绝
 * 2. Last-Event-ID 断线续传；积压过多时让客户端全量刷新而非补发几千条
 * 3. 背压：待发队列过长时降级为只推里程碑事件
 */
export async function handleSse(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: { db: Database; bus: EventBus },
  opts: SseOptions,
) {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let degraded = false;
  let pending = 0;
  let closed = false;

  const write = (event: PublishedEvent) => {
    if (closed) return;
    if (degraded && !isMilestone(event.type)) return;

    pending++;
    const ok = reply.raw.write(
      `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    );
    if (ok) {
      pending--;
    } else {
      reply.raw.once('drain', () => {
        pending--;
        /**
         * ★ 积压排空后**恢复**全量推送。
         *
         *   降级此前是单向的：一次网络抖动把连接推过阈值，它就一直
         *   只收里程碑事件，直到用户自己刷新页面。而降级本来是应对
         *   一时的拥塞，不是对这条连接的判决 —— 慢消费者会反复触发，
         *   快消费者恢复后理应拿回细粒度事件。
         */
        if (degraded && pending === 0) {
          degraded = false;
          if (!closed) {
            reply.raw.write(
              `event: recovered\ndata: ${JSON.stringify({
                reason: '积压已排空，恢复推送全部事件',
              })}\n\n`,
            );
          }
        }
      });
      if (pending > BACKLOG_LIMIT && !degraded) {
        degraded = true;
        reply.raw.write(
          `event: degraded\ndata: ${JSON.stringify({
            reason: '事件积压过多，已降级为仅推送里程碑事件',
          })}\n\n`,
        );
      }
    }
  };

  /**
   * 断线续传。
   *
   * ★★ 整段包在 try 里，是因为响应头已经发出去了（上面的 writeHead）。
   *
   *   此后任何抛出都到不了 Fastify 的错误处理 —— 它只会尝试再写一次头，
   *   拿到 ERR_HTTP_HEADERS_SENT，然后这条连接**永远挂着**：客户端等不到
   *   任何字节，也等不到 FIN。最容易触发它的就是一个不是数字的
   *   Last-Event-ID（`BigInt('abc')` 直接抛），而浏览器重连时带的
   *   那个值是它上次收到的 id，库里被清过之后就可能是任何东西。
   *
   *   续传失败不该拖垮整条流：告诉客户端「补不上，请全量刷新」，
   *   然后照常把实时推送接上。
   */
  if (opts.lastEventId) {
    try {
      const missed = await replayMissed(deps.db, opts.channels, opts.lastEventId);
      if (missed === 'too_many') {
        reply.raw.write(
          `event: resync\ndata: ${JSON.stringify({ reason: '离线期间事件过多，请全量刷新' })}\n\n`,
        );
      } else {
        for (const e of missed) write(e);
      }
    } catch {
      reply.raw.write(
        `event: resync\ndata: ${JSON.stringify({ reason: '断点无法识别，请全量刷新' })}\n\n`,
      );
    }
  }

  reply.raw.write(
    `event: ready\ndata: ${JSON.stringify({
      channels: opts.channels,
      ...(opts.denied?.length ? { denied: opts.denied } : {}),
    })}\n\n`,
  );

  const unsubscribe = deps.bus.subscribe(opts.channels, write);

  const keepalive = setInterval(() => {
    if (!closed) reply.raw.write(': keepalive\n\n');
  }, KEEPALIVE_MS);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    unsubscribe();
  };

  req.raw.on('close', cleanup);
  req.raw.on('error', cleanup);

  return reply;
}

async function replayMissed(
  db: Database,
  channels: string[],
  lastEventId: string,
): Promise<PublishedEvent[] | 'too_many'> {
  const since = BigInt(lastEventId);
  const projectIds = channels
    .filter((c) => c.startsWith('project:'))
    .map((c) => c.split(':')[1]!)
    .filter(Boolean);
  const subjectIds = channels
    .filter((c) => c.startsWith('work_item:') || c.startsWith('run:'))
    .map((c) => c.split(':')[1]!)
    .filter(Boolean);

  if (projectIds.length === 0 && subjectIds.length === 0) return [];

  const rows = await db
    .select()
    .from(events)
    .where(
      and(
        gt(events.id, since),
        projectIds.length && subjectIds.length
          ? sql`(${inArray(events.projectId, projectIds)} OR ${inArray(events.subjectId, subjectIds)})`
          : projectIds.length
            ? inArray(events.projectId, projectIds)
            : inArray(events.subjectId, subjectIds),
      ),
    )
    .orderBy(events.id)
    .limit(RESYNC_THRESHOLD + 1);

  if (rows.length > RESYNC_THRESHOLD) return 'too_many';

  return rows
    .map((r) => ({
      id: String(r.id),
      type: r.type,
      channels: channelsFor({
        type: r.type as never,
        level: r.level as never,
        orgId: r.orgId,
        projectId: r.projectId,
        actor: { type: r.actorType, id: r.actorId },
        subjectType: r.subjectType as never,
        subjectId: r.subjectId,
        payload: r.payload,
        correlationId: r.correlationId,
        id: r.id,
        occurredAt: r.occurredAt,
      }),
      projectId: r.projectId,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      actorType: r.actorType,
      actorId: r.actorId,
      payload: r.payload,
      occurredAt: r.occurredAt.toISOString(),
    }))
    .filter((e) => e.channels.some((c) => channels.includes(c)));
}

const MILESTONE_PREFIXES = [
  'work_item.status_changed',
  'work_item.blocked',
  'decision.',
  'agent_run.completed',
  'agent_run.failed',
  'plan.',
  'project.',
];

function isMilestone(type: string): boolean {
  return MILESTONE_PREFIXES.some((p) => type.startsWith(p));
}
