import type {
  Clarification,
  GeneratedPlan,
  PlanTaskDraft,
  PlanningProvider,
  StructureInput,
  StructuredRequirement,
} from './provider';

/**
 * The deterministic provider — it keeps the whole chain runnable and testable with
 * no API key / 确定性 provider。
 *
 * It does not "pretend to be an LLM". It pulls out of the raw text whatever rules can
 * pull out, and honestly files the rest as clarification questions. That buys:
 * - tests that are stable and repeatable
 * - local development that costs nothing
 * - degradation rather than paralysis when the LLM is unavailable
 */
export class StubPlanningProvider implements PlanningProvider {
  readonly name = 'stub';

  constructor(private readonly options: { placeholder?: boolean } = {}) {}

  async structureRequirement(input: StructureInput): Promise<StructuredRequirement> {
    if (this.options.placeholder) return placeholderRequirement(input);
    const raw = input.rawInput.trim();
    const firstSentence = raw.split(/[。.！!？?\n]/)[0]?.trim() ?? raw.slice(0, 40);

    const mentions = (kw: RegExp) => kw.test(raw);
    const clarifications: Clarification[] = [];

    // Mentions shipping but never says which environment — the most common ambiguity
    // in real requirements
    if (mentions(/上线|发布|deploy|release/i)) {
      clarifications.push({
        question: '「上线」指生产环境全量，还是先灰度？',
        level: 'must_confirm',
        impact: '决定发布方案与回滚预案，可能影响 1 天工期',
        agentSuggestion: '先灰度 10%，观察 2 小时后扩量',
        suggestionBasis: '组织内同类变更的默认发布策略',
        options: ['生产全量', '灰度 10%', '仅预生产'],
      });
    }

    if (mentions(/性能|慢|优化|响应|latency|slow/i)) {
      clarifications.push({
        question: '性能目标的具体指标是什么？',
        level: 'must_confirm',
        impact: '没有量化目标就无法定义验收标准，Review 阶段会返工',
        agentSuggestion: 'P95 响应时间 < 500ms',
        suggestionBasis: '现有同类接口的 SLA',
        options: ['P95 < 200ms', 'P95 < 500ms', 'P95 < 1s'],
      });
    }

    const likelyDbWork = mentions(/数据|表|查|搜|索引|database|sql|性能|慢/i);

    if (likelyDbWork) {
      clarifications.push({
        question: '是否涉及生产数据库结构变更？',
        level: 'must_confirm',
        impact: '涉及则需要 DBA 审批与回滚脚本，工期 +0.5 天',
        agentSuggestion: '按需要 DDL 处理',
        suggestionBasis: '性能优化类需求通常涉及索引变更',
        options: ['需要 DDL', '仅查询优化', '不确定'],
      });
    }

    clarifications.push({
      question: '搜索/列表结果的分页大小？',
      level: 'default_applicable',
      impact: '影响前端交互，可用组织默认值',
      agentSuggestion: '20 条/页',
      suggestionBasis: '组织默认分页配置',
      options: ['10 条/页', '20 条/页', '50 条/页'],
    });

    const acceptanceCriteria = [
      {
        id: 'ac-func',
        text: `${firstSentence} 的核心功能可用`,
        verification: 'agent' as const,
        status: 'pending' as const,
        evidenceRef: null,
        verifiedAt: null,
      },
      {
        id: 'ac-test',
        text: '单元测试覆盖率不低于 80%',
        verification: 'auto' as const,
        status: 'pending' as const,
        evidenceRef: null,
        verifiedAt: null,
      },
      {
        id: 'ac-scan',
        text: '通过安全扫描',
        verification: 'auto' as const,
        status: 'pending' as const,
        evidenceRef: null,
        verifiedAt: null,
      },
    ];

    return {
      title: firstSentence.slice(0, 60) || '未命名需求',
      businessContext: raw.slice(0, 500),
      userProblem: firstSentence,
      businessGoal: `解决：${firstSentence}`,
      userStories: [`作为用户，我希望${firstSentence}，以便提升使用效率`],
      scope: { inScope: [firstSentence], outOfScope: ['历史数据迁移'] },
      nonFunctional: mentions(/性能|慢|优化/) ? ['P95 响应时间需满足约定目标'] : [],
      successMetrics: [],
      constraints: [],
      // ★ This risk doubles as the signal generatePlan uses to decide whether a
      //   database task is needed, so structuring and planning judge on the same basis
      risks: likelyDbWork ? ['可能涉及生产数据库索引或结构变更，需评估回滚方案'] : [],
      acceptanceCriteria,
      clarifications,
      assumptions: ['不涉及历史数据迁移'],
      provenance: {
        title: { source: 'raw_input', span: [0, Math.min(firstSentence.length, raw.length)] },
        businessContext: { source: 'raw_input', span: [0, Math.min(500, raw.length)] },
      },
      cost: 0,
      model: 'stub',
    };
  }

