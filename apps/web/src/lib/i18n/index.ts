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
/**
 * 按 `count` 选单复数变体 / Pick the plural variant for `count`.
 *
 * ★★ 为什么需要它：英文里 `{count} tasks are marked` 在 count=1 时是错的，
 *   而中文「{count} 个任务」不分单复数 —— 于是「把 count 插进一句写死复数的话」
 *   在中文界面上永远看起来是对的，英文界面上永远是错的。实测有四处
 *   （`1 points`、`1 tasks`、`1 places`、`1 of them are`）。
 *
 * ★ 约定：需要区分的词条额外提供 `<key>_one` / `<key>_other` 两条。
 *   两条都在 en.ts 里声明，因此漏写是**编译错误**而不是运行时的错句子。
 *   不提供变体的词条照旧走原键 —— 绝大多数文案不需要这个。
 *
 * ★ 只在当前语言真的有变体时才切换 —— 没有变体的词条落回原键。
 *   中文两条变体写成同一句话（中文本来就不分单复数），这不是冗余：
 *   zh.ts 的类型钉死在 en.ts 的键上，少写一条是编译错误，而那正是
 *   我们要的 —— 加英文变体时不会忘了中文侧。
 */
function pluralKey(locale: Locale, key: MessageKey, params?: Params): MessageKey {
  const count = params?.['count'];
  if (typeof count !== 'number') return key;
  const variant = `${key}_${count === 1 ? 'one' : 'other'}` as MessageKey;
  return CATALOGS[locale][variant] !== undefined ? variant : key;
}

/**
 * 这个键存在吗 / Does this catalogue entry exist?
 *
 * ★★ 专给「服务端原因码 → 词条」这类拼出来的键用。
 *   translate 认不出键时返回**键本身**，于是界面上会出现
 *   `plan.fallback.some_new_code` 这样一串裸 key —— 服务端加一个新码、
 *   前端还没跟上的那段时间里，用户看到的是一行代码标识符。
 *   先问一句「有没有」，没有就回落到兜底句。
 *
 * Server reason codes are turned into keys by string concatenation, so the
 * catalogue can legitimately lag behind. Ask first, fall back to prose.
 */
export function hasMessage(key: string): key is MessageKey {
  return CATALOGS.en[key as MessageKey] !== undefined;
}

export function translate(locale: Locale, key: MessageKey, params?: Params): string {
  const resolved = pluralKey(locale, key, params);
  const template = CATALOGS[locale][resolved] ?? CATALOGS.en[resolved];

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
