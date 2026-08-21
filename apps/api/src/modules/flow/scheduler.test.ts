import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  agentRuns,
  artifacts,
  events,
  policies,
  projects,
  runEvents,
  workItemDependencies,
  workItems,
} from '@apos/db';
import { MockRuntime, RuntimeRegistry } from '@apos/agent-runtimes';
import { createWorkItem, resetDb, seedFixture, testDb, type Fixture } from '../../test/db';
import { seedAgent, waitFor, waitForRunEnd } from '../../test/agent-fixtures';
import { scheduleRound } from './scheduler';

const db = testDb();
let fx: Fixture;

beforeEach(async () => {
  await resetDb(db);
  fx = await seedFixture(db);
});

afterAll(async () => {
  await resetDb(db);
});

const corr = () => randomUUID();

describe('★ 阶段 1 闭环：调度 → 派发 → Agent 执行 → 自动流转', () => {
  it('完整走通一次成功执行，卡片自己从 ready 走到 reviewing', async () => {
    const agent = await seedAgent(db, fx);
    const item = await createWorkItem(db, fx, { executorType: null, executorId: null });

    const report = await scheduleRound(db, agent.registry, {
      projectId: fx.projectId,
      correlationId: corr(),
    });

    expect(report.scanned).toBe(1);
    expect(report.outcomes[0]?.action).toBe('dispatched');
    // 匹配理由必须可读，页面要直接展示
    expect(report.outcomes[0]?.reason).toContain('历史成功率 92%');

    await waitForRunEnd(db, item.id);
    // Run 结束后还要等状态流转落库
    await waitFor(async () => {
      const [w] = await db.select().from(workItems).where(eq(workItems.id, item.id));
      return w?.status === 'reviewing' ? w : null;
    }, { label: '任务未流转到 reviewing' });

    const [after] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(after!.status).toBe('reviewing');
    expect(after!.stage).toBe('review');
    expect(after!.executorType).toBe('agent');

    // Run 记录完整
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.workItemId, item.id));
    expect(run!.status).toBe('completed');
    expect(Number(run!.cost)).toBeGreaterThan(0);
    expect(run!.toolCallCount).toBe(3);
    /**
     * ★★ 派发时冻结的是**语义能力**，不只是工具名。
     *
     *   这个 Agent 在项目里没配过授权，于是走默认档案 —— 能在工作区里干活，
     *   推不了、合不了。快照必须把这件事记下来：半年后翻审计的人问的是
     *   「它当时被授权做什么」，而 `['read_file','write_file']` 回答不了，
     *   因为同一串工具名在适配器改版前后不是一回事。
     */
    expect(run!.permissionSnapshot).toMatchObject({
      version: 2,
      profileKey: 'standard_executor',
    });
    const snapshot = run!.permissionSnapshot as { capabilities: string[]; deniedTools: string[] };
    expect(snapshot.capabilities).toContain('workspace.write');
    expect(snapshot.capabilities).not.toContain('pull_request.merge');
    // 拒绝的能力落到运行时黑名单上 —— 合并在 mock 那边就叫 merge_pr
    expect(snapshot.deniedTools).toContain('merge_pr');

    // 产物落库
    const arts = await db.select().from(artifacts).where(eq(artifacts.workItemId, item.id));
    expect(arts).toHaveLength(1);
    expect(arts[0]!.title).toBe('PR #42');

    // 领域事件链完整
    const domainEvents = await db.select().from(events);
    const types = domainEvents.map((e) => e.type);
    expect(types).toContain('work_item.assigned');
    expect(types).toContain('agent_run.dispatched');
    expect(types).toContain('agent_run.started');
    expect(types).toContain('artifact.produced');
    expect(types).toContain('agent_run.completed');
    expect(types).toContain('work_item.status_changed');
  });

  it('run_events 分层：细节事件不污染领域事件表', async () => {
    const agent = await seedAgent(db, fx);
    const item = await createWorkItem(db, fx);

    await scheduleRound(db, agent.registry, { projectId: fx.projectId, correlationId: corr() });
    const run = await waitForRunEnd(db, item.id);

    const runEventRows = await db.select().from(runEvents).where(eq(runEvents.runId, run.id));
    const domainEvents = await db.select().from(events);

    // 执行细节量级远大于领域事件 —— 这正是分层的价值
    expect(runEventRows.length).toBeGreaterThan(domainEvents.length);

    // tool_call 只进 run_events
    expect(runEventRows.some((e) => e.type === 'tool_call')).toBe(true);
    expect(domainEvents.some((e) => e.type === 'tool_call')).toBe(false);

    // 简明模式只看 milestone
    const milestones = runEventRows.filter((e) => e.level === 'milestone');
    expect(milestones.map((e) => e.type).sort()).toEqual(['artifact', 'run_ended', 'run_started']);
  });

  it('token 用量从 Run 累加到 Work Item 与项目', async () => {
    const agent = await seedAgent(db, fx);
    const item = await createWorkItem(db, fx);

    await scheduleRound(db, agent.registry, { projectId: fx.projectId, correlationId: corr() });
    await waitForRunEnd(db, item.id);
    await waitFor(async () => {
      const [w] = await db.select().from(workItems).where(eq(workItems.id, item.id));
      return Number(w?.actualTokens ?? 0) > 0 ? w : null;
    }, { label: 'token 未累加' });

    const [afterItem] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    const [afterProject] = await db.select().from(projects).where(eq(projects.id, fx.projectId));

    /**
     * ★ mock 运行时每步报 1000 input + 200 output + 500 cacheRead + 300 cacheWrite，
     *   三步共 6000 —— 四类都要算进去。少算一类这里就对不上。
     */
    expect(afterItem!.actualTokens).toBe(6000);
    expect(afterProject!.tokensSpent).toBe(6000);
  });
});