  async generatePlan(
    req: StructuredRequirement,
    projectType: string,
    feedback?: string,
  ): Promise<GeneratedPlan> {
    if (this.options.placeholder) return placeholderPlan(req);
    const start = 0;
    const involvesDb = req.risks.some((r) => r.includes('数据库'));

    const tasks: PlanTaskDraft[] = [
      {
        ref: 'research',
        title: '现状分析与方案调研',
        description: `分析 ${req.title} 的现状与可选方案`,
        type: 'research',
        phase: 'Research',
        estimatedHours: 4,
        estimatedTokens: 75_000,
        riskLevel: 'low',
        requiredCapabilities: ['workspace.read'],
        requiredTools: [],
        requiresHuman: false,
        acceptanceCriteria: [],
        dependsOn: [],
      },
      {
        ref: 'design',
        title: '接口与实现方案设计',
        description: '产出技术方案与接口定义',
        type: 'task',
        phase: 'Design',
        estimatedHours: 6,
        estimatedTokens: 100_000,
        riskLevel: 'low',
        requiredCapabilities: ['workspace.read', 'workspace.write'],
        requiredTools: [],
        requiresHuman: false,
        acceptanceCriteria: [],
        dependsOn: [{ ref: 'research', type: 'finish_to_start' }],
      },
      {
        ref: 'backend',
        title: '服务端实现',
        description: '按设计实现服务端逻辑',
        type: 'task',
        phase: 'Backend',
        estimatedHours: 12,
        estimatedTokens: 325_000,
        riskLevel: 'medium',
        requiredCapabilities: ['workspace.read', 'workspace.write', 'pull_request.create'],
        requiredTools: [],
        requiresHuman: false,
        acceptanceCriteria: req.acceptanceCriteria.filter((c) => c.id === 'ac-func'),
        dependsOn: [{ ref: 'design', type: 'finish_to_start' }],
      },
      {
        ref: 'test',
        title: '单元测试与集成测试',
        description: '补充测试并保证覆盖率达标',
        type: 'test',
        phase: 'Test',
        estimatedHours: 6,
        estimatedTokens: 125_000,
        riskLevel: 'low',
        requiredCapabilities: ['workspace.read', 'workspace.write', 'command.test'],
        requiredTools: [],
        requiresHuman: false,
        acceptanceCriteria: req.acceptanceCriteria.filter((c) => c.id === 'ac-test'),
        dependsOn: [{ ref: 'backend', type: 'finish_to_start' }],
      },
      {
        ref: 'release',
        title: '发布到生产环境',
        description: '按发布方案执行灰度发布',
        type: 'release',
        phase: 'Release',
        estimatedHours: 2,
        estimatedTokens: null,
        riskLevel: 'high',
        requiredCapabilities: [],
        requiredTools: [],
        // Production releases default to being executed by a human (product doc 8.8.6)
        requiresHuman: true,
        operationType: 'deploy',
        environment: 'production',
        acceptanceCriteria: [],
        dependsOn: [{ ref: 'test', type: 'finish_to_start' }],
      },
    ];

    if (involvesDb) {
      tasks.splice(3, 0, {
        ref: 'db',
        title: '数据库索引变更',
        description: '按设计方案调整索引',
        type: 'task',
        phase: 'Backend',
        estimatedHours: 4,
        estimatedTokens: null,
        riskLevel: 'high',
        requiredCapabilities: [],
        requiredTools: [],
        requiresHuman: true,
        operationType: 'db_ddl',
        environment: 'production',
        acceptanceCriteria: [],
        dependsOn: [{ ref: 'design', type: 'finish_to_start' }],
      });
      const test = tasks.find((t) => t.ref === 'test');
      test?.dependsOn.push({ ref: 'db', type: 'finish_to_start' });
    }

    /**
     * ★ Apply the revision feedback. It runs after the base list is fully assembled —
     *   it splits tasks and rewrites refs, so running it earlier makes every later
     *   lookup-by-ref miss (that is exactly how the first version blew up: after the
     *   test task was split, the involvesDb branch went looking for find('test')).
     *
     *   This is keyword matching, not comprehension — it stands in for a model that
     *   would actually read the feedback. It has to exist because a planner that
     *   ignores feedback turns "request changes" into a fake button: the user
     *   comments and gets back an identical v2, and the whole replanning path
     *   (version comparison included) never gets to exercise "the plan really did
     *   change".
     *
     * ★ 按「要求修改」的意见调整，必须放在基础清单拼完之后 —— 它会拆任务、改 ref。
     *   这是关键词匹配而不是理解：不响应意见的规划器会让「要求修改」变成假按钮。
     */
    applyRevision(tasks, feedback);

    return {
      tasks,
      milestones: [
        { name: '功能可用', taskRefs: ['backend', 'test'], dueOffsetDays: 3 },
        { name: '正式上线', taskRefs: ['release'], dueOffsetDays: 5 },
      ],
      risks: req.risks.map((r) => ({
        description: r,
        level: 'medium',
        mitigation: '在计划中安排对应的评估任务',
      })),
      cost: 0,
      durationMs: Date.now() - start > 0 ? 0 : 0,
      model: `stub:${projectType}`,
    };
  }
}

