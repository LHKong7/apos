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
      <div className="bg-amber-50 px-4 py-1 text-center text-[11px] text-amber-800">
        {detail === 'resync' ? '离线期间更新较多，已全量刷新' : detail}
      </div>
    );
  }

  return (
    <div className="bg-amber-100 px-4 py-1 text-center text-[11px] text-amber-900">
      实时更新已断开，正在重连…（卡片显示的是最后一次同步的状态）
    </div>
  );
}
