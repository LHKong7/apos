import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  agentRuns,
  decisions,
  events,
  plans,
  policies,
  projectMembers,
  repositories,
  requirementClarifications,
  requirements,
  workItems,
} from '@apos/db';
import { MockRuntime, RuntimeRegistry, degradedMockRuntime } from '@apos/agent-runtimes';
import { buildApp } from '../app';
import { EventBus } from '../modules/event/bus';
import { StubPlanningProvider } from '../modules/planning/stub-provider';
import {
  auth as authFor,
  createMember,
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
import { scheduleRound } from '../modules/flow/scheduler';
import { reviewRound } from '../modules/flow/review';

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
   * ★★ A forged token must be rejected.
   *
   *   This is the bedrock of the whole auth stack: if the signature is not actually
   *   verified, "identity" collapses into whatever the caller claims, and every role and
   *   membership assertion below loses its meaning. `alg: none` gets its own case — it is
   *   the classic JWT bypass, and its symptom is "the attacker becomes anyone they like",
   *   so not testing it is the same as having no defense at all.
   */
  it('★ 伪造、篡改、过期的令牌一律 401', async () => {
    const real = signToken(fx.userId);
    const [head, body, mac] = real.split('.') as [string, string, string];
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

    const forged: Array<[string, string]> = [
      ['不是 JWT 形状', 'null'],
      ['只有两段', `${head}.${body}`],
      ['签名被改', `${head}.${body}.${mac.slice(0, -2)}xy`],
      // Swap the payload for someone else, keep the signature — the bluntest escalation try
      ['声明被篡改', `${head}.${b64({ sub: randomUUID(), iat: 1, exp: 99999999999 })}.${mac}`],
      // alg: none plus an empty signature
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

    // Endpoints where identity is optional must not silently treat a bad token as "absent"
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
   * The identity path was fixed on its own long ago (see "forged, tampered and expired
   * tokens all get 401" above), but the same hole stayed open on path and query
   * parameters: the value travels all the way into SQL, Postgres raises 22P02, the error
   * handler does not recognize that code, and it gets swallowed as a 500.
   *
   * ★ That costs twice: the caller believes the server is down, and the alerting board
   *   fills up with phantom failures that drown out the real 500s. So what is asserted
   *   here is the **status code**, not merely that an error happened.
   */
  it('★ 路径参数不是 UUID 时返回 400 而不是 500', async () => {
    for (const url of [
      '/api/v1/projects/not-a-uuid',
      '/api/v1/work-items/not-a-uuid',
      '/api/v1/runs/not-a-uuid',
      '/api/v1/decisions/not-a-uuid',
      '/api/v1/plans/not-a-uuid',
      '/api/v1/requirements/not-a-uuid',
      // A frontend that writes /decisions/inbox instead of /decision-inbox lands here
      '/api/v1/decisions/inbox',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: auth() });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error.code, url).toBe('VALIDATION_FAILED');
    }
  });

  /**
   * ★★ `X-Correlation-Id` exists so callers can carry their own trace id, while
   *   `events.correlation_id` is a uuid column.
   *
   *   The header used to be passed through verbatim: a client sends `trace-abc-123` (a
   *   W3C traceparent, a Jaeger span id — none of them uuids), the request travels all
   *   the way to the INSERT before Postgres throws it back with 22P02, which is
   *   translated into a 400 "the path or query parameter format is invalid". The symptom
   *   is "this endpoint always 400s for me, it works from another client", and the error
   *   does not mention the correlation id at all.
   *
   * ★ The second assertion matters just as much: "always ignore the header" would also
   *   turn the first one green, but that deletes the header's entire purpose and no test
   *   would notice.
   */
  it('★ X-Correlation-Id 不是 UUID 时照常受理，是 UUID 时被采纳', async () => {
    const create = (correlationId: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: { ...auth(), 'x-correlation-id': correlationId },
        payload: { name: `项目-${randomUUID().slice(0, 8)}` },
      });

    // ① A non-uuid trace header must not block the write
    const messy = await create('trace-abc-123');
    expect(messy.statusCode).toBe(201);

    // ② A valid uuid has to land on the event, or logs will not line up across systems
    const mine = randomUUID();
    const ok = await create(mine);
    expect(ok.statusCode).toBe(201);

    const [row] = await db
      .select({ correlationId: events.correlationId })
      .from(events)
      .where(eq(events.projectId, ok.json().project.id));
    expect(row?.correlationId).toBe(mine);
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
   * Layer ② of docs/tech/09-security.md §2.1: the project role.
   *
   * ★ This layer used to exist only on the integration endpoints; no other project data
   *   checked membership at all — in practice a user from another org could read *and*
   *   write this project's board / execution graph / Analytics / Policy / requirements.
   *   Each endpoint is pinned down here.
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
     * ★ Paths like /work-items/:id show no project, which makes them the easiest to
     *   miss — and what they return is project data all the same
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
     * ★ List endpoints carry no project id in the URL, so a gate keyed on path shape
     *   cannot reach them — in practice a user who belonged to one project saw pending
     *   decisions from three projects across three orgs in their inbox. Endpoints like
     *   these have to scope themselves.
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
    // But leave a clue the caller can diagnose themselves with
    expect(res.json().error.details.pgCode).toBe('22P02');
  });
});