/**
 * A fallback is an editable scaffold, not a guessed PRD. It intentionally
 * carries no invented user story, quality target, pagination choice or release
 * step. The approval gate requires a person to replace these blanks.
 */
function placeholderRequirement(input: StructureInput): StructuredRequirement {
  const raw = input.rawInput.trim();
  const firstLine = raw.split(/\r?\n/)[0]?.trim() || '未命名需求';
  return {
    title: firstLine.slice(0, 60),
    businessContext: '',
    userProblem: raw,
    businessGoal: '',
    userStories: [],
    scope: { inScope: [], outOfScope: [] },
    nonFunctional: [],
    successMetrics: [],
    constraints: [],
    risks: [],
    acceptanceCriteria: [],
    clarifications: [
      {
        question: '请补充目标用户、明确范围，以及至少一条可验证的成功条件。',
        level: 'must_confirm',
        impact: '缺少这些信息时无法生成可执行、可验收的计划。',
        agentSuggestion: null,
        suggestionBasis: null,
        options: [],
      },
    ],
    assumptions: [],
    provenance: {
      title: { source: 'raw_input', span: [0, Math.min(firstLine.length, raw.length)] },
      userProblem: { source: 'raw_input', span: [0, raw.length] },
    },
    cost: 0,
    model: 'stub:fallback',
  };
}

function placeholderPlan(req: StructuredRequirement): GeneratedPlan {
  return {
    tasks: [
      {
        ref: 'manual-completion',
        title: '人工补全需求与执行计划',
        description: `围绕「${req.title}」补齐范围、实现边界、验证方式与交付目标后重新生成计划。`,
        type: 'task',
        phase: 'Clarification',
        estimatedHours: 0,
        estimatedTokens: null,
        riskLevel: 'low',
        requiredCapabilities: [],
        requiredTools: [],
        requiresHuman: true,
        acceptanceCriteria: [],
        dependsOn: [],
      },
    ],
    milestones: [],
    risks: [
      {
        description: '当前内容是占位骨架，不能据此执行或审批。',
        level: 'medium',
        mitigation: '人工补齐需求后使用可用的规划 Agent 重新生成。',
      },
    ],
    cost: 0,
    durationMs: 0,
    model: 'stub:fallback',
  };
}

