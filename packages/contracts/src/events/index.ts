import { z } from 'zod';
import { ActorType } from '../common/actor';
import { PolicyContext } from '../policy/index';

export const SubjectType = z.enum([
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
]);
export type SubjectType = z.infer<typeof SubjectType>;

export const EventLevel = z.enum(['milestone', 'detail']);
export type EventLevel = z.infer<typeof EventLevel>;

/**
 * 领域事件 —— docs/tech/03-event-model.md
 *
 * 与 run_events 分层：领域事件是业务事实（单 Work Item 数十条），
 * run_events 是执行细节（单 Run 可达数千条）。Analytics 与审计只扫描前者。
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

  /** Policy 模拟回放所需。仅在会触发 Policy 评估的事件上记录。 */
  contextSnapshot: PolicyContext | null;

  /** 直接触发本事件的事件 —— 回答「为什么这样做」 */
  causationId: string | null;
  /** 同一业务流程的所有事件共享 */
  correlationId: string;

  occurredAt: string;
}

/** 事件类型目录 —— docs/tech/03-event-model.md §7。命名规范 {subject}.{过去式动词} */
export const DOMAIN_EVENT_TYPES = [
  // project
  'project.created',
  'project.autonomy_changed',
  'project.paused',
  'project.resumed',
  'project.budget_threshold_reached',
  'project.completed',
  // requirement
  'requirement.created',
  'requirement.analyzed',
  'requirement.clarification_answered',
  'requirement.field_edited',
  'requirement.approved',
  'requirement.rejected',
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
  correlationId: z.string(),
});
export type EventInput = z.infer<typeof EventInput>;
