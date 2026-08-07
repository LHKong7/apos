import type { IntegrationScopes, SyncField } from '@apos/contracts';
import { NEVER_GRANTED_SCOPES } from '@apos/contracts';
import type {
  ConnectionConfig,
  ExternalObject,
  IntegrationAdapter,
  TestResult,
} from '../adapter';
import { HttpClient, HttpError } from './client';

/**
 * GitHub 适配器（页面文档 14 §5.2）。
 *
 * ★ 外部对象是 **Pull Request**，不是 Issue。
 *   Work Item 在 APOS 里是「一件要做的事」，它在 GitHub 上的对应物是
 *   Agent 开出来的那个 PR —— 状态、CI 结果、评审意见全在 PR 上。
 *   映射到 Issue 的话，同步回来的是一个跟执行无关的讨论串。
 *
 * ★ 权限最小化：合并 PR 永远不在授予范围里（§5.2）。
 *   合并代码应当经过 Policy 判定，而不是让集成层直接放开 ——
 *   所以这个适配器**根本没有实现合并**，不是「实现了但默认关」。
 */
export class GitHubAdapter implements IntegrationAdapter {
  readonly provider = 'github' as const;

  constructor(
    private readonly deps: {
      baseUrl?: string;
      /** credentialRef → token。取不到时返回 null，走环境里的默认凭证 */
      resolveToken?: (ref: string | null) => string | null;
      fetchImpl?: typeof fetch;
      sleepImpl?: (ms: number) => Promise<void>;
      onRetry?: HttpClient extends never ? never : ConstructorParameters<typeof HttpClient>[0]['onRetry'];
    } = {},
  ) {}

  private http(conn: ConnectionConfig): HttpClient {
    const token = this.deps.resolveToken?.(conn.credentialRef) ?? null;
    return new HttpClient({
      baseUrl: this.deps.baseUrl ?? 'https://api.github.com',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'apos-integration',
        /**
         * ★ 没有 token 时不发 Authorization 头，而不是发一个空的。
         *   空 Bearer 会被 GitHub 当成无效凭证直接 401，
         *   而在某些部署里（比如带鉴权代理的环境）不带头反而是对的。
         */
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      fetchImpl: this.deps.fetchImpl,
      sleepImpl: this.deps.sleepImpl,
      onRetry: this.deps.onRetry,
      timeoutMs: 20_000,
    });
  }

  private repo(conn: ConnectionConfig): { owner: string; name: string } {
    const owner = String(conn.config['owner'] ?? '');
    const name = String(conn.config['repo'] ?? '');
    if (!owner || !name) throw new Error('GitHub 集成缺少 owner / repo 配置');
    return { owner, name };
  }

  async testConnection(conn: ConnectionConfig): Promise<TestResult> {
    const started = Date.now();
    try {
      const { owner, name } = this.repo(conn);
      const repo = await this.http(conn).request<GhRepo>({ path: `/repos/${owner}/${name}` });
      return {
        ok: true,
        message: repo.private ? '连接正常（私有仓库）' : '连接正常',
        displayName: repo.full_name,
        latencyMs: Date.now() - started,
      };
    } catch (e) {
      // ★ 失败原因要能直接展示给用户，而不是塞一个 stack 进去
      return { ok: false, message: readable(e), latencyMs: Date.now() - started };
    }
  }

  /**
   * 实际拿到的权限。
   *
   * ★ 从仓库的 `permissions` 字段推，而不是照抄一份静态清单 ——
   *   用户给的 token 可能只有只读权限，而页面上写着「✓ 创建 PR」，
   *   等到 Agent 真去开 PR 时才 403。授权页说的必须是真的。
   */
  async grantedScopes(conn: ConnectionConfig): Promise<IntegrationScopes> {
    const denied = [...NEVER_GRANTED_SCOPES.github];
    try {
      const { owner, name } = this.repo(conn);
      const repo = await this.http(conn).request<GhRepo>({ path: `/repos/${owner}/${name}` });
      const p = repo.permissions ?? {};

      const allowed = ['read_code', 'read_ci'];
      if (p.push) allowed.push('create_branch', 'create_pr', 'comment_pr');
      else denied.push('create_branch', 'create_pr', 'comment_pr');

      return { allowed, denied };
    } catch {
      // 探测不到就只声明只读 —— 宁可少说，不能多说
      return { allowed: ['read_code', 'read_ci'], denied };
    }
  }