describe('★ 需求 → 计划 → 看板（HTTP 全链路）', () => {
  it('走通完整流程', async () => {
    await seedAgent(db, fx, {
      registry,
      grant: {
        profileKey: 'code_developer',
        resourceScopes: [{ kind: 'repo', ref: 'order-service', access: 'write' }],
      },
    });

    // Capture the requirement
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${fx.projectId}/requirements`,
      headers: auth(),
      payload: { rawInput: '订单查询太慢了，想支持按手机号和时间段搜索，周五上线' },
    });
    expect(created.statusCode).toBe(201);
    const reqId = created.json().requirement.id;

    // AI structuring
    const analyzed = await app.inject({
      method: 'POST',
      url: `/api/v1/requirements/${reqId}/analyze`,
      headers: auth(),
    });
    expect(analyzed.statusCode).toBe(200);
    expect(analyzed.json().mustConfirmCount).toBeGreaterThan(0);

    // ★ Confirmation is refused while must-answer questions remain, and it names which ones
    const premature = await app.inject({
      method: 'POST',
      url: `/api/v1/requirements/${reqId}/approve`,
      headers: auth(),
      payload: {},
    });
    expect(premature.statusCode).toBe(422);
    expect(premature.json().error.code).toBe('UNANSWERED_MUST_CONFIRM');
    expect(premature.json().error.details.length).toBeGreaterThan(0);

    // Answer the clarification questions
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

    // Confirm the requirement
    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/requirements/${reqId}/approve`,
      headers: auth(),
      payload: {},
    });
    expect(approved.statusCode).toBe(200);

    // Generate the plan
    const planned = await app.inject({
      method: 'POST',
      url: `/api/v1/requirements/${reqId}/plans`,
      headers: auth(),
    });
    expect(planned.statusCode).toBe(201);
    const plan = planned.json();
    expect(plan.autoActions.length).toBeGreaterThan(0);
    expect(plan.humanGates.length).toBeGreaterThan(0);

    // Approval is a hard preflight gate: an Agent alone is not enough when the
    // plan needs a writable workspace and an executable verification command.
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.planId}/approve`,
      headers: auth(),
      payload: { acknowledgedUnassigned: true },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.reason).toBe('plan.preflight_failed');
    expect(blocked.json().error.details.issues.map((issue: { code: string }) => issue.code)).toEqual(
      expect.arrayContaining(['workspace_source_missing', 'verification_missing']),
    );

    await db.insert(repositories).values({
      orgId: fx.orgId,
      projectId: fx.projectId,
      ref: 'order-service',
      name: 'Order service',
      remoteUrl: 'https://example.invalid/order-service.git',
      defaultBranch: 'main',
      checkCommand: 'pnpm test',
      createdBy: fx.userId,
    });

    // Approve the plan
    /**
     * ★ acknowledgedUnassigned: the plan's human tasks have nobody assigned yet, so
     *   approvePlan stops once for that (UNASSIGNED_HUMAN_TASKS). Passing it stands for
     *   the user confirming "let them go into the unclaimed queue for now" — this case
     *   checks that the whole chain runs, and assignment is tested on the plan page.
     */
    const activated = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.planId}/approve`,
      headers: auth(),
      payload: { acknowledgedUnassigned: true },
    });
    expect(activated.statusCode, JSON.stringify(activated.json())).toBe(200);
    expect(activated.json().activatedTasks).toBe(plan.taskCount);

    // Trigger scheduling
    const scheduled = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${fx.projectId}/schedule`,
      headers: auth(),
    });
    expect(scheduled.statusCode).toBe(200);
    expect(
      scheduled.json().outcomes.filter((o: { action: string }) => o.action === 'dispatched'),
    ).toHaveLength(1);

    // The board reflects the real state
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

/**
 * The two routes to a structured requirement: AI analysis and filling it in by hand.
 *
 * ★★ This group watches whether the manual route can reach the end on its own.
 *
 *   It could not: only half the structured fields were writable, a manual edit did not
 *   recompute completeness, and the confirm button required "has been analyzed". Stacked
 *   together, that meant even a requirement a person had written out perfectly still had
 *   to be run through an Agent before it could be confirmed — and with no planning Agent
 *   configured, or when analysis times out (product doc 03 §7), this page is a dead end.
 */
describe('★ 需求：AI 与人工两条路并行', () => {
  async function createRequirement(rawInput = '订单查询太慢，想支持按手机号和时间段搜索') {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${fx.projectId}/requirements`,
      headers: auth(),
      payload: { rawInput },
    });
    expect(res.statusCode).toBe(201);
    return res.json().requirement.id as string;
  }

  const edit = (id: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: `/api/v1/requirements/${id}`, headers: auth(), payload });

  const FULL_MANUAL = {
    title: '订单查询性能优化',
    businessContext:
      '客服每天收到大量关于订单查询慢的投诉，当前列表页 P95 超过 4 秒，已影响续约谈判。',
    userProblem: '客服查一个订单要等好几秒',
    businessGoal: 'P95 查询耗时降到 500ms 以内',
    scope: { inScope: ['按手机号搜索', '按时间段搜索'], outOfScope: ['历史数据迁移'] },
    risks: ['可能涉及生产数据库索引变更'],
    acceptanceCriteria: [
      { text: '按手机号搜索 P95 < 500ms', verification: 'auto' as const },
      { text: '按时间段搜索结果正确', verification: 'agent' as const },
      { text: '客服验收通过', verification: 'human' as const },
    ],
  };

  it('不跑分析，纯人工填出来的需求能确认并生成计划', async () => {
    const id = await createRequirement();

    const saved = await edit(id, FULL_MANUAL);
    expect(saved.statusCode).toBe(200);

    /**
     * ★ A manual edit has to recompute completeness and advance the status.
     *   Without that it stays at score 0 and draft forever — and that score is exactly
     *   what the user reads to judge "is this good enough to confirm", while the status
     *   decides whether the confirm button appears at all.
     */
    const r = saved.json().requirement;
    expect(r.status).toBe('awaiting_approval');
    expect(r.completeness.total).toBeGreaterThan(60);
    expect(r.completeness.goal).toBe(100);
    expect(r.completeness.acceptance).toBeGreaterThan(0);

    // Confirmation works without clarifications — those are an output of AI analysis, not a
    // precondition for confirming
    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/requirements/${id}/approve`,
      headers: auth(),
      payload: {},
    });
    expect(approved.statusCode).toBe(200);

    // The planner reads those columns from the database and does not care who wrote them
    const planned = await app.inject({
      method: 'POST',
      url: `/api/v1/requirements/${id}/plans`,
      headers: auth(),
    });
    expect(planned.statusCode).toBe(201);
    expect(planned.json().taskCount).toBeGreaterThan(0);
  });

  it('一张白纸不能确认，报错给出 AI 与人工两条出路', async () => {
    const id = await createRequirement();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/requirements/${id}/approve`,
      headers: auth(),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    // ★ Saying only "run AI analysis first" makes a deployment with no planning Agent a dead end
    expect(res.json().error.message).toContain('AI 分析');
    expect(res.json().error.message).toContain('自己填');
  });

  it('只改了背景、还没有正题时不推进状态，需求列表上不会冒出一条空的待确认', async () => {
    const id = await createRequirement();

    const res = await edit(id, { businessContext: '客服投诉很多' });
    expect(res.statusCode).toBe(200);
    expect(res.json().requirement.status).toBe('draft');
  });

  it('人工写的验收标准被补齐成与 AI 产出相同的形状', async () => {
    const id = await createRequirement();
    await edit(id, { acceptanceCriteria: [{ text: '按手机号能搜到' }] });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/requirements/${id}`,
      headers: auth(),
    });
    const [ac] = detail.json().requirement.acceptanceCriteria;

    /**
     * ★ Downstream code points back at this criterion by id and routes verification by
     *   `verification`. Missing either one shows up as "nobody ever verifies this
     *   criterion", while on the page it looks no different from the rest.
     */
    expect(ac.id).toBeTruthy();
    expect(ac.status).toBe('pending');
    // The platform has no basis for deciding a hand-written line can be verified
    // automatically; defaulting to auto would make a promise on the user's behalf
    expect(ac.verification).toBe('human');
  });

  it('空文本的验收标准在保存那一刻被拒', async () => {
    const id = await createRequirement();
    const res = await edit(id, { acceptanceCriteria: [{ text: '   ' }] });
    expect(res.statusCode).toBe(400);
  });

  /**
   * ★ Risks on a requirement are a list of strings. Let an object in and the error only
   *   surfaces at plan generation (`r.includes is not a function`), by which time the
   *   person who typed it has long walked away.
   */
  it('风险不是字符串数组时在保存那一刻被拒', async () => {
    const id = await createRequirement();
    const res = await edit(id, { risks: [{ description: '数据库变更' }] });
    expect(res.statusCode).toBe(400);
  });

  it('AI 出稿之后人改一部分，两种来源在字段上分得清', async () => {
    const id = await createRequirement();

    const analyzed = await app.inject({
      method: 'POST',
      url: `/api/v1/requirements/${id}/analyze`,
      headers: auth(),
    });
    expect(analyzed.statusCode).toBe(200);

    const before = await app.inject({
      method: 'GET',
      url: `/api/v1/requirements/${id}`,
      headers: auth(),
    });
    const ai = before.json().requirement;

    /**
     * ★★ The editor submits the whole requirement at once, and only the business goal was
     *   actually edited by a human. Recording provenance by "what was submitted" would
     *   turn the entire panel into "👤 human" — and the only reason those markers exist is
     *   to tell which sentences the user wrote themselves.
     */
    await edit(id, {
      title: ai.title,
      businessContext: ai.businessContext,
      userProblem: ai.userProblem,
      businessGoal: '人工改过的业务目标',
      scope: ai.scope,
      acceptanceCriteria: ai.acceptanceCriteria,
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/requirements/${id}`,
      headers: auth(),
    });
    const r = detail.json().requirement;

    expect(r.businessGoal).toBe('人工改过的业务目标');
    /**
     * ★★ "Did I write this sentence or did the AI?" is the single most important thing to
     *   see clearly at confirmation time. Displaying both sources as one takes that
     *   judgment out of the user's hands.
     */
    expect(r.fieldProvenance.businessGoal.source).toBe('human');
    // A field sent back unchanged does not count as human-edited — it is still the AI's line
    expect(r.fieldProvenance.title.source).not.toBe('human');
    expect(r.fieldProvenance.businessContext.source).not.toBe('human');
    // A manual edit touches neither the raw input nor the attribution of that AI round
    expect(r.rawInput).toContain('订单查询太慢');
    expect(r.analysisModel).toBeTruthy();
  });

  /** ★ Opening the editor and saving unchanged must not leave an "edited" entry in the audit */
  it('什么都没改时不记溯源也不发事件', async () => {
    const id = await createRequirement();
    await edit(id, FULL_MANUAL);

    const again = await edit(id, FULL_MANUAL);
    expect(again.statusCode).toBe(200);

    const edits = await db
      .select()
      .from(events)
      .where(eq(events.type, 'requirement.field_edited'));
    expect(edits.length).toBe(1);
  });

  /**
   * ★★ For the two routes to truly run in parallel, one of them has to yield — and it can
   *   only be the AI.
   *
   *   When a human edit is silently overwritten, the cost is that they rewrite it and
   *   never dare edit again. When an AI suggestion is held back, the cost is merely
   *   clearing that one field before clicking analyze again.
   */
  it('重新分析不覆盖人改过的字段，并说出保住了哪几个', async () => {
    const id = await createRequirement();

    await app.inject({
      method: 'POST',
      url: `/api/v1/requirements/${id}/analyze`,
      headers: auth(),
    });
    await edit(id, { businessGoal: '人工写的业务目标' });

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/requirements/${id}/analyze`,
      headers: auth(),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().keptHumanFields).toEqual(['businessGoal']);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/requirements/${id}`,
      headers: auth(),
    });
    const r = detail.json().requirement;

    expect(r.businessGoal).toBe('人工写的业务目标');
    // A preserved field stays marked "human", or the next analysis round would overwrite it
    expect(r.fieldProvenance.businessGoal.source).toBe('human');
    // Fields nobody touched are refreshed by this round as usual
    expect(r.title).toBeTruthy();
    expect(r.fieldProvenance.title.source).not.toBe('human');
  });

  it('已确认的需求不能再人工编辑', async () => {
    const id = await createRequirement();
    await edit(id, FULL_MANUAL);
    await app.inject({
      method: 'POST',
      url: `/api/v1/requirements/${id}/approve`,
      headers: auth(),
      payload: {},
    });

    const res = await edit(id, { businessGoal: '偷偷改一下' });
    expect(res.statusCode).toBe(409);
  });

  /**
   * ★ A rejection is a conclusion. Letting an edit quietly flip it back to "awaiting
   *   approval" routes around that conclusion — and the person who rejected it is never
   *   told.
   */
  it('人工编辑不会把已驳回的需求变回待确认', async () => {
    const id = await createRequirement();
    await app.inject({
      method: 'POST',
      url: `/api/v1/requirements/${id}/reject`,
      headers: auth(),
      payload: { reason: '这个季度不做' },
    });

    const res = await edit(id, FULL_MANUAL);
    expect(res.statusCode).toBe(200);
    expect(res.json().requirement.status).toBe('rejected');
  });

  /**
   * ★★ Deleting and rejecting are two different things.
   *
   *   A rejection records a conclusion; a deletion erases a record that should never have
   *   existed (a typo, a duplicate submission, test data). With only rejection available,
   *   the second gets used for the first — so the "rejected" list fills with noise and the
   *   real rejection conclusions become invisible.
   */
  describe('删除需求', () => {
    const del = (id: string, headers: Record<string, string>) =>
      app.inject({ method: 'DELETE', url: `/api/v1/requirements/${id}`, headers });

    it('没有派生物的需求删得掉，澄清项跟着一起走', async () => {
      const id = await createRequirement();
      await app.inject({
        method: 'POST',
        url: `/api/v1/requirements/${id}/analyze`,
        headers: auth(),
      });

      const before = await db
        .select()
        .from(requirementClarifications)
        .where(eq(requirementClarifications.requirementId, id));
      expect(before.length).toBeGreaterThan(0);

      const res = await del(id, auth());
      expect(res.statusCode).toBe(200);

      const left = await db.select().from(requirements).where(eq(requirements.id, id));
      expect(left).toHaveLength(0);
      const orphans = await db
        .select()
        .from(requirementClarifications)
        .where(eq(requirementClarifications.requirementId, id));
      expect(orphans).toHaveLength(0);
    });

    /**
     * ★ Once the entity is gone, the event is the only trace that it ever existed — with
     *   just an id on it, someone auditing this line has no idea what was deleted.
     */
    it('删除留下带标题的领域事件', async () => {
      const id = await createRequirement('删了也要留痕的需求');
      await del(id, auth());

      /**
       * ★ The last row has to be taken by ordering on id descending.
       *
       *   This requirement carries more than one event (created first, deleted after), and
       *   row order in a SELECT without ORDER BY is **not guaranteed** — treating `[ev]` as
       *   "the newest one" happened to return `created` here, so the assertion failed;
       *   under a different query plan it might just as easily have passed. An ordering
       *   assumption in a test has to be written down, not left to luck.
       */
      const [ev] = await db
        .select()
        .from(events)
        .where(eq(events.subjectId, id))
        .orderBy(desc(events.id))
        .limit(1);
      expect(ev?.type).toBe('requirement.deleted');
      expect((ev?.payload as { rawInput?: string })?.rawInput).toContain('删了也要留痕');
    });

    /**
     * ★ Anything derived from it blocks deletion: plans and work items have lifecycles of
     *   their own, so this requirement has already affected other things. The right action
     *   then is to reject it, and the error has to say exactly what is in the way — "cannot
     *   delete" alone leaves the user with nothing to act on.
     */
    it('已生成计划的需求删不掉，且报出挡在哪', async () => {
      const id = await createRequirement();
      await edit(id, FULL_MANUAL);
      await app.inject({
        method: 'POST',
        url: `/api/v1/requirements/${id}/approve`,
        headers: auth(),
        payload: {},
      });
      const plan = await app.inject({
        method: 'POST',
        url: `/api/v1/requirements/${id}/plans`,
        headers: auth(),
      });
      expect(plan.statusCode).toBe(201);

      const res = await del(id, auth());
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('GUARD_FAILED');
      expect(res.json().error.message).toContain('计划');
      expect(res.json().error.message).toContain('驳回');

      const left = await db.select().from(requirements).where(eq(requirements.id, id));
      expect(left).toHaveLength(1);
    });

    /**
     * ★ Build an explicit role with createMember — the fixture identity is an org admin, so
     *   testing "who cannot delete" with it is green no matter what.
     */
    it('viewer 与普通成员都不能删', async () => {
      const id = await createRequirement();

      for (const role of ['viewer', 'member']) {
        const userId = await createMember(db, fx, { projectRole: role });
        const res = await del(id, authFor(userId));
        expect(res.statusCode, `${role} 不该删得掉`).toBe(403);
      }

      const left = await db.select().from(requirements).where(eq(requirements.id, id));
      expect(left).toHaveLength(1);
    });
  });
});

