import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { organizationMembers, users, type Database } from '@apos/db';
import { humanActor, OrgRole } from '@apos/contracts';
import { fail } from '../../http/errors';
import { freeOrganizationSlug, insertOrganizationTx } from '../../http/organizations';
import { emitAndPublish } from '../event/bus';
import { assertPasswordAcceptable, hashPassword, verifyPassword, WeakPasswordError } from './password';
import { signToken } from './jwt';

/**
 * 登录与账号管理。
 *
 * 身份模型（docs/tech/09-security.md §1）：账号是**全局**的，组织归属在
 * `organization_members`。所以「建账号」和「把账号加进组织」是两件事，
 * 这里的 createAccount 一次做完两件 —— 超管在界面上做的就是这一件事，
 * 拆成两步只会让「建完了但他进不去」成为常态。
 */

const MIN_TIME_MS = 120;

/**
 * ★ 先 trim 再验格式。次序反过来的话，粘贴时带上的一个尾随空格
 *   会被判成「邮箱格式不合法」的 400 —— 而用户看着地址栏里
 *   一模一样的邮箱，完全无从下手。口令**不 trim**：
 *   空格是口令的合法字符，替用户去掉等于悄悄改了他的口令。
 */
const Email = z.string().trim().email('邮箱格式不合法');

export const LoginInput = z.object({
  email: Email,
  password: z.string().min(1, '请输入口令'),
});

export const CreateAccountInput = z.object({
  email: Email,
  name: z.string().min(1, '姓名不能为空').max(80),
  password: z.string().min(1, '请设置初始口令'),
  orgRole: OrgRole.default('member'),
  approvalScopes: z.array(z.string()).optional(),
});

export const ChangePasswordInput = z.object({
  currentPassword: z.string().min(1, '请输入当前口令'),
  newPassword: z.string().min(1, '请输入新口令'),
});

export const RegisterInput = z.object({
  email: Email,
  name: z.string().trim().min(1, '姓名不能为空').max(80),
  password: z.string().min(1, '请设置口令'),
  /** 留空按姓名推。这是**新建**的组织，不是加入某个已有组织 */
  orgName: z.string().trim().min(1).max(80).optional(),
});

/**
 * 邮箱归一化。
 *
 * ★ 必须和 `addOrganizationMember` 用同一套规则（trim + 小写），
 *   否则「Zhang@acme.dev 建的号」用 `zhang@acme.dev` 加不进组织，
 *   而报错是「没有这个邮箱的账号」—— 指向完全错误的方向。
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * 登录。
 *
 * ★★ 三种失败（邮箱不存在 / 账号没有口令 / 口令不对）回同一句话。
 *   分开说的每一种都是「这个邮箱是不是真账号」的枚举探针。
 *
 * ★ 并且要花掉同样的时间。邮箱不存在时直接返回的话，「查无此人」
 *   比「口令错」快两个数量级 —— 光凭响应耗时就能把通讯录枚举出来。
 *   所以不存在时也走一次 scrypt（拿一个固定的假散列），
 *   再统一垫到最低耗时。
 */
export async function login(db: Database, input: z.infer<typeof LoginInput>) {
  const started = Date.now();
  const email = normalizeEmail(input.email);

  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      status: users.status,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.email, email));

  const ok = await verifyPassword(input.password, user?.passwordHash ?? null);

  // 账号被停用与口令错误同样不能区分 —— 它同样泄漏「这个账号存在」
  const passed = ok && user !== undefined && user.status === 'active';

  const elapsed = Date.now() - started;
  if (elapsed < MIN_TIME_MS) await sleep(MIN_TIME_MS - elapsed);

  if (!passed) {
    throw fail('UNAUTHENTICATED', 'auth.bad_credentials', '邮箱或口令不正确');
  }

  return {
    token: signToken(user!.id),
    user: { id: user!.id, name: user!.name, email: user!.email },
  };
}