/**
 * Fold the user's feedback into the task list / 把用户意见落到任务清单上。
 *
 * ★ The real implementation splices the feedback into the prompt and lets the model
 *   replan. This is keyword matching covering the three most common comments: too
 *   coarse a breakdown, don't automate that step, the hour estimates are too low.
 *   Deliberately nothing more — a stub that pretends to understand arbitrary natural
 *   language misleads people into thinking this chain is already intelligent.
 */
function applyRevision(tasks: PlanTaskDraft[], feedback?: string) {
  if (!feedback) return;

  // "don't automate it / a human should confirm" → mark the named step human-required
  // (tightening)
  if (/不要自动|别自动|人工|人来|需要确认|要确认/.test(feedback)) {
    for (const t of tasks) {
      if (mentions(feedback, t)) t.requiresHuman = true;
    }
  }

  /**
   * ★ "stop asking me every time / just do it automatically" → drop the human
   *   confirmation (loosening).
   *
   *   Real users write this, and it is precisely why version comparison carries that
   *   prominent warning. If the stub could only tighten and never loosen, the "this
   *   version widened the automation boundary" path would live nowhere but in unit
   *   tests — and it is the single path that can least afford to be wrong.
   *
   * ★ 「不用每次都问我 / 自动做就行」→ 去掉人工确认（放宽）。stub 只会收紧不会
   *   放宽的话，「这一版放宽了自动化边界」那条路径就永远只活在单元测试里。
   */
  if (/不用问|不用确认|不用每次|自动做|自动执行|别拦/.test(feedback)) {
    for (const t of tasks) {
      if (mentions(feedback, t)) t.requiresHuman = false;
    }
  }

  // "too coarse / break it down further" → split the test task into two
  if (/太粗|拆细|拆分|再拆/.test(feedback)) {
    const idx = tasks.findIndex((t) => t.ref === 'test');
    if (idx > -1) {
      const test = tasks[idx]!;
      const half = Math.max(1, Math.round((test.estimatedHours / 2) * 10) / 10);
      tasks.splice(idx, 1, {
        ...test,
        ref: 'test-unit',
        title: '单元测试',
        description: '按验收标准补充单元测试',
        estimatedHours: half,
        estimatedTokens: test.estimatedTokens === null ? null : Math.round(test.estimatedTokens / 2),
        acceptanceCriteria: [],
      }, {
        ...test,
        ref: 'test-integration',
        title: '集成测试',
        description: '端到端验证与覆盖率达标',
        estimatedHours: test.estimatedHours - half,
        estimatedTokens: test.estimatedTokens === null ? null : Math.round(test.estimatedTokens / 2),
        dependsOn: [{ ref: 'test-unit', type: 'finish_to_start' }],
      });
      // Tasks that depended on test now depend on the last of the pieces it split into
      for (const t of tasks) {
        for (const d of t.dependsOn) if (d.ref === 'test') d.ref = 'test-integration';
      }
    }
  }

  // "the hours are underestimated / too optimistic" → inflate everything by 30%
  if (/估少|太乐观|时间不够|工时不够/.test(feedback)) {
    for (const t of tasks) {
      t.estimatedHours = Math.round(t.estimatedHours * 1.3 * 10) / 10;
    }
  }
}

/** Does the feedback refer to this step — by title match, or by type ("release" → release tasks) */
function mentions(feedback: string, task: PlanTaskDraft): boolean {
  if (feedback.includes(task.title)) return true;
  if (/发布|上线|部署/.test(feedback) && task.type === 'release') return true;
  if (/数据库|索引|建表/.test(feedback) && task.operationType === 'db_ddl') return true;
  return false;
}
