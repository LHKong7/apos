import { z } from 'zod';
import { ActorType } from '../common/actor';
import { PolicyContext } from '../policy/index';

export const SubjectType = z.enum([
  /**
   * 组织 —— 一切数据的顶层容器（Plane 里叫 Workspace，这里不用那个词，见 db schema）。
   * The organisation: top-level container for everything. Plane calls this a
   * Workspace; we deliberately do not — see the db schema.
   */
  'organization',
  'project',
  'requirement',
  'plan',
  'work_item',
  'agent',
  'agent_run',
  'decision',
  'artifact',
  'policy',
  'integration',
  /**
   * 身份与授权的变更以「被改的那个人」为主体（docs/tech/09-security.md §6.3）。
   * Identity and authorisation changes take the person being changed as the
   * subject (docs/tech/09-security.md §6.3).
   */
  'user',
  /**
   * 角色定义的变更 —— 定义角色就是定义权限本身。
   * Role definition changes: defining a role *is* defining the permissions.
   */
  'role',
]);
export type SubjectType = z.infer<typeof SubjectType>;

export const EventLevel = z.enum(['milestone', 'detail']);
export type EventLevel = z.infer<typeof EventLevel>;

/**
 * 领域事件 —— docs/tech/03-event-model.md
 *
 * 与 run_events 分层：领域事件是业务事实（单 Work Item 数十条），
 * run_events 是执行细节（单 Run 可达数千条）。Analytics 与审计只扫描前者。
 *
 * Domain events — docs/tech/03-event-model.md
 *
 * Layered apart from run_events: a domain event is a business fact (tens per
 * work item), while a run_event is execution detail (thousands per run).
 * Analytics and the audit trail read only the former.
 */
export interface DomainEvent {
  id: string;
  orgId: string;
  projectId: string | null;

  type: DomainEventType;
  level: EventLevel;

  actorType: ActorType;
  actorId: string | null;

  subjectType: SubjectType;
  subjectId: string;

  payload: Record<string, unknown>;

  /**
   * Policy 模拟回放所需。仅在会触发 Policy 评估的事件上记录。
   * What policy simulation replays from. Recorded only on events that trigger
   * a policy evaluation — and it cannot be filled in afterwards.
   */
  contextSnapshot: PolicyContext | null;

  /**
   * 直接触发本事件的事件 —— 回答「为什么这样做」。
   * The event that directly caused this one — it answers "why did this happen".
   */
  causationId: string | null;
  /**
   * 同一业务流程的所有事件共享。
   * Shared by every event in one business flow.
   */
  correlationId: string;

  occurredAt: string;
}

/**
 * 事件类型目录 —— docs/tech/03-event-model.md §7。命名规范 {subject}.{过去式动词}
 * The event type catalogue — docs/tech/03-event-model.md §7.
 * Naming convention: {subject}.{past-tense verb}
 */
