import { z } from 'zod';
import {
  AutonomyLevel,
  CheckResult,
  DataSensitivity,
  Environment,
  OperationType,
  ReviewResult,
  RiskLevel,
} from '../common/enums';
import { WorkItemType } from '../work-item/index';

/**
 * Fact 清单 —— docs/tech/05-policy-engine.md §2.3
 *
 * ⚠ 这份清单同时是事件上下文快照的设计依据（docs/tech/03-event-model.md §4）。
 * 新增 fact 会导致该 fact 之前的历史数据无法模拟回放，因此首版尽量覆盖全。
 *
 * The fact list — docs/tech/05-policy-engine.md §2.3
 *
 * ⚠ This same list defines the shape of the event context snapshot
 * (docs/tech/03-event-model.md §4). Adding a fact makes history recorded
 * before it unreplayable in simulation, which is why the first version tries
 * to be exhaustive.
 */
export const PolicyContext = z.object({
  // 对象属性 / Properties of the thing being acted on
  projectType: z.string(),
  workItemType: WorkItemType,
  riskLevel: RiskLevel,
  reversible: z.boolean(),
  externalFacing: z.boolean(),

  // 环境与数据 / Environment and data
  environment: Environment.nullable(),
  dataSensitivity: DataSensitivity.nullable(),
  impactTaskCount: z.number().int().min(0),
  impactServices: z.array(z.string()),
  operationType: OperationType,

  // Agent
  agentType: z.string().nullable(),
  agentConfidence: z.number().min(0).max(1).nullable(),
  agentSuccessRate: z.number().min(0).max(1).nullable(),
  consecutiveFailures: z.number().int().min(0),

  // 成本 / Cost
  runTokens: z.number().min(0),
  projectTokensSpent: z.number().min(0),
  projectTokenBudget: z.number().min(0).nullable(),
  /**
   * 派生 fact：由上下文构建器计算，规则编写者不用自己算。
   * A derived fact, computed by the context builder so rule authors do not
   * have to work it out themselves.
   */
  budgetUsedPct: z.number().min(0).nullable(),

  // 质量 / Quality
  testsResult: CheckResult,
  testCoverage: z.number().min(0).max(100).nullable(),
  securityScan: CheckResult,
  agentReview: ReviewResult,

  // 项目治理 / Project governance
  autonomyLevel: AutonomyLevel,
});
export type PolicyContext = z.infer<typeof PolicyContext>;

export const FACT_KEYS = Object.keys(PolicyContext.shape) as (keyof PolicyContext)[];
export type FactKey = keyof PolicyContext;

export const Operator = z.enum([
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'not_in',
  'contains',
]);
export type Operator = z.infer<typeof Operator>;

/**
 * 条件的比较值。限定为 JSON 标量与标量数组 —— 规则里比较的永远是这些，
 * 用 `unknown` 既不精确，也会让 Zod 把 value 推断成可选字段。
 *
 * The value a condition compares against. Restricted to JSON scalars and
 * arrays of scalars, because that is all a rule ever compares; `unknown` would
 * be both imprecise and would make Zod infer `value` as optional.
 */
export const FactValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string(), z.number()])),
]);
export type FactValue = z.infer<typeof FactValue>;

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { fact: FactKey; op: Operator; value: FactValue };

export const Condition: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(Condition) }),
    z.object({ any: z.array(Condition) }),
    z.object({ not: Condition }),
    z.object({
      fact: z.enum(FACT_KEYS as [FactKey, ...FactKey[]]),
      op: Operator,
      value: FactValue,
    }),
  ]),
);

export const Recipient = z.union([
  /**
   * 按组织角色，如 dba / security_lead —— 人员变动时规则不用改。
   * By organization role, e.g. dba / security_lead — the rule survives people
   * joining and leaving.
   */
  z.object({ kind: z.literal('role'), role: z.string() }),
  z.object({ kind: z.literal('user'), userId: z.string().uuid() }),
  /**
   * 按项目角色。
   *
   * ★ 取值是**角色 key**，不限于内置的几个 —— 组织自定义的角色
   *   （研发 / 运营 / 测试…）同样可以是审批人和通知目标。
   *   写死枚举的话，一个组织新建了「安全」角色，却没法把
   *   「安全策略变更找安全」这条规则写出来，自定义角色就只是个标签。
   *
   * By project role.
   *
   * ★ The value is a **role key**, not limited to the built-in ones: a
   *   custom organization role (engineering, ops, QA…) can equally be an
   *   approver or a notification target. Hard-coding the enum would mean an
   *   organization that created a "security" role could not write the rule
   *   "send security policy changes to security" — leaving the custom role as
   *   nothing but a label.
   */
  z.object({
    kind: z.literal('project_role'),
    role: z.string().min(1),
  }),
  z.object({ kind: z.literal('owner_of'), subject: z.enum(['work_item', 'agent']) }),
]);
export type Recipient = z.infer<typeof Recipient>;

/**
 * 产品文档 8.9.2 的十种动作。
 * The ten actions from product doc 8.9.2.
 */
export const Action = z.union([
  z.object({ type: z.literal('allow') }),
  z.object({ type: z.literal('allow_and_notify'), notify: z.array(Recipient) }),
  z.object({ type: z.literal('require_agent_review'), agents: z.array(z.string()) }),
  z.object({
    type: z.literal('require_human_review'),
    assignee: Recipient,
    dueInHours: z.number().positive(),
  }),
  z.object({
    type: z.literal('require_multiple_approvals'),
    approvers: z.array(Recipient),
    mode: z.enum(['all', 'majority']),
    dueInHours: z.number().positive(),
  }),
  z.object({ type: z.literal('ask'), assignee: Recipient }),
  z.object({ type: z.literal('pause'), resumeCondition: z.string().nullable() }),
  z.object({ type: z.literal('deny'), message: z.string() }),
  z.object({ type: z.literal('escalate'), to: Recipient }),
  z.object({ type: z.literal('transfer_to_human'), assignee: Recipient }),
]);
export type Action = z.infer<typeof Action>;

