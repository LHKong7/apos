import { and, eq, inArray } from 'drizzle-orm';
import {
  agents,
  organizationMembers,
  projectMembers,
  projects,
  roles,
  users,
  type Database,
} from '@apos/db';
import { humanActor, isOrgAdmin, ORG_ROLE_LABEL, OrgRole } from '@apos/contracts';
import { DEFAULT_AGENT_PROJECT_ROLE, roleAcceptsActor, type Permission } from '@apos/domain';
import { emitAndPublish } from '../modules/event/bus';
import { fail, notFound } from './errors';
import { assertNotLastAdmin } from './organizations';

/**
 * Members and role assignment — what makes RBAC actually usable.
 *
 * ★ Without these endpoints, roles can only be written by the seed script. In practice
 *   a permission system nobody can change shows up as "everyone shares one account",
 *   because switching roles costs more than switching people. How far a permission
 *   model gets adopted depends on how easy it is to adjust.
 *
 * ★★ A role holder can be a person or an Agent. That is the basic shape of this
 *   product: the "QA" seat might be a person, might be an Agent that runs tests, might
 *   be both. Both go through the same function — split into two paths and the rule
 *   "an Agent cannot hold a role carrying Human Gate permissions" is guaranteed to be
 *   missing from one of them.
 *
 * ★ Every write here is audited (§6.3). "Who promoted whom to tech_lead, and when" is
 *   the pivotal step of any privilege escalation; without it, permission creep (§7)
 *   cannot be traced at all.
 */

export type MemberActorType = 'human' | 'agent';

/** The project roster. Agents and people share one table and one set of roles */
export async function listMembers(db: Database, projectId: string, orgId: string) {
  const rows = await db
    .select({
      actorId: projectMembers.actorId,
      actorType: projectMembers.actorType,
      role: projectMembers.role,
      addedAt: projectMembers.addedAt,
      roleName: roles.name,
      rolePermissions: roles.permissions,
    })
    .from(projectMembers)
    .leftJoin(roles, and(eq(roles.orgId, projectMembers.orgId), eq(roles.key, projectMembers.role)))
    .where(eq(projectMembers.projectId, projectId));

  const humanIds = rows.filter((r) => r.actorType === 'human').map((r) => r.actorId);
  const agentIds = rows.filter((r) => r.actorType === 'agent').map((r) => r.actorId);

  /**
   * ★ An organization role now follows **membership**, not the account, so this has to
   *   join organization_members and filter by this org. The same person may be an
   *   admin somewhere else, which has nothing to do with this project — showing it here
   *   would be misleading.
   */
  const humanRows = humanIds.length
    ? await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          avatarUrl: users.avatarUrl,
          orgRole: organizationMembers.orgRole,
        })
        .from(users)
        .leftJoin(
          organizationMembers,
          and(eq(organizationMembers.userId, users.id), eq(organizationMembers.orgId, orgId)),
        )
        .where(inArray(users.id, humanIds))
    : [];
  const agentRows = agentIds.length
    ? await db
        .select({ id: agents.id, name: agents.name, type: agents.type, status: agents.status })
        .from(agents)
        .where(inArray(agents.id, agentIds))
    : [];

  const byId = new Map<string, { name: string; email?: string; orgRole?: string; sub?: string }>();
  for (const u of humanRows)
    byId.set(u.id, { name: u.name, email: u.email, orgRole: u.orgRole ?? undefined });
  for (const a of agentRows) byId.set(a.id, { name: a.name, sub: `${a.type} · ${a.status}` });

  /** Assignable roles, separated by holder type — the dropdowns for people and Agents differ */
  const roleRows = await db.select().from(roles).where(eq(roles.orgId, orgId)).orderBy(roles.key);

  return {
    members: rows.map((r) => ({
      actorId: r.actorId,
      actorType: r.actorType,
      role: r.role,
      /** The leftJoin yields null if the role was deleted — the FK prevents it, but do not crash the UI */
      roleLabel: r.roleName ?? r.role,
      permissionCount: (r.rolePermissions as string[] | null)?.length ?? 0,
      addedAt: r.addedAt,
      name: byId.get(r.actorId)?.name ?? null,
      email: byId.get(r.actorId)?.email ?? null,
      detail: byId.get(r.actorId)?.sub ?? null,
      orgRole: byId.get(r.actorId)?.orgRole ?? null,
    })),
    assignableRoles: roleRows.map((r) => ({
      role: r.key,
      label: r.name,
      description: r.description,
      appliesTo: r.appliesTo as MemberActorType[],
      builtin: r.builtin,
      permissions: r.permissions as Permission[],
    })),
  };
}

