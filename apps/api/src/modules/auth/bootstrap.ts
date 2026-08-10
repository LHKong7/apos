import { count, eq, isNotNull } from 'drizzle-orm';
import { organizationMembers, users, type Database } from '@apos/db';
import { createOrganization } from '../../http/organizations';
import { hashPassword, WeakPasswordError } from './password';
import { normalizeEmail } from './service';

/**
 * 超级管理员的自举 —— 从 .env 长出第一个账号。
 *
 * ★★ 这是整套身份体系的**根**：账号只能由组织管理员创建（§2.2 身份管理），
 *   而第一个管理员没人能创建他。所以他必须来自代码与数据库之外的地方，
 *   也就是部署者手里的环境变量。
 *
 * ★ 幂等，而且**不覆盖已有口令**。每次启动都按 .env 重置口令的话，
 *   超管在界面上改完口令、重启一次就被打回去 —— 而且 .env 里那个
 *   初始口令会永远有效，等于一个改不掉的后门。
 *   所以 `APOS_SUPERADMIN_PASSWORD` 的语义是**初始**口令：
 *   只在建号（或账号还没有口令）时用一次。
 */

export interface BootstrapResult {
  /** 未配置环境变量时为 null —— 这不是错误，但会警告 */
  userId: string | null;
  created: boolean;
  orgCreated: boolean;
}

const DEFAULT_NAME = '超级管理员';

export async function bootstrapSuperadmin(
  db: Database,
  log: (message: string) => void = (m) => console.log(m),
): Promise<BootstrapResult> {
  const account = await ensureSuperadminAccount(db, log);
  if (!account.userId) return { userId: null, created: false, orgCreated: false };

  const orgCreated = await ensureSuperadminOrg(db, account.userId, log);
  return { ...account, orgCreated };
}

/**
 * 账号本身。组织归属不在这里 —— seed 要自己决定把超管放进哪个组织。
 */
export async function ensureSuperadminAccount(
  db: Database,
  log: (message: string) => void = (m) => console.log(m),
): Promise<{ userId: string | null; created: boolean }> {
  const rawEmail = process.env['APOS_SUPERADMIN_EMAIL'];
  const password = process.env['APOS_SUPERADMIN_PASSWORD'];
  const name = process.env['APOS_SUPERADMIN_NAME']?.trim() || DEFAULT_NAME;

  if (!rawEmail) {
    /**
     * ★ 库里已经有能登录的账号时，没配这个变量是正常的（超管已经建出来了，
     *   .env 里那两行可以撤掉）。一个能登录的账号都没有才是死局 ——
     *   那时必须把话说死，否则表现是登录页反复报「邮箱或口令不正确」，
     *   而真正的原因在服务端的配置里，从界面上完全看不出来。
     */
    const [{ n } = { n: 0 }] = await db
      .select({ n: count() })
      .from(users)
      .where(eq(users.status, 'active'));
    const [{ n: withPassword } = { n: 0 }] = await db
      .select({ n: count() })
      .from(users)
      .where(isNotNull(users.passwordHash));
    if (Number(n) === 0 || Number(withPassword) === 0) {
      log(
        '[auth] 没有配置 APOS_SUPERADMIN_EMAIL，且库里没有任何可登录的账号 —— ' +
          '现在谁都登不进来。请在 .env 里设置 APOS_SUPERADMIN_EMAIL 与 APOS_SUPERADMIN_PASSWORD 后重启。',
      );
    }
    return { userId: null, created: false };
  }

  const email = normalizeEmail(rawEmail);
  const [existing] = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, email));

  if (existing) {
    // 已有账号但还没有口令（比如从旧数据升级上来的）：补上，让他能登录
    if (!existing.passwordHash) {
      if (!password) {
        log(
          `[auth] 账号 ${email} 还没有口令，且未配置 APOS_SUPERADMIN_PASSWORD —— 他登不进来。`,
        );
        return { userId: existing.id, created: false };
      }
      const hash = await hashOrExplain(password, log);
      if (!hash) return { userId: existing.id, created: false };
      await db.update(users).set({ passwordHash: hash }).where(eq(users.id, existing.id));
      log(`[auth] 已为超管 ${email} 设置初始口令`);
    }
    return { userId: existing.id, created: false };
  }

  if (!password) {
    log(
      `[auth] 配置了 APOS_SUPERADMIN_EMAIL=${email} 但没有 APOS_SUPERADMIN_PASSWORD，` +
        '无法建号 —— 建一个登不进来的账号没有意义。',
    );
    return { userId: null, created: false };
  }

  const hash = await hashOrExplain(password, log);
  if (!hash) return { userId: null, created: false };

  const [row] = await db
    .insert(users)
    .values({ email, name, passwordHash: hash })
    .returning({ id: users.id });

  log(`[auth] 已创建超级管理员 ${email}（初始口令来自 .env，登录后请尽快修改）`);
  return { userId: row!.id, created: true };
}

/**
 * 保证超管至少属于一个组织。
 *
 * ★★ 不属于任何组织的账号能登录，但**每个请求都是 401**
 *   （resolveCurrentOrg：「这个账号还不属于任何组织」）。
 *   对第一次部署的人来说，那表现为「登录成功之后整个站点是空的」。
 */
export async function ensureSuperadminOrg(
  db: Database,
  userId: string,
  log: (message: string) => void = (m) => console.log(m),
): Promise<boolean> {
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, userId));
  if (Number(n) > 0) return false;

  const name = process.env['APOS_SUPERADMIN_ORG']?.trim() || '默认组织';
  /**
   * ★ 走 createOrganization 而不是直接 INSERT：它在同一个事务里
   *   建组织、把创建者设成 org_admin、预置内置角色。少了最后一件，
   *   这个组织里一个成员都加不进任何项目，报错是一句外键冲突。
   */
  const { organization } = await createOrganization(
    db,
    { actorId: userId, correlationId: `bootstrap-${userId}` },
    { name },
  );
  log(`[auth] 已为超管创建组织「${organization.name}」`);
  return true;
}

async function hashOrExplain(
  password: string,
  log: (message: string) => void,
): Promise<string | null> {
  try {
    return await hashPassword(password);
  } catch (err) {
    if (err instanceof WeakPasswordError) {
      log(`[auth] APOS_SUPERADMIN_PASSWORD 不合要求：${err.message}`);
      return null;
    }
    throw err;
  }
}
