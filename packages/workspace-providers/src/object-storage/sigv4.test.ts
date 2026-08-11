import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalRequestOf, encodeKey, signRequest, uriEncode } from './sigv4';

/**
 * ★★ 这份手写 SigV4 的正确性锚点。
 *
 *   常量来自 AWS 公布的签名文档与通用测试套件，不是从实现反推出来的 ——
 *   反推的期望值只能证明「代码等于它自己」。签名算错的现场表现是 403
 *   SignatureDoesNotMatch，一条完全不指向「哪一步算错」的错误，
 *   所以这里逐段断言：派生密钥 → 规范请求 → 待签串 → 最终签名。
 */

const CREDS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};

describe('派生签名密钥', () => {
  /** AWS「如何派生签名密钥」文档里的示例，逐级都有公布值 */
  it('与 AWS 文档示例逐级一致', () => {
    const hmac = (key: Buffer, data: string) =>
      createHmac('sha256', key).update(data, 'utf8').digest();

    const kDate = hmac(Buffer.from(`AWS4${CREDS.secretAccessKey}`, 'utf8'), '20120215');
    const kRegion = hmac(kDate, 'us-east-1');
    const kService = hmac(kRegion, 'iam');
    const kSigning = hmac(kService, 'aws4_request');

    expect(kSigning.toString('hex')).toBe(
      'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d',
    );
  });
});

describe('SigV4 通用测试套件：get-vanilla', () => {
  const input = {
    method: 'GET',
    path: '/',
    headers: { host: 'example.amazonaws.com' },
    region: 'us-east-1',
    service: 'service',
    credentials: CREDS,
    now: new Date('2015-08-30T12:36:00Z'),
  };

  it('规范请求逐字节一致', () => {
    expect(canonicalRequestOf(input)).toBe(
      [
        'GET',
        '/',
        '',
        'host:example.amazonaws.com',
        'x-amz-date:20150830T123600Z',
        '',
        'host;x-amz-date',
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ].join('\n'),
    );
  });

  it('Authorization 头与套件公布的签名一致', () => {
    const headers = signRequest(input);
    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  /** ★ 非 S3 服务不带 x-amz-content-sha256，否则签名头集合就变了 */
  it('非 s3 服务不注入 x-amz-content-sha256', () => {
    expect(signRequest(input)['x-amz-content-sha256']).toBeUndefined();
  });

  it('s3 服务注入空体的 sha256', () => {
    const headers = signRequest({ ...input, service: 's3' });
    expect(headers['x-amz-content-sha256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('规范化细节', () => {
  const base = {
    method: 'GET',
    path: '/',
    headers: { host: 'example.amazonaws.com' },
    region: 'us-east-1',
    service: 'service',
    credentials: CREDS,
    now: new Date('2015-08-30T12:36:00Z'),
  };

  it('查询参数按 key 排序，不按传入顺序', () => {
    const a = canonicalRequestOf({ ...base, query: { 'Zebra': '1', 'Apple': '2' } });
    const b = canonicalRequestOf({ ...base, query: { 'Apple': '2', 'Zebra': '1' } });
    expect(a).toBe(b);
    expect(a.split('\n')[2]).toBe('Apple=2&Zebra=1');
  });

  /** ★ 头值里的连续空白要折叠成一个空格；不折叠的话服务端与我们算的不是同一个串 */
  it('头值折叠内部连续空白并去首尾空格', () => {
    const cr = canonicalRequestOf({
      ...base,
      headers: { host: 'example.amazonaws.com', 'my-header': '  a   b  c  ' },
    });
    expect(cr).toContain('my-header:a b c\n');
  });

  it('请求体参与签名 —— 体变了签名就得变', () => {
    const one = signRequest({ ...base, method: 'PUT', body: 'hello' })['authorization'];
    const two = signRequest({ ...base, method: 'PUT', body: 'world' })['authorization'];
    expect(one).not.toBe(two);
  });
});

describe('URI 编码', () => {
  /**
   * ★★ encodeURIComponent 保留 !'()* 而 AWS 要求把它们也编码。
   *   差一个字符签名就对不上，而表现是「某些文件名的对象传不上去」——
   *   极难联想到是编码规则。
   */
  it('把 encodeURIComponent 放过的 !\'()* 也编码掉', () => {
    expect(uriEncode("!'()*")).toBe('%21%27%28%29%2A');
    expect(encodeURIComponent("!'()*")).toBe("!'()*"); // 对照：标准库确实放过了
  });

  it('unreserved 字符原样保留', () => {
    expect(uriEncode('aZ0-._~')).toBe('aZ0-._~');
  });

  it('空格编码成 %20 而不是 +', () => {
    expect(uriEncode('a b')).toBe('a%20b');
  });

  it('非 ASCII 按 UTF-8 逐字节编码', () => {
    expect(uriEncode('中')).toBe('%E4%B8%AD');
  });

  /** ★ 对象键里的斜杠是路径分隔，不能编码，否则整个键就成了一段文件名 */
  it('对象键按段编码，斜杠保留', () => {
    expect(encodeKey('a/b c/d!e')).toBe('a/b%20c/d%21e');
  });
});
