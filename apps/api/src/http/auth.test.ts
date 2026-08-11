import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { events, organizationMembers, users } from '@apos/db';
import { RuntimeRegistry } from '@apos/agent-runtimes';
import { buildApp } from '../app';
import { EventBus } from '../modules/event/bus';
import { StubPlanningProvider } from '../modules/planning/stub-provider';
import { assertSignupAllowed, hashPassword, resetSignupThrottle } from '../modules/auth';
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
 * 登录与开账号（docs/tech/09-security.md §1.3）。
 *
 * ★★ 这一层此前根本不存在：身份就是一个 `X-User-Id` 头，没有任何凭证，
 *   写上谁的 uuid 就是谁。整套 RBAC 建在它之上，因而也全是摆设 ——
 *   而接口清单上完全看不出这件事。
 *
 * ★ 账号有三个来源：超管来自 .env（bootstrap）、组织管理员开的号、
 *   以及自助注册。三条路都不会把人放进**别人的**组织 ——
 *   注册开的是一个空的新组织，要进别人的组织仍然只有「被管理员加进去」。
 *   组织边界就是多租户边界，这条线由下面「自助注册」那组用例守着。
 */

const db = testDb();
let app: FastifyInstance;
let fx: Fixture;

const PASSWORD = 'seed-password-1';

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
  // 夹具身份是直插的，没有口令 —— 登录相关的用例要自己补上
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(PASSWORD) })
    .where(eq(users.id, fx.userId));
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await resetDb(db);
});

const login = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/login', payload });

async function emailOf(userId: string): Promise<string> {
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  return row!.email;
}

describe('登录', () => {
  it('邮箱与口令正确时换到一张能用的令牌', async () => {
    const res = await login({ email: await emailOf(fx.userId), password: PASSWORD });
    expect(res.statusCode).toBe(200);

    const { token, user } = res.json();
    expect(user.id).toBe(fx.userId);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.id).toBe(fx.userId);
    expect(me.json().currentOrgId).toBe(fx.orgId);
  });

  it('邮箱大小写与首尾空格不影响登录', async () => {
    const email = await emailOf(fx.userId);
    const res = await login({ email: `  ${email.toUpperCase()}  `, password: PASSWORD });
    expect(res.statusCode).toBe(200);
  });

  /**
   * ★★ 三种失败必须**无法区分**。
   *
   *   「这个邮箱没有账号」和「口令不对」一旦回不同的话，
   *   登录接口就成了一个通讯录枚举探针：拿一份邮箱列表跑一遍，
   *   哪些是这家公司的真账号就出来了。而那正是撞库的第一步。
   */
  it('★ 账号不存在、没有口令、口令错误回同一句话', async () => {
    const noPassword = await createMember(db, fx, { name: '没设口令的人' });
    const messages = new Set<string>();
    const codes = new Set<number>();

    for (const payload of [
      { email: 'nobody@nowhere.dev', password: PASSWORD },
      { email: await emailOf(noPassword), password: PASSWORD },
      { email: await emailOf(fx.userId), password: '完全不对的口令' },
    ]) {
      const res = await login(payload);
      codes.add(res.statusCode);
      messages.add(res.json().error.message);
    }

    expect([...codes]).toEqual([401]);
    expect(messages.size, `实际回了 ${messages.size} 种说法：${[...messages].join(' / ')}`).toBe(1);
  });

  it('停用的账号登不进来', async () => {
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, fx.userId));
    const res = await login({ email: await emailOf(fx.userId), password: PASSWORD });
    expect(res.statusCode).toBe(401);
  });
});

/**
 * ★★ 陈旧的 X-Org-Id 不能把前端锁死。
 *
 *   浏览器一直记着上次选的组织（localStorage 的 apos.orgId）并原样带回来。
 *   那个组织可能已经被删、这个人可能已被移出、或者整个库被重建过。
 *   严格判定下这是 404 —— 而 404 会形成死锁：
 *   /organizations 拿不到 → 陈旧 id 没机会被纠正 → 下一个请求还带着它。
 *   表现是登录成功但整站空白，且退出重登也没用。
 */
describe('陈旧的当前组织', () => {
  const GONE = '00000000-0000-4000-8000-000000000000';

  it('★ /auth/me 照常回答，并给出真实的 currentOrgId 让前端自我纠正', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { ...auth(fx.userId), 'x-org-id': GONE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().currentOrgId).toBe(fx.orgId);
  });

  /**
   * ★★ 这条宽容**只**给 `/auth/me`，连 `/organizations` 都不给。
   *   别处带错组织必须仍然是 404 —— 那既是多租户边界本身
   *   （`assertCurrentOrg` 整条防线都建立在它上面），
   *   也是「不确认这个组织存在」的那一层。
   */
  it('★ 其余端点带错组织仍然被拒', async () => {
    for (const url of ['/api/v1/projects', '/api/v1/organizations', '/api/v1/users']) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { ...auth(fx.userId), 'x-org-id': GONE },
      });
      expect(res.statusCode, url).toBe(404);
    }
  });
});