/**
 * ★ 需求级指定「这条需求的 PRD 由谁写」（页面文档 03 §5.4）。
 *
 * ★★ 选择记在需求上，所以它必须像需求的其它字段一样：落库、留痕、
 *   受同一道成员闸门约束。只在一次分析里临时生效的话，
 *   用户下次进来会发现自己的选择不见了，而界面上没有任何解释。
 */
describe('★ 需求：指定 PRD 编写 Agent', () => {
  async function createRequirement(rawInput = '订单查询太慢，想支持按手机号和时间段搜索') {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${fx.projectId}/requirements`,
      headers: auth(),
      payload: { rawInput },
    });
    expect(res.statusCode).toBe(201);
    return res.json().requirement.id as string;
  }

  const setAuthor = (id: string, agentId: string | null, headers = auth()) =>
    app.inject({
      method: 'PUT',
      url: `/api/v1/requirements/${id}/author-agent`,
      headers,
      payload: { agentId },
    });

  /** 能写 PRD 的 Agent = 本项目的 Agent 成员，判据只有这一条 */
  const seedAuthor = (name: string, inProject = true) =>
    seedAgent(db, fx, { registry, name, inProject });

  const lastEvent = async (subjectId: string) => {
    /**
     * ★ 按 id 倒序取最后一条：这条需求身上不止一个事件（created 在前），
     *   不带 ORDER BY 的 SELECT 行序没有保证。
     */
    const [ev] = await db
      .select()
      .from(events)
      .where(eq(events.subjectId, subjectId))
      .orderBy(desc(events.id))
      .limit(1);
    return ev;
  };

  it('指定之后落库，详情里带回名字，事件记下前后两个值', async () => {
    const id = await createRequirement();
    const a = await seedAuthor('prd-writer');

    const res = await setAuthor(id, a.agentId);
    expect(res.statusCode).toBe(200);
    expect(res.json().agentName).toBe('prd-writer');

    const [row] = await db.select().from(requirements).where(eq(requirements.id, id));
    expect(row!.authorAgentId).toBe(a.agentId);

    /**
     * ★ 详情要带名字，不能只有 id：前端的下拉框只装得下当前的项目成员，
     *   光有 id 的话，一个被移出项目的 Agent 会显示成「未指定」。
     */
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/requirements/${id}`,
      headers: auth(),
    });
    expect(detail.json().authorAgent.name).toBe('prd-writer');
    expect(detail.json().requirement.authorAgentId).toBe(a.agentId);

    const ev = await lastEvent(id);
    expect(ev?.type).toBe('requirement.author_agent_set');
    expect((ev?.payload as { agentId?: string }).agentId).toBe(a.agentId);
    expect((ev?.payload as { previousAgentId?: string | null }).previousAgentId).toBeNull();
  });

  it('取消指定回到「自动挑」，同样留痕并记下原来是谁', async () => {
    const id = await createRequirement();
    const a = await seedAuthor('prd-writer');
    await setAuthor(id, a.agentId);

    const res = await setAuthor(id, null);
    expect(res.statusCode).toBe(200);

    const [row] = await db.select().from(requirements).where(eq(requirements.id, id));
    expect(row!.authorAgentId).toBeNull();

    const ev = await lastEvent(id);
    expect(ev?.type).toBe('requirement.author_agent_set');
    expect((ev?.payload as { agentId?: string | null }).agentId).toBeNull();
    // ★ 「本来是谁」是回溯两次产出为何不同时要的那一半
    expect((ev?.payload as { previousAgentId?: string }).previousAgentId).toBe(a.agentId);
  });

  /**
   * ★★ 成员校验是授权，不是体验：规划 Run 会把项目资源只读挂进工作区。
   */
  it('非本项目成员的 Agent 被拒，报错指向「成员与角色」', async () => {
    const id = await createRequirement();
    const outsider = await seedAuthor('outsider', false);

    const res = await setAuthor(id, outsider.agentId);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    expect(res.json().error.message).toContain('成员');

    const [row] = await db.select().from(requirements).where(eq(requirements.id, id));
    expect(row!.authorAgentId).toBeNull();
  });

  /**
   * ★★ 项目里的任何一个 Agent 成员都能写 PRD。
   *
   *   这里以前卡「适用类型含 requirement」——它管的是派工作项时的执行者
   *   匹配，而写 PRD 不派工作项。卡在这里的后果是一个配了整队 Agent 的
   *   项目，需求页上的下拉框却是空的。
   */
  it('任何一个项目 Agent 成员都能被指定为编写者', async () => {
    const id = await createRequirement();
    const coder = await seedAgent(db, fx, { registry, name: 'coder' });

    const res = await setAuthor(id, coder.agentId);
    expect(res.statusCode).toBe(200);
    expect(res.json().agentName).toBe('coder');

    const [row] = await db.select().from(requirements).where(eq(requirements.id, id));
    expect(row!.authorAgentId).toBe(coder.agentId);
  });

  it('不存在的 Agent 返回 404', async () => {
    const id = await createRequirement();
    const res = await setAuthor(id, randomUUID());
    expect(res.statusCode).toBe(404);
  });

  it('已确认的需求不能再换编写者，返回 409', async () => {
    const id = await createRequirement();
    const a = await seedAuthor('prd-writer');
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/requirements/${id}`,
      headers: auth(),
      payload: { title: '订单查询优化', businessGoal: 'P95 降到 500ms' },
    });
    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/requirements/${id}/approve`,
      headers: auth(),
      payload: {},
    });
    expect(approved.statusCode).toBe(200);

    const res = await setAuthor(id, a.agentId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVALID_TRANSITION');
  });

  /**
   * ★ 用 createMember 造明确角色 —— 夹具身份是组织管理员 + tech_lead，
   *   拿它测「谁不能改」永远是绿的。
   */
  it('viewer 不能换编写 Agent', async () => {
    const id = await createRequirement();
    const a = await seedAuthor('prd-writer');

    const userId = await createMember(db, fx, { projectRole: 'viewer' });
    const res = await setAuthor(id, a.agentId, authFor(userId));
    expect(res.statusCode).toBe(403);

    const [row] = await db.select().from(requirements).where(eq(requirements.id, id));
    expect(row!.authorAgentId).toBeNull();
  });

  /** ★ 外组织的人拿到的是 404 而不是 403 —— 403 等于确认这条需求存在 */
  it('外组织的人拿不到这条路由', async () => {
    const id = await createRequirement();
    const a = await seedAuthor('prd-writer');

    const outsider = await createOutsider(db, fx, { orgRole: 'org_admin' });
    const res = await setAuthor(id, a.agentId, authFor(outsider.userId));
    expect(res.statusCode).toBe(404);
  });

  /**
   * ★★ 历次分析要看得出是谁跑的。只显示模型的话，换了编写 Agent 之后
   *   前后两行看起来一模一样 —— 那个选择等于没有反馈。
   */
  it('历次分析列表带上执行 Agent 的名字', async () => {
    const id = await createRequirement();
    const a = await seedAuthor('prd-writer');
    await db.insert(agentRuns).values({
      orgId: fx.orgId,
      projectId: fx.projectId,
      workItemId: null,
      kind: 'planning',
      requirementId: id,
      agentId: a.agentId,
      status: 'completed',
      idempotencyKey: randomUUID(),
      goal: '需求结构化',
      model: 'mock:claude-opus-5',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/requirements/${id}/runs`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().runs[0].agentName).toBe('prd-writer');
  });
});

describe('看板', () => {
  it('卡片带执行主体名称、依赖数与 token 用量，前端不用二次请求', async () => {
    const agent = await seedAgent(db, fx, { registry, name: 'code-agent-1' });
    const item = await createWorkItem(db, fx, {
      executorType: 'agent',
      executorId: agent.agentId,
      actualTokens: 160_000,
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
    expect(card.tokens).toBe(160_000);
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

  it('★ 人工强制通过验收时写入证据，并在任务完成后汇总到需求', async () => {
    const [requirement] = await db
      .insert(requirements)
      .values({
        orgId: fx.orgId,
        projectId: fx.projectId,
        rawInput: '人工核验交付物',
        status: 'approved',
        acceptanceCriteria: [
          {
            id: 'requirement-ac-manual',
            text: '交付物经人工核验通过',
            verification: 'human',
            status: 'pending',
            evidenceRef: null,
            verifiedAt: null,
          },
        ],
      })
      .returning();
    const item = await createWorkItem(db, fx, {
      status: 'reviewing',
      requirementId: requirement!.id,
      acceptanceCriteria: [
        {
          id: 'task-ac-manual',
          text: '交付物经人工核验通过',
          requirementCriterionId: 'requirement-ac-manual',
          verification: 'human',
          status: 'pending',
          evidenceRef: null,
          verifiedAt: null,
        },
      ],
    });

    const reviewed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/work-items/${item.id}/status`,
      headers: auth(),
      payload: {
        toStatus: 'waiting_for_release',
        reason: '已人工核对交付物与验收标准',
        overrideGuards: ['acceptanceCriteriaMet', 'qualityGatePassed'],
      },
    });
    expect(reviewed.statusCode).toBe(200);

    for (const toStatus of ['releasing', 'acceptance', 'done']) {
      const advanced = await app.inject({
        method: 'PATCH',
        url: `/api/v1/work-items/${item.id}/status`,
        headers: auth(),
        payload: { toStatus, reason: '继续完成发布与验收流程' },
      });
      expect(advanced.statusCode, toStatus).toBe(200);
    }

    const [after] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(after!.acceptanceCriteria[0]).toMatchObject({
      status: 'passed',
      verification: 'human',
    });
    expect(after!.acceptanceCriteria[0]?.evidenceRef).toMatch(/^manual-review:/);
    expect(after!.acceptanceCriteria[0]?.verifiedAt).toBeTruthy();

    const [requirementAfter] = await db
      .select()
      .from(requirements)
      .where(eq(requirements.id, requirement!.id));
    expect(requirementAfter!.acceptanceCriteria[0]).toMatchObject({
      status: 'passed',
      evidenceRef: after!.acceptanceCriteria[0]?.evidenceRef,
    });
    expect(requirementAfter!.acceptanceCriteria[0]?.verifiedAt).toBeTruthy();
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

describe('★ 验收证据回填', () => {
  it('自动评审把 Agent Run 证据写回任务并汇总到需求', async () => {
    const [requirement] = await db
      .insert(requirements)
      .values({
        orgId: fx.orgId,
        projectId: fx.projectId,
        rawInput: '自动核验功能',
        status: 'approved',
        acceptanceCriteria: [
          {
            id: 'requirement-ac-auto',
            text: '核心功能通过自动核验',
            verification: 'auto',
            status: 'pending',
            evidenceRef: null,
            verifiedAt: null,
          },
        ],
      })
      .returning();
    const [oldPlan, activePlan] = await db
      .insert(plans)
      .values([
        {
          projectId: fx.projectId,
          requirementId: requirement!.id,
          version: 1,
          status: 'approved',
        },
        {
          projectId: fx.projectId,
          requirementId: requirement!.id,
          version: 2,
          status: 'approved',
        },
      ])
      .returning();
    await createWorkItem(db, fx, {
      status: 'ready',
      requirementId: requirement!.id,
      planId: oldPlan!.id,
      acceptanceCriteria: [
        {
          id: 'requirement-ac-auto',
          text: '旧计划里的同名验收项',
          verification: 'auto',
          status: 'pending',
          evidenceRef: null,
          verifiedAt: null,
        },
      ],
    });
    const agent = await seedAgent(db, fx, { registry });
    const item = await createWorkItem(db, fx, {
      status: 'reviewing',
      requirementId: requirement!.id,
      planId: activePlan!.id,
      typeData: {
        qualityGate: {
          testSource: 'workspace_check',
          testCommand: 'pnpm test',
          testsPassed: true,
          securityScanPassed: true,
        },
      },
      acceptanceCriteria: [
        {
          id: 'task-ac-auto',
          text: '核心功能通过自动核验',
          requirementCriterionId: 'requirement-ac-auto',
          verification: 'agent',
          status: 'pending',
          evidenceRef: null,
          verifiedAt: null,
        },
      ],
    });
    const [run] = await db
      .insert(agentRuns)
      .values({
        orgId: fx.orgId,
        projectId: fx.projectId,
        workItemId: item.id,
        agentId: agent.agentId,
        status: 'completed',
        idempotencyKey: `acceptance-${randomUUID()}`,
        goal: item.title,
        agentSelfReport: '- [task-ac-auto] passed: automated verification succeeded',
      })
      .returning();

    const outcomes = await reviewRound(db, {
      projectId: fx.projectId,
      correlationId: randomUUID(),
    });

    expect(outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workItemId: item.id, action: 'advanced', finalStatus: 'done' }),
      ]),
    );
    const [after] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(after!.acceptanceCriteria[0]).toMatchObject({
      status: 'passed',
      verification: 'agent',
      evidenceRef: `agent-run:${run!.id}`,
    });
    const [requirementAfter] = await db
      .select()
      .from(requirements)
      .where(eq(requirements.id, requirement!.id));
    expect(requirementAfter!.acceptanceCriteria[0]).toMatchObject({
      status: 'passed',
      evidenceRef: `agent-run:${run!.id}`,
    });
  });
});

