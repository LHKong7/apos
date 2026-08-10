import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { agentRuns, decisions, events, projectMembers, workItems } from '@apos/db';
import { MockRuntime, RuntimeRegistry, degradedMockRuntime } from '@apos/agent-runtimes';
import { buildApp } from '../app';
import { EventBus } from '../modules/event/bus';
import { StubPlanningProvider } from '../modules/planning/stub-provider';
import {
  auth as authFor,
  createOutsider,
  createWorkItem,
  integrationRegistry,
  resetDb,
  seedFixture,
  testDb,
  type Fixture,
} from '../test/db';
import { signToken } from '../modules/auth';
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
    integrations: integrationRegistry(),
    provider: new StubPlanningProvider(),
  });
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await resetDb(db);
});

const auth = () => authFor(fx.userId);

describe('认证与错误映射', () => {
  it('缺少令牌返回 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${fx.projectId}/requirements`,
      payload: { rawInput: '测试' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  /**
   * ★★ 伪造的令牌必须被拒。
   *
   *   这是整套鉴权的地基：如果签名没被真的验，那么「身份」就退回成
   *   调用方自己说了算，下面所有角色与成员关系的断言都失去意义。
   *   `alg: none` 单列一条 —— 那是 JWT 最经典的绕过方式，
   *   而它的表现是「攻击者随便变成谁」，测不出来就等于没设防。
   */
  it('★ 伪造、篡改、过期的令牌一律 401', async () => {
    const real = signToken(fx.userId);
    const [head, body, mac] = real.split('.') as [string, string, string];
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

    const forged: Array<[string, string]> = [
      ['不是 JWT 形状', 'null'],
      ['只有两段', `${head}.${body}`],
      ['签名被改', `${head}.${body}.${mac.slice(0, -2)}xy`],
      // payload 换成别人，签名不变 —— 最直接的越权尝试
      ['声明被篡改', `${head}.${b64({ sub: randomUUID(), iat: 1, exp: 99999999999 })}.${mac}`],
      // alg: none + 空签名
      ['alg 为 none', `${b64({ alg: 'none', typ: 'JWT' })}.${body}.`],
      ['已过期', signToken(fx.userId, { ttlSeconds: -60 })],
    ];

    for (const [why, token] of forged) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${fx.projectId}/requirements`,
        headers: { authorization: `Bearer ${token}` },
        payload: { rawInput: '测试' },
      });
      expect(res.statusCode, why).toBe(401);
      expect(res.json().error.code, why).toBe('UNAUTHENTICATED');
    }

    // 身份可选的端点同样不能把坏令牌当成「没带」静默放过
    for (const url of [
      '/api/v1/decisions',
      `/api/v1/projects/${fx.projectId}/board?onlyMine=true`,
    ]) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: 'Bearer not-a-token' },
      });
      expect(res.statusCode, url).toBe(401);
    }
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

  /**
   * 身份那条路径当初已经单独修过（见上面的「伪造、篡改、过期的令牌一律 401」），
   * 但同一个坑在路径参数和查询参数上还开着：值一路走到 SQL，
   * Postgres 报 22P02，错误处理器不认这个码，于是吞成 500。
   *
   * ★ 后果有两层：调用方以为服务端挂了；告警面板上多出一批假故障，
   *   真正的 500 被淹掉。所以这里断言的是**状态码**，不是有没有报错。
   */
  it('★ 路径参数不是 UUID 时返回 400 而不是 500', async () => {
    for (const url of [
      '/api/v1/projects/not-a-uuid',
      '/api/v1/work-items/not-a-uuid',
      '/api/v1/runs/not-a-uuid',
      '/api/v1/decisions/not-a-uuid',
      '/api/v1/plans/not-a-uuid',
      '/api/v1/requirements/not-a-uuid',
      // 前端把 /decision-inbox 写成 /decisions/inbox 就会落到这里
      '/api/v1/decisions/inbox',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: auth() });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error.code, url).toBe('VALIDATION_FAILED');
    }
  });

  it('★ 查询参数是非法枚举值时返回 400 而不是 500', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}/board?risk=bogus`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });

  /**
   * docs/tech/09-security.md §2.1 的第②层「项目角色」。
   *
   * ★ 这一层此前只在集成端点上实现了，别的项目数据一律没查成员关系 ——
   *   实测中另一个组织的用户可以读、也可以写本项目的看板 / 执行图 /
   *   Analytics / Policy / 需求。这里逐个端点钉住。
   */
  describe('★ 跨项目越权', () => {
    it('非成员读项目数据一律被拒', async () => {
      const outsider = await createOutsider(db, fx);
      for (const url of [
        `/api/v1/projects/${fx.projectId}`,
        `/api/v1/projects/${fx.projectId}/board`,
        `/api/v1/projects/${fx.projectId}/graph`,
        `/api/v1/projects/${fx.projectId}/analytics`,
        `/api/v1/projects/${fx.projectId}/overview`,
        `/api/v1/projects/${fx.projectId}/policies`,
        `/api/v1/projects/${fx.projectId}/integrations`,
        `/api/v1/projects/${fx.projectId}/requirements`,
        `/api/v1/projects/${fx.projectId}/agents`,
      ]) {
        const res = await app.inject({
          method: 'GET',
          url,
          headers: authFor(outsider.userId),
        });
        expect(res.statusCode, url).toBe(404);
      }
    });

    it('★ 非成员写项目数据被拒', async () => {
      const outsider = await createOutsider(db, fx);
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${fx.projectId}/requirements`,
        headers: authFor(outsider.userId),
        payload: { rawInput: '越权写入' },
      });
      expect(res.statusCode).toBe(404);
    });

    /**
     * ★ /work-items/:id 这类路径上看不出项目，最容易被漏掉，
     *   而它返回的同样是项目数据
     */
    it('★ 资源路径（看不出项目的那些）同样挡住非成员', async () => {
      const outsider = await createOutsider(db, fx);
      const item = await createWorkItem(db, fx);
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/work-items/${item.id}`,
        headers: authFor(outsider.userId),
      });
      expect(res.statusCode).toBe(404);

      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/v1/work-items/${item.id}/status`,
        headers: authFor(outsider.userId),
        payload: { toStatus: 'executing', reason: '越权', reasonCategory: 'other' },
      });
      expect(patch.statusCode).toBe(404);
    });

    it('★ 非成员回 404 而不是 403 —— 403 等于确认项目存在，可被枚举', async () => {
      const outsider = await createOutsider(db, fx);
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${fx.projectId}`,
        headers: authFor(outsider.userId),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    });

    it('项目列表只返回自己是成员的项目', async () => {
      const outsider = await createOutsider(db, fx);
      const mine = await app.inject({
        method: 'GET',
        url: '/api/v1/projects',
        headers: auth(),
      });
      expect(mine.json().projects.map((p: { id: string }) => p.id)).toContain(fx.projectId);

      const theirs = await app.inject({
        method: 'GET',
        url: '/api/v1/projects',
        headers: authFor(outsider.userId),
      });
      expect(theirs.json().projects).toEqual([]);
    });

    /**
     * ★ 列表类端点的 URL 里没有项目 id，按路径形状的闸门够不着 ——
     *   实测中一个只属于一个项目的用户，收件箱里能看到三个项目、
     *   跨三个组织的待决策。这类端点必须自己带范围。
     */
    it('★ 决策收件箱不返回非成员项目的决策', async () => {
      const item = await createWorkItem(db, fx, { status: 'awaiting_decision' });
      await db.insert(decisions).values({
        orgId: fx.orgId,
        projectId: fx.projectId,
        workItemId: item.id,
        type: 'high_risk_operation',
        title: '本项目的决策',
        consequence: '任务卡住',
        whyHuman: '高风险',
        riskLevel: 'high',
        reversible: false,
        status: 'pending',
      });

      const mine = await app.inject({
        method: 'GET',
        url: '/api/v1/decision-inbox?scope=all',
        headers: auth(),
      });
      expect(mine.json().decisions.length).toBeGreaterThan(0);

      const outsider = await createOutsider(db, fx);
      const theirs = await app.inject({
        method: 'GET',
        url: '/api/v1/decision-inbox?scope=all',
        headers: authFor(outsider.userId),
      });
      expect(theirs.json().decisions).toEqual([]);
      expect(theirs.json().stats.total).toBe(0);
    });

    it('收件箱指定非成员项目时被拒', async () => {
      const outsider = await createOutsider(db, fx);
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/decision-inbox?scope=all&projectId=${fx.projectId}`,
        headers: authFor(outsider.userId),
      });
      expect(res.statusCode).toBe(404);
    });

    it('★ Agent 花名册不列出别的组织的 Agent', async () => {
      await seedAgent(db, fx, { registry });
      const mine = await app.inject({ method: 'GET', url: '/api/v1/agents', headers: auth() });
      expect(mine.json().agents.length).toBeGreaterThan(0);

      const outsider = await createOutsider(db, fx);
      const theirs = await app.inject({
        method: 'GET',
        url: '/api/v1/agents',
        headers: authFor(outsider.userId),
      });
      expect(theirs.json().agents).toEqual([]);
    });

    it('成员自己访问不受影响', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${fx.projectId}/board`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
    });
  });

  it('★ 400 的响应体不能把表名列名漏出去', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/work-items/not-a-uuid',
      headers: auth(),
    });
    const body = res.body;
    expect(body).not.toMatch(/work_items|select|relation|column/i);
    // 但要留下能自查的线索
    expect(res.json().error.details.pgCode).toBe('22P02');
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

/**
 * ★ 批量批准的安全底线在服务端。
 *
 *   这条规则原先只写在前端（决策中心的 isBatchable：不给高风险/不可逆的
 *   决策渲染勾选框）。服务端的 batch-approve 拿到 id 就逐条照批 ——
 *   直接调 API、或者用一个旧版本的前端，就能把不可逆的生产操作一次批掉。
 *   灰按钮不是权限。
 */
describe('★ 批量批准不能绕过逐条确认', () => {
  const makeDecision = async (over: Record<string, unknown> = {}) => {
    const [d] = await db
      .insert(decisions)
      .values({
        orgId: fx.orgId,
        projectId: fx.projectId,
        type: 'approval',
        riskLevel: 'low',
        reversible: true,
        title: '批量测试决策',
        whyHuman: '测试',
        assigneeId: fx.userId,
        status: 'pending',
        ...over,
      })
      .returning();
    return d!;
  };

  it('低风险可逆的能批量批准', async () => {
    const d = await makeDecision();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/decisions/batch-approve',
      headers: auth(),
      payload: { ids: [d.id] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().approved).toBe(1);
  });

  it('★ 不可逆的决策走批量接口时被服务端挡下', async () => {
    const d = await makeDecision({ reversible: false });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/decisions/batch-approve',
      headers: auth(),
      payload: { ids: [d.id] },
    });
    expect(res.json().approved).toBe(0);
    expect(res.json().failed[0].error).toContain('不可逆');

    // 而且状态确实没被改
    const [after] = await db.select().from(decisions).where(eq(decisions.id, d.id));
    expect(after!.status).toBe('pending');
  });

  it('★ 高风险决策走批量接口时被服务端挡下', async () => {
    for (const riskLevel of ['high', 'critical'] as const) {
      const d = await makeDecision({ riskLevel });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/decisions/batch-approve',
        headers: auth(),
        payload: { ids: [d.id] },
      });
      expect(res.json().approved, riskLevel).toBe(0);
      const [after] = await db.select().from(decisions).where(eq(decisions.id, d.id));
      expect(after!.status, riskLevel).toBe('pending');
    }
  });

  it('★ 混着提交时只放行合规的那些，不是整批拒绝也不是整批放行', async () => {
    const okOne = await makeDecision();
    const risky = await makeDecision({ reversible: false });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/decisions/batch-approve',
      headers: auth(),
      payload: { ids: [okOne.id, risky.id] },
    });
    expect(res.json().approved).toBe(1);
    expect(res.json().failed).toHaveLength(1);

    const [a] = await db.select().from(decisions).where(eq(decisions.id, okOne.id));
    const [b] = await db.select().from(decisions).where(eq(decisions.id, risky.id));
    expect(a!.status).toBe('approved');
    expect(b!.status).toBe('pending');
  });

  it('★ 别人名下的决策不能被批量代批', async () => {
    const { organizationMembers, users: userTable } = await import('@apos/db');
    const [other] = await db
      .insert(userTable)
      .values({ email: `o-${randomUUID()}@acme.dev`, name: '他人' })
      .returning();
    await db
      .insert(organizationMembers)
      .values({ orgId: fx.orgId, userId: other!.id });
    const d = await makeDecision({ assigneeId: other!.id });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/decisions/batch-approve',
      headers: auth(),
      payload: { ids: [d.id] },
    });
    expect(res.json().approved).toBe(0);
    expect(res.json().failed[0].error).toContain('不可代行');
  });
});