describe('开账号', () => {
  const newAccount = {
    email: 'xinren@acme.dev',
    name: '新人',
    password: 'another-password-1',
  };

  it('管理员建的账号可以直接登录，并且已经在本组织里', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: auth(fx.userId),
      payload: newAccount,
    });
    expect(created.statusCode).toBe(201);

    const res = await login({ email: newAccount.email, password: newAccount.password });
    expect(res.statusCode).toBe(200);

    // 已经属于本组织 —— 否则他登录后每个请求都是 401「不属于任何组织」
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${res.json().token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().currentOrgId).toBe(fx.orgId);
  });

  /**
   * ★★ 这是这组端点存在的全部意义：账号是从**边界外**放进来的，
   *   放行的门槛必须是组织管理员。普通成员能开账号的话，
   *   任何一个成员都能给外面的人发一张进入这个租户的门票。
   */
  it('★ 普通成员开不了账号', async () => {
    const plain = await createMember(db, fx, { orgRole: 'member' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: auth(plain),
      payload: newAccount,
    });
    expect(res.statusCode).toBe(403);

    const [row] = await db.select().from(users).where(eq(users.email, newAccount.email));
    expect(row, '被拒之后不该留下账号').toBeUndefined();
  });

  it('未登录开不了账号', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      payload: newAccount,
    });
    expect(res.statusCode).toBe(401);
  });

  /**
   * ★ 邮箱已存在时不能再开一个号：同一个人两个账号，审计里就是两个人，
   *   而「谁批准的」这类问题会永远差一半答案。
   */
  it('★ 邮箱重复时拒绝，并指向「添加成员」', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: auth(fx.userId),
      payload: { ...newAccount, email: await emailOf(fx.userId) },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('添加成员');
  });

  it('口令太短时拒绝，且不留下账号', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: auth(fx.userId),
      payload: { ...newAccount, password: 'short' },
    });
    expect(res.statusCode).toBe(400);

    const [row] = await db.select().from(users).where(eq(users.email, newAccount.email));
    expect(row).toBeUndefined();
  });

  /**
   * ★★ 建账号是提权路径的第零步 —— 在此之前那个人还不存在。
   *   查不到「谁给谁开的号」，整条提权链从一开始就断了（§6.3）。
   */
  it('★ 建账号留下审计事件', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: auth(fx.userId),
      payload: newAccount,
    });

    const rows = await db.select().from(events).where(eq(events.type, 'user.created'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorId).toBe(fx.userId);
    expect((rows[0]!.payload as { email: string }).email).toBe(newAccount.email);
  });
});

describe('改口令', () => {
  it('验过当前口令才能改，改完能用新口令登录', async () => {
    const email = await emailOf(fx.userId);

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: auth(fx.userId),
      payload: { currentPassword: '不是当前口令', newPassword: 'brand-new-password' },
    });
    expect(wrong.statusCode).toBe(401);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: auth(fx.userId),
      payload: { currentPassword: PASSWORD, newPassword: 'brand-new-password' },
    });
    expect(ok.statusCode).toBe(200);

    expect((await login({ email, password: 'brand-new-password' })).statusCode).toBe(200);
    expect((await login({ email, password: PASSWORD })).statusCode).toBe(401);
  });
});

/**
 * 自助注册（docs/tech/09-security.md §1）。
 *
 * ★★ 这里要守住的那条线：注册长出的是一个**新的空组织**，
 *   不是「把自己放进某个已有组织」。后者才是「组织边界就是多租户边界」
 *   要防的东西，而且这几条用例就是防止有人日后把它「优化」成后者。
 */
