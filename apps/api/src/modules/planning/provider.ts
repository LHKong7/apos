import type {
  AcceptanceCriterion,
  AgentCapability,
  DataSensitivity,
  DependencyType,
  Environment,
  OperationType,
  PlanFallback,
  WorkItemType,
} from '@apos/contracts';

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
 * ★ 走真实 Agent 的 provider 需要它来挑执行者：候选是**这个项目的 Agent 成员**
 *   （成员关系是授权，不是偏好），不给 scope 就只能退回规则占位。
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
  /**
   * 调用方**点名**的 Agent（需求页上选定的 PRD 编写者）。
   *
   * ★★ 给了它就必须用它，不再走项目绑定，也**不许悄悄换一个** ——
   *   点名的那个不可用时如实失败并说出原因（照旧回退到规则占位，
   *   原因写进 model 字段）。换一个来跑，用户看到的产出署着他没选的
   *   Agent，而界面上一切正常：规划质量突然变了却查不到原因。
   *
   *   An agent named explicitly by the caller (the PRD author picked on the
   *   requirement page). When set it wins over the project binding and is
   *   never silently substituted — if it is unusable the attempt fails with a
   *   stated reason rather than quietly running someone else.
   */
  agentId?: string;
  /**
   * 产出该用哪种语言写。
   *
   * ★★ brief 里此前一个字都没提语言，于是同一段英文需求，这次拿回一份
   *   全中文的 PRD、下次拿回全英文的 —— 模型每次自己挑。同一个项目里
   *   于是躺着两种语言的需求文档，而界面上没有任何设置左右得了它。
   *
   *   缺省时按 'en'：英文是这个产品的默认语言（见 i18n/locale.ts），
   *   而「不确定就沉默」在这里等于把选择权交还给模型 —— 那正是要治的病。
   *
   * The brief said nothing about language, so the model picked one per call.
   */
  locale?: 'en' | 'zh';
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
  /** null = 运行时不上报成本（不是「没花」） */
  cost: number | null;
  model: string;
  /**
   * 非 null = 这份结果是规则占位，不是 Agent 产出。见 PlanFallback。
   *
   * ★ 与 `model` 里那句中文并存：界面读码决定怎么渲染，日志读句子。
   */
  fallback?: PlanFallback | null;
}

export interface PlanTaskDraft {
  /** 计划内的临时 ID，用于表达依赖 */
  ref: string;
  title: string;
  description: string;
  type: WorkItemType;
  phase: string;
  estimatedHours: number;
  estimatedTokens: number | null;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  requiredSkills: string[];
  /**
   * 这个任务需要的**语义能力**（跨运行时）。调度器按它筛候选。
   * Semantic capabilities this task needs — runtime independent.
   */
  requiredCapabilities: AgentCapability[];
  /** @deprecated 运行时工具名，只为读存量计划保留 / legacy runtime tool names, read-only */
  requiredTools: string[];
  /** 计划阶段就标记出必须由人做的任务 */
  requiresHuman: boolean;
  /** ★ 严格枚举而不是 string：拼错的值必须在解析那一步就被拒收 */
  operationType?: OperationType;
  environment?: Environment;
  /** 规划阶段标出来的数据敏感级与「是否对外」—— 此前这两项没有生产者 */
  dataSensitivity?: DataSensitivity;
  externalFacing?: boolean;
  acceptanceCriteria: AcceptanceCriterion[];
  dependsOn: { ref: string; type: DependencyType }[];
}

export interface GeneratedPlan {
  tasks: PlanTaskDraft[];
  milestones: { name: string; taskRefs: string[]; dueOffsetDays: number }[];
  risks: { description: string; level: string; mitigation: string }[];
  /** null = 运行时不上报成本（不是「没花」） */
  cost: number | null;
  durationMs: number;
  model: string;
  /** 非 null = 这份计划是通用模板，与需求无关。见 PlanFallback */
  fallback?: PlanFallback | null;
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
