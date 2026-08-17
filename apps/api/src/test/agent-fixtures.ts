import { agents, projectAgentPermissions, projectMembers, type Database } from '@apos/db';
import { capabilityProfile, expandProfile, STANDARD_EXECUTOR } from '@apos/domain';
import { MockRuntime, RuntimeRegistry } from '@apos/agent-runtimes';
import type { Fixture } from './db';

export interface AgentFixture {
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
    maxConcurrency?: number;
    tokenLimitPerRun?: number;
    stats?: Record<string, unknown>;
    /**
     * ★ 含 `requirement`：自动挑规划 / PRD 编写 Agent 时它排在前面
     *   （pickAgent 的 PLANNING_TYPE）。此前这个联合漏了它，于是想造一个
     *   「优先被挑去写 PRD 的 Agent」只能绕开夹具直接插表 —— 而绕开夹具的
     *   测试造出来的形态迟早与真实路径分家。
     *
     * ★ 它**不是**能不能写 PRD 的门槛：那条判据只有「是不是项目成员」。
     *   所以默认值里没有它，也照样能被指定为 PRD 编写者。
     */
    applicableTypes?: (
      | 'task'
      | 'bug'
      | 'test'
      | 'research'
      | 'review'
      | 'release'
      | 'requirement'
    )[];
    /**
     * 把这个 Agent 登记成项目成员。默认 **true** —— 派发的硬性前置就是
     * 项目成员关系（domain 的 matchExecutors 里那条 inProject），
     * 不登记的 Agent 一条都派不出去。
     *
     * ★ 夹具默认要跟真实形态一致：真实路径上，Agent 是在「成员与角色」里
     *   被加进项目的，seed 脚本也照做。夹具漏掉这一步，整套调度、恢复、
     *   端到端测试就都在测一个现实中不存在的形态 —— 而它们的失败信息是
     *   「无匹配 Agent」，看不出根因在夹具。
     *
     * ★ 传 false 用来测「没登记就派不出去」那条路径本身。
     */
    inProject?: boolean;
    /**
     * 在夹具项目里给这个 Agent 配一份授权。
     *
     * ★ 不传 = **不配**，落到平台默认档案上 —— 那才是真实路径上最常见的
     *   形态（把 Agent 加进项目就能干活，不必先去配一遍权限）。
     *   想测「配过之后是什么样」的用例才传。
     */
    grant?: { profileKey?: string; resourceScopes?: { kind: string; ref: string; access: string }[] };
  } = {},
): Promise<AgentFixture> {
  const runtime = opts.runtime ?? new MockRuntime();
  const registry = opts.registry ?? new RuntimeRegistry();

  const [agent] = await db
    .insert(agents)
    .values({
      orgId: fx.orgId,
      name: opts.name ?? 'code-agent-1',
      type: 'code',
      // ★ 运行时内联在 Agent 上；注册表按 agentId 键控
      runtimeKind: 'mock',
      capabilities: (await runtime.getCapabilities()) as unknown as Record<string, unknown>,
      model: 'claude-opus-5',
      skills: opts.skills ?? ['TypeScript', 'SQL 优化'],
      applicableTypes: opts.applicableTypes ?? ['task', 'bug', 'test', 'research', 'review'],
      maxConcurrency: opts.maxConcurrency ?? 3,
      tokenLimitPerRun: opts.tokenLimitPerRun ?? 500_000,
      ownerId: fx.userId,
      stats: opts.stats ?? { successRate: 0.92, sampleSize: 25, avgTokens: 5.2 },
    })
    .returning();

  registry.register(agent!.id, runtime);

  if (opts.inProject ?? true) {
    /**
     * ★ 角色用 executor —— 内置角色里唯一一个 Agent 能担任的干活角色
     *   （domain 的 assignableBy：带 humanOnly 权限的角色不给 Agent）。
     *   写别的 key 会撞上 project_members → roles 的外键，
     *   而报错是一句「违反外键」，看不出真正的原因是角色不存在。
     */
    await db
      .insert(projectMembers)
      .values({
        orgId: fx.orgId,
        projectId: fx.projectId,
        actorType: 'agent',
        actorId: agent!.id,
        role: 'executor',
      })
      .onConflictDoNothing();
  }

  if (opts.grant) {
    const profile = capabilityProfile(opts.grant.profileKey ?? STANDARD_EXECUTOR.key)!;
    const expanded = expandProfile(profile);
    await db
      .insert(projectAgentPermissions)
      .values({
        orgId: fx.orgId,
        projectId: fx.projectId,
        agentId: agent!.id,
        profileKey: expanded.profileKey,
        profileVersion: expanded.profileVersion,
        allowedCapabilities: expanded.allowedCapabilities,
        deniedCapabilities: expanded.deniedCapabilities,
        resourceScopes: (opts.grant.resourceScopes ?? []) as never,
        updatedBy: fx.userId,
      })
      .onConflictDoNothing();
  }

  return { agentId: agent!.id, runtime, registry };
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
