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
import { roleAcceptsActor, type Permission } from '@apos/domain';
import { emitAndPublish } from '../modules/event/bus';
import { ApiError, notFound } from './errors';
import { assertNotLastAdmin } from './organizations';

/**
 * 成员与角色指派 —— 让 RBAC 真的可用。
 *
 * ★ 没有这一组端点时，角色只能靠 seed 脚本写进去。一套改不了的权限体系
 *   在实践中的表现是「所有人都用同一个账号」——因为换个角色比换个人便宜。
 *   权限模型的落地程度，取决于调整它有多容易。
 *
 * ★★ 担任者可以是人，也可以是 Agent。这是这个产品的基本形状：
 *   「测试」这个岗位可能是一个人，也可能是一个跑测试的 Agent，还可能两者都有。
 *   两者走同一个函数 —— 分成两条路径的话，「Agent 不能担任带 Human Gate
 *   权限的角色」这条一定会有一边漏掉。
 *
 * ★ 这里每一个写操作都记审计（§6.3）。「谁在什么时候把谁提成了 tech_lead」
 *   是提权路径上最关键的一步，查不到它，权限累积（§7）就无从追溯。
 */

export type MemberActorType = 'human' | 'agent';

/** 项目成员名册。Agent 与人类同表，也担任同一套角色 */
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
   * ★ 组织角色现在跟着**归属**走而不是账号，所以这里必须 join
   *   organization_members 并按本组织过滤 —— 同一个人在别的组织
   *   可能是管理员，那与这个项目无关，显示出来是误导。
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

  /** 可指派的角色，按担任者类型分开 —— 界面上人和 Agent 的下拉框内容不同 */
  const roleRows = await db.select().from(roles).where(eq(roles.orgId, orgId)).orderBy(roles.key);

  return {
    members: rows.map((r) => ({
      actorId: r.actorId,
      actorType: r.actorType,
      role: r.role,
      /** 角色被删掉时 leftJoin 会给 null —— 外键拦得住，但别让界面崩 */
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
  /** 被改的那一位：人或 Agent */
  actorType: MemberActorType;
  targetId: string;
  /** 操作者（永远是人 —— 改权限是 humanOnly） */
  actorId: string;
  correlationId: string;
}

export async function setMemberRole(db: Database, ctx: RoleChangeContext, roleKey: string) {
  const project = await loadProject(db, ctx.projectId);
  const target = await loadTarget(db, ctx.actorType, ctx.targetId, project.orgId);

  /**
   * ★ 只能加本组织的人 / 本组织的 Agent。
   *   不挡的话，一个 pm 就能把外组织的用户拉进项目 ——
   *   成员关系闸门（§2.1.1）此后会如实放行他，
   *   跨租户隔离从「查得严」变成「谁都能开个口子」。
   */
  if (target.orgId !== project.orgId) {
    throw new ApiError('VALIDATION_FAILED', '只能添加本组织的成员', { targetId: ctx.targetId });
  }

  const role = await loadRole(db, project.orgId, roleKey);

  /**
   * ★★ 角色认不认这一类担任者。
   *
   *   `appliesTo` 在建角色时就校验过（带 humanOnly 权限的角色不能给 Agent），
   *   这里再判一次是因为**指派**是另一个时刻：角色是先建好的，
   *   「把处理决策塞进研发角色」和「把研发角色指派给 Agent」
   *   是两次独立的操作，任何一次都可能是最后一步。
   */
  if (!roleAcceptsActor(role, ctx.actorType)) {
    throw new ApiError(
      'VALIDATION_FAILED',
      ctx.actorType === 'agent'
        ? `「${role.name}」不能由 Agent 担任 —— 它含有只能由人类行使的权限（确认需求、批准计划、处理决策这一类）`
        : `「${role.name}」是专门给 Agent 的角色，不能指派给人`,
      { role: roleKey, appliesTo: role.appliesTo },
    );
  }

  const before = await currentRole(db, ctx);
  if (before === roleKey) return { ok: true as const, role: roleKey, changed: false };

  await assertProjectKeepsAManager(db, project.orgId, ctx, roleKey);

  if (before === null) {
    await db.insert(projectMembers).values({
      orgId: project.orgId,
      projectId: ctx.projectId,
      actorType: ctx.actorType,
      actorId: ctx.targetId,
      role: roleKey,
    });
  } else {
    await db.update(projectMembers).set({ role: roleKey }).where(memberRow(ctx));
  }

  await emitAndPublish(db, {
    orgId: project.orgId,
    projectId: ctx.projectId,
    type: before === null ? 'project.member_added' : 'project.member_role_changed',
    actor: humanActor(ctx.actorId),
    subjectType: ctx.actorType === 'agent' ? 'agent' : 'user',
    subjectId: ctx.targetId,
    payload: { from: before, to: roleKey, projectId: ctx.projectId, actorType: ctx.actorType },
    correlationId: ctx.correlationId,
  });

  return { ok: true as const, role: roleKey, changed: true, previousRole: before };
}

export async function removeMember(db: Database, ctx: RoleChangeContext) {
  const project = await loadProject(db, ctx.projectId);
  const before = await currentRole(db, ctx);
  if (before === null) throw notFound('项目成员');

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
 * 组织角色变更（§2.2「org_admin：身份管理」）。
 *
 * ★★ 改的是**这个组织里的**角色，不是这个账号的属性。
 *
 *   账号可以属于多个组织之后，「把张三降级」这句话必须带上「在哪个组织」——
 *   否则在 A 组织点一下会顺手把他在 B 组织的管理员身份也拿掉，
 *   而 B 组织的人完全不知道发生了什么。
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

  // 组织管理员的「全部权限」以组织为界 —— 越界就是多租户隔离失效
  if (!target) {
    throw new ApiError('NOT_FOUND', '用户不存在，或不在你的组织内', {
      targetUserId: ctx.targetUserId,
    });
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

/** 组织通讯录，配角色选择器用 */
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
    /** Agent 也能被加进项目并担任角色，所以这份名单同样要给出去 */
    agents: agentRows,
    assignableOrgRoles: (['org_admin', 'member'] as OrgRole[]).map((role) => ({
      role,
      label: ORG_ROLE_LABEL[role],
    })),
  };
}

/**
 * ★★ 项目里至少要留一个「能管成员的人」。
 *
 *   判据是**权限**不是角色名（`project.members.manage`）：角色可自定义之后，
 *   「负责人」可能叫「运营主管」也可能叫「Tech Owner」。按名字判的话，
 *   一个把 pm 换成自定义角色的组织会突然失去这条保护 ——
 *   而失去它的表现是某天没人能改成员了，且只能改数据库来恢复。
 *
 * ★ 只数人不数 Agent：`project.members.manage` 是 humanOnly，
 *   Agent 拿不到它，数进来只会让这条保护形同虚设。
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
        // Postgres 数组包含运算
        inArray(projectMembers.role, await managerRoleKeys(db, orgId)),
      ),
    );

  const remaining = managers.filter((m) => m.actorId !== ctx.targetId);
  if (managers.some((m) => m.actorId === ctx.targetId) && remaining.length === 0) {
    throw new ApiError(
      'VALIDATION_FAILED',
      '这是项目里最后一位能管理成员的人，改动后将没有人能调整项目成员。请先指定另一位负责人。',
      { targetId: ctx.targetId },
    );
  }
}

/** 本组织里哪些角色带「管理项目成员」权限 */
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
  if (!row) throw notFound('项目');
  return row;
}

/**
 * ★ 账号是全局的，所以「这个人在哪个组织」不再能从 users 上读出来。
 *   项目成员判定要的是「他在**这个项目所属组织**里有没有位置」，
 *   所以带上 orgId 去查归属表。
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
  if (!row) throw notFound('用户');
  return { ...row, orgId: row.orgRole === null ? null : orgId };
}

async function loadTarget(db: Database, actorType: MemberActorType, id: string, orgId: string) {
  if (actorType === 'human') return loadUser(db, id, orgId);
  const [row] = await db
    .select({ id: agents.id, orgId: agents.orgId, name: agents.name })
    .from(agents)
    .where(eq(agents.id, id));
  if (!row) throw notFound('Agent');
  return row;
}

async function loadRole(db: Database, orgId: string, key: string) {
  const [row] = await db
    .select()
    .from(roles)
    .where(and(eq(roles.orgId, orgId), eq(roles.key, key)));
  if (!row) {
    throw new ApiError('VALIDATION_FAILED', `没有这个角色：${key}`, { role: key });
  }
  return { ...row, appliesTo: row.appliesTo as MemberActorType[] };
}
