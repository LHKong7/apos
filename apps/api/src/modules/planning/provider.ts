import type { AcceptanceCriterion, DependencyType, WorkItemType } from '@apos/contracts';

/**
 * 需求结构化与计划生成的 LLM 抽象。
 *
 * 抽成 provider 有两个目的：
 * 1. 整条链路能在没有 API key 的情况下被测试（StubProvider）
 * 2. 换模型或换供应商不影响业务逻辑
 */

export interface StructureInput {
  rawInput: string;
  projectType: string;
  /** 组织与项目上下文，如已有知识、代码仓库说明 */
  context: { title: string; content: string }[];
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
  generatePlan(req: StructuredRequirement, projectType: string): Promise<GeneratedPlan>;
}