describe('★ 决策责任不可代行', () => {
  it('★ 批准人工评审后完成发布链，不把任务卡在 reviewing', async () => {
    const [requirement] = await db
      .insert(requirements)
      .values({
        orgId: fx.orgId,
        projectId: fx.projectId,
        rawInput: '人工核验交付物',
        status: 'approved',
        acceptanceCriteria: [
          {
            id: 'requirement-ac-1',
            text: '交付物已人工核验',
            verification: 'human',
            status: 'pending',
            evidenceRef: null,
            verifiedAt: null,
          },
        ],
      })
      .returning();
    const item = await createWorkItem(db, fx, {
      status: 'reviewing',
      requirementId: requirement!.id,
      acceptanceCriteria: [
        {
          id: 'review-ac-1',
          text: '人工核验交付物',
          requirementCriterionId: 'requirement-ac-1',
          verification: 'human',
          status: 'pending',
          evidenceRef: null,
          verifiedAt: null,
        },
      ],
    });
    const [decision] = await db
      .insert(decisions)
      .values({
        orgId: fx.orgId,
        projectId: fx.projectId,
        workItemId: item.id,
        type: 'review_approval',
        riskLevel: 'low',
        reversible: true,
        title: '评审：人工核验交付物',
        whyHuman: '仓库没有自动质量核验命令',
        assigneeId: fx.userId,
        status: 'pending',
      })
      .returning();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/decisions/${decision!.id}/approve`,
      headers: auth(),
      payload: { note: '交付物已人工核验通过' },
    });

    expect(res.statusCode).toBe(200);
    const [after] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(after!.status).toBe('done');
    expect(after!.acceptanceCriteria[0]).toMatchObject({
      status: 'passed',
      verification: 'human',
      evidenceRef: `decision:${decision!.id}`,
    });
    expect(after!.acceptanceCriteria[0]?.verifiedAt).toBeTruthy();

    const [requirementAfter] = await db
      .select()
      .from(requirements)
      .where(eq(requirements.id, requirement!.id));
    expect(requirementAfter!.acceptanceCriteria[0]).toMatchObject({
      status: 'passed',
      evidenceRef: `decision:${decision!.id}`,
    });
    expect(requirementAfter!.acceptanceCriteria[0]?.verifiedAt).toBeTruthy();

    const itemEvents = await db.select().from(events).where(eq(events.subjectId, item.id));
    expect(itemEvents.some((event) => event.type === 'work_item.force_passed')).toBe(true);
    expect(itemEvents.some((event) => event.type === 'work_item.acceptance_updated')).toBe(true);
    const requirementEvents = await db
      .select()
      .from(events)
      .where(eq(events.subjectId, requirement!.id));
    expect(requirementEvents.some((event) => event.type === 'requirement.acceptance_updated')).toBe(
      true,
    );
  });

  it('★ 驳回人工评审后进入返工，不错误调用 decision_rejected', async () => {
    const item = await createWorkItem(db, fx, { status: 'reviewing' });
    const [decision] = await db
      .insert(decisions)
      .values({
        orgId: fx.orgId,
        projectId: fx.projectId,
        workItemId: item.id,
        type: 'review_approval',
        riskLevel: 'low',
        reversible: true,
        title: '评审：需要返工',
        whyHuman: '需要人工核验',
        assigneeId: fx.userId,
        status: 'pending',
      })
      .returning();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/decisions/${decision!.id}/reject`,
      headers: auth(),
      payload: { reason: '执行报告明确说明没有写出任何文件' },
    });

    expect(res.statusCode).toBe(200);
    const [after] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(after!.status).toBe('changes_requested');
  });

  it('★ 状态流转失败时决策仍保持 pending，不留下半成功状态', async () => {
    const item = await createWorkItem(db, fx, { status: 'ready' });
    const [decision] = await db
      .insert(decisions)
      .values({
        orgId: fx.orgId,
        projectId: fx.projectId,
        workItemId: item.id,
        type: 'review_approval',
        riskLevel: 'low',
        reversible: true,
        title: '不应在 Ready 状态批准评审',
        whyHuman: '事务回滚测试',
        assigneeId: fx.userId,
        status: 'pending',
      })
      .returning();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/decisions/${decision!.id}/approve`,
      headers: auth(),
      payload: { note: '这个流转会失败' },
    });

    expect(res.statusCode).toBe(409);
    const [afterDecision] = await db
      .select()
      .from(decisions)
      .where(eq(decisions.id, decision!.id));
    const [afterItem] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(afterDecision!.status).toBe('pending');
    expect(afterDecision!.resolvedAt).toBeNull();
    expect(afterItem!.status).toBe('ready');
  });

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
    expect(body.metrics.tokens.reported).toBe(true);
    expect(body.metrics.tokens.total).toBeGreaterThan(0);
    expect(body.metrics.durationMs).toBeGreaterThanOrEqual(0);

    expect(body.artifacts.length).toBeGreaterThan(0);
    expect(body.related.attempts).toHaveLength(1);
    expect(body.error).toBeNull();
  });

  it('运行时没有上报用量时返回 unknown 标记，而不是伪造 0 token', async () => {
    const agent = await seedAgent(db, fx, { registry });
    const item = await createWorkItem(db, fx);
    const now = new Date();
    const [run] = await db
      .insert(agentRuns)
      .values({
        orgId: fx.orgId,
        projectId: fx.projectId,
        workItemId: item.id,
        agentId: agent.agentId,
        kind: 'execution',
        attempt: 1,
        idempotencyKey: randomUUID(),
        goal: item.title,
        inputContext: [],
        status: 'completed',
        startedAt: now,
        endedAt: now,
      })
      .returning();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${run!.id}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().metrics.tokens).toMatchObject({ reported: false, total: 0 });
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
  it('token 按步骤拆分，能定位哪一步烧配额', async () => {
    const { run } = await completedRun();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${run.id}/cost-breakdown`,
      headers: auth(),
    });

    const steps = res.json().steps as { step: number | null; tokens: number }[];
    expect(steps.length).toBeGreaterThan(1);
    /**
     * ★ 分步之和必须等于 Run 上的累计值。两处各自累加同一批事件，
     *   一旦有一类 token 只被其中一处算进去，这条就会红 ——
     *   而那种偏差在界面上只表现为「分步加起来对不上总数」，没人会去查。
     */
    const total = steps.reduce((sum, s) => sum + s.tokens, 0);
    const runTotal =
      run.tokensInput + run.tokensOutput + run.tokensCacheRead + run.tokensCacheWrite;
    expect(total).toBe(runTotal);
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
  /**
   * ★ 拦住生产库变更的那条规则得自己建 —— 平台不再自带任何硬编码基线，
   *   库里没有规则时这些任务会一路走过去，测的就不是「等审批时停在哪一列」了。
   */
  async function seedProdDbRule() {
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
  }

  it('执行前审批的任务留在 Execution 列并带 Human Gate 标识', async () => {
    await seedProdDbRule();
    // 生产 DDL 任务：plan_approved 时会被这条 Policy 拦下
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

  it('批准 Policy 决策后进入目标状态，不重复创建同一审批', async () => {
    await seedProdDbRule();
    const item = await createWorkItem(db, fx, {
      status: 'draft',
      stage: 'intake',
      title: '数据库索引变更',
      typeData: { environment: 'production', operationType: 'db_ddl' },
    });

    const { transition } = await import('../modules/flow/transition');
    const gated = await transition(db, {
      workItemId: item.id,
      trigger: 'plan_approved',
      actor: { type: 'human', id: fx.userId },
      correlationId: randomUUID(),
    });

    expect(gated.ok).toBe(true);
    if (!gated.ok || !gated.createdDecisionId) return;

    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/decisions/${gated.createdDecisionId}/approve`,
      headers: auth(),
      payload: { note: 'DBA approved' },
    });

    expect(approved.statusCode).toBe(200);
    expect(approved.json().workItem.to).toBe('ready');
    expect(approved.json().workItem.createdDecisionId).toBeNull();

    const [updated] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(updated?.status).toBe('ready');

    const pending = await db
      .select()
      .from(decisions)
      .where(
        and(
          eq(decisions.workItemId, item.id),
          eq(decisions.status, 'pending'),
        ),
      );
    expect(pending).toHaveLength(0);
  });

  it('批准派发边界的 Policy 决策后真正恢复 queued Run', async () => {
    await seedProdDbRule();
    const runtime = new MockRuntime({}, { steps: ['执行批准后的任务'], stepDelayMs: 100 });
    await seedAgent(db, fx, { registry, runtime });
    const item = await createWorkItem(db, fx, {
      status: 'ready',
      title: '数据库索引变更',
      riskLevel: 'high',
      typeData: { environment: 'production', operationType: 'db_ddl' },
    });

    await scheduleRound(db, registry, {
      projectId: fx.projectId,
      correlationId: randomUUID(),
    });

    const [queued] = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.workItemId, item.id));
    const [decision] = await db
      .select()
      .from(decisions)
      .where(and(eq(decisions.workItemId, item.id), eq(decisions.status, 'pending')));
    expect(queued?.status).toBe('queued');
    expect(decision).toBeTruthy();

    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/decisions/${decision!.id}/approve`,
      headers: auth(),
      payload: { note: 'DBA approved' },
    });

    expect(approved.statusCode).toBe(200);
    expect(runtime.dispatchedTask(queued!.id)).toBeTruthy();
    const [resumed] = await db.select().from(agentRuns).where(eq(agentRuns.id, queued!.id));
    expect(resumed?.status).not.toBe('queued');
  });

  it('执行后审批的任务留在 Review 列', async () => {
    await seedProdDbRule();
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
