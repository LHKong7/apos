import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { events, organizationMembers, users } from '@apos/db';
import { RuntimeRegistry } from '@apos/agent-runtimes';
import { buildApp } from '../app';
import { EventBus } from '../modules/event/bus';
import { StubPlanningProvider } from '../modules/planning/stub-provider';
import {
  assertSignupAllowed,
  bootstrapSuperadmin,
  hashPassword,
  resetSignupThrottle,
  signupEnabled,
  signupSwitch,
} from '../modules/auth';
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
 * Login and account creation (docs/tech/09-security.md §1.3) / 登录与开账号。
 *
 * ★★ This layer did not exist at all before: identity was an `X-User-Id` header with
 *   no credential whatsoever — put someone's uuid in it and you were them. The whole
 *   RBAC system was built on top of that and was therefore equally decorative, and
 *   nothing in the endpoint listing gave the slightest hint of it.
 *
 * ★ Accounts come from exactly three places: the superadmin from .env (bootstrap),
 *   accounts an org admin opens, and self-service signup. None of the three ever puts
 *   somebody into **someone else's** organization — signup creates a new empty org,
 *   and getting into an existing one still means an admin adds you. The organization
 *   boundary *is* the tenancy boundary, and the "self-service signup" cases below
 *   are what guard that line.
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
  // The fixture identity is inserted directly and has no password — the login cases
  // have to supply one themselves
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
   * ★★ The three failures must be **indistinguishable**.
   *
   *   The moment "no account for this email" answers differently from "wrong
   *   password", the login endpoint becomes a directory-enumeration probe: run a list
   *   of addresses through it and out come the ones that are real accounts at this
   *   company. That is step one of a credential-stuffing run.
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
 * ★★ A stale X-Org-Id must not lock the frontend out.
 *
 *   The browser remembers the last organization it was on (apos.orgId in
 *   localStorage) and sends it right back. That org may have been deleted, this
 *   person may have been removed from it, or the whole database may have been rebuilt.
 *   Strictly evaluated that is a 404 — and a 404 here deadlocks: /organizations fails
 *   → the stale id never gets a chance to be corrected → the next request carries it
 *   again. The symptom is a successful login onto a completely blank site, which
 *   logging out and back in does not fix.
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
   * ★★ This leniency is granted to `/auth/me` **only**, not even to
   *   `/organizations`. Anywhere else a wrong org id must still be a 404 — that is
   *   both the tenancy boundary itself (the entire `assertCurrentOrg` defense rests
   *   on it) and the layer that declines to confirm whether an organization exists.
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

    // Already a member of this org — otherwise every request after their login is a
    // 401 "not a member of any organization"
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${res.json().token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().currentOrgId).toBe(fx.orgId);
  });

  /**
   * ★★ This is the whole reason these endpoints exist: an account is being let in
   *   from **outside the boundary**, so the bar to let it through has to be org admin.
   *   If a plain member could open accounts, any member at all could hand an outsider
   *   a ticket into this tenant.
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
   * ★ A duplicate email must not open a second account: one person with two accounts
   *   is two people as far as the audit trail is concerned, and questions like "who
   *   approved this" are then permanently missing half their answer.
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
   * ★★ Creating an account is step zero of any privilege-escalation path — before it,
   *   that person did not exist. If "who opened an account for whom" cannot be looked
   *   up, the escalation chain is broken from its very first link (§6.3).
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
 * Self-service signup (docs/tech/09-security.md §1) / 自助注册。
 *
 * ★★ The line these cases hold: signup grows a **new empty organization**, never
 *   "put myself into an existing one". The latter is precisely what "the organization
 *   boundary is the tenancy boundary" exists to prevent, and these cases are what
 *   stop someone from later "optimizing" signup into it.
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

    // The token works immediately, and the current org is the one just created
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().currentOrgId).toBe(organization.id);
    // ★ org_admin inside their own organization — in this model that single fact is
    //   what "a new superadmin account" means
    expect(me.json().orgRole).toBe('org_admin');
  });

  /**
   * ★★ Signup **must not** make anyone else's organization visible.
   *
   *   Break this line and self-service signup really does become a hole in the tenancy
   *   boundary — which is exactly why 09-security rejected it in the first place.
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

    // The fixture project belongs to someone else's organization; out of reach
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
   * ★ Unlike login, signup **has to** say plainly that the email is taken — without
   *   that the user has no way to complete signup at all. The trade-off is inherent to
   *   this kind of endpoint; the mitigation is rate limiting, not vaguer wording.
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
   * ★★ Creating the user and creating the organization live or die together.
   *
   *   Split across two transactions, a failure in the second step leaves an account
   *   that can log in but belongs to no organization — every subsequent request is a
   *   401, while the signup page told them signup had failed.
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

/**
 * The signup master switch (`APOS_ALLOW_SIGNUP`) / 注册总开关。
 *
 * ★ On by default — the signup cases above pass without setting a single environment
 *   variable, which is itself the assertion about that default.
 */
