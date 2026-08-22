import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  organizations,
  projectMembers,
  roles,
  type Database,
  type DbTransaction,
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
import { fail, notFound } from './errors';

/**
 * Role management (docs/tech/09-security.md §2.2) / 角色管理。
 *
 * ★★ This is where an org admin creates roles like "Engineering", "Operations", or
 *   "QA". Any role can be held by a person or by an Agent. The six built-in roles are
 *   seeded data, not the complete set.
 *
 *   内置的六个是预置数据，不是全集。
 *
 * ★ Defining a role *is* defining permissions, so this entire module is open only to
 *   `org.roles.manage` (organization admins), and every write is audited.
 */

/**
 * Bring the built-in roles in line with the current code / 把内置角色对齐到当前代码。
 *
 * ★★ The source of truth for a built-in role is the **permission catalog**, not the
 *   row in the database.
 *
 *   Add a permission to pm in the catalog and, if the copy in the database does not
 *   follow, you get "the matrix says pm can do this and pm cannot" — with no error
 *   anywhere, just one user reporting that the button does nothing. So the rows are
 *   re-aligned on every startup and degrade into a cache.
 *
 * ★ Only rows with builtin=true are overwritten. Admin-defined roles are not touched
 *   at all, even on a key collision (which cannot happen — keys are unique; see the
 *   onConflict condition below).
 */
export async function syncBuiltinRoles(
  /**
   * ★ Accepts a `Database` or a transaction: when an organization is created, this
   *   step has to run in the same transaction as inserting the org and setting its
   *   admin. Without the roles, not a single member of that org can be added to any
   *   project (project_members.role has a foreign key into roles), and the symptom is
   *   a bare foreign-key violation.
   */
  db: Database | DbTransaction,
  orgId?: string,
): Promise<number> {
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
           * ★ Overwrite built-in rows only. If an organization created a role of the
           *   same name before the built-ins existed, that is their configuration and
           *   an upgrade has no business quietly rewriting it.
           */
          setWhere: eq(roles.builtin, true),
        });
      synced += 1;
    }
  }
  return synced;
}

