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
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from '@/components/ui/table';

/**
 * Sync conflict resolution (the conflict UI in page doc 14 §5.3) / 同步冲突处理。
 *
 * ★ Every conflict has to show three things: both sides' values, the times, and
 *   who changed them. Drop any one of them and the user is guessing about whom
 *   to believe — and "the system changed it" versus "Li Na changed it by hand"
 *   are entirely different situations: the first usually means let the system
 *   win, the second usually means the system missed something.
 *
 * ★ The hotspot hint at the top is not decoration. Conflicts clustering on one
 *   field almost always means that field's SoT is configured backwards — fixing
 *   the configuration once beats resolving a hundred conflicts one at a time.
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
        {/* §7: past 10 queued conflicts, point the user at the SoT configuration */}
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

      {/* ★ Value / time / who changed it — all three, none optional */}
      <Table className="mt-1 text-[11px]">
        <TableBody>
          <Side label="APOS" side={conflict.apos} winner={conflict.sourceOfTruth === 'apos'} />
          <Side
            label={t('conflict.externalSystem')}
            side={conflict.external}
            winner={conflict.sourceOfTruth === 'external'}
          />
        </TableBody>
      </Table>

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
          {/* ★ What gets recorded is a field-level rule, not this one object — what
              the user means by ticking it is "stop asking me about this field" */}
          <Label className="mt-1 flex items-center gap-1 text-[11px] text-slate-500">
            <Checkbox checked={applyToSimilar} onCheckedChange={setApplyToSimilar} />
            {t('conflict.applyToSimilar', { field: conflict.fieldLabel })}
          </Label>
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
    <TableRow>
      <TableCell className="w-16 py-0.5 text-slate-500">{label}</TableCell>
      <TableCell className={clsx('w-28 py-0.5', winner ? 'font-medium text-slate-800' : 'text-slate-700')}>
        {String(side.value ?? '—')}
      </TableCell>
      {/* The raw ISO string is for machines; what the user compares is which side changed later */}
      <TableCell className="w-24 py-0.5 text-slate-400" title={side.changedAt || undefined}>
        {side.changedAt ? relativeTime(side.changedAt) : '—'}
      </TableCell>
      {/* A system edit and a hand edit are entirely different cases; the icon has to separate them at a glance */}
      <TableCell className="py-0.5 text-slate-500">
        {side.actorType === 'human' ? '👤' : side.actorType === 'system' ? '🔧' : '🔗'}{' '}
        {side.changedBy}
      </TableCell>
    </TableRow>
  );
}
