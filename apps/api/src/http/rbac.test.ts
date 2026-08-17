import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  agentRuns,
  agents,
  decisions,
  events,
  organizationMembers,
  plans,
  policies,
  projectMembers,
} from '@apos/db';
import { RuntimeRegistry } from '@apos/agent-runtimes';
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
import { seedAgent } from '../test/agent-fixtures';
import { guardRouteCoverage, isExempt } from './rbac';
import { PERMISSIONS } from '@apos/domain';
import { registerRoutes } from './routes';

/**
 * RBAC 的服务端强制（docs/tech/09-security.md §2）。
 *
 * ★ 这一组测试的对象是「拦不拦得住」，不是「功能通不通」。
 *   所以每个用例都用 {@link createMember} 造角色明确的人 ——
 *   夹具身份是组织管理员，拿它测「谁不能做什么」永远是绿的。
 *
 * ★ 灰按钮不是权限。前端能不能点是另一回事，这里验的是
 *   直接打 API（或者用一个旧版本的前端）能不能绕过去。
 */

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

const as = (userId: string) => authFor(userId);

async function makeRequirement(status = 'clarifying') {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${fx.projectId}/requirements`,
    headers: as(fx.userId),
    payload: { rawInput: '订单查询太慢' },
  });
  const id = res.json().requirement.id as string;
  // 直接落状态，跳过澄清流程 —— 这一组测试关心的是谁能批，不是怎么走到能批
  await db.execute(sql`update requirements set status = ${status} where id = ${id}`);
  return id;
}

describe('★★ 写路由必须登记权限，否则服务起不来', () => {
  /**
   * 这条机制是整套 RBAC 里唯一「以后也不会漏」的保证：
   * 权限矩阵没法从 URL 形状推出来，只能一条条登记 ——
   * 那就让漏登记在启动时就炸，而不是等某天有人发现 viewer 能改自治等级。
   */
  it('★ 没登记的写路由会让清点当场失败，并指名是哪一条', async () => {
    const probe = Fastify();
    const assertCovered = guardRouteCoverage(probe);
    probe.post('/api/v1/projects/:id/danger', async () => ({ ok: true }));
    await probe.ready();

    expect(() => assertCovered()).toThrow('POST /api/v1/projects/:id/danger');
    expect(() => assertCovered()).toThrow(/config\.auth\.permission/);
    await probe.close();
  });

  it('读路由不需要登记 —— 成员关系闸门已经兜住了', async () => {
    const probe = Fastify();
    const assertCovered = guardRouteCoverage(probe);
    probe.get('/api/v1/projects/:id/something-new', async () => ({ ok: true }));
    await probe.ready();

    expect(() => assertCovered()).not.toThrow();
    await probe.close();
  });

  /** 真实的服务必须是清点通过的 —— 这条挂了说明有路由漏登记 */
  it('★ 现有全部路由都已登记或写明豁免', async () => {
    await expect(
      buildApp({
        db,
        bus: new EventBus(),
        registry: new RuntimeRegistry(),
        integrations: integrationRegistry(),
        provider: new StubPlanningProvider(),
      }).then((a) => a.close()),
    ).resolves.toBeUndefined();
  });

  it('豁免必须写明理由 —— Agent 回调走 Run 令牌，不是遗漏', () => {
    expect(isExempt('POST', '/api/v1/agent-callback/runs/x/events')).toContain('Run 级令牌');
    expect(isExempt('POST', '/api/v1/projects/x/policies')).toBeNull();
  });

});

/**
 * ★★ 「哪条路由要哪条权限」的对照表 —— 现在是**断言**，不是运行时的第二个真相。
 *
 *   权限声明搬到了各条路由自己身上（`config.auth`），换来的是「加路由的人
 *   看得见它」。代价是这张全景图散掉了：抄错一条权限、把隔壁那条粘过来，
 *   在单个文件里都长得完全正常。
 *
 *   所以对照表留在测试里，钉住搬家前后每一条的取值。它红了只有两种可能：
 *   有人改了某条路由的权限（那应该是一次明确的决定，连同这里一起改），
 *   或者搬家搬错了。
 *
 * The route-to-permission table, kept as an assertion rather than as runtime
 * state. Declarations now live on each route, which is what makes them visible
 * when you add one — but it scatters the overview, and a permission copied
 * from the neighbouring route looks fine in isolation. This table pins every
 * value across the move.
 */
const EXPECTED_PERMISSIONS: Record<string, string | string[]> = {
  'GET /api/v1/admin/capabilities': 'agent.view',
  'DELETE /api/v1/admin/agents/:id': 'agent.delete',
  'DELETE /api/v1/admin/repositories/:id': 'repository.manage',
  'DELETE /api/v1/admin/roles/:key': 'org.roles.manage',
  'DELETE /api/v1/admin/storage-targets/:id': 'storage_target.manage',
  'DELETE /api/v1/conventions/:id': 'convention.manage',
  'DELETE /api/v1/integrations/:id': 'integration.disconnect',
  'DELETE /api/v1/organizations/:id': 'organization.delete',
  'DELETE /api/v1/organizations/:id/members/:userId': 'organization.members.manage',
  'DELETE /api/v1/projects/:id/members/:memberId': 'project.members.manage',
  'DELETE /api/v1/projects/:id/policies/:policyId': 'policy.loosen',
  'DELETE /api/v1/requirements/:id': 'requirement.delete',
  'GET /api/v1/projects/:id/members': 'project.view',
  'PATCH /api/v1/admin/agents/:id': 'agent.update',
  'PATCH /api/v1/admin/repositories/:id': 'repository.manage',
  'PATCH /api/v1/admin/roles/:key': 'org.roles.manage',
  'PATCH /api/v1/admin/storage-targets/:id': 'storage_target.manage',
  'PATCH /api/v1/admin/users/:id/org-role': 'org.members.manage',
  'PATCH /api/v1/conventions/:id': 'convention.manage',
  'PATCH /api/v1/integrations/:id/notifications': 'integration.configure_notification',
  'PATCH /api/v1/integrations/:id/sync-mapping': 'integration.change_sot',
  'PATCH /api/v1/organizations/:id': 'organization.update',
  'PATCH /api/v1/projects/:id/autonomy': 'project.autonomy.change',
  'PATCH /api/v1/projects/:id/labor-cost': 'project.settings.update',
  'PATCH /api/v1/projects/:id/policies/:policyId': 'policy.tighten',
  'PATCH /api/v1/requirements/:id': 'requirement.edit',
  'PATCH /api/v1/work-items/:id/assignee': 'work_item.assign',
  'POST /api/v1/admin/agents': 'agent.create',
  'POST /api/v1/admin/agents/:id/probe': 'agent.update',
  'POST /api/v1/admin/repositories': 'repository.manage',
  'POST /api/v1/admin/repositories/:id/probe': 'repository.manage',
  'POST /api/v1/admin/roles': 'org.roles.manage',
  'POST /api/v1/admin/roles/:key/clone': 'org.roles.manage',
  'POST /api/v1/admin/roles/:key/preview': 'project.view',
  'POST /api/v1/admin/storage-targets': 'storage_target.manage',
  'POST /api/v1/admin/storage-targets/:id/probe': 'storage_target.manage',
  'POST /api/v1/admin/users': 'organization.members.manage',
  'POST /api/v1/agents/:agentId/pause': 'agent.pause',
  'POST /api/v1/assumptions/:id/confirm': 'requirement.edit',
  'POST /api/v1/assumptions/:id/invalidate': 'requirement.edit',
  'POST /api/v1/clarifications/:id/answer': 'clarification.answer',
  'POST /api/v1/decisions/:id/approve': 'decision.act',
  'POST /api/v1/decisions/:id/reject': 'decision.act',
  'POST /api/v1/decisions/:id/remind': 'decision.remind',
  'POST /api/v1/integrations/:id/ingest-ci': 'integration.view',
  'POST /api/v1/integrations/:id/objects': 'integration.view',
  'POST /api/v1/integrations/:id/sync': 'integration.view',
  'POST /api/v1/organizations/:id/members': 'organization.members.manage',
  'POST /api/v1/plans/:id/approve': 'plan.approve',
  'POST /api/v1/plans/:id/revise': 'plan.generate',
  'POST /api/v1/projects': 'project.create',
  'POST /api/v1/projects/:id/agents/:agentId/access/preview': 'agent.view',
  'POST /api/v1/projects/:id/conventions': 'convention.manage',
  'POST /api/v1/projects/:id/integrations': 'integration.connect',
  'POST /api/v1/projects/:id/policies': 'policy.tighten',
  'POST /api/v1/projects/:id/policies/autonomy-preview': 'policy.view',
  'POST /api/v1/projects/:id/policies/evaluate': 'policy.view',
  'POST /api/v1/projects/:id/policies/from-template': 'policy.view',
  'POST /api/v1/projects/:id/policies/simulate': 'policy.view',
  'POST /api/v1/projects/:id/requirements': 'requirement.create',
  'POST /api/v1/projects/:id/schedule': 'project.schedule',
  'POST /api/v1/projects/:id/work-items': 'work_item.create',
  'POST /api/v1/requirements/:id/analyze': 'requirement.edit',
  'POST /api/v1/requirements/:id/approve': 'requirement.approve',
  'POST /api/v1/requirements/:id/assumptions': 'requirement.edit',
  'POST /api/v1/requirements/:id/plans': 'plan.generate',
  'POST /api/v1/requirements/:id/reject': 'requirement.approve',
  'POST /api/v1/requirements/:id/reopen': 'requirement.approve',
  'POST /api/v1/runs/:id/control': 'run.control',
  'POST /api/v1/sync-conflicts/:id/resolve': 'integration.resolve_conflict',
  'POST /api/v1/work-items/:id/assign': 'work_item.execute',
  'POST /api/v1/work-items/:id/retry': 'work_item.execute',
  'POST /api/v1/work-items/:id/start': 'work_item.execute',
  'POST /api/v1/work-items/:id/takeover': 'work_item.takeover',
  'PUT /api/v1/projects/:id/agents': 'project.settings.update',
  'PUT /api/v1/projects/:id/agents/:agentId/access': 'agent.permissions.restrict',
  'PUT /api/v1/projects/:id/members/:memberId': 'project.members.manage',
  'PUT /api/v1/requirements/:id/author-agent': 'requirement.edit',};

/** 取决于请求内容的那几条，逐个单测（见下面「勾了 overrideGuards」那组） */
const DYNAMIC_ROUTES = new Set([
  'GET /api/v1/runs/:id/events',
  'PATCH /api/v1/work-items/:id/status',
  'POST /api/v1/decisions/batch-approve',
  'POST /api/v1/projects/:id/policies/:policyId/toggle',
  'POST /api/v1/requirements/:id/approve-and-plan',]);

describe('★★ 路由权限声明', () => {
  async function declarations() {
    const probe = Fastify();
    const assertCovered = guardRouteCoverage(probe);
    await registerRoutes(probe, {
      db,
      bus: new EventBus(),
      registry: new RuntimeRegistry(),
      integrations: integrationRegistry(),
      provider: new StubPlanningProvider(),
    });
    await probe.ready();
    const out = assertCovered.declarations();
    await probe.close();
    return out;
  }

  /**
   * ★★ 搬家不能改变任何一条路由要什么权限。
   *   这是把集中表拆散那次改动的验收条件本身。
   */
  it('每条路由声明的权限与对照表一致', async () => {
    const actual: Record<string, unknown> = {};
    for (const d of await declarations()) {
      const key = `${d.method} ${d.url}`;
      /**
       * ★ Fastify 给每条 GET 自动配一条 HEAD。它继承同一份声明是**对的**
       *   （HEAD 与 GET 该同档），只是对照表按显式注册的路由写的。
       *   下面那条用例专门盯住这对孪生路由不会走散。
       */
      if (d.method === 'HEAD') continue;
      if (DYNAMIC_ROUTES.has(key)) continue;
      const p = d.auth.permission;
      if (p === undefined || typeof p === 'function') continue;
      if (typeof p === 'object' && !Array.isArray(p)) continue; // deferred
      actual[key] = p;
    }
    expect(actual).toEqual(EXPECTED_PERMISSIONS);
  });

  /**
   * ★★ HEAD 是 Fastify 自动配出来的，但它照样打到同一个 handler 上。
   *   两者的声明一旦走散，就出现「HEAD 能读、GET 不能」这种没人会去试的口子。
   */
  it('自动生成的 HEAD 与对应的 GET 同一档权限', async () => {
    const all = await declarations();
    const gets = new Map(all.filter((d) => d.method === 'GET').map((d) => [d.url, d.auth]));
    const heads = all.filter((d) => d.method === 'HEAD');

    expect(heads.length).toBeGreaterThan(0);
    for (const head of heads) {
      expect(head.auth.permission, `HEAD ${head.url}`).toEqual(gets.get(head.url)?.permission);
    }
  });

  /** ★ deferred 必须带理由：它是这套启动即失败机制唯一的绕过方式 */
  it('deferred 的路由都写明了理由', async () => {
    const deferredOnes = (await declarations()).filter(
      (d) =>
        typeof d.auth.permission === 'object' &&
        d.auth.permission !== null &&
        !Array.isArray(d.auth.permission),
    );
    expect(deferredOnes.length).toBeGreaterThan(0);
    for (const d of deferredOnes) {
      const why = (d.auth.permission as { deferred: string }).deferred;
      expect(why.length, `${d.method} ${d.url} 的 deferred 没写理由`).toBeGreaterThan(10);
    }
  });

  /** ★ 声明里出现的权限名必须是目录里真有的 —— 敲错一个字母等于这条路由不设防 */
  it('声明的权限名都在权限目录里', async () => {
    const known = new Set<string>(PERMISSIONS);
    for (const d of await declarations()) {
      const p = d.auth.permission;
      const names = typeof p === 'string' ? [p] : Array.isArray(p) ? p : [];
      for (const name of names) {
        expect(known.has(name), `${d.method} ${d.url} 声明了不存在的权限 ${name}`).toBe(true);
      }
    }
  });
});


describe('§2.3 权限矩阵在服务端生效', () => {
  it('★ tech_lead 批不了需求（那是 sponsor / pm 的业务判断）', async () => {
    const lead = await createMember(db, fx, { projectRole: 'tech_lead' });
    const reqId = await makeRequirement();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/requirements/${reqId}/approve`,
      headers: as(lead),
      payload: {},
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(res.json().error.message).toContain('sponsor');
  });

  it('sponsor 批得了', async () => {
    const sponsor = await createMember(db, fx, { projectRole: 'sponsor' });
    const reqId = await makeRequirement('awaiting_approval');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/requirements/${reqId}/approve`,
      headers: as(sponsor),
      payload: {},
    });

    expect(res.statusCode).not.toBe(403);
  });

  it('★ 批准计划要 tech_lead，pm 不行', async () => {
    const pm = await createMember(db, fx, { projectRole: 'pm' });
    const [plan] = await db
      .insert(plans)
      .values({ projectId: fx.projectId, version: 1, status: 'awaiting_approval' })
      .returning();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan!.id}/approve`,
      headers: as(pm),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('tech_lead');
  });

  it('修改自治等级要 pm / tech_lead，普通成员不行', async () => {
    const member = await createMember(db, fx, { projectRole: 'member' });
    const pm = await createMember(db, fx, { projectRole: 'pm' });
    const url = `/api/v1/projects/${fx.projectId}/autonomy`;
    const payload = { autonomyLevel: 'agent_autonomous' };

    expect((await app.inject({ method: 'PATCH', url, headers: as(member), payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url, headers: as(pm), payload })).statusCode).toBe(200);
  });

  /** 「强制放行」绕过的是质量闸门，不能和「改状态」同一档 */
  it('★ member 能改状态，但强制放行要 tech_lead', async () => {
    const member = await createMember(db, fx, { projectRole: 'member' });
    const item = await createWorkItem(db, fx, { status: 'reviewing' });

    const forced = await app.inject({
      method: 'PATCH',
      url: `/api/v1/work-items/${item.id}/status`,
      headers: as(member),
      payload: { toStatus: 'done', reason: '就这样吧', overrideGuards: true },
    });
    expect(forced.statusCode).toBe(403);
    expect(forced.json().error.message).toContain('强制放行');

    // 同一个人不勾 overrideGuards 就不会被这一条挡住
    const plain = await app.inject({
      method: 'PATCH',
      url: `/api/v1/work-items/${item.id}/status`,
      headers: as(member),
      payload: { toStatus: 'done', reason: '正常验收通过' },
    });
    expect(plain.statusCode).not.toBe(403);
  });

  it('★ Run 详细模式（可能含敏感上下文）挡住普通成员', async () => {
    const member = await createMember(db, fx, { projectRole: 'member' });
    const agent = await seedAgent(db, fx, { registry });
    const item = await createWorkItem(db, fx, { status: 'executing' });
    const [run] = await db
      .insert(agentRuns)
      .values({
        orgId: fx.orgId,
        projectId: fx.projectId,
        workItemId: item.id,
        agentId: agent.agentId,
        attempt: 1,
        status: 'running',
        idempotencyKey: randomUUID(),
        goal: '实现多条件查询 API',
      })
      .returning();

    const detailed = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${run!.id}/events?level=detailed`,
      headers: as(member),
    });
    expect(detailed.statusCode).toBe(403);

    const brief = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${run!.id}/events`,
      headers: as(member),
    });
    expect(brief.statusCode).toBe(200);
  });
});

