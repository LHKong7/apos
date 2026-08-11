/**
 * 连接串解析 —— 让同一个连接串在本机 Postgres 与 Supabase 上都能直接用。
 *
 * ★ 这个模块**不 import drizzle / postgres**，是纯字符串逻辑。
 *   drizzle.config.ts 与启动日志都要用它，而 drizzle-kit 加载配置时
 *   把整个 ORM 连带拖进来纯属白花。
 */

/**
 * 连接形态。
 *
 * | 形态 | 典型来源 | 预编译语句 |
 * | --- | --- | --- |
 * | `direct` | 本机 / docker-compose 的 Postgres、Supabase 直连 | 可用 |
 * | `pooled-session` | Supabase Session Pooler（:5432） | 可用 |
 * | `pooled-transaction` | Supabase Transaction Pooler（:6543）、PgBouncer | **不可用** |
 */
export type ConnectionMode = 'direct' | 'pooled-session' | 'pooled-transaction';

export interface ConnectionShape {
  mode: ConnectionMode;
  /** 剥掉客户端专用参数之后、真正交给 postgres.js 的连接串 */
  url: string;
  /** postgres.js 的 prepare 开关 */
  prepare: boolean;
  /**
   * 需要**显式**传给 postgres.js 的 ssl 选项。
   * `undefined` 表示不插手 —— 要么连接串里已经写了 sslmode（由它自己解析），
   * 要么就是本机明文连接。
   */
  ssl: 'require' | undefined;
  host: string;
  port: number;
  /** 被剥掉的参数名。启动日志里要说一声，免得有人以为它生效了 */
  strippedParams: string[];
  /** 一行人话，给启动日志用 */
  summary: string;
}

/**
 * 客户端专用参数 —— 它们不是 Postgres 的启动参数。
 *
 * ★★ postgres.js 会把连接串里所有它不认识的查询参数**原样当作启动参数**
 *   发给服务端（postgres/src/index.js `parseOptions` 末尾拼 `connection` 那一段）。
 *   而从 Supabase 控制台复制来的连接串长这样：
 *
 *     postgresql://postgres.xxx:pw@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?supa=base-pooler.x
 *
 *   那个 `supa=base-pooler.x` 会让服务端在建连时回一句
 *   `unrecognized configuration parameter "supa"`。★ 这个错发生在 TCP 已经连上
 *   **之后**，表现为「数据库把我们拒了」，而连接串看上去完全正常 ——
 *   没有人会怀疑到 URL 尾巴上那个参数头上。
 *
 *   列进来的都是各家工具的既定约定（Supabase 的 `supa`、Prisma 的
 *   `pgbouncer` / `connection_limit` / `pool_timeout`），剥掉它们，
 *   「从控制台复制粘贴」这条最常走的路就直接能用。
 *
 * ★ 不用白名单：真正的启动参数（`options`、`application_name`、`search_path`…）
 *   是开放集合，白名单会把合法用法误杀成「连上了但 search_path 没生效」。
 */
const CLIENT_ONLY_PARAMS = new Set([
  'supa',
  'pgbouncer',
  'connection_limit',
  'pool_timeout',
  'prepare',
]);

/** Supavisor 的 transaction 模式端口。session 模式与直连都是 5432 */
const TRANSACTION_POOLER_PORT = 6543;

/** 走这些域名一律上 TLS —— Supabase 不接受明文连接 */
const TLS_REQUIRED_SUFFIXES = ['.pooler.supabase.com', '.supabase.co', '.supabase.com'];

/**
 * 从连接串推断出连接形态。
 *
 * ★★ 这里最要紧的一件事是 `prepare`。Supabase 的 Transaction Pooler 每条语句
 *   都可能落在不同的后端连接上，而预编译语句是**绑在连接上**的 —— 于是
 *   `PREPARE` 在 A 连接上做、`EXECUTE` 掉到 B 连接上，服务端报
 *   `prepared statement "s1" does not exist`。
 *
 *   ★ 它的恶劣之处在于**不是必现**：池子空闲时前几条查询很可能复用同一条
 *   后端连接，一切正常；等并发上来才开始随机失败。也就是说本地连上 Supabase
 *   点两下页面是测不出来的，它专门等到有真实负载之后才炸。
 *
 * 导出出来是为了让启动日志能把判定结果说清楚（见 apps/api/src/main.ts）——
 * 判定错了要能一眼看出来，而不是等线上随机报错才回头翻代码。
 */
