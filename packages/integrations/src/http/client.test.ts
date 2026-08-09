import { describe, expect, it, vi } from 'vitest';
import { HttpClient, HttpError, classify } from './client';

function res(status: number, body = '', headers: Record<string, string> = {}): Response {
  // 204 按规范不能带 body，构造时传空串会直接抛
  return new Response(status === 204 ? null : body, { status, headers });
}

function client(fetchImpl: typeof fetch, over: Record<string, unknown> = {}) {
  return new HttpClient({
    baseUrl: 'https://api.example.com/v1/',
    fetchImpl,
    sleepImpl: async () => {},
    ...over,
  });
}

/**
 * 外部系统 HTTP 客户端。
 *
 * 错误分类比错误信息重要：同步失败时页面要回答的是「我该重新授权、
 * 该等一会儿、还是该找管理员」，一句「请求失败 500」三个问题一个都答不了。
 */
describe('错误分类', () => {
  it('401 → 需要重新授权', () => {
    expect(classify(res(401), '').kind).toBe('unauthorized');
  });

  it('403 → 权限不足', () => {
    const e = classify(res(403), 'Resource not accessible');
    expect(e.kind).toBe('forbidden');
    expect(e.message).toContain('权限已被回收');
  });

  /**
   * ★ 最容易踩的坑：GitHub 限流也返回 403。
   *   当成「权限不足」会让页面提示用户去找管理员要权限，
   *   而真正该做的是等几分钟。
   */
  it('★ 403 + x-ratelimit-remaining: 0 是限流，不是权限不足', () => {
    const e = classify(res(403, '', { 'x-ratelimit-remaining': '0' }), '');
    expect(e.kind).toBe('rate_limited');
    expect(e.retryable).toBe(true);
  });

  it('★ 403 + secondary rate limit 文案也算限流', () => {
    const e = classify(res(403), 'You have exceeded a secondary rate limit');
    expect(e.kind).toBe('rate_limited');
  });

  it('404 → 对象不存在，提示可能已在外部被删', () => {
    expect(classify(res(404), '').message).toContain('已在外部系统被删除');
  });

  it('5xx 与 429 可重试，4xx 不可重试', () => {
    expect(classify(res(502), '').retryable).toBe(true);
    expect(classify(res(429), '').retryable).toBe(true);
    expect(classify(res(401), '').retryable).toBe(false);
    expect(classify(res(403), 'nope').retryable).toBe(false);
    expect(classify(res(400), '').retryable).toBe(false);
  });
});

describe('退避重试', () => {
  it('限流后重试，最终成功', async () => {
    const calls: number[] = [];
    const f = vi.fn(async () => {
      calls.push(1);
      return calls.length < 3 ? res(429, '', { 'retry-after': '1' }) : res(200, '{"ok":true}');
    });

    const out = await client(f as unknown as typeof fetch).request<{ ok: boolean }>({ path: 'x' });
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(3);
  });

  /**
   * ★ 优先听对方的 Retry-After。自己算一个更短的间隔重试，
   *   只会更快撞进下一轮限流。
   */
  it('★ 退避时长听 Retry-After，不用自己的指数退避', async () => {
    const waits: number[] = [];
    const f = vi.fn(async () => res(429, '', { 'retry-after': '7' }));

    await expect(
      new HttpClient({
        baseUrl: 'https://api.example.com/',
        fetchImpl: f as unknown as typeof fetch,
        sleepImpl: async (ms) => void waits.push(ms),
        maxRetries: 2,
      }).request({ path: 'x' }),
    ).rejects.toThrow();

    expect(waits).toEqual([7000, 7000]);
  });

  it('没有 Retry-After 时指数退避', async () => {
    const waits: number[] = [];
    const f = vi.fn(async () => res(503));

    await expect(
      new HttpClient({
        baseUrl: 'https://api.example.com/',
        fetchImpl: f as unknown as typeof fetch,
        sleepImpl: async (ms) => void waits.push(ms),
        maxRetries: 3,
        baseBackoffMs: 100,
      }).request({ path: 'x' }),
    ).rejects.toThrow();

    expect(waits).toEqual([100, 200, 400]);
  });

  it('GitHub 的 x-ratelimit-reset 也能算出等待时长', async () => {
    const waits: number[] = [];
    const resetAt = Math.floor(Date.now() / 1000) + 30;
    const f = vi.fn(async () =>
      res(403, '', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt) }),
    );

    await expect(
      new HttpClient({
        baseUrl: 'https://api.example.com/',
        fetchImpl: f as unknown as typeof fetch,
        sleepImpl: async (ms) => void waits.push(ms),
        maxRetries: 1,
      }).request({ path: 'x' }),
    ).rejects.toThrow();

    expect(waits[0]).toBeGreaterThan(25_000);
    expect(waits[0]).toBeLessThanOrEqual(30_000);
  });

  /** ★ 不可重试的错误立刻抛，不浪费三轮退避把 401 重试成 401 */
  it('★ 401 不重试', async () => {
    const f = vi.fn(async () => res(401));
    await expect(client(f as unknown as typeof fetch).request({ path: 'x' })).rejects.toThrow();
    expect(f).toHaveBeenCalledTimes(1);
  });

  /**
   * ★ 真实踩到过：GitHub 限流时 x-ratelimit-reset 在四十分钟之后，
   *   「听对方的 Retry-After」让同步请求原地睡了四十分钟 ——
   *   请求不返回、连接不释放、页面一直转圈。
   */
  it('★ 需要等待的时间超过上限时立刻放弃，并说明还要等多久', async () => {
    const waits: number[] = [];
    const resetAt = Math.floor(Date.now() / 1000) + 40 * 60;
    const f = vi.fn(async () =>
      res(403, '', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt) }),
    );

    try {
      await new HttpClient({
        baseUrl: 'https://api.example.com/',
        fetchImpl: f as unknown as typeof fetch,
        sleepImpl: async (ms) => void waits.push(ms),
        maxRetries: 3,
      }).request({ path: 'x' });
      throw new Error('应当抛错');
    } catch (e) {
      const err = e as HttpError;
      expect(err.kind).toBe('rate_limited');
      expect(err.message).toContain('分钟');
      expect(err.message).toContain('已停止重试');
      // 一次都没睡 —— 直接放弃，把等待时长交给调用方
      expect(waits).toEqual([]);
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it('上限之内照常退避', async () => {
    const waits: number[] = [];
    let n = 0;
    const f = vi.fn(async () => (++n < 2 ? res(429, '', { 'retry-after': '5' }) : res(200, '{}')));

    await new HttpClient({
      baseUrl: 'https://api.example.com/',
      fetchImpl: f as unknown as typeof fetch,
      sleepImpl: async (ms) => void waits.push(ms),
      maxBackoffMs: 30_000,
    }).request({ path: 'x' });

    expect(waits).toEqual([5000]);
  });

  it('重试时回调，供页面显示「同步降速中」', async () => {
    const seen: string[] = [];
    const f = vi.fn(async () => res(429));
    await expect(
      client(f as unknown as typeof fetch, {
        maxRetries: 2,
        onRetry: (i: { reason: string }) => seen.push(i.reason),
      }).request({ path: 'x' }),
    ).rejects.toThrow();
    expect(seen).toEqual(['rate_limited', 'rate_limited']);
  });
});

