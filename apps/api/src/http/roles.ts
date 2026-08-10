import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  organizations,
  projectMembers,
  roles,
  type Database,
} from '@apos/db';
import { humanActor } from '@apos/contracts';
import {
  BUILTIN_ROLES,
  PERMISSIONS,
  PERMISSION_SPECS,
  RoleDefinition,
  assignablePermissions,
  validateRoleDefinition,
  type Permission,
  type Role,
} from '@apos/domain';
import { emitAndPublish } from '../modules/event/bus';
import { ApiError, notFound } from './errors';

/**
 * 角色管理（docs/tech/09-security.md §2.2）。
 *
 * ★★ 超管在这里造出「研发」「运营」「测试」这些角色，每个角色可以由人担任、
 *   也可以由 Agent 担任。内置的六个是预置数据，不是全集。
 *
 * ★ 定义角色就是定义权限本身，所以这一整个模块只对 `org.roles.manage`
 *   （组织管理员）开放，且每一次写操作都记审计。
 */

/**
 * 把内置角色对齐到当前代码。
 *
 * ★★ 内置角色的真相来源是**权限目录**，不是库里的行。
 *
 *   目录里给 pm 加一条权限，如果库里那份拷贝不跟着变，就会出现
 *   「矩阵里写着 pm 能做，实际 pm 做不了」—— 没有任何报错，
 *   只有一个用户说「我这边点不动」。所以每次启动对齐一次，
 *   库里的行退化成一份缓存。
 *
 * ★ 只覆盖 builtin=true 的行。管理员自定义的角色一个字都不碰，
 *   哪怕 key 撞车（撞不了，key 唯一，见下面 onConflict 的条件）。
 */
export async function syncBuiltinRoles(db: Database, orgId?: string): Promise<number> {
  const targets = orgId
    ? [{ id: orgId }]
    : await db.select({ id: organizations.id }).from(organizations);

  let synced = 0;
  for (const org of targets) {
    for (const role of BUILTIN_ROLES) {
      await db
        .insert(roles)
        .values({
          orgId: org.id,
          key: role.key,
          name: role.name,
          description: role.description,
          permissions: role.permissions,
          appliesTo: role.appliesTo,
          builtin: true,
        })
        .onConflictDoUpdate({
          target: [roles.orgId, roles.key],
          set: {
            name: role.name,
            description: role.description,
            permissions: role.permissions,
            appliesTo: role.appliesTo,
            updatedAt: new Date(),
          },
          /**
           * ★ 只在 builtin 行上覆盖。一个组织如果在内置角色被引入之前
           *   自己建过同名角色，那是他们的配置，不该被一次升级悄悄改掉。
           */
          setWhere: eq(roles.builtin, true),
        });
      synced += 1;
    }
  }
  return synced;
}

/** 组织的全部角色。前端建角色时要看有哪些权限可选，一并返回 */
export async function listRoles(db: Database, orgId: string) {
  const rows = await db
    .select()
    .from(roles)
    .where(eq(roles.orgId, orgId))
    .orderBy(sql`${roles.builtin} desc`, roles.key);

  const usage = await roleUsage(db, orgId);

  return {
    roles: rows.map((r) => ({
      key: r.key,
      name: r.name,
      description: r.description,
      permissions: r.permissions as Permission[],
      appliesTo: r.appliesTo as ('human' | 'agent')[],
      builtin: r.builtin,
      /** 有多少人 / 多少 Agent 正在担任 —— 删除前要知道会影响谁 */
      memberCount: usage.get(r.key) ?? { human: 0, agent: 0 },
    })),
    /**
     * 可选权限清单。
     *
     * ★ 组织级权限不在里面（`assignablePermissions` 过滤掉了）：
     *   允许下放的话，超管能造一个「能创建角色的角色」发出去，
     *   拿到它的人再造一个更宽的 —— 一步走到组织管理员。
     */
    availablePermissions: assignablePermissions().map((p) => ({
      key: p,
      label: PERMISSION_SPECS[p].label,
      scope: PERMISSION_SPECS[p].scope,
      /** 带这个标记的权限进不了 Agent 角色，界面要能直接说明白 */
      humanOnly: Boolean(PERMISSION_SPECS[p].humanOnly),
      group: p.split('.')[0] ?? 'other',
    })),
  };
}

