import type { FastifyReply } from 'fastify';

/** docs/tech/07-api-design.md §2 */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'INVALID_TRANSITION'
  | 'GUARD_FAILED'
  | 'POLICY_DENIED'
  | 'BUDGET_EXCEEDED'
  | 'UNANSWERED_MUST_CONFIRM'
  | 'AGENT_UNAVAILABLE'
  /** 运行时能力不足（降级矩阵）—— 不是故障，是这个运行时做不到 */
  | 'UNSUPPORTED_FEATURE'
  | 'RATE_LIMITED'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  INVALID_TRANSITION: 409,
  GUARD_FAILED: 409,
  POLICY_DENIED: 422,
  BUDGET_EXCEEDED: 422,
  UNANSWERED_MUST_CONFIRM: 422,
  AGENT_UNAVAILABLE: 503,
  // 501 而不是 4xx：请求本身没问题，是服务端这个运行时不具备该能力
  UNSUPPORTED_FEATURE: 501,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function sendError(reply: FastifyReply, error: ApiError) {
  return reply.status(STATUS[error.code]).send({
    error: {
      code: error.code,
      message: error.message,
      details: error.details ?? null,
      traceId: reply.request.id,
    },
  });
}

export function notFound(what: string) {
  return new ApiError('NOT_FOUND', `${what}不存在`);
}
