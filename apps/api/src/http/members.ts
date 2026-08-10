import { and, eq, inArray, ne } from 'drizzle-orm';
import { agents, projectMembers, projects, users, type Database } from '@apos/db';
import {
  humanActor,
  isOrgAdmin,
  ORG_ROLE_LABEL,
  OrgRole,
  PROJECT_ROLE_LABEL,
  ProjectRole,
} from '@apos/contracts';
import { emitAndPublish } from '../modules/event/bus';
import { ApiError, notFound } from './errors';

/**
 * 成员与角色管理 —— 让 RBAC 真的可用。
 *
 * ★ 没有这一组端点时，角色只能靠 seed 脚本写进去。一套改不了的权限体系
 *   在实践中的表现是「所有人都用同一个账号」——因为换个角色比换个人便宜。
 *   权限模型的落地程度，取决于调整它有多容易。
 *
 * ★ 这里每一个写操作都记审计（§6.3）。「谁在什么时候把谁提成了 tech_lead」
 *   是提权路径上最关键的一步，查不到它，权限累积（§7）就无从追溯。
 */

const ASSIGNABLE_ROLES = ProjectRole.options;

/** 项目成员名册。Agent 与人类同表，但角色语义不同，分开返回 */
export async function listMembers(db: Database, projectId: string) {
  const rows = await db
    .select({
      actorId: projectMembers.actorId,
      actorType: projectMembers.actorType,
      role: projectMembers.role,
      addedAt: projectMembers.addedAt,
    })
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId));

  const humanIds = rows.filter((r) => r.actorType === 'human').map((r) => r.actorId);
  const agentIds = rows.filter((r) => r.actorType === 'agent').map((r) => r.actorId);

  const humanRows = humanIds.length
    ? await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          avatarUrl: users.avatarUrl,
          orgRole: users.orgRole,
        })
        .from(users)
        .where(inArray(users.id, humanIds))
    : [];
  const agentRows = agentIds.length
    ? await db
        .select({ id: agents.id, name: agents.name, type: agents.type })
        .from(agents)
        .where(inArray(agents.id, agentIds))
    : [];

  const byId = new Map<string, { name: string; email?: string; orgRole?: string }>();
  for (const u of humanRows) byId.set(u.id, { name: u.name, email: u.email, orgRole: u.orgRole });
  for (const a of agentRows) byId.set(a.id, { name: a.name });

  return {
    members: rows.map((r) => ({
      actorId: r.actorId,
      actorType: r.actorType,
      role: r.role,
      roleLabel: PROJECT_ROLE_LABEL[r.role as ProjectRole] ?? r.role,
      addedAt: r.addedAt,
      name: byId.get(r.actorId)?.name ?? null,
      email: byId.get(r.actorId)?.email ?? null,
      orgRole: byId.get(r.actorId)?.orgRole ?? null,
    })),
    assignableRoles: ASSIGNABLE_ROLES.map((role) => ({ role, label: PROJECT_ROLE_LABEL[role] })),
  };
}

export interface RoleChangeContext {
  projectId: string;
  targetUserId: string;
  actorId: string;
  correlationId: string;
}

/** 加成员 / 改角色。同一个端点 —— 从调用方看这就是「把某人设成某个角色」 */
export async function setMemberRole(
  db: Database,
  ctx: RoleChangeContext,
  role: ProjectRole,
) {
  const project = await loadProject(db, ctx.projectId);
  const target = await loadUser(db, ctx.targetUserId);

  /**
   * ★ 只能加本组织的人。
   *   不挡的话，一个 pm 就能把外组织的用户拉进项目 ——
   *   成员关系闸门（§2.1.1）此后会如实放行他，
   *   跨租户隔离从「查得严」变成「谁都能开个口子」。
   */
  if (target.orgId !== project.orgId) {
    throw new ApiError('VALIDATION_FAILED', '只能添加本组织的成员', {
      targetUserId: ctx.targetUserId,
    });
  }

  const before = await currentRole(db, ctx.projectId, ctx.targetUserId);
  if (before === role) return { ok: true as const, role, changed: false };

  await assertProjectKeepsALead(db, ctx.projectId, ctx.targetUserId, role);

  if (before === null) {
    await db
      .insert(projectMembers)
      .values({ projectId: ctx.projectId, actorType: 'human', actorId: ctx.targetUserId, role });
  } else {
    await db
      .update(projectMembers)
      .set({ role })
      .where(
        and(
          eq(projectMembers.projectId, ctx.projectId),
          eq(projectMembers.actorType, 'human'),
          eq(projectMembers.actorId, ctx.targetUserId),
        ),
      );
  }

  await emitAndPublish(db, {
    orgId: project.orgId,
    projectId: ctx.projectId,
    type: before === null ? 'project.member_added' : 'project.member_role_changed',
    actor: humanActor(ctx.actorId),
    subjectType: 'user',
    subjectId: ctx.targetUserId,
    payload: { from: before, to: role, projectId: ctx.projectId },
    correlationId: ctx.correlationId,
  });

  return { ok: true as const, role, changed: true, previousRole: before };
}