describe('自助注册', () => {
  const register = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/register', payload });

  beforeEach(() => resetSignupThrottle());

  it('注册即建号 + 建自己的组织，并直接拿到能用的令牌', async () => {
    const res = await register({
      email: 'newcomer@acme.dev',
      name: '新来的',
      password: 'a-fresh-password',
    });
    expect(res.statusCode).toBe(200);

    const { token, user, organization } = res.json();
    expect(user.email).toBe('newcomer@acme.dev');
    expect(organization.id).toBeTruthy();

    // 令牌当场可用，且当前组织就是刚建的那个
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().currentOrgId).toBe(organization.id);
    // ★ 在自己的组织里是 org_admin —— 「新的超管账号」在这套模型里就是这一句
    expect(me.json().orgRole).toBe('org_admin');
  });

  /**
   * ★★ 注册**不能**让人看见别人的组织。
   *
   *   这条线一旦破了，「自助注册」就真的变成了多租户边界的缺口 ——
   *   而那正是 09-security 当初拒绝它的理由。
   */
  it('★ 新注册的人看不到别人的组织与项目', async () => {
    const res = await register({
      email: 'stranger@elsewhere.dev',
      name: '陌生人',
      password: 'another-password',
    });
    const { token, organization } = res.json();
    const headers = { authorization: `Bearer ${token}` };

    const orgs = await app.inject({ method: 'GET', url: '/api/v1/organizations', headers });
    expect(orgs.statusCode).toBe(200);
    const ids = orgs.json().organizations.map((o: { id: string }) => o.id);
    expect(ids).toEqual([organization.id]);
    expect(ids).not.toContain(fx.orgId);

    // 夹具那个项目属于别人的组织，够不着
    const board = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}/board`,
      headers,
    });
    expect([401, 403, 404]).toContain(board.statusCode);
  });

  it('组织名留空时按姓名推，且两个同名的人不会撞 slug', async () => {
    const a = await register({ email: 'a@x.dev', name: '张三', password: 'password-one' });
    const b = await register({ email: 'b@x.dev', name: '张三', password: 'password-two' });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json().organization.slug).not.toBe(b.json().organization.slug);
  });

  it('可以自己指定组织名', async () => {
    const res = await register({
      email: 'founder@startup.dev',
      name: '创始人',
      password: 'startup-password',
      orgName: 'Startup 科技',
    });
    expect(res.json().organization.name).toBe('Startup 科技');
  });

  /**
   * ★ 和登录接口不同，注册**必须**说清楚邮箱被占用了 ——
   *   不说的话用户没有任何办法完成注册。这是这类接口固有的取舍，
   *   缓解手段是限流而不是把话说糊。
   */
  it('邮箱已存在时明确拒绝，且不会重复建号', async () => {
    const email = await emailOf(fx.userId);
    const res = await register({ email, name: '冒名者', password: 'yet-another-password' });
    expect(res.statusCode).toBe(409);

    const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    expect(rows).toHaveLength(1);
  });

  it('弱口令被挡下，且没有留下半个账号', async () => {
    const res = await register({ email: 'weak@x.dev', name: '短口令', password: 'abc' });
    expect(res.statusCode).toBe(400);

    const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, 'weak@x.dev'));
    expect(rows).toHaveLength(0);
  });

  /**
   * ★★ 建号与建组织必须同生同死。
   *
   *   分成两个事务的话，第二步失败会留下一个「能登录但不属于任何组织」的
   *   账号 —— 他之后每个请求都是 401，而注册页显示的是「注册失败」。
   */
  it('★ 注册成功的人一定属于某个组织', async () => {
    const res = await register({ email: 'paired@x.dev', name: '成对的', password: 'paired-password' });
    const userId = res.json().user.id;

    const memberships = await db
      .select({ orgId: organizationMembers.orgId, orgRole: organizationMembers.orgRole })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, userId));
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.orgRole).toBe('org_admin');
  });

  it('注册会留下审计事件', async () => {
    const res = await register({ email: 'audited@x.dev', name: '被审计的', password: 'audit-password' });
    const orgId = res.json().organization.id;

    const rows = await db.select({ type: events.type }).from(events).where(eq(events.orgId, orgId));
    const types = rows.map((r) => r.type);
    expect(types).toContain('organization.created');
    expect(types).toContain('user.created');
    expect(types).toContain('organization.member_added');
  });
});

describe('注册限流', () => {
  beforeEach(() => resetSignupThrottle());

  /**
   * ★ 未鉴权 + 每次跑一遍 scrypt + 写四张表。没有闸的话，
   *   一个写错的脚本就能把 CPU 打满 —— 不需要有人恶意。
   */
  it('★ 同一来源短时间内反复注册会被挡下', async () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) assertSignupAllowed('203.0.113.7', now + i);
    expect(() => assertSignupAllowed('203.0.113.7', now + 10)).toThrow(/注册太频繁/);
  });

  it('换一个来源不受影响，窗口过后自动恢复', async () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) assertSignupAllowed('203.0.113.7', now + i);

    expect(() => assertSignupAllowed('198.51.100.4', now)).not.toThrow();
    expect(() => assertSignupAllowed('203.0.113.7', now + 11 * 60 * 1000)).not.toThrow();
  });
});

describe('SSE', () => {
  /**
   * ★★ 这条流此前完全不鉴权：猜到频道名就能拿到那个项目实时推送的
   *   全部事件 —— 状态流转、决策、Run 产出。REST 那边查同样的数据
   *   要过成员关系闸门，这里绕过去了。
   */
  it('★ 未登录连不上事件流', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/stream?channels=project:${fx.projectId}:board`,
    });
    expect(res.statusCode).toBe(401);
  });
});
