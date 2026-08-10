import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { agents, events, projectMembers, roles } from '@apos/db';
import { RuntimeRegistry } from '@apos/agent-runtimes';
import { buildApp } from '../app';
import { EventBus } from '../modules/event/bus';
import { StubPlanningProvider } from '../modules/planning/stub-provider';
import {
  createMember,
  integrationRegistry,
  resetDb,
  seedFixture,
  testDb,
  type Fixture,
} from '../test/db';

/**
 * 自定义角色（docs/tech/09-security.md §2.2）。
 *
 * ★★ 超管造出「研发」「运营」「测试」，每个角色可以由人担任、也可以由 Agent
 *   担任。这一组测试验的是两件事：造角色的三条边界拦不拦得住，
 *   以及自定义角色的权限在服务端**真的**生效（不是只在列表里好看）。
 */

const db = testDb();
let app: FastifyInstance;
let fx: Fixture;

beforeEach(async () => {
  await resetDb(db);
  fx = await seedFixture(db);
  app = await buildApp({
    db,
    bus: new EventBus(),
    registry: new RuntimeRegistry(),
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

const as = (userId: string) => ({ 'x-user-id': userId });

const postRole = (userId: string, body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/v1/admin/roles', headers: as(userId), payload: body });

const devRole = {
  key: 'dev',
  name: '研发',
  description: '写代码、跑测试',
  permissions: ['project.view', 'policy.view', 'work_item.execute'],
  appliesTo: ['human', 'agent'],
};

async function seedAgentRow(name = 'code-agent-1') {
  const [agent] = await db
    .insert(agents)
    .values({
      orgId: fx.orgId,
      name,
      type: 'code',
      runtimeKind: 'mock',
      ownerId: fx.userId,
      allowedTools: ['read_file'],
    })
    .returning();
  return agent!;
}

describe('内置角色', () => {
  it('建组织时预置，且标记为内置', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/roles',
      headers: as(fx.userId),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.roles.map((r: { key: string }) => r.key).sort()).toEqual([
      'executor',
      'member',
      'pm',
      'sponsor',
      'tech_lead',
      'viewer',
    ]);
    expect(body.roles.every((r: { builtin: boolean }) => r.builtin)).toBe(true);
  });

  /** 内置角色**就是**权限矩阵（§2.3）。每个组织都不一样的话，文档就没意义了 */
  it('★ 内置角色的权限改不了，也删不掉', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/roles/viewer',
      headers: as(fx.userId),
      payload: { name: '只读', permissions: ['project.view', 'policy.loosen'], appliesTo: ['human'] },
    });
    expect(patch.statusCode).toBe(403);
    expect(patch.json().error.message).toContain('权限矩阵');

    const del = await app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/roles/tech_lead',
      headers: as(fx.userId),
    });
    expect(del.statusCode).toBe(403);
  });

  /** 可授予的权限清单要标出哪些进不了 Agent 角色，界面才能直接说明白 */
  it('权限清单标注 humanOnly，且不含组织级权限', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/roles',
      headers: as(fx.userId),
    });
    const perms = res.json().availablePermissions as {
      key: string;
      humanOnly: boolean;
      scope: string;
    }[];
    expect(perms.some((p) => p.key === 'decision.act' && p.humanOnly)).toBe(true);
    expect(perms.every((p) => p.scope !== 'org')).toBe(true);
  });
});

