import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { agentRuns, decisions, requirementClarifications, workItems } from '@apos/db';
import { MockRuntime, RuntimeRegistry, degradedMockRuntime } from '@apos/agent-runtimes';
import { buildApp } from '../app';
import { EventBus } from '../modules/event/bus';
import { StubPlanningProvider } from '../modules/planning/stub-provider';
import { createWorkItem, resetDb, seedFixture, testDb, type Fixture } from '../test/db';
import { seedAgent, waitFor } from '../test/agent-fixtures';
import { dispatchRun } from '../modules/agent/dispatch';

const db = testDb();
let app: FastifyInstance;
let fx: Fixture;
let registry: RuntimeRegistry;

beforeEach(async () => {
  await resetDb(db);
  fx = await seedFixture(db);
  registry = new RuntimeRegistry();
  app = await buildApp({
    db,
    bus: new EventBus(),
    registry,
    provider: new StubPlanningProvider(),
  });
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await resetDb(db);
});

const auth = () => ({ 'x-user-id': fx.userId });

describe('认证与错误映射', () => {
  it('缺少身份头返回 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${fx.projectId}/requirements`,
      payload: { rawInput: '测试' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  /**
   * `X-User-Id: null` 是客户端很常见的失误（变量是 null 被拼成字符串）。
   * 不校验格式的话它会一路走到 SQL，报 uuid 语法错误变成 500，
   * 调用方以为服务端挂了。
   */
  it('★ 格式非法的身份头返回 401 而不是 500', async () => {
    // 身份可选的端点同样不能把格式错误吞成 500
    for (const url of [
      '/api/v1/decisions',
      `/api/v1/projects/${fx.projectId}/board?onlyMine=true`,
    ]) {
      for (const bad of ['null', 'undefined', 'admin', '123']) {
        const res = await app.inject({ method: 'GET', url, headers: { 'x-user-id': bad } });
        expect(res.statusCode).toBe(401);
      }
    }

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${fx.projectId}/requirements`,
      headers: { 'x-user-id': 'null' },
      payload: { rawInput: '测试' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.details.received).toBe('null');
  });

  it('不存在的资源返回 404 且带中文说明', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/work-items/${randomUUID()}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toContain('任务不存在');
  });

  it('校验失败返回 400 并列出具体字段', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${fx.projectId}/requirements`,
      headers: auth(),
      payload: { rawInput: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('每个错误响应都带 traceId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/plans/${randomUUID()}`,
      headers: auth(),
    });
    expect(res.json().error.traceId).toMatch(/^req_/);
  });
});

describe('★ 需求 → 计划 → 看板（HTTP 全链路）', () => {
  it('走通完整流程', async () => {
    await seedAgent(db, fx, { registry });

    // 录入需求
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${fx.projectId}/requirements`,
      headers: auth(),
      payload: { rawInput: '订单查询太慢了，想支持按手机号和时间段搜索，周五上线' },
    });
    expect(created.statusCode).toBe(201);
    const reqId = created.json().requirement.id;

    // AI 结构化
    const analyzed = await app.inject({
      method: 'POST',
      url: `/api/v1/requirements/${reqId}/analyze`,
      headers: auth(),
    });
    expect(analyzed.statusCode).toBe(200);
    expect(analyzed.json().mustConfirmCount).toBeGreaterThan(0);

    // ★ 必答问题没答完时确认被拒，且告知是哪几个
    const premature = await app.inject({
      method: 'POST',
      url: `/api/v1/requirements/${reqId}/approve`,
      headers: auth(),
      payload: {},
    });
    expect(premature.statusCode).toBe(422);
    expect(premature.json().error.code).toBe('UNANSWERED_MUST_CONFIRM');
    expect(premature.json().error.details.length).toBeGreaterThan(0);

    // 回答澄清问题
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/requirements/${reqId}`,
      headers: auth(),
    });
    const clarifications = detail.json().clarifications as { id: string; level: string }[];

    for (const q of clarifications.filter((c) => c.level === 'must_confirm')) {
      const answered = await app.inject({
        method: 'POST',
        url: `/api/v1/clarifications/${q.id}/answer`,
        headers: auth(),
        payload: { answer: '采纳建议', usedSuggestion: true },
      });
      expect(answered.statusCode).toBe(200);
    }

    // 确认需求
    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/requirements/${reqId}/approve`,
      headers: auth(),
      payload: {},
    });
    expect(approved.statusCode).toBe(200);

    // 生成计划
    const planned = await app.inject({
      method: 'POST',
      url: `/api/v1/requirements/${reqId}/plans`,
      headers: auth(),
    });
    expect(planned.statusCode).toBe(201);
    const plan = planned.json();
    expect(plan.autoActions.length).toBeGreaterThan(0);
    expect(plan.humanGates.length).toBeGreaterThan(0);

    // 批准计划
    const activated = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.planId}/approve`,
      headers: auth(),
      payload: {},
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json().activatedTasks).toBe(plan.taskCount);

    // 触发调度
    const scheduled = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${fx.projectId}/schedule`,
      headers: auth(),
    });
    expect(scheduled.statusCode).toBe(200);
    expect(
      scheduled.json().outcomes.filter((o: { action: string }) => o.action === 'dispatched'),
    ).toHaveLength(1);

    // 看板反映真实状态
    await waitFor(async () => {
      const board = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${fx.projectId}/board`,
        headers: auth(),
      });
      const review = board.json().columns.find((c: { key: string }) => c.key === 'review');
      return review.count > 0 ? board.json() : null;
    }, { label: '看板未出现 review 列卡片' });

    const board = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}/board`,
      headers: auth(),
    });

    const columns = board.json().columns as { key: string; count: number; items: unknown[] }[];
    expect(columns.map((c) => c.key)).toEqual([
      'intake', 'planning', 'execution', 'review', 'release', 'done',
    ]);
    expect(columns.find((c) => c.key === 'review')!.count).toBeGreaterThan(0);
  });
});

describe('看板', () => {
  it('卡片带执行主体名称、依赖数与成本，前端不用二次请求', async () => {
    const agent = await seedAgent(db, fx, { registry, name: 'code-agent-1' });
    const item = await createWorkItem(db, fx, {
      executorType: 'agent',
      executorId: agent.agentId,
      actualCost: '3.2000',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}/board`,
      headers: auth(),
    });

    const execution = res.json().columns.find((c: { key: string }) => c.key === 'execution');
    const card = execution.items[0];

    expect(card.id).toBe(item.id);
    expect(card.executor).toEqual({ type: 'agent', id: agent.agentId, name: 'code-agent-1' });
    expect(card.cost).toBe('3.2000');
    expect(card.unmetDependencies).toBe(0);
  });

  it('阻塞卡片带原因与时长', async () => {
    await createWorkItem(db, fx, {
      status: 'blocked',
      blockedSince: new Date(Date.now() - 3 * 3600_000),
      blockedReason: '等待 DBA 审批',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}/board?blocked=true`,
      headers: auth(),
    });

    const card = res.json().columns.find((c: { key: string }) => c.key === 'execution').items[0];
    expect(card.blockedReason).toBe('等待 DBA 审批');
    expect(card.blockedMinutes).toBeGreaterThanOrEqual(179);
    expect(res.json().summary.blocked).toBe(1);
  });

  it('Done 列默认折叠，避免长期项目无限增长', async () => {
    for (let i = 0; i < 8; i++) {
      await createWorkItem(db, fx, { status: 'done', title: `已完成 ${i}` });
    }

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}/board`,
      headers: auth(),
    });

    const done = res.json().columns.find((c: { key: string }) => c.key === 'done');
    expect(done.count).toBe(8);
    expect(done.items).toHaveLength(5);
    expect(done.hasMore).toBe(true);
  });
});

