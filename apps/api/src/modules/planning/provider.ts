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
 * The LLM abstraction behind requirement structuring and plan generation /
 * 需求结构化与计划生成的 LLM 抽象。
 *
 * Pulling it into a provider serves two purposes:
 * 1. The whole chain stays testable with no API key at hand (StubProvider).
 * 2. Swapping models or vendors leaves the business logic untouched.
 */

/**
 * Who this planning run belongs to / 这次规划属于谁。
 *
 * ★ A provider backed by a real agent needs this to choose an executor: the
 *   candidates are **the agent members of this project** (membership is
 *   authorization, not preference). With no scope it can only fall back to the
 *   rule-based placeholder.
 *
 * ★ Optional rather than required: StubProvider never looks at it, and a pile of
 *   existing tests construct StructureInput directly — editing those tests for a
 *   field they do not use changes the tests instead of the thing under test. When
 *   it is missing, AgentProvider **falls back and says so**; it never degrades
 *   silently.
 *
 * ★ 走真实 Agent 的 provider 需要它来挑执行者：候选是这个项目的 Agent 成员
 *   （成员关系是授权，不是偏好），不给 scope 就只能退回规则占位。
 *
 * ★ 做成可选而不是必填：StubProvider 根本不看它，而一堆既有测试是直接构造
 *   StructureInput 的 —— 为了一个它们用不到的字段去改测试，改动的是测试而不是
 *   被测的东西。缺失时 AgentProvider 会如实回退并说明，不是静默降级。
 */
export interface PlanningScope {
  orgId: string;
  projectId: string;
  /**
   * Which requirement this analysis / planning run is for /
   * 这次分析、规划是给哪条需求做的。
   *
   * ★ Lands in agent_runs.requirement_id. Without it, planning runs are rows you can
   *   query but never navigate back to: nothing on the requirement page links to
   *   them.
   */
  requirementId?: string;
  /**
   * An agent the caller **named explicitly** (the PRD author picked on the
   * requirement page) / 调用方点名的 Agent。
   *
   * ★★ Once set it must be used: it wins over the project binding and is **never
   *   silently substituted**. If the named agent is unusable the attempt fails with
   *   a stated reason (still falling back to the rule-based placeholder, with the
   *   reason written into the model field). Running someone else instead hands the
   *   user output signed by an agent they did not pick while the UI looks entirely
   *   normal — planning quality changes overnight and nothing explains why.
   *
   * ★★ 给了它就必须用它，不再走项目绑定，也不许悄悄换一个 —— 点名的那个不可用时
   *   如实失败并说出原因（照旧回退到规则占位，原因写进 model 字段）。换一个来跑，
   *   用户看到的产出署着他没选的 Agent，而界面上一切正常：规划质量突然变了却
   *   查不到原因。
   */
  agentId?: string;
  /**
   * Which language the output must be written in / 产出该用哪种语言写。
   *
   * ★★ The brief used to say nothing at all about language, so the same English
   *   requirement came back as an all-Chinese PRD one run and an all-English one the
   *   next — the model picked per call. A single project ended up holding
   *   requirement documents in two languages, with no setting anywhere in the UI
   *   able to influence it.
   *
   *   Defaults to 'en': English is this product's default language (see
   *   i18n/locale.ts), and "stay silent when unsure" here just hands the choice back
   *   to the model — which is the exact disease being treated.
   *
   * ★★ brief 里此前一个字都没提语言，于是同一段英文需求，这次拿回一份全中文的 PRD、
   *   下次拿回全英文的 —— 模型每次自己挑。缺省按 'en'，因为「不确定就沉默」在这里
   *   等于把选择权交还给模型。
   */
  locale?: 'en' | 'zh';
}

export interface StructureInput {
  rawInput: string;
  projectType: string;
  /** Org and project context — existing knowledge, repository descriptions, and so on */
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
  /** What happens if it goes unanswered — quantified in schedule or scope terms */
  impact: string;
  /** The agent's leaning plus its basis. Asking without suggesting feels like being quizzed by the AI */
  agentSuggestion: string | null;
  suggestionBasis: string | null;
  options: string[];
  /**
   * The answer a human gave / 人给出的答案。
   *
   * ★★ This is what planning actually consumes. The type used to have no such field
   *   at all — so even when clarifications were passed down, the agent received a
   *   list of questions and every answer the user had typed was lost.
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
  /** Field → source-span provenance; powers the side-by-side highlighting on the requirement page */
  provenance: Record<string, { source: string; span?: [number, number] }>;
  /** null = the runtime does not report cost (which is not the same as "cost nothing") */
  cost: number | null;
  model: string;
  /**
   * Non-null = this result is the rule-based placeholder, not agent output. See
   * PlanFallback.
   *
   * ★ It coexists with the Chinese sentence in `model`: the UI reads the code to
   *   decide how to render, the logs read the sentence.
   */
  fallback?: PlanFallback | null;
}

export interface PlanTaskDraft {
  /** A temporary ID local to the plan, used only to express dependencies */
  ref: string;
  title: string;
  description: string;
  type: WorkItemType;
  phase: string;
  estimatedHours: number;
  estimatedTokens: number | null;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  /**
   * Semantic capabilities this task needs — runtime independent. The scheduler
   * filters candidates by them / 这个任务需要的语义能力（跨运行时）。
   */
  requiredCapabilities: AgentCapability[];
  /** @deprecated Legacy runtime tool names, kept read-only for existing plans / 运行时工具名，只为读存量计划保留 */
  requiredTools: string[];
  /** Marks, already at planning time, the tasks a human has to do */
  requiresHuman: boolean;
  /** ★ A strict enum rather than string: a misspelled value has to be rejected at parse time */
  operationType?: OperationType;
  environment?: Environment;
  /** Data sensitivity and external-facing flag, set during planning — neither had a producer before */
  dataSensitivity?: DataSensitivity;
  externalFacing?: boolean;
  acceptanceCriteria: AcceptanceCriterion[];
  dependsOn: { ref: string; type: DependencyType }[];
}

export interface GeneratedPlan {
  tasks: PlanTaskDraft[];
  milestones: { name: string; taskRefs: string[]; dueOffsetDays: number }[];
  risks: { description: string; level: string; mitigation: string }[];
  /** null = the runtime does not report cost (which is not the same as "cost nothing") */
  cost: number | null;
  durationMs: number;
  model: string;
  /** Non-null = this plan is a generic template unrelated to the requirement. See PlanFallback */
  fallback?: PlanFallback | null;
}

export interface PlanningProvider {
  readonly name: string;
  structureRequirement(input: StructureInput): Promise<StructuredRequirement>;
  /**
   * @param feedback What the user wrote when they asked for a revision.
   *
   * ★ This parameter did not exist before — the feedback was stored in
   *   plans.revisionFeedback and never handed to the planner. So a user who asked
   *   for changes got back a byte-identical v2, and nothing anywhere told them.
   *   The very first run after version comparison shipped showed it in the diff:
   *   "replanning produced a plan with identical content".
   */
  generatePlan(
    req: StructuredRequirement,
    projectType: string,
    feedback?: string,
    scope?: PlanningScope,
  ): Promise<GeneratedPlan>;
}
