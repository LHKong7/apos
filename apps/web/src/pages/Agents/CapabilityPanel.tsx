import { useState } from 'react';
import clsx from 'clsx';
import type { CapabilityReport } from '../../lib/api/types';

/**
 * 运行时能力报告（页面文档 08 §5 / 14 §5.4）。
 *
 * ★ 「不静默降级」是 Agent 协议里最重要的一条约定，这个组件就是它的界面。
 *   所以顺序是反直觉的：先说「做不到什么」，再说「能做什么」。
 *   一个把 14 个能力项打满绿勾、把缺失折叠到底部的面板，
 *   等于把降级又藏回去了 —— 用户在派高风险任务之前，
 *   有权先看见「这个 Agent 的暂停其实是终止」。
 *
 * ★ 每条缺失都摊开三段：降级后的行为、对用户的影响、严重程度。
 *   只写「不支持 pause」是没用的，用户没法据此做决定；
 *   写「暂停降级为终止，会丢失执行中的进度」才是可决策的信息。
 */
export function CapabilityPanel({
  report,
  runtimeName,
}: {
  report: CapabilityReport;
  runtimeName: string;
}) {
  const [showTools, setShowTools] = useState(false);

  // critical 排最前 —— 它决定「这个运行时能不能碰高风险任务」
  const missing = [...report.missing].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity),
  );

  return (
    <section className="rounded border border-slate-200 bg-white">
      <div className="flex flex-wrap items-baseline gap-2 border-b border-slate-100 px-3 py-1.5">
        <h2 className="text-xs font-medium text-slate-700">⚙ 运行时能力</h2>
        {/* 数据库里的运行时名和适配器自报的名字常常是同一个，重复印两遍只是噪音 */}
        <span className="text-[11px] text-slate-500">
          {runtimeName === report.runtime.name ? '' : `${runtimeName} · `}
          {report.runtime.name} {report.runtime.version} · 协议 {report.protocolVersion}
        </span>
        <span className="ml-auto text-[11px] text-slate-500">
          支持 {report.supported.length} / {report.supported.length + report.missing.length}
        </span>
      </div>

      {/* ★ restricted 是硬结论，不是又一条提示：critical 缺失意味着
          终止不可靠、成本可能泄漏，这类运行时不该承接高风险任务。 */}
      {report.restricted && (
        <p className="border-b border-red-100 bg-red-50 px-3 py-1.5 text-[11px] text-red-800">
          ⚠ 存在 critical 级缺失，不应把高风险任务派给这个运行时上的 Agent
        </p>
      )}

      {/* ── 做不到什么（先说这个） ── */}
      {missing.length === 0 ? (
        <p className="px-3 py-2 text-[11px] text-slate-500">
          协议定义的 {report.supported.length} 项能力全部支持，没有降级
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {missing.map((m) => (
            <li key={m.feature} className="px-3 py-1.5">
              <p className="text-xs">
                <span className={clsx('font-medium', SEVERITY_TONE[m.severity] ?? 'text-slate-600')}>
                  ✗ {m.label}
                </span>
                <span
                  className={clsx(
                    'ml-1.5 rounded px-1 text-[10px]',
                    SEVERITY_BADGE[m.severity] ?? 'bg-slate-100 text-slate-600',
                  )}
                >
                  {SEVERITY_LABELS[m.severity] ?? m.severity}
                </span>
              </p>
              {/* 降级后系统实际怎么做 → 用户会感受到什么 */}
              <p className="text-[11px] text-slate-600">{m.behavior}</p>
              <p className="text-[11px] text-slate-500">→ {m.userImpact}</p>
            </li>
          ))}
        </ul>
      )}

      {/* ── 能做什么 ── */}
      {report.supported.length > 0 && (
        <div className="border-t border-slate-100 px-3 py-1.5">
          <p className="text-[11px] text-slate-500">已支持</p>
          <p className="text-[11px] text-slate-600">
            {report.supported.map((s) => s.label).join('、')}
          </p>
        </div>
      )}

      {/* ── 运行参数 ── */}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 border-t border-slate-100 px-3 py-1.5 text-[11px] text-slate-500">
        <span>事件通道 {TRANSPORT_LABELS[report.transport.eventDelivery] ?? report.transport.eventDelivery}</span>
        <span>
          心跳{' '}
          {report.transport.heartbeatIntervalSeconds === null
            ? '无'
            : `${report.transport.heartbeatIntervalSeconds}s`}
        </span>
        <span>并发上限 {report.limits.maxConcurrentRuns}</span>
        <span>单次最长 {Math.round(report.limits.maxRunDurationSeconds / 60)} 分钟</span>
        {report.limits.maxContextTokens !== null && (
          <span>上下文 {formatTokens(report.limits.maxContextTokens)}</span>
        )}
        {report.models.length > 0 && <span>模型 {report.models.join('、')}</span>}
      </div>

      {/* ── 工具清单 ──
          ★ 按副作用等级标色而不是按字母排。用户扫这张表是为了找
            「它能不能删东西 / 能不能碰外部系统」，不是为了查字典。 */}
      {report.tools.length > 0 && (
        <div className="border-t border-slate-100 px-3 py-1.5">
          <button
            type="button"
            onClick={() => setShowTools((v) => !v)}
            className="text-[11px] text-slate-500 hover:text-slate-700"
          >
            {showTools ? '▾' : '▸'} 运行时提供的工具（{report.tools.length}）
            {!showTools && riskyCount(report) > 0 && (
              <span className="ml-1 text-amber-700">其中 {riskyCount(report)} 个有写入或外部副作用</span>
            )}
          </button>
          {showTools && (
            <ul className="mt-1 space-y-0.5">
              {[...report.tools]
                .sort((a, b) => effectRank(b.sideEffects) - effectRank(a.sideEffects))
                .map((t) => (
                  <li key={t.name} className="text-[11px]">
                    <span className="text-slate-700">{t.name}</span>
                    <span className="ml-1 text-slate-500">{t.description}</span>
                    <span className={clsx('ml-1', EFFECT_TONE[t.sideEffects] ?? 'text-slate-400')}>
                      {EFFECT_LABELS[t.sideEffects] ?? t.sideEffects}
                    </span>
                  </li>
                ))}
            </ul>
          )}
          <p className="mt-1 text-[11px] text-slate-400">
            这是运行时声明能提供的工具；某个 Agent 实际能用哪些，由它自己的权限边界决定
          </p>
        </div>
      )}
    </section>
  );
}

