import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4。
 *
 * ★★ 为什么手写而不是引 @aws-sdk/client-s3。
 *
 *   这里只用到 S3 的四个操作（List / Get / Put / Delete），而 SDK 会带进来
 *   几十个传递依赖。这个仓库对重依赖一向克制（见 docs/tech/README §2.5
 *   「刻意不引入的」），而且更实际的一条：**SDK 在这里也没法被集成测试**
 *   （环境里没有真的 S3），所以「用成熟 SDK 换正确性」这笔账并不成立。
 *
 *   手写版的正确性靠 AWS 官方公布的 SigV4 测试向量锚定（见 sigv4.test.ts），
 *   那是可以离线跑的真凭据。
 *
 * ★ 只实现 header 签名，不实现 presigned URL 与 chunked upload ——
 *   用不到的东西不写。要用时再补，而不是现在猜一个签法。
 */

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignInput {
  method: string;
  /** 已编码的路径，必须以 / 开头 */
  path: string;
  /** 查询参数，签名前会按 key 排序 */
  query?: Record<string, string>;
  headers: Record<string, string>;
  /** 请求体。字符串或字节；空体传 undefined */
  body?: Uint8Array | string;
  region: string;
  service: string;
  credentials: SigV4Credentials;
  /** 签名时刻。显式传入让签名可复现、可测 */
  now: Date;
}

const UNSIGNED = 'UNSIGNED-PAYLOAD';

/**
 * 签名并返回**完整的**请求头（含 Authorization / x-amz-date /
 * x-amz-content-sha256）。
 */
export function signRequest(input: SignInput): Record<string, string> {
  const amzDate = formatAmzDate(input.now);
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = hashPayload(input.body);

  const headers: Record<string, string> = {
    ...input.headers,
    'x-amz-date': amzDate,
  };
  /**
   * ★ 只有 S3 强制要求 `x-amz-content-sha256`，别的服务不带。
   *   无条件加上的话，签名头集合就与 AWS 公布的通用测试向量对不上 ——
   *   而那些向量是这份手写实现唯一的正确性锚点，不能为了少一个 if 放弃它。
   */
  if (input.service === 's3') headers['x-amz-content-sha256'] = payloadHash;
  if (input.credentials.sessionToken) {
    headers['x-amz-security-token'] = input.credentials.sessionToken;
  }

  /**
   * ★ 规范化：header 名小写、值折叠内部连续空白、按名排序。
   *   任何一步与服务端理解的不一致，表现都是 403 SignatureDoesNotMatch ——
   *   一条完全不指向「哪一步算错了」的错误。
   */
  const normalized = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase().trim(), collapse(String(v))] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const signedHeaders = normalized.map(([k]) => k).join(';');
  const canonicalHeaders = normalized.map(([k, v]) => `${k}:${v}\n`).join('');

  const canonicalQuery = Object.keys(input.query ?? {})
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(input.query![k]!)}`)
    .join('&');

  const canonicalRequest = [
    input.method.toUpperCase(),
    input.path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signature = hmac(signingKey(input.credentials.secretAccessKey, dateStamp, input.region, input.service), stringToSign).toString('hex');

  headers['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return headers;
}

/** 供测试断言中间产物 —— 签名对不上时，能看出是哪一步错了 */
export function canonicalRequestOf(input: SignInput): string {
  const amzDate = formatAmzDate(input.now);
  const payloadHash = hashPayload(input.body);
  const headers: Record<string, string> = {
    ...input.headers,
    'x-amz-date': amzDate,
  };
  if (input.service === 's3') headers['x-amz-content-sha256'] = payloadHash;
  const normalized = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase().trim(), collapse(String(v))] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalQuery = Object.keys(input.query ?? {})
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(input.query![k]!)}`)
    .join('&');
  return [
    input.method.toUpperCase(),
    input.path,
    canonicalQuery,
    normalized.map(([k, v]) => `${k}:${v}\n`).join(''),
    normalized.map(([k]) => k).join(';'),
    payloadHash,
  ].join('\n');
}

export { UNSIGNED as UNSIGNED_PAYLOAD };

/**
 * 对象键 → URL 路径段。
 *
 * ★★ 不能用 `encodeURIComponent`：它保留 `!'()*`，而 AWS 的规范要求
 *   把它们也编码。差一个字符，签名就对不上，而错误是 403 ——
 *   表现为「某些文件名的对象传不上去」，极难联想到编码规则。
 *
 * ★ 斜杠不编码（S3 的键里斜杠是路径分隔），所以按段编码后再拼回去。
 */
export function encodeKey(key: string): string {
  return key.split('/').map(uriEncode).join('/');
}

/** RFC 3986 的 unreserved 之外全部百分号编码 */
export function uriEncode(value: string): string {
  return Array.from(Buffer.from(value, 'utf8'))
    .map((b) => {
      const c = String.fromCharCode(b);
      if (/[A-Za-z0-9\-._~]/.test(c)) return c;
      return `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hashPayload(body: Uint8Array | string | undefined): string {
  if (body === undefined) return sha256Hex('');
  return sha256Hex(body);
}

function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(Buffer.from(`AWS4${secret}`, 'utf8'), dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** `20130524T000000Z` */
function formatAmzDate(d: Date): string {
  return `${d.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

/** 头值里的连续空白折叠成一个空格，首尾去空 */
function collapse(v: string): string {
  return v.trim().replace(/\s+/g, ' ');
}
