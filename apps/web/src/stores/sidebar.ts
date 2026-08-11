import { create } from 'zustand';

const KEY = 'apos.sidebar.collapsed';

interface SidebarState {
  /**
   * 用户**显式**表过的态。null = 没表过，跟着页面走。
   *
   * ★★ 三态而不是布尔，是因为「看板页自动收窄」和「用户自己点过折叠」
   *   是两回事，用一个布尔存会互相打架：
   *   进看板自动折叠 → 写回 true → 离开看板还是折叠的，
   *   用户没做过任何选择却得到了一个粘住的偏好。
   */
  manual: boolean | null;
  setManual: (collapsed: boolean) => void;
}

export const useSidebarStore = create<SidebarState>((set) => ({
  manual: read(),
  setManual: (collapsed) => {
    try {
      localStorage.setItem(KEY, collapsed ? '1' : '0');
    } catch {
      // 隐私模式下写不进去 —— 记不住偏好可以接受，抛出去让页面白屏不行
    }
    set({ manual: collapsed });
  },
}));

function read(): boolean | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === null ? null : v === '1';
  } catch {
    return null;
  }
}

/**
 * 侧栏此刻是不是收窄的。
 *
 * ★ 看板默认收成图标栏，是被一个硬数字逼出来的：六列不横滚要 1332px
 *   （6 × 13rem + 5 × 12px gap + 24px padding）。1440 的屏幕上，
 *   56px 的图标栏还剩 52px 余量，224px 的展开态则直接把看板挤到横滚。
 *
 * ★ 用户点过折叠开关之后，他的选择压过这条规则 —— 包括「我就要在看板上
 *   展开」。那会让看板横滚，但横滚本来就是支持的状态（board-scroll），
 *   而「导航在我最常待的那页展不开」不是。
 */
export function sidebarCollapsed(manual: boolean | null, pathname: string): boolean {
  return manual ?? /\/projects\/[^/]+\/board$/.test(pathname);
}
