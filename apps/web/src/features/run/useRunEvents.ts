import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { sseConnection } from '../../lib/sse/connection';
import type { RunEventRow } from '../../lib/api/types';

/** 执行中的 Run 拉新事件的间隔 */
const POLL_MS = 2000;

/**
 * Run 事件流。
 *
 * ★ 为什么是轮询而不是 SSE：
 *
 *   SSE 推的是**领域事件**（run 启动/完成/失败），run_events 那一层
 *   （每次工具调用、每条推理）刻意不进领域事件流 ——
 *   它们量级大两个数量级，全推上去会把 Analytics 和审计要扫的表撑爆
 *   （docs/tech/03-event-model.md §2）。
 *
 *   所以这里分两路：SSE 负责「Run 状态变了」这种低频信号，
 *   高频的执行细节用 after 游标增量拉。游标接口本来就是为这个设计的，
 *   只在 Run 活跃时轮询，结束后自动停。
 */
export function useRunEvents(runId: string, level: 'brief' | 'detailed', live: boolean) {
  const qc = useQueryClient();
  const [events, setEvents] = useState<RunEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const cursor = useRef<number | null>(null);
  const inFlight = useRef(false);

  // 切换简明/详细是换一套数据源，必须整段重来
  useEffect(() => {
    let cancelled = false;
    cursor.current = null;
    setEvents([]);
    setLoading(true);

    void (async () => {
      const page = await api.runEvents(runId, { level });
      if (cancelled) return;
      setEvents(page.events);
      cursor.current = page.nextCursor;
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [runId, level]);

  useEffect(() => {
    if (!live) return;
    let stopped = false;

    const pull = async () => {
      if (inFlight.current || stopped) return;
      inFlight.current = true;
      try {
        const page = await api.runEvents(runId, {
          level,
          ...(cursor.current !== null ? { after: cursor.current } : {}),
        });
        if (stopped || page.events.length === 0) return;
        cursor.current = page.nextCursor ?? cursor.current;
        // 去重：轮询与首屏加载可能重叠
        setEvents((prev) => {
          const seen = new Set(prev.map((e) => e.seq));
          return [...prev, ...page.events.filter((e) => !seen.has(e.seq))];
        });
      } catch {
        // 单次拉取失败不该中断轮询，下一轮会补上
      } finally {
        inFlight.current = false;
      }
    };

    const timer = setInterval(() => void pull(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [runId, level, live]);

  // Run 的状态变化走 SSE —— 结束时立刻刷新头部，不用等下一次轮询
  useEffect(() => {
    return sseConnection.subscribe([`run:${runId}`], () => {
      void qc.invalidateQueries({ queryKey: qk.run(runId) });
    });
  }, [runId, qc]);

  return { events, loading };
}
