import clsx from 'clsx';

const DIMENSIONS = [
  { key: 'goal', label: '目标' },
  { key: 'scope', label: '范围' },
  { key: 'acceptance', label: '验收' },
  { key: 'dependency', label: '依赖' },
  { key: 'risk', label: '风险' },
  { key: 'technical', label: '技术' },
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
  const total = scores.total ?? 0;

  return (
    <div className="flex flex-wrap items-center gap-3 text-xs">
      <span className="text-slate-600">需求完整度</span>
      <span className="h-2 w-24 overflow-hidden rounded-full bg-slate-200">
        <span
          className={clsx(
            'block h-full transition-all duration-500',
            total >= 80 ? 'bg-green-600' : total >= 60 ? 'bg-amber-500' : 'bg-red-500',
          )}
          style={{ width: `${Math.max(2, total)}%` }}
        />
      </span>
      <span className="font-semibold tabular-nums text-slate-900">{total} 分</span>

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
              title={`${d.label} ${v} 分`}
            >
              {d.label} {mark}
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