describe('依赖与调度顺序', () => {
  it('依赖未满足的任务不被调度', async () => {
    const agent = await seedAgent(db, fx);
    const blocker = await createWorkItem(db, fx, { status: 'ready', title: '前置任务' });
    const dependent = await createWorkItem(db, fx, { title: '后置任务' });

    await db.insert(workItemDependencies).values({
      projectId: fx.projectId,
      fromId: blocker.id,
      toId: dependent.id,
      type: 'finish_to_start',
      createdByType: 'system',
    });

    const report = await scheduleRound(db, agent.registry, {
      projectId: fx.projectId,
      correlationId: corr(),
    });

    // 只有 blocker 被调度
    expect(report.scanned).toBe(1);
    expect(report.outcomes[0]?.workItemId).toBe(blocker.id);
  });

  it('前置完成后，后置任务在下一轮被调度', async () => {
    const agent = await seedAgent(db, fx);
    const blocker = await createWorkItem(db, fx, { status: 'done', title: '已完成的前置' });
    const dependent = await createWorkItem(db, fx, { title: '后置任务' });

    await db.insert(workItemDependencies).values({
      projectId: fx.projectId,
      fromId: blocker.id,
      toId: dependent.id,
      type: 'finish_to_start',
      createdByType: 'system',
    });

    const report = await scheduleRound(db, agent.registry, {
      projectId: fx.projectId,
      correlationId: corr(),
    });

    expect(report.outcomes.map((o) => o.workItemId)).toEqual([dependent.id]);
    expect(report.outcomes[0]?.action).toBe('dispatched');
  });
});

describe('WIP 与预算护栏', () => {
  it('WIP 满时不挤占，任务排队并说明原因', async () => {
    const agent = await seedAgent(db, fx, { maxConcurrency: 5 });
    await db.update(projects).set({ wipLimits: { execution: 1 } }).where(eq(projects.id, fx.projectId));

    await createWorkItem(db, fx, { status: 'executing', title: '占位任务' });
    await createWorkItem(db, fx, { title: '排队任务' });

    const report = await scheduleRound(db, agent.registry, {
      projectId: fx.projectId,
      correlationId: corr(),
    });

    expect(report.outcomes[0]?.action).toBe('skipped');
    expect(report.outcomes[0]?.reason).toContain('WIP 上限 1');
  });

  it('★ 预估 token 会超预算时派发前就拦下', async () => {
    const agent = await seedAgent(db, fx);
    await db
      .update(projects)
      .set({ tokenBudget: 500_000, tokensSpent: 400_000 })
      .where(eq(projects.id, fx.projectId));

    await createWorkItem(db, fx, { estimatedTokens: 250_000 });

    const report = await scheduleRound(db, agent.registry, {
      projectId: fx.projectId,
      correlationId: corr(),
    });

    expect(report.outcomes[0]?.action).toBe('skipped');
    expect(report.outcomes[0]?.reason).toContain('超出预算');

    // 没有产生任何 Run
    expect(await db.select().from(agentRuns)).toHaveLength(0);
  });

  it('预算已耗尽时停止调度新任务', async () => {
    const agent = await seedAgent(db, fx);
    await db
      .update(projects)
      .set({ tokenBudget: 500_000, tokensSpent: 500_000 })
      .where(eq(projects.id, fx.projectId));

    await createWorkItem(db, fx);

    const report = await scheduleRound(db, agent.registry, {
      projectId: fx.projectId,
      correlationId: corr(),
    });
    expect(report.outcomes[0]?.reason).toContain('达到预算');
  });
});

