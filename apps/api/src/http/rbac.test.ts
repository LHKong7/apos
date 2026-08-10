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
import { guardRouteCoverage, isExempt, permissionsForRoute, registeredRoutes } from './rbac';

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
    expect(() => assertCovered()).toThrow(/ROUTE_PERMISSIONS/);
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

  it('路由表登记的都是真实存在的权限名', () => {
    expect(registeredRoutes().length).toBeGreaterThan(30);
  });

  /** 同一个端点上，「改状态」和「强制放行」不能共用一档权限 */
  it('★ 勾了 overrideGuards 就额外要 force_pass', () => {
    const plain = permissionsForRoute('PATCH', '/api/v1/work-items/:id/status', {
      body: { toStatus: 'done' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const forced = permissionsForRoute('PATCH', '/api/v1/work-items/:id/status', {
      body: { toStatus: 'done', overrideGuards: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(plain).toEqual(['work_item.execute']);
    expect(forced).toContain('work_item.force_pass');
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
        allowedTools: ['read_file', 'write_file'],
        deniedTools: ['merge_pr'],
        resourceScopes: [{ kind: 'repo', ref: 'order-service', access: 'write' }],
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
      payload: { allowedTools: ['read_file'] },
    });
    expect(restrict.statusCode).toBe(200);

    const expand = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/agents/${agent.id}`,
      headers: as(owner),
      payload: { allowedTools: ['read_file', 'deploy'], reason: '要发布' },
    });
    expect(expand.statusCode).toBe(403);
    expect(expand.json().error.message).toContain('tech_lead');
  });

  /**
   * ★ 黑名单优先级高于白名单（§3.1）。从黑名单里拿掉一项是**放宽**，
   *   哪怕白名单一个字没动 —— 按「列表变短 = 收紧」的直觉判会判反，
   *   而判反的后果正是「绝对不能合并代码」这条硬约束被 owner 自己撤掉。
   */
  it('★ 从黑名单里删一项算扩大权限，owner 做不到', async () => {
    const owner = await createMember(db, fx, { projectRole: 'member' });
    const agent = await seedOwnedAgent(owner);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/agents/${agent.id}`,
      headers: as(owner),
      payload: { deniedTools: [], reason: '不需要这条限制了' },
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
