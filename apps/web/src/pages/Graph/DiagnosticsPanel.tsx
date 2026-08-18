import { useT } from '../../lib/i18n';
import { useState } from 'react';
import clsx from 'clsx';
import type { Diagnostic, DiagnosticAction } from '@apos/domain';
import { Button } from '@/components/ui/button';

const SEVERITY_META = {
  critical: { icon: '⛔', className: 'text-red-700' },
  warning: { icon: '⚠', className: 'text-amber-700' },
  info: { icon: '💡', className: 'text-slate-600' },
} as const;

/** 折叠时露出几条 —— 诊断区不该抢走画布的高度 */
const COLLAPSED = 3;

/**
 * 图中发现的问题（页面文档 07 §5.8）。
 *
 * ★ 这是本页的「智能」所在，也最容易变成装饰。
 *   每条诊断都必须带可执行动作 —— 只说「有问题」不说「怎么办」的提示，
 *   用户看两次就会忽略整个区域，然后这一页就退化成一张好看的图。
 */
export function DiagnosticsPanel({
  diagnostics,
  onAction,
  onFocus,
}: {
  diagnostics: Diagnostic[];
  onAction: (action: DiagnosticAction) => void;
  onFocus: (nodeId: string) => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);

  if (diagnostics.length === 0) {
    return (
      <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-2 text-xs text-slate-500">
        {t('diag.noneFound')}
      </div>
    );
  }

  const visible = expanded ? diagnostics : diagnostics.slice(0, COLLAPSED);

  return (
    <div className="max-h-48 shrink-0 overflow-y-auto border-t border-slate-200 bg-white px-4 py-2">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-xs font-medium text-slate-700">
          {t('diag.found', { count: diagnostics.length })}
        </h2>
        {diagnostics.length > COLLAPSED && (
          <Button variant="ghost"
            onClick={() => setExpanded((v) => !v)}
            className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent text-[11px] text-slate-500 underline"
          >
            {expanded ? t('timeline.collapse') : t('graph.expandRest', { count: diagnostics.length - COLLAPSED })}
          </Button>
        )}
      </div>

      <ul className="space-y-1.5">
        {visible.map((d, i) => {
          const meta = SEVERITY_META[d.severity];
          return (
            <li key={`${d.type}-${i}`} className="flex items-start gap-2 text-xs">
              <span aria-hidden className={meta.className}>
                {meta.icon}
              </span>
              <div className="min-w-0 flex-1">
                <p className={clsx('leading-5', meta.className)}>{d.message}</p>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  {d.actions.map((action) => (
                    <Button variant="outline" size="xs"
                      key={`${action.kind}-${action.label}`}
                      onClick={() => onAction(action)}>
                      {action.label}
                    </Button>
                  ))}
                  {d.affectedNodes[0] && (
                    <Button variant="ghost"
                      onClick={() => onFocus(d.affectedNodes[0]!)}
                      className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent text-[11px] text-slate-400 underline hover:text-slate-600"
                    >
                      {t('diag.locate', { count: d.affectedNodes.length })}
                    </Button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
