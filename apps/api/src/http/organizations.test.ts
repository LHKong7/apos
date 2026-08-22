import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  organizationMembers,
  organizations,
  projectMembers,
  projects,
  roles,
  users,
} from '@apos/db';
import { RuntimeRegistry } from '@apos/agent-runtimes';
import { buildApp } from '../app';
import { EventBus } from '../modules/event/bus';
import { StubPlanningProvider } from '../modules/planning/stub-provider';
import {
  auth,
  createMember,
  integrationRegistry,
  resetDb,
  seedFixture,
  testDb,
  type Fixture,
} from '../test/db';

/**
 * Organizations — the top-level container for every piece of data (Plane calls it a Workspace) /
 * 组织 —— 一切数据的顶层容器（Plane 里叫 Workspace）。
 *
 * ★★ Until now an organization was nothing but an `org_id` column: the table was there, the
 *   foreign keys were there, the multi-tenant checks were there — but no endpoint could create
 *   one, rename one, or switch between them. So "multi-tenant" held at the database layer only;
 *   as a product this was a single-tenant instance, and the endpoint list said nothing about it.
 *   在此之前组织只是一列 `org_id`：表在、外键在、多租户判定也在，
 *   但没有任何接口能创建、改名或切换它。于是「多租户」只在数据库层面成立，
 *   产品上是个单租户实例 —— 而这件事从接口清单上完全看不出来。
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

const as = (userId: string, orgId?: string) => ({
  ...auth(userId),
  ...(orgId ? { 'x-org-id': orgId } : {}),
});

const create = (payload: Record<string, unknown>, userId = fx.userId) =>
  app.inject({ method: 'POST', url: '/api/v1/organizations', headers: as(userId), payload });

describe('建组织', () => {
  it('创建者成为组织管理员，并且能立刻在里面建项目', async () => {
    const res = await create({ name: '新公司' });
    expect(res.statusCode).toBe(201);
    const orgId = res.json().organization.id;

    const [member] = await db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, orgId));
    expect(member!.orgRole).toBe('org_admin');

    const project = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: as(fx.userId, orgId),
      payload: { name: '第一个项目' },
    });
    expect(project.statusCode).toBe(201);
    expect(project.json().project.orgId).toBe(orgId);
  });

  /**
   * ★★ Without the built-in roles, **not one member can be added to any project** in this
   *   organization — project_members.role carries a foreign key onto roles(org_id, key), and
   *   what surfaces is a bare FK violation, which reads nothing like "the organization was
   *   created wrong".
   *   少了内置角色，这个组织里**一个成员都加不进任何项目** ——
   *   project_members.role 有指向 roles(org_id, key) 的外键，
   *   而报错是一句外键冲突，跟「组织建歪了」看不出关系。
   */
  it('★ 新组织预置内置角色 —— 否则成员一个都加不进去', async () => {
    const orgId = (await create({ name: '新公司' })).json().organization.id;

    const rows = await db.select().from(roles).where(eq(roles.orgId, orgId));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.key)).toEqual(expect.arrayContaining(['tech_lead', 'pm', 'member']));
    expect(rows.every((r) => r.builtin)).toBe(true);
  });

  it('slug 留空时从名字推，中文名回落到 org-xxxx', async () => {
    expect((await create({ name: 'Acme Rocket' })).json().organization.slug).toBe('acme-rocket');
    expect((await create({ name: '北京科技' })).json().organization.slug).toMatch(/^org(-\d+)?$/);
  });

  it('slug 撞车时自动编号，显式指定的撞车则拒绝', async () => {
    expect((await create({ name: 'Dup Co' })).json().organization.slug).toBe('dup-co');
    expect((await create({ name: 'Dup Co' })).json().organization.slug).toBe('dup-co-2');

    const explicit = await create({ name: '第三个', slug: 'dup-co' });
    expect(explicit.statusCode).toBe(409);
  });

  it('非法 slug 当场拒绝并说明规则', async () => {
    const res = await create({ name: 'X', slug: 'Not_Valid' });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain('小写字母');
  });
});

