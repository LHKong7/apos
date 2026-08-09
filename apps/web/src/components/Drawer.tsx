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
      <button
        type="button"
        aria-label="关闭"
        onClick={onClose}
        className="flex-1 cursor-default bg-slate-900/20"
      />
      <aside className={`${width} flex flex-col border-l border-slate-200 bg-white shadow-xl`}>
        <header className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-2">
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            ✕
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </aside>
    </div>
  );
}
