import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { agents, projectMembers } from '@apos/db';
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

async function seedPlanningAgent(registry: RuntimeRegistry, runtime: AgentRuntimeAdapter) {
  const [agent] = await db
    .insert(agents)
    .values({
      orgId: fx.orgId,
      name: 'planner-1',
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
  await db.insert(projectMembers).values({
    orgId: fx.orgId,
    projectId: fx.projectId,
    actorType: 'agent',
    actorId: agent!.id,
    role: 'executor',
  });
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