describe('请求构造', () => {
  it('路径与 baseUrl 正确拼接，query 参数带上', async () => {
    let seen = '';
    const f = vi.fn(async (url: string) => {
      seen = url;
      return res(200, '{}');
    });

    await client(f as unknown as typeof fetch).request({
      path: '/repos/a/b/pulls',
      query: { state: 'open', per_page: 50, cursor: undefined },
    });

    expect(seen).toBe('https://api.example.com/v1/repos/a/b/pulls?state=open&per_page=50');
    expect(seen).not.toContain('cursor');
  });

  it('带 body 时自动加 content-type', async () => {
    let headers: Record<string, string> = {};
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return res(200, '{}');
    });

    await client(f as unknown as typeof fetch).request({
      method: 'POST',
      path: 'x',
      json: { a: 1 },
    });
    expect(headers['content-type']).toBe('application/json');
  });

  /**
   * ★ Webhook 的 URL 是一个整体，多一个尾斜杠可能直接 404 ——
   *   而这种失败看起来像「webhook 配错了」，用户会去重新生成一个，
   *   然后发现还是不行。
   */
  it('★ path 为空时 baseUrl 原样用，不补尾斜杠', async () => {
    let seen = '';
    const f = vi.fn(async (url: string) => {
      seen = url;
      return res(200, 'ok');
    });

    await new HttpClient({
      baseUrl: 'https://hooks.slack.com/services/T000/B111/xyz',
      fetchImpl: f as unknown as typeof fetch,
    }).request({ method: 'POST', path: '', json: {}, raw: true });

    expect(seen).toBe('https://hooks.slack.com/services/T000/B111/xyz');
  });

  it('raw 模式原样返回文本，不做 JSON 解析', async () => {
    const f = vi.fn(async () => res(200, 'ok'));
    const out = await client(f as unknown as typeof fetch).request<string>({ path: 'x', raw: true });
    expect(out).toBe('ok');
  });

  it('204 不解析 body', async () => {
    const f = vi.fn(async () => res(204));
    await expect(client(f as unknown as typeof fetch).request({ path: 'x' })).resolves.toBeUndefined();
  });

  /** 网络层失败等同于服务不可达，可重试 —— 不是「请求写错了」*/
  it('网络异常归类为不可达并可重试', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const p = client(f as unknown as typeof fetch, { maxRetries: 0 }).request({ path: 'x' });
    await expect(p).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('超时给出可读原因', async () => {
    const f = vi.fn(async () => {
      throw new DOMException('The operation was aborted', 'TimeoutError');
    });
    try {
      await client(f as unknown as typeof fetch, { maxRetries: 0 }).request({ path: 'x' });
      throw new Error('应当抛错');
    } catch (e) {
      expect((e as HttpError).message).toContain('超时');
    }
  });
});
