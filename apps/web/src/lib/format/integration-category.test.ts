import { describe, expect, it } from 'vitest';
import { useLocaleStore } from '../i18n';
import { integrationCategoryLabel } from './index';

/**
 * ★★ 集成分类的措辞归界面，不归服务端。
 *
 *   这一页原来印的是响应里的 `categoryLabel` —— 它来自 contracts 的
 *   `CATEGORY_LABELS`，只有中文。同文件里的邻居（`SYNC_FIELD_LABELS`、
 *   `STRATEGY_LABELS`）都带 `_EN` 镜像，唯独它没有，于是英文界面上三个
 *   中文标题压在一排翻译好的卡片上 —— 而这种漏法在中文界面里完全看不出来。
 *
 *   Integration category wording belongs to the UI. The page used to print the
 *   response's `categoryLabel`, which is Chinese-only; every neighbouring table
 *   in the same contracts file ships an `_EN` mirror and this one never did.
 *   The failure is invisible in the Chinese UI, which is exactly why it needs a
 *   test rather than a look.
 */
describe('集成分类标题跟着界面语言走', () => {
  it('英文界面给英文', () => {
    useLocaleStore.setState({ locale: 'en' });
    expect(integrationCategoryLabel('code')).toBe('Code and engineering');
    expect(integrationCategoryLabel('project_management')).toBe('Project management');
    expect(integrationCategoryLabel('communication')).toBe('Collaboration and notifications');
  });

  it('中文界面给中文', () => {
    useLocaleStore.setState({ locale: 'zh' });
    expect(integrationCategoryLabel('code')).toBe('代码与研发');
    expect(integrationCategoryLabel('communication')).toBe('协同与通知');
  });

  /** ★ 认不出来的分类回落到原始码，而不是空标题 */
  it('未知分类原样显示', () => {
    useLocaleStore.setState({ locale: 'en' });
    expect(integrationCategoryLabel('erp')).toBe('erp');
  });
});
