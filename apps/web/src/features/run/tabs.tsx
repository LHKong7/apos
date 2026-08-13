import { useT, type MessageKey } from '../../lib/i18n';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { money, relativeTime } from '../../lib/format';
import type { RunDetail } from '../../lib/api/types';
import { Button } from '@/components/ui/button';
import { ArtifactFiles } from './ArtifactFiles';

/**
 * 输入 Tab（页面文档 09 §5.4）。
 *
 * ★ 上下文清单是排障的关键：很多失败的根因是「该给的没给」。
 *   把每一项列出来（来源、大小、是否可信），缺什么一眼看得出。
 */
export function InputTab({ detail }: { detail: RunDetail }) {
  const t = useT();
  const { input } = detail;

  return (
    <div className="space-y-4 text-xs">
      <Section title={t('runTab.goal')}>
        <p className="whitespace-pre-wrap text-slate-700">{input.goal}</p>
      </Section>

      <Section title={t('runTab.contextList', { count: input.context.length })}>
        {input.context.length === 0 ? (
          <p className="rounded bg-amber-50 px-2 py-1.5 text-amber-800">
            {t('runTab.noContextWarning')}
          </p>
        ) : (
          <ul className="space-y-1">
            {input.context.map((c, i) => (
              <li key={c.ref ?? i} className="rounded border border-slate-200 p-1.5">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-slate-100 px-1 text-[10px] text-slate-600">
                    {c.kind ?? t('runTab.unknownSource')}
                  </span>
                  <span className="flex-1 truncate text-slate-700">{c.title ?? c.ref}</span>
                  {c.priority && (
                    <span className="text-[10px] text-slate-400">
                      {c.priority === 'must_read' ? t('runTab.mustRead') : t('runTab.reference')}
                    </span>
                  )}
                  {/* 不可信来源要标出来 —— 提示注入的入口就在这里 */}
                  {c.trusted === false && (
                    <span className="rounded bg-amber-100 px-1 text-[10px] text-amber-700">
                      {t('runTab.untrustedSource')}
                    </span>
                  )}
                  <span className="font-mono text-[10px] text-slate-400">
                    {c.content ? t('runTab.chars', { count: c.content.length }) : '—'}
                  </span>
                </div>
                {c.content && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[10px] text-slate-400">{t('runTab.viewContent')}</summary>
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[10px] text-slate-600">
                      {c.content}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t('runTab.modelAndTools')}>
        <dl className="grid grid-cols-[5rem_1fr] gap-y-1 text-slate-700">
          <dt className="text-slate-400">{t('runTab.model')}</dt>
          <dd className="font-mono">{input.model ?? '—'}</dd>
          <dt className="text-slate-400">{t('runTab.toolset')}</dt>
          <dd className="font-mono">{input.tools.join('、') || '—'}</dd>
        </dl>
      </Section>

      {/*
        ★ 权限快照。Agent 的权限可能在 Run 之后被改，
          审计回溯必须能看到「当时」是什么，而不是「现在」是什么。
      */}
      <Section title={t('runTab.permissionSnapshot')}>
        {input.permissions ? (
          <dl className="grid grid-cols-[5rem_1fr] gap-y-1 text-slate-700">
            <dt className="text-slate-400">{t('runTab.allowed')}</dt>
            <dd className="font-mono">{input.permissions.allowedTools.join('、') || t('runTab.none')}</dd>
            <dt className="text-slate-400">{t('runTab.denied')}</dt>
            <dd className="font-mono text-red-700">
              {input.permissions.deniedTools.join('、') || t('runTab.none')}
            </dd>
            <dt className="text-slate-400">{t('runTab.resourceScopes')}</dt>
            <dd className="font-mono">
              {input.permissions.resourceScopes
                .map((s) => `${s.kind}:${s.ref}(${s.access})`)
                .join('、') || t('runTab.none')}
            </dd>
          </dl>
        ) : (
          <p className="text-slate-400">{t('runTab.notRecorded')}</p>
        )}
      </Section>
    </div>
  );
}

export function ArtifactsTab({ detail }: { detail: RunDetail }) {
  const t = useT();
  if (detail.artifacts.length === 0) {
    return <p className="py-6 text-center text-xs text-slate-400">{t('runTab.noArtifacts')}</p>;
  }

  const incomplete = ['failed', 'terminated', 'timeout'].includes(detail.run.status);

  return (
    <div className="space-y-2 text-xs">
      {incomplete && (
        <p className="rounded bg-amber-50 px-2 py-1.5 text-amber-800">
          {t('runTab.incompleteArtifacts')}
        </p>
      )}
      {detail.artifacts.map((a) => (
        <article key={a.id} className="rounded border border-slate-200 p-2">
          <div className="flex items-center gap-2">
            <span className="rounded bg-slate-100 px-1 text-[10px] text-slate-600">{a.kind}</span>
            <span className="flex-1 truncate font-medium text-slate-800">{a.title}</span>
            <span className="text-[10px] text-slate-400">{relativeTime(a.createdAt)}</span>
          </div>
          {a.externalUrl && (
            <a
              href={a.externalUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block truncate text-sky-700 underline"
            >
              {a.externalUrl}
            </a>
          )}
          {a.content && (
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-[10px] leading-4 text-slate-600">
              {a.content}
            </pre>
          )}
          {/*
            ★ 本地归档的产物在这里才第一次能被打开。此前页面只拿得到
              「改了 N 个文件」和文件名，内容要看只能上服务器。
              不是本地归档的（git / 对象存储）这个组件自己不渲染。
          */}
          <ArtifactFiles artifactId={a.id} />
        </article>
      ))}
    </div>
  );
}

/**
 * 成本 Tab（页面文档 09 §5.6）。
 *
 * 回答「哪一步烧钱」。只给总数的话，成本超支永远只能得到
 * 「超了 28%」这一个结论，没法往下追。
 */
export function CostTab({ detail }: { detail: RunDetail }) {
  const t = useT();
  const breakdown = useQuery({
    queryKey: qk.runCost(detail.run.id),
    queryFn: () => api.runCostBreakdown(detail.run.id),
  });

  const { tokens } = detail.metrics;
  const spent = Number(detail.metrics.cost);
  const estimated = detail.metrics.estimatedCost ? Number(detail.metrics.estimatedCost) : null;
  const overrun = estimated && estimated > 0 ? (spent - estimated) / estimated : null;

  const steps = breakdown.data?.steps ?? [];
  const maxCost = Math.max(...steps.map((s) => s.costUsd), 0.0001);

  return (
    <div className="space-y-4 text-xs">
      <Section title={t('runTab.tokenBreakdown')}>
        <dl className="grid grid-cols-[6rem_1fr] gap-y-1 tabular-nums text-slate-700">
          <dt className="text-slate-400">{t('runTab.input')}</dt>
          <dd>{tokens.input.toLocaleString()}</dd>
          <dt className="text-slate-400">{t('runTab.output')}</dt>
          <dd>{tokens.output.toLocaleString()}</dd>
          <dt className="text-slate-400">{t('runTab.cacheHit')}</dt>
          <dd>
            {tokens.cacheRead.toLocaleString()}
            {/* 缓存命中率直接决定成本，单独标出来 */}
            <span className="ml-2 text-slate-400">
              {t('runTab.cacheHitRate', { percent: (tokens.cacheHitRate * 100).toFixed(0) })}
            </span>
          </dd>
          <dt className="text-slate-400">{t('runTab.total')}</dt>
          <dd className="font-medium">{tokens.total.toLocaleString()}</dd>
        </dl>
      </Section>

      {overrun !== null && overrun > 0.05 && (
        <p className="rounded bg-amber-50 px-2 py-1.5 text-amber-800">
          {t('runTab.costOverrun', {
            spent: money(spent),
            estimated: money(estimated!),
            percent: (overrun * 100).toFixed(0),
          })}
        </p>
      )}

      <Section title={t('runTab.byStep')}>
        {steps.length === 0 ? (
          <p className="text-slate-400">{breakdown.isPending ? t('common.loading') : t('runTab.noCostRecords')}</p>
        ) : (
          <ul className="space-y-1">
            {steps.map((s) => (
              <li key={`${s.step ?? 'pre'}`} className="flex items-center gap-2">
                <span className="w-8 shrink-0 text-right font-mono text-[10px] text-slate-400">
                  {s.step === null ? t('runTab.start') : `#${s.step}`}
                </span>
                <span className="min-w-0 flex-1 truncate text-slate-700">{s.description}</span>
                <span className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-slate-200">
                  <span
                    className="block h-full bg-agent"
                    style={{ width: `${(s.costUsd / maxCost) * 100}%` }}
                  />
                </span>
                <span className="w-16 shrink-0 text-right font-mono tabular-nums text-slate-600">
                  {money(s.costUsd)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

/**
 * 错误 Tab（页面文档 09 §5.7）。
 *
 * ★ 「Agent 的自述」是关键设计：让 Agent 用人话解释自己为什么卡住，
 *   比堆栈有用得多。堆栈告诉你哪行代码抛了异常，自述告诉你缺什么。
 */
export function ErrorTab({
  detail,
  onRetry,
  onTakeover,
}: {
  detail: RunDetail;
  onRetry: () => void;
  onTakeover: () => void;
}) {
  const t = useT();
  const error = detail.error;
  if (!error) {
    return <p className="py-6 text-center text-xs text-slate-400">{t('runTab.noErrors')}</p>;
  }

  const failedAt = error.failedAt;

  return (
    <div className="space-y-4 text-xs">
      <div className="rounded border border-red-200 bg-red-50 p-2">
        <p className="font-medium text-red-800">
          {t('runTab.runFailed', { n: detail.run.attempt })}
        </p>
        <dl className="mt-2 grid grid-cols-[5rem_1fr] gap-y-1 text-red-900">
          <dt className="text-red-500">{t('runTab.failureClass')}</dt>
          {/* ★ 认不出的分类回落到原始值，而不是渲染词条键本身 */}
          <dd>{ERROR_LABELS[error.class] ? t(ERROR_LABELS[error.class]!) : error.class}</dd>
          <dt className="text-red-500">{t('runTab.failureStep')}</dt>
          <dd>
            {failedAt.step !== null
              ? t('runTab.stepOf', {
                  step: failedAt.step,
                  total: failedAt.total ? `/${failedAt.total}` : '',
                })
              : t('runTab.notRecorded')}
          </dd>
          <dt className="text-red-500">{t('runTab.errorSummary')}</dt>
          <dd className="break-words">{error.message ?? t('runTab.none')}</dd>
        </dl>
      </div>

      {error.selfReport && (
        <Section title={t('runTab.agentAccount')}>
          <p className="whitespace-pre-wrap rounded bg-amber-50 p-2 leading-5 text-amber-900">
            {error.selfReport}
          </p>
        </Section>
      )}

      {detail.related.policies.length > 0 && (
        <Section title={t('runTab.systemVerdict')}>
          <ul className="space-y-1 text-slate-700">
            {detail.related.policies.map((p) => (
              <li key={p.eventId}>{t('runTab.policyHit', { name: p.policyName ?? '' })}</li>
            ))}
          </ul>
        </Section>
      )}

      {error.detail && (
        <details>
          <summary className="cursor-pointer text-slate-400">{t('runTab.showRawError')}</summary>
          <pre className="mt-1 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-[10px] text-slate-600">
            {JSON.stringify(error.detail, null, 2)}
          </pre>
        </details>
      )}

      <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-3">
        <Button variant="neutral"
          onClick={onRetry}>
          {t('runTab.retryWithContext')}
        </Button>
        <Button variant="outline"
          onClick={onTakeover}>
          {t('runTab.takeOver')}
        </Button>
      </div>
    </div>
  );
}

/**
 * 错误分类 → 词条键 / Error class → message key.
 *
 * ★ 存**键**不存译文：模块级常量取不到 hook，存译文的话切语言时不会重算，
 *   界面会停在第一次渲染的那个语言。渲染处负责 t()。
 */
const ERROR_LABELS: Record<string, MessageKey> = {
  context_insufficient: 'errClass.context_insufficient',
  permission_denied: 'errClass.permission_denied',
  tool_failure: 'errClass.tool_failure',
  timeout: 'errClass.timeout',
  budget_exceeded: 'errClass.budget_exceeded',
  capability_mismatch: 'errClass.capability_mismatch',
  invalid_task: 'errClass.invalid_task',
  external_unavailable: 'errClass.external_unavailable',
  runtime_error: 'errClass.runtime_error',
  unknown: 'errClass.unknown',
};

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
        {title}
      </h4>
      {children}
    </section>
  );
}

export { clsx };
