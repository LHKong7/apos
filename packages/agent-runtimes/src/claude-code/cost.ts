export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * 单价表（美元 / 百万 token）。
 *
 * ⚠ 这张表只用于**执行过程中**的实时估算 —— 它会随官方定价漂移。
 *   Run 结束时 SDK 会给出权威的 total_cost_usd，适配器用一条差额事件
 *   把累计值校正为权威值（见 translate.ts 的 reconcile）。
 *   因此表过期只会让进度中的成本条不准，不会让最终账目出错。
 */
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-fable-5': { input: 10, output: 50 },
};

/** 缓存命中约为输入价的 0.1 倍，缓存写入约 1.25 倍 */
const CACHE_READ_RATIO = 0.1;
const CACHE_WRITE_RATIO = 1.25;

export function estimateCostUsd(model: string | null, tokens: TokenCounts): number {
  const price = lookupPrice(model);
  if (!price) return 0;

  const perToken = (rate: number) => rate / 1_000_000;
  return (
    tokens.input * perToken(price.input) +
    tokens.output * perToken(price.output) +
    tokens.cacheRead * perToken(price.input * CACHE_READ_RATIO) +
    tokens.cacheWrite * perToken(price.input * CACHE_WRITE_RATIO)
  );
}

/** 带日期后缀的模型 ID（claude-opus-5-20260101）按前缀匹配 */
function lookupPrice(model: string | null) {
  if (!model) return null;
  if (PRICE_PER_MTOK[model]) return PRICE_PER_MTOK[model];
  for (const [key, price] of Object.entries(PRICE_PER_MTOK)) {
    if (model.startsWith(key)) return price;
  }
  return null;
}

/** 是否知道该模型的价格 —— 不知道时实时成本只能显示 0，需要在事件里说明 */
export function hasPricing(model: string | null): boolean {
  return lookupPrice(model) !== null;
}
