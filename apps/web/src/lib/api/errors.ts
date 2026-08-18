import { ApiError } from './client';
import { t } from '../i18n';
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
    case 'CONFLICT':
      return t('error.conflict');
    default:
      return error.message || fallback;
  }
}
