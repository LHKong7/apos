import { beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from './en';
import { zh } from './zh';
import { translate, t, useLocaleStore } from './index';
import { readLocale } from './locale';

beforeEach(() => {
  localStorage.clear();
  useLocaleStore.setState({ locale: 'en' });
});

describe('词条表 / catalogs', () => {
  /**
   * ★★ 这条是这套 i18n 的地基：两张表的键必须完全一致。
   *
   *   类型系统已经挡住了「zh 少了一个键」，但挡不住「zh 多出一个 en
   *   没有的键」—— 那种键永远不会被渲染，是纯粹的死重，而且会让人
   *   误以为某句话已经翻过了。
   *
   *   TypeScript catches keys missing from zh; it does not catch keys that
   *   exist only in zh. Those never render and read as "already translated".
   */
  it('★ 两张表的键一一对应，没有一边多出来的', () => {
    const enKeys = Object.keys(en).sort();
    const zhKeys = Object.keys(zh).sort();
    expect(zhKeys).toEqual(enKeys);
  });

  /** ★ 空词条等于界面上少一句话，而少的那句往往正是解释性的那句 */
  it('没有空词条', () => {
    const blank = Object.entries({ ...en, ...zh })
      .filter(([, v]) => v.trim() === '')
      .map(([k]) => k);
    expect(blank).toEqual([]);
  });

  /**
   * ★★ 同一个键在两种语言里的占位符必须一致。
   *
   *   en 写 `{count}` 而 zh 写成 `{n}` 的话，中文界面上会**原样显示
   *   `{n}`** —— 因为调用方传的是 count。这种错在 code review 里
   *   极难看出来，但在界面上是一句读不通的话。
   */
  it('★ 占位符在两种语言里一致', () => {
    const holes = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort();
    const mismatched = Object.keys(en).filter((k) => {
      const key = k as keyof typeof en;
      return holes(en[key]).join() !== holes(zh[key]).join();
    });
    expect(mismatched).toEqual([]);
  });
});

describe('translate', () => {
  it('按语言取词', () => {
    expect(translate('en', 'common.cancel')).toBe('Cancel');
    expect(translate('zh', 'common.cancel')).toBe('取消');
  });

  it('插值', () => {
    expect(translate('en', 'requirement.list.heading', { count: 3 })).toBe('Requirements (3)');
    expect(translate('zh', 'requirement.list.heading', { count: 3 })).toBe('已有需求（3）');
  });

  /**
   * ★ 少传参数时保留 `{count}` 而不是替换成空白。
   *   空白让句子读起来只是别扭，`{count}` 明摆着是个 bug ——
   *   而这正是我们希望它被当成的东西。
   */
  it('★ 缺参数时保留占位符，不静默变成空白', () => {
    expect(translate('en', 'requirement.list.heading')).toBe('Requirements ({count})');
  });

  /** ★ 缺键返回键名并 warn —— 返回空串的话，界面上少一句话没人会发现 */
  it('★ 缺键时返回键名而不是空串', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // @ts-expect-error 故意传一个不存在的键：运行时行为才是这条测试的对象
    expect(translate('en', 'no.such.key')).toBe('no.such.key');
    warn.mockRestore();
  });
});

describe('语言选择 / locale', () => {
  /**
   * ★★ 默认英文。看不懂中文的人也看不懂那个写着「切换语言」的按钮 ——
   *   默认中文等于把英文用户锁在外面。
   */
  it('★ 默认英文', () => {
    expect(readLocale()).toBe('en');
  });

  it('只认得 zh，其余一律回落英文', () => {
    localStorage.setItem('apos.locale', 'zh');
    expect(readLocale()).toBe('zh');
    localStorage.setItem('apos.locale', 'ja');
    expect(readLocale()).toBe('en');
  });

  it('切换会写回 localStorage 并改 <html lang>', () => {
    useLocaleStore.getState().setLocale('zh');
    expect(localStorage.getItem('apos.locale')).toBe('zh');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(t('common.cancel')).toBe('取消');

    useLocaleStore.getState().toggle();
    expect(document.documentElement.lang).toBe('en');
    expect(t('common.cancel')).toBe('Cancel');
  });
});
