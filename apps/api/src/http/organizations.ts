import { and, asc, count, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  organizationMembers,
  organizations,
  projects,
  roles,
  users,
  type Database,
  type DbTransaction,
} from '@apos/db';
import { humanActor, isOrgAdmin, ORG_ROLE_LABEL, OrgRole } from '@apos/contracts';
import { emitAndPublish } from '../modules/event/bus';
import { fail, notFound } from './errors';
import { syncBuiltinRoles } from './roles';

/**
 * 组织 —— 一切数据的顶层容器（Plane 里叫 Workspace）。
 *
 * ★★ 不叫 workspace 是刻意的：这个代码库里 `workspace` 已经指 Agent 的
 *   git 工作区（`AGENT_WORKSPACE_ROOT` / `WorkspaceService`）。
 *   两个都叫这个名字，「清理 workspace」会同时指向两件毫不相干的事。
 *   见 packages/db/src/schema/core.ts 上 organizations 的注释。
 *
 * ★★ 在此之前组织只是一列 `org_id`：表在、外键在、多租户判定也在，
 *   但**没有任何接口能创建、改名或切换它**，唯一的来源是 seed 脚本。
 *   于是「多租户」这件事只在数据库层面成立，产品上是个单租户实例。
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export const OrganizationInput = z.object({
  name: z.string().min(1, '组织名不能为空').max(120),
  /**
   * ★ 留空就按名字推。中文名推不出可用的 slug（正则之后是空串），
   *   那时回落到 `org-xxxxxxxx` —— 而不是拒绝创建。
   *   要求用户先想一个英文短名，是把实现细节变成了他的问题。
   */
  slug: z
    .string()
    .regex(SLUG_RE, 'slug 只能用小写字母、数字和连字符，3–40 位，不能以连字符开头或结尾')
    .optional(),
  description: z.string().max(2000).nullable().optional(),
});

export const OrganizationPatch = OrganizationInput.partial();

/** 我属于哪些组织 —— 切换器的数据源 */
export async function listMyOrganizations(db: Database, userId: string) {
  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      description: organizations.description,
      orgRole: organizationMembers.orgRole,
      addedAt: organizationMembers.addedAt,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .where(eq(organizationMembers.userId, userId))
    .orderBy(asc(organizations.name));

  const ids = rows.map((r) => r.id);
  const counts = ids.length
    ? await db
        .select({ orgId: projects.orgId, n: count() })
        .from(projects)
        .where(and(inArray(projects.orgId, ids), sql`${projects.deletedAt} IS NULL`))
        .groupBy(projects.orgId)
    : [];
  const byOrg = new Map(counts.map((c) => [c.orgId, Number(c.n)]));

  return {
    organizations: rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      description: r.description,
      orgRole: r.orgRole,
      orgRoleLabel: ORG_ROLE_LABEL[r.orgRole as OrgRole] ?? r.orgRole,
      projectCount: byOrg.get(r.id) ?? 0,
      joinedAt: r.addedAt.toISOString(),
    })),
  };
}

/**
 * 建组织。
 *
 * ★★ 三件事必须在同一个事务里：建组织、把创建者设成 org_admin、
 *   预置内置角色。
 *
 *   少了第二件，创建者进不去自己刚建的组织；少了第三件，
 *   `project_members.role` 的外键指向 `roles(org_id, key)`，
 *   于是这个组织里**一个成员都加不进任何项目** ——
 *   而那个报错是一句外键冲突，跟「组织建歪了」看不出关系。
 */
export async function createOrganization(
  db: Database,
  ctx: { actorId: string; correlationId: string },
  input: z.infer<typeof OrganizationInput>,
) {
  const slug = input.slug ?? (await freeSlug(db, input.name));

  const [existing] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, slug));
  if (existing) {
    throw fail(
      'VERSION_CONFLICT',
      'org.slug_taken',
      `slug ${slug} 已被占用`,
      { params: { slug }, details: { slug } },
    );
  }

  const org = await db.transaction((tx) =>
    insertOrganizationTx(tx, {
      name: input.name,
      slug,
      description: input.description ?? null,
      actorId: ctx.actorId,
    }),
  );

  await emitAndPublish(db, {
    orgId: org.id,
    projectId: null,
    type: 'organization.created',
    actor: humanActor(ctx.actorId),
    subjectType: 'organization',
    subjectId: org.id,
    payload: { name: org.name, slug: org.slug },
    correlationId: ctx.correlationId,
  });

  return { organization: org };
}

/**
 * 建组织的事务体：建组织 + 把创建者设成 org_admin + 预置内置角色。
 *
 * ★★ 单独拆出来，是为了让**自助注册**能把「建账号」和「建组织」放进
 *   同一个事务（`modules/auth/service.ts` 的 `registerAccount`）。
 *   分成两个事务的话，第二步失败会留下一个「存在但不属于任何组织」的账号：
 *   他能登录，但登录后每个请求都是 401 —— 而注册页那边显示的是「注册失败」，
 *   于是他会换个邮箱再注册一次，库里就多一个永远登不进去的号。
 *
 * ★ 抄一份而不是拆出来的下场，是新组织和老组织的内置角色慢慢长得不一样。
 */
