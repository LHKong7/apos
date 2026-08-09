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
 */
export const PolicyContext = z.object({
  // 对象属性
  projectType: z.string(),
  workItemType: WorkItemType,
  riskLevel: RiskLevel,
  reversible: z.boolean(),
  externalFacing: z.boolean(),

  // 环境与数据
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

  // 成本
  runCost: z.number().min(0),
  projectCostSpent: z.number().min(0),
  projectBudget: z.number().min(0).nullable(),
  /** 派生 fact：由上下文构建器计算，规则编写者不用自己算 */
  budgetUsedPct: z.number().min(0).nullable(),

  // 质量
  testsResult: CheckResult,
  testCoverage: z.number().min(0).max(100).nullable(),
  securityScan: CheckResult,
  agentReview: ReviewResult,

  // 项目治理
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
  /** 按组织角色，如 dba / security_lead —— 人员变动时规则不用改 */
  z.object({ kind: z.literal('role'), role: z.string() }),
  z.object({ kind: z.literal('user'), userId: z.string().uuid() }),
  z.object({
    kind: z.literal('project_role'),
    role: z.enum(['pm', 'tech_lead', 'sponsor']),
  }),
  z.object({ kind: z.literal('owner_of'), subject: z.enum(['work_item', 'agent']) }),
]);
export type Recipient = z.infer<typeof Recipient>;

/** 产品文档 8.9.2 的十种动作 */
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
 * 动作的严格程度序，用于「项目规则只能收紧不能放宽」的静态检查
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

/** 这些动作意味着「不需要人类介入即可继续」 */
export const AUTO_APPROVE_ACTIONS: readonly ActionType[] = ['allow', 'allow_and_notify'] as const;

export const Policy = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  /** null = 组织级规则，项目不可删除、不可放宽 */
  projectId: z.string().uuid().nullable(),
  name: z.string().min(1),
  description: z.string().default(''),
  /** 越小越先评估。组织级 1–99，项目级 100+ */
  priority: z.number().int().min(1),
  enabled: z.boolean(),
  condition: Condition,
  action: Action,
});
export type Policy = z.infer<typeof Policy>;

export const ORG_PRIORITY_MAX = 99;
export const PROJECT_PRIORITY_MIN = 100;

export interface TraceEntry {
  policyId: string;
  name: string;
  matched: boolean;
  /** 未命中时记录第一个失败的叶子条件，供 UI 说明「为什么没走这条」 */
  failedAt: { fact: FactKey; op: Operator; expected: unknown; actual: unknown } | null;
}

export interface PolicyVerdict {
  action: Action;
  matchedPolicyId: string | null;
  matchedPolicyName: string | null;
  trace: TraceEntry[];
  /** 是否需要人类介入才能继续 */
  requiresHuman: boolean;
  /** 写入事件，供后续模拟回放 */
  contextSnapshot: PolicyContext;
}
