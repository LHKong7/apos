import { auditRls, createDatabase, inspectConnection } from '@apos/db';
import { RuntimeRegistry } from '@apos/agent-runtimes';
import {
  FeishuTransport,
  GitHubAdapter,
  IntegrationRegistry,
  MemoryIntegrationAdapter,
  SlackTransport,
  proxyAwareFetch,
  type NotifyTransport,
} from '@apos/integrations';
import { DevExternalStore } from './modules/integration/dev-store';
import { buildApp } from './app';
import { syncBuiltinRoles } from './http/roles';
import { bootstrapSuperadmin, signupSwitch } from './modules/auth';
import { syncAgents } from './modules/agent/runtime-factory';
import { WorkspaceProvisioner } from './modules/workspace/provisioner';
import { probeGit } from './modules/workspace/git';
import { startFlowLoops } from './workers/flow-loops';
import { defaultBus } from './modules/event/bus';
import { StubPlanningProvider } from './modules/planning/stub-provider';
import { AgentPlanningProvider } from './modules/planning/agent-provider';
import { startSchedulerLoop } from './workers/scheduler-loop';
import { startNotificationLoop } from './workers/notification-loop';

const PROCESS_ROLE = process.env['PROCESS_ROLE'] ?? 'all';

/**
 * 连接池大小。不设就用 @apos/db 的默认值（10）。
 *
 * ★ 托管 Postgres 的连接数是**硬上限**（Supabase 免费档直连 60 条），
 *   而 api 与 worker 是两个进程 —— 默认值下就是 20 条，再加上迁移和
 *   本机连进去看数据的，余量并不宽。超了的表现是「一部分请求卡住直到超时」，
 *   而数据库那边只是安静地拒绝新连接。
 *
 * ★ 认不出来的取值要喊出来而不是当没设：写成 `APOS_DB_POOL_MAX=ten`
 *   却静默回退到 10，等于配置根本没生效而现场毫无迹象。
 */
function poolMax(): number | undefined {
  const raw = process.env['APOS_DB_POOL_MAX'];
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.warn(`[db] APOS_DB_POOL_MAX=${raw} 不是正整数，已忽略，按默认池大小处理`);
    return undefined;
  }
  return parsed;
}

