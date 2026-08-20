import { ApiError } from './client';
import { hasMessage, t, type MessageKey } from '../i18n';
import { statusLabel } from '../format';

/**
 * 把错误信封翻译成一句用户能据以行动的话。
 *
 * ★★ 服务端的错误码是稳定的，它的**消息**不是。
 *
 *   接管一张卡片失败时，服务端答的是 409 + INVALID_TRANSITION +
 *   「当前状态 ready 不支持该操作」，而界面上那张卡片写着「已阻塞」——
 *   同一件事的两个名字，用户没有任何办法把它们对上，看到的就是
 *   系统在自相矛盾（问题记录 #16 / #27）。
 *
 *   这里按 code 重写，并且**说清下一步**：状态冲突几乎总是因为界面上
 *   这张卡已经过期了（别人刚动过、或调度器刚推进了它），所以那句话
 *   应该是「刷新一下再看」，而不是复述一个内部状态名。
 *
 * Codes are stable, server messages are not. A 409 on takeover almost always
 * means the card on screen is stale, so say that instead of naming an internal
 * status the UI never showed.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;

  /**
   * ★★ 原因码优先于一切按 HTTP 码的改写。
   *
   *   服务端给的 `reason` 是它对「这是哪一类错」的判断，比这里按
   *   `VALIDATION_FAILED` 这种粗粒度码猜出来的准得多 —— 400 底下藏着
   *   几十种完全不同的错。认得出码就按码取词，那才是唯一能同时
   *   服务中英文两套界面的形态。
   *
   * ★ 认不出就往下走，最终回落到服务端那句中文 —— 而不是空白。
   *   服务端加了新码、前端还没跟上的那段时间里，用户要看到的是
   *   一句能读的话，哪怕语言不对。
   */
  const byReason = reasonMessage(error);
  if (byReason) return byReason;

  switch (error.code) {
    case 'INVALID_TRANSITION': {
      const from = (error.details as { from?: string } | null)?.from;
      return from
        ? t('error.invalidTransition', { status: statusLabel(from) })
        : t('error.invalidTransitionUnknown');
    }
    case 'GUARD_FAILED':
      /** ★ Guard 的失败原因本来就是写给人看的，原样带出来比任何改写都准 */
      return error.message;
    case 'FORBIDDEN':
      return t('error.forbidden');
    /**
     * ★★ 服务端发的是 `VERSION_CONFLICT`，不是 `CONFLICT`。
     *
     *   这里原来写的是 `case 'CONFLICT'` —— 一个服务端从来不发的码，
     *   于是版本冲突一路落到 default，把服务端那句中文原样显示出来。
     *   `ApiError.code` 在前端是 `string` 而不是那个联合类型，
     *   所以 tsc 抓不到这种笔误；rbac.test.ts 那种全景对照表也管不着前端。
     */
    case 'VERSION_CONFLICT':
      return t('error.conflict');
    default:
      return error.message || fallback;
  }
}

/**
 * 这几条码**故意**没有词条 / Deliberately left without a catalog entry.
 *
 * ★★ 服务端在这几处送来的句子比任何通用译文都具体。
 *
 *   `guard.failed` 带的是「哪几条前置条件没过」的逐条说明，
 *   `policy.denied` 带的是那条规则自己的说法 —— 换成一句
 *   「有一条规则拦下了这个操作」，用户就不知道是哪一条、也不知道下一步做什么。
 *   信息量比语言更重要：一句具体的中文，好过一句正确但没用的英文。
 *
 * ★ 这份名单存在的意义是把「故意没翻」和「忘了翻」分开。
 *   i18n 的测试断言每个码都有词条，**除非**它在这儿并写明了理由 ——
 *   没有这份名单的话，两者在测试里长得一模一样。
 *   要真正修好它们，得让 domain 层那些理由各自带码（见 CLAUDE.md 的剩余缺口）。
 */
export const REASONS_WITHOUT_CATALOG = new Set(['guard.failed', 'policy.denied']);

/**
 * 原因码 → 词条。
 *
 * ★ 「找不到」单独一支：它的实体名是键的一部分（`error.notFound.project`），
 *   而不是插进一句话的参数。中文里名词在前、英文里 "not found" 在后，
 *   拼出来的句子只在写它的那种语言里成立。
 */
function reasonMessage(error: ApiError): string | null {
  if (!error.reason) return null;

  if (error.reason === 'not_found') {
    const entity = error.params?.['entity'];
    const key = `error.notFound.${String(entity)}` as MessageKey;
    return hasMessage(key) ? t(key) : null;
  }

  const key = `error.reason.${error.reason}` as MessageKey;
  return hasMessage(key) ? t(key, error.params ?? {}) : null;
}