describe('执行主体匹配', () => {
  /**
   * ★★ 项目成员关系是派发的硬性前置，不是匹配偏好。
   *
   *   这条走的是 seedAgent 的 `inProject: false` —— 夹具默认会把 Agent
   *   登记进项目（真实路径就是这样），这里显式不登记，验的是那道闸门
   *   本身还在。它同时钉住了拒绝理由：指向「没加进项目」，
   *   而不是让人跑去给 Agent 加技能。
   */
  it('★ 没被加进项目的 Agent 一律不派发', async () => {
    const registry = new RuntimeRegistry();
    await seedAgent(db, fx, { registry, inProject: false });

    await createWorkItem(db, fx, { executorType: null, executorId: null });

    const report = await scheduleRound(db, registry, {
      projectId: fx.projectId,
      correlationId: corr(),
    });

    expect(report.outcomes[0]?.action).toBe('skipped');
    expect(report.outcomes[0]?.reason).toContain('不是本项目成员');
  });

  it('★ 无匹配 Agent 时任务被阻塞并给出具体原因', async () => {
    const registry = new RuntimeRegistry();
    /**
     * ★ 默认档案（standard_executor）不含开 PR 的能力 —— 这正是
     *   「没配置 ≠ 没权限，但默认档案是有边界的」那条设计的直接体现。
     */
    await seedAgent(db, fx, { registry });

    // 任务要求 create_pr，而默认档案给不了这条能力
    const item = await createWorkItem(db, fx, {
      executorType: null,
      executorId: null,
      typeData: { requiredTools: ['create_pr'] },
    });

    const report = await scheduleRound(db, registry, {
      projectId: fx.projectId,
      correlationId: corr(),
    });

    expect(report.outcomes[0]?.action).toBe('skipped');
    expect(report.outcomes[0]?.reason).toContain('缺少所需工具权限：create_pr');

    const [after] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(after!.blockedReason).toContain('create_pr');
    expect(after!.blockedSince).toBeTruthy();

    /**
     * ★ 除了那句中文，逐个候选的原因码也要落库 —— 界面据此分层展示
     *   并给出「去授权」的直达入口，而不是让用户读一行分号串起来的长句。
     */
    expect(after!.blockedDetail?.kind).toBe('no_matching_agent');
    const rejected = after!.blockedDetail?.candidates ?? [];
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[0]?.code).toBe('missing_tools');
    expect(rejected[0]?.scope).toBe('project');
  });

  /**
   * ★★ 调度器每轮都会重新推出同一个结论。无条件写的代价有两处：
   *
   *   1. Timeline 上堆出几十条一模一样的 `work_item.blocked`，
   *      把真正的状态变更淹掉（问题记录 #43）；
   *   2. `blockedSince` 每轮被刷新，于是卡片上的阻塞时长**恒等于 0m** ——
   *      而那一栏本来是用来判断「卡了多久」的（问题记录 #2）。
   *
   *   两条都在这一个测试里钉住：跑三轮，事件只该有一条，起点不该动。
   */
  it('★ 原因没变时不重复记事件，也不重置阻塞起点', async () => {
    const registry = new RuntimeRegistry();
    await seedAgent(db, fx, { registry });
    const item = await createWorkItem(db, fx, {
      executorType: null,
      executorId: null,
      typeData: { requiredTools: ['create_pr'] },
    });

    await scheduleRound(db, registry, { projectId: fx.projectId, correlationId: corr() });
    const [first] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    const firstBlockedAt = first!.blockedSince!.getTime();

    await scheduleRound(db, registry, { projectId: fx.projectId, correlationId: corr() });
    await scheduleRound(db, registry, { projectId: fx.projectId, correlationId: corr() });

    const blockedEvents = await db
      .select()
      .from(events)
      .where(eq(events.subjectId, item.id));
    expect(blockedEvents.filter((e) => e.type === 'work_item.blocked')).toHaveLength(1);

    const [after] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(after!.blockedSince!.getTime()).toBe(firstBlockedAt);
  });

  /** ★ 原因**变了**仍然要记 —— 去重不能把「情况变了」也一起吞掉 */
  it('★ 原因变化时重新记一条事件', async () => {
    const registry = new RuntimeRegistry();
    await seedAgent(db, fx, { registry });
    const item = await createWorkItem(db, fx, {
      executorType: null,
      executorId: null,
      typeData: { requiredTools: ['create_pr'] },
    });

    await scheduleRound(db, registry, { projectId: fx.projectId, correlationId: corr() });

    // 换一个要求：拒绝理由随之改变
    await db
      .update(workItems)
      .set({ typeData: { requiredTools: ['deploy_prod'] } })
      .where(eq(workItems.id, item.id));

    await scheduleRound(db, registry, { projectId: fx.projectId, correlationId: corr() });

    const blockedEvents = await db.select().from(events).where(eq(events.subjectId, item.id));
    expect(blockedEvents.filter((e) => e.type === 'work_item.blocked')).toHaveLength(2);
  });

  it('标记为需要人类经验的任务不分配给 Agent', async () => {
    const agent = await seedAgent(db, fx);
    await createWorkItem(db, fx, {
      executorType: null,
      executorId: null,
      typeData: { requiresHuman: true },
    });

    const report = await scheduleRound(db, agent.registry, {
      projectId: fx.projectId,
      correlationId: corr(),
    });

    expect(report.outcomes[0]?.action).toBe('skipped');
    /**
     * ★ 措辞是「被指定为人工执行」而不是「需要人类经验」：`requiresHuman`
     *   这个布尔已经拆成 executionMode + approvalGate 两栏（见 domain 的
     *   matching.ts），旧数据由 executionModeOf 归一到 executionMode='human'。
     *   这里断言的是归一之后的那句 —— 拒绝理由要指向真实原因。
     */
    expect(report.outcomes[0]?.reason).toContain('人工执行');
  });

  it('已指派人类的任务不派发 Agent', async () => {
    const agent = await seedAgent(db, fx);
    await createWorkItem(db, fx, { executorType: 'human', executorId: fx.userId });

    const report = await scheduleRound(db, agent.registry, {
      projectId: fx.projectId,
      correlationId: corr(),
    });

    expect(report.outcomes[0]?.action).toBe('assigned_to_human');
    expect(await db.select().from(agentRuns)).toHaveLength(0);
  });

  it('多个 Agent 时选评分最高的，并记录匹配依据', async () => {
    const registry = new RuntimeRegistry();
    const runtime = new MockRuntime();
    await seedAgent(db, fx, {
      registry,
      runtime,
      name: 'code-agent-1',
      stats: { successRate: 0.72, sampleSize: 25, avgTokens: 455_000 },
    });
    const better = await seedAgent(db, fx, {
      registry,
      runtime,
      name: 'code-agent-2',
      stats: { successRate: 0.96, sampleSize: 30, avgTokens: 190_000 },
    });

    await createWorkItem(db, fx, { executorType: null, executorId: null });

    const report = await scheduleRound(db, registry, {
      projectId: fx.projectId,
      correlationId: corr(),
    });

    expect(report.outcomes[0]?.agentId).toBe(better.agentId);

    const assigned = (await db.select().from(events)).find((e) => e.type === 'work_item.assigned');
    expect(assigned!.payload['matchReasons']).toEqual(
      expect.arrayContaining([expect.stringContaining('历史成功率 96%')]),
    );
  });
});