export async function insertOrganizationTx(
  tx: DbTransaction,
  input: { name: string; slug: string; description?: string | null; actorId: string },
) {
  const [row] = await tx
    .insert(organizations)
    .values({
      name: input.name.trim(),
      slug: input.slug,
      description: input.description?.trim() || null,
      createdBy: input.actorId,
    })
    .returning({ id: organizations.id, name: organizations.name, slug: organizations.slug });

  await tx
    .insert(organizationMembers)
    .values({ orgId: row!.id, userId: input.actorId, orgRole: 'org_admin' });

  await syncBuiltinRoles(tx, row!.id);

  return row!;
}

/**
 * 给定名字挑一个没被占用的 slug。
 *
 * ★ 导出是给自助注册用的：它要在开事务**之前**把 slug 定下来
 *   （这一步是读，放进事务里只会白白拉长事务持有时间）。
 */
export async function freeOrganizationSlug(db: Database, name: string): Promise<string> {
  return freeSlug(db, name);
}

export async function updateOrganization(
  db: Database,
  ctx: { orgId: string; actorId: string; correlationId: string },
  input: z.infer<typeof OrganizationPatch>,
) {
  const before = await loadOrg(db, ctx.orgId);

  if (input.slug && input.slug !== before.slug) {
    const [taken] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.slug, input.slug), ne(organizations.id, ctx.orgId)));
    if (taken) throw fail(
      'VERSION_CONFLICT',
      'org.slug_taken',
      `slug ${input.slug} 已被占用`,
      { params: { slug: input.slug }, details: { slug: input.slug } },
    );
  }

  const [row] = await db
    .update(organizations)
    .set({
      ...(input.name ? { name: input.name.trim() } : {}),
      ...(input.slug ? { slug: input.slug } : {}),
      // null = 清空，undefined = 这次没提这个字段
      ...(input.description !== undefined
        ? { description: input.description?.trim() || null }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, ctx.orgId))
    .returning({ id: organizations.id, name: organizations.name, slug: organizations.slug });

  await emitAndPublish(db, {
    orgId: ctx.orgId,
    projectId: null,
    type: 'organization.updated',
    actor: humanActor(ctx.actorId),
    subjectType: 'organization',
    subjectId: ctx.orgId,
    payload: { from: { name: before.name, slug: before.slug }, to: { name: row!.name, slug: row!.slug } },
    correlationId: ctx.correlationId,
  });

  return { organization: row };
}

/**
 * 删组织。
 *
 * ★★ 只在**没有项目**时允许。
 *
 *   组织下面挂着项目、工作项、Agent、仓库、Run、审计事件 ——
 *   级联删除它们等于一次点击抹掉整个租户的历史，而且不可逆
 *   （事件流本身也在里面，连"谁删的"都留不下）。
 *   要求先清空项目，是让这件事变成一串有迹可循的动作。
 *
 * ★ 也不能删掉自己最后一个组织：删完之后这个账号没有任何组织，
 *   每个请求都会 401，表现成"登录坏了"。
 */
export async function deleteOrganization(
  db: Database,
  ctx: { orgId: string; actorId: string; correlationId: string },
) {
  const org = await loadOrg(db, ctx.orgId);

  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(projects)
    .where(eq(projects.orgId, ctx.orgId));
  if (Number(n) > 0) {
    throw fail(
      'VERSION_CONFLICT',
      'org.has_projects',
      `组织下还有 ${n} 个项目。请先删除或转移它们 —— 删组织会连同工作项、Agent、Run 与审计记录一起消失，这一步不可逆`,
      { params: { count: Number(n) }, details: { projectCount: Number(n) } },
    );
  }

  const mine = await db
    .select({ orgId: organizationMembers.orgId })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, ctx.actorId));
  if (mine.length <= 1) {
    throw fail(
      'VALIDATION_FAILED',
      'org.last_one_for_you',
      '这是你唯一的组织，删掉之后你将不属于任何组织，界面会整个用不了。请先创建或加入另一个组织。',
    );
  }

  await db.transaction(async (tx) => {
    await tx.delete(organizationMembers).where(eq(organizationMembers.orgId, ctx.orgId));
    await tx.delete(roles).where(eq(roles.orgId, ctx.orgId));
    await tx.delete(organizations).where(eq(organizations.id, ctx.orgId));
  });

  await emitAndPublish(db, {
    orgId: ctx.orgId,
    projectId: null,
    type: 'organization.deleted',
    actor: humanActor(ctx.actorId),
    subjectType: 'organization',
    subjectId: ctx.orgId,
    payload: { name: org.name, slug: org.slug },
    correlationId: ctx.correlationId,
  });

  return { ok: true as const };
}

// ── 成员 ──────────────────────────────────────────────────────────────

