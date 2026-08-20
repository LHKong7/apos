import { describe, expect, it } from 'vitest';
import { ErrorReason, NotFoundEntity } from '@apos/contracts';
import { ApiError } from './client';
import { apiErrorMessage, REASONS_WITHOUT_CATALOG } from './errors';
import { en } from '../i18n/en';
import { zh } from '../i18n/zh';
import { useLocaleStore } from '../i18n';

/**
 * 服务端报错的翻译 / Translating server-reported errors.
 *
 * ★★ 这组测试守的是一件事：**英文界面上不出现中文**。
 *
 *   服务端的 `message` 永远是中文（日志与告警要一句现成的话），
 *   界面要显示的那句由 `reason` 决定。两者脱钩之后，唯一会悄悄
 *   退化的地方就是「加了新码但忘了加词条」—— 那时英文用户看到的
 *   仍然是那句中文，而没有任何测试会红。这里让它红。
 */

const zhProse = '这是服务端那句中文';

function err(reason?: string, params?: Record<string, string | number>) {
  return new ApiError('VALIDATION_FAILED', zhProse, null, 400, reason, params);
}

describe('原因码词条的完整性 / catalog coverage', () => {
  /**
   * ★★ 每个码都要有词条，除非它明确写在「故意不翻」的名单里。
   *
   *   没有这条断言，加一个码而不加词条的代价是零 —— 中文界面照常，
   *   英文界面上多出一句中文，而两种情况在测试里长得一模一样。
   */
  it('★ 每个 ErrorReason 都有词条，或在故意不翻的名单里', () => {
    const uncovered = ErrorReason.options.filter(
      (code) =>
        code !== 'not_found' &&
        !REASONS_WITHOUT_CATALOG.has(code) &&
        en[`error.reason.${code}` as keyof typeof en] === undefined,
    );
    expect(uncovered).toEqual([]);
  });

  /** ★ 反过来也要查：词条表里不该有指向已删除原因码的死条目 */
  it('★ 没有对应不上任何原因码的死词条', () => {
    const codes = new Set<string>(ErrorReason.options);
    const orphans = Object.keys(en)
      .filter((k) => k.startsWith('error.reason.'))
      .map((k) => k.slice('error.reason.'.length))
      .filter((code) => !codes.has(code));
    expect(orphans).toEqual([]);
  });

  /**
   * ★★ 「找不到」是一码多句：实体名是键的一部分，不是插进句子的参数。
   *   少一个实体的词条，界面上就会回落到服务端那句
   *   `${中文实体名}不存在` —— 正是这次要消灭的东西。
   */
  it('★ 每种实体都有自己的「找不到」整句', () => {
    const missing = NotFoundEntity.options.filter(
      (e) => en[`error.notFound.${e}` as keyof typeof en] === undefined,
    );
    expect(missing).toEqual([]);
  });

  /** ★ 中英两侧都要有 —— zh 的类型钉死在 en 上，但这里连值一起查 */
  it('两种语言的报错词条都不为空', () => {
    const blank = Object.keys(en)
      .filter((k) => k.startsWith('error.'))
      .filter((k) => {
        const key = k as keyof typeof en;
        return en[key].trim() === '' || zh[key].trim() === '';
      });
    expect(blank).toEqual([]);
  });
});

describe('apiErrorMessage', () => {
  it('按原因码取词，两种语言各自成句', () => {
    useLocaleStore.setState({ locale: 'en' });
    expect(apiErrorMessage(err('storage.type_immutable'), 'x')).toBe(
      en['error.reason.storage.type_immutable'],
    );
    useLocaleStore.setState({ locale: 'zh' });
    expect(apiErrorMessage(err('storage.type_immutable'), 'x')).toBe(
      zh['error.reason.storage.type_immutable'],
    );
  });

  it('插值走参数，用户写的名字原样带过去', () => {
    useLocaleStore.setState({ locale: 'en' });
    const message = apiErrorMessage(err('agent.not_project_member', { name: '张三的助手' }), 'x');
    expect(message).toContain('张三的助手');
    expect(message).toContain('not a member of this project');
  });

  /**
   * ★★ 认不出的码要回落到服务端那句话，而不是空白，也不是裸 key。
   *
   *   服务端加了新码、前端还没跟上，这段窗口是必然存在的。
   *   那时用户要看到的是一句能读的话 —— 哪怕语言不对 ——
   *   而不是一行 `error.reason.some_new_code`。
   */
  it('★ 认不出的码回落到服务端原句，不是空白也不是裸 key', () => {
    useLocaleStore.setState({ locale: 'en' });
    expect(apiErrorMessage(err('a.code.from.the.future'), 'fallback')).toBe(zhProse);
  });

  /** ★ 完全没带码的（老服务端）也一样回落 */
  it('没有原因码时回落到服务端原句', () => {
    expect(apiErrorMessage(err(undefined), 'fallback')).toBe(zhProse);
  });

  /**
   * ★★ 故意不翻的那几条，必须落到服务端那句**具体**的话上。
   *
   *   哪几条前置条件没过，比「有条件没满足」有用得多。
   *   这条测试盯着的是：别有人「顺手」给它们补上词条 ——
   *   补上的那一刻，界面就从「具体的中文」退化成「通用的英文」。
   */
  it('★ 名单里的码落到服务端具体那句，不被通用译文盖掉', () => {
    useLocaleStore.setState({ locale: 'en' });
    for (const code of REASONS_WITHOUT_CATALOG) {
      expect(apiErrorMessage(err(code), 'fallback')).toBe(zhProse);
    }
  });

  it('「找不到」按实体取整句，不是拼出来的', () => {
    useLocaleStore.setState({ locale: 'en' });
    expect(apiErrorMessage(err('not_found', { entity: 'project' }), 'x')).toBe(
      en['error.notFound.project'],
    );
    useLocaleStore.setState({ locale: 'zh' });
    expect(apiErrorMessage(err('not_found', { entity: 'artifact' }), 'x')).toBe(
      zh['error.notFound.artifact'],
    );
  });

  /** ★ 认不出的实体也回落 —— 服务端加了新实体而前端还没跟上 */
  it('认不出的实体回落到服务端原句', () => {
    expect(apiErrorMessage(err('not_found', { entity: 'spaceship' }), 'x')).toBe(zhProse);
  });

  /**
   * ★★ VERSION_CONFLICT 才是服务端发的码，不是 CONFLICT。
   *
   *   这里原来写的是 `case 'CONFLICT'` —— 一个谁都不会发的码，
   *   于是版本冲突一路落到 default，把服务端那句中文原样显示出来。
   *   `ApiError.code` 在前端是 string，tsc 抓不到这种笔误，只有测试能。
   */
  it('★ 版本冲突走 VERSION_CONFLICT 而不是不存在的 CONFLICT', () => {
    useLocaleStore.setState({ locale: 'en' });
    const conflict = new ApiError('VERSION_CONFLICT', zhProse, null, 409);
    expect(apiErrorMessage(conflict, 'x')).toBe(en['error.conflict']);
  });

  it('不是 ApiError 的东西走调用方给的兜底', () => {
    expect(apiErrorMessage(new Error('boom'), 'fallback')).toBe('fallback');
  });
});
