import { encodeKey, signRequest, type SigV4Credentials } from './sigv4';

export class S3Error extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'S3Error';
  }
}

export interface S3ClientOptions {
  endpoint: string;
  region: string;
  bucket: string;
  credentials: SigV4Credentials;
  /** path-style（`host/bucket/key`）还是 virtual-host-style（`bucket.host/key`） */
  forcePathStyle: boolean;
  /** 注入 fetch，测试用进程内假服务端；生产走全局 fetch */
  fetchImpl?: typeof fetch;
  /** 注入时钟，让签名可复现 */
  now?: () => Date;
  requestTimeoutMs?: number;
}

export interface S3Object {
  key: string;
  size: number;
  /** 已去掉引号 */
  etag: string;
  lastModified: string;
}

/**
 * 最小 S3 客户端 —— 只有铺料与交货真正用到的四个操作。
 *
 * ★ 兼容 AWS S3 / MinIO / Ceph / R2 / 阿里云 OSS 的 S3 兼容端点。
 *   差异基本都落在寻址风格上，所以那一项是显式配置而不是猜。
 */
export class S3Client {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: S3ClientOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * 列出 prefix 下的全部对象。
   *
   * ★ 自动翻页到底。只取第一页的话，一个超过 1000 个对象的 bucket 会静默
   *   少算 —— 而少算的表现是「基线里没有这些对象」，收尾时它们全都成了新增。
   */
  async list(prefix: string, opts: { maxObjects?: number } = {}): Promise<{
    objects: S3Object[];
    truncated: boolean;
  }> {
    const cap = opts.maxObjects ?? 20_000;
    const objects: S3Object[] = [];
    let token: string | undefined;

    for (;;) {
      const query: Record<string, string> = { 'list-type': '2', 'max-keys': '1000' };
      if (prefix) query['prefix'] = prefix;
      if (token) query['continuation-token'] = token;

      const res = await this.send('GET', '', query);
      const xml = await res.text();

      for (const item of parseContents(xml)) {
        if (objects.length >= cap) return { objects, truncated: true };
        objects.push(item);
      }

      const next = tagValue(xml, 'NextContinuationToken');
      if (tagValue(xml, 'IsTruncated') !== 'true' || !next) break;
      token = next;
    }

    return { objects, truncated: false };
  }

  async get(key: string): Promise<Uint8Array> {
    const res = await this.send('GET', key);
    return new Uint8Array(await res.arrayBuffer());
  }

  async put(key: string, body: Uint8Array, contentType = 'application/octet-stream'): Promise<void> {
    await this.send('PUT', key, undefined, body, { 'content-type': contentType });
  }

  async delete(key: string): Promise<void> {
    await this.send('DELETE', key);
  }

  /** 端点连通性与凭证有效性 —— 登记时探一次，不要等第一次派发才炸 */
  async probe(prefix = ''): Promise<{ ok: boolean; problem: string | null }> {
    try {
      await this.send('GET', '', { 'list-type': '2', 'max-keys': '1', ...(prefix ? { prefix } : {}) });
      return { ok: true, problem: null };
    } catch (err) {
      return { ok: false, problem: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── 内部 ────────────────────────────────────────────────────────────

  private urlFor(key: string): { url: URL; path: string; host: string } {
    const base = new URL(this.options.endpoint);
    const encoded = key ? `/${encodeKey(key)}` : '/';

    if (this.options.forcePathStyle) {
      const prefix = base.pathname.replace(/\/+$/, '');
      // 模板串以 / 开头，必非空 —— 不需要再兜一个 '/'
      const path = `${prefix}/${this.options.bucket}${encoded === '/' ? '' : encoded}`;
      const url = new URL(base.origin);
      url.pathname = path;
      return { url, path, host: base.host };
    }

    const host = `${this.options.bucket}.${base.host}`;
    const url = new URL(`${base.protocol}//${host}`);
    url.pathname = encoded;
    return { url, path: encoded, host };
  }

  private async send(
    method: string,
    key: string,
    query?: Record<string, string>,
    body?: Uint8Array,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const { url, path, host } = this.urlFor(key);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);

    const headers = signRequest({
      method,
      path,
      ...(query ? { query } : {}),
      headers: { host, ...extraHeaders },
      ...(body ? { body } : {}),
      region: this.options.region,
      service: 's3',
      credentials: this.options.credentials,
      now: this.now(),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 120_000);

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers,
        ...(body ? { body } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      throw new S3Error(
        `请求 ${method} ${redactUrl(url)} 失败：${err instanceof Error ? err.message : String(err)}`,
        0,
        null,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const code = tagValue(text, 'Code');
      /**
       * ★ 403 在 S3 上同时意味着「凭证不对」和「没有这个权限」，
       *   而两者的处置完全不同。把服务端给的 Code 带出来，
       *   否则运维只能看到一个「403」。
       */
      throw new S3Error(
        `${method} ${redactUrl(url)} → ${res.status}${code ? ` ${code}` : ''}：${tagValue(text, 'Message') ?? text.slice(0, 200)}`,
        res.status,
        code,
      );
    }

    return res;
  }
}

/**
 * 从 ListObjectsV2 响应里抽 `<Contents>`。
 *
 * ★ 刻意不引 XML 解析器：这里只认一种响应形状，而通用解析器会为此带进
 *   一个几百 KB 的依赖。代价是**必须**处理实体转义 —— 对象键里合法地出现
 *   `&` 与 `<`，不还原的话这些键会被当成「与本地不同」，每次收尾都报成修改。
 */
function parseContents(xml: string): S3Object[] {
  const out: S3Object[] = [];
  const re = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1]!;
    const key = tagValue(block, 'Key');
    if (!key) continue;
    out.push({
      key,
      size: Number(tagValue(block, 'Size') ?? '0'),
      etag: (tagValue(block, 'ETag') ?? '').replace(/^"|"$/g, ''),
      lastModified: tagValue(block, 'LastModified') ?? '',
    });
  }
  return out;
}

function tagValue(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? unescapeXml(m[1]!) : null;
}

function unescapeXml(v: string): string {
  return v
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    // ★ &amp; 必须最后还原，否则 `&amp;lt;` 会被两步还原成 `<`
    .replace(/&amp;/g, '&');
}

/** 报错里带 URL，但查询串可能含签名参数 —— 只留路径 */
function redactUrl(url: URL): string {
  return `${url.origin}${url.pathname}`;
}