/**
 * docs/tech/07-api-design.md §4。
 *
 * ★ 这里要防的不是「重复执行」——状态机已经挡住了（重复批准拿 409）。
 *   要防的是**成功了却被告知失败**：客户端 POST 批准，响应回来的路上
 *   网络断了，它重试，这次拿到 409，界面显示「批准失败」。
 *   再点还是失败，而操作第一次就成了。
 */
describe('★ Idempotency-Key', () => {
  const pendingDecision = async (over: Record<string, unknown> = {}) => {
    const [d] = await db
      .insert(decisions)
      .values({
        orgId: fx.orgId,
        projectId: fx.projectId,
        type: 'approval',
        riskLevel: 'low',
        reversible: true,
        title: '幂等测试决策',
        whyHuman: '测试',
        assigneeId: fx.userId,
        status: 'pending',
        ...over,
      })
      .returning();
    return d!;
  };

  const approve = (id: string, key?: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/decisions/${id}/approve`,
      headers: key ? { ...auth(), 'idempotency-key': key } : auth(),
      payload: { note: 'x' },
    });

  it('★ 带同一个 key 重放，返回首次结果而不是 409', async () => {
    const d = await pendingDecision();
    const first = await approve(d.id, 'key-1');
    const replay = await approve(d.id, 'key-1');

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(replay.headers['idempotent-replay']).toBe('true');
  });

  it('不带 key 时维持原行为：重复批准报冲突', async () => {
    const d = await pendingDecision();
    expect((await approve(d.id)).statusCode).toBe(200);
    expect((await approve(d.id)).statusCode).toBe(409);
  });

  /**
   * ★ 「重放不产生副作用」直接数事件：这个产品的每一次状态变更都必须
   *   连带写事件（CONTRIBUTING 第一条约束），所以事件条数没变，
   *   就等于确实什么都没再发生
   */
  it('★ 重放不产生第二次副作用', async () => {
    const d = await pendingDecision();
    await approve(d.id, 'key-2');

    const before = await db.select().from(events);
    const [decisionBefore] = await db.select().from(decisions).where(eq(decisions.id, d.id));

    await approve(d.id, 'key-2');

    const after = await db.select().from(events);
    expect(after.length).toBe(before.length);

    const [decisionAfter] = await db.select().from(decisions).where(eq(decisions.id, d.id));
    expect(decisionAfter).toEqual(decisionBefore);
  });

  it('不同 key 指向不同决策，互不干扰', async () => {
    const a = await pendingDecision();
    const b = await pendingDecision();
    expect((await approve(a.id, 'key-a')).statusCode).toBe(200);
    expect((await approve(b.id, 'key-b')).statusCode).toBe(200);
  });

  /**
   * ★ key 由客户端自己生成，撞车不是不可能，而响应里带着决策内容
   */
  it('★ 换个身份用同一个 key 拿不到别人的响应', async () => {
    const d = await pendingDecision({ assigneeId: null });
    await approve(d.id, 'key-shared');

    const { organizationMembers, users: userTable } = await import('@apos/db');
    const [other] = await db
      .insert(userTable)
      .values({ email: `x-${randomUUID()}@acme.dev`, name: '另一个人' })
      .returning();
    await db
      .insert(organizationMembers)
      .values({ orgId: fx.orgId, userId: other!.id });
    await db.insert(projectMembers).values({
      orgId: fx.orgId,
      projectId: fx.projectId,
      actorType: 'human',
      actorId: other!.id,
      role: 'member',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/decisions/${d.id}/approve`,
      headers: { ...authFor(other!.id), 'idempotency-key': 'key-shared' },
      payload: { note: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('另一个身份');
  });

  /**
   * ★ 缓存失败的响应会把一次偶发故障钉死 24 小时 ——
   *   之后每次带同一个 key 重试都拿到那个陈旧的错误，再也好不了
   */
  it('★ 失败的响应不进缓存，稍后重试仍能成功', async () => {
    const d = await pendingDecision({ assigneeId: null });

    // 先用一个非成员触发失败
    const outsider = await createOutsider(db, fx);
    const failed = await app.inject({
      method: 'POST',
      url: `/api/v1/decisions/${d.id}/approve`,
      headers: { ...authFor(outsider.userId), 'idempotency-key': 'key-retry' },
      payload: { note: 'x' },
    });
    expect(failed.statusCode).toBeGreaterThanOrEqual(400);

    // 同一个 key 换成有权限的人，应当真的执行而不是回放那个错误
    const good = await approve(d.id, 'key-retry');
    expect(good.statusCode).toBe(200);
  });
});

describe('★ 决策责任不可代行', () => {
  it('非责任人无法批准，提示用改派', async () => {
    const item = await createWorkItem(db, fx);

    const { organizationMembers, users } = await import('@apos/db');
    const [other] = await db
      .insert(users)
      .values({ email: `dba-${randomUUID()}@acme.dev`, name: '王强' })
      .returning();
    await db.insert(organizationMembers).values({ orgId: fx.orgId, userId: other!.id });
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
    const { organizationMembers, users } = await import('@apos/db');
    const [other] = await db
      .insert(users)
      .values({ email: `dba-${randomUUID()}@acme.dev`, name: '王强' })
      .returning();
    await db.insert(organizationMembers).values({ orgId: fx.orgId, userId: other!.id });

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
    registry.register(agent.agentId, runtime);
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
