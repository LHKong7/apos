/**
 * 外部系统 HTTP 客户端。
 *
 * ★ 各家 API 的差异吃在适配器里，但**失败的处理方式必须统一** ——
 *   页面文档 14 §11 对限流、不可达、403 回收各有明确要求，
 *   而这些要求跟 provider 无关。每个适配器各写一套退避重试，
 *   迟早有一家写错，而写错的表现是「偶尔同步不上」，最难查。
 *
 * ★ 错误分类比错误信息重要。同步失败时页面要回答的是
 *   「我该重新授权、该等一会儿、还是该找管理员」——
 *   一句「请求失败 500」三个问题一个都答不了。
 */

export type HttpErrorKind =
  /** token 过期或无效 —— 用户要重新授权 */
  | 'unauthorized'
  /** 有 token 但没这个权限，或权限被管理员回收了（§11）*/
  | 'forbidden'
  /** 对象不存在，或被删了 */
  | 'not_found'
  /** 限流，退避后可重试 */
  | 'rate_limited'
  /** 对方 5xx / 网络不通，退避后可重试 */
  | 'unavailable'
  /** 我们发的请求本身有问题，重试没用 */
  | 'bad_request';

export class HttpError extends Error {
  constructor(
    readonly kind: HttpErrorKind,
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null = null,
    readonly body: string | null = null,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  /** 退避重试有没有意义 —— 401/403/404/400 重试一百次也是同样的结果 */
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'unavailable';
  }
}

export interface HttpOptions {
  baseUrl: string;
  /** 每次请求都会带上。凭证由适配器解析后传进来，这一层不碰密钥管理 */
  headers?: Record<string, string>;
  /** 最多重试几次（不含首次）。默认 3 */
  maxRetries?: number;
  /** 首次退避毫秒，之后指数增长。默认 500 */
  baseBackoffMs?: number;
  /**
   * 单次退避的上限。默认 30s。
   *
   * ★ 没有这个上限会出真事：GitHub 限流时 x-ratelimit-reset 可能在
   *   四十分钟之后，而「听对方的 Retry-After」会让这一次同步请求
   *   原地睡四十分钟 —— 请求不返回、连接不释放、页面一直转圈。
   *   超过上限就别等了，直接把「还要等多久」报上去，
   *   由调用方暂停这个集成、过一阵子再来（§11「持续限流时提示调整同步频率」）。
   */
  maxBackoffMs?: number;
  timeoutMs?: number;
  /** 注入用，测试里换成假的 fetch/sleep */
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** 每次重试都会回调，供页面显示「同步降速中」 */
  onRetry?: (info: { attempt: number; waitMs: number; reason: HttpErrorKind }) => void;
}

export interface RequestInitLite {
  method?: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  headers?: Record<string, string>;
  /**
   * 原样返回响应体文本，不做 JSON 解析。
   *
   * ★ 不是所有 API 都回 JSON：Slack 的 Incoming Webhook 成功时回一个
   *   裸的 "ok"，飞书出错时可能回一段网关 HTML。默认解析的话，
   *   这些响应会在解析处炸掉 —— 而调用方本来正要读那段文本来判断成败，
   *   结果连内容都拿不到，错误信息变成「Unexpected token '<'」。
   */
  raw?: boolean;
}

export class HttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: HttpOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async request<T>(init: RequestInitLite): Promise<T> {
    const max = this.opts.maxRetries ?? 3;
    let lastError: HttpError | undefined;

    for (let attempt = 0; attempt <= max; attempt++) {
      try {
        return await this.once<T>(init);
      } catch (e) {
        if (!(e instanceof HttpError) || !e.retryable || attempt === max) throw e;
        lastError = e;

        /**
         * ★ 优先听对方的 Retry-After，没有才用指数退避。
         *   GitHub 和 Jira 限流时都会明确告诉你等多久，
         *   自己算一个更短的间隔重试，只会更快撞进下一轮限流。
         */
        const waitMs = e.retryAfterMs ?? (this.opts.baseBackoffMs ?? 500) * 2 ** attempt;

        /**
         * ★ 但也不能真的等下去。等待时间超过上限时立刻抛，
         *   把「还要等多久」带出去让调用方决定 ——
         *   一次同步请求原地睡四十分钟，表现是页面一直转圈，
         *   而且连接一直占着。
         */
        const cap = this.opts.maxBackoffMs ?? 30_000;
        if (waitMs > cap) {
          throw new HttpError(
            e.kind,
            `${e.message} —— 需要等待约 ${Math.round(waitMs / 60_000)} 分钟，已停止重试`,
            e.status,
            waitMs,
            e.body,
          );
        }
        this.opts.onRetry?.({ attempt: attempt + 1, waitMs, reason: e.kind });
        await this.sleep(waitMs);
      }
    }

