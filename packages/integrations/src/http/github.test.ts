import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectionConfig } from '../adapter';
import {
  GitHubAdapter,
  extractCoverage,
  mapPrState,
  readOriginTag,
  withOriginTag,
} from './github';

/**
 * GitHub 适配器。
 *
 * ★ 用一个真的 HTTP 服务器做契约测试，不是 mock fetch。
 *   mock fetch 测的是「我以为我发了什么」，起一个服务器测的是
 *   「线上真的收到了什么」—— URL 拼错、header 少一个、
 *   body 序列化方式不对，只有后者会暴露。
 */

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

let server: Server;
let baseUrl = '';
const recorded: Recorded[] = [];
let handler: (req: Recorded) => { status: number; body: unknown; headers?: Record<string, string> };

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const rec: Recorded = {
        method: req.method ?? 'GET',
        url: req.url ?? '',
        headers: req.headers as Record<string, string>,
        body,
      };
      recorded.push(rec);
      const out = handler(rec);
      res.writeHead(out.status, { 'content-type': 'application/json', ...out.headers });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const CONN: ConnectionConfig = {
  config: { owner: 'acme', repo: 'order-service' },
  credentialRef: 'secret://local/abc',
};

function adapter() {
  return new GitHubAdapter({
    baseUrl,
    resolveToken: () => 'ghp_testtoken',
    sleepImpl: async () => {},
  });
}

function pull(over: Record<string, unknown> = {}) {
  return {
    number: 37,
    state: 'open',
    draft: false,
    merged_at: null,
    title: '实现多条件查询',
    body: '按设计实现',
    html_url: 'https://github.com/acme/order-service/pull/37',
    updated_at: '2026-08-07T10:00:00Z',
    user: { login: 'code-agent-1' },
    assignee: { login: 'zhangwei' },
    head: { sha: 'abc123' },
    ...over,
  };
}

describe('请求契约', () => {
  it('★ 打到正确的 URL，并带上 GitHub 要求的三个头', async () => {
    recorded.length = 0;
    handler = () => ({ status: 200, body: { full_name: 'acme/order-service', private: false } });

    const r = await adapter().testConnection(CONN);

    expect(r.ok).toBe(true);
    expect(r.displayName).toBe('acme/order-service');
    const req = recorded[0]!;
    expect(req.url).toBe('/repos/acme/order-service');
    expect(req.headers['authorization']).toBe('Bearer ghp_testtoken');
    expect(req.headers['accept']).toBe('application/vnd.github+json');
    expect(req.headers['x-github-api-version']).toBe('2022-11-28');
  });

  /**
   * ★ 没有 token 时不能发一个空的 Authorization 头 ——
   *   空 Bearer 会被直接 401，而在带鉴权代理的环境里不带头才是对的。
   */
  it('★ 没有 token 时不发 Authorization 头', async () => {
    recorded.length = 0;
    handler = () => ({ status: 200, body: { full_name: 'a/b', private: false } });

    await new GitHubAdapter({ baseUrl, resolveToken: () => null }).testConnection(CONN);
    expect(recorded[0]!.headers['authorization']).toBeUndefined();
  });

  it('连接失败时返回可读原因，而不是抛异常', async () => {
    handler = () => ({ status: 401, body: { message: 'Bad credentials' } });
    const r = await adapter().testConnection(CONN);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('重新授权');
  });
});

describe('授权范围', () => {
  /**
   * ★ 从仓库真实的 permissions 推，不照抄静态清单。
   *   token 只读却在页面上写「✓ 创建 PR」，等 Agent 真去开 PR 时才 403。
   */
  it('★ 只读 token 不会声称能创建 PR', async () => {
    handler = () => ({
      status: 200,
      body: { full_name: 'a/b', private: false, permissions: { pull: true, push: false } },
    });

    const s = await adapter().grantedScopes(CONN);
    expect(s.allowed).toContain('read_code');
    expect(s.allowed).not.toContain('create_pr');
    expect(s.denied).toContain('create_pr');
  });

  it('有写权限时才声明能创建 PR', async () => {
    handler = () => ({
      status: 200,
      body: { full_name: 'a/b', private: false, permissions: { pull: true, push: true } },
    });
    const s = await adapter().grantedScopes(CONN);
    expect(s.allowed).toContain('create_pr');
  });

  /**
   * ★ 探测失败时标出「这是兜底不是事实」。
   *
   *   真实跑过一次限流之后拿到的就是这份只读清单，而页面把它当事实
   *   显示成「✗ 创建 PR」，用户会跑去找管理员要权限 ——
   *   而真相是刚才那次探测被限流了。
   *   不加这个标记，「不知道」和「确实没有」在界面上长得一模一样。
   */
  it('★ 探测失败时按只读兜底，但标明 probed=false', async () => {
    handler = () => ({ status: 429, body: {} });
    const s = await adapter().grantedScopes(CONN);

    expect(s.probed).toBe(false);
    expect(s.allowed).toEqual(['read_code', 'read_ci']);
    // 兜底也绝不放开禁止项
    expect(s.denied).toContain('merge_pr');
  });

  it('探测成功时 probed=true', async () => {
    handler = () => ({
      status: 200,
      body: { full_name: 'a/b', private: false, permissions: { pull: true, push: true } },
    });
    expect((await adapter().grantedScopes(CONN)).probed).toBe(true);
  });

  /** ★ 合并 PR 永远在禁止项里，与 token 权限无关 */
  it('★ 即便 token 是 admin，合并 PR 仍在禁止项', async () => {
    handler = () => ({
      status: 200,
      body: { full_name: 'a/b', private: false, permissions: { admin: true, push: true } },
    });
    const s = await adapter().grantedScopes(CONN);
    expect(s.denied).toContain('merge_pr');
    expect(s.allowed).not.toContain('merge_pr');
  });
});

