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
  channels: string[];
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

  // 断线续传
  if (opts.lastEventId) {
    const missed = await replayMissed(deps.db, opts.channels, opts.lastEventId);
    if (missed === 'too_many') {
      reply.raw.write(
        `event: resync\ndata: ${JSON.stringify({ reason: '离线期间事件过多，请全量刷新' })}\n\n`,
      );
    } else {
      for (const e of missed) write(e);
    }
  }

  reply.raw.write(
    `event: ready\ndata: ${JSON.stringify({ channels: opts.channels })}\n\n`,
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