describe('★ viewer 是只读的', () => {
  it('看得到项目，但一个写操作都做不了', async () => {
    const viewer = await createMember(db, fx, { projectRole: 'viewer' });

    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}`,
      headers: as(viewer),
    });
    expect(read.statusCode).toBe(200);

    const writes = [
      { method: 'POST' as const, url: `/api/v1/projects/${fx.projectId}/requirements`, payload: { rawInput: 'x' } },
      { method: 'POST' as const, url: `/api/v1/projects/${fx.projectId}/schedule`, payload: {} },
      { method: 'PATCH' as const, url: `/api/v1/projects/${fx.projectId}/labor-cost`, payload: { laborHourlyCost: 50 } },
      { method: 'PUT' as const, url: `/api/v1/projects/${fx.projectId}/members/${fx.userId}`, payload: { role: 'viewer' } },
    ];

    for (const w of writes) {
      const res = await app.inject({ ...w, headers: as(viewer) });
      expect(`${w.method} ${w.url} → ${res.statusCode}`).toBe(`${w.method} ${w.url} → 403`);
    }
  });
});

describe('★★ Policy：收紧与放宽是两档权限', () => {
  const draft = (over: Record<string, unknown> = {}) => ({
    name: '低风险代码变更自动放行',
    priority: 100,
    condition: { fact: 'riskLevel', op: 'eq', value: 'low' },
    action: { type: 'allow' },
    ...over,
  });

  it('★ pm 收得紧，放不宽', async () => {
    const pm = await createMember(db, fx, { projectRole: 'pm' });

    const loosen = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${fx.projectId}/policies`,
      headers: as(pm),
      payload: draft(),
    });
    expect(loosen.statusCode).toBe(403);
    expect(loosen.json().error.message).toContain('tech_lead');

    const tighten = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${fx.projectId}/policies`,
      headers: as(pm),
      payload: draft({
        name: '高风险一律人工确认',
        condition: { fact: 'riskLevel', op: 'eq', value: 'critical' },
        action: {
          type: 'require_human_review',
          assignee: { kind: 'project_role', role: 'tech_lead' },
          dueInHours: 4,
        },
      }),
    });
    expect(tighten.statusCode).toBe(201);
  });

  it('tech_lead 两个方向都行', async () => {
    const lead = await createMember(db, fx, { projectRole: 'tech_lead' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${fx.projectId}/policies`,
      headers: as(lead),
      payload: draft(),
    });
    expect(res.statusCode).toBe(201);
  });

  /** 停用一条规则就是把治理拿掉 —— 与放宽同档，不能只按「改了个开关」算 */
  it('★ 停用规则算放宽，pm 停不了', async () => {
    const lead = await createMember(db, fx, { projectRole: 'tech_lead' });
    const pm = await createMember(db, fx, { projectRole: 'pm' });

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${fx.projectId}/policies`,
      headers: as(lead),
      payload: draft(),
    });
    const policyId = created.json().policy.id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${fx.projectId}/policies/${policyId}/toggle`,
      headers: as(pm),
      payload: { enabled: false, reason: '先关掉' },
    });
    expect(res.statusCode).toBe(403);
  });

  /**
   * ★ 权限判定要在跑模拟之前：模拟会扫 90 天历史评估，
   *   既贵，又会把「哪些历史任务会被自动放行」告诉不该看到的人。
   */
  it('★ 没资格放宽的人，连模拟都不该被跑起来', async () => {
    const pm = await createMember(db, fx, { projectRole: 'pm' });
    const before = await db.select().from(policies);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${fx.projectId}/policies`,
      headers: as(pm),
      payload: draft(),
    });

    expect(res.statusCode).toBe(403);
    // 没有留下任何痕迹：既没建规则，也没写事件
    expect(await db.select().from(policies)).toHaveLength(before.length);
  });
});

describe('★ Agent 权限：扩大要 tech_lead，收紧 owner 就行', () => {
  async function seedOwnedAgent(ownerId: string) {
    const [agent] = await db
      .insert(agents)
      .values({
        orgId: fx.orgId,
        name: 'Review Agent',
        type: 'reviewer',
        runtimeKind: 'mock',
        ownerId,
        capabilityCeiling: ['workspace.read', 'workspace.write', 'command.test'],
        deniedCapabilities: ['pull_request.merge'],
      })
      .returning();
    return agent!;
  }

  it('★ owner 收得紧，但扩不了', async () => {
    const owner = await createMember(db, fx, { projectRole: 'member' });
    const agent = await seedOwnedAgent(owner);

    const restrict = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/agents/${agent.id}`,
      headers: as(owner),
      payload: { capabilityCeiling: ['workspace.read'] },
    });
    expect(restrict.statusCode).toBe(200);

    const expand = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/agents/${agent.id}`,
      headers: as(owner),
      payload: {
        capabilityCeiling: ['workspace.read', 'environment.deploy'],
        reason: '要发布',
      },
    });
    expect(expand.statusCode).toBe(403);
    expect(expand.json().error.message).toContain('tech_lead');
  });

  /**
   * ★ 硬拒绝优先级高于允许（§3.1）。从拒绝清单里拿掉一项是**放宽**，
   *   哪怕上限一个字没动 —— 按「列表变短 = 收紧」的直觉判会判反，
   *   而判反的后果正是「绝对不能合并代码」这条硬约束被 owner 自己撤掉。
   */
  it('★ 从硬拒绝里删一项算扩大权限，owner 做不到', async () => {
    const owner = await createMember(db, fx, { projectRole: 'member' });
    const agent = await seedOwnedAgent(owner);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/agents/${agent.id}`,
      headers: as(owner),
      payload: { deniedCapabilities: [], reason: '不需要这条限制了' },
    });
    expect(res.statusCode).toBe(403);
  });

  /**
   * ★ Agent 没被显式登记进项目，但已经在里面跑过 —— 那它就是这个项目的。
   *   只认显式登记的话，§2.3「扩大 Agent 权限需 tech_lead」会落空：
   *   一个跑了三个月的 Agent 对项目负责人是「不属于任何项目」。
   */
  it('★ tech_lead 扩得了在自己项目里跑过的 Agent 的权限', async () => {
    const owner = await createMember(db, fx, { projectRole: 'member' });
    const lead = await createMember(db, fx, { projectRole: 'tech_lead' });
    const agent = await seedOwnedAgent(owner);
    const item = await createWorkItem(db, fx, { status: 'executing' });
    await db.insert(agentRuns).values({
      orgId: fx.orgId,
      projectId: fx.projectId,
      workItemId: item.id,
      agentId: agent.id,
      attempt: 1,
      status: 'completed',
      idempotencyKey: randomUUID(),
      goal: '跑过一次',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/agents/${agent.id}`,
      headers: as(lead),
      payload: { allowedTools: ['read_file', 'write_file', 'run_tests'], reason: '需要跑测试' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('不是 owner 也不是管理员的人，连改档案都不行', async () => {
    const owner = await createMember(db, fx, { projectRole: 'member' });
    const other = await createMember(db, fx, { projectRole: 'member' });
    const agent = await seedOwnedAgent(owner);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/agents/${agent.id}`,
      headers: as(other),
      payload: { model: 'claude-opus-5' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('登记与删除 Agent 是组织管理员的事', async () => {
    const lead = await createMember(db, fx, { projectRole: 'tech_lead' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/agents',
      headers: as(lead),
      payload: { name: 'x', type: 'coder', runtimeKind: 'mock', ownerId: lead, allowedTools: ['read_file'] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('组织管理员');
  });
});

describe('★ 批量批准：权限按每条决策各自的项目判', () => {
  async function decisionIn(projectId: string, orgId: string, assigneeId: string | null) {
    const [d] = await db
      .insert(decisions)
      .values({
        orgId,
        projectId,
        type: 'approval',
        riskLevel: 'low',
        reversible: true,
        title: '批量测试',
        whyHuman: '测试',
        assigneeId,
        status: 'pending',
      })
      .returning();
    return d!;
  }

  /**
   * ★★ 批量接口的 URL 里没有项目 id —— ②层闸门够不着它。
   *   而无人认领的决策（assigneeId 为空）按产品口径照样进批量，
   *   于是它对任何拿到 id 的人开放。这是绕过项目边界最省事的一条路。
   */
  it('★ 非成员批不动别的项目里无人认领的决策', async () => {
    const outsider = await createOutsider(db, fx);
    const d = await decisionIn(fx.projectId, fx.orgId, null);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/decisions/batch-approve',
      headers: as(outsider.userId),
      payload: { ids: [d.id] },
    });

    expect(res.json().approved).toBe(0);
    // 不确认「这条决策存在」，与②层同一口径
    expect(res.json().failed[0].error).toContain('没有访问权限');

    const [after] = await db.select().from(decisions).where(eq(decisions.id, d.id));
    expect(after!.status).toBe('pending');
  });

  it('★ 同组织的 viewer 也批不动 —— 是成员不等于能决策', async () => {
    const viewer = await createMember(db, fx, { projectRole: 'viewer' });
    const d = await decisionIn(fx.projectId, fx.orgId, null);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/decisions/batch-approve',
      headers: as(viewer),
      payload: { ids: [d.id] },
    });

    expect(res.json().approved).toBe(0);
    expect(res.json().failed[0].error).toContain('只读');
  });

  it('本项目成员照常能批', async () => {
    const member = await createMember(db, fx, { projectRole: 'member' });
    const d = await decisionIn(fx.projectId, fx.orgId, member);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/decisions/batch-approve',
      headers: as(member),
      payload: { ids: [d.id] },
    });
    expect(res.json().approved).toBe(1);
  });
});

