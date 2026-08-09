import { createDatabase } from '@apos/db';
import { ClaudeCodeRuntime, MockRuntime, RuntimeRegistry } from '@apos/agent-runtimes';
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
import { agentRuntimes } from '@apos/db';
import { buildApp } from './app';
import { defaultBus } from './modules/event/bus';
import { StubPlanningProvider } from './modules/planning/stub-provider';
import { startSchedulerLoop } from './workers/scheduler-loop';
import { startNotificationLoop } from './workers/notification-loop';

const PROCESS_ROLE = process.env['PROCESS_ROLE'] ?? 'all';

async function main() {
  const db = createDatabase({
    url: process.env['DATABASE_URL'] ?? 'postgres://apos@localhost:5433/apos',
  });

  const registry = new RuntimeRegistry();

  /**
   * 把数据库里的运行时登记进注册表。只处理还没注册过的行，可反复调用。
   *
   * ★ 为什么要能反复调用：注册表原本只在启动时建一次，于是任何在
   *   进程起来之后新增的运行时都是隐形的 —— 界面显示「适配器没有在当前
   *   进程注册」，任务派不出去，而这句话不会告诉你该去重启谁。
   *
   *   最容易踩到的是本地开发：`pnpm --filter @apos/api seed` 每次都会
   *   insert 一条新的 agent_runtimes（新 UUID），API 早已启动，
   *   于是 seed 完的演示数据一个任务都派不出去，看起来像产品坏了。
   *   生产上同样的形状：管理员加了一个运行时，要等下次重启才生效。
   */
  async function syncRuntimes() {
    const runtimes = await db.select().from(agentRuntimes);
    let added = 0;
    for (const rt of runtimes) {
      if (registry.has(rt.id)) continue;

      if (rt.kind === 'mock') {
        registry.register(rt.id, new MockRuntime());
        added++;
        continue;
      }

      if (rt.kind === 'claude_code') {
        registry.register(
          rt.id,
          new ClaudeCodeRuntime({
            // 凭证与工作目录都从环境读，绝不从数据库里取人类用户的 token
            workspaceRoot: process.env['AGENT_WORKSPACE_ROOT'],
            onDiagnostic: (message, detail) => console.warn('[claude-code]', message, detail ?? ''),
          }),
        );
        added++;
        continue;
      }

      console.warn(`[runtime] 未知运行时类型 ${rt.kind}（${rt.name}），已跳过注册`);
    }
    return added;
  }

  await syncRuntimes();

  /**
   * ★ 只增不减：这里不注销已经消失的运行时行。
   *   正在跑的 Run 还握着那个适配器，把它摘掉等于中断一次执行 ——
   *   为了一条清理逻辑打断真实执行，代价不对等。
   */
  const runtimeSyncMs = Number(process.env['RUNTIME_SYNC_INTERVAL_MS'] ?? 15_000);
  if (runtimeSyncMs > 0) {
    setInterval(() => {
      syncRuntimes()
        .then((added) => {
          if (added > 0) console.log(`[runtime] 新注册 ${added} 个运行时`);
        })
        .catch((err) => console.error('[runtime] 同步失败', err));
    }, runtimeSyncMs).unref();
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
    provider: new StubPlanningProvider(),
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
    });
    console.log('[worker] scheduler loop started');
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
