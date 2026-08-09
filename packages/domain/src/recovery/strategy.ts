import type { ErrorClass } from '@apos/contracts';

/**
 * 恢复策略 —— docs/tech/04-flow-engine.md §6
 *
 * 关键设计：不同错误类型的恢复策略必须不同。无差别重试三次是最糟的实现 ——
 * permission_denied 重试 100 次也不会成功，只是烧钱。
 */

export const RECOVERY_ACTIONS = [
  'retry',
  'retry_with_context',
  'switch_agent',
  'downgrade_model',
  'split_task',
  'request_decision',
  'transfer_to_human',
  'pause_and_escalate',
  'terminate',
] as const;

export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];

export interface RecoveryInput {
  errorClass: ErrorClass;
  /** 已尝试次数（含本次失败） */
  attempt: number;
  maxAttempts: number;
  hasAlternativeAgent: boolean;
  /** 累计成本 / 预估成本 */
  costRatio: number;
  consecutiveFailures: number;
}

export interface RecoveryDecision {
  action: RecoveryAction;
  reason: string;
  /** 需要人类介入的动作，附上决策类型 */
  decisionType?: string;
}

/** 成本护栏：已花到预估的 3 倍就不再自动重试 */
const COST_RATIO_LIMIT = 3;

export function decideRecovery(input: RecoveryInput): RecoveryDecision {
  const { errorClass, attempt, maxAttempts, hasAlternativeAgent, costRatio, consecutiveFailures } =
    input;

  // 连续失败 3 次一律暂停升级（产品文档 8.9.3）
  if (consecutiveFailures >= 3) {
    return {
      action: 'pause_and_escalate',
      reason: `连续失败 ${consecutiveFailures} 次，暂停并请技术负责人处理`,
      decisionType: 'agent_failure',
    };
  }

  // 成本护栏优先于错误分类
  if (costRatio >= COST_RATIO_LIMIT) {
    return {
      action: 'request_decision',
      reason: `已消耗预估成本的 ${costRatio.toFixed(1)} 倍，不再自动重试`,
      decisionType: 'cost_overrun_on_retry',
    };
  }

  switch (errorClass) {
    case 'context_insufficient':
      return attempt === 1
        ? {
            action: 'retry_with_context',
            reason: '上下文不足，自动补充相关知识与上次失败信息后重试',
          }
        : {
            action: 'request_decision',
            reason: '补充上下文后仍失败，需要人类提供缺失信息',
            decisionType: 'context_needed',
          };

    case 'capability_mismatch':
      return hasAlternativeAgent
        ? { action: 'switch_agent', reason: '任务超出当前 Agent 能力，改派更匹配的 Agent' }
        : {
            action: 'transfer_to_human',
            reason: '任务超出 Agent 能力且无可用替代，转人工执行',
          };

    case 'tool_failure':
    case 'external_unavailable':
      return attempt < maxAttempts
        ? { action: 'retry', reason: `外部依赖异常，退避后重试（第 ${attempt + 1} 次）` }
        : {
            action: 'request_decision',
            reason: '外部依赖持续不可用，需要人工确认',
            decisionType: 'external_blocker',
          };

    case 'timeout':
      return attempt === 1
        ? { action: 'split_task', reason: '执行超时，尝试拆分为更小的任务' }
        : { action: 'transfer_to_human', reason: '拆分后仍超时，转人工执行' };

    // 重试无用的两类：立即找人
    case 'permission_denied':
      return {
        action: 'request_decision',
        reason: 'Agent 权限不足，重试无效，需要人类决定是否扩大权限',
        decisionType: 'permission_request',
      };

    case 'budget_exceeded':
      return {
        action: 'request_decision',
        reason: '成本超出限额，需要 Sponsor 决定是否追加预算',
        decisionType: 'budget_overrun',
      };

    case 'invalid_task':
      return {
        action: 'request_decision',
        reason: '任务描述自相矛盾或不可执行，需要回到需求或计划澄清',
        decisionType: 'invalid_task',
      };

    case 'runtime_error':
      return attempt < maxAttempts
        ? { action: 'retry', reason: '运行时故障，重试' }
        : {
            action: 'switch_agent',
            reason: '运行时持续故障，改派其他 Agent',
          };

    case 'unknown':
      return attempt < maxAttempts
        ? { action: 'retry', reason: '未知错误，保守重试一次' }
        : {
            action: 'request_decision',
            reason: '未知错误且重试无效，需要人工排查',
            decisionType: 'agent_failure',
          };
  }
}
