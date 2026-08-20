import { hasMessage, useT, type MessageKey } from '../../lib/i18n';
import { useState } from 'react';
import clsx from 'clsx';
import type { Insight, InsightAction } from '@apos/domain';
import { Button } from '@/components/ui/button';

const SEVERITY = {
  critical: { icon: '🔴', className: 'text-red-800', bg: 'bg-red-50' },
  warning: { icon: '🟡', className: 'text-amber-800', bg: 'bg-amber-50' },
  good: { icon: '🟢', className: 'text-green-800', bg: 'bg-green-50' },
} as const;

/**
 * 系统发现（页面文档 12 §5.1）—— 本页最重要的区域。
 *
 * ★ 页面成功标准写的是「系统发现的采纳率 > 30%」，不是「有多少人看过图表」。
 *   所以这块是整页唯一被计入价值的产出，其余图表都是它的论据。
 *   两条硬要求都在这里兑现：每条带动作、必须有正面发现。
 */
export function InsightsPanel({
  insights,
  onAction,
  lowConfidence,
}: {
  insights: Insight[];
  onAction: (action: InsightAction, insight: Insight) => void;
  lowConfidence: boolean;
}) {
  const t = useT();
  const [openEvidence, setOpenEvidence] = useState<number | null>(null);

  /**
   * ★★ 每条发现的说法按 `code` 从词条表取，不画服务端的 `message` / `evidence` ——
   *   那两个字段是中文。句子里的数字（百分比、时长、token 数）在服务端就已经
   *   格式化成语言中立的形态放进 `params`，这边只负责按各自语言的语序组织。
   *
   * ★ 认不出的码回落到中文原句：服务端加了一条新发现而词条还没跟上时，
   *   用户要看到的是一句能读的话，而不是一行 `analytics.insight.x.message`。
   */
  const copy = (i: Insight, part: 'message' | 'evidence') => {
    const key = `analytics.insight.${i.code}.${part}` as MessageKey;
    return hasMessage(key) ? t(key, i.params) : part === 'message' ? i.message : i.evidence;
  };
  const actionLabel = (a: InsightAction) => {
    const key = `analytics.insightAction.${a.code}` as MessageKey;
    return hasMessage(key) ? t(key, a.params ?? {}) : a.label;
  };

  if (insights.length === 0) {
    return (
      <div className="rounded border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500">
        {t('insights.noneFound')}
      </div>
    );
  }

  return (
    <section className="rounded border border-slate-200 bg-white">
      <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-1.5">
        <h2 className="text-xs font-medium text-slate-700">{t('insights.title', { count: insights.length })}</h2>
        {lowConfidence && (
          <span className="text-[11px] text-slate-400">
            {t('insights.lowConfidence')}
          </span>
        )}
      </div>

      <ul>
        {insights.map((insight, i) => {
          const meta = SEVERITY[insight.severity];
          return (
            <li
              key={`${insight.type}-${i}`}
              className={clsx('flex items-start gap-2 px-3 py-1.5 text-xs', i > 0 && 'border-t border-slate-100')}
            >
              <span aria-hidden>{meta.icon}</span>
              <div className="min-w-0 flex-1">
                <p className={clsx('leading-5', meta.className)}>{copy(insight, 'message')}</p>

                <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  {insight.actions.map((action) => (
                    <Button variant="outline" size="xs"
                      key={`${action.kind}-${action.code}`}
                      onClick={() => onAction(action, insight)}>
                      {actionLabel(action)} →
                    </Button>
                  ))}
                  {/*
                    ★ 判据可展开。
                      「决策等待占 34%」这种结论，用户第一反应是「真的吗，怎么算的」。
                      答不上来，他就不会照着它做任何事；这一页也就白做了。
                  */}
                  <Button variant="ghost"
                    onClick={() => setOpenEvidence(openEvidence === i ? null : i)}
                    className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent text-[11px] text-slate-400 underline hover:text-slate-600"
                  >
                    {openEvidence === i ? t('insights.hideEvidence') : t('insights.showEvidence')}
                  </Button>
                </div>

                {openEvidence === i && (
                  <p className={clsx('mt-1 rounded px-2 py-1 text-[11px] text-slate-600', meta.bg)}>
                    {copy(insight, 'evidence')}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
