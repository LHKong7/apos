import { useT } from '../../lib/i18n';
import { useEffect, useState } from 'react';
import { useBoardStore } from '../../stores/board';

/**
 * 「N 张卡片已移动」提示条（页面文档 05 §5.5、§7）。
 *
 * ★ 不自动滚动视口去追移动的卡片。
 *   用户正在看某一列时被拽走视线，比错过一次移动糟糕得多 ——
 *   这条要求在看板、Run 事件流、决策列表里反复出现，本质是同一条：
 *   系统的更新不能抢走用户的注意力控制权。
 */
export function MovedToast() {
  const t = useT();
  const unseen = useBoardStore((s) => s.unseenMoves);
  const acknowledge = useBoardStore((s) => s.acknowledgeMoves);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (unseen.length === 0) {
      setVisible(false);
      return;
    }
    setVisible(true);
    // 汇总提示自己淡出，不需要用户点掉
    const timer = setTimeout(() => {
      setVisible(false);
      acknowledge();
    }, 4000);
    return () => clearTimeout(timer);
  }, [unseen.length, acknowledge]);

  if (!visible || unseen.length === 0) return null;

  const last = unseen[unseen.length - 1]!;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-40 animate-fade-in-up rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-800 shadow-lg glass-strong">
      {unseen.length === 1
        ? t('toast.oneMoved', { to: last.to })
        : t('toast.manyMoved', { count: unseen.length })}
    </div>
  );
}
