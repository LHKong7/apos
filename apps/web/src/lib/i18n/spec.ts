import { useLocaleStore } from './locale';

/**
 * 运行时配置规格的取词 / Reading localised copy off runtime specs.
 *
 * ★★ 这些文案不在词条表里，而是长在 `@apos/contracts` 的
 *   `RUNTIME_KIND_SPECS` 上 —— 因为它们是**数据**：加第七个 CLI 等于加一条
 *   profile，界面一个字都不用改。把它们搬进 en.ts / zh.ts 会把这条性质毁掉：
 *   加一个运行时就要同时改两张词条表，而漏改的表现是界面上一片空白。
 *
 *   This copy lives on the contracts specs rather than in the message
 *   catalogs because it is data: adding a CLI is adding a profile entry, with
 *   no UI change. Moving it into the catalogs would mean every new runtime
 *   also had to touch two catalog files, and a miss would render blank.
 *
 * ★ 缺英文时回落中文，不回落成空。一段中文说明总比没有说明强 ——
 *   而空白会让人以为「这一项没什么好说的」。
 *   Missing English falls back to Chinese, never to blank: a reader seeing
 *   nothing concludes there is nothing to know.
 */
export function useSpecText(): (zh: string, en?: string | null) => string {
  const locale = useLocaleStore((s) => s.locale);
  return (zh, en) => (locale === 'en' ? (en ?? zh) : zh);
}
