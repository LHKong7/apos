import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 会话令牌 —— HS256 JWT。
 *
 * ★ 手写而不是引一个 JWT 库：需要的是 HMAC-SHA256 加两次 base64url，
 *   node:crypto 全都有（这个仓库的 AES-GCM 也是这么写的）。
 *   引库的代价不是体积，是「库支持十几种算法而我们只允许一种」——
 *   算法混淆（alg confusion）恰恰是 JWT 最常见的漏洞来源，
 *   而它的根因永远是「库愿意接受另一种 alg」。
 *
 * ★★ 所以这里把 alg 钉死：`verify` 只认字面量 `HS256`，
 *   `none` 和 RS256 一律拒。攻击者能改的是 header，
 *   把 alg 换成 `none` 再把签名清空，是这类库最经典的绕过方式。
 *
 * ★ 令牌是**无状态**的：改口令、停用账号都不会让已签发的令牌立刻失效，
 *   最长要等到 exp。这是 MVP 的取舍（做撤销要引会话表或黑名单）——
 *   TTL 因此不能太长，默认 12 小时。真要立刻踢人只能改 APOS_JWT_SECRET
 *   重启，那会把所有人一起踢下线。
 */

const ALG = 'HS256';
const DEFAULT_TTL_SECONDS = 12 * 60 * 60;

export interface TokenClaims {
  /** 用户 id */
  sub: string;
  /** 签发时刻（秒） */
  iat: number;
  /** 过期时刻（秒） */
  exp: number;
}

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenError';
  }
}

let cached: Buffer | null = null;
let warned = false;

/**
 * 签名密钥。
 *
 * ★★ 没配置时**不报错**，而是每个进程随机生成一把并大声警告。
 *
 *   报错的表现是「装完起不来」，而这个变量对第一次跑起来的人
 *   没有任何意义；随机兜底的表现是「重启后要重新登录」，
 *   自解释得多。但多副本部署时随机兜底是致命的：A 副本签的令牌
 *   B 副本验不过，表现为「随机掉线」—— 所以警告里必须写清楚。
 */
function secret(): Buffer {
  if (cached) return cached;
  const raw = process.env['APOS_JWT_SECRET'];
  if (raw && raw.length > 0) {
    cached = Buffer.from(raw, 'utf8');
    return cached;
  }
  if (!warned) {
    warned = true;
    console.warn(
      '[auth] 未配置 APOS_JWT_SECRET，本进程使用随机密钥：重启后所有人需要重新登录，' +
        '多副本部署会表现为随机掉线。生产环境请设置该变量。',
    );
  }
  cached = randomBytes(32);
  return cached;
}

/** 仅供测试：改了 APOS_JWT_SECRET 之后让下一次调用重新读环境变量 */
export function resetSecretCache(): void {
  cached = null;
  warned = false;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function signToken(userId: string, opts: { ttlSeconds?: number } = {}): string {
  const ttl = opts.ttlSeconds ?? Number(process.env['APOS_JWT_TTL_SECONDS'] ?? DEFAULT_TTL_SECONDS);
  const now = Math.floor(Date.now() / 1000);
  const claims: TokenClaims = { sub: userId, iat: now, exp: now + ttl };

  const head = b64url(JSON.stringify({ alg: ALG, typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  return `${head}.${body}.${sign(`${head}.${body}`)}`;
}

/**
 * 校验并取出声明。任何不合法都抛 {@link TokenError}。
 *
 * ★ 先验签名再看内容。顺序反过来的话，未经验证的 payload 已经被
 *   解析并可能被用于日志或查库 —— 那是一段攻击者完全可控的 JSON。
 */
export function verifyToken(token: string): TokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenError('令牌格式不合法');
  const [head, body, mac] = parts as [string, string, string];

  let header: { alg?: unknown; typ?: unknown };
  try {
    header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
  } catch {
    throw new TokenError('令牌格式不合法');
  }
  // ★★ 算法必须是字面量 HS256。`none` 与非对称算法一律拒
  if (header.alg !== ALG) throw new TokenError('令牌签名算法不被接受');

  const expected = Buffer.from(sign(`${head}.${body}`), 'utf8');
  const actual = Buffer.from(mac, 'utf8');
  // ★ 长度不等时 timingSafeEqual 会抛，先挡一道；长度本身不是秘密
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new TokenError('令牌签名不匹配');
  }

  let claims: Partial<TokenClaims>;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new TokenError('令牌格式不合法');
  }

  if (typeof claims.sub !== 'string' || claims.sub === '') {
    throw new TokenError('令牌里没有身份');
  }
  if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') {
    throw new TokenError('令牌缺少有效期');
  }
  if (claims.exp * 1000 <= Date.now()) {
    throw new TokenError('登录已过期，请重新登录');
  }

  return { sub: claims.sub, iat: claims.iat, exp: claims.exp };
}

/**
 * 从请求里取令牌。
 *
 * ★ 两个来源：`Authorization: Bearer` 是主路径；query 上的
 *   `access_token` 只为 SSE 存在 —— EventSource 不能带自定义头
 *   （前端 lib/sse/connection.ts 里对 Last-Event-ID 也是同样的妥协）。
 *
 * ★ query 里的令牌会进 access log 和浏览器历史。这是 EventSource
 *   的固有代价，缓解办法是 TTL 短 + 生产上关掉 URL 日志。
 */
export function tokenFrom(req: {
  headers: Record<string, unknown>;
  query?: unknown;
}): string | null {
  const header = req.headers['authorization'];
  if (typeof header === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m) return m[1]!.trim();
  }
  const q = req.query as { access_token?: unknown } | undefined;
  if (q && typeof q.access_token === 'string' && q.access_token !== '') return q.access_token;
  return null;
}
