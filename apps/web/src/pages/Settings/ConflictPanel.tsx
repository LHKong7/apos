import { useT } from '../../lib/i18n';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { relativeTime } from '../../lib/format';
import type { SyncConflictRow } from '../../lib/api/types';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';

/**
 * 同步冲突处理（页面文档 14 §5.3 的冲突界面）。
 *
 * ★ 每条冲突必须摆出三样：两侧的值、时间、谁改的。
 *   少任何一样，用户就只能靠猜决定听谁的 ——
 *   而「系统改的」和「李娜手动改的」是完全不同的两种情况：
 *   前者多半该让系统赢，后者多半意味着系统漏了什么。
 *
 * ★ 顶部的热点提示不是装饰。冲突集中在某个字段，几乎总是说明
 *   那个字段的 SoT 配反了 —— 逐条处理一百次，不如把配置改对一次。
 */
export function ConflictPanel({ projectId, canResolve }: { projectId: string; canResolve: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: qk.syncConflicts(projectId),
    queryFn: () => api.syncConflicts(projectId),
  });

  if (q.isPending || !q.data) return null;
  if (q.data.conflicts.length === 0) return null;

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: qk.syncConflicts(projectId) });
    void qc.invalidateQueries({ queryKey: qk.integrations(projectId) });
  };

  return (
    <section className="rounded border border-amber-200 bg-white">
      <div className="flex flex-wrap items-baseline gap-2 border-b border-amber-100 bg-amber-50 px-3 py-1.5">
        <h2 className="text-xs font-medium text-amber-900">
          {t('conflict.title', { count: q.data.conflicts.length })}
        </h2>
        {/* §7：冲突积压 > 10 时提醒去看 SoT 配置 */}
        {q.data.conflicts.length > 10 && (
          <span className="text-[11px] text-amber-800">
            {t('conflict.tooMany')}
          </span>
        )}
      </div>

      {q.data.hotspots.length > 0 && q.data.hotspots[0]!.count >= 3 && (
        <p className="border-b border-amber-100 px-3 py-1 text-[11px] text-amber-800">
          {t('conflict.hotspot', {
            count: q.data.hotspots[0]!.count,
            field: q.data.hotspots[0]!.fieldLabel,
          })}
        </p>
      )}

      <ul className="divide-y divide-slate-100">
        {q.data.conflicts.map((c) => (
          <ConflictRow
            key={c.id}
            conflict={c}
            projectId={projectId}
            canResolve={canResolve}
            onResolved={invalidate}
          />
        ))}
      </ul>
    </section>
  );
}

function ConflictRow({
  conflict,
  projectId,
  canResolve,
  onResolved,
}: {
  conflict: SyncConflictRow;
  projectId: string;
  canResolve: boolean;
  onResolved: () => void;
}) {
  const t = useT();
  const [applyToSimilar, setApplyToSimilar] = useState(false);

  const resolve = useMutation({
    mutationFn: (winner: 'apos' | 'external') =>
      api.resolveConflict(conflict.id, winner, applyToSimilar),
    onSuccess: onResolved,
  });

  return (
    <li className="px-3 py-2">
      <p className="text-xs">
        <span className="text-slate-800">
          {conflict.externalKey} · {conflict.fieldLabel}
        </span>
        {conflict.workItemId && (
          <Link
            to={`/projects/${projectId}/board?item=${conflict.workItemId}`}
            className="ml-2 text-[11px] text-slate-500 underline-offset-2 hover:underline"
          >
            {conflict.workItemTitle}
          </Link>
        )}
        <span className="ml-2 text-[11px] text-slate-400">{relativeTime(conflict.createdAt)}</span>
      </p>

      {/* ★ 值 / 时间 / 谁改的，三样缺一不可 */}
      <table className="mt-1 text-[11px]">
        <tbody>
          <Side label="APOS" side={conflict.apos} winner={conflict.sourceOfTruth === 'apos'} />
          <Side
            label={t('conflict.externalSystem')}
            side={conflict.external}
            winner={conflict.sourceOfTruth === 'external'}
          />
        </tbody>
      </table>

      <p className="mt-0.5 text-[11px] text-slate-500">ℹ {conflict.sotNote}</p>

      {canResolve ? (
        <>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Button variant="neutral" size="xs"
              disabled={resolve.isPending}
              onClick={() => resolve.mutate('apos')}>
              {t('conflict.preferApos')}
            </Button>
            <Button variant="outline" size="xs"
              disabled={resolve.isPending}
              onClick={() => resolve.mutate('external')}>
              {t('conflict.preferExternal')}
            </Button>
          </div>
          {/* ★ 记的是字段级规则，不是这一条对象 —— 用户勾它时想表达的是
              「这个字段以后别再问我」 */}
          <label className="mt-1 flex items-center gap-1 text-[11px] text-slate-500">
            <Checkbox checked={applyToSimilar} onCheckedChange={setApplyToSimilar} />
            {t('conflict.applyToSimilar', { field: conflict.fieldLabel })}
          </label>
        </>
      ) : (
        <p className="mt-1 text-[11px] text-slate-400">{t('conflict.needMembership')}</p>
      )}

      {resolve.error && (
        <p className="mt-1 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
          {resolve.error instanceof ApiError ? resolve.error.message : t('conflict.handleFailed')}
        </p>
      )}
    </li>
  );
}

function Side({
  label,
  side,
  winner,
}: {
  label: string;
  side: SyncConflictRow['apos'];
  winner: boolean;
}) {
  return (
    <tr>
      <td className="w-16 py-0.5 text-slate-500">{label}</td>
      <td className={clsx('w-28 py-0.5', winner ? 'font-medium text-slate-800' : 'text-slate-700')}>
        {String(side.value ?? '—')}
      </td>
      {/* 原始 ISO 串是给机器读的；用户要比的是「谁改得更晚」 */}
      <td className="w-24 py-0.5 text-slate-400" title={side.changedAt || undefined}>
        {side.changedAt ? relativeTime(side.changedAt) : '—'}
      </td>
      {/* 系统改的和人手改的是完全不同的两种情况，图标要能一眼区分 */}
      <td className="py-0.5 text-slate-500">
        {side.actorType === 'human' ? '👤' : side.actorType === 'system' ? '🔧' : '🔗'}{' '}
        {side.changedBy}
      </td>
    </tr>
  );
}
