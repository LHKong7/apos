import { useEffect } from 'react';
import { t } from './i18n';

/**
 * 「改了还没存」的保护 / Unsaved-changes guard.
 *
 * ★★ 用户在弹窗里改了半天，走神点了外面（或者关了标签页），改动就没了 ——
 *   而且没有任何提示，他甚至不会立刻发现（问题记录 #26）。
 *
 * ★ 两道防线，缺一不可：
 *   1. `beforeunload`：挡住刷新与关标签页。浏览器只允许一句它自己的话，
 *      文案由浏览器决定，我们只能声明「有未保存内容」。
 *   2. `confirmClose()`：挡住关弹窗。这一道才是常见的那条路 ——
 *      弹窗关掉不触发 beforeunload，只有它能拦。
 *
 * ★ **没改过就不要拦**。一个每次关闭都要确认一遍的弹窗，用户三次之后
 *   就会条件反射地点确认 —— 而那正好训练掉了这道防线本身的作用。
 *   所以 `dirty` 必须是真的「和初始值不一样」，不能是「碰过这个表单」。
 *
 * Two lines of defense: beforeunload for tab close/reload, and confirmClose
 * for dismissing a dialog (which never fires beforeunload). Guarding when
 * nothing changed trains the user to dismiss the guard.
 */
export function useUnsavedGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      /**
       * ★ 现代浏览器忽略这里的字符串，只用它作为「要拦」的信号。
       *   仍然赋值是因为老版本读它 —— 而且空着会被某些实现当成「不拦」。
       */
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
}

/**
 * 关闭前确认。
 *
 * ★ 用原生 `confirm` 而不是自建对话框：它是模态的、键盘可达的、
 *   而且在弹窗之上再叠一层自制弹窗会带来一堆焦点陷阱的边角问题。
 *   这一处的要求是「拦住」，不是「好看」。
 */
export function confirmClose(dirty: boolean): boolean {
  if (!dirty) return true;
  return window.confirm(t('common.unsavedConfirm'));
}