describe('★★ 造角色的边界', () => {
  it('超管能造出「研发」这样的自定义角色', async () => {
    const res = await postRole(fx.userId, devRole);
    expect(res.statusCode).toBe(201);
    expect(res.json().role).toMatchObject({ key: 'dev', name: '研发', builtin: false });
  });

  it('★ 定义角色只有组织管理员做得了 —— 定义角色就是定义权限本身', async () => {
    const lead = await createMember(db, fx, { projectRole: 'tech_lead' });
    const res = await postRole(lead, devRole);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('组织管理员');
  });

  /**
   * ★★ 允许下放组织级权限的话，超管能造一个「能创建角色的角色」发出去，
   *   拿到它的人再造一个更宽的 —— 一步从项目角色走到组织管理员。
   */
  it('★ 组织级权限不能下放给项目角色', async () => {
    const res = await postRole(fx.userId, {
      ...devRole,
      permissions: ['project.view', 'org.roles.manage'],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('组织级权限不能下放');
  });

  it('★ 不认识的权限名当场拒绝，不静默忽略', async () => {
    const res = await postRole(fx.userId, { ...devRole, permissions: ['project.view', 'bogus'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('bogus');
  });

  /** §7.2 的推论：不能自定义一个角色把 Human Gate 权限塞给 Agent */
  it('★ 把「处理决策」塞进 Agent 角色会被拒', async () => {
    const res = await postRole(fx.userId, {
      key: 'autodecider',
      name: '自动决策',
      permissions: ['project.view', 'decision.act'],
      appliesTo: ['human', 'agent'],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('只能由人类行使');
  });

  it('同样的权限限定给人类就能建', async () => {
    const res = await postRole(fx.userId, {
      key: 'ops',
      name: '运营',
      permissions: ['project.view', 'decision.act'],
      appliesTo: ['human'],
    });
    expect(res.statusCode).toBe(201);
  });

  it('角色标识重复被拒', async () => {
    await postRole(fx.userId, devRole);
    const again = await postRole(fx.userId, devRole);
    expect(again.statusCode).toBe(400);
    expect(again.json().error.message).toContain('已经被占用');
  });

  /** §6.3：定义角色是权限变更，必须留痕 */
  it('★ 建角色写入审计事件', async () => {
    await postRole(fx.userId, devRole);
    const rows = await db.select().from(events).where(eq(events.type, 'role.created'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subjectType).toBe('role');
    expect(rows[0]!.actorId).toBe(fx.userId);
    expect(rows[0]!.payload).toMatchObject({ key: 'dev' });
  });
});

describe('★★ 自定义角色的权限真的生效', () => {
  it('★ 「研发」能执行任务，但批不了计划', async () => {
    await postRole(fx.userId, devRole);
    const dev = await createMember(db, fx, { projectRole: 'dev' });

    const perms = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}/permissions`,
      headers: as(dev),
    });
    const body = perms.json();
    expect(body.projectRole).toBe('dev');
    expect(body.permissions['work_item.execute']).toBe(true);
    expect(body.permissions['plan.approve']).toBe(false);
    expect(body.denyReasons['plan.approve']).toContain('tech_lead');

    // 服务端真的拦得住，不只是清单上写着
    const attempt = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${fx.projectId}/autonomy`,
      headers: as(dev),
      payload: { autonomyLevel: 'agent_autonomous' },
    });
    expect(attempt.statusCode).toBe(403);
  });

  /** 改角色的权限，所有担任者的权限一起变 —— 这正是角色存在的理由 */
  it('★ 给角色加一条权限，担任者立刻就有了', async () => {
    await postRole(fx.userId, devRole);
    const dev = await createMember(db, fx, { projectRole: 'dev' });

    const before = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}/permissions`,
      headers: as(dev),
    });
    expect(before.json().permissions['work_item.takeover']).toBe(false);

    await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/roles/dev',
      headers: as(fx.userId),
      payload: {
        ...devRole,
        permissions: [...devRole.permissions, 'work_item.takeover'],
      },
    });

    const after = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}/permissions`,
      headers: as(dev),
    });
    expect(after.json().permissions['work_item.takeover']).toBe(true);
  });

  it('删角色前挡住，并说清楚还有几个人在担任', async () => {
    await postRole(fx.userId, devRole);
    await createMember(db, fx, { projectRole: 'dev' });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/roles/dev',
      headers: as(fx.userId),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('1 人');
    expect(res.json().error.message).toContain('权限归零');
  });

  it('没人担任就能删', async () => {
    await postRole(fx.userId, devRole);
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/roles/dev',
      headers: as(fx.userId),
    });
    expect(res.statusCode).toBe(200);
    expect(await db.select().from(roles).where(eq(roles.key, 'dev'))).toHaveLength(0);
  });
});

