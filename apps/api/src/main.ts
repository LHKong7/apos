import { createDatabase } from '@apos/db';
import { MockRuntime, RuntimeRegistry } from '@apos/agent-runtimes';
import { agentRuntimes } from '@apos/db';
import { buildApp } from './app';
import { defaultBus } from './modules/event/bus';
import { StubPlanningProvider } from './modules/planning/stub-provider';
import { startSchedulerLoop } from './workers/scheduler-loop';

const PROCESS_ROLE = process.env['PROCESS_ROLE'] ?? 'all';

async function main() {
  const db = createDatabase({
    url: process.env['DATABASE_URL'] ?? 'postgres://apos@localhost:5433/apos',
  });

  // MVP：注册内存运行时。接入真实 Agent 时在此处替换为对应适配器。
  const registry = new RuntimeRegistry();
  const runtimes = await db.select().from(agentRuntimes);
  for (const rt of runtimes) {
    if (rt.kind === 'mock') registry.register(rt.id, new MockRuntime());
  }

  const deps = {
    db,
    bus: defaultBus,
    registry,
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