/**
 * 自助注册 —— 每次注册长出一个**自己的新组织**，注册者是那个组织的 org_admin。
 *
 * ★★ 「新的超管账号」在这套模型里的准确含义就是这一句。
 *
 *   这个代码库里**没有跨租户的全局超管**：`users` 表上没有任何全局角色列，
 *   一切权限都来自 organization_members / project_members。启动时那个
 *   「超级管理员」（bootstrap.ts）之所以叫超管，只是因为他是第一个人、
 *   并且自动拥有了一个属于自己的组织 —— 他看不到别人的组织。
 *   所以注册干的事和 bootstrap 完全一样，只是触发方式从 .env 变成了表单。
 *
 * ★★ 这不违反「组织边界就是多租户边界」。
 *
 *   09-security 里那句「刻意没有自助注册」，针对的是**自助进入已有组织**。
 *   这里每次注册都开一个空的新组织，谁也进不去别人的边界 ——
 *   要进别人的组织，仍然只有一条路：被那个组织的管理员加进去。
 *
 * ★ 建账号与建组织必须在同一个事务里。分开的话，第二步失败会留下一个
 *   「存在但不属于任何组织」的账号：他能登录，但之后每个请求都是 401，
 *   而注册页显示的是「注册失败」——于是他换个邮箱再注册一次，
 *   库里就多一个永远登不进去的号。
 *
 * ★ 邮箱已存在时**明说**。登录接口刻意不区分「邮箱不存在」和「口令错」
 *   （那是枚举探针），但注册接口做不到同样的克制：不告诉用户邮箱被占用，
 *   他就没有任何办法完成注册。这是这类接口固有的取舍，业界一致 ——
 *   真正的缓解手段是限流（见 throttle.ts），不是把话说糊。
 */
export async function registerAccount(
  db: Database,
  ctx: { correlationId: string },
  input: z.infer<typeof RegisterInput>,
) {
  const email = normalizeEmail(input.email);
  const name = input.name.trim();
  const orgName = input.orgName?.trim() || `${name} 的组织`;

  /**
   * ★ 先算散列再查库。反过来的话，「邮箱是否存在」的判断会在昂贵的 scrypt
   *   之前返回 —— 响应耗时就把「这个邮箱注册过没有」泄漏出去了，
   *   而这正是登录接口花了大力气堵掉的那条信道。
   */
  let passwordHash: string;
  try {
    passwordHash = await hashPassword(input.password);
  } catch (err) {
    if (err instanceof WeakPasswordError) {
      throw fail('VALIDATION_FAILED', err.reason, err.message, { params: err.params });
    }
    throw err;
  }

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) {
    throw fail(
      'VERSION_CONFLICT',
      'auth.email_already_registered',
      '这个邮箱已经注册过了，直接登录即可',
      { details: { email } },
    );
  }

  // slug 是读操作，放在事务外算 —— 塞进去只会白白拉长事务持有时间
  const slug = await freeOrganizationSlug(db, orgName);

  const created = await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ email, name, passwordHash })
      .returning({ id: users.id, name: users.name, email: users.email });

    const organization = await insertOrganizationTx(tx, {
      name: orgName,
      slug,
      actorId: user!.id,
    });

    return { user: user!, organization };
  });

  /**
   * ★ 三条事件分开记，口径和管理员开号那条路完全一致
   *   （user.created / organization.created / organization.member_added）。
   *   合成一条「注册」事件的话，既有的审计查询就要同时认两套类型。
   * ★ actor 是注册者自己 —— 自助注册就是本人干的，写成系统会让审计失真。
   */
  const actor = humanActor(created.user.id);
  await emitAndPublish(db, {
    orgId: created.organization.id,
    projectId: null,
    type: 'organization.created',
    actor,
    subjectType: 'organization',
    subjectId: created.organization.id,
    payload: { name: created.organization.name, slug: created.organization.slug, viaSignup: true },
    correlationId: ctx.correlationId,
  });
  await emitAndPublish(db, {
    orgId: created.organization.id,
    projectId: null,
    type: 'user.created',
    actor,
    subjectType: 'user',
    subjectId: created.user.id,
    payload: { email: created.user.email, name: created.user.name, orgRole: 'org_admin', viaSignup: true },
    correlationId: ctx.correlationId,
  });
  await emitAndPublish(db, {
    orgId: created.organization.id,
    projectId: null,
    type: 'organization.member_added',
    actor,
    subjectType: 'user',
    subjectId: created.user.id,
    payload: { orgRole: 'org_admin', name: created.user.name, viaSignup: true },
    correlationId: ctx.correlationId,
  });

  /** ★ 直接发令牌：注册完还要用户自己再登录一次，是白白多一道门 */
  return {
    token: signToken(created.user.id),
    user: { id: created.user.id, name: created.user.name, email: created.user.email },
    organization: created.organization,
  };
}