/**
 * Every role in the organization. The assignable permission list rides along, because
 * the client needs it while a role is being built.
 */
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
      /** How many people / Agents hold it — you need to know who is affected before deleting */
      memberCount: usage.get(r.key) ?? { human: 0, agent: 0 },
    })),
    /**
     * The assignable permission list / 可选权限清单。
     *
     * ★ Organization-level permissions are excluded (`assignablePermissions` filters
     *   them out). If they could be handed down, an admin could mint a "role that can
     *   create roles" and give it away; whoever receives it mints a wider one — one
     *   step from there to organization admin.
     */
    availablePermissions: assignablePermissions().map((p) => ({
      key: p,
      label: PERMISSION_SPECS[p].label,
      scope: PERMISSION_SPECS[p].scope,
      /** Permissions carrying this flag cannot enter an Agent role; the UI has to say so plainly */
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
    throw fail(
      'VALIDATION_FAILED',
      'role.key_taken',
      `角色标识「${def.key}」已经被占用`,
      { params: { key: def.key }, details: { key: def.key } },
    );
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
   * ★ Built-in roles have immutable permissions — they **are** the permission matrix
   *   (§2.3). Let them be edited and "a tech_lead can approve plans" stops being true
   *   in some unknown subset of organizations, and docs, audit, and support all lose
   *   their shared vocabulary. Anyone who needs something different creates a role.
   */
  if (before.builtin) {
    throw fail(
      'FORBIDDEN',
      'role.builtin_permissions_locked',
      `「${before.name}」是内置角色，权限不可修改 —— 它就是权限矩阵本身。如需不同的组合，请新建一个角色。`,
      { params: { name: before.name }, details: { key, builtin: true } },
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

/**
 * Copy-and-customize: build a new role using an existing one as the template
 * / 「复制并改」。
 *
 * ★★ This is the **other half** of "built-in roles are not editable" (the check in
 *   updateRole).
 *
 *   Say only "you cannot edit built-in roles" and the user's next move is ticking a
 *   permission list from scratch — and a from-scratch role is almost certainly not
 *   the "tech_lead plus one more thing" they had in mind, in ways they themselves
 *   cannot articulate. Give them a copy path and "same as tech_lead but cannot
 *   approve plans" becomes one subtraction instead of a reinvention.
 *
 * ★★ What is copied is a **permission snapshot**, not an inheritance link.
 *
 *   `basedOn` is a provenance label for display only. Make it dynamic inheritance and
 *   the day the platform adjusts a built-in role, every derived role widens with it —
 *   which is exactly how "permission creep" (§7) happens, the same reason capability
 *   profiles are stored expanded.
 */
export async function cloneRole(db: Database, ctx: RoleWriteContext, key: string, input: unknown) {
  const source = await load(db, ctx.orgId, key);

  const def = RoleDefinition.parse({
    // ★ Permissions and appliesTo are carried over wholesale by default; anything the
    //   caller supplies wins
    permissions: source.permissions,
    appliesTo: source.appliesTo,
    description: source.description,
    ...(input as Record<string, unknown>),
  });

  const created = await createRole(db, ctx, def);
  return { ...created, basedOn: { key: source.key, name: source.name } };
}

/**
 * Impact preview, shown before saving / 保存前的影响预览。
 *
 * ★★ Same discipline as the Agent permission side: **preview and save share one
 *   evaluation**. This computes what was added, what was removed, how many people and
 *   Agents are affected, and whether the change tightens or loosens — and updateRole
 *   asks for its permission using those same numbers.
 *
 * ★ "How many people this affects" has to be said **before** the save. Roles are
 *   organization-level, so one edit can change what a dozen people across five
 *   projects are allowed to do — and after the save no screen anywhere tells them.
 */
export async function previewRole(db: Database, orgId: string, key: string, input: unknown) {
  const before = await load(db, orgId, key);
  const def = RoleDefinition.parse({ ...(input as Record<string, unknown>), key });
  /**
   * ★ Validate before diffing. Skip it and a mistyped permission name travels all the
   *   way into the PERMISSION_SPECS lookup, the preview panel renders undefined, and
   *   the user concludes "this permission exists, it just has no description".
   */
  assertValid(def);
  const next = def.permissions as Permission[];

  const beforeSet = new Set(before.permissions as Permission[]);
  const afterSet = new Set(next);

  const added = next.filter((p) => !beforeSet.has(p));
  const removed = (before.permissions as Permission[]).filter((p) => !afterSet.has(p));

  const usage = (await roleUsage(db, orgId)).get(key) ?? { human: 0, agent: 0 };

  /**
   * ★ Pull the humanOnly incompatibilities out separately. Adding a humanOnly
   *   permission to a role that Agents can also hold gets rejected on save by
   *   validateRoleDefinition — but that error arrives after the save button, and the
   *   user is looking at the checkboxes right now.
   */
  const humanOnlyConflicts = added.filter(
    (p) => PERMISSION_SPECS[p].humanOnly && def.appliesTo.includes('agent'),
  );

  return {
    direction: added.length > 0 ? 'loosen' : removed.length > 0 ? 'tighten' : 'neutral',
    added: added.map((p) => ({ key: p, label: PERMISSION_SPECS[p].label })),
    removed: removed.map((p) => ({ key: p, label: PERMISSION_SPECS[p].label })),
    affectedHumans: usage.human,
    affectedAgents: usage.agent,
    humanOnlyConflicts: humanOnlyConflicts.map((p) => ({
      key: p,
      label: PERMISSION_SPECS[p].label,
    })),
    /** Built-ins can be copied, not edited — say it in the preview instead of 403-ing on save */
    builtin: before.builtin,
    requiresReason: false,
  };
}

export async function deleteRole(db: Database, ctx: RoleWriteContext, key: string) {
  const before = await load(db, ctx.orgId, key);

  if (before.builtin) {
    throw fail(
      'FORBIDDEN',
      'role.builtin_undeletable',
      `「${before.name}」是内置角色，不能删除`,
      { params: { name: before.name }, details: { key } },
    );
  }

  /**
   * ★ Refuse the delete while anyone holds the role, and say how many.
   *
   *   The foreign key would already stop it (project_members_role_fk), but what it
   *   stops with is a database constraint error that reaches the user as "operation
   *   failed". Counting first is what makes it possible to say "3 people and 2 Agents
   *   still hold this role" — a sentence that tells them what to do next.
   */
  const usage = (await roleUsage(db, ctx.orgId)).get(key) ?? { human: 0, agent: 0 };
  if (usage.human + usage.agent > 0) {
    /**
     * ★★ Three reason codes, not one code with a stitched-together subject.
     *
     *   This used to join "3 人" and "2 个 Agent" with "、" into a `who` string and
     *   drop it into one sentence. English needs "3 people and 2 Agents" — different
     *   conjunction, different pluralization, and the zero side should not appear at
     *   all. A stitched subject only works in Chinese. So "humans only", "Agents
     *   only", and "both" are three independent sentences.
     */
    const who = [
      usage.human > 0 ? `${usage.human} 人` : null,
      usage.agent > 0 ? `${usage.agent} 个 Agent` : null,
    ]
      .filter(Boolean)
      .join('、');
    const reason =
      usage.human > 0 && usage.agent > 0
        ? 'role.in_use_by_both'
        : usage.agent > 0
          ? 'role.in_use_by_agents'
          : 'role.in_use_by_humans';
    throw fail(
      'VALIDATION_FAILED',
      reason,
      `还有 ${who} 在担任「${before.name}」，删除会让他们的权限归零。请先把他们改成别的角色。`,
      {
        params: { name: before.name, humans: usage.human, agents: usage.agent },
        details: { key, usage },
      },
    );
  }

  await db.delete(roles).where(and(eq(roles.orgId, ctx.orgId), eq(roles.key, key)));
  await audit(db, ctx, 'role.deleted', before.id, { key, name: before.name });

  return { ok: true as const, deleted: true };
}

/**
 * What happens to current holders when appliesTo changes / 改 appliesTo 时已在担任的人怎么办。
 *
 * ★ Narrow "Engineering" from [human, agent] to [human] while Agents already hold it
 *   and those Agents land in a state that should not exist: still attached in the
 *   database, but with no answer to whether their membership still counts. Better to
 *   refuse now and make the admin deal with them than to leave a set of members whose
 *   status nobody can determine.
 */
async function assertAssigneesStillFit(
  db: Database,
  orgId: string,
  key: string,
  appliesTo: readonly string[],
) {
  const usage = (await roleUsage(db, orgId)).get(key) ?? { human: 0, agent: 0 };
  if (usage.agent > 0 && !appliesTo.includes('agent')) {
    throw fail(
      'VALIDATION_FAILED',
      'role.agents_hold_it',
      `还有 ${usage.agent} 个 Agent 在担任这个角色，不能把它改成「仅人类」。请先把它们改成别的角色。`,
      { params: { count: usage.agent }, details: { key, agents: usage.agent } },
    );
  }
  if (usage.human > 0 && !appliesTo.includes('human')) {
    throw fail(
      'VALIDATION_FAILED',
      'role.humans_hold_it',
      `还有 ${usage.human} 人在担任这个角色，不能把它改成「仅 Agent」。请先把他们改成别的角色。`,
      { params: { count: usage.human }, details: { key, humans: usage.human } },
    );
  }
}

function assertValid(def: RoleDefinition) {
  const errors = validateRoleDefinition(def);
  if (errors.length > 0) {
    /**
     * ★ The per-field validation detail stays in `details.errors` so the UI can show
     *   each one against its field; the headline sentence only reports how many things
     *   are wrong. Joining N Chinese messages with "；" into one line is neither
     *   English on an English screen nor something that maps back to individual fields.
     */
    throw fail(
      'VALIDATION_FAILED',
      'role.invalid_permissions',
      errors.map((e) => e.message).join('；'),
      { params: { count: errors.length }, details: { errors }, },
    );
  }
}

async function load(db: Database, orgId: string, key: string) {
  const [row] = await db
    .select()
    .from(roles)
    .where(and(eq(roles.orgId, orgId), eq(roles.key, key)));
  if (!row) throw notFound('role');
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
 * Role key → permission set, used for authorization / 角色 key → 权限集合。
 *
 * ★ Queried once per request; the result hangs off the actor (see resolveActor in
 *   rbac.ts).
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
       * ★ Drop permission names the code does not recognize. Roles are data: a row may
       *   have been written by an older version, or a permission may have been removed
       *   since. Carried through as-is, `includes` would never match — silent failure
       *   already — but worse, the unknown name would show up in "what can this role
       *   do", leaving someone convinced the grant worked.
       */
      (r.permissions as string[]).filter((p): p is Permission => known.has(p)),
    ]),
  );
}
