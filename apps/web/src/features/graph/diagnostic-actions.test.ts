import { beforeEach, describe, expect, it } from 'vitest';
import { DIAGNOSTIC_TYPES, type DiagnosticAction } from '@apos/domain';
import { useLocaleStore } from '../../lib/i18n';
import { resolveDiagnosticAction } from './diagnostic-actions';

const PROJECT = 'p1';

/** 领域层可能产出的全部动作种类 */
const ALL_KINDS: DiagnosticAction['kind'][] = [
  'remind',
  'reassign',
  'split',
  'adjust_dependency',
  'adjust_policy',
  'locate',
];

/** ★ 钉住中文：这条断言查的是「计划」两个字，默认语言是英文 */
beforeEach(() => useLocaleStore.setState({ locale: 'zh' }));

describe('诊断动作一定有去处', () => {
  it('★ 每一种动作都解析出可执行意图，没有一种是死胡同', () => {
    for (const kind of ALL_KINDS) {
      const intent = resolveDiagnosticAction({ kind, labelCode: 'reassign', label: kind, nodeId: 'n1' }, PROJECT);
      expect(intent, kind).toBeTruthy();
      expect(intent.kind, kind).not.toBe('noop');
    }
  });

  it('★ 没有任何动作会把用户导向「尚未实现」', () => {
    for (const kind of ALL_KINDS) {
      const intent = resolveDiagnosticAction({ kind, labelCode: 'reassign', label: kind, nodeId: 'n1' }, PROJECT);
      if (intent.kind === 'explain') {
        // 唯一允许只给话不给页面的是 MVP 有意只读的依赖调整，
        // 而且必须说清替代路径，不能是一句「没做」
        expect(intent.message).toMatch(/计划/);
        expect(intent.message).not.toMatch(/尚未实现|暂未实现/);
      }
    }
  });

  it('调整 Policy 落到本项目的 Policy 配置页', () => {
    const intent = resolveDiagnosticAction({ kind: 'adjust_policy', labelCode: 'reassign', label: '调整 Policy' }, PROJECT);
    expect(intent).toEqual({ kind: 'navigate', to: '/projects/p1/settings/policies' });
  });

  it('★ 在看板中定位带上具体卡片，而不是把人扔到看板首页', () => {
    const intent = resolveDiagnosticAction(
      { kind: 'locate', labelCode: 'reassign', label: '在看板中定位', nodeId: 'w9' },
      PROJECT,
    );
    expect(intent).toEqual({ kind: 'navigate', to: '/projects/p1/board?card=w9' });
  });

  it('缺 nodeId 时退化成不带定位的看板，而不是拼出 card=undefined', () => {
    const intent = resolveDiagnosticAction({ kind: 'locate', labelCode: 'reassign', label: '定位' }, PROJECT);
    expect(intent).toEqual({ kind: 'navigate', to: '/projects/p1/board' });
  });

  it('改派与拆分就地开抽屉，不换页', () => {
    for (const kind of ['reassign', 'split'] as const) {
      expect(resolveDiagnosticAction({ kind, labelCode: 'reassign', label: kind, nodeId: 'w3' }, PROJECT)).toEqual({
        kind: 'open-card',
        nodeId: 'w3',
      });
    }
  });

  it('催办指向那条决策；没有具体节点时退到决策中心', () => {
    expect(
      resolveDiagnosticAction({ kind: 'remind', labelCode: 'reassign', label: '催办', nodeId: 'w4' }, PROJECT),
    ).toEqual({ kind: 'remind', nodeId: 'w4' });
    expect(resolveDiagnosticAction({ kind: 'remind', labelCode: 'reassign', label: '催办' }, PROJECT)).toEqual({
      kind: 'navigate',
      to: '/projects/p1/decisions',
    });
  });

  it('六类诊断都还在（领域层删改了会红，提醒同步检查落点）', () => {
    expect([...DIAGNOSTIC_TYPES]).toEqual([
      'cycle',
      'blocking_amplified',
      'pseudo_serial',
      'approval_bottleneck',
      'single_point',
      'agent_overload',
    ]);
  });
});
