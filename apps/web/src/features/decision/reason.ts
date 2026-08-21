import type { DecisionReason } from '@apos/contracts';
import { statusLabel } from '@/lib/format';
import { useT, type MessageKey } from '@/lib/i18n';

/**
 * 决策理由的本地化 / Localised decision rationale.
 *
 * ★★ 英文界面上这两句话此前长成「If ignored: 任务无法进入「待执行」」——
 *   英文前缀套中文正文，中间夹着中文引号。半句翻译比不翻译更糟：
 *   它读起来像功能没做完，而不是「这段是原始数据」（问题记录 #34）。
 *
 * ★ 认不出来的码一律回落到服务端那句中文，不返回空。
 *   少一句解释没人会注意到，而那句解释正是「为什么需要你」——
 *   这一页的全部意义所在。
 *
 * ★ Policy 名字一律原样显示 —— 规则全部由用户在项目里自己建，名字是
 *   用户数据。把它「翻译」一遍等于给用户起的名字改名。
 *   （平台曾经自带十条硬编码基线规则，它们的名字是平台文案、按 id 认词条；
 *   基线删掉之后这条分支跟着消失。）
 */
export function useDecisionReason(): {
  whyHuman: (reason: DecisionReason | null | undefined, fallback: string) => string;
  consequence: (reason: DecisionReason | null | undefined, fallback: string | null) => string | null;
} {
  const t = useT();

  const tryKey = (key: string, params?: Record<string, string | number>): string | null => {
    const out = t(key as MessageKey, params);
    return out === key ? null : out;
  };

  return {
    whyHuman: (reason, fallback) => {
      const w = reason?.whyHuman;
      if (!w) return fallback;

      if (w.code === 'policy_requires_human') {
        return t('decision.why.policy', { policy: String(w.params?.['policy'] ?? '') });
      }
      if (w.code === 'recovery_escalated') {
        /**
         * ★ 三档回落：本地化的说法 → 服务端带过来的那句 → 存量数据里的整句。
         *   `||` 而不是 `??` —— 中间那一档取不到时是**空串**不是 null，
         *   而空串必须继续往下落，否则界面上会出现一句空的解释。
         */
        const action = String(w.params?.['action'] ?? '');
        const carried = String(w.params?.['fallback'] ?? '');
        return tryKey(`decision.why.recovery.${action}`) || carried || fallback;
      }
      return tryKey(`decision.why.${w.code}`, w.params) ?? fallback;
    },

    consequence: (reason, fallback) => {
      const c = reason?.consequence;
      if (!c) return fallback;
      const params = { ...(c.params ?? {}) };
      /** ★ 状态在参数里是枚举值，显示要用界面上那个词 —— 两个名字对不上等于没说 */
      if (typeof params['status'] === 'string') params['status'] = statusLabel(params['status']);
      return tryKey(`decision.consequence.${c.code}`, params) ?? fallback;
    },
  };
}
