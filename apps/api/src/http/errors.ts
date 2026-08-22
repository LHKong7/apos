import type { FastifyReply } from 'fastify';
import type { ErrorReason, NotFoundEntity } from '@apos/contracts';

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
  /**
   * 请求本身没问题，但需要用户先明确确认一次才能继续。
   *
   * ★★ 与 VALIDATION_FAILED 分开：后者是「你发来的东西不对」，这个是
   *   「东西没问题，但我要你看一眼再点一次」。混用 400 的代价不在功能上——
   *   功能照常——而在**日志与监控**里：一条正常的人机交互和一次真正的
   *   客户端错误长得一模一样，于是 4xx 率再也不能当告警指标用。
   *
   * Well-formed but needs an explicit acknowledgment first. Kept apart from
   * VALIDATION_FAILED so a normal confirmation round-trip does not read as a
   * client error in the logs.
   */
  | 'CONFIRMATION_REQUIRED'
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
  // 409：请求合法，与当前状态冲突，确认之后重发即可
  CONFIRMATION_REQUIRED: 409,
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
    /**
     * 自由上下文。各调用点塞各自的东西（`{ path }`、校验 issue 列表、
     * 预算数字），前端按具体接口读。
     *
     * ★ 原因码**不**放这儿。`details.code` 早就被另一套约定占着
     *   （`UNASSIGNED_HUMAN_TASKS`，见 Plan/index.tsx），挤进来会撞车。
     */
    readonly details?: unknown,
    /**
     * 界面按它取词 / The UI reads this, not `message`.
     *
     * ★★ 可选是**过渡态**而不是设计：留空的那条报错，在英文界面上仍然
     *   是一句中文。新增报错一律走 `fail()` 把它填上。
     */
    readonly reason?: ErrorReason,
    /** 词条里 `{name}` 的实参。用户自己写的词原样带，不翻译 */
    readonly params?: Record<string, string | number>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * 带原因码地抛错 / Throw with a reason code.
 *
 * ★★ 参数顺序是 `code, reason, message` —— 码在前，句子在后。
 *
 *   反过来（句子在前）读起来更顺，但会让「先写句子、码回头再补」
 *   成为默认路径，而回头补的那一步从来不会发生。
 *   码在前，写的人必须先回答「这是哪一类错」，那正是界面需要的东西。
 *
 * ★ `message` 仍然是一句现成的中文：日志、告警、以及认不出码的老客户端
 *   都要它。界面读码，日志读句子。
 */
export function fail(
  code: ErrorCode,
  reason: ErrorReason,
  message: string,
  extra?: { params?: Record<string, string | number>; details?: unknown },
): ApiError {
  return new ApiError(code, message, extra?.details, reason, extra?.params);
}

export function sendError(reply: FastifyReply, error: ApiError) {
  return reply.status(STATUS[error.code]).send({
    error: {
      code: error.code,
      /**
       * ★ 原因码与句子**同时**给。界面优先读 reason 取词，认不出（服务端
       *   加了新码而前端还没跟上）时回落到 message —— 回落成空白的话，
       *   界面上少的正是那句解释「为什么不让我做」的话。
       */
      reason: error.reason ?? null,
      params: error.params ?? null,
      message: error.message,
      details: error.details ?? null,
      traceId: reply.request.id,
    },
  });
}

/**
 * 「找不到」的中文兜底句 / Chinese fallback prose per entity.
 *
 * ★ 只用于 `message`（日志、告警、认不出码的老客户端）。界面走
 *   `error.notFound.<entity>` 那条整句词条，不碰这张表。
 */
const NOT_FOUND_PROSE: Record<NotFoundEntity, string> = {
  project: '项目',
  work_item: '任务',
  parent_work_item: '父任务',
  agent: 'Agent',
  integration: '集成',
  requirement: '需求',
  policy: '规则',
  decision: '决策',
  plan: '计划',
  run: 'Run',
  user: '用户',
  file: '文件',
  project_convention: '工程约定',
  conflict: '冲突',
  project_member: '项目成员',
  owner: '负责人',
  role: '角色',
  org_member: '组织成员',
  organization: '组织',
  template: '模板',
  storage_target: '存储目标',
  external_object_link: '外部对象映射',
  repository: '仓库',
  artifact: '产物',
};

/**
 * ★★ 实参是**实体键**而不是一句中文。
 *
 *   原来是 `notFound('项目')` → `` `${what}不存在` ``，也就是把句子拼出来。
 *   中文里名词在前、英文里 "not found" 在后 —— 拼出来的句子只在中文里成立，
 *   英文界面拿到它只能原样显示一句中文。现在整句是一条词条
 *   （`error.notFound.project`），实体名是键的一部分而不是拼进去的片段。
 *
 *   The entity is a key, not prose: the noun leads in Chinese and trails in
 *   English, so the whole sentence has to be one catalog entry per entity.
 */
export function notFound(entity: NotFoundEntity) {
  return fail('NOT_FOUND', 'not_found', `${NOT_FOUND_PROSE[entity]}不存在`, {
    params: { entity },
  });
}

/**
 * Postgres 的「这个值根本不是这个类型」类错误 → 400。
 *
 * ★ 路由参数与查询串是**客户端**给的。`/work-items/not-a-uuid`、
 *   `?risk=bogus` 这类输入会一路走到 SQL，由 Postgres 报 22P02 抛出来。
 *   不认这些码的话，错误处理器只能把它当未知异常吞成 500 ——
 *   于是调用方以为服务端挂了，而告警面板上多出一批假的服务端故障。
 *
 *   身份那条路径当初已经被单独修过（见 routes.test.ts
 *   「格式非法的身份返回 401 而不是 500」），但那只堵了身份一个口子，
 *   路径参数和查询参数还是原样。这里统一在出口收掉。
 *
 * ★ 只认「值的文本形态不合法」这一类，不认约束冲突（23xxx）——
 *   那些是业务语义问题，各自的调用点有更准确的错误码可给。
 */
const CLIENT_INPUT_PG_CODES: Record<string, { reason: ErrorReason; zh: string }> = {
  // uuid / 枚举 / 数字字面量解析失败，最常见的一类
  '22P02': { reason: 'request.bad_path_or_query', zh: '路径或查询参数的格式不合法' },
  // 字符串超出字段长度
  '22001': { reason: 'request.param_too_long', zh: '参数长度超出限制' },
  // 数值超出范围
  '22003': { reason: 'request.number_out_of_range', zh: '数值超出允许范围' },
  // 日期时间格式不合法
  '22007': { reason: 'request.bad_timestamp', zh: '时间格式不合法' },
  '22008': { reason: 'request.timestamp_out_of_range', zh: '时间值超出范围' },
};

/**
 * 把数据库层抛出的「客户端输入不合法」翻译成 ApiError；
 * 不属于这一类的返回 null，交给调用方按未知异常处理。
 */
export function asClientInputError(error: unknown): ApiError | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return null;
  const known = CLIENT_INPUT_PG_CODES[code];
  if (!known) return null;
  // ★ 不回传 Postgres 原始 message —— 里面有表名列名，是信息泄露。
  //   给调用方能自查的东西：错在哪一类、拿到的是什么码。
  return fail('VALIDATION_FAILED', known.reason, known.zh, { details: { pgCode: code } });
}