describe('PR → Work Item 字段映射', () => {
  it('拉取 PR 与评论，映射成同步字段', async () => {
    handler = (req) =>
      req.url.includes('/comments')
        ? {
            status: 200,
            body: [
              { id: 9, body: '看起来没问题', created_at: '2026-08-07T09:00:00Z', user: { login: 'lina' } },
            ],
          }
        : { status: 200, body: pull() };

    const obj = await adapter().fetchObject(CONN, '#37');

    expect(obj!.fields.status).toBe('reviewing');
    expect(obj!.fields.assignee).toBe('zhangwei');
    expect(obj!.url).toContain('/pull/37');
    const comments = obj!.fields.comments as { externalId: string; author: string }[];
    expect(comments[0]).toMatchObject({ externalId: 'gh:9', author: 'lina' });
  });

  /**
   * ★ merged 和 closed 是两件事：前者做完了，后者放弃了。
   *   GitHub 把它们塞在同一个 state 里，只看 state 会把
   *   「被放弃的 PR」同步成「任务已完成」。
   */
  it('★ 已合并 → done，被关闭未合并 → cancelled', () => {
    expect(mapPrState({ state: 'closed', merged_at: '2026-08-07T00:00:00Z' })).toBe('done');
    expect(mapPrState({ state: 'closed', merged_at: null })).toBe('cancelled');
    expect(mapPrState({ state: 'open', merged_at: null, draft: true })).toBe('executing');
    expect(mapPrState({ state: 'open', merged_at: null })).toBe('reviewing');
  });

  /**
   * ★ 404 是「外部对象没了」，不是「同步失败」。
   *   当成失败会中断整轮同步并把集成标成异常，
   *   而实际上只有这一个对象被删了。
   */
  it('★ PR 被删 → 标记 deleted，不抛错', async () => {
    handler = () => ({ status: 404, body: { message: 'Not Found' } });
    const obj = await adapter().fetchObject(CONN, '#404');
    expect(obj!.deleted).toBe(true);
  });

  it('评论接口挂了不影响主字段同步', async () => {
    handler = (req) =>
      req.url.includes('/comments')
        ? { status: 500, body: {} }
        : { status: 200, body: pull() };

    const obj = await adapter().fetchObject(CONN, '#37');
    expect(obj!.fields.status).toBe('reviewing');
    expect(obj!.fields.comments).toEqual([]);
  });
});

describe('回写与来源标记', () => {
  /**
   * ★ 标记必须落在下次读得回来的地方。GitHub 没有自定义字段，
   *   写进 commit message 或 label 都会被人清掉，body 是最稳的。
   */
  it('★ 回写 body 时带上来源标记，且能读回来', async () => {
    recorded.length = 0;
    handler = () => ({ status: 200, body: pull() });

    await adapter().writeField(CONN, '#37', 'requirement_content', '新的描述', 'apos:proj-1');

    const sent = JSON.parse(recorded[0]!.body) as { body: string };
    expect(sent.body).toContain('新的描述');
    expect(readOriginTag(sent.body)).toBe('apos:proj-1');
  });

  it('重复回写不会堆叠标记', () => {
    const once = withOriginTag('正文', 'apos:p1');
    const twice = withOriginTag(once, 'apos:p1');
    expect(twice.match(/apos-origin/g)).toHaveLength(1);
    expect(twice).toContain('正文');
  });

  it('评论是追加语义，已经从 GitHub 拉回来的那些不再发一遍', async () => {
    recorded.length = 0;
    handler = () => ({ status: 201, body: {} });

    await adapter().writeField(
      CONN,
      '#37',
      'comments',
      [
        { externalId: 'gh:9', body: '这是从 GitHub 拉回来的' },
        { externalId: 'apos:1', body: 'APOS 这边新增的' },
      ],
      'apos:p1',
    );

    expect(recorded).toHaveLength(1);
    expect(JSON.parse(recorded[0]!.body).body).toContain('APOS 这边新增的');
  });

  /**
   * ★ 这是整个适配器最危险的一条路径：把 done 映射成 merge。
   *   合并代码必须经过 Policy 判定，集成层直接放开就绕过了它 ——
   *   所以合并的代码路径根本不存在，不是默认关。
   */
  it('★ 状态回写永远不会触发合并', async () => {
    recorded.length = 0;
    handler = () => ({ status: 200, body: pull() });

    await adapter().writeField(CONN, '#37', 'status', 'done', 'apos:p1');
    await adapter().writeField(CONN, '#37', 'status', 'released', 'apos:p1');

    // done / released 都不产生任何请求 —— 更不会打到 /merge
    expect(recorded).toHaveLength(0);
  });

  it('取消的任务把 PR 关掉（不是合并）', async () => {
    recorded.length = 0;
    handler = () => ({ status: 200, body: pull() });

    await adapter().writeField(CONN, '#37', 'status', 'cancelled', 'apos:p1');

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.url).not.toContain('merge');
    expect(JSON.parse(recorded[0]!.body)).toEqual({ state: 'closed' });
  });

  it('GitHub 上没有对应物的字段静默跳过', async () => {
    recorded.length = 0;
    handler = () => ({ status: 200, body: {} });
    await adapter().writeField(CONN, '#37', 'due_date', '2026-09-01', 'apos:p1');
    expect(recorded).toHaveLength(0);
  });
});