export interface RoleChangeContext {
  projectId: string;
  /** The one being changed: a person or an Agent */
  actorType: MemberActorType;
  targetId: string;
  /** The actor — always a person, since changing permissions is humanOnly */
  actorId: string;
  correlationId: string;
}

/**
 * Assign or change a project member's role.
 *
 * A null `roleKey` means the caller named no role. Only an agent joining a
 * project may do that, and it lands on {@link DEFAULT_AGENT_PROJECT_ROLE};
 * humans must always name one, because the human role ladder runs from
 * sponsor to viewer and no rung is a safe default.
 *
 * `roleKey` 为 null 表示调用方没点名角色 —— 只有 Agent 加入项目允许这样调。
 */
export async function setMemberRole(
  db: Database,
  ctx: RoleChangeContext,
  roleKey: string | null,
) {
  const project = await loadProject(db, ctx.projectId);
  const target = await loadTarget(db, ctx.actorType, ctx.targetId, project.orgId);

  /**
   * ★ Only people and Agents from this organization may be added. Without this check a
   *   pm could pull a user from another org into the project — the membership gate
   *   (§2.1.1) would then faithfully let them through, and cross-tenant isolation would
   *   go from "strictly checked" to "anyone can open a hole in it".
   */
  if (target.orgId !== project.orgId) {
    throw fail(
      'VALIDATION_FAILED',
      'member.outside_org',
      '只能添加本组织的成员',
      { details: { targetId: ctx.targetId } },
    );
  }

  const before = await currentRole(db, ctx);

  /**
   * ★★ Two branches when no role was named, and their order cannot be swapped.
   *
   *   Already a member → **return untouched, change nothing**. This matters more than
   *   the default itself: the UI uses this one endpoint for both "add to project" and
   *   "change role", so a misclick that landed as "reset to executor" would silently
   *   demote a custom role an admin had tuned — and afterward it would look exactly
   *   like an Agent that had always been an executor, so nobody would notice.
   *
   *   Not a member yet → fall to the lowest level. Joining a project is already an
   *   explicit grant, and filling in an execute-only, decide-nothing role at that
   *   moment widens no one's intent.
   */
  if (roleKey === null) {
    if (before !== null) return { ok: true as const, role: before, changed: false };

    if (ctx.actorType !== 'agent') {
      throw fail(
        'VALIDATION_FAILED',
        'member.human_role_required',
        '添加人类成员必须指定角色 —— 人的角色从业务负责人到只读都有，没有一个默认档是安全的',
        { details: { actorType: ctx.actorType } },
      );
    }
  }

  const effectiveRole = roleKey ?? DEFAULT_AGENT_PROJECT_ROLE;
  const role = await loadRole(db, project.orgId, effectiveRole);

  /**
   * ★★ Does the role accept this kind of holder?
   *
   *   `appliesTo` was already validated when the role was created (a role carrying
   *   humanOnly permissions cannot be given to Agents). It is checked again here
   *   because **assignment** is a separate moment in time: the role was built earlier,
   *   and "add decision handling to the Engineering role" and "assign the Engineering
   *   role to an Agent" are two independent acts — either one can be the last one.
   */
  if (!roleAcceptsActor(role, ctx.actorType)) {
    /** ★ Two codes. "A human role given to an Agent" and the reverse are different problems */
    throw ctx.actorType === 'agent'
      ? fail(
          'VALIDATION_FAILED',
          'role.human_only',
          `「${role.name}」不能由 Agent 担任 —— 它含有只能由人类行使的权限（确认需求、批准计划、处理决策这一类）`,
          { params: { name: role.name }, details: { role: effectiveRole, appliesTo: role.appliesTo } },
        )
      : fail(
          'VALIDATION_FAILED',
          'role.agent_only',
          `「${role.name}」是专门给 Agent 的角色，不能指派给人`,
          { params: { name: role.name }, details: { role: effectiveRole, appliesTo: role.appliesTo } },
        );
  }

  if (before === effectiveRole) {
    return { ok: true as const, role: effectiveRole, changed: false };
  }

  await assertProjectKeepsAManager(db, project.orgId, ctx, effectiveRole);

  if (before === null) {
    await db.insert(projectMembers).values({
      orgId: project.orgId,
      projectId: ctx.projectId,
      actorType: ctx.actorType,
      actorId: ctx.targetId,
      role: effectiveRole,
    });
  } else {
    await db.update(projectMembers).set({ role: effectiveRole }).where(memberRow(ctx));
  }

  await emitAndPublish(db, {
    orgId: project.orgId,
    projectId: ctx.projectId,
    type: before === null ? 'project.member_added' : 'project.member_role_changed',
    actor: humanActor(ctx.actorId),
    subjectType: ctx.actorType === 'agent' ? 'agent' : 'user',
    subjectId: ctx.targetId,
    payload: {
      from: before,
      to: effectiveRole,
      projectId: ctx.projectId,
      actorType: ctx.actorType,
      /** ★ Record whether this level was defaulted or chosen — the audit must tell them apart */
      roleDefaulted: roleKey === null,
    },
    correlationId: ctx.correlationId,
  });

  return { ok: true as const, role: effectiveRole, changed: true, previousRole: before };
}

