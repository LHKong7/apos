import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 跟随底部。
 *
 * ★ 「不自动滚动」这条要求在看板、Run 事件流、决策列表里反复出现，
 *   本质是同一条：系统的更新不能抢走用户的注意力控制权。
 *   用户正读着上面的内容被拽到底部，比错过一条新事件糟糕得多。
 *
 * 规则：贴底时自动跟随；一旦用户往上滚就停止跟随并计数未读；
 * 滚回底部自动恢复跟随。
 */
export function useFollowTail<T extends HTMLElement>(itemCount: number) {
  const ref = useRef<T | null>(null);
  const [pinned, setPinned] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const lastCount = useRef(itemCount);

  const isAtBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return true;
    // 留 24px 容差：滚动条差几个像素不到底也应算「贴底」
    return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setPinned(true);
    setUnseen(0);
  }, []);

  const onScroll = useCallback(() => {
    const bottom = isAtBottom();
    setPinned(bottom);
    if (bottom) setUnseen(0);
  }, [isAtBottom]);

  useEffect(() => {
    const added = itemCount - lastCount.current;
    lastCount.current = itemCount;
    if (added <= 0) return;

    if (pinned) {
      const el = ref.current;
      if (el) el.scrollTop = el.scrollHeight;
    } else {
      setUnseen((n) => n + added);
    }
  }, [itemCount, pinned]);

  return { ref, pinned, unseen, scrollToBottom, onScroll };
}