export async function listOrganizationMembers(db: Database, orgId: string) {
  const rows = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      avatarUrl: users.avatarUrl,
      status: users.status,
      orgRole: organizationMembers.orgRole,
      addedAt: organizationMembers.addedAt,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(organizationMembers.orgId, orgId))
    .orderBy(asc(users.name));

  return {
    members: rows.map((r) => ({
      userId: r.userId,
      name: r.name,
      email: r.email,
      avatarUrl: r.avatarUrl,
      status: r.status,
      orgRole: r.orgRole,
      orgRoleLabel: ORG_ROLE_LABEL[r.orgRole as OrgRole] ?? r.orgRole,
      addedAt: r.addedAt.toISOString(),
    })),
    assignableOrgRoles: (['org_admin', 'member'] as OrgRole[]).map((role) => ({
      role,
      label: ORG_ROLE_LABEL[role],
    })),
  };
}

/**
 * 把一个已有账号加进组织，或改它的组织角色。
 *
 * ★ 按 email 找人而不是按 id：邀请的人手上有的是邮箱，不是 uuid。
 *   账号现在是全局的，所以"这个人已经在别的组织里"是正常情况，
 *   直接把他加进来即可，不用也不该新建账号。
 */
export async function addOrganizationMember(
  db: Database,
  ctx: { orgId: string; actorId: string; correlationId: string },
  input: { email: string; orgRole: OrgRole },
) {
  const [user] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.email, input.email.trim().toLowerCase()));
  if (!user) {
    throw fail(
      'NOT_FOUND',
      'org.no_account_for_email',
      `没有邮箱为 ${input.email} 的账号。这里只能把**已存在的账号**加进组织 —— ` + '要么让他先自己注册（他会先有一个自己的组织，不影响加进来），' + '要么用「账号管理」直接给他开一个号',
      { params: { email: input.email }, details: { email: input.email } },
    );
  }

  await db
    .insert(organizationMembers)
    .values({ orgId: ctx.orgId, userId: user.id, orgRole: input.orgRole })
    .onConflictDoUpdate({
      target: [organizationMembers.orgId, organizationMembers.userId],
      set: { orgRole: input.orgRole },
    });

  await emitAndPublish(db, {
    orgId: ctx.orgId,
    projectId: null,
    type: 'organization.member_added',
    actor: humanActor(ctx.actorId),
    subjectType: 'user',
    subjectId: user.id,
    payload: { orgRole: input.orgRole, name: user.name },
    correlationId: ctx.correlationId,
  });

  return { ok: true as const, userId: user.id, orgRole: input.orgRole };
}

export async function removeOrganizationMember(
  db: Database,
  ctx: { orgId: string; actorId: string; correlationId: string },
  targetUserId: string,
) {
  const [member] = await db
    .select({ orgRole: organizationMembers.orgRole })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, ctx.orgId),
        eq(organizationMembers.userId, targetUserId),
      ),
    );
  if (!member) throw notFound('org_member');

  if (isOrgAdmin(member.orgRole)) await assertNotLastAdmin(db, ctx.orgId, targetUserId);

  await db
    .delete(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, ctx.orgId),
        eq(organizationMembers.userId, targetUserId),
      ),
    );

  await emitAndPublish(db, {
    orgId: ctx.orgId,
    projectId: null,
    type: 'organization.member_removed',
    actor: humanActor(ctx.actorId),
    subjectType: 'user',
    subjectId: targetUserId,
    payload: { orgRole: member.orgRole },
    correlationId: ctx.correlationId,
  });

  return { ok: true as const };
}

/**
 * ★★ 不能拿掉组织里最后一个管理员。
 *
 *   没有这条的话，一次手滑就让整个组织再也没有人能管身份、定义角色、
 *   改组织级 Policy、看审计 —— 而恢复它需要直接改数据库。
 *   「把自己锁在门外」是权限系统最常见的自伤方式。
 */
export async function assertNotLastAdmin(db: Database, orgId: string, exceptUserId: string) {
  const others = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        ne(organizationMembers.userId, exceptUserId),
        inArray(organizationMembers.orgRole, ['org_admin', 'admin']),
      ),
    );

  if (others.length === 0) {
    throw fail(
      'VALIDATION_FAILED',
      'org.last_admin',
      '这是组织里最后一个管理员。移除或降级后将没有人能管理身份与组织级规则，请先指定另一位管理员。',
      { details: { orgId } },
    );
  }
}

// ── 共用 ──────────────────────────────────────────────────────────────

async function loadOrg(db: Database, orgId: string) {
  const [row] = await db
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!row) throw notFound('organization');
  return row;
}

/** 名字 → slug；中文名推不出东西时回落到随机短串 */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return SLUG_RE.test(base) ? base : '';
}

async function freeSlug(db: Database, name: string): Promise<string> {
  const base = slugify(name) || 'org';
  const taken = await db
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(sql`${organizations.slug} = ${base} OR ${organizations.slug} LIKE ${`${base}-%`}`);
  if (!taken.some((t) => t.slug === base)) return base;

  const used = new Set(taken.map((t) => t.slug));
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  throw fail(
    'VERSION_CONFLICT',
    'org.slug_variants_exhausted',
    `slug ${base} 及其编号变体都被占用了，请手动指定一个`,
    { params: { base } },
  );
}
