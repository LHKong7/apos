import { describe, expect, it } from 'vitest';
import { buildPlanBrief, buildStructureBrief } from './agent-brief';
import type { StructuredRequirement } from './provider';

const REQ: StructuredRequirement = {
  title: 'Todo list',
  businessContext: '',
  userProblem: '',
  businessGoal: '',
  userStories: [],
  scope: { inScope: [], outOfScope: [] },
  nonFunctional: [],
  successMetrics: [],
  constraints: [],
  risks: [],
  acceptanceCriteria: [],
  clarifications: [],
  assumptions: [],
  provenance: {},
  cost: 0,
  model: '',
};

/**
 * ★★ brief 里必须有一句明确的输出语言要求。
 *
 *   在此之前一个字都没提，而 brief 本身是中文、需求可能是英文 ——
 *   模型两边都占理，于是它每次自己挑一个。实测同一段英文需求，
 *   一条拿回全中文 PRD、另一条拿回全英文，同一个项目里两种语言并存，
 *   而界面上没有任何设置左右得了它。
 */
describe('brief 必须钉住输出语言', () => {
  it('结构化 brief 里带英文要求', () => {
    const brief = buildStructureBrief({
      rawInput: 'Build a todo list',
      projectType: 'development',
      context: [],
      scope: { orgId: 'o', projectId: 'p', locale: 'en' },
    });
    expect(brief).toContain('输出语言');
    expect(brief).toContain('英文');
  });

  it('结构化 brief 里带中文要求', () => {
    const brief = buildStructureBrief({
      rawInput: '做一个待办清单',
      projectType: 'development',
      context: [],
      scope: { orgId: 'o', projectId: 'p', locale: 'zh' },
    });
    expect(brief).toContain('简体中文');
  });

  /** ★ 没给 locale 时按产品默认语言（英文）写，而不是把选择权还给模型 */
  it('没给 locale 时回落到英文', () => {
    const brief = buildStructureBrief({
      rawInput: 'Build a todo list',
      projectType: 'development',
      context: [],
    });
    expect(brief).toContain('英文');
  });

  it('计划 brief 同样钉住语言', () => {
    expect(buildPlanBrief(REQ, 'development', undefined, 'zh')).toContain('简体中文');
    expect(buildPlanBrief(REQ, 'development', undefined, 'en')).toContain('英文');
  });

  /** ★ 原样引用的内容不翻译 —— 翻译用户起的名字等于给它改名 */
  it('说明了哪些内容不该翻译', () => {
    const brief = buildStructureBrief({
      rawInput: 'x',
      projectType: 'development',
      context: [],
      scope: { orgId: 'o', projectId: 'p', locale: 'en' },
    });
    expect(brief).toContain('不要翻译');
  });
});
