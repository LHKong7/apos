import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { sseConnection } from './connection';
import { applyEventToCache } from './apply-event';

/**
 * 订阅项目看板频道，并把事件落到 Query 缓存。
 *
 * 组件只管订阅，缓存怎么改由 apply-event 决定 ——
 * 让页面自己处理事件的话，同一个事件在不同页面会被处理成不同结果。
 */
export function useProjectStream(projectId: string | undefined) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!projectId) return;
    return sseConnection.subscribe([`project:${projectId}:board`], (event) => {
      applyEventToCache(qc, event);
    });
  }, [projectId, qc]);
}