describe('★ 手动状态调整必须留痕', () => {
  it('不填原因时被拒绝', async () => {
    const item = await createWorkItem(db, fx, { status: 'reviewing' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/work-items/${item.id}/status`,
      headers: auth(),
      payload: { toStatus: 'changes_requested' },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().error.details)).toContain('必须填写原因');
  });

  it('填了原因则放行并记入事件', async () => {
    const item = await createWorkItem(db, fx, { status: 'reviewing' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/work-items/${item.id}/status`,
      headers: auth(),
      payload: { toStatus: 'changes_requested', reason: '审核发现接口未做鉴权' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().to).toBe('changes_requested');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/work-items/${item.id}`,
      headers: auth(),
    });
    const changed = detail
      .json()
      .timeline.find((e: { type: string }) => e.type === 'work_item.status_changed');
    expect(changed.payload.reason).toBe('审核发现接口未做鉴权');
    expect(changed.actorType).toBe('human');
  });

  it('非法流转返回 409 并给出可用操作', async () => {
    const item = await createWorkItem(db, fx, { status: 'ready' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/work-items/${item.id}/status`,
      headers: auth(),
      payload: { toStatus: 'acceptance', reason: '试试' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVALID_TRANSITION');
    expect(res.json().error.details.allowedTriggers).toContain('run_dispatched');
  });

  /**
   * 目标状态到 trigger 的映射一度是手写表，ready 被写死成 retry_requested，
   * 于是「返工后重新开始」（changes_requested → ready，走 rework_started）
   * 在界面上能拖、后端一律 409。同一个目标状态可以从不同来源经不同 trigger 抵达，
   * 只有状态机知道该用哪个。
   */
  it('★ 同一目标状态按来源选 trigger：返工重新开始走得通', async () => {
    const item = await createWorkItem(db, fx, { status: 'changes_requested' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/work-items/${item.id}/status`,
      headers: auth(),
      payload: { toStatus: 'ready', reason: '按评审意见改完了，重新开始' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().to).toBe('ready');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/work-items/${item.id}`,
      headers: auth(),
    });
    const changed = detail
      .json()
      .timeline.find((e: { type: string }) => e.type === 'work_item.status_changed');
    expect(changed.payload.trigger).toBe('rework_started');
  });

  it('人不能伪造只属于系统的 trigger', async () => {
    const item = await createWorkItem(db, fx, { status: 'executing' });

    // executing → reviewing 有两条路：agent_run_completed（系统）与
    // human_work_completed（人）。人发起时必须走后者，否则事件流里
    // 会出现「Agent 报告完成」而实际上没有 Agent 做过任何事
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/work-items/${item.id}/status`,
      headers: auth(),
      payload: { toStatus: 'reviewing', reason: '我手工做完了' },
    });

    expect(res.statusCode).toBe(200);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/work-items/${item.id}`,
      headers: auth(),
    });
    const changed = detail
      .json()
      .timeline.find((e: { type: string }) => e.type === 'work_item.status_changed');
    expect(changed.payload.trigger).toBe('human_work_completed');
  });

  it('Guard 未通过时返回 409 与可读原因', async () => {
    const item = await createWorkItem(db, fx, {
      status: 'reviewing',
      acceptanceCriteria: [
        { id: 'a', text: 'P95 < 500ms', verification: 'auto', status: 'pending', evidenceRef: null, verifiedAt: null },
      ],
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/work-items/${item.id}/status`,
      headers: auth(),
      payload: { toStatus: 'waiting_for_release', reason: '想直接发布' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('验收标准未通过');
    // 可强制放行的 guard 要标出来，前端才能给「强制放行」按钮
    expect(res.json().error.details.failures[0].overridable).toBe(true);
    expect(res.json().error.details.failures[0].overrideRole).toBe('tech_lead');
  });
});

describe('★ 决策责任不可代行', () => {
  it('非责任人无法批准，提示用改派', async () => {
    const item = await createWorkItem(db, fx);

    const { users } = await import('@apos/db');
    const [other] = await db
      .insert(users)
      .values({ orgId: fx.orgId, email: `dba-${randomUUID()}@acme.dev`, name: '王强' })
      .returning();
    const otherUserId = other!.id;

    const [decision] = await db
      .insert(decisions)
      .values({
        orgId: fx.orgId,
        projectId: fx.projectId,
        workItemId: item.id,
        type: 'high_risk_operation',
        riskLevel: 'high',
        title: '生产数据库变更审批',
        whyHuman: 'Policy 要求 DBA 审批',
        assigneeId: null,
      })
      .returning();

    // 手动指派给别人
    await db.update(decisions).set({ assigneeId: otherUserId }).where(eq(decisions.id, decision!.id));

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/decisions/${decision!.id}/approve`,
      headers: auth(),
      payload: {},
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('不可代行');
    expect(res.json().error.message).toContain('改派');
  });

  it('已处理的决策不能重复批准', async () => {
    const [decision] = await db
      .insert(decisions)
      .values({
        orgId: fx.orgId,
        projectId: fx.projectId,
        type: 'approval',
        riskLevel: 'low',
        title: '测试决策',
        whyHuman: '测试',
        assigneeId: fx.userId,
        status: 'approved',
      })
      .returning();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/decisions/${decision!.id}/approve`,
      headers: auth(),
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('VERSION_CONFLICT');
  });

  it('★ 批准时附加的约束写入任务，Agent 执行时必须遵守', async () => {
    const item = await createWorkItem(db, fx, { status: 'executing' });

    // 让任务进入决策等待
    const { transition } = await import('../modules/flow/transition');
    const entered = await transition(db, {
      workItemId: item.id,
      trigger: 'decision_required',
      actor: { type: 'system', id: null },
      correlationId: randomUUID(),
    });
    expect(entered.ok).toBe(true);

    const [decision] = await db
      .insert(decisions)
      .values({
        orgId: fx.orgId,
        projectId: fx.projectId,
        workItemId: item.id,
        type: 'high_risk_operation',
        riskLevel: 'high',
        title: '索引变更审批',
        whyHuman: 'Policy 要求',
        assigneeId: fx.userId,
      })
      .returning();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/decisions/${decision!.id}/approve`,
      headers: auth(),
      payload: {
        constraints: [
          {
            type: 'time_window',
            value: '02:00-05:00',
            description: '仅在低峰期执行',
            enforcement: 'system',
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);

    const [after] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(after!.constraints).toHaveLength(1);
    expect(after!.constraints[0]).toMatchObject({
      type: 'time_window',
      description: '仅在低峰期执行',
      decisionId: decision!.id,
    });
    // 任务回到进入决策前的状态
    expect(after!.status).toBe('executing');
  });

  /**
   * ★ 批量批准省的是点击，不是规则。
   *
   *   为批量另写一条快路径，是这类功能出事故最常见的原因 ——
   *   所以它逐条走单条批准的同一个函数，「不可代行」必须原样生效。
   *   这个测试就是那条路径的锁：一条能批、一条是别人的，只能过一条。
   */
  it('★ 批量批准不绕过「不可代行」：别人的决策照样批不动', async () => {
    const { users } = await import('@apos/db');
    const [other] = await db
      .insert(users)
      .values({ orgId: fx.orgId, email: `dba-${randomUUID()}@acme.dev`, name: '王强' })
      .returning();

    const rows = await db
      .insert(decisions)
      .values([
        {
          orgId: fx.orgId,
          projectId: fx.projectId,
          type: 'approval',
          riskLevel: 'low',
          title: '我的决策',
          whyHuman: '测试',
          assigneeId: fx.userId,
        },
        {
          orgId: fx.orgId,
          projectId: fx.projectId,
          type: 'approval',
          riskLevel: 'low',
          title: '别人的决策',
          whyHuman: '测试',
          assigneeId: other!.id,
        },
      ])
      .returning();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/decisions/batch-approve',
      headers: auth(),
      payload: { ids: rows.map((r) => r.id) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.approved).toBe(1);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].error).toContain('不可代行');

    // 别人那条必须原封不动
    const [mine] = await db.select().from(decisions).where(eq(decisions.id, rows[0]!.id));
    const [theirs] = await db.select().from(decisions).where(eq(decisions.id, rows[1]!.id));
    expect(mine!.status).toBe('approved');
    expect(theirs!.status).toBe('pending');
  });
});

describe('Agent 回调鉴权', () => {
  it('Run 令牌无效时拒绝，防止事件伪造', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/agent-callback/runs/${randomUUID()}/events`,
      headers: { authorization: 'Bearer wrong-token' },
      payload: { type: 'heartbeat', runId: 'x', seq: 0, ts: new Date().toISOString() },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('Run 详情（页面文档 09）', () => {
  async function completedRun() {
    const agent = await seedAgent(db, fx, { registry });
    const item = await createWorkItem(db, fx);

    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${fx.projectId}/schedule`,
      headers: auth(),
    });

    const run = await waitFor(async () => {
      const [r] = await db.select().from(agentRuns).where(eq(agentRuns.workItemId, item.id));
      return r?.status === 'completed' ? r : null;
    }, { label: 'Run 未完成' });

    return { agent, item, run };
  }

  it('一次查全：输入、指标、产物、关联，前端不用分五次请求', async () => {
    const { run, item } = await completedRun();

    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${run.id}`, headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.run.id).toBe(run.id);
    expect(body.agent.name).toBe('code-agent-1');
    expect(body.workItem.id).toBe(item.id);

    // ★ 权限快照：Agent 权限可能在 Run 之后被改，回溯必须看当时的
    expect(body.input.permissions.allowedTools).toContain('read_file');
    expect(body.input.goal).toBe(item.title);
    expect(Array.isArray(body.input.context)).toBe(true);

    // 工具调用按名字聚合 —— 「哪个工具被反复调用」是排障的第一个线索
    expect(body.metrics.toolCalls.total).toBeGreaterThan(0);
    expect(Object.keys(body.metrics.toolCalls.byTool).length).toBeGreaterThan(0);
    expect(body.metrics.tokens.total).toBeGreaterThan(0);
    expect(body.metrics.durationMs).toBeGreaterThanOrEqual(0);

    expect(body.artifacts.length).toBeGreaterThan(0);
    expect(body.related.attempts).toHaveLength(1);
    expect(body.error).toBeNull();
  });

  /**
   * ★ 简明与详细的差别是每条事件的深度，不是返回哪些事件。
   *
   *   按 level 过滤会让简明模式只剩「启动 / 产出 / 结束」三行 ——
   *   中间做了什么全没了，而这一页存在的理由就是回答「它做了什么」。
   */
  it('★ 简明模式仍返回全部事件，只是不带 payload', async () => {
    const { run } = await completedRun();

    const brief = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${run.id}/events`,
      headers: auth(),
    });
    const detailed = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${run.id}/events?level=detailed`,
      headers: auth(),
    });

    const briefEvents = brief.json().events as { type: string; payload: unknown }[];
    const detailedEvents = detailed.json().events as { type: string; payload: unknown }[];

    expect(briefEvents.length).toBe(detailedEvents.length);
    expect(briefEvents.some((e) => e.type === 'tool_call')).toBe(true);
    // 省掉的是体积大头：推理全文、工具原始参数、上下文明细
    expect(briefEvents.every((e) => e.payload === null)).toBe(true);
    expect(detailedEvents.some((e) => e.payload !== null)).toBe(true);
  });

  it('after 游标只返回新增事件，供执行中的 Run 增量追加', async () => {
    const { run } = await completedRun();

    const all = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${run.id}/events?level=detailed`,
      headers: auth(),
    });
    const events = all.json().events as { seq: number }[];
    const midpoint = events[Math.floor(events.length / 2)]!.seq;

    const tail = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${run.id}/events?level=detailed&after=${midpoint}`,
      headers: auth(),
    });

    expect(tail.json().events.every((e: { seq: number }) => e.seq > midpoint)).toBe(true);
    expect(tail.json().events.length).toBeLessThan(events.length);
  });

  /** 成本超支最常见的原因分步骤才看得出来，总数只能告诉你「超了」 */
  it('成本按步骤拆分，能定位哪一步烧钱', async () => {
    const { run } = await completedRun();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${run.id}/cost-breakdown`,
      headers: auth(),
    });

    const steps = res.json().steps as { step: number | null; costUsd: number }[];
    expect(steps.length).toBeGreaterThan(1);
    const total = steps.reduce((sum, s) => sum + s.costUsd, 0);
    expect(total).toBeCloseTo(Number(run.cost), 4);
  });

  it('失败的 Run 给出失败分类、Agent 自述与失败步骤', async () => {
    const registryLocal = new RuntimeRegistry();
    const runtime = new MockRuntime(
      {},
      {
        outcome: 'failed',
        steps: ['分析', '尝试定位'],
        error: {
          class: 'context_insufficient',
          message: '无法定位 orders 表结构定义',
          selfReport: '我需要 orders 表的结构定义，但仓库里没找到 schema 文件。',
        },
      },
    );
    const agent = await seedAgent(db, fx, { registry: registryLocal, runtime });
    const item = await createWorkItem(db, fx);

    const dispatched = await dispatchRun(db, registryLocal, {
      workItemId: item.id,
      agentId: agent.agentId,
      correlationId: randomUUID(),
    });
    if (!dispatched.ok) throw new Error('派发失败');

    await waitFor(async () => {
      const [r] = await db.select().from(agentRuns).where(eq(agentRuns.id, dispatched.runId));
      return r?.status === 'failed' ? r : null;
    }, { label: 'Run 未失败' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${dispatched.runId}`,
      headers: auth(),
    });
    const error = res.json().error;

    expect(error.class).toBe('context_insufficient');
    // ★ Agent 自述比堆栈有用得多，是排障效率的核心
    expect(error.selfReport).toContain('schema 文件');
    // 失败在哪一步，而不是只说失败了
    expect(error.failedAt.step).toBe(2);
    expect(error.failedAt.total).toBe(2);
  });
});

describe('★ Run 控制：能力不足要如实报，不能悄悄降级', () => {
  async function runningRun(runtime: MockRuntime) {
    const registryLocal = new RuntimeRegistry();
    const agent = await seedAgent(db, fx, { registry: registryLocal, runtime });
    const item = await createWorkItem(db, fx);

    const dispatched = await dispatchRun(db, registryLocal, {
      workItemId: item.id,
      agentId: agent.agentId,
      correlationId: randomUUID(),
    });
    if (!dispatched.ok) throw new Error('派发失败');

    // 控制指令要走 HTTP，app 用的是外层 registry
    registry.register(agent.runtimeId, runtime);
    return dispatched.runId;
  }

  it('终止必须填原因 —— 不可逆操作要留痕', async () => {
    const runId = await runningRun(new MockRuntime({}, { steps: ['慢'], stepDelayMs: 800 }));

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/control`,
      headers: auth(),
      payload: { action: 'terminate' },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().error.details)).toContain('终止必须填写原因');
  });

  it('终止成功后写入事件', async () => {
    const runtime = new MockRuntime({}, { steps: ['慢'], stepDelayMs: 800 });
    const runId = await runningRun(runtime);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/control`,
      headers: auth(),
      payload: { action: 'terminate', reason: '需求已作废' },
    });

    expect(res.statusCode).toBe(200);
    expect(runtime.controlsFor(runId).map((c) => c.action)).toContain('terminate');
  });

  /**
   * 降级矩阵的界面落点：Claude Code 没有暂停语义，点「暂停」实际会变成终止。
   * 暂停可恢复、终止不可，这个差别对用户是决定性的，必须让他自己选，
   * 而不是后端替他决定。
   */
  it('★ 运行时不支持的能力返回 501 并给出替代动作', async () => {
    const runId = await runningRun(degradedMockRuntime({ steps: ['慢'], stepDelayMs: 800 }));

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/control`,
      headers: auth(),
      payload: { action: 'pause' },
    });

    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe('UNSUPPORTED_FEATURE');
    expect(res.json().error.message).toContain('暂停');
    expect(res.json().error.details.fallback).toContain('终止');
  });

  it('已结束的 Run 不能再控制', async () => {
    const registryLocal = new RuntimeRegistry();
    const agent = await seedAgent(db, fx, { registry: registryLocal });
    const item = await createWorkItem(db, fx);
    const dispatched = await dispatchRun(db, registryLocal, {
      workItemId: item.id,
      agentId: agent.agentId,
      correlationId: randomUUID(),
    });
    if (!dispatched.ok) throw new Error('派发失败');

    await waitFor(async () => {
      const [r] = await db.select().from(agentRuns).where(eq(agentRuns.id, dispatched.runId));
      return r?.status === 'completed' ? r : null;
    }, { label: 'Run 未完成' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${dispatched.runId}/control`,
      headers: auth(),
      payload: { action: 'terminate', reason: '试试' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('completed');
  });
});

describe('★ 等待审批的任务留在原阶段，不假装「已做完在审核」', () => {
  it('执行前审批的任务留在 Execution 列并带 Human Gate 标识', async () => {
    // 生产 DDL 任务：plan_approved 时会被基线 Policy 拦下
    const item = await createWorkItem(db, fx, {
      status: 'draft',
      stage: 'intake',
      title: '数据库索引变更',
      typeData: { environment: 'production', operationType: 'db_ddl' },
    });

    const { transition } = await import('../modules/flow/transition');
    const result = await transition(db, {
      workItemId: item.id,
      trigger: 'plan_approved',
      actor: { type: 'human', id: fx.userId },
      correlationId: randomUUID(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.to).toBe('awaiting_decision');
    // ★ 本来要去 ready（Execution），就留在 Execution，而不是跳到 Review
    expect(result.stage).toBe('execution');

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}/board`,
      headers: auth(),
    });

    const columns = res.json().columns as { key: string; items: { id: string }[] }[];
    const execution = columns.find((c) => c.key === 'execution')!;
    const review = columns.find((c) => c.key === 'review')!;

    expect(execution.items.map((i) => i.id)).toContain(item.id);
    expect(review.items.map((i) => i.id)).not.toContain(item.id);
    expect(res.json().summary.pendingDecisions).toBe(1);
  });

  it('执行后审批的任务留在 Review 列', async () => {
    const item = await createWorkItem(db, fx, {
      status: 'executing',
      typeData: { environment: 'production', operationType: 'db_ddl' },
    });
    const { artifacts } = await import('@apos/db');
    await db.insert(artifacts).values({
      orgId: fx.orgId,
      projectId: fx.projectId,
      workItemId: item.id,
      kind: 'code',
      title: 'diff',
      producedByType: 'agent',
    });

    const { transition } = await import('../modules/flow/transition');
    const result = await transition(db, {
      workItemId: item.id,
      trigger: 'agent_run_completed',
      actor: { type: 'system', id: null },
      correlationId: randomUUID(),
    });

    expect(result.ok && result.to).toBe('awaiting_decision');
    // 本来要去 reviewing，就留在 Review
    expect(result.ok && result.stage).toBe('review');
  });
});
