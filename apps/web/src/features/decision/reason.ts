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
 * ★ Policy 名字分两种：平台自带的九条基线规则有稳定 id，可以翻译；
 *   项目自己建的规则名字是用户数据，原样显示。把后者也「翻译」一遍
 *   等于给用户起的名字改名。
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
        const policyId = String(w.params?.['policyId'] ?? '');
        const authored = String(w.params?.['policy'] ?? '');
        /** ★ 基线规则按 id 认词条；认不出来就是用户自建的规则，用它自己的名字 */
        const name = (policyId.startsWith('baseline-') && tryKey(`policyName.${policyId}`)) || authored;
        return t('decision.why.policy', { policy: name });
      }
      if (w.code === 'recovery_escalated') {
        const action = String(w.params?.['action'] ?? '');
        return (
          tryKey(`decision.why.recovery.${action}`) ??
          String(w.params?.['fallback'] ?? '') ??
          fallback
        );
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
