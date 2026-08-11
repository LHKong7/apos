import { describe, expect, it } from 'vitest';
import { S3Client, S3Error } from './s3';

/**
 * 进程内假 S3 —— 记录收到的请求并按 S3 的响应形状回话。
 *
 * ★ 环境里没有真的 S3，也装不了 MinIO。假服务端验的是「我们发出去的请求
 *   长什么样」与「响应解析对不对」，签名本身的正确性由 sigv4.test.ts 用
 *   AWS 官方向量锚定 —— 两者合起来才覆盖得住。
 */
function fakeS3(handler: (req: { method: string; url: URL; headers: Headers; body?: string }) => Response) {
  const calls: { method: string; url: URL; headers: Headers; body?: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body =
      init?.body instanceof Uint8Array ? Buffer.from(init.body).toString('utf8') : undefined;
    const call = {
      method: init?.method ?? 'GET',
      url,
      headers: new Headers(init?.headers as Record<string, string>),
      ...(body === undefined ? {} : { body }),
    };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

function xmlList(keys: { key: string; etag: string; size?: number }[], truncated = false, next?: string) {
  return `<?xml version="1.0"?><ListBucketResult>
    <IsTruncated>${truncated}</IsTruncated>
    ${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ''}
    ${keys
      .map(
        (k) =>
          `<Contents><Key>${k.key}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified>` +
          `<ETag>&quot;${k.etag}&quot;</ETag><Size>${k.size ?? 3}</Size></Contents>`,
      )
      .join('')}
  </ListBucketResult>`;
}

function client(fetchImpl: typeof fetch, over: Partial<ConstructorParameters<typeof S3Client>[0]> = {}) {
  return new S3Client({
    endpoint: 'https://minio.internal:9000',
    region: 'us-east-1',
    bucket: 'artifacts',
    forcePathStyle: true,
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
    fetchImpl,
    now: () => new Date('2026-01-01T00:00:00Z'),
    ...over,
  });
}

describe('S3 请求构造', () => {
  it('path-style 把 bucket 放在路径里，并带上签名头', async () => {
    const { fetchImpl, calls } = fakeS3(() => new Response(xmlList([])));
    await client(fetchImpl).list('');

    expect(calls[0]!.url.origin).toBe('https://minio.internal:9000');
    expect(calls[0]!.url.pathname).toBe('/artifacts');
    expect(calls[0]!.headers.get('authorization')).toContain('AWS4-HMAC-SHA256');
    expect(calls[0]!.headers.get('x-amz-content-sha256')).toBeTruthy();
  });

  /**
   * ★ 自建端点基本只支持 path-style，AWS 两种都支持 —— 所以这是显式配置。
   *   默认成 virtual-host 的话，自建端点的表现是 DNS 解析失败，
   *   完全不指向「寻址风格」这件事。
   */
  it('virtual-host-style 把 bucket 放进域名', async () => {
    const { fetchImpl, calls } = fakeS3(() => new Response(xmlList([])));
    await client(fetchImpl, { forcePathStyle: false, endpoint: 'https://s3.amazonaws.com' }).list('');

    expect(calls[0]!.url.host).toBe('artifacts.s3.amazonaws.com');
    expect(calls[0]!.url.pathname).toBe('/');
  });

  it('对象键里的空格与特殊字符按 AWS 规则编码，斜杠保留', async () => {
    const { fetchImpl, calls } = fakeS3(() => new Response('ok'));
    await client(fetchImpl).get("out/a b/c!d.txt");

    expect(calls[0]!.url.pathname).toBe('/artifacts/out/a%20b/c%21d.txt');
  });
});

describe('列举', () => {
  /**
   * ★★ 只取第一页的话，超过 1000 个对象的 bucket 会静默少算 ——
   *   而少算的表现是「基线里没有这些对象」，收尾时它们全都成了新增。
   */
  it('自动翻页到底', async () => {
    let page = 0;
    const { fetchImpl, calls } = fakeS3(() => {
      page++;
      return page === 1
        ? new Response(xmlList([{ key: 'a.txt', etag: 'e1' }], true, 'TOKEN-2'))
        : new Response(xmlList([{ key: 'b.txt', etag: 'e2' }]));
    });

    const { objects, truncated } = await client(fetchImpl).list('');
    expect(objects.map((o) => o.key)).toEqual(['a.txt', 'b.txt']);
    expect(truncated).toBe(false);
    expect(calls[1]!.url.searchParams.get('continuation-token')).toBe('TOKEN-2');
  });

  it('超过上限时如实标 truncated，而不是悄悄少报', async () => {
    const { fetchImpl } = fakeS3(() =>
      new Response(xmlList([{ key: 'a', etag: '1' }, { key: 'b', etag: '2' }, { key: 'c', etag: '3' }])),
    );
    const { objects, truncated } = await client(fetchImpl).list('', { maxObjects: 2 });
    expect(objects).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it('ETag 去掉引号', async () => {
    const { fetchImpl } = fakeS3(() => new Response(xmlList([{ key: 'a.txt', etag: 'abc123' }])));
    const { objects } = await client(fetchImpl).list('');
    expect(objects[0]!.etag).toBe('abc123');
  });

  /**
   * ★ 对象键里合法地出现 & 与 <。不还原实体的话这些键会被当成
   *   「与本地不同」，每次收尾都报成修改。
   */
  it('还原键里的 XML 实体', async () => {
    const { fetchImpl } = fakeS3(
      () => new Response(xmlList([{ key: 'a&amp;b/c&lt;d.txt', etag: 'e' }])),
    );
    const { objects } = await client(fetchImpl).list('');
    expect(objects[0]!.key).toBe('a&b/c<d.txt');
  });
});

describe('错误处理', () => {
  it('把服务端的 Code 带进报错 —— 403 同时意味着凭证不对与没有权限', async () => {
    const { fetchImpl } = fakeS3(
      () =>
        new Response('<Error><Code>SignatureDoesNotMatch</Code><Message>坏了</Message></Error>', {
          status: 403,
        }),
    );

    await expect(client(fetchImpl).get('a.txt')).rejects.toThrow(S3Error);
    await expect(client(fetchImpl).get('a.txt')).rejects.toThrow(/SignatureDoesNotMatch/);
  });

  /** ★ 报错里不能带查询串 —— 那里可能有签名参数 */
  it('报错里只留 origin + path，不带查询串', async () => {
    const { fetchImpl } = fakeS3(() => new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 }));
    await expect(client(fetchImpl).list('secret-prefix')).rejects.toThrow(
      /https:\/\/minio\.internal:9000\/artifacts →/,
    );
  });

  it('probe 把连不上/凭证不对变成一个可读的判断，而不是抛异常', async () => {
    const { fetchImpl } = fakeS3(() => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }));
    const result = await client(fetchImpl).probe();
    expect(result.ok).toBe(false);
    expect(result.problem).toContain('AccessDenied');
  });
});

describe('写入', () => {
  it('put 带上 content-type 与请求体', async () => {
    const { fetchImpl, calls } = fakeS3(() => new Response('', { status: 200 }));
    await client(fetchImpl).put('out/report.md', new TextEncoder().encode('# hi'), 'text/markdown');

    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url.pathname).toBe('/artifacts/out/report.md');
    expect(calls[0]!.headers.get('content-type')).toBe('text/markdown');
    expect(calls[0]!.body).toBe('# hi');
  });

  it('delete 发 DELETE', async () => {
    const { fetchImpl, calls } = fakeS3(() => new Response(null, { status: 204 }));
    await client(fetchImpl).delete('out/gone.txt');
    expect(calls[0]!.method).toBe('DELETE');
  });
});
