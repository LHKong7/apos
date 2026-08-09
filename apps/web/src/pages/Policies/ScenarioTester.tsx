import { useState } from 'react';
import clsx from 'clsx';
import { useMutation } from '@tanstack/react-query';
import type { FactKey } from '@apos/contracts';
import { ENV_LABELS, FACT_LABELS, OPERATION_LABELS } from '@apos/domain';
import { ApiError, api } from '../../lib/api/client';
import type { ScenarioTestResponse } from '../../lib/api/types';

const RISKS = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'critical', label: '极高' },
];

const STATE_META = {
  matched: { icon: '✓', label: '命中', className: 'text-green-800 font-medium' },
  missed: { icon: '·', label: '未命中', className: 'text-slate-500' },
  not_evaluated: { icon: '⊘', label: '未评估', className: 'text-slate-300' },
} as const;

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
  const [ctx, setCtx] = useState<Record<string, unknown>>({
    operationType: 'deploy',
    riskLevel: 'low',
    environment: 'production',
    runCost: 8,
  });
  const [error, setError] = useState<string | null>(null);

  const test = useMutation({
    mutationFn: () => api.testScenario(projectId, ctx),
    onError: (e) => setError(e instanceof ApiError ? e.message : '测试失败'),
  });

  const set = (key: string, value: unknown) => setCtx((c) => ({ ...c, [key]: value }));

  return (
    <div className="space-y-3">
      <section className="rounded border border-slate-200 bg-white px-3 py-2">
        <h2 className="text-xs font-medium text-slate-700">构造一个场景，看系统会怎么判</h2>
        <p className="text-[11px] text-slate-400">
          排查「为什么这个操作还要找我」最快的路径
        </p>

        <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
          <Field label="操作类型">
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

          <Field label="风险等级">
            <select
              value={String(ctx.riskLevel)}
              onChange={(e) => set('riskLevel', e.target.value)}
              className="w-full rounded border border-slate-300 px-1.5 py-1 text-xs"
            >
              {RISKS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="操作环境">
            <select
              value={String(ctx.environment ?? '')}
              onChange={(e) => set('environment', e.target.value || null)}
              className="w-full rounded border border-slate-300 px-1.5 py-1 text-xs"
            >
              <option value="">不涉及</option>
              {['dev', 'test', 'staging', 'production'].map((v) => (
                <option key={v} value={v}>
                  {ENV_LABELS[v] ?? v}
                </option>
              ))}
            </select>
          </Field>

          <Field label="本次成本（USD）">
            <input
              type="number"
              value={Number(ctx.runCost)}
              onChange={(e) => set('runCost', Number(e.target.value))}
              className="w-full rounded border border-slate-300 px-1.5 py-1 text-xs"
            />
          </Field>
        </div>

        <button
          type="button"
          onClick={() => test.mutate()}
          disabled={test.isPending}
          className="mt-2 rounded bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {test.isPending ? '判定中…' : '运行测试'}
        </button>
        {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
      </section>

      {test.data && <Result result={test.data} />}
    </div>
  );
}

function Result({ result }: { result: ScenarioTestResponse }) {
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
        {result.requiresHuman ? '⚠ 需要人类确认' : '✓ 自动执行'}
        {result.matchedPolicyName && (
          <span className="ml-2 font-normal text-slate-600">
            命中规则「{result.matchedPolicyName}」
          </span>
        )}
        {!result.matchedPolicyName && (
          <span className="ml-2 font-normal text-slate-600">
            没有规则命中，走自治等级的默认策略
          </span>
        )}
      </p>

      {/*
        ★ 匹配过程才是这块的价值。
          「未到达规则 #7 —— 被 #1 拦截」这一句解释掉了大部分困惑。
      */}
      <div className="mt-2">
        <p className="text-[11px] text-slate-500">
          匹配过程（按优先级从上到下，命中即停）
          {skipped > 0 && <span className="ml-1">· 后面 {skipped} 条根本没被评估</span>}
        </p>
        <ul className="mt-1 space-y-0.5">
          {result.trace.map((t, i) => {
            const meta = STATE_META[t.state];
            return (
              <li key={t.policyId} className={clsx('flex items-center gap-2 text-[11px]', meta.className)}>
                <span className="w-4" aria-hidden>
                  {meta.icon}
                </span>
                <span className="w-10 tabular-nums">#{t.priority}</span>
                <span className="w-12 text-slate-400">{t.scope === 'org' ? '组织级' : '项目级'}</span>
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                <span className="w-14 text-right">{meta.label}</span>
                {t.state === 'missed' && t.failedAt && (
                  <span
                    className="w-44 truncate text-slate-400"
                    title={`${FACT_LABELS[t.failedAt.fact as FactKey] ?? t.failedAt.fact} 实际是 ${String(t.failedAt.actual)}，规则要求 ${JSON.stringify(t.failedAt.expected)}`}
                  >
                    差在{FACT_LABELS[t.failedAt.fact as FactKey] ?? t.failedAt.fact}
                  </span>
                )}
                {i === matchedIndex && (
                  <span className="w-20 text-right text-slate-500">← 到此为止</span>
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
