import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { agents, projectAgentBindings, projectMembers } from '@apos/db';
import { MockRuntime, RuntimeRegistry, type AgentRuntimeAdapter } from '@apos/agent-runtimes';
import type {
  CapabilityManifest,
  ControlCommand,
  RunEvent,
  TaskDispatch,
} from '@apos/contracts';
import { resetDb, seedFixture, testDb, type Fixture } from '../../test/db';
import { AgentPlanningProvider } from './agent-provider';
import { StubPlanningProvider } from './stub-provider';
import { OUTPUT_FILE } from './agent-brief';

const db = testDb();
let fx: Fixture;
let root: string;

beforeEach(async () => {
  await resetDb(db);
  fx = await seedFixture(db);
  root = await mkdtemp(join(tmpdir(), 'apos-plan-'));
});

/**
 * 一个会真的往工作目录里写文件的假运行时 —— MockRuntime 不碰文件系统，
 * 而这里要验的恰恰是「Agent 拿到的目录是什么样、平台怎么收它写的东西」。
 */
class FileWritingRuntime implements AgentRuntimeAdapter {
  readonly kind = 'mock';
  /** dispatch 那一刻工作目录里有什么 —— 用来验基线时序 */
  seenAtDispatch: string[] = [];
  lastTask: TaskDispatch | null = null;

  constructor(private readonly output: unknown) {}

  async getCapabilities(): Promise<CapabilityManifest> {
    return new MockRuntime().getCapabilities();
  }

  async dispatch(task: TaskDispatch) {
    this.lastTask = task;
    const dir = task.workspace!.path;
    const { readdir } = await import('node:fs/promises');
    this.seenAtDispatch = await readdir(dir);
    await writeFile(join(dir, OUTPUT_FILE), JSON.stringify(this.output), 'utf8');
    return { externalRunId: `x-${task.runId}`, accepted: true as const };
  }

  async subscribe(runId: string, onEvent: (e: RunEvent) => Promise<void>) {
    queueMicrotask(async () => {
      await onEvent({
        runId,
        seq: 0,
        ts: new Date().toISOString(),
        type: 'run_ended',
        outcome: 'completed',
        summary: '规划完成',
      } as RunEvent);
    });
    return () => undefined;
  }

  async queryStatus() {
    return {
      status: 'completed' as const,
      externalRunId: 'x',
      lastActivityAt: new Date().toISOString(),
    };
  }

  async control(_runId: string, _cmd: ControlCommand) {}
}

const STRUCTURED_OUTPUT = {
  title: '订单超时重试',
  businessContext: '背景',
  userProblem: '问题',
  businessGoal: '目标',
  userStories: ['作为用户我要 X'],
  scope: { inScope: ['A'], outOfScope: ['B'] },
  nonFunctional: ['P95 < 200ms'],
  successMetrics: ['失败率下降'],
  constraints: [],
  risks: [],
  acceptanceCriteria: [{ text: '重试三次后进死信', verification: 'auto' }],
  clarifications: [],
  assumptions: [],
};

async function seedPlanningAgent(
  registry: RuntimeRegistry,
  runtime: AgentRuntimeAdapter,
  name = 'planner-1',
  opts: { inProject?: boolean } = {},
) {
  const [agent] = await db
    .insert(agents)
    .values({
      orgId: fx.orgId,
      name,
      type: 'planning',
      runtimeKind: 'mock',
      capabilities: (await runtime.getCapabilities()) as unknown as Record<string, unknown>,
      model: 'claude-opus-5',
      skills: [],
      applicableTypes: ['requirement'],
      allowedTools: ['read_file', 'write_file'],
      deniedTools: [],
      maxConcurrency: 1,
      costLimitPerRun: '5.0000',
      ownerId: fx.userId,
      stats: {},
    })
    .returning();
  registry.register(agent!.id, runtime);

  /**
   * ★ 加进项目成员 —— pickAgent 没有 planner 绑定时就退到「项目成员里的
   *   Agent」，两条路都以成员关系为前提。少了这一步，provider 会如实地
   *   回一句「这个项目还没有绑定规划 Agent」并退到规则占位，
   *   于是下面几条验的就不是真 Agent 那条链路了。
   */
  /** ★ inProject:false 用来测「点名一个非本项目成员的 Agent」那条授权路径 */
  if (opts.inProject ?? true) {
    await db.insert(projectMembers).values({
      orgId: fx.orgId,
      projectId: fx.projectId,
      actorType: 'agent',
      actorId: agent!.id,
      role: 'executor',
    });
  }
  return agent!;
}

