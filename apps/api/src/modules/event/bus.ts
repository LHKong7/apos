import type { Database } from '@apos/db';
import { emit, type EmitInput, type EmittedEvent } from './emitter';

export type Channel = string;

export interface PublishedEvent {
  id: string;
  type: string;
  channels: Channel[];
  projectId: string | null;
  subjectType: string;
  subjectId: string;
  actorType: string;
  actorId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export type Subscriber = (event: PublishedEvent) => void;

/**
 * 进程内事件总线。
 *
 * ★ 只能在事务提交后调用 publish。事务内发布会把「已进入 Review」推给浏览器，
 *   而事务随后回滚，前端状态就永久错了。
 *   docs/tech/03-event-model.md §5.1
 *
 * 多实例部署时在此处接 Redis Pub/Sub，订阅侧接口不变。
 */
export class EventBus {
  private subscribers = new Map<Channel, Set<Subscriber>>();

  subscribe(channels: Channel[], fn: Subscriber): () => void {
    for (const ch of channels) {
      let set = this.subscribers.get(ch);
      if (!set) {
        set = new Set();
        this.subscribers.set(ch, set);
      }
      set.add(fn);
    }
    return () => {
      for (const ch of channels) {
        const set = this.subscribers.get(ch);
        set?.delete(fn);
        if (set?.size === 0) this.subscribers.delete(ch);
      }
    };
  }

  private allSubscribers = new Set<Subscriber>();

  /**
   * 订阅全部事件，不按频道过滤。
   *
   * ★ 给通知投递这类「横切」订阅者用。让它去订一堆频道的话，
   *   新增一种频道时就得记得回来加一行 —— 而漏加的表现是
   *   「某类决策从来不提醒」，没人会注意到。
   */
  subscribeAll(fn: Subscriber): () => void {
    this.allSubscribers.add(fn);
    return () => void this.allSubscribers.delete(fn);
  }

  publish(events: EmittedEvent[]): void {
    for (const e of events) {
      const published = toPublished(e);
      // 同一订阅者可能同时订了多个命中的频道，去重后只推一次
      const seen = new Set<Subscriber>();

      for (const fn of this.allSubscribers) {
        seen.add(fn);
        try {
          fn(published);
        } catch {
          // 横切订阅者异常不影响主流程
        }
      }

      for (const ch of published.channels) {
        for (const fn of this.subscribers.get(ch) ?? []) {
          if (seen.has(fn)) continue;
          seen.add(fn);
          try {
            fn(published);
          } catch {
            // 单个订阅者异常不影响其他订阅者与主流程
          }
        }
      }
    }
  }

  subscriberCount(): number {
    return new Set([...this.subscribers.values()].flatMap((s) => [...s])).size;
  }
}

/** 事件 → 频道映射（docs/tech/01-architecture.md §4.3） */
export function channelsFor(e: EmittedEvent): Channel[] {
  const channels: Channel[] = [];
  const payload = e.payload ?? {};

  if (e.projectId) channels.push(`project:${e.projectId}:board`);

  switch (e.subjectType) {
    case 'work_item':
      channels.push(`work_item:${e.subjectId}`);
      break;
    case 'agent_run':
      channels.push(`run:${e.subjectId}`);
      if (typeof payload['workItemId'] === 'string') {
        channels.push(`work_item:${payload['workItemId']}`);
      }
      break;
    case 'decision':
      channels.push(`decision:${e.subjectId}`);
      if (typeof payload['assigneeId'] === 'string') {
        channels.push(`user:${payload['assigneeId']}:decisions`);
      }
      break;
    case 'artifact':
      if (typeof payload['workItemId'] === 'string') {
        channels.push(`work_item:${payload['workItemId']}`);
      }
      break;
    case 'agent':
      channels.push(`agent:${e.subjectId}`);
      break;
  }

  if (e.actor.type === 'agent' && e.actor.id) channels.push(`agent:${e.actor.id}`);

  return [...new Set(channels)];
}

function toPublished(e: EmittedEvent): PublishedEvent {
  return {
    id: String(e.id),
    type: e.type,
    channels: channelsFor(e),
    projectId: e.projectId,
    subjectType: e.subjectType,
    subjectId: e.subjectId,
    actorType: e.actor.type,
    actorId: e.actor.id,
    payload: e.payload ?? {},
    occurredAt: e.occurredAt.toISOString(),
  };
}

/** 默认总线。测试里可以自己 new 一个隔离的。 */
export const defaultBus = new EventBus();

/**
 * 独立写一条事件并在提交后发布。
 *
 * 用于不涉及状态流转的事件（派发、产物、失败上报等）。
 * 状态流转走 transition，它自己管理 outbox。
 */
export async function emitAndPublish(db: Database, input: EmitInput): Promise<EmittedEvent> {
  const event = await db.transaction(async (tx) => emit(tx, input));
  defaultBus.publish([event]);
  return event;
}