describe('Policy 在调度路径上生效', () => {
  it('★ 生产 DDL 任务派发时被拦下，不真正启动 Agent', async () => {
    /**
     * ★ 规则要自己建。平台不再自带硬编码基线 —— 库里没有规则时这个任务
     *   会照常派发出去，那测的是调度器，不是「Policy 在调度路径上生效」。
     */
    await db.insert(policies).values({
      orgId: fx.orgId,
      projectId: fx.projectId,
      name: '生产数据库变更必须由 DBA 审批',
      description: '',
      priority: 100,
      enabled: true,
      createdBy: fx.userId,
      condition: {
        all: [
          { fact: 'environment', op: 'eq', value: 'production' },
          { fact: 'operationType', op: 'in', value: ['db_ddl', 'db_dml'] },
        ],
      },
      action: { type: 'require_human_review', assignee: { kind: 'role', role: 'dba' }, dueInHours: 4 },
    });

    const agent = await seedAgent(db, fx);
    const item = await createWorkItem(db, fx, {
      typeData: { environment: 'production', operationType: 'db_ddl' },
    });

    await scheduleRound(db, agent.registry, { projectId: fx.projectId, correlationId: corr() });

    const [after] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(after!.status).toBe('awaiting_decision');

    // Run 记录存在但停在 queued —— 没有真的让 Agent 动手
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.workItemId, item.id));
    expect(run!.status).toBe('queued');
    expect(await db.select().from(runEvents)).toHaveLength(0);
  });
});