export function inspectConnection(rawUrl: string): ConnectionShape {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    /**
     * ★ 解析不了就原样透传，不抛错。postgres.js 自己还有一套更宽松的解析，
     *   这里因为一个没见过的连接串形态把进程拦死是越权 —— 真连不上的话，
     *   报错会来自建连那一步，那里的信息比这里准确得多。
     */
    return {
      mode: 'direct',
      url: rawUrl,
      prepare: true,
      ssl: undefined,
      host: '',
      port: 0,
      strippedParams: [],
      summary: '连接串无法按 URL 解析，按直连处理（预编译语句开）',
    };
  }

  const host = url.hostname;
  const port = Number(url.port) || 5432;

  // 剥掉客户端专用参数，顺带把其中两个当作显式意图读出来
  const strippedParams: string[] = [];
  let prepareOverride: boolean | undefined;
  let pgbouncerFlag = false;
  for (const name of [...url.searchParams.keys()]) {
    if (!CLIENT_ONLY_PARAMS.has(name)) continue;
    const value = url.searchParams.get(name);
    if (name === 'prepare') prepareOverride = !isFalsy(value);
    if (name === 'pgbouncer') pgbouncerFlag = !isFalsy(value);
    url.searchParams.delete(name);
    strippedParams.push(name);
  }

  const mode: ConnectionMode =
    port === TRANSACTION_POOLER_PORT || pgbouncerFlag
      ? 'pooled-transaction'
      : host.endsWith('.pooler.supabase.com')
        ? 'pooled-session'
        : 'direct';

  const prepare = prepareOverride ?? mode !== 'pooled-transaction';

  /**
   * ★ 连接串里写了 sslmode 就完全不插手：显式配置优先于我们的推断。
   *   注意 postgres.js 的选项对象**盖过**连接串（parseOptions 里 `k in o` 先判），
   *   所以这里一旦无条件传 ssl，用户写的 `?sslmode=verify-full` 会被静默降级成
   *   不校验证书 —— 一个「配了但没生效」的安全问题。
   */
  const hasSslMode = url.searchParams.has('sslmode');
  const ssl =
    !hasSslMode && TLS_REQUIRED_SUFFIXES.some((suffix) => host.endsWith(suffix))
      ? ('require' as const)
      : undefined;

  return {
    mode,
    url: url.toString(),
    prepare,
    ssl,
    host,
    port,
    strippedParams,
    summary: describe({ mode, host, port, prepare, ssl, hasSslMode, strippedParams }),
  };
}

/**
 * 把形态压回成一个连接串。
 *
 * 给只认 URL、不接受额外选项的工具用 —— drizzle-kit 的 `dbCredentials.url`
 * 就是这样，没法在旁边再传一个 `ssl`。
 */
export function toConnectionUrl(shape: ConnectionShape): string {
  if (!shape.ssl) return shape.url;
  const url = new URL(shape.url);
  url.searchParams.set('sslmode', shape.ssl);
  return url.toString();
}

function isFalsy(value: string | null): boolean {
  return value === 'false' || value === '0' || value === 'disable';
}

function describe(x: {
  mode: ConnectionMode;
  host: string;
  port: number;
  prepare: boolean;
  ssl: 'require' | undefined;
  hasSslMode: boolean;
  strippedParams: string[];
}): string {
  const mode = {
    direct: '直连',
    'pooled-session': 'Session Pooler',
    'pooled-transaction': 'Transaction Pooler',
  }[x.mode];
  const tls = x.hasSslMode ? 'TLS(连接串 sslmode)' : x.ssl ? 'TLS(自动)' : '明文';
  const prepare = x.prepare ? '预编译语句开' : '预编译语句关';
  const stripped =
    x.strippedParams.length > 0 ? `，已忽略客户端参数 ${x.strippedParams.join('/')}` : '';
  return `${x.host}:${x.port} ${mode}，${tls}，${prepare}${stripped}`;
}