describe('账号属于多个组织', () => {
  /**
   * ★★ This is the entire reason for the change.
   *
   *   `users.org_id` used to weld an account to exactly one organization: to take part in a
   *   second one you had to register a second account — and in the audit trail those two
   *   accounts are two different people.
   *   这是这次改动的全部理由。在此之前 `users.org_id` 把账号和归属焊死成一对一：
   *   一个人要参与第二个组织只能再注册一个账号，而那两个账号在审计里是两个不同的人。
   */
  it('★ 同一个账号能同时属于两个组织，并在各自里有独立的组织角色', async () => {
    const second = (await create({ name: 'Second Co' })).json().organization.id;

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/organizations',
      headers: as(fx.userId),
    });
    const orgs = list.json().organizations as { id: string; orgRole: string }[];
    expect(orgs.map((o) => o.id).sort()).toEqual([fx.orgId, second].sort());
    expect(orgs.every((o) => o.orgRole === 'org_admin')).toBe(true);
  });

  it('★ 在 A 组织是管理员，在 B 组织可以只是普通成员', async () => {
    const plain = await createMember(db, fx, { projectRole: null, orgRole: 'member' });
    const second = (await create({ name: 'Second Co', slug: 'second-co' }, plain)).json()
      .organization.id;

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/organizations',
      headers: as(plain),
    });
    const byId = new Map(
      (list.json().organizations as { id: string; orgRole: string }[]).map((o) => [o.id, o.orgRole]),
    );
    expect(byId.get(fx.orgId)).toBe('member');
    expect(byId.get(second)).toBe('org_admin');
  });

  /**
   * ★★ A missing X-Org-Id must not be an error.
   *
   *   Old clients, curl scripts, and the first page load after a seed all arrive without it, and
   *   answering 400 there shows up as "the entire site is a blank screen".
   *   没带 X-Org-Id 不能报错。老客户端、curl 脚本、seed 之后第一次打开的页面都不会带，
   *   而那时报 400 的表现是「整个站点白屏」。
   */
  it('★ 不带 X-Org-Id 时回落到确定的缺省，而不是报错', async () => {
    await create({ name: 'Second Co' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/organizations',
      headers: auth(fx.userId),
    });
    expect(res.statusCode).toBe(200);
    // Ordered by join time, so the fixture's organization comes first
    expect(res.json().currentOrgId).toBe(fx.orgId);
  });

  it('带了但不是成员 → 404，不确认这个组织存在', async () => {
    const [other] = await db
      .insert(organizations)
      .values({ name: '别人家', slug: `x-${randomUUID().slice(0, 8)}` })
      .returning();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/organizations',
      headers: as(fx.userId, other!.id),
    });
    expect(res.statusCode).toBe(404);
  });

  /**
   * ★★ After switching organizations you must be looking at that organization's data.
   *   If this does not hold, the switcher is decoration.
   *   切换组织之后看到的必须是那个组织的数据。这一条不成立的话，切换器就只是个装饰。
   */
  it('★ 切换组织后项目列表跟着换', async () => {
    const second = (await create({ name: 'Second Co' })).json().organization.id;
    await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: as(fx.userId, second),
      payload: { name: '另一个组织的项目' },
    });

    const inFirst = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: as(fx.userId, fx.orgId),
    });
    const inSecond = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: as(fx.userId, second),
    });

    expect(inFirst.json().projects.map((p: { name: string }) => p.name)).toEqual([
      '订单系统重构',
    ]);
    expect(inSecond.json().projects.map((p: { name: string }) => p.name)).toEqual([
      '另一个组织的项目',
    ]);
  });
});

