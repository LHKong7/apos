import { z } from 'zod';
import { ActorType } from '../common/actor';
import { RiskLevel } from '../common/enums';

/**
 * 产品文档 6.3：统一工作对象，13 种可配置类型。
 * Product doc 6.3: one unified work object with 13 configurable types.
 */
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

/**
 * 谁来执行这一项。
 *
 * ★★ 与 `approvalGate` 是**两件事**，此前被一个 `requiresHuman` 合并了。
 *
 *   「这活只能人来干」（executionMode）与「干完要不要人批」（approvalGate）
 *   在产品上正交：一个需要人写的文案不一定要审批，一次自动的生产发布
 *   几乎一定要审批。合成一个布尔之后，想表达「Agent 执行 + 人类审批」
 *   只能靠 Policy 绕，而计划页上那一栏会显示成「🤖 Agent」——
 *   看不出后面还有一道闸。
 *
 *   `auto` 表示不指定，交给调度器按能力匹配。
 *
 * Who executes this item — deliberately separate from whether the result
 * needs approval. Collapsing both into one boolean made "agent executes,
 * human approves" inexpressible.
 */
export const ExecutionMode = z.enum(['auto', 'agent', 'human']);
export type ExecutionMode = z.infer<typeof ExecutionMode>;

/**
 * 交付物要不要人批准，以及由谁批。
 *
 * ★ `none` 不等于「不安全」：安全底线与 Policy 仍然照跑，
 *   这一栏只表达计划**额外**要求的那道闸。
 */
export const ApprovalGate = z.enum(['none', 'reviewer', 'owner', 'tech_lead']);
export type ApprovalGate = z.infer<typeof ApprovalGate>;

/**
 * 项目 Agent 的角色绑定。
 *
 * ★ 绑的是已配置好的 Agent，不是运行时 —— 选 Claude Code 还是 Codex
 *   属于 Agent 配置那一层，到这里只回答「哪个 Agent 干这个角色」。
 */
export const ProjectAgentRole = z.enum(['planner', 'coordinator', 'reviewer']);
export type ProjectAgentRole = z.infer<typeof ProjectAgentRole>;

/**
 * 六阶段（产品文档五、8.4.1）。
 * The six stages (product doc part five, 8.4.1).
 */
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

/**
 * 状态的中文名，全站唯一一份。
 *
 * ★ 放在 contracts 而不是前端，是因为后端也要拼给人看的句子
 *   （比如决策卡片上的「不处理会怎样」）。各写一份的下场已经见过：
 *   决策类型的标签表就是这么和运行时的取值走散的。
 * ★ Record<WorkItemStatus, string> 会在新增状态时直接编译不过 —— 这是故意的。
 *
 * Chinese status names — one copy for the whole system.
 *
 * ★ They live in contracts rather than the frontend because the server also
 *   builds human-readable sentences (such as "what happens if you do nothing"
 *   on a decision card). We have already seen what separate copies cost: the
 *   decision-type label table drifted away from the runtime values exactly
 *   that way.
 * ★ `Record<WorkItemStatus, string>` fails to compile when a status is added,
 *   which is the point.
 */
export const STATUS_LABELS: Record<WorkItemStatus, string> = {
  draft: '草稿',
  clarifying: '澄清中',
  awaiting_requirement_approval: '待需求确认',
  planning: '规划中',
  awaiting_plan_approval: '待计划批准',
  ready: '待执行',
  executing: '执行中',
  blocked: '阻塞',
  failed: '失败',
  reviewing: '审核中',
  changes_requested: '需返工',
  awaiting_decision: '待决策',
  waiting_for_release: '等待发布',
  releasing: '发布中',
  released: '已发布',
  acceptance: '验收中',
  done: '已完成',
  cancelled: '已取消',
};

/**
 * 状态的英文名 / English status names.
 *
 * ★★ 与 STATUS_LABELS 同为 `Record<WorkItemStatus, string>`：新增状态时
 *   两张表都编译不过。少了这一条，英文表会悄悄漏掉新状态，而漏掉的表现
 *   是界面上冒出一个原始的下划线枚举值。
 *
 *   Both tables are `Record<WorkItemStatus, string>`, so adding a status
 *   breaks the build in both places. Without that, the English table would
 *   silently miss new statuses and leak a raw enum value into the UI.
 *
 * ★ 前端不直接读这两张表，它走 i18n 词条（lib/i18n 的 workItemStatus.*）——
 *   这里保留是给**服务端**拼人类可读的句子用的。
 */
export const STATUS_LABELS_EN: Record<WorkItemStatus, string> = {
  draft: 'Draft',
  clarifying: 'Clarifying',
  awaiting_requirement_approval: 'Awaiting requirement approval',
  planning: 'Planning',
  awaiting_plan_approval: 'Awaiting plan approval',
  ready: 'Ready',
  executing: 'Executing',
  blocked: 'Blocked',
  failed: 'Failed',
  reviewing: 'In review',
  changes_requested: 'Changes requested',
  awaiting_decision: 'Awaiting decision',
  waiting_for_release: 'Waiting for release',
  releasing: 'Releasing',
  released: 'Released',
  acceptance: 'Acceptance',
  done: 'Done',
  cancelled: 'Cancelled',
};

/**
 * status → stage 的映射。看板列由此决定。
 * The status → stage mapping; it decides which board column a card lands in.
 */
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
 *
 * Which board column a card belongs to.
 *
 * ★ `awaiting_decision` is not a stage but a cross-cutting state: a work item
 *   can be waiting on a human call before execution, after it, or before
 *   release. Filing it under the review column would make "waiting for
 *   approval to start" look like "finished and under review".
 *
 *   Page doc 05 §5.4: a Human Gate shows as a badge on the card rather than
 *   its own column, so the card stays in the stage it was actually heading to.
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

/**
 * 依赖类型（产品文档 8.6.2）。
 * Dependency types (product doc 8.6.2).
 */
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
