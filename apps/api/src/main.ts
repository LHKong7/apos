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
  const runtimes = await db.select().from(agentRuntimes);
  for (const rt of runtimes) {
    if (rt.kind === 'mock') {
      registry.register(rt.id, new MockRuntime());
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
      continue;
    }

    console.warn(`[runtime] 未知运行时类型 ${rt.kind}（${rt.name}），已跳过注册`);
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

  if (PROCESS_ROLE === 'all' || PROCESS_ROLE === 'api') {
    const app = await buildApp({ ...deps, logger: true });
    const port = Number(process.env['PORT'] ?? 3000);
    await app.listen({ port, host: '0.0.0.0' });
    app.log.info(`APOS API listening on :${port}`);
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
