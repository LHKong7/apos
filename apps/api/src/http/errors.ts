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
  /** 外部系统故障 —— 不是我们的 bug，也不是用户输错了 */
  | 'EXTERNAL_ERROR'
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
  // 502 而不是 500：请求走到了外部系统，是那一侧出的问题
  EXTERNAL_ERROR: 502,
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

/**
 * Postgres 的「这个值根本不是这个类型」类错误 → 400。
 *
 * ★ 路由参数与查询串是**客户端**给的。`/work-items/not-a-uuid`、
 *   `?risk=bogus` 这类输入会一路走到 SQL，由 Postgres 报 22P02 抛出来。
 *   不认这些码的话，错误处理器只能把它当未知异常吞成 500 ——
 *   于是调用方以为服务端挂了，而告警面板上多出一批假的服务端故障。
 *
 *   `X-User-Id` 这条路径当初已经被单独修过（见 routes.test.ts
 *   「格式非法的身份头返回 401 而不是 500」），但那只堵了身份头一个口子，
 *   路径参数和查询参数还是原样。这里统一在出口收掉。
 *
 * ★ 只认「值的文本形态不合法」这一类，不认约束冲突（23xxx）——
 *   那些是业务语义问题，各自的调用点有更准确的错误码可给。
 */
const CLIENT_INPUT_PG_CODES: Record<string, string> = {
  // uuid / 枚举 / 数字字面量解析失败，最常见的一类
  '22P02': '路径或查询参数的格式不合法',
  // 字符串超出字段长度
  '22001': '参数长度超出限制',
  // 数值超出范围
  '22003': '数值超出允许范围',
  // 日期时间格式不合法
  '22007': '时间格式不合法',
  '22008': '时间值超出范围',
};

/**
 * 把数据库层抛出的「客户端输入不合法」翻译成 ApiError；
 * 不属于这一类的返回 null，交给调用方按未知异常处理。
 */
export function asClientInputError(error: unknown): ApiError | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return null;
  const message = CLIENT_INPUT_PG_CODES[code];
  if (!message) return null;
  // ★ 不回传 Postgres 原始 message —— 里面有表名列名，是信息泄露。
  //   给调用方能自查的东西：错在哪一类、拿到的是什么码。
  return new ApiError('VALIDATION_FAILED', message, { pgCode: code });
}
