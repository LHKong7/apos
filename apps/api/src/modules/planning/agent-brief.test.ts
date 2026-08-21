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

/**
 * 任务书自己埋的雷。
 *
 * ★★ 一次真实事故：schema 示例里写着 `"dependsOn": [{ "ref": "design" }]` ——
 *   拿 `design` 当示例 ref，而 13 种工作项类型里**没有** design。
 *   规划 Agent 把这个词抄进了 `type`，整份计划被拒收，用户拿回一份
 *   与需求无关的通用模板。
 *
 *   示例是模型最听话的那部分：它照抄的概率比读硬要求高得多。
 *   所以这一组守的是「示例本身不能教错」。
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
    // 事故里那个词一个都不该再出现在示例里
    expect(example).not.toContain('"design"');
  });

  /**
   * ★ 示例里的 dependsOn 必须指向示例里**真实存在**的 ref。
   *   原来的示例只有一个任务、却依赖了一个没定义的 ref —— 硬要求那一节
   *   明明写着「必须指向真实存在的任务」，示例自己先违反了它。
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

  /** ★ 13 个合法值要列全，并且告诉它「设计」「调研」该落到哪一个 */
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
   * ★★ `estimatedTokens` 的注释上写着「估不出来填 null」，模型很自然地
   *   把这个习惯推广到旁边几个可选字段。得明说这一条只适用于它一个。
   */
  it('★ 说明「不确定的可选字段整个省略，不要写 null」', () => {
    const out = brief();
    expect(out).toContain('不要写');
    expect(out).toContain('null');
    expect(out).toContain('省略');
  });
});

/**
 * 修正轮的任务书。
 *
 * ★★ 缺任何一样这一轮就白跑：只给报错，Agent 不知道自己当时写了什么，
 *   只能从头重写（很可能重犯同一个错）；只给产物，它不知道哪里不合格；
 *   不给原任务书，它这一轮是新会话，根本没有 schema。
 */
describe('修正轮的任务书', () => {
  const original = buildPlanBrief(REQ, 'development', undefined, 'zh');

  it('★ 报错、上一版产物、原任务书三样都在', () => {
    const repair = buildRepairBrief(original, 'tasks.0.type 无效的枚举值', '{"tasks":[]}');
    expect(repair).toContain('tasks.0.type 无效的枚举值');
    expect(repair).toContain('{"tasks":[]}');
    expect(repair).toContain('type` 只有这 13 个值');
  });

  /** ★ 指令要说「改错的地方」而不是「重写一份」—— 重写等于上一轮白做 */
  it('★ 让它只改错的地方，并整份重写产物文件', () => {
    const repair = buildRepairBrief(original, 'x', '{}');
    expect(repair).toContain('只改错的地方');
    expect(repair).toContain('不是补丁');
  });

  /**
   * ★ 上一版产物要截断。一份被判废的计划可能有几十 KB，整个塞回去会把
   *   真正要读的那句「哪里错了」挤到几千行之后。
   */
  it('★ 上一版产物过长时截断，并说明截断了', () => {
    const huge = 'x'.repeat(50_000);
    const repair = buildRepairBrief(original, 'x', huge);
    expect(repair.length).toBeLessThan(original.length + 20_000);
    expect(repair).toContain('太长，只截取前');
  });

  /** 上一轮压根没写出文件时如实说，而不是给一段空的代码块 */
  it('上一版没有产物时如实说明', () => {
    expect(buildRepairBrief(original, 'x', null)).toContain('上一版没有写出产物文件');
  });
});