async function roleUsage(db: Database, orgId: string) {
  const rows = await db
    .select({
      role: projectMembers.role,
      actorType: projectMembers.actorType,
      count: sql<number>`count(*)::int`,
    })
    .from(projectMembers)
    .where(eq(projectMembers.orgId, orgId))
    .groupBy(projectMembers.role, projectMembers.actorType);

  const map = new Map<string, { human: number; agent: number }>();
  for (const r of rows) {
    const entry = map.get(r.role) ?? { human: 0, agent: 0 };
    if (r.actorType === 'human') entry.human += r.count;
    if (r.actorType === 'agent') entry.agent += r.count;
    map.set(r.role, entry);
  }
  return map;
}

export interface RoleWriteContext {
  orgId: string;
  actorId: string;
  correlationId: string;
}

export async function createRole(db: Database, ctx: RoleWriteContext, input: unknown) {
  const def = RoleDefinition.parse(input);
  assertValid(def);

  const [existing] = await db
    .select({ key: roles.key })
    .from(roles)
    .where(and(eq(roles.orgId, ctx.orgId), eq(roles.key, def.key)));
  if (existing) {
    throw new ApiError('VALIDATION_FAILED', `角色标识「${def.key}」已经被占用`, { key: def.key });
  }

  const [row] = await db
    .insert(roles)
    .values({
      orgId: ctx.orgId,
      key: def.key,
      name: def.name,
      description: def.description,
      permissions: def.permissions,
      appliesTo: def.appliesTo,
      builtin: false,
    })
    .returning();

  await audit(db, ctx, 'role.created', row!.id, {
    key: def.key,
    name: def.name,
    permissions: def.permissions,
    appliesTo: def.appliesTo,
  });

  return { role: serialize(row!) };
}

export async function updateRole(
  db: Database,
  ctx: RoleWriteContext,
  key: string,
  input: unknown,
) {
  const before = await load(db, ctx.orgId, key);

  /**
   * ★ 内置角色改不了权限 —— 它们**就是**权限矩阵（§2.3）。
   *   允许改的话，「tech_lead 能批准计划」这句话在每个组织里都可能不成立，
   *   文档、审计、支持全部失去共同语言。要不一样就自定义一个新角色。
   */
  if (before.builtin) {
    throw new ApiError(
      'FORBIDDEN',
      `「${before.name}」是内置角色，权限不可修改 —— 它就是权限矩阵本身。如需不同的组合，请新建一个角色。`,
      { key, builtin: true },
    );
  }

  const def = RoleDefinition.parse({ ...(input as Record<string, unknown>), key });
  assertValid(def);
  await assertAssigneesStillFit(db, ctx.orgId, key, def.appliesTo);

  const [row] = await db
    .update(roles)
    .set({
      name: def.name,
      description: def.description,
      permissions: def.permissions,
      appliesTo: def.appliesTo,
      updatedAt: new Date(),
    })
    .where(and(eq(roles.orgId, ctx.orgId), eq(roles.key, key)))
    .returning();

  await audit(db, ctx, 'role.updated', row!.id, {
    key,
    from: { permissions: before.permissions, appliesTo: before.appliesTo },
    to: { permissions: def.permissions, appliesTo: def.appliesTo },
  });

  return { role: serialize(row!) };
}

export async function deleteRole(db: Database, ctx: RoleWriteContext, key: string) {
  const before = await load(db, ctx.orgId, key);

  if (before.builtin) {
    throw new ApiError('FORBIDDEN', `「${before.name}」是内置角色，不能删除`, { key });
  }

  /**
   * ★ 有人担任就不让删，并说清楚是几个人。
   *
   *   外键其实已经会拦住（project_members_role_fk），但拦下来的是一条
   *   数据库约束错误，用户看到的是「操作失败」。先查一遍，
   *   才能说出「还有 3 个人 2 个 Agent 在担任这个角色」——
   *   这句话直接告诉他下一步该做什么。
   */
  const usage = (await roleUsage(db, ctx.orgId)).get(key) ?? { human: 0, agent: 0 };
  if (usage.human + usage.agent > 0) {
    const who = [
      usage.human > 0 ? `${usage.human} 人` : null,
      usage.agent > 0 ? `${usage.agent} 个 Agent` : null,
    ]
      .filter(Boolean)
      .join('、');
    throw new ApiError(
      'VALIDATION_FAILED',
      `还有 ${who} 在担任「${before.name}」，删除会让他们的权限归零。请先把他们改成别的角色。`,
      { key, usage },
    );
  }

  await db.delete(roles).where(and(eq(roles.orgId, ctx.orgId), eq(roles.key, key)));
  await audit(db, ctx, 'role.deleted', before.id, { key, name: before.name });

  return { ok: true as const, deleted: true };
}

