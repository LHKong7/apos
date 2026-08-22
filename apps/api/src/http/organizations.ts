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
 * Organization — the top-level container for all data (Plane calls it a
 * Workspace) / 组织，一切数据的顶层容器。
 *
 * ★★ Not calling it `workspace` is deliberate: in this codebase `workspace`
 *   already means an agent's git working directory (`AGENT_WORKSPACE_ROOT` /
 *   `WorkspaceService`). Give both the same name and "clean up the workspace"
 *   points at two entirely unrelated things at once. See the comment on
 *   organizations in packages/db/src/schema/core.ts.
 *
 * ★★ Before this, an organization was just an `org_id` column: the table was
 *   there, the foreign keys were there, the multi-tenant checks were there —
 *   but **no endpoint could create, rename, or switch one**, and the only
 *   source was the seed script. So "multi-tenant" held at the database layer
 *   while the product was a single-tenant instance.
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export const OrganizationInput = z.object({
  name: z.string().min(1, '组织名不能为空').max(120),
  /**
   * ★ Left empty, it is derived from the name. A Chinese name derives no usable
   *   slug (the regex leaves an empty string), and that falls back to
   *   `org-xxxxxxxx` rather than refusing to create the org. Demanding that the
   *   user think up a short English name first turns an implementation detail
   *   into their problem.
   */
  slug: z
    .string()
    .regex(SLUG_RE, 'slug 只能用小写字母、数字和连字符，3–40 位，不能以连字符开头或结尾')
    .optional(),
  description: z.string().max(2000).nullable().optional(),
});

export const OrganizationPatch = OrganizationInput.partial();

/** Which organizations I belong to — the data source for the org switcher */
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
 * Create an organization / 建组织。
 *
 * ★★ Three things must happen in one transaction: create the org, make the
 *   creator an org_admin, and seed the built-in roles.
 *
 *   Without the second, the creator cannot get into the org they just made.
 *   Without the third, `project_members.role` carries a foreign key onto
 *   `roles(org_id, key)`, so **no member can be added to any project** in this
 *   org — and the error is a foreign-key violation that looks nothing like
 *   "the organization was created wrong".
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
 * The transaction body behind creating an organization: create the org, make
 * the creator an org_admin, seed the built-in roles.
 *
 * ★★ It is split out so that **self-service signup** can put "create account"
 *   and "create org" into one transaction (`registerAccount` in
 *   `modules/auth/service.ts`). Across two transactions, a failure in the
 *   second step leaves an account that exists but belongs to no organization:
 *   they can log in, but every request afterward is a 401 — while the signup
 *   page told them "registration failed", so they sign up again with another
 *   email and the database gains one more account that can never get in.
 *
 * ★ Copying this instead of sharing it ends with new orgs and old orgs slowly
 *   drifting apart on their built-in roles.
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
 * Pick a free slug for the given name / 给定名字挑一个没被占用的 slug。
 *
 * ★ Exported for self-service signup, which has to settle the slug **before**
 *   opening its transaction (this step is a read; inside the transaction it
 *   would only lengthen how long the transaction is held).
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
      // null = clear it, undefined = the field was not mentioned this time
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
 * Delete an organization / 删组织。
 *
 * ★★ Allowed only when the org has **no projects**.
 *
 *   An org carries projects, work items, agents, repositories, runs, and audit
 *   events — cascading a delete through all of them wipes an entire tenant's
 *   history in one click, irreversibly (the event stream is in there too, so
 *   not even "who deleted it" survives). Requiring the projects to be cleared
 *   first turns this into a sequence of actions that leaves a trail.
 *
 * ★ Nor can you delete your own last organization: afterward the account
 *   belongs to no org at all, every request 401s, and it presents to them as
 *   "login is broken".
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

// ── Members ───────────────────────────────────────────────────────────

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
 * Add an existing account to the org, or change its org role /
 * 把一个已有账号加进组织，或改它的组织角色。
 *
 * ★ People are looked up by email, not by id: whoever is inviting them has an
 *   email address in hand, not a uuid. Accounts are global now, so "this person
 *   is already in another org" is the normal case — just add them, and neither
 *   need nor create a second account for them.
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
 * ★★ The last admin in an organization cannot be removed.
 *
 *   Without this rule, one slip leaves a whole org with nobody who can manage
 *   identities, define roles, change org-level policies, or read the audit
 *   trail — and recovering from it means editing the database by hand. Locking
 *   yourself out is the most common way a permission system wounds its own
 *   users. 「把自己锁在门外」是权限系统最常见的自伤方式。
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

// ── Shared ────────────────────────────────────────────────────────────

async function loadOrg(db: Database, orgId: string) {
  const [row] = await db
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!row) throw notFound('organization');
  return row;
}

/** Name → slug; when a Chinese name derives nothing, fall back to a random short string */
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
