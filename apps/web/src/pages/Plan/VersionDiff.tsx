import { useT } from '../../lib/i18n';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import type { PlanDiff, TaskDiff } from '@apos/domain';
import { api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';

/**
 * 计划版本对比（页面文档 04）。
 *
 * ★ 用户要批准的是 v2，脑子里记得的是 v1。不给 diff 的话，
 *   他只能把三十行任务清单整个重读一遍 ——
 *   而「重读一遍」的真实结果通常是不读，直接批。
 *   所以这一块不是便利功能，是让「批准」这个动作重新有意义的东西。
 *
 * ★ 默认展开而不是折叠。折叠起来的 diff 等于没有 diff：
 *   会主动去点开它的人，本来就是会认真重读的那批。
 */
export function VersionDiff({ planId }: { planId: string }) {
  const t = useT();
  const [against, setAgainst] = useState<number | undefined>(undefined);
  const [showUnchanged, setShowUnchanged] = useState(false);

  const q = useQuery({
    queryKey: qk.planDiff(planId, against),
    queryFn: () => api.planDiff(planId, against),
  });

  if (q.isPending || !q.data) return null;
  // 只有一个版本，没什么可比的 —— 不占位、不显示空面板
  if (q.data.versions.length < 2) return null;

  const { diff, versions } = q.data;
  const others = versions.filter((v) => !v.isCurrent);
  const current = versions.find((v) => v.isCurrent);

  return (
    <section
      className={clsx(
        'rounded border bg-white',
        diff?.boundary.loosened ? 'border-amber-300' : 'border-slate-200',
      )}
    >
      <div className="flex flex-wrap items-baseline gap-2 border-b border-slate-100 px-3 py-1.5">
        <h2 className="text-xs font-medium text-slate-700">
          {t('planDiff.against', { version: q.data.against?.version ?? '—' })}
        </h2>
        {others.length > 1 && (
          <Select
            value={String(against ?? q.data.against?.version ?? '')}
            onValueChange={(v) => setAgainst(Number(v))}
          >
            <SelectTrigger
              className="h-6 w-auto px-1.5 text-[11px]"
              aria-label={t('planDiff.compareVersion')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* ★ Radix 的 value 只认字符串，版本号是 number —— 两边都要显式转 */}
              {others.map((v) => (
                <SelectItem key={v.id} value={String(v.version)}>
                  v{v.version}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <span className="text-[11px] text-slate-400">
          {t('planDiff.versionCount', {
            count: versions.length,
            current: current?.version ?? '',
          })}
        </span>
      </div>

      {/* ★ 这一版是怎么来的 —— 取自上一版的 revisionFeedback。
          diff 说改了什么，这句说为什么改。 */}
      {q.data.feedback && (
        <p className="border-b border-slate-100 bg-sky-50 px-3 py-1.5 text-[11px] text-sky-900">
          {t('planDiff.basedOnFeedback', { feedback: q.data.feedback })}
        </p>
      )}

      {!diff ? (
        <p className="px-3 py-2 text-[11px] text-slate-500">{t('planDiff.firstVersion')}</p>
      ) : diff.identical ? (
        <p className="px-3 py-2 text-[11px] text-slate-500">
          {t('planDiff.identical')}
        </p>
      ) : (
        <>
          <BoundarySection boundary={diff.boundary} />

          {diff.metrics.length > 0 && (
            <div className="border-t border-slate-100 px-3 py-1.5">
              <p className="text-[11px] text-slate-500">{t('planDiff.totals')}</p>
              <ul className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5">
                {diff.metrics.map((m) => (
                  <li key={m.field} className="text-[11px]">
                    <span className="text-slate-600">{m.label}</span>{' '}
                    <span className="text-slate-400">{m.before}</span>
                    <span className="text-slate-400"> → </span>
                    <span className={clsx(m.loosened ? 'text-amber-700' : 'text-slate-800')}>
                      {m.after}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <TaskSection tasks={diff.tasks} showUnchanged={showUnchanged} onToggle={setShowUnchanged} />

          {(diff.risks.added.length > 0 || diff.risks.removed.length > 0) && (
            <div className="border-t border-slate-100 px-3 py-1.5">
              <p className="text-[11px] text-slate-500">{t('planDiff.risk')}</p>
              <ul className="mt-0.5 space-y-0.5">
                {diff.risks.added.map((r) => (
                  <li key={r} className="text-[11px] text-amber-800">
                    {t('planDiff.riskAdded', { risk: r })}
                  </li>
                ))}
                {diff.risks.removed.map((r) => (
                  <li key={r} className="text-[11px] text-slate-500">
                    {t('planDiff.riskRemoved', { risk: r })}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * ★ 自动化边界的变化排在最前，因为它是唯一一类
 *   「不看就会漏掉、漏掉就出事」的变化。其余变化最坏是计划不如预期，
 *   这一类最坏是批准了自己不知道的自动化。
 */
function BoundarySection({ boundary }: { boundary: PlanDiff['boundary'] }) {
  const t = useT();
  const nothing =
    boundary.autoAdded.length === 0 &&
    boundary.autoRemoved.length === 0 &&
    boundary.gatesAdded.length === 0 &&
    boundary.gatesRemoved.length === 0;

  if (nothing) {
    return (
      <p className="px-3 py-1.5 text-[11px] text-slate-500">
        {t('planDiff.boundaryUnchanged')}
      </p>
    );
  }

  return (
    <div
      className={clsx(
        'px-3 py-1.5',
        boundary.loosened ? 'bg-amber-50' : '',
      )}
    >
      <p
        className={clsx(
          'text-[11px] font-medium',
          boundary.loosened ? 'text-amber-900' : 'text-slate-700',
        )}
      >
        {boundary.loosened
          ? t('planDiff.loosenedWarning')
          : t('planDiff.automationBoundary')}
      </p>
      <ul className="mt-0.5 space-y-0.5">
        {boundary.autoAdded.map((a) => (
          <li key={`aa-${a}`} className="text-[11px] text-amber-900">
            {t('planDiff.autoAdded', { action: a })}
            <span className="ml-1 text-amber-700">{t('planDiff.notInPrevious')}</span>
          </li>
        ))}
        {boundary.gatesRemoved.map((g) => (
          <li key={`gr-${g}`} className="text-[11px] text-amber-900">
            {t('planDiff.gateRemoved', { gate: g })}
          </li>
        ))}
        {boundary.gatesAdded.map((g) => (
          <li key={`ga-${g}`} className="text-[11px] text-slate-600">
            {t('planDiff.gateAdded', { gate: g })}
          </li>
        ))}
        {boundary.autoRemoved.map((a) => (
          <li key={`ar-${a}`} className="text-[11px] text-slate-600">
            {t('planDiff.autoRemoved', { action: a })}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TaskSection({
  tasks,
  showUnchanged,
  onToggle,
}: {
  tasks: TaskDiff[];
  showUnchanged: boolean;
  onToggle: (v: boolean) => void;
}) {
  const t = useT();
  const changed = tasks.filter((t) => t.kind !== 'unchanged');
  const unchangedCount = tasks.length - changed.length;
  const visible = showUnchanged ? tasks : changed;

  if (tasks.length === 0) return null;

  return (
    <div className="border-t border-slate-100 px-3 py-1.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <p className="text-[11px] text-slate-500">
          {t('planDiff.taskChanges', { count: changed.length })}
        </p>
        {unchangedCount > 0 && (
          <Button
            variant="ghost"
            onClick={() => onToggle(!showUnchanged)}
            className="h-auto p-0 text-[11px] font-normal text-slate-500 hover:bg-transparent hover:text-slate-700"
          >
            {t('planDiff.unchangedCount', { action: showUnchanged ? t('planDiff.hide') : t('planDiff.show'), count: unchangedCount })}
          </Button>
        )}
      </div>

      <ul className="mt-0.5 space-y-0.5">
        {/* ★ 参数不叫 t —— 会遮住 i18n 的 t */}
        {visible.map((row) => (
          <li key={`${row.kind}-${row.title}`} className="text-[11px]">
            <span className={clsx('mr-1', MARK_TONE[row.kind])}>{MARK[row.kind]}</span>
            <span
              className={clsx(
                row.kind === 'removed' ? 'text-slate-400 line-through' : 'text-slate-700',
              )}
            >
              {row.title}
            </span>
            {row.kind === 'added' && (
              <span className="ml-1.5 text-slate-500">
                {row.after?.requiresHuman ? t('planDiff.needsHuman') : t('planDiff.byAgent')}
              </span>
            )}
            {row.fields.map((f) => (
              <span key={f.field} className="ml-2 text-slate-500">
                {f.label} <span className="text-slate-400">{f.before}</span> →{' '}
                <span className={clsx(f.loosened ? 'text-amber-700' : 'text-slate-700')}>
                  {f.after}
                </span>
              </span>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

const MARK: Record<TaskDiff['kind'], string> = {
  added: '+',
  removed: '−',
  changed: '~',
  unchanged: '·',
};

const MARK_TONE: Record<TaskDiff['kind'], string> = {
  added: 'text-green-700',
  removed: 'text-red-700',
  changed: 'text-amber-700',
  unchanged: 'text-slate-400',
};
