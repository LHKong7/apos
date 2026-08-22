import { useState } from 'react';
import clsx from 'clsx';
import { Label } from '@/components/ui/label';

/**
 * Shared layout atoms for the settings pages / 设置区各页共用的排版小件。
 *
 * ★★ They get their own file because once the storage target was split out of
 *   the Agent config page, these four atoms were needed by both pages. Leaving
 *   them in AgentConfig.tsx and importing them from the storage page would
 *   encode "the storage page depends on the Agent config page" — the two pages
 *   have no such relationship, and that import would be nothing but a residue
 *   of where the code happened to be written first.
 *
 *   单独一个文件，是因为「存储目标」从 Agent 配置里拆出去之后，这四个小件
 *   同时被两页用到。留在 AgentConfig.tsx 里再从存储页 import 的话，依赖方向
 *   就成了「存储页依赖 Agent 配置页」—— 而两页之间本来没有任何从属关系，
 *   那条 import 只是历史位置的残留。
 *
 * ★ Only things with **no domain knowledge** live here: they take label / tone
 *   / children and know nothing of Agents, repositories, or storage targets.
 *   Anything that knows the domain belongs to the page that owns it.
 *
 *   只放**没有领域知识**的东西：接受 label / tone / children，不认识
 *   Agent、仓库或存储目标。有领域知识的组件属于它自己那一页。
 */

/** A form row with a label and help text */
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
   * ★ Still wraps rather than associating by htmlFor: this atom does not know
   *   its child's id, and adding a required id parameter would touch dozens of
   *   call sites. The cost is that when the child is a Radix Select, clicking
   *   the label text focuses the trigger without opening it — Radix opens on
   *   pointerdown and a label only forwards a click. Space/Enter/ArrowDown
   *   still open it from there, so it is not a dead end.
   *
   *   仍然是「包起来」而不是 htmlFor：这个小件不认识子元素的 id，加一个必填
   *   的 id 参数要改几十个调用点。代价是子元素为 Radix Select 时，点标签文字
   *   只把焦点给到触发器、不展开下拉 —— 聚焦后空格/回车/下箭头照常展开。
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

/** One "field name / value" cell on a card, meant to sit inside a <dl> */
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

/**
 * A three-sentence primer for a settings page / 「这一页是干什么的」。
 *
 * ★★ The settings area speaks entirely in domain vocabulary: Policy, Agent
 *   capabilities, RBAC, RLS, audit log. Those words are precise to whoever
 *   wrote them and a wall to a product or project manager. The first thing
 *   they do on opening the page is decide "does this concern me at all", and
 *   nothing on the page answered that question (issue #42).
 *
 *   设置区通篇是领域词汇：Policy、Agent capabilities、RBAC、RLS、审计日志。
 *   这些词对写它的人是精确的，对产品经理或项目经理是一堵墙 —— 他打开这一页
 *   第一件事是判断「这跟我有关系吗」，而页面上没有一句话回答（问题记录 #42）。
 *
 * ★ Expanded by **default**, and it says three things in one pass: what this
 *   is, when you would need to touch it, and what happens if you never do.
 *   Someone who has read it can collapse it, and the collapsed state is kept in
 *   localStorage — otherwise they would dismiss it again on every visit to
 *   settings, which is more annoying than not having it at all.
 *
 *   默认展开，一次性写清三件事：这是什么、什么时候需要动它、不动会怎样。
 *   收起状态记在 localStorage 里，否则每次进设置都要重新关一遍。
 *
 * ★ Never write "see the docs for more". If a reader has to leave the page to
 *   understand this blurb, the blurb is the thing that is wrong.
 *
 *   不写「更多信息见文档」。真需要跳出去读文档才能懂的话，这段话就没写好。
 */
export function WhatIsThis({
  storageKey,
  title,
  children,
}: {
  /** One key per page; remembers that this reader has already read it */
  storageKey: string;
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(() => readDismissed(storageKey) === false);

  const toggle = () => {
    setOpen((v) => {
      writeDismissed(storageKey, v);
      return !v;
    });
  };

  return (
    <section className="rounded border border-sky-200 bg-sky-50/60 px-3 py-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex w-full items-center gap-1.5 text-left text-xs font-medium text-sky-900"
      >
        <span aria-hidden>{open ? '▾' : '▸'}</span>
        {title}
      </button>
      {open && <div className="mt-1 space-y-1 text-[11px] leading-5 text-sky-900">{children}</div>}
    </section>
  );
}

/**
 * ★ Every localStorage read and write is wrapped in a try — it throws in
 *   private browsing mode, and failing to read a preference must never take the
 *   whole page down with it. A failed read is treated as "not read yet": the
 *   cost of showing the primer one extra time is far below a blank screen.
 *
 *   localStorage 读写都包一层 try —— 隐私模式下它会抛，而「读不到偏好」绝不该
 *   把整页拖垮。读不到就当成没读过：多显示一次说明，远好过一个白屏。
 */
function readDismissed(key: string): boolean {
  try {
    return window.localStorage.getItem(`apos.whatIsThis.${key}`) === 'dismissed';
  } catch {
    return false;
  }
}

function writeDismissed(key: string, dismissed: boolean): void {
  try {
    if (dismissed) window.localStorage.setItem(`apos.whatIsThis.${key}`, 'dismissed');
    else window.localStorage.removeItem(`apos.whatIsThis.${key}`);
  } catch {
    /* Private mode refuses the write — the preference is simply not remembered */
  }
}