describe('CI 结果（质量 Tab 的数据源）', () => {
  it('全部检查完成且无失败 → passed', async () => {
    handler = (req) =>
      req.url.includes('check-runs')
        ? {
            status: 200,
            body: {
              check_runs: [
                { name: 'unit', status: 'completed', conclusion: 'success' },
                { name: 'lint', status: 'completed', conclusion: 'success' },
              ],
            },
          }
        : { status: 200, body: pull() };

    const ci = await adapter().fetchCiResult(CONN, '#37');
    expect(ci).toMatchObject({ passed: true, total: 2, failed: 0, sha: 'abc123' });
  });

  it('有失败的检查 → passed=false，并列出是哪几个', async () => {
    handler = (req) =>
      req.url.includes('check-runs')
        ? {
            status: 200,
            body: {
              check_runs: [
                { name: 'unit', status: 'completed', conclusion: 'failure' },
                { name: 'lint', status: 'completed', conclusion: 'success' },
              ],
            },
          }
        : { status: 200, body: pull() };

    const ci = await adapter().fetchCiResult(CONN, '#37');
    expect(ci!.passed).toBe(false);
    expect(ci!.failedChecks).toEqual(['unit']);
  });

  /** ★ 半路的 CI 说明不了通过与否，不下结论比猜一个好 */
  it('★ 还有检查没跑完时不下结论（passed = null）', async () => {
    handler = (req) =>
      req.url.includes('check-runs')
        ? {
            status: 200,
            body: {
              check_runs: [
                { name: 'unit', status: 'completed', conclusion: 'success' },
                { name: 'e2e', status: 'in_progress', conclusion: null },
              ],
            },
          }
        : { status: 200, body: pull() };

    const ci = await adapter().fetchCiResult(CONN, '#37');
    expect(ci!.passed).toBeNull();
  });

  it('没有任何检查时返回 null —— 这个仓库没接 CI', async () => {
    handler = (req) =>
      req.url.includes('check-runs')
        ? { status: 200, body: { check_runs: [] } }
        : { status: 200, body: pull() };

    expect(await adapter().fetchCiResult(CONN, '#37')).toBeNull();
  });
});

describe('覆盖率抽取', () => {
  it('从 check run 的 output 里抓百分比', () => {
    expect(
      extractCoverage([
        { name: 'test', status: 'completed', conclusion: 'success', output: { summary: 'Coverage: 87.4%' } },
      ]),
    ).toBe(87.4);
    expect(
      extractCoverage([
        { name: 'test', status: 'completed', conclusion: 'success', output: { title: '覆盖率 72%' } },
      ]),
    ).toBe(72);
  });

  /**
   * ★ 抓不到就返回 null，绝不蒙一个。
   *   覆盖率趋势图上一条编出来的线，会让人真的据此判断「质量在变好」。
   */
  it('★ 抓不到覆盖率时返回 null，不猜', () => {
    expect(extractCoverage([{ name: 'lint', status: 'completed', conclusion: 'success' }])).toBeNull();
    expect(
      extractCoverage([
        { name: 'x', status: 'completed', conclusion: 'success', output: { summary: '3 tests passed' } },
      ]),
    ).toBeNull();
  });

  it('超出 0–100 的数不当作覆盖率', () => {
    expect(
      extractCoverage([
        { name: 'x', status: 'completed', conclusion: 'success', output: { summary: 'coverage 250%' } },
      ]),
    ).toBeNull();
  });
});
