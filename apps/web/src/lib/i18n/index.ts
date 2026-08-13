import { en, type MessageKey } from './en';
import { zh } from './zh';
import { useLocaleStore, type Locale } from './locale';

export { useLocaleStore, readLocale, type Locale } from './locale';
export type { MessageKey } from './en';
export { useSpecText } from './spec';

const CATALOGS: Record<Locale, Record<MessageKey, string>> = { en, zh };

export type Params = Record<string, string | number>;

/**
 * 取一条词条并做插值 / Look up a message and interpolate.
 *
 * ★★ 键不存在时返回**键本身**，并在开发模式下 warn。
 *
 *   返回空串是最坏的选择：界面上少一句话，没人会注意到，而它可能正是
 *   那句解释「为什么这个按钮是灰的」的提示。返回键名很丑，但丑得看得见 ——
 *   这个仓库反复吃的亏就是「配置没生效而现场毫无迹象」。
 *
 *   Missing keys render as the key itself, loudly. An empty string would
 *   silently drop the one sentence that explained why a button is disabled.
 *
 * ★ 插值不做转义：React 渲染文本节点时自己会转义，这里再转一遍会把
 *   用户填的 `<` 变成 `&lt;` 显示出来。
 */
export function translate(locale: Locale, key: MessageKey, params?: Params): string {
  const template = CATALOGS[locale][key] ?? CATALOGS.en[key];

  if (template === undefined) {
    if (import.meta.env.DEV) {
      console.warn(`[i18n] 缺少词条 / missing message: ${key}`);
    }
    return key;
  }

  if (!params) return template;

  /**
   * ★ 占位符没有对应参数时保留原样 `{name}` 而不是替换成空。
   *   空白等于把「这里本该有个数字」变成一句读不通的话，
   *   而 `{count}` 明摆着是个 bug。
   */
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

/**
 * 组件里用这个 / The hook components should use.
 *
 * ★ 订阅 locale，所以切换语言时用到它的组件会重渲染。
 *   直接 import 一个模块级 `t` 拿不到这个效果 —— 切了语言界面纹丝不动。
 */
export function useT(): (key: MessageKey, params?: Params) => string {
  const locale = useLocaleStore((s) => s.locale);
  return (key, params) => translate(locale, key, params);
}

/** 当前语言，非组件上下文里用（事件处理器、store）。 */
export function currentLocale(): Locale {
  return useLocaleStore.getState().locale;
}

/** 非组件上下文里的取词 / Non-reactive lookup for stores and handlers. */
export function t(key: MessageKey, params?: Params): string {
  return translate(currentLocale(), key, params);
}