describe('注册开关', () => {
  const KEY = 'APOS_ALLOW_SIGNUP';
  const before = process.env[KEY];

  beforeEach(() => resetSignupThrottle());
  afterEach(() => {
    if (before === undefined) delete process.env[KEY];
    else process.env[KEY] = before;
  });

  const register = () =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'gated@x.dev', name: '被开关挡住的', password: 'gated-password' },
    });

  it('关掉之后注册被拒，且不留下账号', async () => {
    process.env[KEY] = 'false';
    const res = await register();
    expect(res.statusCode).toBe(403);

    const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, 'gated@x.dev'));
    expect(rows).toHaveLength(0);
  });

  it('/auth/config 如实回答，且无需身份', async () => {
    const on = await app.inject({ method: 'GET', url: '/api/v1/auth/config' });
    expect(on.statusCode).toBe(200);
    expect(on.json().allowSignup).toBe(true);

    process.env[KEY] = 'off';
    const off = await app.inject({ method: 'GET', url: '/api/v1/auth/config' });
    expect(off.json().allowSignup).toBe(false);
  });

  it('几种写法都认', () => {
    for (const v of ['1', 'true', 'YES', 'on', 'enabled']) {
      process.env[KEY] = v;
      expect(signupEnabled(), v).toBe(true);
    }
    for (const v of ['0', 'false', 'NO', 'off', 'disabled']) {
      process.env[KEY] = v;
      expect(signupEnabled(), v).toBe(false);
    }
  });

  /**
   * ★★ An unrecognized value is treated as **off**.
   *
   *   This is a security switch, and the two failure modes cost wildly different
   *   amounts. Read `flase` as on and an operator who meant to close signup has left
   *   it open with no sign anywhere. Read `ture` as off and the symptom is "the signup
   *   button is gone", which somebody reports within the hour. Better to err closed.
   */
  it('★ 拼错的取值按关闭处理，而不是按开启', () => {
    process.env[KEY] = 'flase';
    const s = signupSwitch();
    expect(s.enabled).toBe(false);
    expect(s.reason).toContain('认不出来');
  });

  it('没配置时默认开启', () => {
    delete process.env[KEY];
    expect(signupEnabled()).toBe(true);
  });
});

describe('注册限流', () => {
  beforeEach(() => resetSignupThrottle());

  /**
   * ★ Unauthenticated, runs scrypt on every call, and writes four tables. With no gate
   *   in front of it a single buggy script pins the CPU — no malice required.
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
   * ★★ This stream used to have no authentication at all: guess the channel name and
   *   you received every event that project pushed in real time — status transitions,
   *   decisions, Run output. Reading the same data over REST goes through the
   *   membership gate; this route walked straight around it.
   */
  it('★ 未登录连不上事件流', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/stream?channels=project:${fx.projectId}:board`,
    });
    expect(res.statusCode).toBe(401);
  });
});

/**
 * Superadmin bootstrap (09-security §1.3) / 超管自举。
 *
 * ★★ This whole block had no tests at all — and it is the **only** path a first-time
 *   deployment takes. So the correlationId in `ensureSuperadminOrg` that could not fit
 *   the uuid column survived: `pnpm test` was green while the instance from
 *   `docker compose up` could not create the superadmin's organization, and every
 *   request after login came back 401 "not a member of any organization yet".
 *
 *   ★ Only actually running the bootstrap catches it. That is also why it slipped
 *     through in the first place: every other case inserts data via seedFixture and
 *     bypasses this path entirely.
 */
describe('超管自举', () => {
  const KEYS = ['APOS_SUPERADMIN_EMAIL', 'APOS_SUPERADMIN_PASSWORD', 'APOS_SUPERADMIN_ORG'] as const;
  const before = KEYS.map((k) => [k, process.env[k]] as const);

  afterEach(() => {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('★ 从 .env 长出超管，并且真的把组织建出来', async () => {
    process.env['APOS_SUPERADMIN_EMAIL'] = 'boot@example.com';
    process.env['APOS_SUPERADMIN_PASSWORD'] = 'bootstrap-password-1';
    process.env['APOS_SUPERADMIN_ORG'] = '自举出来的组织';

    const result = await bootstrapSuperadmin(db, () => {});

    expect(result.created).toBe(true);
    /**
     * ★ This is the load-bearing assertion. If the account is created but the org is
     *   not, the person can log in to a completely empty site — and created:true makes
     *   it look as though the bootstrap succeeded.
     */
    expect(result.orgCreated).toBe(true);

    const [membership] = await db
      .select({ orgId: organizationMembers.orgId, role: organizationMembers.orgRole })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, result.userId!));
    expect(membership?.role).toBe('org_admin');

    // The event written alongside the org creation has to actually land — a
    // correlationId that will not fit the uuid column blows up right here
    const [row] = await db
      .select({ correlationId: events.correlationId })
      .from(events)
      .where(eq(events.orgId, membership!.orgId));
    expect(row?.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  /**
   * ★ Idempotent, and it **never overwrites a password that was changed** — otherwise
   *   the initial password in .env becomes a backdoor nobody can close (see the top of
   *   bootstrap.ts).
   */
  it('重复自举不再建号建组织，也不重置口令', async () => {
    process.env['APOS_SUPERADMIN_EMAIL'] = 'boot@example.com';
    process.env['APOS_SUPERADMIN_PASSWORD'] = 'bootstrap-password-1';

    const first = await bootstrapSuperadmin(db, () => {});
    expect(first.created).toBe(true);

    // The user changed their password
    const changed = await hashPassword('user-changed-password-9');
    await db.update(users).set({ passwordHash: changed }).where(eq(users.id, first.userId!));

    const second = await bootstrapSuperadmin(db, () => {});
    expect(second.created).toBe(false);
    expect(second.orgCreated).toBe(false);
    expect(second.userId).toBe(first.userId);

    const [row] = await db
      .select({ hash: users.passwordHash })
      .from(users)
      .where(eq(users.id, first.userId!));
    expect(row?.hash).toBe(changed);
  });
});