export async function removeMember(db: Database, ctx: RoleChangeContext) {
  const project = await loadProject(db, ctx.projectId);
  const before = await currentRole(db, ctx.projectId, ctx.targetUserId);
  if (before === null) throw notFound('项目成员');

  await assertProjectKeepsALead(db, ctx.projectId, ctx.targetUserId, null);

  await db
    .delete(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, ctx.projectId),
        eq(projectMembers.actorType, 'human'),
        eq(projectMembers.actorId, ctx.targetUserId),
      ),
    );

  await emitAndPublish(db, {
    orgId: project.orgId,
    projectId: ctx.projectId,
    type: 'project.member_removed',
    actor: humanActor(ctx.actorId),
    subjectType: 'user',
    subjectId: ctx.targetUserId,
    payload: { from: before, projectId: ctx.projectId },
    correlationId: ctx.correlationId,
  });

  return { ok: true as const, removed: true };
}

/** 组织角色变更（§2.2「org_admin：身份管理」）*/
export async function setOrgRole(
  db: Database,
  ctx: { targetUserId: string; actorId: string; correlationId: string },
  role: OrgRole,
) {
  const target = await loadUser(db, ctx.targetUserId);
  const actor = await loadUser(db, ctx.actorId);

  // 组织管理员的「全部权限」以组织为界 —— 越界就是多租户隔离失效
  if (target.orgId !== actor.orgId) {
    throw new ApiError('NOT_FOUND', '用户不存在，或不在你的组织内', {
      targetUserId: ctx.targetUserId,
    });
  }
  if (target.orgRole === role) return { ok: true as const, orgRole: role, changed: false };

  /**
   * ★ 不能把最后一个组织管理员降级。
   *
   *   没有这条的话，一次手滑就让整个组织再也没有人能管身份、
   *   改组织级 Policy、看审计 —— 而恢复它需要直接改数据库。
   *   「把自己锁在门外」是权限系统最常见的自伤方式。
   */
  if (isOrgAdmin(target.orgRole) && !isOrgAdmin(role)) {
    const others = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.orgId, target.orgId),
          ne(users.id, ctx.targetUserId),
          inArray(users.orgRole, ['org_admin', 'admin']),
        ),
      );
    if (others.length === 0) {
      throw new ApiError(
        'VALIDATION_FAILED',
        '这是组织里最后一个管理员，降级后将没有人能管理身份与组织级规则。请先指定另一位管理员。',
        { targetUserId: ctx.targetUserId },
      );
    }
  }

  await db.update(users).set({ orgRole: role }).where(eq(users.id, ctx.targetUserId));

  await emitAndPublish(db, {
    orgId: target.orgId,
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

/** 组织通讯录，配角色选择器用 */
export async function listOrgUsers(db: Database, orgId: string) {
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      avatarUrl: users.avatarUrl,
      orgRole: users.orgRole,
      status: users.status,
    })
    .from(users)
    .where(eq(users.orgId, orgId))
    .orderBy(users.name);

  return {
    users: rows.map((u) => ({
      ...u,
      orgRoleLabel: ORG_ROLE_LABEL[u.orgRole as OrgRole] ?? u.orgRole,
    })),
    assignableOrgRoles: (['org_admin', 'member'] as OrgRole[]).map((role) => ({
      role,
      label: ORG_ROLE_LABEL[role],
    })),
  };
}

/**
 * ★ 项目里至少要留一个 pm / tech_lead。
 *
 *   这两个角色是项目内唯一能改成员的（project.members.manage）。
 *   最后一个走掉之后，这个项目的权限就只有组织管理员能修 ——
 *   而多数组织里那是另一个部门的人，要走工单。
 *   与其事后求人，不如现在挡住并说清楚。
 */
async function assertProjectKeepsALead(
  db: Database,
  projectId: string,
  targetUserId: string,
  nextRole: ProjectRole | null,
) {
  if (nextRole === 'pm' || nextRole === 'tech_lead') return;

  const leads = await db
    .select({ actorId: projectMembers.actorId })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.actorType, 'human'),
        inArray(projectMembers.role, ['pm', 'tech_lead']),
      ),
    );

  const remaining = leads.filter((l) => l.actorId !== targetUserId);
  if (leads.some((l) => l.actorId === targetUserId) && remaining.length === 0) {
    throw new ApiError(
      'VALIDATION_FAILED',
      '这是项目里最后一位 pm / tech_lead，改动后将没有人能管理项目成员。请先指定另一位负责人。',
      { targetUserId },
    );
  }
}

async function currentRole(
  db: Database,
  projectId: string,
  userId: string,
): Promise<ProjectRole | null> {
  const [row] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.actorType, 'human'),
        eq(projectMembers.actorId, userId),
      ),
    );
  return (row?.role as ProjectRole | undefined) ?? null;
}

async function loadProject(db: Database, projectId: string) {
  const [row] = await db
    .select({ id: projects.id, orgId: projects.orgId })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!row) throw notFound('项目');
  return row;
}

async function loadUser(db: Database, userId: string) {
  const [row] = await db
    .select({ id: users.id, orgId: users.orgId, orgRole: users.orgRole, name: users.name })
    .from(users)
    .where(eq(users.id, userId));
  if (!row) throw notFound('用户');
  return row;
}
