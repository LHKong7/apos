/**
 * token 数的可读写法，供 domain 里生成的说明性文本使用。
 *
 * ★ 为什么要缩写：这些串出现在结论句和拦截理由里
 *   （「今日 token 额度已用尽（1.2M/1.5M）」）。完整的 1,203,884/1,500,000
 *   会把一行理由撑成两行，而多出来的那几位对「用尽了」这个判断没有影响。
 *
 * ★ 为什么不在这里做本地化：这是 domain，拿不到 locale。
 *   前端有自己那份带 i18n 的实现（apps/web/src/lib/format），
 *   这一份只服务于服务端生成的文本 —— 那些文本目前整体仍是中文，
 *   属于仓库已知的缺口，不是这个函数单独的问题。
 *
 * A readable rendering of a token count, for explanatory text generated
 * inside the domain layer. Abbreviated because these strings appear inline
 * in one-line reasons where the extra digits change nothing about the
 * judgment being explained. Localization lives in the web formatter: the
 * domain layer has no locale.
 */
export function formatTokens(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${trim(v / 1e9)}B`;
  if (abs >= 1e6) return `${trim(v / 1e6)}M`;
  if (abs >= 1e3) return `${trim(v / 1e3)}k`;
  return String(Math.round(v));
}

/** 小于 10 时保留一位小数（1.2M 比 1M 有信息），否则取整 */
function trim(v: number): string {
  return v.toFixed(Math.abs(v) < 10 ? 1 : 0).replace(/\.0$/, '');
}