/**
 * 改 appliesTo 时，已经在担任的人怎么办。
 *
 * ★ 把「研发」从 [human, agent] 收窄成 [human]，而已经有 Agent 在担任它 ——
 *   那些 Agent 会立刻变成一个「不该存在」的状态：库里还挂着，
 *   判定上说不清算不算数。宁可现在拒绝并让管理员先处理，
 *   也不要留下一批状态不明的成员。
 */
async function assertAssigneesStillFit(
  db: Database,
  orgId: string,
  key: string,
  appliesTo: readonly string[],
) {
  const usage = (await roleUsage(db, orgId)).get(key) ?? { human: 0, agent: 0 };
  if (usage.agent > 0 && !appliesTo.includes('agent')) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `还有 ${usage.agent} 个 Agent 在担任这个角色，不能把它改成「仅人类」。请先把它们改成别的角色。`,
      { key, agents: usage.agent },
    );
  }
  if (usage.human > 0 && !appliesTo.includes('human')) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `还有 ${usage.human} 人在担任这个角色，不能把它改成「仅 Agent」。请先把他们改成别的角色。`,
      { key, humans: usage.human },
    );
  }
}

function assertValid(def: RoleDefinition) {
  const errors = validateRoleDefinition(def);
  if (errors.length > 0) {
    throw new ApiError('VALIDATION_FAILED', errors.map((e) => e.message).join('；'), { errors });
  }
}

async function load(db: Database, orgId: string, key: string) {
  const [row] = await db
    .select()
    .from(roles)
    .where(and(eq(roles.orgId, orgId), eq(roles.key, key)));
  if (!row) throw notFound('角色');
  return row;
}

function serialize(row: typeof roles.$inferSelect): Role & { memberCount?: unknown } {
  return {
    key: row.key,
    name: row.name,
    description: row.description,
    permissions: row.permissions as Permission[],
    appliesTo: row.appliesTo as ('human' | 'agent')[],
    builtin: row.builtin,
  };
}

async function audit(
  db: Database,
  ctx: RoleWriteContext,
  type: 'role.created' | 'role.updated' | 'role.deleted',
  roleId: string,
  payload: Record<string, unknown>,
) {
  await emitAndPublish(db, {
    orgId: ctx.orgId,
    projectId: null,
    type,
    actor: humanActor(ctx.actorId),
    subjectType: 'role',
    subjectId: roleId,
    payload,
    correlationId: ctx.correlationId,
  });
}

/**
 * 角色 key → 权限集合，用于授权判定。
 *
 * ★ 一次请求只查一次，结果挂在 actor 上（见 rbac.ts 的 resolveActor）。
 */
export async function permissionsForRoles(
  db: Database,
  orgId: string,
  keys: readonly string[],
): Promise<Map<string, Permission[]>> {
  if (keys.length === 0) return new Map();
  const rows = await db
    .select({ key: roles.key, permissions: roles.permissions })
    .from(roles)
    .where(and(eq(roles.orgId, orgId), inArray(roles.key, [...keys])));

  const known = new Set<string>(PERMISSIONS);
  return new Map(
    rows.map((r) => [
      r.key,
      /**
       * ★ 过滤掉不认识的权限名。角色是数据，可能是旧版本写进去的、
       *   或者某条权限后来被删了 —— 原样带进判定的话，
       *   `includes` 永远不会命中，等于静默失效，但更糟的是
       *   它会出现在「这个角色有什么权限」的展示里，让人以为授权成功了。
       */
      (r.permissions as string[]).filter((p): p is Permission => known.has(p)),
    ]),
  );
}