const SEVERITY_TONE: Record<string, string> = {
  critical: 'text-red-700',
  warning: 'text-amber-700',
  info: 'text-slate-600',
};

const SEVERITY_BADGE: Record<string, string> = {
  critical: 'bg-red-50 text-red-700',
  warning: 'bg-amber-50 text-amber-700',
  info: 'bg-slate-100 text-slate-600',
};

const SEVERITY_LABELS: Record<string, string> = {
  critical: '严重',
  warning: '注意',
  info: '提示',
};

const TRANSPORT_LABELS: Record<string, string> = {
  sse: 'SSE 推送',
  webhook: 'Webhook 回调',
  poll: '轮询',
};

const EFFECT_TONE: Record<string, string> = {
  destructive: 'text-red-700',
  external: 'text-orange-700',
  write: 'text-amber-700',
  read: 'text-slate-400',
  none: 'text-slate-400',
};

const EFFECT_LABELS: Record<string, string> = {
  destructive: '破坏性',
  external: '外部系统',
  write: '写入',
  read: '只读',
  none: '无副作用',
};

function severityRank(s: string): number {
  return s === 'critical' ? 3 : s === 'warning' ? 2 : 1;
}

function effectRank(e: string): number {
  return e === 'destructive' ? 4 : e === 'external' ? 3 : e === 'write' ? 2 : e === 'read' ? 1 : 0;
}

function riskyCount(report: CapabilityReport): number {
  return report.tools.filter((t) => effectRank(t.sideEffects) >= 2).length;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}
