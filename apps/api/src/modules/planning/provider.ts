import type { AcceptanceCriterion, DependencyType, WorkItemType } from '@apos/contracts';

/**
 * 需求结构化与计划生成的 LLM 抽象。
 *
 * 抽成 provider 有两个目的：
 * 1. 整条链路能在没有 API key 的情况下被测试（StubProvider）
 * 2. 换模型或换供应商不影响业务逻辑
 */

/**
 * 这次规划属于谁。
 *
 * ★ 走真实 Agent 的 provider 需要它来挑执行者：规划 Agent 是按组织配置的
 *   （agents.applicableTypes 含 `requirement`），不给 scope 就只能退回规则占位。
 *
 * ★ 做成可选而不是必填：StubProvider 根本不看它，而一堆既有测试是直接
 *   构造 StructureInput 的 —— 为了一个它们用不到的字段去改测试，
 *   改动的是测试而不是被测的东西。缺失时 AgentProvider 会**如实回退并说明**，
 *   不是静默降级。
 */
export interface PlanningScope {
  orgId: string;
  projectId: string;
  /**
   * 这次分析 / 规划是给哪条需求做的。
   *
   * ★ 落到 agent_runs.requirement_id 上。没有它，规划 Run 是一批查得到却
   *   找不回来的记录：需求页上没有任何入口指向它。
   */
  requirementId?: string;
}

export interface StructureInput {
  rawInput: string;
  projectType: string;
  /** 组织与项目上下文，如已有知识、代码仓库说明 */
  context: { title: string; content: string }[];
  scope?: PlanningScope;
}

export type ClarificationLevel =
  | 'must_confirm'
  | 'default_applicable'
  | 'assumption_ok'
  | 'auto_resolved';

export interface Clarification {
  question: string;
  level: ClarificationLevel;
  /** 不回答会怎样 —— 量化到工期或范围 */
  impact: string;
  /** Agent 倾向 + 依据。只提问不给建议会让用户觉得「AI 在考我」 */
  agentSuggestion: string | null;
  suggestionBasis: string | null;
  options: string[];
  /**
   * 人给出的答案。
   *
   * ★★ 规划要用的就是这个。以前这个类型里根本没有它 —— 于是即便把澄清
   *   传下去，Agent 拿到的也只是一串问题，用户逐条回答的内容全丢了。
   */
  answer?: string | null;
}

export interface StructuredRequirement {
  title: string;
  businessContext: string;
  userProblem: string;
  businessGoal: string;
  userStories: string[];
  scope: { inScope: string[]; outOfScope: string[] };
  nonFunctional: string[];
  successMetrics: string[];
  constraints: string[];
  risks: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  clarifications: Clarification[];
  assumptions: string[];
  /** 字段 → 原文片段的溯源，支撑需求页的原文对照高亮 */
  provenance: Record<string, { source: string; span?: [number, number] }>;
  cost: number;
  model: string;
}

export interface PlanTaskDraft {
  /** 计划内的临时 ID，用于表达依赖 */
  ref: string;
  title: string;
  description: string;
  type: WorkItemType;
  phase: string;
  estimatedHours: number;
  estimatedCost: number | null;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  requiredSkills: string[];
  requiredTools: string[];
  /** 计划阶段就标记出必须由人做的任务 */
  requiresHuman: boolean;
  operationType?: string;
  environment?: string;
  acceptanceCriteria: AcceptanceCriterion[];
  dependsOn: { ref: string; type: DependencyType }[];
}

export interface GeneratedPlan {
  tasks: PlanTaskDraft[];
  milestones: { name: string; taskRefs: string[]; dueOffsetDays: number }[];
  risks: { description: string; level: string; mitigation: string }[];
  cost: number;
  durationMs: number;
  model: string;
}

export interface PlanningProvider {
  readonly name: string;
  structureRequirement(input: StructureInput): Promise<StructuredRequirement>;
  /**
   * @param feedback 「要求修改」时用户写的意见。
   *
   * ★ 这个参数以前不存在 —— 意见被存进 plans.revisionFeedback，
   *   却从来没有传给规划器。于是用户提了意见，拿回一份一模一样的 v2，
   *   而且没有任何地方会告诉他这件事。版本对比做出来之后，
   *   第一次跑就是在 diff 上看到「重新规划后产出的是一份内容相同的计划」。
   */
  generatePlan(
    req: StructuredRequirement,
    projectType: string,
    feedback?: string,
    scope?: PlanningScope,
  ): Promise<GeneratedPlan>;
}