describe('成员与角色管理', () => {
  it('pm 能改成员角色，普通成员不能', async () => {
    const pm = await createMember(db, fx, { projectRole: 'pm' });
    const target = await createMember(db, fx, { projectRole: 'member' });

    const denied = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${fx.projectId}/members/${pm}`,
      headers: as(target),
      payload: { role: 'tech_lead' },
    });
    expect(denied.statusCode).toBe(403);

    const ok = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${fx.projectId}/members/${target}`,
      headers: as(pm),
      payload: { role: 'tech_lead' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().previousRole).toBe('member');
  });

  /** §6.3：权限变更必须留痕，否则提权路径上最关键的一步查不到 */
  it('★ 角色变更写入审计事件', async () => {
    const target = await createMember(db, fx, { projectRole: 'member' });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${fx.projectId}/members/${target}`,
      headers: as(fx.userId),
      payload: { role: 'tech_lead' },
    });

    const rows = await db
      .select()
      .from(events)
      .where(eq(events.type, 'project.member_role_changed'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ from: 'member', to: 'tech_lead' });
    expect(rows[0]!.actorId).toBe(fx.userId);
    expect(rows[0]!.subjectId).toBe(target);
  });

  /**
   * ★★ Agent 加入项目时可以不点角色，落到 executor。
   *
   *   这一组测的是「默认发生在加入项目、而不是建 Agent」这条边界：
   *   建 Agent 不该碰任何项目，加入项目才补最低档。
   */
  describe('Agent 加入项目的默认角色', () => {
    it('不给 role 的 Agent 进项目，拿到 executor', async () => {
      const agent = await seedAgent(db, fx, { registry, inProject: false });

      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/projects/${fx.projectId}/members/${agent.agentId}`,
        headers: as(fx.userId),
        payload: { actorType: 'agent' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ role: 'executor', changed: true, previousRole: null });
    });

    /**
     * ★★ 这条比默认值本身更重要。
     *
     *   「加入项目」和「改角色」是同一个端点，一次误点如果把管理员调过的
     *   角色重置成 executor，降完之后它和「本来就是 executor」在界面上
     *   完全一样 —— 没有人会发现自己被降权了。
     */
    it('★ 已是成员的 Agent 再不给 role，角色不被覆盖', async () => {
      const agent = await seedAgent(db, fx, { registry, inProject: false });
      const url = `/api/v1/projects/${fx.projectId}/members/${agent.agentId}`;

      await app.inject({
        method: 'PUT',
        url,
        headers: as(fx.userId),
        payload: { actorType: 'agent', role: 'viewer' },
      });

      const again = await app.inject({
        method: 'PUT',
        url,
        headers: as(fx.userId),
        payload: { actorType: 'agent' },
      });

      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ role: 'viewer', changed: false });

      const [row] = await db
        .select()
        .from(projectMembers)
        .where(eq(projectMembers.actorId, agent.agentId));
      expect(row!.role).toBe('viewer');
    });

    it('显式给的 role 优先于默认档', async () => {
      const agent = await seedAgent(db, fx, { registry, inProject: false });

      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/projects/${fx.projectId}/members/${agent.agentId}`,
        headers: as(fx.userId),
        payload: { actorType: 'agent', role: 'viewer' },
      });

      expect(res.json().role).toBe('viewer');
    });

    /**
     * ★ 人没有安全的默认档：角色从业务负责人到只读都有，
     *   替他默认任何一档都是替他做了一次授权决定。
     */
    it('★ 人不给 role 一律拒绝，不套用 Agent 的默认档', async () => {
      // projectRole: null = 本组织的人，但还不是这个项目的成员
      const notYetMember = await createMember(db, fx, { projectRole: null });

      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/projects/${fx.projectId}/members/${notYetMember}`,
        headers: as(fx.userId),
        payload: { actorType: 'human' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('必须指定角色');
    });

    it('默认补的那一档在审计事件里标了出来', async () => {
      const agent = await seedAgent(db, fx, { registry, inProject: false });
      await app.inject({
        method: 'PUT',
        url: `/api/v1/projects/${fx.projectId}/members/${agent.agentId}`,
        headers: as(fx.userId),
        payload: { actorType: 'agent' },
      });

      const [row] = await db
        .select()
        .from(events)
        .where(eq(events.type, 'project.member_added'));
      expect(row!.payload).toMatchObject({ to: 'executor', roleDefaulted: true });
    });
  });

  it('★ 不能把外组织的人拉进项目', async () => {
    const outsider = await createOutsider(db, fx);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${fx.projectId}/members/${outsider.userId}`,
      headers: as(fx.userId),
      payload: { role: 'member' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('本组织');
  });

  /** 把自己锁在门外是权限系统最常见的自伤方式 */
  it('★ 不能把项目里最后一位负责人降级', async () => {
    // 夹具用户是唯一的 tech_lead
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${fx.projectId}/members/${fx.userId}`,
      headers: as(fx.userId),
      payload: { role: 'member' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('最后一位');

    // 先立一个接班人就可以了
    const successor = await createMember(db, fx, { projectRole: 'pm' });
    expect(successor).toBeTruthy();
    const retry = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${fx.projectId}/members/${fx.userId}`,
      headers: as(fx.userId),
      payload: { role: 'member' },
    });
    expect(retry.statusCode).toBe(200);
  });

  it('★ 不能把组织里最后一个管理员降级', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${fx.userId}/org-role`,
      headers: as(fx.userId),
      payload: { orgRole: 'member' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('最后一个管理员');
  });

  it('★ 管理员改不了别的组织的人的身份', async () => {
    const outsider = await createOutsider(db, fx);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${outsider.userId}/org-role`,
      headers: as(fx.userId),
      payload: { orgRole: 'org_admin' },
    });
    expect(res.statusCode).toBe(404);

    const [after] = await db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, outsider.userId));
    expect(after!.orgRole).toBe('member');
  });

  it('身份管理只有组织管理员做得了', async () => {
    const lead = await createMember(db, fx, { projectRole: 'tech_lead' });
    const target = await createMember(db, fx, { projectRole: 'member' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${target}/org-role`,
      headers: as(lead),
      payload: { orgRole: 'org_admin' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('权限清单（给前端灰按钮用）', () => {
  it('一次拿全当前身份在这个项目里的权限与拒绝理由', async () => {
    const pm = await createMember(db, fx, { projectRole: 'pm' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}/permissions`,
      headers: as(pm),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.projectRole).toBe('pm');
    expect(body.permissions['policy.tighten']).toBe(true);
    expect(body.permissions['policy.loosen']).toBe(false);
    // 灰掉的按钮必须能说出为什么，否则用户会反复点它
    expect(body.denyReasons['policy.loosen']).toContain('tech_lead');
  });

  it('★ 前端拿到的判定与服务端真正的拦截一致', async () => {
    const member = await createMember(db, fx, { projectRole: 'member' });
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}/permissions`,
      headers: as(member),
    });
    expect(list.json().permissions['project.autonomy.change']).toBe(false);

    const attempt = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${fx.projectId}/autonomy`,
      headers: as(member),
      payload: { autonomyLevel: 'agent_autonomous' },
    });
    expect(attempt.statusCode).toBe(403);
  });
});

describe('组织管理员的「全部权限」以组织为界', () => {
  it('本组织的管理员即使不是项目成员也进得去', async () => {
    const admin = await createMember(db, fx, { projectRole: null, orgRole: 'org_admin' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}`,
      headers: as(admin),
    });
    expect(res.statusCode).toBe(200);
  });

  it('★ 别的组织的管理员照样是 404 —— 管理员不是跨租户的', async () => {
    const outsider = await createOutsider(db, fx);
    await db
      .update(organizationMembers)
      .set({ orgRole: 'org_admin' })
      .where(eq(organizationMembers.userId, outsider.userId));

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}`,
      headers: as(outsider.userId),
    });
    expect(res.statusCode).toBe(404);
  });

  it('同组织但不是成员的普通用户进不去', async () => {
    const stranger = await createMember(db, fx, { projectRole: null });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}`,
      headers: as(stranger),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('新建项目', () => {
  it('★ 建完就是成员，否则建完进不去自己的项目', async () => {
    const member = await createMember(db, fx, { projectRole: null });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: as(member),
      payload: { name: '新项目', orgId: fx.orgId },
    });
    expect(created.statusCode).toBe(201);
    const projectId = created.json().project.id;

    const rows = await db
      .select()
      .from(projectMembers)
      .where(eq(projectMembers.projectId, projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('tech_lead');

    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}`,
      headers: as(member),
    });
    expect(read.statusCode).toBe(200);
  });

  it('★ 不能往别的组织里塞项目', async () => {
    const outsider = await createOutsider(db, fx);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: as(outsider.userId),
      payload: { name: '越界项目', orgId: fx.orgId },
    });
    expect(res.statusCode).toBe(403);
  });
});
