import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { events, users } from '@apos/db';
import { RuntimeRegistry } from '@apos/agent-runtimes';
import { buildApp } from '../app';
import { EventBus } from '../modules/event/bus';
import { StubPlanningProvider } from '../modules/planning/stub-provider';
import { hashPassword } from '../modules/auth';
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
 * ★ 账号只有两个来源：超管来自 .env（bootstrap），其余由组织管理员创建。
 *   **没有自助注册** —— 组织边界就是多租户边界，能自助注册等于
 *   任何人都能把自己放进那条边界里。
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
