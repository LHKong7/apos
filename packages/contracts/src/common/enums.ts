import { z } from 'zod';

export const RiskLevel = z.enum(['low', 'medium', 'high', 'critical']);
export type RiskLevel = z.infer<typeof RiskLevel>;

/**
 * 风险等级的序，用于比较（Policy 条件里的 gte/lte）。
 * Ordering for risk levels, used by the gte/lte comparisons in policy conditions.
 */
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
 *
 * Operation types. Product doc 10.4 lists nine that need extra governance;
 * three of those are fixed in docs/tech/09-security.md §9 as operations no
 * policy may ever wave through.
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

/**
 * 无论自治等级与项目规则如何，永远不允许自动放行。
 * Never auto-approved, whatever the autonomy level or the project's own rules
 * say. `packages/domain/src/policy/evaluate.test.ts` asserts this exhaustively
 * and blocks CI — if it goes red, the governance model has been bypassed.
 */
export const NEVER_AUTO_APPROVE: readonly OperationType[] = [
  'delete_resource',
  'permission_change',
  'payment',
] as const;

/**
 * 批准后撤不回来的操作。
 *
 * ★ 判据是「效果是否离开了我们的控制范围」，不是「有没有难度」：
 *   钱付出去了、信息发出去了、数据被人看过了、资源被删了 —— 这四类
 *   事后再怎么补救也回不到原状。
 *
 * ★ db_ddl / db_dml 不在其中：有备份就能还原，而「有没有备份」
 *   不是操作类型能回答的问题。宁可少标一个，也不要让「不可逆」
 *   贴到处都是 —— 一个到处都是的警示等于没有警示。
 *
 * 用途：决策卡片上的「不可逆」标记、批量批准的准入门槛。
 *
 * Operations that cannot be taken back once approved.
 *
 * ★ The test is whether the effect has left our control, not whether undoing
 *   it would be hard: money sent, information published, data someone has now
 *   seen, a resource deleted — no amount of remediation restores any of those.
 *
 * ★ db_ddl / db_dml are deliberately absent: a backup restores them, and
 *   "is there a backup" is not a question the operation type can answer.
 *   Better to under-mark than to stamp "irreversible" everywhere — a warning
 *   that appears everywhere is no warning at all.
 *
 * Used by: the "irreversible" marker on a decision card, and the entry bar for
 * bulk approval.
 */
export const IRREVERSIBLE_OPERATIONS: readonly OperationType[] = [
  'payment',
  'delete_resource',
  'send_external',
  'access_sensitive_data',
] as const;

/**
 * 产品文档 10.4 的九类高风险操作，默认需要额外治理。
 * The nine high-risk operations from product doc 10.4; governed extra by default.
 */
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
