import { pgEnum } from 'drizzle-orm/pg-core';
import {
  ActorType,
  AutonomyLevel,
  DependencyType,
  Environment,
  RiskLevel,
  RunStatus,
  Stage,
  WorkItemStatus,
  WorkItemType,
} from '@apos/contracts';

/**
 * 数据库枚举直接由 contracts 的 Zod enum 生成 —— 单一真相来源。
 * 新增取值时改 contracts，迁移会自动带上。
 */

function values<T extends string>(list: readonly T[]): [T, ...T[]] {
  return list as unknown as [T, ...T[]];
}

export const actorTypeEnum = pgEnum('actor_type', values(ActorType.options));
export const riskLevelEnum = pgEnum('risk_level', values(RiskLevel.options));
export const autonomyLevelEnum = pgEnum('autonomy_level', values(AutonomyLevel.options));
export const environmentEnum = pgEnum('environment', values(Environment.options));
export const workItemTypeEnum = pgEnum('work_item_type', values(WorkItemType.options));
export const workItemStatusEnum = pgEnum('work_item_status', values(WorkItemStatus.options));
export const stageEnum = pgEnum('stage', values(Stage.options));
export const dependencyTypeEnum = pgEnum('dependency_type', values(DependencyType.options));
export const runStatusEnum = pgEnum('run_status', values(RunStatus.options));

export const projectStatusEnum = pgEnum('project_status', [
  'active',
  'paused',
  'completed',
  'archived',
]);

export const requirementStatusEnum = pgEnum('requirement_status', [
  'draft',
  'analyzing',
  'clarifying',
  'awaiting_approval',
  'approved',
  'rejected',
  'on_hold',
]);

export const clarificationLevelEnum = pgEnum('clarification_level', [
  'must_confirm',
  'default_applicable',
  'assumption_ok',
  'auto_resolved',
]);

export const decisionStatusEnum = pgEnum('decision_status', [
  'pending',
  'approved',
  'rejected',
  'revision_requested',
  'delegated',
  'taken_over',
  'expired',
  'cancelled',
]);