export type ActionType = Action['type'];

/**
 * 动作的中文名，紧挨着定义放。
 *
 * ★ `Record<ActionType, string>` 会在新增动作时直接编译不过 —— 这是故意的。
 *   之前有过一次教训：决策类型的标签表按文档词汇另写了一份，
 *   而运行时发出的是另一套，界面上于是一直印着裸 key。
 *   凡是「新增枚举值时必须同步的映射」都该长在枚举旁边。
 *
 * Human-readable action names, kept right next to the definition.
 *
 * ★ `Record<ActionType, string>` fails to compile when an action is added,
 *   and that is deliberate. We learned this once already: the decision-type
 *   label table was written separately using the wording from the docs while
 *   the runtime emitted a different set, so the UI printed raw keys for a long
 *   time. Any mapping that must be updated when an enum grows belongs beside
 *   that enum.
 */
export const ACTION_LABELS: Record<ActionType, string> = {
  allow: '放行',
  allow_and_notify: '放行并通知',
  require_agent_review: '需 Agent 复核',
  require_human_review: '需人确认',
  require_multiple_approvals: '需多人会签',
  ask: '询问',
  pause: '暂停',
  deny: '拒绝',
  escalate: '升级',
  transfer_to_human: '转人工执行',
};

export function actionLabel(type: string): string {
  return ACTION_LABELS[type as ActionType] ?? type;
}

/**
 * 动作的严格程度序，用于「项目规则只能收紧不能放宽」的静态检查。
 * Strictness ordering, used by the static check that a project rule may only
 * tighten an organization rule, never loosen it.
 * （docs/tech/05-policy-engine.md §4.2）
 */
export const ACTION_STRICTNESS: Record<ActionType, number> = {
  allow: 0,
  allow_and_notify: 1,
  ask: 2,
  require_agent_review: 3,
  require_human_review: 4,
  transfer_to_human: 5,
  require_multiple_approvals: 6,
  escalate: 7,
  pause: 8,
  deny: 9,
};

/**
 * 这些动作意味着「不需要人类介入即可继续」。
 * These actions mean "carry on without a person".
 */
export const AUTO_APPROVE_ACTIONS: readonly ActionType[] = ['allow', 'allow_and_notify'] as const;

export const Policy = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  /**
   * null = 组织级规则，项目不可删除、不可放宽。
   * null means an organization rule: a project can neither delete nor loosen it.
   */
  projectId: z.string().uuid().nullable(),
  name: z.string().min(1),
  description: z.string().default(''),
  /**
   * 越小越先评估。组织级 1–99，项目级 100+。
   * Lower evaluates first. Organization rules use 1–99, project rules 100+.
   */
  priority: z.number().int().min(1),
  enabled: z.boolean(),
  condition: Condition,
  action: Action,
});
export type Policy = z.infer<typeof Policy>;

export const ORG_PRIORITY_MAX = 99;
export const PROJECT_PRIORITY_MIN = 100;

/**
 * 操作开关矩阵生成的规则占的那一格。
 *
 * ★★ 每个操作类型至多一条 —— 再切一次是**改这一条**，不是叠一条新的。
 *   叠加的话，「部署 → 自动 → 需人 → 自动」会留下三条规则，
 *   而「删掉那条规则即还原」这个承诺当场作废：用户不知道该删哪一条，
 *   也看不出哪一条还在生效。一行一条，行为才可预期、可回滚。
 *
 * ★ 它们排在手写项目规则**前面**（100 < 101+）：开关是用户刚刚做出的
 *   最新表态，被一条半年前写的规则默默盖掉是最难查的一类问题。
 *   互不冲突 —— 每条各锁一个 operationType，两条永远不会同时命中。
 *
 * The slot occupied by rules the operation switch matrix generates: at most one
 * per operation type, updated in place rather than stacked, so "delete that one
 * rule to undo" stays true. They sit ahead of hand-authored project rules
 * because a switch is the user's most recent statement of intent.
 */
export const OPERATION_SWITCH_PRIORITY = PROJECT_PRIORITY_MIN;

/** 手写项目规则从这里往上排（自动分配，见 http/policies.ts 的 nextAuthoredPriority） */
export const AUTHORED_PRIORITY_MIN = PROJECT_PRIORITY_MIN + 1;

export interface TraceEntry {
  policyId: string;
  name: string;
  matched: boolean;
  /**
   * 未命中时记录第一个失败的叶子条件，供 UI 说明「为什么没走这条」。
   * On a miss, records the first leaf condition that failed so the UI can say
   * why this rule was not the one.
   */
  failedAt: { fact: FactKey; op: Operator; expected: unknown; actual: unknown } | null;
}

export interface PolicyVerdict {
  action: Action;
  matchedPolicyId: string | null;
  matchedPolicyName: string | null;
  trace: TraceEntry[];
  /**
   * 是否需要人类介入才能继续。
   * Whether a person has to step in before this can continue.
   */
  requiresHuman: boolean;
  /**
   * 写入事件，供后续模拟回放。
   * Written into the event so simulation can replay it later.
   */
  contextSnapshot: PolicyContext;
}
