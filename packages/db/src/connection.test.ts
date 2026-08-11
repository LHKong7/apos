import { describe, expect, it } from 'vitest';
import { inspectConnection, toConnectionUrl } from './connection';

/** 从 Supabase 控制台「Connection string」里原样复制出来的三种形态 */
const SUPABASE = {
  direct: 'postgresql://postgres:pw@db.abcdefghijklm.supabase.co:5432/postgres',
  session:
    'postgresql://postgres.abcdefghijklm:pw@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?supa=base-pooler.x',
  transaction:
    'postgresql://postgres.abcdefghijklm:pw@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?supa=base-pooler.x',
};

describe('连接串解析', () => {
  /**
   * ★★ 这条是「兼容」两个字的全部意义所在。
   *
   *   接 Supabase 的改动一旦顺手改了本机的默认行为，代价是所有人的开发环境
   *   都要跟着调 —— 而这种改动通常没人写进 changelog，下一个 clone 仓库的人
   *   只会遇到一个跑不起来的项目。
   */
  it('本机连接串原样透传，行为与改造前一致', () => {
    const shape = inspectConnection('postgres://apos@localhost:5433/apos');

    expect(shape.url).toBe('postgres://apos@localhost:5433/apos');
    expect(shape.mode).toBe('direct');
    expect(shape.prepare).toBe(true); // postgres.js 的默认值
    expect(shape.ssl).toBeUndefined(); // 本机不上 TLS
    expect(shape.strippedParams).toEqual([]);
  });

  /**
   * ★★ 整个模块最要紧的一条。判错的表现是**偶发**的
   *   `prepared statement "s1" does not exist` —— 空闲时复用同一条后端连接
   *   所以本地怎么点都是好的，等线上有并发了才开始随机失败。
   */
  it('Transaction Pooler（:6543）必须关掉预编译语句', () => {
    const shape = inspectConnection(SUPABASE.transaction);

    expect(shape.mode).toBe('pooled-transaction');
    expect(shape.prepare).toBe(false);
  });

  it('Session Pooler（:5432）可以用预编译语句', () => {
    const shape = inspectConnection(SUPABASE.session);

    expect(shape.mode).toBe('pooled-session');
    expect(shape.prepare).toBe(true);
  });

  it('Supabase 直连按直连处理，预编译语句可用', () => {
    const shape = inspectConnection(SUPABASE.direct);

    expect(shape.mode).toBe('direct');
    expect(shape.prepare).toBe(true);
  });

  /**
   * ★★ 不剥掉的话，postgres.js 会把 `supa` 当成 Postgres 的启动参数发出去，
   *   服务端回一句 `unrecognized configuration parameter "supa"`。
   *   报错发生在 TCP 连上之后，看起来像「数据库拒绝了我们」，
   *   而连接串是从官方控制台复制的、看上去完全正常。
   */
  it('剥掉 Supabase 控制台带的 supa 参数，否则建连会被服务端顶回来', () => {
    const shape = inspectConnection(SUPABASE.transaction);

    expect(shape.url).not.toContain('supa=');
    expect(shape.strippedParams).toContain('supa');
    // 剥的是参数，不是连接串本身
    expect(shape.url).toContain('aws-0-ap-northeast-1.pooler.supabase.com:6543');
    expect(shape.url).toContain('/postgres');
  });

  it('剥掉 Prisma 风格的客户端参数', () => {
    const shape = inspectConnection(
      'postgresql://u:p@host.pooler.supabase.com:5432/db?connection_limit=1&pool_timeout=0',
    );

    expect(shape.strippedParams.sort()).toEqual(['connection_limit', 'pool_timeout']);
    expect(shape.url).not.toContain('connection_limit');
  });

  /**
   * ★ 真正的启动参数不能误伤 —— 剥错了的表现是「连上了，但 search_path 没生效」，
   *   比连不上难查得多。
   */
  it('不碰真正的服务端启动参数', () => {
    const shape = inspectConnection(
      'postgres://apos@localhost:5433/apos?application_name=apos-api&options=-c%20statement_timeout%3D5s',
    );

    expect(shape.strippedParams).toEqual([]);
    expect(shape.url).toContain('application_name=apos-api');
    expect(shape.url).toContain('options=');
  });

  describe('TLS', () => {
    it('连 Supabase 自动上 TLS —— 它不接受明文连接', () => {
      expect(inspectConnection(SUPABASE.direct).ssl).toBe('require');
      expect(inspectConnection(SUPABASE.session).ssl).toBe('require');
      expect(inspectConnection(SUPABASE.transaction).ssl).toBe('require');
    });

    /**
     * ★★ postgres.js 的选项对象**盖过**连接串。所以这里一旦无条件传 ssl，
     *   用户写的 `sslmode=verify-full` 会被静默降级成不校验证书 ——
     *   一个「配了但没生效」的安全问题，且没有任何提示。
     */
    it('连接串里写了 sslmode 就完全不插手，不把 verify-full 降级掉', () => {
      const shape = inspectConnection(`${SUPABASE.direct}?sslmode=verify-full`);

      expect(shape.ssl).toBeUndefined();
      expect(shape.url).toContain('sslmode=verify-full');
    });

    it('toConnectionUrl 把 TLS 压回连接串，给只认 url 的工具用', () => {
      const url = toConnectionUrl(inspectConnection(SUPABASE.direct));
      expect(url).toContain('sslmode=require');

      // 本机不该被塞上 sslmode
      const local = toConnectionUrl(inspectConnection('postgres://apos@localhost:5433/apos'));
      expect(local).toBe('postgres://apos@localhost:5433/apos');
    });
  });

  describe('显式覆盖', () => {
    it('pgbouncer=true 认作 transaction 模式，端口不是 6543 也算', () => {
      const shape = inspectConnection('postgres://u:p@my-pgbouncer.internal:5432/db?pgbouncer=true');

      expect(shape.mode).toBe('pooled-transaction');
      expect(shape.prepare).toBe(false);
      expect(shape.strippedParams).toContain('pgbouncer');
      expect(new URL(shape.url).searchParams.has('pgbouncer')).toBe(false);
    });

    it('prepare=false 能手工关掉，给自建连接池用', () => {
      const shape = inspectConnection('postgres://apos@localhost:5433/apos?prepare=false');

      expect(shape.prepare).toBe(false);
      expect(shape.url).not.toContain('prepare');
    });

    it('prepare=true 能盖过自动判定 —— 判定错了要有逃生口', () => {
      const shape = inspectConnection(`${SUPABASE.transaction}&prepare=true`);

      expect(shape.mode).toBe('pooled-transaction');
      expect(shape.prepare).toBe(true);
    });
  });

  /**
   * ★ 因为一个没见过的连接串形态把进程拦死是越权。真连不上的话，
   *   报错会来自建连那一步，那里的信息比这里准确得多。
   */
  it('解析不了的连接串原样透传，不抛错', () => {
    const shape = inspectConnection('this-is-not-a-url');

    expect(shape.url).toBe('this-is-not-a-url');
    expect(shape.prepare).toBe(true);
  });

  it('summary 里说得清判定结果，出了事能对着日志核', () => {
    expect(inspectConnection(SUPABASE.transaction).summary).toBe(
      'aws-0-ap-northeast-1.pooler.supabase.com:6543 Transaction Pooler，TLS(自动)，预编译语句关，已忽略客户端参数 supa',
    );
    expect(inspectConnection('postgres://apos@localhost:5433/apos').summary).toBe(
      'localhost:5433 直连，明文，预编译语句开',
    );
  });
});
