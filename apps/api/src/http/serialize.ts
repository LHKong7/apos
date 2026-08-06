import type { events } from '@apos/db';

type EventRow = typeof events.$inferSelect;

export interface EventDto {
  id: string;
  type: string;
  level: string;
  actorType: string;
  actorId: string | null;
  subjectType: string;
  subjectId: string;
  payload: Record<string, unknown>;
  causationId: string | null;
  correlationId: string;
  occurredAt: string;
}

/**
 * 事件的对外形状。
 *
 * ★ events.id 与 causation_id 是 bigint，JSON.stringify 直接抛异常。
 *   所有返回事件的接口都必须走这里，否则会得到一个 500 而不是数据。
 */
export function serializeEvent(row: EventRow): EventDto {
  return {
    id: String(row.id),
    type: row.type,
    level: row.level,
    actorType: row.actorType,
    actorId: row.actorId,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    payload: row.payload,
    causationId: row.causationId === null ? null : String(row.causationId),
    correlationId: row.correlationId,
    occurredAt: row.occurredAt.toISOString(),
  };
}

/**
 * 兜底：把任意结构里的 BigInt 转成字符串。
 *
 * 用于日志与错误详情这类结构不固定的地方。业务响应应当走显式的 DTO，
 * 依赖兜底会让 API 契约变得不可预测。
 */
export function safeJson<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? String(v) : v)),
  ) as T;
}
