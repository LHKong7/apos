import { useEffect } from 'react';

/**
 * 侧栏抽屉。
 *
 * 详情用抽屉而不是跳页，是因为看板是「巡检」场景：
 * 处理一张卡片之后要立刻回到全局视野。跳走再跳回会丢掉滚动位置与筛选，
 * 一次巡检就变成了反复找回上下文。
 */
export function Drawer({
  title,
  onClose,
  children,
  width = 'w-[min(28rem,100vw)]',
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-label={title}>
      {/*
        ★ 遮罩用专门的 scrim 令牌，不是 slate-900/20。
          深色主题下 slate-900 是**近白**（色阶整体反转，见 index.css），
          照搬过来会在内容上蒙一层雾，而不是压暗它。
        ★ 背后再糊一点：抽屉是「暂时盖住看板」，不是「切走看板」，
          模糊比压黑更能保住那种「原地展开」的感觉。
      */}
      <button
        type="button"
        aria-label="关闭"
        onClick={onClose}
        className="flex-1 cursor-default bg-scrim/[var(--scrim-alpha)] backdrop-blur-[2px] animate-fade-in"
      />
      <aside
        className={`${width} flex animate-slide-in-right flex-col border-l border-slate-200 bg-white shadow-xl`}
      >
        <header className="relative flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-2.5">
          <div aria-hidden className="hairline-brand absolute inset-x-0 top-0 h-px opacity-70" />
          <h2 className="text-sm font-semibold tracking-tight text-slate-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="-mr-1 flex h-6 w-6 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            ✕
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </aside>
    </div>
  );
}
