import { useT, type MessageKey } from '../../lib/i18n';
import clsx from 'clsx';

const DIMENSIONS = [
  { key: 'goal', labelKey: 'completeness.goal' as MessageKey },
  { key: 'scope', labelKey: 'completeness.scope' as MessageKey },
  { key: 'acceptance', labelKey: 'completeness.acceptance' as MessageKey },
  { key: 'dependency', labelKey: 'completeness.dependency' as MessageKey },
  { key: 'risk', labelKey: 'completeness.risk' as MessageKey },
  { key: 'technical', labelKey: 'completeness.technical' as MessageKey },
] as const;

/**
 * 需求完整度（页面文档 03 §5.2）。
 *
 * ★ 总分不是门槛。低分不阻止确认，只提示「Agent 可能产生较多返工」——
 *   把它做成硬门槛，用户会为了凑分数瞎填，得到的是更差的需求
 *   加上一个好看的数字。
 *
 * ★ 分数要随回答实时回升。这是给用户的正反馈：
 *   「我刚才那一下是有用的」，比任何说明文字都更能推动他答完剩下的问题。
 */
export function Completeness({ scores }: { scores: Record<string, number> }) {
  const t = useT();
  const total = scores.total ?? 0;

  return (
    <div className="flex flex-wrap items-center gap-3 text-xs">
      <span className="text-slate-600">{t('completeness.title')}</span>
      <span className="h-2 w-24 overflow-hidden rounded-full bg-slate-200">
        <span
          className={clsx(
            'block h-full transition-all duration-500',
            total >= 80 ? 'bg-green-600' : total >= 60 ? 'bg-amber-500' : 'bg-red-500',
          )}
          style={{ width: `${Math.max(2, total)}%` }}
        />
      </span>
      <span className="font-semibold tabular-nums text-slate-900">{t('completeness.score', { score: total })}</span>

      <span className="flex flex-wrap items-center gap-2">
        {DIMENSIONS.map((d) => {
          const v = scores[d.key] ?? 0;
          const mark = v >= 80 ? '✓' : v >= 40 ? '⚠' : '✗';
          return (
            <span
              key={d.key}
              className={clsx(
                'text-[11px]',
                v >= 80 ? 'text-green-700' : v >= 40 ? 'text-amber-700' : 'text-red-600',
              )}
              title={t('completeness.itemScore', { label: t(d.labelKey), score: v })}
            >
              {t(d.labelKey)} {mark}
            </span>
          );
        })}
      </span>

      {total < 60 && (
        <span className="text-[11px] text-amber-700">
          完整度较低，Agent 可能产生较多返工 —— 但不阻止你确认
        </span>
      )}
    </div>
  );
}