    throw lastError ?? new HttpError('unavailable', '请求失败', 0);
  }

  private async once<T>(init: RequestInitLite): Promise<T> {
    /**
     * ★ path 为空时 baseUrl 原样用，不补斜杠。
     *   Webhook 的 URL 是一个整体（.../hooks/T000/B111/xxx），
     *   多一个尾斜杠可能直接 404 —— 而这种失败看起来像
     *   「webhook 配错了」，用户会去重新生成一个，然后发现还是不行。
     */
    const url =
      init.path === ''
        ? new URL(this.opts.baseUrl)
        : new URL(init.path.replace(/^\//, ''), ensureSlash(this.opts.baseUrl));
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      ...this.opts.headers,
      ...init.headers,
    };
    if (init.json !== undefined) headers['content-type'] = 'application/json';

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method: init.method ?? 'GET',
        headers,
        body: init.json === undefined ? undefined : JSON.stringify(init.json),
        signal: this.opts.timeoutMs ? AbortSignal.timeout(this.opts.timeoutMs) : undefined,
      });
    } catch (e) {
      // 网络层失败（DNS / 连接拒绝 / 超时）等同于服务不可达，可重试
      throw new HttpError('unavailable', networkMessage(e), 0);
    }

    if (res.ok) {
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      if (init.raw) return text as T;
      return (text ? JSON.parse(text) : undefined) as T;
    }

    const body = await res.text().catch(() => '');
    throw classify(res, body);
  }
}

/**
 * HTTP 状态 → 可行动的分类。
 *
 * ★ 403 要再看一眼 body：GitHub 的限流也返回 403（带 x-ratelimit-remaining: 0），
 *   当成「权限不足」会让页面提示用户去找管理员要权限，
 *   而真正该做的是等几分钟。这是最容易踩的一个坑。
 */
export function classify(res: Response, body: string): HttpError {
  const status = res.status;
  const retryAfter = parseRetryAfter(res);

  if (status === 401) {
    return new HttpError('unauthorized', 'token 已过期或无效，需要重新授权', status, null, body);
  }

  if (status === 429) {
    return new HttpError('rate_limited', '被外部系统限流', status, retryAfter, body);
  }

  if (status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0' || /rate limit|abuse detection|secondary rate/i.test(body)) {
      return new HttpError('rate_limited', '被外部系统限流', status, retryAfter, body);
    }
    return new HttpError('forbidden', '权限不足 —— 可能是授权范围不够，或权限已被回收', status, null, body);
  }

  if (status === 404) {
    return new HttpError('not_found', '对象不存在（可能已在外部系统被删除）', status, null, body);
  }

  if (status >= 500) {
    return new HttpError('unavailable', `外部服务异常（${status}）`, status, retryAfter, body);
  }

  return new HttpError('bad_request', `请求被拒绝（${status}）`, status, null, body);
}

/**
 * Retry-After 既可能是秒数，也可能是 HTTP 日期。
 * GitHub 限流还会给 x-ratelimit-reset（Unix 秒）。
 */
function parseRetryAfter(res: Response): number | null {
  const header = res.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }

  const reset = res.headers.get('x-ratelimit-reset');
  if (reset && Number.isFinite(Number(reset))) {
    return Math.max(0, Number(reset) * 1000 - Date.now());
  }
  return null;
}

function networkMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/abort|timeout/i.test(msg)) return '请求超时，外部服务无响应';
  return `无法连接外部服务：${msg}`;
}

function ensureSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}
