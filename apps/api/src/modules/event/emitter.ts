import { events, type Database } from '@apos/db';
import {
  REASON_REQUIRED_EVENTS,
  type DomainEventType,
  type EventLevel,
  type PolicyContext,
  type SubjectType,
  type ActorRef,
} from '@apos/contracts';

export interface EmitInput {
  type: DomainEventType;
  level?: EventLevel;
  orgId: string;
  projectId: string | null;
  actor: ActorRef;
  subjectType: SubjectType;
  subjectId: string;
  payload?: Record<string, unknown>;
  contextSnapshot?: PolicyContext | null;
  causationId?: bigint | null;
  correlationId: string;
}

export interface EmittedEvent extends EmitInput {
  id: bigint;
  occurredAt: Date;
}

/** 事务型数据库句柄 —— transition 内部传入的是事务对象而非连接池 */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export class MissingReasonError extends Error {
  constructor(type: DomainEventType) {
    super(`事件 ${type} 必须在 payload 中携带 reason —— 人类覆盖系统判断时必须留痕`);
    this.name = 'MissingReasonError';
  }
}

/**
 * 写入领域事件。
 *
 * ★ 必须在业务事务内调用。事件与状态同事务写入，否则会出现
 *   「状态变了但没有事件」的审计黑洞（docs/tech/03-event-model.md §5.1）。
 */
export async function emit(tx: Tx, input: EmitInput): Promise<EmittedEvent> {
  const payload = input.payload ?? {};

  // 强制留痕：人类覆盖系统判断的事件必须说明原因
  if (REASON_REQUIRED_EVENTS.includes(input.type)) {
    const reason = payload['reason'];
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new MissingReasonError(input.type);
    }
  }

  const [row] = await tx
    .insert(events)
    .values({
      orgId: input.orgId,
      projectId: input.projectId,
      type: input.type,
      level: input.level ?? 'milestone',
      actorType: input.actor.type,
      actorId: input.actor.id,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      payload,
      contextSnapshot: input.contextSnapshot ?? null,
      causationId: input.causationId ?? null,
      correlationId: input.correlationId,
    })
    .returning({ id: events.id, occurredAt: events.occurredAt });

  if (!row) throw new Error('事件写入失败');

  return { ...input, payload, id: row.id, occurredAt: row.occurredAt };
}