  async fetchObject(conn: ConnectionConfig, externalKey: string): Promise<ExternalObject | null> {
    const { owner, name } = this.repo(conn);
    const number = prNumber(externalKey);
    const http = this.http(conn);

    let pr: GhPull;
    try {
      pr = await http.request<GhPull>({ path: `/repos/${owner}/${name}/pulls/${number}` });
    } catch (e) {
      /**
       * ★ 404 是「外部对象没了」，不是「同步失败」。
       *   当成失败会让整轮同步中断并把集成标成异常，
       *   而实际上只有这一个对象被删了（§11 要求本地打标、不删数据）。
       */
      if (e instanceof HttpError && e.kind === 'not_found') {
        return { externalKey, url: null, fields: {}, lastChange: null, deleted: true };
      }
      throw e;
    }

    const comments = await http
      .request<GhComment[]>({
        path: `/repos/${owner}/${name}/issues/${number}/comments`,
        query: { per_page: 100 },
      })
      .catch(() => [] as GhComment[]);

    return {
      externalKey,
      url: pr.html_url,
      fields: {
        status: mapPrState(pr),
        requirement_content: pr.body ?? '',
        assignee: pr.assignee?.login ?? null,
        comments: comments.map((c) => ({
          externalId: `gh:${c.id}`,
          createdAt: c.created_at,
          author: c.user?.login ?? 'unknown',
          body: c.body,
        })),
      },
      /**
       * ★ 来源标记藏在 PR body 里。
       *   GitHub 没有「自定义字段」，而标记必须落在下次读得回来的地方 ——
       *   写进 commit message 或 label 都会被人清掉，body 是最稳的。
       */
      lastChange: {
        originTag: readOriginTag(pr.body ?? ''),
        by: pr.user?.login ?? 'unknown',
        at: pr.updated_at,
      },
    };
  }

  async listObjects(conn: ConnectionConfig, limit: number): Promise<ExternalObject[]> {
    const { owner, name } = this.repo(conn);
    const pulls = await this.http(conn).request<GhPull[]>({
      path: `/repos/${owner}/${name}/pulls`,
      query: { state: 'all', per_page: Math.min(limit, 100), sort: 'updated', direction: 'desc' },
    });

    return pulls.slice(0, limit).map((pr) => ({
      externalKey: `#${pr.number}`,
      url: pr.html_url,
      fields: {
        status: mapPrState(pr),
        requirement_content: pr.body ?? '',
        assignee: pr.assignee?.login ?? null,
      },
      lastChange: {
        originTag: readOriginTag(pr.body ?? ''),
        by: pr.user?.login ?? 'unknown',
        at: pr.updated_at,
      },
    }));
  }

  async writeField(
    conn: ConnectionConfig,
    externalKey: string,
    field: SyncField,
    value: unknown,
    originTag: string,
  ): Promise<void> {
    const { owner, name } = this.repo(conn);
    const number = prNumber(externalKey);
    const http = this.http(conn);

    switch (field) {
      case 'requirement_content': {
        await http.request({
          method: 'PATCH',
          path: `/repos/${owner}/${name}/pulls/${number}`,
          json: { body: withOriginTag(String(value ?? ''), originTag) },
        });
        return;
      }

      case 'comments': {
        // 评论是追加语义：只发本地新增的那些，不是整段覆盖
        const rows = Array.isArray(value) ? value : [];
        for (const c of rows) {
          const row = c as Record<string, unknown>;
          if (String(row['externalId'] ?? '').startsWith('gh:')) continue;
          await http.request({
            method: 'POST',
            path: `/repos/${owner}/${name}/issues/${number}/comments`,
            json: { body: withOriginTag(String(row['body'] ?? ''), originTag) },
          });
        }
        return;
      }

      case 'status': {
        /**
         * ★ 状态只回写「关闭」，而且**永远不合并**。
         *   把 APOS 的 done 映射成 merge 是这个适配器最危险的一条路径：
         *   合并代码必须经过 Policy 判定（§5.2），集成层直接放开就绕过了它。
         *   所以这里根本没有合并的代码路径 —— 不是默认关，是不存在。
         */
        const state = String(value) === 'cancelled' ? 'closed' : null;
        if (!state) return;
        await http.request({
          method: 'PATCH',
          path: `/repos/${owner}/${name}/pulls/${number}`,
          json: { state },
        });
        return;
      }

      default:
        // 负责人 / 截止时间在 GitHub 上没有对应物，静默跳过而不是报错
        return;
    }
  }

