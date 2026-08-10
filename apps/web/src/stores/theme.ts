import { create } from 'zustand';

export type Theme = 'dark' | 'light';

const THEME_KEY = 'apos.theme';

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

/**
 * 主题。
 *
 * ★ 深色是默认值，浅色是显式选择。
 *
 *   这块面板是拿来长时间盯着的（看板、执行图、Run 日志），
 *   深底让状态色自己发光；而且首屏那一下也不会闪白。
 *
 * ★★ 真正生效的那次赋值在 index.html 的内联脚本里，不在这里。
 *
 *   React 挂载至少要等 bundle 下载 + 解析完，在那之前 <html> 上没有
 *   data-theme，浏览器就按 CSS 里 :root 的默认值画一帧。选了浅色的人
 *   每次刷新都会先被闪一下深色 —— 这里只负责**后续切换**与写回。
 */
export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: readTheme(),

  setTheme: (theme) => {
    applyTheme(theme);
    localStorage.setItem(THEME_KEY, theme);
    set({ theme });
  },

  toggle: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
}));

/** 和 index.html 内联脚本同一套判据；两边都改才算改完 */
export function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    // 隐私模式下 localStorage 会抛 —— 主题读不到不该让整个应用起不来
    return 'dark';
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  // 移动端地址栏跟着一起变色，否则页面顶上会挂着一条不搭的白边
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'light' ? '#f5f7fb' : '#070b14');
}
