import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '../../lib/api/client';
import { Card } from './Card';
import type { AnalyticsResponse } from '../../lib/api/types';

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
        title="人力成本基准"
        subtitle="这个数只有你知道。系统不替你填一个 —— 编出来的「省了多少」经不起一次追问"
      >
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-[11px] text-slate-600">
            {b.currency}
            <input
              type="number"
              min={0}
              step={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="未填"
              aria-label="人力小时成本"
              className="w-24 rounded border border-slate-300 px-1.5 py-0.5 text-xs"
            />
            / 小时
          </label>
          <button
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate()}
            className="rounded bg-slate-900 px-2 py-0.5 text-[11px] text-white hover:bg-slate-700 disabled:opacity-40"
          >
            {save.isPending ? '保存中…' : '保存'}
          </button>
          {draft.trim() !== '' && (
            <button
              type="button"
              onClick={() => {
                setDraft('');
                save.mutate();
              }}
              className="text-[11px] text-slate-500 hover:text-slate-700"
            >
              清空（回到「不换算」）
            </button>
          )}
        </div>
        {save.error && (
          <p className="mt-1 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
            {save.error instanceof ApiError ? save.error.message : '保存失败'}
          </p>
        )}
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        <Card title="收益侧">
          <Lines lines={benefits} currency={b.currency} />
        </Card>
        <Card title="代价侧" subtitle="不减掉这些就是在自欺">
          <Lines lines={costs} currency={b.currency} />
        </Card>
      </div>

      {b.hasBaseline && b.net !== null && (
        <Card title="算式" subtitle="每一步都摊开，好让你能对着追问">
          <p className="text-[11px] text-slate-600">
            {b.agentHours} 小时 × {b.currency}
            {b.laborHourlyCost}/h
            <span className="text-slate-400"> （Agent 承担的执行工时，按实际时长不按估算）</span>
          </p>
          <p className="text-[11px] text-slate-600">
            − {b.humanOverheadHours} 小时 × {b.currency}
            {b.laborHourlyCost}/h
            <span className="text-slate-400"> （人工覆盖占用的时间）</span>
          </p>
          <p className="text-[11px] text-slate-600">
            − {b.currency}
            {b.agentSpend}
            <span className="text-slate-400"> （Agent 的实际花费）</span>
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