describe('★★ Agent 担任角色', () => {
  it('★ Agent 和人担任同一个角色，走同一条 API', async () => {
    await postRole(fx.userId, devRole);
    const agent = await seedAgentRow();
    const human = await createMember(db, fx, { projectRole: null });

    for (const [actorType, id] of [
      ['agent', agent.id],
      ['human', human],
    ] as const) {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/projects/${fx.projectId}/members/${id}`,
        headers: as(fx.userId),
        payload: { role: 'dev', actorType },
      });
      expect(`${actorType}:${res.statusCode}`).toBe(`${actorType}:200`);
    }

    const rows = await db
      .select()
      .from(projectMembers)
      .where(eq(projectMembers.projectId, fx.projectId));
    expect(rows.filter((r) => r.actorType === 'agent' && r.role === 'dev')).toHaveLength(1);
  });

  it('★ 只给人的角色指派不到 Agent 头上', async () => {
    await postRole(fx.userId, {
      key: 'ops',
      name: '运营',
      permissions: ['project.view', 'decision.act'],
      appliesTo: ['human'],
    });
    const agent = await seedAgentRow();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${fx.projectId}/members/${agent.id}`,
      headers: as(fx.userId),
      payload: { role: 'ops', actorType: 'agent' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('不能由 Agent 担任');
  });

  /**
   * ★ 把角色从 [human, agent] 收窄成 [human]，而已经有 Agent 在担任 ——
   *   那些 Agent 会变成一个说不清算不算数的状态。宁可现在拒绝。
   */
  it('★ 还有 Agent 在担任时，不能把角色改成「仅人类」', async () => {
    await postRole(fx.userId, devRole);
    const agent = await seedAgentRow();
    await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${fx.projectId}/members/${agent.id}`,
      headers: as(fx.userId),
      payload: { role: 'dev', actorType: 'agent' },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/roles/dev',
      headers: as(fx.userId),
      payload: { ...devRole, appliesTo: ['human'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('1 个 Agent');
  });

  it('Agent 成员出现在名册里，标注担任的角色', async () => {
    await postRole(fx.userId, devRole);
    const agent = await seedAgentRow('测试 Agent');
    await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${fx.projectId}/members/${agent.id}`,
      headers: as(fx.userId),
      payload: { role: 'dev', actorType: 'agent' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}/members`,
      headers: as(fx.userId),
    });
    const member = res
      .json()
      .members.find((m: { actorType: string }) => m.actorType === 'agent');
    expect(member).toMatchObject({ role: 'dev', roleLabel: '研发', name: '测试 Agent' });
  });

  it('★ 外组织的 Agent 加不进来', async () => {
    await postRole(fx.userId, devRole);
    const [otherOrgAgent] = await db
      .insert(agents)
      .values({
        orgId: (await seedFixtureOrg()).orgId,
        name: '别人的 Agent',
        type: 'code',
        runtimeKind: 'mock',
        ownerId: fx.userId,
      })
      .returning();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${fx.projectId}/members/${otherOrgAgent!.id}`,
      headers: as(fx.userId),
      payload: { role: 'dev', actorType: 'agent' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('本组织');
  });
});

/** 另建一个组织，用来验证跨组织的东西加不进来 */
async function seedFixtureOrg() {
  const { organizations } = await import('@apos/db');
  const [org] = await db.insert(organizations).values({ name: `Other-${randomUUID()}` }).returning();
  return { orgId: org!.id };
}

describe('「至少留一个能管成员的人」按权限判，不按角色名', () => {
  /**
   * ★★ 角色可自定义之后，「负责人」可能叫「运营主管」也可能叫「Tech Owner」。
   *   按名字判的话，一个把 pm 换成自定义角色的组织会突然失去这条保护 ——
   *   而失去它的表现是某天没人能改成员了，且只能改数据库来恢复。
   */
  it('★ 自定义的「主管」角色带 members.manage，一样算数', async () => {
    await postRole(fx.userId, {
      key: 'lead2',
      name: '技术主管',
      permissions: ['project.view', 'project.members.manage'],
      appliesTo: ['human'],
    });
    const successor = await createMember(db, fx, { projectRole: 'lead2' });
    expect(successor).toBeTruthy();

    // 夹具用户是唯一的 tech_lead，但现在还有一位自定义主管，可以降级了
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${fx.projectId}/members/${fx.userId}`,
      headers: as(fx.userId),
      payload: { role: 'member' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('没有接班人时仍然拦住', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${fx.projectId}/members/${fx.userId}`,
      headers: as(fx.userId),
      payload: { role: 'member' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('最后一位');
  });
});
