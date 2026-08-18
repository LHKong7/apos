import { beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { DecisionReason } from '@apos/contracts';
import { useDecisionReason } from './reason';
import { useLocaleStore } from '../../lib/i18n';

/**
 * 决策理由的本地化。
 *
 * ★★ 英文界面上这两句话此前长成「If ignored: 任务无法进入「待执行」」——
 *   英文前缀套中文正文，中间夹着中文引号。半句翻译比不翻译更糟：
 *   它读起来像功能没做完，而不是「这段是原始数据」（问题记录 #34）。
 */

const reason = (over: Partial<DecisionReason> = {}): DecisionReason => ({
  whyHuman: { code: 'policy_requires_human', params: { policy: '生产环境发布需发布负责人审批', policyId: 'baseline-prod-deploy' } },
  consequence: { code: 'stalled_with_downstream', params: { status: 'ready', count: 3 } },
  ...over,
});

beforeEach(() => useLocaleStore.setState({ locale: 'en' }));

const hook = () => renderHook(() => useDecisionReason()).result.current;

describe('决策理由', () => {
  it('★ 英文界面上给出整句英文，不是英文前缀套中文正文', () => {
    const { whyHuman, consequence } = hook();
    const why = whyHuman(reason(), 'FALLBACK');
    const what = consequence(reason(), 'FALLBACK');

    expect(why).toContain('Production releases need');
    expect(why).not.toMatch(/[一-龥]/);
    expect(what).toContain('3 downstream tasks');
    expect(what).not.toMatch(/[一-龥]/);
  });

  /**
   * ★★ 平台自带的九条基线规则名字是平台文案，可以翻译；项目自建规则的
   *   名字是用户数据，原样显示 —— 把用户起的名「翻译」一遍等于给它改名。
   */
  it('★ 用户自建的 Policy 名原样显示，不翻译', () => {
    const { whyHuman } = hook();
    const out = whyHuman(
      reason({
        whyHuman: {
          code: 'policy_requires_human',
          params: { policy: '我们组的发版规矩', policyId: 'b3e1c2d4-0000-4000-8000-000000000000' },
        },
      }),
      'FALLBACK',
    );
    expect(out).toContain('我们组的发版规矩');
  });

  /** ★ 状态在参数里是枚举值，显示要用界面上那个词 —— 两个名字对不上等于没说 */
  it('★ 后果里的状态用界面上的标签，不印枚举值', () => {
    const { consequence } = hook();
    const out = consequence(reason(), 'FALLBACK');
    expect(out).toContain('Ready');
    expect(out).not.toContain('"ready"');
  });

  /**
   * ★ 认不出来的码回落到服务端那句话，不返回空。
   *   少一句解释没人会注意到，而那句解释正是「为什么需要你」——
   *   这一页的全部意义所在。
   */
  it('★ 没有结构化理由时回落到服务端那句话', () => {
    const { whyHuman, consequence } = hook();
    expect(whyHuman(null, '服务端原话')).toBe('服务端原话');
    expect(consequence(null, '服务端原话')).toBe('服务端原话');
    expect(consequence(reason({ consequence: null }), null)).toBeNull();
  });

  it('中文界面照常给中文', () => {
    useLocaleStore.setState({ locale: 'zh' });
    const { whyHuman } = hook();
    expect(whyHuman(reason(), 'FALLBACK')).toContain('生产环境发布需发布负责人审批');
  });

  /** ★ 恢复策略按动作挑说法，认不出来时用服务端带过来的那一句 */
  it('★ 恢复升级：认识的动作给本地化说法，不认识的用带过来的原话', () => {
    const { whyHuman } = hook();
    expect(
      whyHuman(reason({ whyHuman: { code: 'recovery_escalated', params: { action: 'terminate', fallback: '原话' } } }), 'F'),
    ).toContain('Terminating means');
    expect(
      whyHuman(reason({ whyHuman: { code: 'recovery_escalated', params: { action: 'brand_new', fallback: '原话' } } }), 'F'),
    ).toBe('原话');
  });
});
