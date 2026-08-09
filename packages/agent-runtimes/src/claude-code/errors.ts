import type { AgentError, ErrorClass } from '@apos/contracts';
import { classifyError } from '../adapter';

type ResultSubtype =
  | 'success'
  | 'error_during_execution'
  | 'error_max_turns'
  | 'error_max_budget_usd'
  | 'error_max_structured_output_retries';

/**
 * Run 结束态的错误分类。
 *
 * ★ 这些是运行时**上报**的判定，不是从错误文本猜的，
 *   所以 classificationSource='reported'。恢复策略（decideRecovery）
 *   对 reported 的分类可以直接采信；inferred 的要更早转人工。
 */
export function classifyResultError(input: {
  subtype: ResultSubtype;
  errors?: string[];
  permissionDenials?: { tool_name: string }[];
  maxCostUsd: number;
}): AgentError {
  const detail = (input.errors ?? []).join('\n').trim();

  switch (input.subtype) {
    case 'error_max_budget_usd':
      return {
        class: 'budget_exceeded',
        message: `执行成本触及上限 $${input.maxCostUsd}，运行时已主动停止`,
        retriable: false,
        selfReport: '任务未完成就用尽了预算。继续需要人类调高预算或缩小任务范围。',
        classificationSource: 'reported',
      };

    case 'error_max_turns':
      return {
        class: 'timeout',
        message: '达到最大轮次仍未完成',
        retriable: true,
        selfReport: '任务在允许的交互轮次内没做完，通常意味着任务粒度过大或缺少关键上下文。',
        classificationSource: 'reported',
      };

    case 'error_max_structured_output_retries':
      return {
        class: 'invalid_task',
        message: '多次尝试仍无法产出符合约定格式的结果',
        retriable: false,
        classificationSource: 'reported',
      };

    case 'error_during_execution':
    default: {
      // 有权限拒绝记录时，这是比文本匹配可靠得多的信号
      const denials = input.permissionDenials ?? [];
      if (denials.length > 0) {
        const tools = [...new Set(denials.map((d) => d.tool_name))].join('、');
        return {
          class: 'permission_denied',
          message: `执行过程中被拒绝使用工具：${tools}`,
          detail,
          retriable: false,
          selfReport: `任务需要 ${tools}，但当前授权不包含它。需要人类扩权后重试。`,
          classificationSource: 'reported',
        };
      }

      if (!detail) {
        return {
          class: 'runtime_error',
          message: '运行时未给出错误详情',
          retriable: true,
          classificationSource: 'reported',
        };
      }

      return {
        class: classifyError(detail),
        message: detail,
        retriable: true,
        classificationSource: 'inferred',
      };
    }
  }
}

type AssistantErrorCode =
  | 'authentication_failed'
  | 'oauth_org_not_allowed'
  | 'billing_error'
  | 'rate_limit'
  | 'overloaded'
  | 'invalid_request'
  | 'model_not_found'
  | 'server_error'
  | 'unknown'
  | 'max_output_tokens';

/** SDK 在 assistant 消息上直接给出的错误码 —— 全部按 reported 处理 */
const ASSISTANT_ERROR_CLASS: Record<AssistantErrorCode, ErrorClass> = {
  authentication_failed: 'permission_denied',
  oauth_org_not_allowed: 'permission_denied',
  billing_error: 'budget_exceeded',
  rate_limit: 'external_unavailable',
  overloaded: 'external_unavailable',
  server_error: 'external_unavailable',
  invalid_request: 'invalid_task',
  model_not_found: 'capability_mismatch',
  max_output_tokens: 'runtime_error',
  unknown: 'unknown',
};

const RETRIABLE_ASSISTANT_ERRORS: readonly AssistantErrorCode[] = [
  'rate_limit',
  'overloaded',
  'server_error',
  'max_output_tokens',
];

export function classifyAssistantError(code: string): AgentError {
  const known = (Object.keys(ASSISTANT_ERROR_CLASS) as AssistantErrorCode[]).includes(
    code as AssistantErrorCode,
  )
    ? (code as AssistantErrorCode)
    : null;

  if (!known) {
    return {
      class: classifyError(code),
      message: code,
      retriable: true,
      classificationSource: 'inferred',
    };
  }

  return {
    class: ASSISTANT_ERROR_CLASS[known],
    message: `模型调用失败：${known}`,
    retriable: (RETRIABLE_ASSISTANT_ERRORS as readonly string[]).includes(known),
    classificationSource: 'reported',
  };
}

/** 适配器自身抛出的异常（SDK 没装、子进程起不来、超时中止等） */
export function classifyThrown(err: unknown, opts: { aborted: boolean }): AgentError {
  if (opts.aborted) {
    return {
      class: 'timeout',
      message: '执行超时，已中止',
      retriable: true,
      classificationSource: 'reported',
    };
  }

  const message = err instanceof Error ? err.message : String(err);

  // 模块加载失败是部署问题，不是任务问题 —— 分错会让系统一直重试
  if (/Cannot find (module|package)|ERR_MODULE_NOT_FOUND/i.test(message)) {
    return {
      class: 'runtime_error',
      message: `Claude Agent SDK 不可用：${message}`,
      retriable: false,
      selfReport: '运行时依赖缺失，需要在部署环境安装 @anthropic-ai/claude-agent-sdk。',
      classificationSource: 'reported',
    };
  }

  return {
    class: classifyError(message),
    message,
    retriable: true,
    classificationSource: 'inferred',
  };
}
