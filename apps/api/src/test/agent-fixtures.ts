import { agentRuntimes, agents, type Database } from '@apos/db';
import { MockRuntime, RuntimeRegistry } from '@apos/agent-runtimes';
import type { Fixture } from './db';

export interface AgentFixture {
  runtimeId: string;
  agentId: string;
  runtime: MockRuntime;
  registry: RuntimeRegistry;
}

export async function seedAgent(
  db: Database,
  fx: Fixture,
  opts: {
    runtime?: MockRuntime;
    registry?: RuntimeRegistry;
    name?: string;
    skills?: string[];
    allowedTools?: string[];
    deniedTools?: string[];
    maxConcurrency?: number;
    costLimitPerRun?: string;
    stats?: Record<string, unknown>;
  } = {},
): Promise<AgentFixture> {
  const runtime = opts.runtime ?? new MockRuntime();
  const registry = opts.registry ?? new RuntimeRegistry();

  const [rt] = await db
    .insert(agentRuntimes)
    .values({
      orgId: fx.orgId,
      name: 'mock runtime',
      kind: 'mock',
      protocolVersion: '1.0',
      capabilities: (await runtime.getCapabilities()) as unknown as Record<string, unknown>,
    })
    .returning();

  registry.register(rt!.id, runtime);

  const [agent] = await db
    .insert(agents)
    .values({
      orgId: fx.orgId,
      name: opts.name ?? 'code-agent-1',
      type: 'code',
      runtimeId: rt!.id,
      runtimeRef: 'mock:code-1',
      model: 'claude-opus-5',
      skills: opts.skills ?? ['TypeScript', 'SQL 优化'],
      applicableTypes: ['task', 'bug', 'test'],
      allowedTools: opts.allowedTools ?? ['read_file', 'write_file', 'run_tests', 'create_pr'],
      deniedTools: opts.deniedTools ?? ['merge_pr'],
      maxConcurrency: opts.maxConcurrency ?? 3,
      costLimitPerRun: opts.costLimitPerRun ?? '15.0000',
      ownerId: fx.userId,
      stats: opts.stats ?? { successRate: 0.92, sampleSize: 25, avgCost: 5.2 },
    })
    .returning();

  return { runtimeId: rt!.id, agentId: agent!.id, runtime, registry };
}

/**
 * 轮询直到条件满足。
 *
 * Agent 事件流是真异步的（含数据库往返），tick 循环不可靠；
 * 轮询实际状态才是确定性的等待方式。
 */
export async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeout = opts.timeoutMs ?? 5000;
  const interval = opts.intervalMs ?? 20;
  const deadline = Date.now() + timeout;

  for (;;) {
    const result = await probe();
    if (result) return result;
    if (Date.now() > deadline) {
      throw new Error(`等待超时（${timeout}ms）：${opts.label ?? '条件未满足'}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** 等待某个 Work Item 的 Run 结束 */
export async function waitForRunEnd(
  db: Database,
  workItemId: string,
  opts: { timeoutMs?: number } = {},
) {
  const { agentRuns } = await import('@apos/db');
  const { eq, inArray, and } = await import('drizzle-orm');
  return waitFor(
    async () => {
      const [run] = await db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.workItemId, workItemId),
            inArray(agentRuns.status, ['completed', 'failed', 'timeout', 'terminated']),
          ),
        );
      return run ?? null;
    },
    { ...opts, label: `Work Item ${workItemId} 的 Run 未结束` },
  );
}
