import { useT, type MessageKey } from '../../lib/i18n';
import { useState } from 'react';
import clsx from 'clsx';
import { useMutation } from '@tanstack/react-query';
import type { FactKey } from '@apos/contracts';
import { ENV_LABELS, FACT_LABELS, OPERATION_LABELS } from '@apos/domain';
import { ApiError, api } from '../../lib/api/client';
import type { ScenarioTestResponse } from '../../lib/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const RISKS: { value: string; labelKey: MessageKey }[] = [
  { value: 'low', labelKey: 'scenario.riskLow' },
  { value: 'medium', labelKey: 'scenario.riskMedium' },
  { value: 'high', labelKey: 'scenario.riskHigh' },
  { value: 'critical', labelKey: 'scenario.riskCritical' },
];

const STATE_META = {
  matched: { icon: '✓', labelKey: 'scenario.hit', className: 'text-green-800 font-medium' },
  missed: { icon: '·', labelKey: 'scenario.miss', className: 'text-slate-500' },
  not_evaluated: { icon: '⊘', labelKey: 'scenario.notEvaluated', className: 'text-slate-400' },
} as const satisfies Record<string, { icon: string; labelKey: MessageKey; className: string }>;

/**
 * 构造场景测试（页面文档 13 §5.7）。
 *
 * ★ 这一页最常被问的问题是「我明明配了自动批准，为什么还找我」。
 *   答案永远是「被某条更高优先级的规则先拦下了」。
 *   所以这里的主体不是结论，而是**匹配过程** ——
 *   把优先级链条一条条画出来，标清楚哪条命中、哪些根本没被评估，
 *   用户自己就看懂了机制，下次不用再来问。
 */
export function ScenarioTester({ projectId }: { projectId: string }) {
  const t = useT();
  const [ctx, setCtx] = useState<Record<string, unknown>>({
    operationType: 'deploy',
    riskLevel: 'low',
    environment: 'production',
    runCost: 8,
  });
  const [error, setError] = useState<string | null>(null);

  const test = useMutation({
    mutationFn: () => api.testScenario(projectId, ctx),
    onError: (e) => setError(e instanceof ApiError ? e.message : t('scenario.testFailed')),
  });

  const set = (key: string, value: unknown) => setCtx((c) => ({ ...c, [key]: value }));

  return (
    <div className="space-y-3">
      <section className="rounded border border-slate-200 bg-white px-3 py-2">
        <h2 className="text-xs font-medium text-slate-700">{t('scenario.intro')}</h2>
        <p className="text-[11px] text-slate-400">
          {t('scenario.introHint')}
        </p>

        <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
          <Field label={t('scenario.operationType')}>
            <select
              value={String(ctx.operationType)}
              onChange={(e) => set('operationType', e.target.value)}
              className="w-full rounded border border-slate-300 px-1.5 py-1 text-xs"
            >
              {Object.entries(OPERATION_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t('scenario.riskLevel')}>
            <select
              value={String(ctx.riskLevel)}
              onChange={(e) => set('riskLevel', e.target.value)}
              className="w-full rounded border border-slate-300 px-1.5 py-1 text-xs"
            >
              {RISKS.map((r) => (
                <option key={r.value} value={r.value}>
                  {t(r.labelKey)}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t('scenario.environment')}>
            <select
              value={String(ctx.environment ?? '')}
              onChange={(e) => set('environment', e.target.value || null)}
              className="w-full rounded border border-slate-300 px-1.5 py-1 text-xs"
            >
              <option value="">{t('scenario.notApplicable')}</option>
              {['dev', 'test', 'staging', 'production'].map((v) => (
                <option key={v} value={v}>
                  {ENV_LABELS[v] ?? v}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t('scenario.cost')}>
            <Input
              type="number"
              value={Number(ctx.runCost)}
              onChange={(e) => set('runCost', Number(e.target.value))} />
          </Field>
        </div>

        <Button variant="neutral" size="sm"
          onClick={() => test.mutate()}
          disabled={test.isPending}
          className="mt-2">
          {test.isPending ? t('scenario.judging') : t('scenario.runTest')}
        </Button>
        {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
      </section>

      {test.data && <Result result={test.data} />}
    </div>
  );
}

function Result({ result }: { result: ScenarioTestResponse }) {
  const t = useT();
  const matchedIndex = result.trace.findIndex((t) => t.state === 'matched');
  const skipped = result.trace.filter((t) => t.state === 'not_evaluated').length;

  return (
    <section className="rounded border border-slate-200 bg-white px-3 py-2">
      <p
        className={clsx(
          'text-xs font-medium',
          result.requiresHuman ? 'text-amber-800' : 'text-green-800',
        )}
      >
        {result.requiresHuman ? t('scenario.needsHuman') : t('scenario.automatic')}
        {result.matchedPolicyName && (
          <span className="ml-2 font-normal text-slate-600">
            {t('scenario.matchedRule', { name: result.matchedPolicyName })}
          </span>
        )}
        {!result.matchedPolicyName && (
          <span className="ml-2 font-normal text-slate-600">
            {t('scenario.noMatch')}
          </span>
        )}
      </p>

      {/*
        ★ 匹配过程才是这块的价值。
          「未到达规则 #7 —— 被 #1 拦截」这一句解释掉了大部分困惑。
      */}
      <div className="mt-2">
        <p className="text-[11px] text-slate-500">
          {t('scenario.matchProcess')}
          {skipped > 0 && <span className="ml-1">{t('scenario.skipped', { count: skipped })}</span>}
        </p>
        <ul className="mt-1 space-y-0.5">
          {/* ★ 参数不叫 t —— 会遮住 i18n 的 t */}
          {result.trace.map((row, i) => {
            const meta = STATE_META[row.state];
            const fact = FACT_LABELS[row.failedAt?.fact as FactKey] ?? row.failedAt?.fact ?? '';
            return (
              <li
                key={row.policyId}
                className={clsx('flex items-center gap-2 text-[11px]', meta.className)}
              >
                <span className="w-4" aria-hidden>
                  {meta.icon}
                </span>
                <span className="w-10 tabular-nums">#{row.priority}</span>
                <span className="w-12 text-slate-400">
                  {row.scope === 'org' ? t('scenario.orgLevel') : t('scenario.projectLevel')}
                </span>
                <span className="min-w-0 flex-1 truncate">{row.name}</span>
                <span className="w-14 text-right">{t(meta.labelKey)}</span>
                {row.state === 'missed' && row.failedAt && (
                  <span
                    className="w-44 truncate text-slate-400"
                    title={t('scenario.diffDetail', {
                      fact,
                      actual: String(row.failedAt.actual),
                      expected: JSON.stringify(row.failedAt.expected),
                    })}
                  >
                    {t('scenario.diffOn', { fact })}
                  </span>
                )}
                {i === matchedIndex && (
                  <span className="w-20 text-right text-slate-500">{t('scenario.stopsHere')}</span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-[11px] text-slate-600">
      {label}
      <span className="mt-0.5 block">{children}</span>
    </label>
  );
}
