import type {
  Clarification,
  GeneratedPlan,
  PlanTaskDraft,
  PlanningProvider,
  StructureInput,
  StructuredRequirement,
} from './provider';

/**
 * 确定性 provider —— 让整条链路在没有 API key 时也能跑通与测试。
 *
 * 它不是「假装成 LLM」，而是用规则从原文里抽取能抽取的部分，
 * 抽不出来的诚实地列为澄清问题。这保证了：
 * - 测试稳定可重复
 * - 本地开发不烧钱
 * - LLM 不可用时系统降级而非瘫痪
 */
export class StubPlanningProvider implements PlanningProvider {
  readonly name = 'stub';

  async structureRequirement(input: StructureInput): Promise<StructuredRequirement> {
    const raw = input.rawInput.trim();
    const firstSentence = raw.split(/[。.！!？?\n]/)[0]?.trim() ?? raw.slice(0, 40);

    const mentions = (kw: RegExp) => kw.test(raw);
    const clarifications: Clarification[] = [];

    // 提到了时间要求但没说清是哪个环境 —— 真实需求里最常见的歧义
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
      // ★ 这条 risk 同时是 generatePlan 判断是否需要数据库任务的信号，
      //   保证结构化与计划两步用的是同一个判断依据
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
        requiredSkills: ['需求分析'],
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
        requiredSkills: ['系统设计'],
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
        requiredSkills: ['TypeScript'],
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
        requiredSkills: ['测试'],
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
        requiredSkills: [],
        requiredCapabilities: [],
        requiredTools: [],
        // 生产发布默认由人执行（产品文档 8.8.6）
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
        requiredSkills: ['SQL 优化'],
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
     * ★ 按「要求修改」的意见调整。放在基础清单拼完之后 ——
     *   它会拆任务、改 ref，先跑的话后面按 ref 找任务的地方就都落空了
     *   （第一版就是这么炸的：拆完 test 之后 involvesDb 分支再去 find('test')）。
     *
     *   这是关键词匹配，不是理解 —— 它替的是一个会读懂意见的模型。
     *   之所以非做不可：不响应意见的规划器会让「要求修改」变成假按钮，
     *   用户提了意见拿回一模一样的 v2，而整条重新规划的链路
     *   （含版本对比）也就永远测不到「计划真的变了」这条路径。
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
 * 把用户意见落到任务清单上。
 *
 * ★ 真实实现是把 feedback 拼进 prompt 让模型重新规划。这里是关键词匹配，
 *   覆盖三类最常见的意见：拆得太粗、某步不要自动做、工时估少了。
 *   刻意不做更多 —— 一个假装能理解任意自然语言的 stub，
 *   会让人误以为这条链路已经智能了。
 */
function applyRevision(tasks: PlanTaskDraft[], feedback?: string) {
  if (!feedback) return;

  // 「不要自动做 / 要人确认」→ 把提到的那一步改成需要人（收紧）
  if (/不要自动|别自动|人工|人来|需要确认|要确认/.test(feedback)) {
    for (const t of tasks) {
      if (mentions(feedback, t)) t.requiresHuman = true;
    }
  }

  /**
   * ★ 「不用每次都问我 / 自动做就行」→ 去掉人工确认（放宽）。
   *
   *   这是真实用户会提的意见，也正是版本对比里那条醒目警告存在的理由。
   *   stub 只会收紧不会放宽的话，「这一版放宽了自动化边界」那条路径
   *   就永远只活在单元测试里 —— 而它恰恰是最不能出错的一条。
   */
  if (/不用问|不用确认|不用每次|自动做|自动执行|别拦/.test(feedback)) {
    for (const t of tasks) {
      if (mentions(feedback, t)) t.requiresHuman = false;
    }
  }

  // 「拆得太粗 / 再拆细」→ 把测试任务拆成两条
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
      // 原本依赖 test 的任务改依赖拆出来的最后一条
      for (const t of tasks) {
        for (const d of t.dependsOn) if (d.ref === 'test') d.ref = 'test-integration';
      }
    }
  }

  // 「工时估少了 / 太乐观」→ 整体上浮 30%
  if (/估少|太乐观|时间不够|工时不够/.test(feedback)) {
    for (const t of tasks) {
      t.estimatedHours = Math.round(t.estimatedHours * 1.3 * 10) / 10;
    }
  }
}

/** 意见里提到了这一步吗 —— 标题命中，或按类型指代（「发布」→ release 任务） */
function mentions(feedback: string, task: PlanTaskDraft): boolean {
  if (feedback.includes(task.title)) return true;
  if (/发布|上线|部署/.test(feedback) && task.type === 'release') return true;
  if (/数据库|索引|建表/.test(feedback) && task.operationType === 'db_ddl') return true;
  return false;
}