function provider(registry: RuntimeRegistry) {
  return new AgentPlanningProvider(db, registry, new StubPlanningProvider(), {
    root,
    timeoutMs: 10_000,
  });
}

describe('规划 Agent 的工作区', () => {
  /**
   * ★★ 此前这里造的是 { repoRef:'planning', branch:'planning' } —— 一个假的
   *   Git 工作区，于是治理规则会对 Agent 说「你在分支 planning 上工作，
   *   它基于 planning」。Agent 读到只会去找一个不存在的分支。
   */
  it('是一个如实的空目录工作区，vcs 为 null 而不是 planning 占位符', async () => {
    const registry = new RuntimeRegistry();
    const runtime = new FileWritingRuntime(STRUCTURED_OUTPUT);
    await seedPlanningAgent(registry, runtime);

    const result = await provider(registry).structureRequirement({
      rawInput: '订单超时要重试',
      projectType: 'web',
      context: [],
      scope: { orgId: fx.orgId, projectId: fx.projectId },
    });

    // 走的是真 Agent 而不是规则占位 —— 否则下面验的就不是这条链路
    expect(result.model).toContain('mock');
    expect(result.title).toBe('订单超时重试');
    const ws = runtime.lastTask!.workspace!;
    expect(ws.vcs).toBeNull();
    expect(ws.writable).toBe(true);
    expect(ws.path).toContain('planning');
  });

  /**
   * ★★ 基线必须在平台写完自己的输入文件**之后**记。否则 BRIEF.md 会出现在
   *   变更集的 added 里，被当成 Agent 的产出记进产物 —— 而真正的产出
   *   淹没在里面。
   */
  it('任务书在 Agent 开工前就已落盘，且算进基线', async () => {
    const registry = new RuntimeRegistry();
    const runtime = new FileWritingRuntime(STRUCTURED_OUTPUT);
    await seedPlanningAgent(registry, runtime);

    await provider(registry).structureRequirement({
      rawInput: '订单超时要重试',
      projectType: 'web',
      context: [],
      scope: { orgId: fx.orgId, projectId: fx.projectId },
    });

    // Agent 拿到目录时 BRIEF.md 已经在了
    expect(runtime.seenAtDispatch).toContain('BRIEF.md');

    const dir = runtime.lastTask!.workspace!.path;
    expect(await readFile(join(dir, 'BRIEF.md'), 'utf8')).toContain('订单超时要重试');
  });

  /** ★ 规划目录留着不删 —— 失败时 BRIEF.md 与半成品是唯一的排查材料 */
  it('收尾后目录保留供事后复查，基线快照被清掉', async () => {
    const registry = new RuntimeRegistry();
    const runtime = new FileWritingRuntime(STRUCTURED_OUTPUT);
    await seedPlanningAgent(registry, runtime);

    await provider(registry).structureRequirement({
      rawInput: '订单超时要重试',
      projectType: 'web',
      context: [],
      scope: { orgId: fx.orgId, projectId: fx.projectId },
    });

    const dir = runtime.lastTask!.workspace!.path;
    await expect(stat(dir)).resolves.toBeTruthy();
    await expect(stat(join(dir, OUTPUT_FILE))).resolves.toBeTruthy();
    // 基线快照是内部状态，使命完成就该清掉 —— 目录留着但里面不留文件
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(join(root, 'state')).catch(() => [])).toEqual([]);
  });

  it('没有可用规划 Agent 时回退到规则占位，并把真相写进 model', async () => {
    const result = await provider(new RuntimeRegistry()).structureRequirement({
      rawInput: '订单超时要重试',
      projectType: 'web',
      context: [],
      scope: { orgId: fx.orgId, projectId: fx.projectId },
    });

    expect(result.model).toContain('规划 Agent');
  });
});

/**
 * 需求上点名的编写 Agent（scope.agentId）。
 *
 * ★★ 这一组的中心只有一条：**点名之后绝不换人**。
 *   点名的那个不可用时如实失败并说出原因，而不是悄悄找另一个跑完 ——
 *   后者在界面上一切正常，产出却来自一个用户没选的 Agent。
 */
