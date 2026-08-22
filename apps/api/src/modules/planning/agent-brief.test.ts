import { describe, expect, it } from 'vitest';
import { buildPlanBrief, buildRepairBrief, buildStructureBrief } from './agent-brief';
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
 * ★★ The brief must carry one explicit sentence about the output language.
 *
 *   Before this it said nothing at all, and with the brief itself in Chinese while
 *   the requirement may be in English, both sides have a claim — so the model picked
 *   one per call. Measured on the same English requirement: one run came back as an
 *   all-Chinese PRD, another as all-English, leaving two languages coexisting inside
 *   one project with no setting anywhere in the UI able to influence it.
 *
 * ★★ brief 里必须有一句明确的输出语言要求。在此之前一个字都没提，而 brief 本身是
 *   中文、需求可能是英文 —— 模型两边都占理，于是它每次自己挑一个。
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

  /** ★ With no locale, write in the product's default language (English) rather than
   *  handing the choice back to the model */
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

  /** ★ Verbatim quotations stay untranslated — translating a name the user chose renames it */
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

/**
 * Mines the brief lays for itself / 任务书自己埋的雷。
 *
 * ★★ A real incident: the schema example read `"dependsOn": [{ "ref": "design" }]` —
 *   `design` used as a sample ref, while the 13 work-item types contain **no**
 *   design. The planning agent copied the word straight into `type`, the whole plan
 *   was rejected, and the user got back a generic template unrelated to their
 *   requirement.
 *
 *   The example is the part of the brief a model obeys most: it copies from the
 *   example far more readily than it reads the hard requirements. So this group
 *   guards one thing — the example itself must not teach the wrong answer.
 */
describe('计划任务书不能自己教错', () => {
  const brief = () => buildPlanBrief(REQ, 'development', undefined, 'zh');

  it('★ 示例的 ref 不使用任何一个合法的 type 值', () => {
    const example = brief().match(/```jsonc\n([\s\S]*?)\n```/)![1]!;
    const refs = [...example.matchAll(/"ref":\s*"([^"]+)"/g)].map((m) => m[1]!);
    const TYPES = [
      'requirement', 'feature', 'story', 'task', 'bug', 'research', 'review',
      'test', 'incident', 'decision', 'approval', 'release', 'knowledge',
    ];
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((r) => TYPES.includes(r))).toEqual([]);
    // The word from the incident must not appear anywhere in the example again
    expect(example).not.toContain('"design"');
  });

  /**
   * ★ dependsOn in the example must point at a ref that **actually exists** in the
   *   example. The old example had a single task yet depended on an undefined ref —
   *   the hard-requirements section says in so many words "must point at a task that
   *   really exists", and the example was the first thing to violate it.
   */
  it('★ 示例里的 dependsOn 指向示例内真实存在的任务', () => {
    const example = brief().match(/```jsonc\n([\s\S]*?)\n```/)![1]!;
    const refs = new Set([...example.matchAll(/"ref":\s*"([^"]+)"/g)].map((m) => m[1]!));
    const deps = [...example.matchAll(/"dependsOn":\s*\[\s*\{\s*"ref":\s*"([^"]+)"/g)].map(
      (m) => m[1]!,
    );
    expect(deps.length).toBeGreaterThan(0);
    for (const dep of deps) expect(refs.has(dep)).toBe(true);
  });

  /** ★ All 13 legal values must be listed, plus where design work and research work land */
  it('★ 列出全部 13 个 type，并给出设计类与调研类的去处', () => {
    const out = brief();
    for (const t of [
      'requirement', 'feature', 'story', 'task', 'bug', 'research', 'review',
      'test', 'incident', 'decision', 'approval', 'release', 'knowledge',
    ]) {
      expect(out).toContain(t);
    }
    expect(out).toContain('方案设计');
    expect(out).toContain('调研');
  });

  /**
   * ★★ The comment on `estimatedTokens` says "write null when you cannot estimate",
   *   and the model quite naturally generalizes that habit to the optional fields
   *   next to it. The brief has to say outright that the allowance applies to that
   *   one field only.
   */
  it('★ 说明「不确定的可选字段整个省略，不要写 null」', () => {
    const out = brief();
    expect(out).toContain('不要写');
    expect(out).toContain('null');
    expect(out).toContain('省略');
  });
});

/**
 * The brief for the repair round / 修正轮的任务书。
 *
 * ★★ Drop any one of the three and the round is wasted: with only the complaint the
 *   agent has no idea what it wrote last time and rewrites from scratch (often
 *   repeating the same mistake); with only the output it does not know what failed;
 *   without the original brief it is a fresh session with no schema at all.
 */
describe('修正轮的任务书', () => {
  const original = buildPlanBrief(REQ, 'development', undefined, 'zh');

  it('★ 报错、上一版产物、原任务书三样都在', () => {
    const repair = buildRepairBrief(original, 'tasks.0.type 无效的枚举值', '{"tasks":[]}');
    expect(repair).toContain('tasks.0.type 无效的枚举值');
    expect(repair).toContain('{"tasks":[]}');
    expect(repair).toContain('type` 只有这 13 个值');
  });

  /** ★ The instruction has to say "fix what is wrong", not "write a new one" — a rewrite
   *  throws away everything the previous round worked out */
  it('★ 让它只改错的地方，并整份重写产物文件', () => {
    const repair = buildRepairBrief(original, 'x', '{}');
    expect(repair).toContain('只改错的地方');
    expect(repair).toContain('不是补丁');
  });

  /**
   * ★ The previous output has to be truncated. A rejected plan can run to tens of KB,
   *   and pasting all of it back pushes the one line that matters ("here is what was
   *   wrong") thousands of lines down.
   */
  it('★ 上一版产物过长时截断，并说明截断了', () => {
    const huge = 'x'.repeat(50_000);
    const repair = buildRepairBrief(original, 'x', huge);
    expect(repair.length).toBeLessThan(original.length + 20_000);
    expect(repair).toContain('太长，只截取前');
  });

  /** When the previous round wrote no file at all, say so plainly instead of showing an empty code block */
  it('上一版没有产物时如实说明', () => {
    expect(buildRepairBrief(original, 'x', null)).toContain('上一版没有写出产物文件');
  });
});

