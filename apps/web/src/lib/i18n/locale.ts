import { create } from 'zustand';

export type Locale = 'en' | 'zh';

const LOCALE_KEY = 'apos.locale';

/**
 * 界面语言 / UI language.
 *
 * ★★ 默认英文，中文是显式选择 —— 与主题相反的取舍。
 *
 *   主题那边深色是默认，因为它关乎长时间盯屏的舒适度；语言这边默认英文，
 *   因为不认识中文的人**看不出切换器写着什么**。反过来默认中文的话，
 *   一个英文用户打开界面看到的是一屏方块字，而那个能救他的下拉框
 *   也是方块字 —— 死锁。默认英文时，中文用户至少认得 "中文" 这两个字。
 *
 * ★ 不做浏览器语言嗅探。navigator.language 在国内环境下经常是 zh-CN
 *   而使用者其实要英文界面（截图、报 bug、给外部同事看），
 *   嗅探的结果是「我明明选了英文，换台机器又变回中文」。
 *   显式选择 + 记住，比猜得准。
 */
interface LocaleState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  toggle: () => void;
}

export const useLocaleStore = create<LocaleState>((set, get) => ({
  locale: readLocale(),

  setLocale: (locale) => {
    applyLocale(locale);
    try {
      localStorage.setItem(LOCALE_KEY, locale);
    } catch {
      // 隐私模式下 localStorage 会抛 —— 存不下不该让切换本身失败
    }
    set({ locale });
  },

  toggle: () => get().setLocale(get().locale === 'en' ? 'zh' : 'en'),
}));

/** 和 index.html 内联脚本同一套判据；两边都改才算改完（同 readTheme） */
export function readLocale(): Locale {
  try {
    return localStorage.getItem(LOCALE_KEY) === 'zh' ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

function applyLocale(locale: Locale) {
  /**
   * ★ <html lang> 必须跟着走。它不是装饰：
   *   - 屏幕阅读器按它选发音，中文内容标成 lang="en" 会被逐字母念
   *   - 浏览器的「翻译此页」按它判断要不要弹出来
   *   - CJK 与拉丁字形的断行规则不同，字体回退也看它
   */
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
}
