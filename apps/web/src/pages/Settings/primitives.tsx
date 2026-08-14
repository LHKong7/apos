import clsx from 'clsx';

/**
 * 设置区各页共用的排版小件。
 *
 * ★★ 单独一个文件，是因为「存储目标」从 Agent 配置里拆出去之后，这四个
 *   小件同时被两页用到。留在 AgentConfig.tsx 里再从存储页 import 的话，
 *   依赖方向就成了「存储页依赖 Agent 配置页」—— 而两页之间本来没有
 *   任何从属关系，那条 import 只是历史位置的残留。
 *
 *   Shared layout atoms for the settings pages. They live here rather than in
 *   AgentConfig.tsx because the storage page now needs them too, and importing
 *   them from a sibling page would encode a dependency that does not exist.
 *
 * ★ 只放**没有领域知识**的东西：接受 label / tone / children，不认识
 *   Agent、仓库或存储目标。有领域知识的组件属于它自己那一页。
 */

/** 带标签与说明的表单行 */
export function Labeled({
  label,
  help,
  badge,
  children,
}: {
  label: string;
  help?: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="mt-2 block first:mt-0">
      <span className="flex items-center gap-1 text-xs font-medium text-slate-700">
        {label}
        {badge}
      </span>
      <div className="mt-1">{children}</div>
      {help && <p className="mt-1 text-[11px] text-slate-500">{help}</p>}
    </label>
  );
}

/** 卡片上的一格「字段名 / 值」，配 <dl> 使用 */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-slate-400">{label}</dt>
      <dd
        className="truncate text-slate-700"
        title={typeof children === 'string' ? children : undefined}
      >
        {children}
      </dd>
    </div>
  );
}

export function StatusDot({ tone, label }: { tone: 'ok' | 'warning' | 'error'; label: string }) {
  return (
    <span
      className={clsx(
        'rounded px-1.5 py-0.5 text-[11px]',
        tone === 'ok'
          ? 'bg-emerald-50 text-emerald-700'
          : tone === 'warning'
            ? 'bg-amber-50 text-amber-800'
            : 'bg-rose-50 text-rose-700',
      )}
      title={label}
    >
      ● {label}
    </span>
  );
}

export function Notice({
  tone,
  children,
}: {
  tone: 'info' | 'warning' | 'error';
  children: React.ReactNode;
}) {
  return (
    <div
      className={clsx(
        'rounded border px-3 py-2 text-[11px]',
        tone === 'info'
          ? 'border-slate-200 bg-slate-50 text-slate-600'
          : tone === 'warning'
            ? 'border-amber-200 bg-amber-50 text-amber-800'
            : 'border-rose-200 bg-rose-50 text-rose-700',
      )}
    >
      {children}
    </div>
  );
}
