import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { agentRuns, agents, projectAgentBindings, projectMembers, runEvents } from '@apos/db';
import { MockRuntime, RuntimeRegistry, type AgentRuntimeAdapter } from '@apos/agent-runtimes';
import type {
  CapabilityManifest,
  ControlCommand,
  RunEvent,
  TaskDispatch,
} from '@apos/contracts';
import { resetDb, seedFixture, testDb, type Fixture } from '../../test/db';
import { AgentPlanningProvider } from './agent-provider';
import type { StructuredRequirement } from './provider';
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
  /** 每一轮拿到的任务书 —— 修正轮验的就是「第二份任务书里有没有那句报错」 */
  readonly briefs: string[] = [];
  dispatchCount = 0;
  /** 每轮上报的成本，null = 这个运行时不报成本 */
  costPerRound: number | null = null;
  /** CLI may emit a token-carrying cost event without claiming monetary reporting. */
  costReporting = true;

  private readonly outputs: unknown[];

  /**
   * ★ 收一串产物而不是一个：重试循环要的正是「第一轮写错、第二轮写对」。
   *   用完之后重复最后一个 —— 「每一轮都写同样的错」是另一条要测的路径。
   *   `undefined` 表示这一轮压根不写产物文件。
   */
  constructor(...outputs: unknown[]) {
    this.outputs = outputs;
  }

  async getCapabilities(): Promise<CapabilityManifest> {
    const capabilities = await new MockRuntime().getCapabilities();
    capabilities.features.costReporting = this.costReporting;
    return capabilities;
  }

  async dispatch(task: TaskDispatch) {
    this.lastTask = task;
    const dir = task.workspace!.path;
    const { readdir } = await import('node:fs/promises');
    this.seenAtDispatch = await readdir(dir);
    this.briefs.push(await readFile(join(dir, 'BRIEF.md'), 'utf8').catch(() => ''));

    const output = this.outputs[Math.min(this.dispatchCount, this.outputs.length - 1)];
    this.dispatchCount += 1;
    if (output !== undefined) {
      await writeFile(join(dir, OUTPUT_FILE), JSON.stringify(output), 'utf8');
    }
    return { externalRunId: `x-${task.runId}`, accepted: true as const };
  }

  async subscribe(runId: string, onEvent: (e: RunEvent) => Promise<void>) {
    queueMicrotask(async () => {
      let seq = 0;
      if (this.costPerRound !== null) {
        await onEvent({
          runId,
          seq: seq++,
          ts: new Date().toISOString(),
          type: 'cost',
          deltaUsd: this.costPerRound,
          totalUsd: this.costPerRound,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        } as RunEvent);
      }
      await onEvent({
        runId,
        seq: seq++,
        ts: new Date().toISOString(),
        type: 'note',
        text: 'stdout: I finished the analysis but may have forgotten to write the file',
      } as RunEvent);
      await onEvent({
        runId,
        seq,
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
  opts: {
    inProject?: boolean;
  } = {},
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
      /** ★ skills / applicableTypes 两列已经没有读取方，夹具不再写它们 */
      allowedTools: ['read_file', 'write_file'],
      deniedTools: [],
      maxConcurrency: 1,
      tokenLimitPerRun: 250_000,
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

/**
 * 谁能写 PRD。
 *
 * ★★ 这一组钉的是：**没有任何自述标签参与这件事**。
 *
 *   这里以前有一栏 `applicableTypes`：它回答的是派工作项时能不能派给它，
 *   而写 PRD 不派工作项 —— 这会儿工作项还不存在。拿它当门槛的后果是一个
 *   配了整队 Agent 的项目，能写 PRD 的却是零个，而界面上只有一个空下拉框；
 *   退一步拿它当排序偏好，效果也只是把「有人勾过一个格子」当成了
 *   「它更擅长写 PRD」。那一栏现在整个不存在了：能不能写由项目成员关系决定，
 *   由谁来写由项目的 planner 绑定决定。
 *
 *   Nothing an agent declares about itself takes part in this. Membership
 *   decides eligibility; the planner binding decides who.
 */
describe('谁能写 PRD 不由任何自述标签决定', () => {
  it('点名一个普通执行 Agent：照样由它跑，不回退规则占位', async () => {
    const registry = new RuntimeRegistry();
    const runtime = new FileWritingRuntime({ ...STRUCTURED_OUTPUT, title: 'coder 写的' });
    const coder = await seedPlanningAgent(registry, runtime, 'coder');

    const result = await provider(registry).structureRequirement({
      rawInput: '订单超时要重试',
      projectType: 'web',
      context: [],
      scope: { orgId: fx.orgId, projectId: fx.projectId, agentId: coder.id },
    });

    expect(result.title).toBe('coder 写的');
    expect(runtime.lastTask).not.toBeNull();
    // ★ 回退时 model 里会写着原因；这里不该有任何原因
    expect(result.model).not.toContain('规则占位');
  });

  /**
   * ★ 项目里只有一个 Agent 时就用它。以前这里会因为它「不含 requirement」
   *   而返回空、整次分析退成规则占位 —— 而那个 Agent 跑得动。
   */
  it('自动挑：项目里只有一个 Agent 成员时，就是它', async () => {
    const registry = new RuntimeRegistry();
    const runtime = new FileWritingRuntime({ ...STRUCTURED_OUTPUT, title: '唯一的那个写的' });
    await seedPlanningAgent(registry, runtime, 'only-coder');

    const result = await provider(registry).structureRequirement({
      rawInput: '订单超时要重试',
      projectType: 'web',
      context: [],
      scope: { orgId: fx.orgId, projectId: fx.projectId },
    });

    expect(result.title).toBe('唯一的那个写的');
    expect(runtime.lastTask).not.toBeNull();
  });

  /**
   * ★★ 自动挑只按 createdAt —— 排序里**没有**任何标签偏好。
   *
   *   这条以前断言的是「勾了 requirement 的排在前面」。删掉那一栏之后，
   *   自动挑退回到一个诚实的规则：最早建的那个。它不假装知道谁更擅长 ——
   *   真要指定，用项目的 planner 绑定（上面那一组测的就是绑定优先）。
   */
  it('★ 自动挑按建号顺序，不按任何标签偏好', async () => {
    const registry = new RuntimeRegistry();
    const firstRuntime = new FileWritingRuntime({ ...STRUCTURED_OUTPUT, title: '先建的写的' });
    const secondRuntime = new FileWritingRuntime({ ...STRUCTURED_OUTPUT, title: '后建的写的' });

    await seedPlanningAgent(registry, firstRuntime, 'agent-first');
    await seedPlanningAgent(registry, secondRuntime, 'agent-second');

    const result = await provider(registry).structureRequirement({
      rawInput: '订单超时要重试',
      projectType: 'web',
      context: [],
      scope: { orgId: fx.orgId, projectId: fx.projectId },
    });

    expect(result.title).toBe('先建的写的');
    expect(secondRuntime.lastTask).toBeNull();
  });

  /**
   * ★ 「现在能不能跑」仍然排在建号顺序之前：先建但运行时没注册的那个
   *   不该压过一个跑得动的。反过来的话，一次本来能成的分析会退成规则占位。
   */
  it('自动挑：先建但运行时没注册时，让位给跑得动的那个', async () => {
    const registry = new RuntimeRegistry();
    const coderRuntime = new FileWritingRuntime({ ...STRUCTURED_OUTPUT, title: 'coder 写的' });

    const unregistered = new RuntimeRegistry();
    await seedPlanningAgent(unregistered, new FileWritingRuntime(STRUCTURED_OUTPUT), 'ghost');
    await seedPlanningAgent(registry, coderRuntime, 'runnable-coder');

    const result = await provider(registry).structureRequirement({
      rawInput: '订单超时要重试',
      projectType: 'web',
      context: [],
      scope: { orgId: fx.orgId, projectId: fx.projectId },
    });

    expect(result.title).toBe('coder 写的');
    expect(coderRuntime.lastTask).not.toBeNull();
  });
});

/**
 * 规划产出不合格时的修正轮。
 *
 * ★★ 这一组是照着一次真实事故写的。当时的现场是这样：
 *
 *   1. 任务书自己埋了雷 —— schema 示例里 `"dependsOn": [{ "ref": "design" }]`
 *      拿 `design` 当示例 ref，而 13 种工作项类型里**没有** design；
 *      规划 Agent 把这个词抄进了 `type`。
 *   2. 同一份示例上注着「估不出来填 null」，Agent 把这个习惯推广到
 *      `operationType`，写成显式 `null`，被 `.optional()` 拒收。
 *   3. 拒收之后**没有任何挽回** —— `agent-output.ts` 上写着「拒收换来的是
 *      一次重试或一次澄清」，而重试根本不存在：产品里最贵的那次调用
 *      整场作废，用户直接掉进一份与需求无关的规则模板。
 *
 *   三处各修一处，这一组守住第三处。
 */
const PLAN_REQ: StructuredRequirement = {
  title: '订单超时重试',
  businessContext: '背景',
  userProblem: '问题',
  businessGoal: '目标',
  userStories: [],
  scope: { inScope: [], outOfScope: [] },
  nonFunctional: [],
  successMetrics: [],
  constraints: [],
  risks: [],
  acceptanceCriteria: [],
  clarifications: [],
  assumptions: [],
  provenance: {},
  cost: 0,
  model: 'mock',
};

const planTask = (over: Record<string, unknown> = {}) => ({
  ref: 'step-1',
  title: '接入重试队列',
  description: '描述',
  type: 'task',
  phase: 'Execution',
  estimatedHours: 4,
  estimatedTokens: 50_000,
  riskLevel: 'low',
  requiredCapabilities: [],
  requiresHuman: false,
  acceptanceCriteria: [],
  dependsOn: [],
  ...over,
});

const plan = (...tasks: Record<string, unknown>[]) => ({
  tasks: tasks.length > 0 ? tasks : [planTask()],
  milestones: [],
  risks: [],
});

/** 事故当时那份产物的形状：type 抄了示例里的 ref，可选字段写成显式 null */
const ACCIDENT_PLAN = plan(planTask({ ref: 'design', type: 'design', operationType: null }));

async function generate(registry: RuntimeRegistry) {
  return provider(registry).generatePlan(PLAN_REQ, 'web', undefined, {
    orgId: fx.orgId,
    projectId: fx.projectId,
  });
}

describe('规划产出不合格时的修正轮', () => {
  it('★ 任务验收项保留有效的需求验收项关联，并丢弃伪造的关联', async () => {
    const registry = new RuntimeRegistry();
    const runtime = new FileWritingRuntime(
      plan(
        planTask({
          acceptanceCriteria: [
            {
              text: '重试三次后进入死信队列',
              verification: 'auto',
              requirementCriterionId: 'requirement-ac-1',
            },
            {
              text: '补充内部运行手册',
              verification: 'human',
              requirementCriterionId: 'not-a-requirement-criterion',
            },
          ],
        }),
      ),
    );
    await seedPlanningAgent(registry, runtime);
    const requirement: StructuredRequirement = {
      ...PLAN_REQ,
      acceptanceCriteria: [
        {
          id: 'requirement-ac-1',
          text: '重试三次后进入死信队列',
          verification: 'auto',
          status: 'pending',
          evidenceRef: null,
          verifiedAt: null,
        },
      ],
    };

    const result = await provider(registry).generatePlan(requirement, 'web', undefined, {
      orgId: fx.orgId,
      projectId: fx.projectId,
    });

    expect(result.tasks[0]!.acceptanceCriteria[0]?.requirementCriterionId).toBe(
      'requirement-ac-1',
    );
    expect(result.tasks[0]!.acceptanceCriteria[1]?.requirementCriterionId).toBeUndefined();
  });

  /**
   * ★★ 事故复现：第一轮拿回当时那份产物，第二轮拿回合格的。
   *   修完之后用户拿到的是**这个需求的**计划，而不是一份通用模板。
   */
  it('★ 第一轮 type 写错时带着报错再试一轮，救得回来', async () => {
    const registry = new RuntimeRegistry();
    const runtime = new FileWritingRuntime(ACCIDENT_PLAN, plan());
    await seedPlanningAgent(registry, runtime);

    const result = await generate(registry);

    expect(runtime.dispatchCount).toBe(2);
    // 没有回退 —— 这一条是整组的结论
    expect(result.fallback).toBeNull();
    expect(result.model).toContain('mock');
    expect(result.tasks.map((t) => t.title)).toEqual(['接入重试队列']);
  });

  /**
   * ★★ 修正轮的任务书必须同时带上**报错**与**上一版产物**。
   *   只给报错，Agent 不知道自己当时写了什么，只能从头重写（很可能重犯）；
   *   只给产物，它不知道哪里不合格。缺一样这一轮就白跑。
   */
  it('★ 修正轮的任务书里有 zod 报错、上一版产物、以及原始 schema', async () => {
    const registry = new RuntimeRegistry();
    const runtime = new FileWritingRuntime(ACCIDENT_PLAN, plan());
    await seedPlanningAgent(registry, runtime);

    await generate(registry);

    const repair = runtime.briefs[1]!;
    expect(repair).toContain('上一版产物没通过校验');
    // zod 报的是「哪个字段、错在哪」—— 原样递回去
    expect(repair).toContain('tasks.0.type');
    // 上一版产物本身
    expect(repair).toContain('"type":"design"');
    // 原始任务书整份附在后面：这一轮是新会话，schema 得再给一遍
    expect(repair).toContain('type` 只有这 13 个值');
    expect(repair).toContain(OUTPUT_FILE);
  });

  /**
   * ★ 每一轮一条独立的 agent_runs 记录。合并成一条的话，「第一轮为什么废了」
   *   会被第二轮的结果覆盖 —— 而那正是事后唯一能看出
   *   「这个 Agent 老是写错枚举」的地方。
   */
  it('★ 两轮各留一条 Run 记录，失败那条写明原因', async () => {
    const registry = new RuntimeRegistry();
    const runtime = new FileWritingRuntime(ACCIDENT_PLAN, plan());
    await seedPlanningAgent(registry, runtime);

    await generate(registry);

    const runs = await db.select().from(agentRuns).where(eq(agentRuns.kind, 'planning'));
    expect(runs).toHaveLength(2);
    const failed = runs.find((r) => r.status === 'failed');
    const done = runs.find((r) => r.status === 'completed');
    expect(failed?.errorMessage).toContain('tasks.0.type');
    expect(done).toBeTruthy();
  });

  /** ★ 废掉的那一轮照样花了钱，不计进去的话计划页上的成本会少一轮 */
  it('★ 成本跨轮累计', async () => {
    const registry = new RuntimeRegistry();
    const runtime = new FileWritingRuntime(ACCIDENT_PLAN, plan());
    runtime.costPerRound = 0.25;
    await seedPlanningAgent(registry, runtime);

    const result = await generate(registry);
    expect(result.cost).toBeCloseTo(0.5);
  });

  it('运行时未声明成本能力时，不把 token 事件里的占位 0 显示成 $0.00', async () => {
    const registry = new RuntimeRegistry();
    const runtime = new FileWritingRuntime(plan());
    runtime.costPerRound = 0;
    runtime.costReporting = false;
    await seedPlanningAgent(registry, runtime);

    const result = await generate(registry);
    expect(result.cost).toBeNull();
  });

  /**
   * ★★ 连败两轮才回退，而且只跑两轮 —— 每多一轮，用户就多等一次完整的
   *   Agent 执行。回退的原因里要写明「重试过仍不合格」：
   *   「试过一次没救回来」和「一次都没试」对用户是两个不同的结论。
   */
  it('★ 两轮都不合格才回退模板，且只跑两轮', async () => {
    const registry = new RuntimeRegistry();
    const runtime = new FileWritingRuntime(ACCIDENT_PLAN);
    await seedPlanningAgent(registry, runtime);

    const result = await generate(registry);

    expect(runtime.dispatchCount).toBe(2);
    expect(result.fallback?.code).toBe('output_invalid');
    expect(result.fallback?.reason).toContain('重试过仍不合格');
    expect(result.model).toContain('规则占位');
  });

  /** 图不自洽（悬空 ref）同样值得再来一轮 —— 它也是「照着报错改得回来」的那类 */
  it('依赖指向不存在的任务时也走修正轮', async () => {
    const registry = new RuntimeRegistry();
    const runtime = new FileWritingRuntime(
      plan(planTask({ dependsOn: [{ ref: 'nowhere', type: 'finish_to_start' }] })),
      plan(),
    );
    await seedPlanningAgent(registry, runtime);

    const result = await generate(registry);
    expect(runtime.dispatchCount).toBe(2);
    expect(result.fallback).toBeNull();
    expect(runtime.briefs[1]).toContain('nowhere');
  });

  /**
   * ★★ Runtime exit 0 means the model was reachable. Missing the file is a
   * delivery-protocol failure, and the repair brief can tell it exactly what
   * was omitted — unlike a timeout or runtime rejection.
   *
   * 运行成功但漏写文件是可纠正的交付协议错误，不应直接把用户丢进规则模板。
   */
  it('★ 第一轮漏写产物时用明确的写文件提醒纠正一次', async () => {
    const registry = new RuntimeRegistry();
    const runtime = new FileWritingRuntime(undefined, plan());
    await seedPlanningAgent(registry, runtime);

    const result = await generate(registry);

    expect(runtime.dispatchCount).toBe(2);
    expect(runtime.briefs[1]).toContain('没有创建 apos-output.json');
    expect(runtime.briefs[1]).toContain('实际调用写文件工具');
    expect(runtime.briefs[1]).toContain('上一轮 stdout');
    expect(runtime.briefs[1]).toContain('forgotten to write the file');
    expect(result.fallback).toBeNull();

    const runs = await db.select().from(agentRuns).where(eq(agentRuns.kind, 'planning'));
    const failed = runs.find((run) => run.status === 'failed');
    expect(failed?.errorClass).toBe('output_missing');
    const validation = await db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, failed!.id));
    expect(validation.some((event) => event.type === 'delivery_validation')).toBe(true);
  });

  it('连续两轮都漏写产物后才回退，并说明已重试', async () => {
    const registry = new RuntimeRegistry();
    const runtime = new FileWritingRuntime(undefined);
    await seedPlanningAgent(registry, runtime);

    const result = await generate(registry);

    expect(runtime.dispatchCount).toBe(2);
    expect(result.fallback?.code).toBe('output_missing');
    expect(result.fallback?.reason).toContain('重试过仍不合格');
  });

  /**
   * ★★ 显式 `null` 与省略同义，一轮就该通过。
   *
   *   null 表达的是「我不知道」，省略表达的也是「我不知道」—— 收下一个
   *   再拒掉另一个，拒的不是风险，是模型的书写习惯。而拼错的**字符串**
   *   照旧拒收：那才是真正危险的那类值（见下一条）。
   */
  it('★ 可选字段写成显式 null 时一轮通过，且不留下这一项', async () => {
    const registry = new RuntimeRegistry();
    const runtime = new FileWritingRuntime(
      plan(
        planTask({
          operationType: null,
          environment: null,
          dataSensitivity: null,
          externalFacing: null,
        }),
      ),
    );
    await seedPlanningAgent(registry, runtime);

    const result = await generate(registry);

    expect(runtime.dispatchCount).toBe(1);
    expect(result.fallback).toBeNull();
    // null 不该变成一个值 —— 它和「没写这一行」必须落到同一个结果
    expect(result.tasks[0]!.operationType).toBeUndefined();
    expect(result.tasks[0]!.externalFacing).toBeUndefined();
  });

  /**
   * ★★ 安全底线不松：拼错的枚举**字符串**照旧整份打回。
   *   `"delete_resrouce"` 看起来像个答案，实际让所有治理规则静默地匹配不上 ——
   *   null 不会这样伪装。
   */
  it('★ 拼错的 operationType 仍然拒收，不因为放宽 null 而一起放过', async () => {
    const registry = new RuntimeRegistry();
    const runtime = new FileWritingRuntime(plan(planTask({ operationType: 'delete_resrouce' })));
    await seedPlanningAgent(registry, runtime);

    const result = await generate(registry);

    expect(result.fallback?.code).toBe('output_invalid');
    expect(result.fallback?.reason).toContain('operationType');
  });
});
