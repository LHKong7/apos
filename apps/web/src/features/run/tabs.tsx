import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { money, relativeTime } from '../../lib/format';
import type { RunDetail } from '../../lib/api/types';

/**
 * 输入 Tab（页面文档 09 §5.4）。
 *
 * ★ 上下文清单是排障的关键：很多失败的根因是「该给的没给」。
 *   把每一项列出来（来源、大小、是否可信），缺什么一眼看得出。
 */
export function InputTab({ detail }: { detail: RunDetail }) {
  const { input } = detail;

  return (
    <div className="space-y-4 text-xs">
      <Section title="目标">
        <p className="whitespace-pre-wrap text-slate-700">{input.goal}</p>
      </Section>

      <Section title={`上下文清单（${input.context.length} 项）`}>
        {input.context.length === 0 ? (
          <p className="rounded bg-amber-50 px-2 py-1.5 text-amber-800">
            没有携带任何上下文。如果这次 Run 因为「找不到信息」失败，这里就是原因。
          </p>
        ) : (
          <ul className="space-y-1">
            {input.context.map((c, i) => (
              <li key={c.ref ?? i} className="rounded border border-slate-200 p-1.5">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-slate-100 px-1 text-[10px] text-slate-600">
                    {c.kind ?? '未知来源'}
                  </span>
                  <span className="flex-1 truncate text-slate-700">{c.title ?? c.ref}</span>
                  {c.priority && (
                    <span className="text-[10px] text-slate-400">
                      {c.priority === 'must_read' ? '必读' : '参考'}
                    </span>
                  )}
                  {/* 不可信来源要标出来 —— 提示注入的入口就在这里 */}
                  {c.trusted === false && (
                    <span className="rounded bg-amber-100 px-1 text-[10px] text-amber-700">
                      来源不可信
                    </span>
                  )}
                  <span className="font-mono text-[10px] text-slate-400">
                    {c.content ? `${c.content.length} 字` : '—'}
                  </span>
                </div>
                {c.content && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[10px] text-slate-400">查看内容</summary>
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

      <Section title="模型与工具">
        <dl className="grid grid-cols-[5rem_1fr] gap-y-1 text-slate-700">
          <dt className="text-slate-400">模型</dt>
          <dd className="font-mono">{input.model ?? '—'}</dd>
          <dt className="text-slate-400">工具集</dt>
          <dd className="font-mono">{input.tools.join('、') || '—'}</dd>
        </dl>
      </Section>

      {/*
        ★ 权限快照。Agent 的权限可能在 Run 之后被改，
          审计回溯必须能看到「当时」是什么，而不是「现在」是什么。
      */}
      <Section title="权限快照（派发时）">
        {input.permissions ? (
          <dl className="grid grid-cols-[5rem_1fr] gap-y-1 text-slate-700">
            <dt className="text-slate-400">允许</dt>
            <dd className="font-mono">{input.permissions.allowedTools.join('、') || '（无）'}</dd>
            <dt className="text-slate-400">禁止</dt>
            <dd className="font-mono text-red-700">
              {input.permissions.deniedTools.join('、') || '（无）'}
            </dd>
            <dt className="text-slate-400">资源范围</dt>
            <dd className="font-mono">
              {input.permissions.resourceScopes
                .map((s) => `${s.kind}:${s.ref}(${s.access})`)
                .join('、') || '（无）'}
            </dd>
          </dl>
        ) : (
          <p className="text-slate-400">未记录</p>
        )}
      </Section>
    </div>
  );
}

export function ArtifactsTab({ detail }: { detail: RunDetail }) {
  if (detail.artifacts.length === 0) {
    return <p className="py-6 text-center text-xs text-slate-400">本次 Run 没有产出任何产物</p>;
  }

  const incomplete = ['failed', 'terminated', 'timeout'].includes(detail.run.status);

  return (
    <div className="space-y-2 text-xs">
      {incomplete && (
        <p className="rounded bg-amber-50 px-2 py-1.5 text-amber-800">
          以下产物来自未完成的 Run，使用前请人工确认
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
      <Section title="Token 明细">
        <dl className="grid grid-cols-[6rem_1fr] gap-y-1 tabular-nums text-slate-700">
          <dt className="text-slate-400">输入</dt>
          <dd>{tokens.input.toLocaleString()}</dd>
          <dt className="text-slate-400">输出</dt>
          <dd>{tokens.output.toLocaleString()}</dd>
          <dt className="text-slate-400">缓存命中</dt>
          <dd>
            {tokens.cacheRead.toLocaleString()}
            {/* 缓存命中率直接决定成本，单独标出来 */}
            <span className="ml-2 text-slate-400">
              命中率 {(tokens.cacheHitRate * 100).toFixed(0)}%
            </span>
          </dd>
          <dt className="text-slate-400">合计</dt>
          <dd className="font-medium">{tokens.total.toLocaleString()}</dd>
        </dl>
      </Section>

      {overrun !== null && overrun > 0.05 && (
        <p className="rounded bg-amber-50 px-2 py-1.5 text-amber-800">
          实际成本 {money(spent)} 超出预估 {money(estimated!)} 的 {(overrun * 100).toFixed(0)}%
        </p>
      )}

      <Section title="按步骤分布">
        {steps.length === 0 ? (
          <p className="text-slate-400">{breakdown.isPending ? '加载中…' : '没有成本记录'}</p>
        ) : (
          <ul className="space-y-1">
            {steps.map((s) => (
              <li key={`${s.step ?? 'pre'}`} className="flex items-center gap-2">
                <span className="w-8 shrink-0 text-right font-mono text-[10px] text-slate-400">
                  {s.step === null ? '起始' : `#${s.step}`}
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
  const error = detail.error;
  if (!error) {
    return <p className="py-6 text-center text-xs text-slate-400">这次 Run 没有报错</p>;
  }

  const failedAt = error.failedAt;

  return (
    <div className="space-y-4 text-xs">
      <div className="rounded border border-red-200 bg-red-50 p-2">
        <p className="font-medium text-red-800">
          ❌ Run 失败 · 第 {detail.run.attempt} 次尝试
        </p>
        <dl className="mt-2 grid grid-cols-[5rem_1fr] gap-y-1 text-red-900">
          <dt className="text-red-500">失败分类</dt>
          <dd>{ERROR_LABELS[error.class] ?? error.class}</dd>
          <dt className="text-red-500">失败步骤</dt>
          <dd>
            {failedAt.step !== null
              ? `步骤 ${failedAt.step}${failedAt.total ? `/${failedAt.total}` : ''}`
              : '未记录'}
          </dd>
          <dt className="text-red-500">错误摘要</dt>
          <dd className="break-words">{error.message ?? '（无）'}</dd>
        </dl>
      </div>

      {error.selfReport && (
        <Section title="Agent 的自述">
          <p className="whitespace-pre-wrap rounded bg-amber-50 p-2 leading-5 text-amber-900">
            {error.selfReport}
          </p>
        </Section>
      )}

      {detail.related.policies.length > 0 && (
        <Section title="系统判定">
          <ul className="space-y-1 text-slate-700">
            {detail.related.policies.map((p) => (
              <li key={p.eventId}>⚖ 命中「{p.policyName}」</li>
            ))}
          </ul>
        </Section>
      )}

      {error.detail && (
        <details>
          <summary className="cursor-pointer text-slate-400">展开原始错误</summary>
          <pre className="mt-1 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-[10px] text-slate-600">
            {JSON.stringify(error.detail, null, 2)}
          </pre>
        </details>
      )}

      <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-3">
        <button
          type="button"
          onClick={onRetry}
          className="rounded bg-slate-900 px-3 py-1 text-white hover:bg-slate-700"
        >
          补充上下文重试
        </button>
        <button
          type="button"
          onClick={onTakeover}
          className="rounded border border-slate-300 px-3 py-1 text-slate-700 hover:bg-slate-50"
        >
          我来接管
        </button>
      </div>
    </div>
  );
}

const ERROR_LABELS: Record<string, string> = {
  context_insufficient: '上下文不足',
  permission_denied: '权限不足',
  tool_failure: '工具执行失败',
  timeout: '超时',
  budget_exceeded: '预算耗尽',
  capability_mismatch: '能力不匹配',
  invalid_task: '任务定义有问题',
  external_unavailable: '外部依赖不可用',
  runtime_error: '运行时故障',
  unknown: '未分类',
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
