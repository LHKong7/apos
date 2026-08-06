import { z } from 'zod';

export const RiskLevel = z.enum(['low', 'medium', 'high', 'critical']);
export type RiskLevel = z.infer<typeof RiskLevel>;

/** 风险等级的序，用于比较（Policy 条件里的 gte/lte） */
export const RISK_ORDER: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export const AutonomyLevel = z.enum(['human_led', 'agent_led_approval', 'agent_autonomous']);
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;

export const Environment = z.enum(['dev', 'test', 'staging', 'production']);
export type Environment = z.infer<typeof Environment>;

export const DataSensitivity = z.enum(['public', 'internal', 'confidential', 'restricted']);
export type DataSensitivity = z.infer<typeof DataSensitivity>;

export const CheckResult = z.enum(['passed', 'failed', 'not_run']);
export type CheckResult = z.infer<typeof CheckResult>;

export const ReviewResult = z.enum(['passed', 'concerns', 'failed', 'not_run']);
export type ReviewResult = z.infer<typeof ReviewResult>;

/**
 * 高风险操作类型。产品文档 10.4 列出九类需要额外治理的操作。
 * 其中三类在 docs/tech/09-security.md §9 被定为「不可被 Policy 放行」。
 */
export const OperationType = z.enum([
  'read',
  'code_change',
  'db_ddl',
  'db_dml',
  'deploy',
  'delete_resource',
  'permission_change',
  'access_sensitive_data',
  'send_external',
  'payment',
  'security_policy_change',
  'high_cost_resource',
]);
export type OperationType = z.infer<typeof OperationType>;

/** 无论自治等级与项目规则如何，永远不允许自动放行 */
export const NEVER_AUTO_APPROVE: readonly OperationType[] = [
  'delete_resource',
  'permission_change',
  'payment',
] as const;

/** 产品文档 10.4 的九类高风险操作，默认需要额外治理 */
export const HIGH_RISK_OPERATIONS: readonly OperationType[] = [
  'db_ddl',
  'db_dml',
  'delete_resource',
  'permission_change',
  'access_sensitive_data',
  'send_external',
  'payment',
  'deploy',
  'security_policy_change',
] as const;
