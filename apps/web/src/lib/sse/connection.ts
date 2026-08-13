import { DOMAIN_EVENT_TYPES } from '@apos/contracts';
import { getAuthToken } from '../api/client';
import type { StreamEvent } from '../api/types';

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting';

export type EventHandler = (event: StreamEvent) => void;
export type StatusHandler = (status: ConnectionStatus, detail?: string) => void;
export type Unsubscribe = () => void;

/** 重连退避上限。再久用户就会以为页面挂了 */
const MAX_BACKOFF_MS = 15_000;
/** 频道变更防抖：快速切页时不要反复重连 */
const RECONNECT_DEBOUNCE_MS = 100;

/**
 * 单连接多频道（docs/tech/08-frontend-architecture.md §4.1）。
 *
 * 只维持一条 EventSource：HTTP/1.1 下浏览器对同域并发连接有 6 条上限，
 * 每个组件各开一条很快就会把连接用光，后续的普通请求都会排队。
 *
 * 频道用引用计数而不是 Set —— 两个组件订同一个频道，其中一个卸载时
 * 不能把频道摘掉。
 */
export class SSEConnection {
  private es: EventSource | null = null;
  private channelRefs = new Map<string, number>();
  private handlers = new Set<EventHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private lastEventId: string | null = null;
  private backoff = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private status: ConnectionStatus = 'idle';
  private connectedChannels: string[] = [];

  constructor(private readonly baseUrl = '/api/v1/stream') {}

  subscribe(channels: string[], handler: EventHandler): Unsubscribe {
    this.handlers.add(handler);
    for (const ch of channels) {
      this.channelRefs.set(ch, (this.channelRefs.get(ch) ?? 0) + 1);
    }
    this.scheduleConnect();

    return () => {
      this.handlers.delete(handler);
      for (const ch of channels) {
        const next = (this.channelRefs.get(ch) ?? 1) - 1;
        if (next <= 0) this.channelRefs.delete(ch);
        else this.channelRefs.set(ch, next);
      }
      this.scheduleConnect();
    };
  }

  onStatus(handler: StatusHandler): Unsubscribe {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  currentStatus(): ConnectionStatus {
    return this.status;
  }

  close() {
    this.clearTimers();
    this.es?.close();
    this.es = null;
    this.connectedChannels = [];
    this.setStatus('idle');
  }

  private scheduleConnect() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.reconnectIfChannelsChanged();
    }, RECONNECT_DEBOUNCE_MS);
  }

  private reconnectIfChannelsChanged() {
    const wanted = [...this.channelRefs.keys()].sort();

    if (wanted.length === 0) {
      this.close();
      return;
    }
    if (this.es && sameChannels(wanted, this.connectedChannels)) return;

    this.connect(wanted);
  }

  private connect(channels: string[]) {
    this.clearTimers();
    this.es?.close();

    this.connectedChannels = channels;
    this.setStatus(this.lastEventId ? 'reconnecting' : 'connecting');

    const params = new URLSearchParams({ channels: channels.join(',') });
    // EventSource 不能带自定义头，Last-Event-ID 只能走 query；
    // 后端两处都读
    if (this.lastEventId) params.set('lastEventId', this.lastEventId);

    /**
     * ★★ 令牌同样只能走 query —— 和上面 Last-Event-ID 是同一个限制。
     *
     *   没有它这条连接就是 401，而 EventSource 对 401 的表现是
     *   「静默重连」：页面不报错，只是所有实时更新都不来了，
     *   看起来像后端不推事件。所以未登录时**根本不连**，
     *   让它在登录后由订阅方重新触发。
     */
    const token = getAuthToken();
    if (!token) {
      this.connectedChannels = [];
      this.setStatus('idle');
      return;
    }
    params.set('access_token', token);

    const es = new EventSource(`${this.baseUrl}?${params.toString()}`);
    this.es = es;

    es.addEventListener('ready', () => {
      this.backoff = 500;
      this.setStatus('open');
    });

    es.addEventListener('degraded', (e) => {
      this.setStatus('open', readReason(e));
    });

    /**
     * ★ 降级会恢复：积压排空后服务端推 `recovered`，把那句降级提示撤掉。
     *   不处理的话，一次网络抖动留下的「已降级」会一直挂在界面上，
     *   而连接其实早就恢复正常了。
     */
    es.addEventListener('recovered', () => {
      this.setStatus('open');
    });

    es.addEventListener('resync', () => {
      // 离线期间事件太多，补发不划算：让订阅方全量刷新
      this.lastEventId = null;
      for (const h of this.statusHandlers) h('open', 'resync');
    });

    /**
     * 后端给每条事件都带了 `event: <type>`，命名事件不会触发 onmessage，
     * 所以要逐类型注册。类型表来自 contracts，前后端同源，
     * 不会出现「后端加了新事件前端静默收不到」。
     */
    const onDomainEvent = (e: MessageEvent<string>) => {
      this.lastEventId = e.lastEventId || this.lastEventId;
      let parsed: StreamEvent;
      try {
        parsed = JSON.parse(e.data) as StreamEvent;
      } catch {
        return;
      }
      for (const h of this.handlers) h(parsed);
    };

    for (const type of DOMAIN_EVENT_TYPES) {
      es.addEventListener(type, onDomainEvent as EventListener);
    }
    es.onmessage = onDomainEvent;

    es.onerror = () => {
      es.close();
      if (this.es !== es) return;
      this.es = null;
      this.setStatus('reconnecting');
      this.reconnectTimer = setTimeout(() => this.connect(channels), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    };
  }

  private setStatus(status: ConnectionStatus, detail?: string) {
    this.status = status;
    for (const h of this.statusHandlers) h(status, detail);
  }

  private clearTimers() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

function sameChannels(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function readReason(e: Event): string | undefined {
  const data = (e as MessageEvent<string>).data;
  if (!data) return undefined;
  try {
    return (JSON.parse(data) as { reason?: string }).reason;
  } catch {
    return undefined;
  }
}

export const sseConnection = new SSEConnection();