describe('身份列表', () => {
  /**
   * ★★ An unauthenticated caller does not get the address book.
   *
   *   With no identity attached, this endpoint used to return **every user in the database** —
   *   a bootstrap hole left over from the X-User-Id era, when the identity switcher needed a
   *   list before anyone could be picked out of it. Once identity started coming from login the
   *   hole was no longer needed, and leaving it in place meant shipping an unauthenticated
   *   global address-book export: names and email addresses, across every tenant.
   *   未认证的调用者拿不到通讯录。这个端点此前在不带身份时返回**全库**用户 ——
   *   那是 X-User-Id 时代身份切换器的自举缺口（第一次打开时得先有一份名单才选得出人）。
   *   身份改由登录签发之后缺口不再需要，而它留在那里就是一个
   *   不需要认证的全局通讯录导出接口：姓名与邮箱，跨所有租户。
   */
  it('★ 未登录拿不到用户名单', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/users' });
    expect(res.statusCode).toBe(401);
    expect(res.json().users).toBeUndefined();
  });

  /**
   * ★ Someone who belongs to two organizations still appears exactly once — filter by the
   *   current organization instead of joining the whole membership table. The frontend keys on
   *   id, so a duplicate surfaces as a React duplicate-key warning plus a repeated dropdown row.
   *   一个人属于两个组织时，名单里也只该出现一次 —— 按当前组织过滤，
   *   而不是把归属表整个 join 出来。前端按 id 做 key，
   *   重复的表现是一句 React 重复 key 警告加一个重复的下拉项。
   */
  it('★ 属于多个组织的人在名单里只出现一次', async () => {
    await create({ name: 'Second Co' });

    const scoped = await app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: as(fx.userId),
    });
    const scopedIds = (scoped.json().users as { id: string }[]).map((u) => u.id);
    expect(scopedIds.filter((id) => id === fx.userId)).toHaveLength(1);
    expect(new Set(scopedIds).size).toBe(scopedIds.length);
  });

  it('带了身份时按**当前组织**给组织角色', async () => {
    const second = (await create({ name: 'Second Co' })).json().organization.id;
    const plain = await createMember(db, fx, { projectRole: null, orgRole: 'member' });
    await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${second}/members`,
      headers: as(fx.userId, second),
      payload: { email: (await db.select().from(users).where(eq(users.id, plain)))[0]!.email },
    });

    const inFirst = await app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: as(fx.userId, fx.orgId),
    });
    const rows = inFirst.json().users as { id: string; orgRole: string | null }[];
    expect(rows.find((u) => u.id === fx.userId)!.orgRole).toBe('org_admin');
  });
});

describe('组织成员', () => {
  const membersUrl = () => `/api/v1/organizations/${fx.orgId}/members`;

  it('按邮箱把已有账号加进来', async () => {
    const [outsiderUser] = await db
      .insert(users)
      .values({ email: `new-${randomUUID()}@acme.dev`, name: '新同事' })
      .returning();

    const res = await app.inject({
      method: 'POST',
      url: membersUrl(),
      headers: as(fx.userId),
      payload: { email: outsiderUser!.email, orgRole: 'member' },
    });
    expect(res.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: membersUrl(), headers: as(fx.userId) });
    expect(list.json().members.map((m: { name: string }) => m.name)).toContain('新同事');
  });

  it('邮箱查无此人时说清楚，而不是静默建一个账号', async () => {
    const res = await app.inject({
      method: 'POST',
      url: membersUrl(),
      headers: as(fx.userId),
      payload: { email: 'nobody@nowhere.dev' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.payload).toContain('已存在的账号');
  });

  /**
   * ★★ Locking yourself out is the most common way a permission system injures its own owner:
   *   once the last admin is gone, nobody can manage identities, define roles, or change
   *   organization-level policy — and getting it back takes direct surgery on the database.
   *   「把自己锁在门外」是权限系统最常见的自伤方式：
   *   移除最后一个管理员之后，没有人能管身份、定义角色、改组织级 Policy，
   *   而恢复它需要直接改数据库。
   */
  it('★ 不能移除最后一个组织管理员', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `${membersUrl()}/${fx.userId}`,
      headers: as(fx.userId),
    });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain('最后一个管理员');
  });

  it('★ 也不能把最后一个管理员降级', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${fx.userId}/org-role`,
      headers: as(fx.userId),
      payload: { orgRole: 'member' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain('最后一个管理员');
  });

  it('普通成员改不了组织成员', async () => {
    const plain = await createMember(db, fx, { projectRole: 'member', orgRole: 'member' });
    const res = await app.inject({
      method: 'POST',
      url: membersUrl(),
      headers: as(plain),
      payload: { email: 'someone@acme.dev' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('改与删', () => {
  it('管理员能改名和 slug', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${fx.orgId}`,
      headers: as(fx.userId),
      payload: { name: '改过的名字', slug: 'renamed-co' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().organization).toMatchObject({ name: '改过的名字', slug: 'renamed-co' });
  });

  /**
   * ★★ Sitting in organization A, where you are an admin, and firing a request that points at
   *   organization B — the permission check reads your role in A, so if the handler follows the
   *   URL and mutates B, that check bought nothing. This is the textbook privilege escalation.
   *   在自己是管理员的 A 组织里，发一个指向 B 组织的请求 ——
   *   权限判定拿的是 A 的角色，handler 如果照着 URL 去改 B，
   *   那次判定就白判了。这是最典型的一类越权。
   */
  it('★ 不能拿当前组织的管理员身份去改另一个组织', async () => {
    const second = (await create({ name: 'Second Co' })).json().organization.id;

    const res = await app.inject({
      method: 'PATCH',
      // Identity stays in the first organization while the URL points at the second
      url: `/api/v1/organizations/${second}`,
      headers: as(fx.userId, fx.orgId),
      payload: { name: '越权改名' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.payload).toContain('当前组织');
  });

  /**
   * ★★ An organization has projects, work items, agents, repositories, runs, and audit events
   *   hanging off it. Cascading the delete would wipe a whole tenant's history in one click —
   *   and the event stream is itself part of what gets wiped, so not even "who deleted it"
   *   survives.
   *   组织下面挂着项目、工作项、Agent、仓库、Run 与审计事件。
   *   级联删掉它们等于一次点击抹掉整个租户的历史，而且事件流本身
   *   也在里面 —— 连「谁删的」都留不下。
   */
  it('★ 还有项目时不许删，并说清楚为什么', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${fx.orgId}`,
      headers: as(fx.userId),
    });
    expect(res.statusCode).toBe(409);
    expect(res.payload).toContain('不可逆');
  });

  it('★ 不能删掉自己唯一的组织 —— 删完之后界面整个用不了', async () => {
    // Member rows carry a foreign key onto projects, so clear them first
    await db.delete(projectMembers).where(eq(projectMembers.orgId, fx.orgId));
    await db.delete(projects).where(eq(projects.orgId, fx.orgId));

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${fx.orgId}`,
      headers: as(fx.userId),
    });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain('唯一的组织');
  });

  it('空组织可以删', async () => {
    const second = (await create({ name: 'Second Co' })).json().organization.id;

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${second}`,
      headers: as(fx.userId, second),
    });
    expect(res.statusCode).toBe(200);
    expect(await db.select().from(organizations).where(eq(organizations.id, second))).toHaveLength(
      0,
    );
  });
});
