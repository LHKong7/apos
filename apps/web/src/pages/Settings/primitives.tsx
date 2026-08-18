import clsx from 'clsx';
import { Label } from '@/components/ui/label';

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
  /**
   * ★ 仍然是「包起来」而不是 htmlFor：这个小件不认识子元素的 id，
   *   加一个必填的 id 参数要改几十个调用点。
   *   代价是子元素为 Radix Select 时，点标签文字只把焦点给到触发器、
   *   不展开下拉（Radix 在 pointerdown 上展开，而 label 转发的是 click）——
   *   聚焦后空格/回车/下箭头照常展开，所以不是死路。
   *
   *   Still wraps rather than associating by htmlFor: this atom does not know
   *   its child's id, and adding a required id would touch dozens of call
   *   sites. The cost is that when the child is a Radix Select, clicking the
   *   label text focuses the trigger without opening it — Radix opens on
   *   pointerdown and a label only forwards a click. Space/Enter/ArrowDown
   *   still open it from there.
   */
  return (
    <Label className="mt-2 block font-normal first:mt-0">
      <span className="flex items-center gap-1 text-xs font-medium text-slate-700">
        {label}
        {badge}
      </span>
      <div className="mt-1">{children}</div>
      {help && <p className="mt-1 text-[11px] text-slate-500">{help}</p>}
    </Label>
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