export const DOMAIN_EVENT_TYPES = [
  /**
   * organization —— 顶层容器的生命周期与归属变更。
   *
   * ★ 归属变更必须记审计：「谁把谁加进了哪个组织」是提权路径的第一步，
   *   查不到它，跨租户的权限累积就无从追溯。
   *
   * organization — lifecycle and membership changes of the top-level container.
   *
   * ★ Membership changes must be audited: "who added whom to which
   *   organisation" is the first step of a privilege-escalation path, and
   *   without it cross-tenant accumulation of permissions cannot be traced.
   */
  'organization.created',
  'organization.updated',
  'organization.deleted',
  'organization.member_added',
  'organization.member_removed',
  'organization.member_role_changed',
  // project
  'project.created',
  'project.autonomy_changed',
  'project.paused',
  'project.resumed',
  'project.budget_threshold_reached',
  'project.completed',
  /**
   * 授权变更（09-security §6.3 强制记审计）。
   * Authorisation changes — auditing is mandatory per 09-security §6.3.
   */
  'project.member_added',
  'project.member_role_changed',
  'project.member_removed',
  /**
   * 项目 Agent 角色绑定变更。
   *
   * ★ 与成员变更同档记审计：换掉规划 Agent 会改变此后**所有**计划的产出，
   *   而它在界面上只是一个下拉框 —— 查不到「谁什么时候换的」，
   *   计划质量突然变差就无从追溯。
   */
  'project.agent_bound',
  // requirement
  'requirement.created',
  'requirement.analyzed',
  'requirement.clarification_answered',
  'requirement.field_edited',
  'requirement.approved',
  'requirement.rejected',
  /**
   * ★ 实体已经不在了，这条事件是它存在过的唯一痕迹 ——
   *   payload 因此要带标题与原文摘要，只留 subjectId 等于什么都没留。
   *
   * ★ The entity is gone, so this event is the only trace it ever existed.
   *   The payload therefore carries the title and a snippet of the original
   *   text; keeping only a subjectId keeps nothing.
   */
  'requirement.deleted',
  'requirement.assumption_invalidated',
  // plan
  'plan.generated',
  'plan.item_modified',
  'plan.approved',
  'plan.revision_requested',
  'plan.superseded',
  // work item
  'work_item.created',
  'work_item.status_changed',
  'work_item.assigned',
  /**
   * ★ 与 assigned 分开：这一条表示「换了执行者」，不表示「开始执行」。
   *   合成一条的话，审计里分不清「PM 把卡挂到某人名下」和「Agent 开跑了」——
   *   而后者才是花钱和改文件的那一刻。
   */
  'work_item.assignee_changed',
  'work_item.blocked',
  'work_item.unblocked',
  'work_item.taken_over',
  'work_item.handed_back',
  'work_item.acceptance_updated',
  'work_item.force_passed',
  'work_item.dependency_added',
  'work_item.dependency_removed',
  'work_item.split',
  'work_item.merged',
  /**
   * 恢复策略被 recovery-worker 执行（自动重试 / 改派 / 转人工 / 升级为决策）。
   * The recovery worker applied a strategy (auto retry / reassign / hand to a
   * person / escalate into a decision).
   */
  'work_item.recovery_applied',
  /**
   * 质量门禁自动核验的结果（reviewing 阶段）。
   * Result of the automated quality gate, during the reviewing stage.
   */
  'work_item.quality_checked',
  // agent run
  'agent_run.dispatched',
  'agent_run.started',
  'agent_run.completed',
  'agent_run.failed',
  'agent_run.timeout',
  'agent_run.terminated',
  'agent_run.heartbeat_lost',
  'agent_run.constraint_added',
  'agent_run.cost_threshold_reached',
  // decision
  'decision.created',
  'decision.approved',
  'decision.rejected',
  'decision.revision_requested',
  'decision.delegated',
  'decision.escalated',
  'decision.reminded',
  'decision.expired',
  'decision.outcome_recorded',
  // policy
  'policy.evaluated',
  'policy.created',
  'policy.updated',
  'policy.disabled',
  // agent
  'agent.registered',
  'agent.permissions_changed',
  'agent.permission_violation',
  'agent.paused',
  // 身份与角色
  /**
   * ★ 建账号是提权路径的**第零步**：在此之前那个人还不存在。
   *   「谁给谁开的号」查不到的话，提权链条从一开始就断了。
   */
  'user.created',
  'user.password_changed',
  'user.org_role_changed',
  'role.created',
  'role.updated',
  'role.deleted',
  // artifact & integration
  'artifact.produced',
  'integration.connected',
  'integration.disconnected',
  'integration.synced',
  'integration.conflict_detected',
  'integration.conflict_resolved',
  'integration.error',
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

/** 这些事件必须携带 payload.reason —— 人类覆盖系统判断时必须留痕 */
export const REASON_REQUIRED_EVENTS: readonly DomainEventType[] = [
  'work_item.taken_over',
  'work_item.force_passed',
  'decision.rejected',
  'policy.disabled',
  'project.paused',
  'agent.paused',
  'agent_run.terminated',
] as const;

/** 除 level=milestone 外，这些事件也必须进审计视图 */
export const AUDIT_EVENTS: readonly DomainEventType[] = [
  'policy.evaluated',
  'policy.created',
  'policy.updated',
  'policy.disabled',
  'agent.permissions_changed',
  'agent.permission_violation',
  'work_item.force_passed',
  'project.autonomy_changed',
  /**
   * ★ 授权变更必须可审计（§6.3）。
   *
   *   §7 把「权限累积」列为本产品的特有威胁：逐次小幅放宽，
   *   最终权限过大。它的缓解手段第一条就是「权限变更全审计」——
   *   没有这几条事件，谁在什么时候把谁提成 tech_lead 就查不到，
   *   而那恰恰是提权路径上最关键的一步。
   */
  'project.member_added',
  'project.member_role_changed',
  'project.member_removed',
  'project.agent_bound',
  'user.created',
  'user.password_changed',
  'user.org_role_changed',
  /**
   * ★ 角色定义的变更比成员变更更要紧：改一次角色，所有担任它的人的权限
   *   一起变。「谁给研发这个角色加上了放宽规则的权限」查不到的话，
   *   逐个人查授权记录也拼不出真相 —— 每个人的记录都会显示「他一直是研发」。
   */
  'role.created',
  'role.updated',
  'role.deleted',
] as const;

export const EventInput = z.object({
  type: z.enum(DOMAIN_EVENT_TYPES),
  level: EventLevel.default('milestone'),
  orgId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  actorType: ActorType,
  actorId: z.string().uuid().nullable(),
  subjectType: SubjectType,
  subjectId: z.string().uuid(),
  payload: z.record(z.unknown()).default({}),
  contextSnapshot: PolicyContext.nullable().default(null),
  causationId: z.string().nullable().default(null),
  // ★ uuid 而不是 string：events.correlation_id 就是 uuid 列。
  //   这里当初漏了 .uuid()，而 TS 那侧的类型只是 string —— 于是拼一个
  //   描述性字符串进去编译期毫无反应，只在插库那一刻炸（见 auth/bootstrap.ts）
  correlationId: z.string().uuid(),
});
export type EventInput = z.infer<typeof EventInput>;