  /**
   * 拉取 PR 头部提交的 CI 结论（页面文档 12「质量」Tab 的数据源）。
   *
   * ★ 这是 Analytics 质量 Tab 一直缺的那一块。以前「自动测试通过率」
   *   算不出来不是因为算法难，是因为**没有任何东西在写 qualityGate**。
   *   Policy 引擎读它、看板显示它，但从来没有人填过。
   */
  async fetchCiResult(conn: ConnectionConfig, externalKey: string): Promise<CiResult | null> {
    const { owner, name } = this.repo(conn);
    const number = prNumber(externalKey);
    const http = this.http(conn);

    const pr = await http
      .request<GhPull>({ path: `/repos/${owner}/${name}/pulls/${number}` })
      .catch(() => null);
    if (!pr) return null;

    const runs = await http
      .request<{ check_runs: GhCheckRun[] }>({
        path: `/repos/${owner}/${name}/commits/${pr.head.sha}/check-runs`,
        query: { per_page: 100 },
      })
      .catch(() => null);
    if (!runs || runs.check_runs.length === 0) return null;

    const finished = runs.check_runs.filter((r) => r.status === 'completed');
    const failed = finished.filter((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out');

    return {
      sha: pr.head.sha,
      total: runs.check_runs.length,
      completed: finished.length,
      failed: failed.length,
      /** 有未完成的检查时不下结论 —— 半路的 CI 说明不了通过与否 */
      passed: finished.length === runs.check_runs.length ? failed.length === 0 : null,
      failedChecks: failed.map((r) => r.name),
      coverage: extractCoverage(runs.check_runs),
    };
  }
}

export interface CiResult {
  sha: string;
  total: number;
  completed: number;
  failed: number;
  passed: boolean | null;
  failedChecks: string[];
  /** 从 check run 的 output 里抓覆盖率百分比；抓不到就是 null，不猜 */
  coverage: number | null;
}

/**
 * 覆盖率没有标准字段，各家 CI 写法不同。
 *
 * ★ 只认「明确写出百分比」的那几种常见格式，抓不到就返回 null。
 *   蒙一个数比没有数更糟：覆盖率趋势图上一条编出来的线，
 *   会让人真的据此判断「质量在变好」。
 */
export function extractCoverage(runs: GhCheckRun[]): number | null {
  for (const r of runs) {
    const text = `${r.output?.title ?? ''} ${r.output?.summary ?? ''}`;
    const m = text.match(/(?:coverage|覆盖率)[^\d]{0,12}(\d{1,3}(?:\.\d+)?)\s*%/i);
    if (m?.[1]) {
      const n = Number(m[1]);
      if (n >= 0 && n <= 100) return n;
    }
  }
  return null;
}

/**
 * PR 状态 → Work Item 状态。
 *
 * ★ merged 和 closed 是两件事：前者是做完了，后者是放弃了。
 *   GitHub 把它们放在同一个 state 字段里（都是 closed），
 *   只看 state 会把「被放弃的 PR」同步成「任务已完成」。
 */
export function mapPrState(pr: Pick<GhPull, 'state' | 'merged_at' | 'draft'>): string {
  if (pr.merged_at) return 'done';
  if (pr.state === 'closed') return 'cancelled';
  if (pr.draft) return 'executing';
  return 'reviewing';
}

const ORIGIN_MARK = '<!-- apos-origin:';

export function withOriginTag(body: string, originTag: string): string {
  const stripped = body.replace(new RegExp(`\\n?${ORIGIN_MARK}[^>]*-->`, 'g'), '');
  return `${stripped}\n${ORIGIN_MARK}${originTag} -->`;
}

export function readOriginTag(body: string): string | null {
  const m = body.match(/<!-- apos-origin:([^\s]+) -->/);
  return m?.[1] ?? null;
}

function prNumber(externalKey: string): number {
  const n = Number(externalKey.replace(/^#/, ''));
  if (!Number.isInteger(n)) throw new Error(`不是合法的 PR 编号: ${externalKey}`);
  return n;
}

function readable(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  return e instanceof Error ? e.message : '连接失败';
}

interface GhRepo {
  full_name: string;
  private: boolean;
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
}

interface GhPull {
  number: number;
  state: string;
  draft?: boolean;
  merged_at: string | null;
  title: string;
  body: string | null;
  html_url: string;
  updated_at: string;
  user: { login: string } | null;
  assignee: { login: string } | null;
  head: { sha: string };
}

interface GhComment {
  id: number;
  body: string;
  created_at: string;
  user: { login: string } | null;
}

export interface GhCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  output?: { title?: string | null; summary?: string | null };
}