export async function removeMember(db: Database, ctx: RoleChangeContext) {
  const project = await loadProject(db, ctx.projectId);
  const before = await currentRole(db, ctx);
  if (before === null) throw notFound('project_member');

  await assertProjectKeepsAManager(db, project.orgId, ctx, null);

  await db.delete(projectMembers).where(memberRow(ctx));

  await emitAndPublish(db, {
    orgId: project.orgId,
    projectId: ctx.projectId,
    type: 'project.member_removed',
    actor: humanActor(ctx.actorId),
    subjectType: ctx.actorType === 'agent' ? 'agent' : 'user',
    subjectId: ctx.targetId,
    payload: { from: before, projectId: ctx.projectId, actorType: ctx.actorType },
    correlationId: ctx.correlationId,
  });

  return { ok: true as const, removed: true };
}

/**
 * Change an organization role (§2.2, "org_admin: identity management").
 *
 * ★★ What changes is the role **within this organization**, not a property of the
 *   account.
 *
 *   Once an account can belong to several organizations, "demote this person" has to
 *   name which organization — otherwise one click inside org A also strips their admin
 *   standing in org B, and nobody in org B has any idea what happened.
 */
export async function setOrgRole(
  db: Database,
  ctx: { orgId: string; targetUserId: string; actorId: string; correlationId: string },
  role: OrgRole,
) {
  const [target] = await db
    .select({ orgRole: organizationMembers.orgRole })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, ctx.orgId),
        eq(organizationMembers.userId, ctx.targetUserId),
      ),
    );

  // An org admin's "all permissions" stops at the organization boundary — crossing it
  // is precisely what tenancy isolation failing looks like
  if (!target) {
    throw fail('NOT_FOUND', 'member.user_outside_org', '用户不存在，或不在你的组织内', { details: {
      targetUserId: ctx.targetUserId,
    } });
  }
  if (target.orgRole === role) return { ok: true as const, orgRole: role, changed: false };

  if (isOrgAdmin(target.orgRole) && !isOrgAdmin(role)) {
    await assertNotLastAdmin(db, ctx.orgId, ctx.targetUserId);
  }

  await db
    .update(organizationMembers)
    .set({ orgRole: role })
    .where(
      and(
        eq(organizationMembers.orgId, ctx.orgId),
        eq(organizationMembers.userId, ctx.targetUserId),
      ),
    );

  await emitAndPublish(db, {
    orgId: ctx.orgId,
    projectId: null,
    type: 'user.org_role_changed',
    actor: humanActor(ctx.actorId),
    subjectType: 'user',
    subjectId: ctx.targetUserId,
    payload: { from: target.orgRole, to: role },
    correlationId: ctx.correlationId,
  });

  return { ok: true as const, orgRole: role, changed: true, previousRole: target.orgRole };
}

/** The organization directory, for the role pickers */
export async function listOrgUsers(db: Database, orgId: string) {
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      avatarUrl: users.avatarUrl,
      orgRole: organizationMembers.orgRole,
      status: users.status,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(organizationMembers.orgId, orgId))
    .orderBy(users.name);

  const agentRows = await db
    .select({ id: agents.id, name: agents.name, type: agents.type, status: agents.status })
    .from(agents)
    .where(eq(agents.orgId, orgId))
    .orderBy(agents.name);

  return {
    users: rows.map((u) => ({
      ...u,
      orgRoleLabel: ORG_ROLE_LABEL[u.orgRole as OrgRole] ?? u.orgRole,
    })),
    /** Agents can join projects and hold roles too, so this list ships alongside the people */
    agents: agentRows,
    assignableOrgRoles: (['org_admin', 'member'] as OrgRole[]).map((role) => ({
      role,
      label: ORG_ROLE_LABEL[role],
    })),
  };
}

