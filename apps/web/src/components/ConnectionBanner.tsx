import { useT } from '../lib/i18n';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { sseConnection, type ConnectionStatus } from '../lib/sse/connection';

/**
 * 实时连接状态条（页面文档 05 §7）。
 *
 * 断线时必须显式告诉用户，否则看板会静静地停在旧状态 ——
 * 用户以为「什么都没发生」，实际是「什么都没收到」。这是最坏的一种沉默。
 */
export function ConnectionBanner() {
  const t = useT();
  const qc = useQueryClient();
  const [status, setStatus] = useState<ConnectionStatus>(sseConnection.currentStatus());
  const [detail, setDetail] = useState<string | undefined>();

  useEffect(
    () =>
      sseConnection.onStatus((s, d) => {
        setStatus(s);
        setDetail(d);
        // 补发太多改为全量刷新（后端的 resync 信号）
        if (d === 'resync') void qc.invalidateQueries();
      }),
    [qc],
  );

  if (status === 'open' && !detail) return null;
  if (status === 'idle' || status === 'connecting') return null;

  if (detail && status === 'open') {
    return (
      <div className="flex shrink-0 items-center justify-center gap-2 border-b border-amber-200/50 bg-amber-50 px-4 py-1 text-[11px] text-amber-800">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-gate" />
        {detail === 'resync' ? t('conn.resynced') : detail}
      </div>
    );
  }

  return (
    <div className="flex shrink-0 items-center justify-center gap-2 border-b border-amber-300/40 bg-amber-100 px-4 py-1 text-[11px] text-amber-900">
      {/* 一个真的在闪的点，比一句「正在重连」更快被余光捕捉到 */}
      <span aria-hidden className="relative flex h-1.5 w-1.5">
        <span className="absolute inset-0 rounded-full bg-gate animate-ping-soft" />
        <span className="relative h-1.5 w-1.5 rounded-full bg-gate" />
      </span>
      {t('conn.reconnecting')}
    </div>
  );
}