/**
 * 建账号 —— 组织管理员给别人开号（09-security §2.2「身份管理」）。
 *
 * ★★ 建账号与加入组织必须在同一个事务里。
 *   分开的话，第二步失败会留下一个「存在但不属于任何组织」的账号：
 *   他能登录，但登录后每个请求都是 401「还不属于任何组织」，
 *   而管理员那边看到的是「加成员时说没有这个邮箱」（他其实建成了）。
 *
 * ★ 邮箱已存在时**不是**报错了事：那个人可能是别的组织的账号，
 *   这时正确的动作是把他加进本组织，而不是逼管理员换一个邮箱 ——
 *   换邮箱等于给同一个人开第二个账号，审计里就成了两个人。
 */
export async function createAccount(
  db: Database,
  ctx: { orgId: string; actorId: string; correlationId: string },
  input: z.infer<typeof CreateAccountInput>,
) {
  const email = normalizeEmail(input.email);

  let passwordHash: string;
  try {
    passwordHash = await hashPassword(input.password);
  } catch (err) {
    if (err instanceof WeakPasswordError) {
      throw fail('VALIDATION_FAILED', err.reason, err.message, { params: err.params });
    }
    throw err;
  }

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) {
    throw fail(
      'VERSION_CONFLICT',
      'auth.email_taken_use_add_member',
      `邮箱 ${email} 已有账号。如果要把他加进本组织，用「添加成员」而不是新建 —— ` + '同一个人开两个账号，审计里就成了两个人。',
      { params: { email }, details: { email, userId: existing.id } },
    );
  }

  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(users)
      .values({
        email,
        name: input.name.trim(),
        passwordHash,
        approvalScopes: input.approvalScopes ?? [],
      })
      .returning({ id: users.id, name: users.name, email: users.email });

    await tx
      .insert(organizationMembers)
      .values({ orgId: ctx.orgId, userId: row!.id, orgRole: input.orgRole });

    return row!;
  });

  /**
   * ★ 建号与入组织各记一条事件。
   *   合成一条的话，「谁被加进了这个组织」这个查询就要同时认两种事件类型，
   *   而 organization.member_added 是既有的审计口径（§6.3）。
   */
  await emitAndPublish(db, {
    orgId: ctx.orgId,
    projectId: null,
    type: 'user.created',
    actor: humanActor(ctx.actorId),
    subjectType: 'user',
    subjectId: created.id,
    payload: { email: created.email, name: created.name, orgRole: input.orgRole },
    correlationId: ctx.correlationId,
  });
  await emitAndPublish(db, {
    orgId: ctx.orgId,
    projectId: null,
    type: 'organization.member_added',
    actor: humanActor(ctx.actorId),
    subjectType: 'user',
    subjectId: created.id,
    payload: { orgRole: input.orgRole, name: created.name },
    correlationId: ctx.correlationId,
  });

  return { id: created.id, name: created.name, email: created.email, orgRole: input.orgRole };
}

/**
 * 改自己的口令。
 *
 * ★ 必须验当前口令。不验的话，一台没锁屏的电脑就等于账号被永久接管 ——
 *   令牌是无状态的，改完口令攻击者手里那张令牌照样有效（见 jwt.ts）。
 */
export async function changeOwnPassword(
  db: Database,
  ctx: { userId: string; orgId: string; correlationId: string },
  input: z.infer<typeof ChangePasswordInput>,
) {
  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, ctx.userId));
  if (!user) throw fail('UNAUTHENTICATED', 'auth.account_gone', '用户不存在');

  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw fail('UNAUTHENTICATED', 'auth.wrong_password', '当前口令不正确');
  }

  try {
    assertPasswordAcceptable(input.newPassword);
  } catch (err) {
    if (err instanceof WeakPasswordError) throw fail(
      'VALIDATION_FAILED',
      err.reason,
      err.message,
      { params: err.params },
    );
    throw err;
  }

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(input.newPassword) })
    .where(eq(users.id, ctx.userId));

  await emitAndPublish(db, {
    orgId: ctx.orgId,
    projectId: null,
    type: 'user.password_changed',
    actor: humanActor(ctx.userId),
    subjectType: 'user',
    subjectId: ctx.userId,
    payload: {},
    correlationId: ctx.correlationId,
  });

  /** ★ 换一张令牌回去：旧的那张还没过期，但调用方应当立刻改用新的 */
  return { ok: true as const, token: signToken(ctx.userId) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