/**
 * ★★ A project must keep at least one person who can manage members.
 *
 *   The criterion is the **permission** (`project.members.manage`), not the role name.
 *   Once roles are customizable, "the lead" might be called "Operations Manager" or
 *   "Tech Owner". Judging by name means an organization that replaced pm with a custom
 *   role loses this protection out of nowhere — and losing it shows up as the day
 *   nobody can change members any more, recoverable only by editing the database.
 *
 * ★ Count people only, never Agents: `project.members.manage` is humanOnly, so an
 *   Agent can never hold it, and counting them would render this protection hollow.
 */
async function assertProjectKeepsAManager(
  db: Database,
  orgId: string,
  ctx: RoleChangeContext,
  nextRole: string | null,
) {
  if (ctx.actorType !== 'human') return;

  if (nextRole !== null) {
    const next = await loadRole(db, orgId, nextRole);
    if ((next.permissions as string[]).includes('project.members.manage')) return;
  }

  const managers = await db
    .select({ actorId: projectMembers.actorId })
    .from(projectMembers)
    .innerJoin(roles, and(eq(roles.orgId, projectMembers.orgId), eq(roles.key, projectMembers.role)))
    .where(
      and(
        eq(projectMembers.projectId, ctx.projectId),
        eq(projectMembers.actorType, 'human'),
        // Postgres array-containment operation
        inArray(projectMembers.role, await managerRoleKeys(db, orgId)),
      ),
    );

  const remaining = managers.filter((m) => m.actorId !== ctx.targetId);
  if (managers.some((m) => m.actorId === ctx.targetId) && remaining.length === 0) {
    throw fail(
      'VALIDATION_FAILED',
      'member.last_manager',
      '这是项目里最后一位能管理成员的人，改动后将没有人能调整项目成员。请先指定另一位负责人。',
      { details: { targetId: ctx.targetId } },
    );
  }
}

/** Which roles in this organization carry the "manage project members" permission */
async function managerRoleKeys(db: Database, orgId: string): Promise<string[]> {
  const rows = await db
    .select({ key: roles.key, permissions: roles.permissions })
    .from(roles)
    .where(eq(roles.orgId, orgId));
  return rows
    .filter((r) => (r.permissions as string[]).includes('project.members.manage'))
    .map((r) => r.key);
}

function memberRow(ctx: RoleChangeContext) {
  return and(
    eq(projectMembers.projectId, ctx.projectId),
    eq(projectMembers.actorType, ctx.actorType),
    eq(projectMembers.actorId, ctx.targetId),
  );
}

async function currentRole(db: Database, ctx: RoleChangeContext): Promise<string | null> {
  const [row] = await db.select({ role: projectMembers.role }).from(projectMembers).where(memberRow(ctx));
  return row?.role ?? null;
}

async function loadProject(db: Database, projectId: string) {
  const [row] = await db
    .select({ id: projects.id, orgId: projects.orgId })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!row) throw notFound('project');
  return row;
}

/**
 * ★ Accounts are global, so "which organization is this person in" can no longer be
 *   read off the users row. What project membership needs is whether they have a place
 *   in **the organization this project belongs to**, so the membership table is queried
 *   with that orgId.
 */
async function loadUser(db: Database, userId: string, orgId: string) {
  const [row] = await db
    .select({ id: users.id, name: users.name, orgRole: organizationMembers.orgRole })
    .from(users)
    .leftJoin(
      organizationMembers,
      and(eq(organizationMembers.userId, users.id), eq(organizationMembers.orgId, orgId)),
    )
    .where(eq(users.id, userId));
  if (!row) throw notFound('user');
  return { ...row, orgId: row.orgRole === null ? null : orgId };
}

async function loadTarget(db: Database, actorType: MemberActorType, id: string, orgId: string) {
  if (actorType === 'human') return loadUser(db, id, orgId);
  const [row] = await db
    .select({ id: agents.id, orgId: agents.orgId, name: agents.name })
    .from(agents)
    .where(eq(agents.id, id));
  if (!row) throw notFound('agent');
  return row;
}

async function loadRole(db: Database, orgId: string, key: string) {
  const [row] = await db
    .select()
    .from(roles)
    .where(and(eq(roles.orgId, orgId), eq(roles.key, key)));
  if (!row) {
    throw fail(
      'VALIDATION_FAILED',
      'member.unknown_role',
      `没有这个角色：${key}`,
      { params: { role: key }, details: { role: key } },
    );
  }
  return { ...row, appliesTo: row.appliesTo as MemberActorType[] };
}