describe('点名指定的 PRD 编写 Agent', () => {
  it('压过项目绑定：绑定的是 A，点名 B 就由 B 跑', async () => {
    const registry = new RuntimeRegistry();
    const boundRuntime = new FileWritingRuntime({ ...STRUCTURED_OUTPUT, title: 'A 写的' });
    const namedRuntime = new FileWritingRuntime({ ...STRUCTURED_OUTPUT, title: 'B 写的' });

    const bound = await seedPlanningAgent(registry, boundRuntime, 'planner-A');
    const named = await seedPlanningAgent(registry, namedRuntime, 'planner-B');
    await db.insert(projectAgentBindings).values({
      orgId: fx.orgId,
      projectId: fx.projectId,
      role: 'planner',
      priority: 0,
      agentId: bound.id,
      createdBy: fx.userId,
    });

    const result = await provider(registry).structureRequirement({
      rawInput: '订单超时要重试',
      projectType: 'web',
      context: [],
      scope: { orgId: fx.orgId, projectId: fx.projectId, agentId: named.id },
    });

    expect(result.title).toBe('B 写的');
    // 绑定的那个一次都没被派到
    expect(boundRuntime.lastTask).toBeNull();
    expect(namedRuntime.lastTask).not.toBeNull();
  });

  /**
   * ★★ 授权：非本项目成员的 Agent 即使被点名也不能跑。
   *   这个 id 是从 HTTP 请求一路传下来的，而项目是权限与上下文的边界 ——
   *   规划 Run 会把项目资源只读挂进工作区。
   */
  it('点名一个非本项目成员的 Agent：不跑，且说出是成员关系的问题', async () => {
    const registry = new RuntimeRegistry();
    const runtime = new FileWritingRuntime(STRUCTURED_OUTPUT);
    const outsider = await seedPlanningAgent(registry, runtime, 'outsider', {
      inProject: false,
    });

    const result = await provider(registry).structureRequirement({
      rawInput: '订单超时要重试',
      projectType: 'web',
      context: [],
      scope: { orgId: fx.orgId, projectId: fx.projectId, agentId: outsider.id },
    });

    expect(runtime.lastTask).toBeNull();
    expect(result.model).toContain('不是这个项目的成员');
  });

  /**
   * ★★ 有一个完全可用的备选摆在那里，也不许拿它顶上。
   *   这条是整组的核心：静默换人比失败更糟。
   */
  it('点名的 Agent 停用时：不退给别人，回退到规则占位并说明', async () => {
    const registry = new RuntimeRegistry();
    const healthyRuntime = new FileWritingRuntime(STRUCTURED_OUTPUT);
    const pausedRuntime = new FileWritingRuntime(STRUCTURED_OUTPUT);

    await seedPlanningAgent(registry, healthyRuntime, 'healthy');
    const paused = await seedPlanningAgent(registry, pausedRuntime, 'paused-one');
    await db.update(agents).set({ status: 'paused' }).where(eq(agents.id, paused.id));

    const result = await provider(registry).structureRequirement({
      rawInput: '订单超时要重试',
      projectType: 'web',
      context: [],
      scope: { orgId: fx.orgId, projectId: fx.projectId, agentId: paused.id },
    });

    expect(result.model).toContain('paused-one');
    expect(result.model).toContain('paused');
    // 健康的那个没有被拿来顶班
    expect(healthyRuntime.lastTask).toBeNull();
  });

  it('点名的 Agent 已被删除：如实说不存在', async () => {
    const registry = new RuntimeRegistry();
    const runtime = new FileWritingRuntime(STRUCTURED_OUTPUT);
    await seedPlanningAgent(registry, runtime, 'still-here');

    const result = await provider(registry).structureRequirement({
      rawInput: '订单超时要重试',
      projectType: 'web',
      context: [],
      scope: { orgId: fx.orgId, projectId: fx.projectId, agentId: randomUUID() },
    });

    expect(runtime.lastTask).toBeNull();
    expect(result.model).toContain('已不存在');
  });

  it('没点名时行为不变，仍然按项目成员自动挑', async () => {
    const registry = new RuntimeRegistry();
    const runtime = new FileWritingRuntime(STRUCTURED_OUTPUT);
    await seedPlanningAgent(registry, runtime, 'auto-picked');

    const result = await provider(registry).structureRequirement({
      rawInput: '订单超时要重试',
      projectType: 'web',
      context: [],
      scope: { orgId: fx.orgId, projectId: fx.projectId },
    });

    expect(result.title).toBe('订单超时重试');
    expect(runtime.lastTask).not.toBeNull();
  });
});