async function main() {
  const databaseUrl = process.env['DATABASE_URL'] ?? 'postgres://apos@localhost:5433/apos';

  /**
   * ★ 连接形态是从连接串**推断**出来的（判定规则见 packages/db/src/connection.ts），
   *   所以推断结果必须在启动时说出来。
   *
   *   推断错了的表现是「上线之后开始随机报 prepared statement does not exist」——
   *   偶发、与负载相关、且完全不指向端口号。日志里有这一行，对一眼就知道是不是
   *   把 Transaction Pooler 认成了直连。
   */
  const connection = inspectConnection(databaseUrl);
  console.log(`[db] ${connection.summary}`);

  const db = createDatabase({ url: databaseUrl, max: poolMax() });

  /**
   * ★★ 托管 Postgres（Supabase 等）会给 public 下的每张表自动生成一套
   *   **匿名** REST 接口。迁移 0017 已经把那条通道关死了，这里再查一遍，
   *   是因为它可能被绕开：有人手工 GRANT、在控制台点了按钮、或者后来
   *   某次迁移改了默认权限。
   *
   *   ★ 漏掉的后果没有任何症状 —— 应用照常跑、日志干净，只有被拖库之后
   *     才会知道。所以这条必须主动喊，且用 error 级别：它和 probeGit
   *     那条警告不同，不是「某类任务跑不了」，是数据在裸奔。
   */
  const rls = await auditRls(db);
  if (rls.exposed && rls.unprotected.length > 0) {
    console.error(
      `[db] ★ 以下表没有开启 RLS，而这个库上存在 PostgREST 角色 —— ` +
        `它们可以被匿名 REST 接口直接读取：${rls.unprotected.join('、')}。` +
        '补一条迁移对它们执行 ALTER TABLE … ENABLE ROW LEVEL SECURITY。',
    );
  }

  /**
   * ★★ 内置角色对齐到当前代码（09-security §2.2）。
   *
   *   内置角色的真相来源是权限目录，库里那几行只是缓存。目录里给 pm
   *   加一条权限而库不跟着变，就会出现「矩阵里写着 pm 能做、实际做不了」——
   *   没有任何报错，只有一个用户说「我这边点不动」。
   *   放在启动而不是每次请求：角色不常变，而每请求一次对齐是白花的开销。
   *
   *   自定义角色（研发 / 运营 / 测试…）一个字都不碰。
   */
  const syncedRoles = await syncBuiltinRoles(db);
  if (syncedRoles > 0) console.log(`[rbac] 内置角色已对齐（${syncedRoles} 条）`);

  /**
   * ★★ 超管自举（09-security §1.3）。
   *
   *   账号只能由组织管理员创建，而第一个管理员没人能创建他 ——
   *   所以他必须来自数据库之外，也就是部署者手里的 .env。
   *   幂等：已存在就什么都不做，尤其**不会**用 .env 里的口令覆盖他改过的口令。
   *
   *   放在 syncBuiltinRoles 之后：自举可能要建一个默认组织，
   *   而建组织依赖内置角色目录（成员表对 roles 有外键）。
   */
  await bootstrapSuperadmin(db, (m) => console.log(m));

  /**
   * ★ 注册开关的实际状态必须在启动时说一次。
   *   它认不出来的取值会按「关」处理（见 modules/auth/signup.ts）——
   *   把 `APOS_ALLOW_SIGNUP=flase` 写错了却毫无迹象的话，
   *   运维只会在用户报「注册不了」时才发现，而那时没人会想到是拼写。
   */
  {
    const signup = signupSwitch();
    console.log(`[auth] 自助注册：${signup.enabled ? '开启' : '关闭'}（${signup.reason}）`);
  }

  const registry = new RuntimeRegistry();

  const diagnose = (message: string, detail?: unknown) => console.warn('[runtime]', message, detail ?? '');

  const boot = await syncAgents(db, registry, { onDiagnostic: diagnose });
  if (boot.skipped.length > 0) {
    console.warn(`[runtime] 跳过 ${boot.skipped.length} 个 Agent：${boot.skipped.join('、')}`);
  }

  /**
   * 周期同步。★ 只增不减：正在跑的 Run 还握着那个适配器，
   * 把它摘掉等于中断一次执行，代价不对等。
   *
   * 新建/改配置时 admin 接口会立刻注册（registerAgentNow），
   * 这个循环兜的是多进程部署下「别的进程建的 Agent」。
   */
  const runtimeSyncMs = Number(process.env['RUNTIME_SYNC_INTERVAL_MS'] ?? 15_000);
  if (runtimeSyncMs > 0) {
    setInterval(() => {
      syncAgents(db, registry, { onDiagnostic: diagnose })
        .then((r: { added: number }) => {
          if (r.added > 0) console.log(`[runtime] 新注册 ${r.added} 个 Agent`);
        })
        .catch((err: unknown) => console.error('[runtime] 同步失败', err));
    }, runtimeSyncMs).unref();
  }

  /**
   * 工作区供给。
   *
   * ★ git 不可用要在**启动时**就喊出来，而不是等第一次派发才炸 ——
   *   那时错误会表现为「某个任务失败了」，没人会想到是部署环境没装 git。
   */
  const workspaces = new WorkspaceProvisioner(db, {
    root: process.env['AGENT_WORKSPACE_ROOT'],
    onDiagnostic: (message, detail) => console.warn('[workspace]', message, detail ?? ''),
  });
  const gitStatus = await probeGit();
  if (!gitStatus.ok) {
    console.warn(
      `[workspace] ${gitStatus.problem} —— 需要代码仓库的任务将无法派发。` +
        '只跑调研/文档类任务可以忽略这条。',
    );
  } else {
    console.log(`[workspace] ${gitStatus.version}，根目录 ${process.env['AGENT_WORKSPACE_ROOT'] ?? '/tmp/apos-workspaces'}`);
  }

  /**
   * 集成适配器注册表。
   *
   * ★ 只有进程内适配器有真实实现 —— 真实 provider 的 HTTP 传输层
   *   需要 OAuth 凭证与外网，两样都没有。与其写一个从未跑通、
   *   第一次真实调用才发现签名错的 GitHub 客户端，不如把
   *   接口定清楚、把它下游的一切（SoT 判定、冲突、循环抑制）验证到位。
   *   页面上如实标注哪些 provider 还没有传输层。
   */
  const integrationRegistry = new IntegrationRegistry();

  /**
   * ★ 出网可能要过代理。Node 内置 fetch **不认 HTTPS_PROXY** ——
   *   装在内网的实例会表现为「所有集成都连不上」，而运维一试 curl 是通的，
   *   这个差异极难自己想到。
   */
  const httpFetch = proxyAwareFetch();

  /**
   * 真实 provider 优先；没有真实实现的用进程内适配器兜底。
   *
   * ★ GitHub 走真的 api.github.com。`INTEGRATION_MEMORY_ADAPTERS=all`
   *   可以强制全部用进程内适配器（演示环境、离线开发）。
   */
  const forceMemory = process.env['INTEGRATION_MEMORY_ADAPTERS'] === 'all';
  if (!forceMemory) {
    integrationRegistry.register(
      new GitHubAdapter({
        fetchImpl: httpFetch,
        resolveToken: () => process.env['GITHUB_INTEGRATION_TOKEN'] ?? null,
      }),
    );
  }
  for (const p of ['jira', 'github', 'slack', 'feishu', 'plane'] as const) {
    if (integrationRegistry.has(p)) continue;
    integrationRegistry.register(new MemoryIntegrationAdapter(p, new DevExternalStore(db)));
  }

  /** 通知投递端 —— Slack / 飞书都是一个 webhook POST */
  const transports = new Map<string, NotifyTransport>([
    ['slack', new SlackTransport({ fetchImpl: httpFetch })],
    ['feishu', new FeishuTransport({ fetchImpl: httpFetch })],
  ]);

  const deps = {
    db,
    bus: defaultBus,
    registry,
    integrations: integrationRegistry,
    /**
     * ★★ 规划走真实 Agent，跑不通时回退规则占位。
     *
     *   回退**不是静默的**：AgentPlanningProvider 会把原因编进 model 字段，
     *   一路显示到需求页与计划页上。在此之前界面写着「🤖 AI 结构化结果」
     *   而底下是关键词正则，用户拿回自己的原话换了三个标签，
     *   只会觉得「这 AI 真差」——没人会想到根本没接模型。
     *
     * ★ 用哪个运行时由组织里的 Agent 配置决定（applicableTypes 含
     *   requirement 的那个），claude-code / codex / 将来的 pi / kimi
     *   都走 AgentRuntimeAdapter 这一个接口，这里不用区分。
     */
    provider: new AgentPlanningProvider(db, registry, new StubPlanningProvider(), {
      root: process.env['AGENT_WORKSPACE_ROOT'],
      timeoutMs: Number(process.env['PLANNING_TIMEOUT_MS'] ?? 600_000),
      // 与执行 Run 共用同一个工作区服务，诊断输出汇到一处
      workspaces,
      onDiagnostic: (message, detail) => console.log(message, detail ?? ''),
    }),
    workspaces,
  };

  /** 退出时要关掉的 HTTP 服务；worker 角色不监听端口，保持 null */
  let httpServer: Awaited<ReturnType<typeof buildApp>> | null = null;

  if (PROCESS_ROLE === 'all' || PROCESS_ROLE === 'api') {
    const app = await buildApp({
      ...deps,
      logger: true,
      // 单机部署时由本进程一并托管前端（见 http/web-app.ts）
      webDist: process.env['APOS_WEB_DIST'],
      trustProxy: process.env['TRUST_PROXY'] === 'true',
    });
    const port = Number(process.env['PORT'] ?? 3000);
    await app.listen({ port, host: '0.0.0.0' });
    app.log.info(`APOS API listening on :${port}`);
    httpServer = app;
  }

  if (PROCESS_ROLE === 'all' || PROCESS_ROLE === 'worker') {
    // API 进程要能随时重启，worker 承载长循环 —— 混在一起会让部署时
    // 正在跑的调度被打断（docs/tech/01-architecture.md §3.1）
    startNotificationLoop(db, defaultBus, {
      transports,
      webBaseUrl: process.env['WEB_BASE_URL'] ?? 'http://localhost:5173',
      onError: (e) => console.error('[notify]', e),
    });
    console.log('[worker] notification loop started');

    startSchedulerLoop(db, registry, {
      intervalMs: Number(process.env['SCHEDULER_INTERVAL_MS'] ?? 5000),
      onError: (err) => console.error('[scheduler]', err),
      workspaces,
    });
    console.log('[worker] scheduler loop started');

    /**
     * ★ 让一条任务链能自己跑完的四个循环（架构文档 §3.3）。
     *   在此之前只有 scheduler 一个循环：任务派出去之后，
     *   超时没人判、失败没人恢复、评审没人推进 —— 全靠人盯着。
     */
    startFlowLoops(db, {
      registry,
      workspaces,
      heartbeatTimeoutMs: Number(process.env['RUN_HEARTBEAT_TIMEOUT_MS'] ?? 90_000),
      onError: (err) => console.error('[flow]', err),
      onReport: (name, detail) => console.log(`[${name}]`, JSON.stringify(detail)),
    });
    console.log('[worker] flow loops started (supervisor / recovery / review / stats)');
  }

  /**
   * 优雅退出。容器编排停容器时先发 SIGTERM，宽限期（默认 10s）过了才 SIGKILL。
   *
   * ★ 不处理 SIGTERM 的后果不是「退出慢一点」：连接会被硬断，
   *   浏览器那边的 SSE 表现为莫名其妙的断流，数据库连接池里
   *   正在写的事务被掐掉。而这个产品的每一次状态变更都要连带写事件
   *   （CONTRIBUTING 的第一条约束），写到一半被掐 = 审计链有洞。
   *
   * ★ 这里只负责让本进程干净退出，不试图「等所有 Agent Run 跑完」——
   *   Run 活在外部运行时里，本来就不随本进程生死（架构文档 §3.3），
   *   重启后由 run-supervisor 的孤儿接管负责认领。
   */
  let closing = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (closing) return; // 连按两次 Ctrl-C 不该走两遍关闭流程
      closing = true;
      console.log(`[shutdown] 收到 ${signal}，正在收尾…`);

      const timer = setTimeout(() => {
        console.error('[shutdown] 收尾超时，强制退出');
        process.exit(1);
      }, Number(process.env['SHUTDOWN_TIMEOUT_MS'] ?? 10_000));

      void (async () => {
        try {
          if (httpServer) await httpServer.close();
          await db.$client.end({ timeout: 5 });
          clearTimeout(timer);
          console.log('[shutdown] 已退出');
          process.exit(0);
        } catch (err) {
          console.error('[shutdown] 收尾出错', err);
          process.exit(1);
        }
      })();
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
