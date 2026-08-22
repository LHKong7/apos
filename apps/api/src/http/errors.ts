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
   * The request is well-formed, but the user has to acknowledge something once
   * before it can proceed / 请求本身没问题，但需要用户先明确确认一次才能继续。
   *
   * ★★ Kept apart from VALIDATION_FAILED: that one means "what you sent is
   *   wrong", this one means "nothing is wrong, but look at this and click
   *   again". Folding it into 400 costs nothing functionally — the feature
   *   still works — but it wrecks **logs and monitoring**: a normal
   *   human-in-the-loop round-trip becomes indistinguishable from a real
   *   client error, and the 4xx rate stops working as an alerting signal.
   *
   *   混用 400 的代价在日志与监控里：4xx 率再也不能当告警指标用。
   */
  | 'CONFIRMATION_REQUIRED'
  | 'UNANSWERED_MUST_CONFIRM'
  | 'AGENT_UNAVAILABLE'
  /** Runtime capability missing (degradation matrix) — not a fault, this runtime cannot do it */
  | 'UNSUPPORTED_FEATURE'
  | 'RATE_LIMITED'
  /** External system failure — neither our bug nor bad input from the user */
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
  // 409: a legal request that conflicts with current state; resend it after confirming
  CONFIRMATION_REQUIRED: 409,
  UNANSWERED_MUST_CONFIRM: 422,
  AGENT_UNAVAILABLE: 503,
  // 501 rather than 4xx: the request is fine, this server-side runtime lacks the capability
  UNSUPPORTED_FEATURE: 501,
  RATE_LIMITED: 429,
  // 502 rather than 500: the request reached an external system and that side failed
  EXTERNAL_ERROR: 502,
  INTERNAL: 500,
};

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    /**
     * Free-form context. Each call site puts in whatever fits (`{ path }`, a
     * list of validation issues, budget numbers) and the UI reads it per
     * endpoint / 各调用点塞各自的东西，前端按具体接口读。
     *
     * ★ The reason code does **not** go here. `details.code` was long since
     *   claimed by another convention (`UNASSIGNED_HUMAN_TASKS`, see
     *   Plan/index.tsx), so squeezing in would collide with it.
     */
    readonly details?: unknown,
    /**
     * The UI reads this, not `message` / 界面按它取词。
     *
     * ★★ Optional is a **transitional state**, not the design: an error that
     *   leaves it empty still renders as a Chinese sentence in the English UI.
     *   Every new error goes through `fail()` and fills it in.
     */
    readonly reason?: ErrorReason,
    /** Arguments for `{name}` in the catalog entry. User-authored words pass through untranslated */
    readonly params?: Record<string, string | number>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Throw with a reason code / 带原因码地抛错。
 *
 * ★★ The argument order is `code, reason, message` — code first, sentence
 *   last.
 *
 *   The reverse (sentence first) reads more naturally, but it makes "write the
 *   sentence now, add the code later" the default path, and the later part
 *   never happens. With the code first, whoever writes the error has to answer
 *   "which kind of error is this?" up front — which is exactly what the UI
 *   needs.
 *
 * ★ `message` is still a ready-made Chinese sentence: logs, alerts, and older
 *   clients that do not recognize the code all need it. The UI reads the code,
 *   the log reads the sentence / 界面读码，日志读句子。
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
       * ★ Send the reason code and the sentence **together**. The UI looks the
       *   code up first and falls back to `message` when it does not recognize
       *   it (the server added a code the front end has not caught up with) —
       *   falling back to blank would drop precisely the sentence that
       *   explains "why won't you let me do this".
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
 * Chinese fallback prose per entity / 「找不到」的中文兜底句。
 *
 * ★ Used only for `message` (logs, alerts, older clients that do not know the
 *   code). The UI goes through the whole-sentence catalog entry
 *   `error.notFound.<entity>` and never touches this table.
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
 * ★★ The argument is an **entity key**, not a Chinese sentence.
 *
 *   It used to be `notFound('项目')` → `` `${what}不存在` ``, i.e. the sentence
 *   was assembled right here. The noun leads in Chinese and "not found" trails
 *   in English, so an assembled sentence only holds up in Chinese — the
 *   English UI could do nothing but render that Chinese verbatim. Now the
 *   whole sentence is one catalog entry (`error.notFound.project`) and the
 *   entity name is part of the key rather than a fragment glued into prose.
 *
 *   实体名是键的一部分而不是拼进去的片段。
 */
export function notFound(entity: NotFoundEntity) {
  return fail('NOT_FOUND', 'not_found', `${NOT_FOUND_PROSE[entity]}不存在`, {
    params: { entity },
  });
}

/**
 * Postgres "this value is not that type at all" errors → 400 /
 * Postgres 的「这个值根本不是这个类型」类错误。
 *
 * ★ Path params and query strings come from the **client**. Input such as
 *   `/work-items/not-a-uuid` or `?risk=bogus` travels all the way into SQL and
 *   surfaces as Postgres 22P02. Without recognizing these codes the error
 *   handler can only swallow them as an unknown exception and answer 500 — so
 *   the caller concludes the server is down, and the alerting dashboard grows
 *   a batch of fake server-side failures.
 *
 *   The identity path was fixed separately once (see routes.test.ts, "a
 *   malformed identity returns 401 rather than 500"), but that plugged the one
 *   hole; path params and query params stayed as they were. This catches the
 *   rest of them at the exit.
 *
 * ★ Only the "the textual form of the value is invalid" family is recognized,
 *   not constraint violations (23xxx) — those are business-semantics problems,
 *   and each call site has a more accurate code to give.
 */
const CLIENT_INPUT_PG_CODES: Record<string, { reason: ErrorReason; zh: string }> = {
  // uuid / enum / numeric literal failed to parse — by far the most common one
  '22P02': { reason: 'request.bad_path_or_query', zh: '路径或查询参数的格式不合法' },
  // String longer than the column allows
  '22001': { reason: 'request.param_too_long', zh: '参数长度超出限制' },
  // Number outside the allowed range
  '22003': { reason: 'request.number_out_of_range', zh: '数值超出允许范围' },
  // Malformed date/time
  '22007': { reason: 'request.bad_timestamp', zh: '时间格式不合法' },
  '22008': { reason: 'request.timestamp_out_of_range', zh: '时间值超出范围' },
};

/**
 * Translate a database-level "invalid client input" into an ApiError; anything
 * outside that family returns null, and the caller handles it as an unknown
 * exception / 不属于这一类的返回 null，交给调用方按未知异常处理。
 */
export function asClientInputError(error: unknown): ApiError | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return null;
  const known = CLIENT_INPUT_PG_CODES[code];
  if (!known) return null;
  // ★ Never pass the raw Postgres message back — it carries table and column
  //   names, which is an information leak. Give the caller something they can
  //   act on instead: which family the error is in, and which code came back.
  return fail('VALIDATION_FAILED', known.reason, known.zh, { details: { pgCode: code } });
}
