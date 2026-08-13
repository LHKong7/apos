import { useT } from '../../lib/i18n';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '../../lib/api/client';
import { Card } from './Card';
import type { AnalyticsResponse } from '../../lib/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * 成本效益（页面文档 12 §12.3）。
 *
 * ★ 这一块曾经不做，理由是「硬编一个时薪算出来的『本月为你省了 $12,400』
 *   看起来最像成果，也最经不起追问」。
 *
 *   问题从来不在技术上，在于那个数字**不可证伪**。所以做法是：
 *   基准由用户自己填，每一步换算都摊在明面上，
 *   结论永远带着「按你填的 X/小时」。
 *   一个「你自己的假设推出来的结论」可以被追问，也就可以被相信。
 *
 * ★ 代价那一侧必须同时给。只算「Agent 干了多少活」而不算
 *   「人为此花了多少时间收拾」，得到的是一个营销数字。
 */
export function BenefitTab({
  data,
  projectId,
}: {
  data: AnalyticsResponse;
  projectId: string;
}) {
  const t = useT();
  const b = data.benefit;
  const qc = useQueryClient();
  const [draft, setDraft] = useState(b.laborHourlyCost === null ? '' : String(b.laborHourlyCost));

  const save = useMutation({
    mutationFn: () =>
      api.setLaborCost(projectId, draft.trim() === '' ? null : Number(draft)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['analytics'] }),
  });

  const benefits = b.lines.filter((l) => l.side === 'benefit');
  const costs = b.lines.filter((l) => l.side === 'cost');

  return (
    <div className="space-y-3">
      {/* ★ 结论在最上面，而且始终带着它建立在什么假设上 */}
      <div
        className={clsx(
          'rounded border px-3 py-2 text-xs',
          !b.hasBaseline
            ? 'border-slate-300 bg-white text-slate-700'
            : b.net !== null && b.net > 0
              ? 'border-slate-200 bg-white text-slate-700'
              : 'border-amber-200 bg-amber-50 text-amber-900',
        )}
      >
        {b.verdict}
      </div>

      <Card
        title={t('benefit.laborBaseline')}
        subtitle={t('benefit.baselineSubtitle')}
      >
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-[11px] text-slate-600">
            {b.currency}
            <Input
              type="number"
              min={0}
              step={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t('benefit.notSet')}
              aria-label={t('benefit.hourlyCost')}
              className="w-24" />
            {t('benefit.perHour')}
          </label>
          <Button variant="neutral" size="xs"
            disabled={save.isPending}
            onClick={() => save.mutate()}>
            {save.isPending ? t('common.saving') : t('common.save')}
          </Button>
          {draft.trim() !== '' && (
            <button
              type="button"
              onClick={() => {
                setDraft('');
                save.mutate();
              }}
              className="text-[11px] text-slate-500 hover:text-slate-700"
            >
              {t('benefit.clearRate')}
            </button>
          )}
        </div>
        {save.error && (
          <p className="mt-1 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
            {save.error instanceof ApiError ? save.error.message : t('benefit.saveFailed')}
          </p>
        )}
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        <Card title={t('benefit.gains')}>
          <Lines lines={benefits} currency={b.currency} />
        </Card>
        <Card title={t('benefit.costs')} subtitle={t('benefit.costsHint')}>
          <Lines lines={costs} currency={b.currency} />
        </Card>
      </div>

      {b.hasBaseline && b.net !== null && (
        <Card title={t('benefit.formula')} subtitle={t('benefit.formulaHint')}>
          <p className="text-[11px] text-slate-600">
            {t('benefit.hoursTimesRate', {
              hours: b.agentHours,
              currency: b.currency,
              rate: b.laborHourlyCost ?? '',
            })}
            <span className="text-slate-400">{t('benefit.agentHours')}</span>
          </p>
          <p className="text-[11px] text-slate-600">
            {t('benefit.minusHoursTimesRate', {
              hours: b.humanOverheadHours,
              currency: b.currency,
              rate: b.laborHourlyCost ?? '',
            })}
            <span className="text-slate-400">{t('benefit.overrideHours')}</span>
          </p>
          <p className="text-[11px] text-slate-600">
            − {b.currency}
            {b.agentSpend}
            <span className="text-slate-400">{t('benefit.agentSpend')}</span>
          </p>
          <p className="mt-1 border-t border-slate-100 pt-1 text-xs font-medium text-slate-800">
            = {b.currency}
            {b.net}
          </p>
        </Card>
      )}
    </div>
  );
}

function Lines({
  lines,
  currency,
}: {
  lines: AnalyticsResponse['benefit']['lines'];
  currency: string;
}) {
  return (
    <ul className="space-y-1">
      {lines.map((l) => (
        <li key={l.key} className="text-[11px]">
          <span className="text-slate-700">{l.label}</span>
          <span className="ml-2 tabular-nums text-slate-800">
            {l.hours > 0 && `${l.hours}h`}
            {l.money !== null && (
              <span className="ml-1">
                {currency}
                {l.money}
              </span>
            )}
            {/* 没有基准时不给假的金额 —— 但工时照给，那是系统记的 */}
            {l.money === null && l.hours === 0 && <span className="text-slate-300">—</span>}
          </span>
          {/* ★ 每一行都写清这个数字怎么来的，包括其中的假设 */}
          <span className="mt-0.5 block text-slate-400">{l.basis}</span>
        </li>
      ))}
    </ul>
  );
}
