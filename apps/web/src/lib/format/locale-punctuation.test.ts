import { describe, expect, it } from 'vitest';
import { useLocaleStore } from '../i18n';
import { colon, joinList } from './index';

/**
 * ★★ 顿号「、」和全角冒号「：」只在中文里成立。
 *
 *   这两个标点此前散落在二十来处 `join('、')` 与写死的 `：` 里，
 *   于是英文界面上出现 `Requirement、Research`、`Can do：Read workspace files`
 *   —— 中文标点夹在英文词之间。这组断言钉住方向别再反过来。
 */
describe('列表与冒号跟着语言走', () => {
  it('英文用逗号加空格', () => {
    useLocaleStore.setState({ locale: 'en' });
    expect(joinList(['Requirement', 'Research'])).toBe('Requirement, Research');
    expect(colon()).toBe(': ');
  });

  it('中文用顿号与全角冒号', () => {
    useLocaleStore.setState({ locale: 'zh' });
    expect(joinList(['需求', '调研'])).toBe('需求、调研');
    expect(colon()).toBe('：');
  });

  it('空列表与单项不出分隔符', () => {
    useLocaleStore.setState({ locale: 'en' });
    expect(joinList([])).toBe('');
    expect(joinList(['only'])).toBe('only');
  });
});
