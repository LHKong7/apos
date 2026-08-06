import { z } from 'zod';
import { ActorType } from '../common/actor';
import { RiskLevel } from '../common/enums';

/** 产品文档 6.3：统一工作对象，13 种可配置类型 */
export const WorkItemType = z.enum([
  'requirement',
  'feature',
  'story',
  'task',
  'bug',
  'research',
  'review',
  'test',
  'incident',
  'decision',
  'approval',
  'release',
  'knowledge',
]);
export type WorkItemType = z.infer<typeof WorkItemType>;

/** 六阶段（产品文档五、8.4.1） */
export const Stage = z.enum(['intake', 'planning', 'execution', 'review', 'release', 'done']);
export type Stage = z.infer<typeof Stage>;

export const WorkItemStatus = z.enum([
  // intake
  'draft',
  'clarifying',
  'awaiting_requirement_approval',
  // planning
  'planning',
  'awaiting_plan_approval',
  // execution
  'ready',
  'executing',
  'blocked',
  'failed',
  // review
  'reviewing',
  'changes_requested',
  'awaiting_decision',
  // release
  'waiting_for_release',
  'releasing',
  'released',
  // done
  'acceptance',
  'done',
  'cancelled',
]);
export type WorkItemStatus = z.infer<typeof WorkItemStatus>;

/** status → stage 的映射。看板列由此决定。 */
export const STATUS_STAGE: Record<WorkItemStatus, Stage> = {
  draft: 'intake',
  clarifying: 'intake',
  awaiting_requirement_approval: 'intake',

  planning: 'planning',
  awaiting_plan_approval: 'planning',

  ready: 'execution',
  executing: 'execution',
  blocked: 'execution',
  failed: 'execution',

  reviewing: 'review',
  changes_requested: 'review',
  awaiting_decision: 'review',

  waiting_for_release: 'release',
  releasing: 'release',
  released: 'release',

  acceptance: 'done',
  done: 'done',
  cancelled: 'done',
};

export const TERMINAL_STATUSES: readonly WorkItemStatus[] = ['done', 'cancelled'] as const;

/**
 * 看板列归属。
 *
 * ★ awaiting_decision 不是一个「阶段」，而是一个横切状态：任务可能在
 *   执行前、执行后、发布前的任意时刻等待人类拍板。直接把它归到 review 列
 *   会让「等待执行前审批」的任务看起来像「已经做完了在审核」。
 *
 *   页面文档 05 §5.4：Human Gate 通过卡片徽标体现，不展开为独立看板列。
 *   因此这里让卡片留在它本来要去的阶段。
 */
export function stageFor(
  status: WorkItemStatus,
  previousStatus?: WorkItemStatus | null,
): Stage {
  if (status === 'awaiting_decision' && previousStatus) {
    return STATUS_STAGE[previousStatus];
  }
  return STATUS_STAGE[status];
}

/** 依赖类型（产品文档 8.6.2） */
export const DependencyType = z.enum([
  'finish_to_start',
  'start_to_start',
  'artifact',
  'decision',
  'permission',
  'external',
  'data',
]);
export type DependencyType = z.infer<typeof DependencyType>;

/** Human Gate 状态（产品文档 8.4.3，页面文档通用组件 §5.1） */
export const HumanGate = z.enum([
  'approval_required',
  'waiting_for_decision',
  'human_reviewing',
  'human_took_over',
  'approved',
  'rejected',
  'escalated',
  'decision_overdue',
]);
export type HumanGate = z.infer<typeof HumanGate>;

/** decision_overdue 优先级最高，覆盖其他状态显示 */
export const HUMAN_GATE_PRIORITY: Record<HumanGate, number> = {
  decision_overdue: 100,
  escalated: 90,
  approval_required: 80,
  waiting_for_decision: 70,
  human_took_over: 60,
  human_reviewing: 50,
  rejected: 40,
  approved: 30,
};

/**
 * 验收标准。必须结构化——它是 Review 阶段自动校验的依据（产品文档 8.10.1），
 * 自由文本无法被系统验证。
 */
export const AcceptanceCriterion = z.object({
  id: z.string(),
  text: z.string(),
  verification: z.enum(['auto', 'agent', 'human']),
  status: z.enum(['pending', 'passed', 'failed']).default('pending'),
  evidenceRef: z.string().nullable().default(null),
  verifiedAt: z.string().datetime().nullable().default(null),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;

/**
 * 人类附加的执行约束，来自 Decision 的 Approve with Constraints。
 * enforcement 决定它能否被系统自动校验（docs/product/pages/11 §9）。
 */
export const ExecutionConstraint = z.object({
  type: z.enum([
    'time_window',
    'threshold_abort',
    'scope_limit',
    'approval_checkpoint',
    'notification_required',
    'freeform',
  ]),
  value: z.unknown(),
  /** 给 Agent 读的自然语言版本 */
  description: z.string(),
  enforcement: z.enum(['system', 'agent', 'manual']),
  decisionId: z.string().uuid().nullable().default(null),
});
export type ExecutionConstraint = z.infer<typeof ExecutionConstraint>;

export const WorkItem = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  projectId: z.string().uuid(),
  requirementId: z.string().uuid().nullable(),
  planId: z.string().uuid().nullable(),

  type: WorkItemType,
  status: WorkItemStatus,
  stage: Stage,
  title: z.string().min(1),
  description: z.string().nullable(),
  priority: z.number().int().min(0).max(3),
  riskLevel: RiskLevel,

  parentId: z.string().uuid().nullable(),
  path: z.string().nullable(),
  position: z.number().int(),

  /** 人类负责人（问责），与执行主体分离 */
  ownerId: z.string().uuid().nullable(),
  executorType: ActorType.nullable(),
  executorId: z.string().uuid().nullable(),

  plannedStart: z.string().datetime().nullable(),
  plannedEnd: z.string().datetime().nullable(),
  actualStart: z.string().datetime().nullable(),
  actualEnd: z.string().datetime().nullable(),
  estimatedHours: z.number().nullable(),

  estimatedCost: z.string().nullable(),
  actualCost: z.string(),

  acceptanceCriteria: z.array(AcceptanceCriterion),
  constraints: z.array(ExecutionConstraint),

  humanGate: HumanGate.nullable(),
  humanGateRef: z.string().uuid().nullable(),

  blockedSince: z.string().datetime().nullable(),
  blockedReason: z.string().nullable(),

  typeData: z.record(z.unknown()),
  externalRefs: z.array(
    z.object({ system: z.string(), key: z.string(), url: z.string().nullable() }),
  ),

  version: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WorkItem = z.infer<typeof WorkItem>;
