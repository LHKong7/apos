import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  agentRuns,
  agents,
  organizationMembers,
  projectMembers,
  projects,
  roles,
  users,
  type Database,
} from '@apos/db';
import { isOrgAdmin, type ActorType, type OrgRole } from '@apos/contracts';
import {
  PERMISSIONS,
  check,
  denyReasonsOf,
  permissionsOf,
  type Permission,
  type RbacActor,
} from '@apos/domain';
import { fail } from './errors';

/**
 * The authorization gate — layers ① and ② of docs/tech/09-security.md §2.1 as they land
 * on HTTP. / 授权闸门 —— docs/tech/09-security.md §2.1 的 ①② 层在 HTTP 上的落地。
 *
 * ★★ The rules themselves live in the permission catalog in `@apos/domain`; this file
 *   only does three things:
 *   1. Look up *who is calling* (org role + role in the target project + resource
 *      ownership);
 *   2. Define how a route declares what it needs (`config.auth`, see {@link RouteAuth});
 *   3. Guarantee that **no write route can ship without a declaration**.
 *
 *   判定规则本身在 `@apos/domain` 的权限目录里，这个文件只做三件事：查出「谁在调用」、
 *   定义路由怎么声明它要什么权限、保证没有一条写路由能不声明就上线。
 *
 * ★ Point 3 is the main reason this file exists.
 *
 *   §2.1.1 already made the argument: holes of this kind always come from *one place that
 *   was missed*. The membership gate solves "a new route is closed by default" by
 *   intercepting on URL shape alone, but the permission matrix cannot — "approving a plan
 *   requires tech_lead" is not derivable from a URL, so it has to be declared route by
 *   route.
 *
 *   Hence **fail at startup**: if a write route is registered without a declaration, the
 *   process refuses to boot. That is more reliable than any test — whoever forgot finds
 *   out on the spot, rather than someone discovering one day that a viewer can change the
 *   autonomy level.
 *
 *   第 3 条是这个文件存在的主要理由：这类漏洞的成因永远是「漏了一处」，而权限矩阵推不出
 *   URL 形状，所以改成启动即失败 —— 忘了声明的人当场就知道。
 *
 * ★★ The declaration **lives on the route itself**, no longer in a central table here.
 *
 *   A central table stops "forgot to add it" (startup fails) but not "added the wrong
 *   one": copying the neighboring route's permission reads very differently in a table a
 *   thousand lines away than it does next to the handler. The cross-reference table still
 *   exists, but it now lives in rbac.test.ts as an **assertion** — pinning down every
 *   entry rather than serving as a second runtime source of truth.
 *
 *   声明写在路由自己身上，不再是这个文件里的集中表；对照表移到 rbac.test.ts 里当断言用。
 */

/**
 * Permission names the catalog knows. Roles are data, so what was written into one may
 * no longer be recognized here — see roles.ts.
 */
const KNOWN_PERMISSIONS = new Set<string>(PERMISSIONS);

/**
 * ★ The UUID shape is spelled out here on purpose; it cannot reuse the `UUID_RE.source`
 *   from elsewhere, which carries `^$` anchors — embedding those mid-pattern yields a
 *   regex that never matches, and a gate that never fires looks exactly like "everything
 *   is fine", the worst possible failure mode.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export interface RequestActor extends RbacActor {
  userId: string;
  orgId: string;
  orgRole: OrgRole;
  /** Role key — one of the six built-ins, or one the org defined itself (dev / ops / …) */
  projectRole: string | null;
  actorType: ActorType;
  /** Target project; null for org-level routes */
  projectId: string | null;
}

/** Which org this request is in. Identity rides Authorization: Bearer, the org rides this */
export const ORG_HEADER = 'x-org-id';

export function orgHeaderOf(req: { headers: Record<string, unknown> }): string | null {
  const raw = req.headers[ORG_HEADER];
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/**
 * Resolve which organization this request belongs to.
 *
 * ★★ Once an account can belong to several orgs, this can no longer be read off the
 *   account — the request has to state it. The first consequence: **a missing header must
 *   not be an error**.
 *
 *   Old clients, a script hitting the API with curl, and the first page load after a seed
 *   all send nothing, and answering 400 there shows up as a blank site. So a missing
 *   header falls back to a deterministic default (the first org by join time), and that
 *   choice is handed back to the caller.
 *
 * ★ Header present but the caller is not a member → 404, not 403. A 403 confirms "this
 *   org exists", turning org ids into an enumerable probe — same reasoning as the project
 *   layer.
 *
 *   没带组织头时取按加入时间的第一个组织并回传给调用方；带了但不属于回 404 而不是 403，
 *   403 等于确认这个组织存在。
 */
export async function resolveCurrentOrg(
  db: Database,
  userId: string,
  requested: string | null,
): Promise<{ orgId: string; orgRole: OrgRole }> {
  const rows = await db
    .select({ orgId: organizationMembers.orgId, orgRole: organizationMembers.orgRole })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, userId))
    .orderBy(asc(organizationMembers.addedAt), asc(organizationMembers.orgId));

  if (rows.length === 0) {
    const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
    /** ★ Two codes: "account exists but has no org" vs "account is gone" — different fixes */
    throw exists
      ? fail(
          'UNAUTHENTICATED',
          'org.no_membership_yet',
          '这个账号还不属于任何组织。请先创建一个组织，或让管理员把你加进已有组织。',
          { details: { userId } },
        )
      : fail('UNAUTHENTICATED', 'auth.account_gone', '用户不存在', { details: { userId } });
  }

  if (requested) {
    const hit = rows.find((r) => r.orgId === requested);
    if (!hit) {
      throw fail(
        'NOT_FOUND',
        'org.not_a_member',
        '组织不存在，或当前身份不是它的成员',
        { details: { orgId: requested } },
      );
    }
    return { orgId: hit.orgId, orgRole: (hit.orgRole as OrgRole) ?? 'member' };
  }

  const first = rows[0]!;
  return { orgId: first.orgId, orgRole: (first.orgRole as OrgRole) ?? 'member' };
}

/**
 * "If the org that was sent is not recognized, fall back to the default" — **for the
 * `/auth/me` endpoint only**.
 *
 * ★★ The browser keeps remembering the last org that was picked and sends it back
 *   verbatim (localStorage's apos.orgId). That org may have been deleted, this person may
 *   have been removed from it, or the whole database may have been rebuilt. Strict
 *   handling answers 404, and that **deadlocks** the frontend: every request carries the
 *   stale value, so every request 404s — including the ones that were supposed to correct
 *   it. The symptom is a successful login onto a blank site, and logging out and back in
 *   does not help, because the stale id is still sitting in localStorage.
 *
 *   `/auth/me` is where the deadlock breaks: "who am I" needs no org scope at all, so it
 *   answers as usual and hands back the **real** currentOrgId for the client to correct
 *   itself with.
 *
 * ★★ No other endpoint may use this, `/organizations` included. Sending the wrong org
 *   anywhere else must be a 404: that is the multi-tenant boundary itself (§2.1.2),
 *   `assertCurrentOrg` builds its entire defense on it, and 404 is also the layer that
 *   declines to confirm the org exists. "Belongs to no org at all" still throws as
 *   before — that is a genuine absence of scope, not stale data.
 *
 *   宽松解析只给 `/auth/me` 用：浏览器会一直带回陈旧的 orgId，严格判定下每个请求都会 404，
 *   包括本该纠正它的那些，表现是登录成功但整站空白。其余端点一律 404，那是多租户边界本身。
 */
export async function resolveCurrentOrgLenient(
  db: Database,
  userId: string,
  requested: string | null,
): Promise<{ orgId: string; orgRole: OrgRole }> {
  try {
    return await resolveCurrentOrg(db, userId, requested);
  } catch (err) {
    if (requested === null) throw err;
    return resolveCurrentOrg(db, userId, null);
  }
}

/**
 * What permission a route requires.
 *
 * `permission` accepts a function because one class of operations derives its requirement
 * from the **request body** rather than the path: whether a Policy edit tightens or
 * loosens, whether a status change ticked overrideGuards. Those can only be decided after
 * reading the body, and expressing that as a function in the route declaration beats
 * scattering the same snippet across handlers.
 */
export type PermissionResolver = (req: FastifyRequest) => Permission | Permission[] | null;

/**
 * A route's auth declaration, **written on the route itself** (`config.auth`).
 *
 * ★★ Moving it from a central table to sit beside the route buys one thing: whoever adds
 *   a route can see it.
 *
 *   The trouble with the central table was never maintenance, it was **distance**: adding
 *   a write route meant adding a line in another file, a thousand lines away from the
 *   thing that line protects. Fail-at-startup blocks "forgot to add it" but not "added
 *   the wrong one" — copy `work_item.execute` onto the neighboring route and both places
 *   look perfectly normal. With the declaration hugging the handler, that mistake is
 *   visible in review.
 *
 * ★ Only the **permission** moved over; scope (project / resource) is still derived from
 *   URL shape.
 *
 *   That is not laziness: URL shape **cannot be forgotten**, a declaration can. The
 *   membership gate has to hold "a new route is closed by default" for read routes too —
 *   and read routes have no startup check behind them. Making scope declarative as well
 *   would trade a defense that does not depend on human memory for one that does.
 *
 *   鉴权声明写在路由自己身上，换的是「加路由的人看得见它」；只有权限挪了过来，作用域仍由
 *   URL 形状推断 —— URL 形状忘不掉，而读路由没有启动检查兜底。
 */
export interface RouteAuth {
  /**
   * What this route requires.
   *
   * - string / array: static
   * - function: depends on the request body (was overrideGuards ticked, is this a
   *   tightening or a loosening)
   * - `deferred(...)`: judged per resource inside the handler; a reason is mandatory
   */
  permission?: Permission | Permission[] | PermissionResolver | { deferred: string };
  /**
   * Resource-level role supplement (`agent_owner` and its kind).
   *
   * ★ Uses the **same** subject as the preHandler: if the two compute different roles you
   *   get a 403 nobody can explain — the gate let the request through and the inner check
   *   turned it away.
   */
  context?: ContextResolver;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: RouteAuth;
  }
}

/**
 * "The permission for this route is judged by the handler itself."
 *
 * ★ The one legitimate use: a single request spanning several projects, where permission
 *   has to be judged per resource (bulk approval is exactly that — ten decisions may
 *   belong to ten projects, and the gate sees none of them in the URL).
 *
 * ★ The reason is mandatory and travels into the route listing. That is not ceremony:
 *   "defer it for now, come back later" is the only way around fail-at-startup, and
 *   making the bypass carry an explanation that has to be written on the spot costs just
 *   enough to make someone think first.
 */
export function deferred(why: string): { deferred: string } {
  return { deferred: why };
}

/**
 * ★ The exemption list. An entry needs a reason, and the reason shows up in the startup
 *   log.
 *
 *   `agent-callback` uses a Run-scoped token (§1.1); its authentication happens in the
 *   handler (verifying runToken) and never travels the human-identity path — that is
 *   §1.2, "an Agent never borrows a human identity", in action rather than an omission.
 */
const EXEMPT: Array<{ method: string; pattern: RegExp; why: string }> = [
  { method: '*', pattern: /^\/health$/, why: '存活探针，无身份' },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/auth\/login$/,
    why: '身份的来源本身 —— 要求"先登录才能登录"不成立。它的门槛是邮箱与口令，在 handler 里判',
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/auth\/register$/,
    why: '自助注册：调用时还不存在任何身份。它开的是一个**空的新组织**，进不到别人的边界里；门槛是限流 + 邮箱唯一，在 handler 里判',
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/auth\/password$/,
    why: '改自己的口令，作用域是调用者自己，与组织角色无关；当前口令在 handler 里验',
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/agent-callback\//,
    why: 'Run 级令牌鉴权（§1.1），不走人类身份',
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/dev\/webhook-sink$/,
    why: '开发用回声端点，由 DEV_WEBHOOK_SINK 开关控制，无副作用',
  },
  /**
   * ★ The one write route that must still work while the caller has no organization: at
   *   that moment layer ① of the four-layer check has no input at all. It opens an empty
   *   new org, so it cannot reach into anyone else's boundary.
   */
  {
    method: 'POST',
    pattern: /^\/api\/v1\/organizations$/,
    why: '建组织时还不存在"在哪个组织里"，四层判定的第①层没有输入 —— 门槛只有"是不是一个登录账号"，在 handler 里判',
  },
];


/**
 * Resolving resource-level roles (§2.2's `agent_owner`).
 *
 * ★ An Agent is an **org-level** resource, so its route URLs carry no project id — the
 *   membership gate alone cannot resolve the caller's project role, which drops the first
 *   two roles out of §2.3's "terminating a Run needs tech_lead / pm / agent_owner" and
 *   leaves only the owner and org admins able to act. This puts the role back: which
 *   projects an Agent takes part in is queryable (project_members holds Agents and humans
 *   in one table), and the caller's role in those projects is their role over this Agent.
 */
export type ContextResolver = (
  req: FastifyRequest,
  ctx: { db: Database; userId: string },
) => Promise<Partial<RbacActor>>;

/** Role strength order. Across projects the strongest one wins — see highestRoleOverAgent */
const ROLE_RANK: Record<string, number> = {
  viewer: 0,
  executor: 1,
  member: 2,
  sponsor: 3,
  pm: 4,
  tech_lead: 5,
};


/**
 * ★ For use in route declarations: reference it straight from `config.auth.context`.
 *   An Agent is an org-level resource and its URL carries no project id — the membership
 *   gate alone cannot resolve the caller's project role, so "terminating a Run needs
 *   tech_lead / pm / agent_owner" loses its first two roles, leaving only the owner and
 *   org admins able to act.
 */
export async function agentContext(
  { db, userId }: { db: Database; userId: string },
  agentId: string,
): Promise<Partial<RbacActor>> {
  const [agent] = await db
    .select({ ownerId: agents.ownerId })
    .from(agents)
    .where(eq(agents.id, agentId));
  if (!agent) return {};
  return {
    resourceOwner: agent.ownerId === userId,
    projectRole: await highestRoleOverAgent(db, userId, agentId),
  };
}

/** A Run carries projectId, so the gate already resolved the project role; only owner is left */
export async function runOwnerContext(
  { db, userId }: { db: Database; userId: string },
  runId: string,
): Promise<Partial<RbacActor>> {
  const [row] = await db
    .select({ ownerId: agents.ownerId })
    .from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(eq(agentRuns.id, runId));
  return row ? { resourceOwner: row.ownerId === userId } : {};
}

/**
 * The caller's strongest role across the projects this Agent takes part in.
 *
 * ★ Strongest rather than per-project: someone is tech_lead in project A and member in
 *   project B, and this Agent runs in both — then they are tech_lead over this Agent.
 *   Taking the weakest instead would leave managers unable to manage the Agents inside
 *   their own project.
 *
 * ★ Only for org-level resources such as Agents. Anything inside a project always uses
 *   the role in the project named by the URL, never this path — otherwise the tech_lead
 *   of one project could operate on another project's data.
 */
async function highestRoleOverAgent(
  db: Database,
  userId: string,
  agentId: string,
): Promise<string | null> {
  /**
   * ★ "Which projects does this Agent belong to" has two sources, and both are required:
   *   - explicit registration (project_members rows with actor_type='agent');
   *   - the projects it has actually run in (agent_runs.project_id).
   *
   *   With only the first, an Agent that was never explicitly registered but has been
   *   running in a project for three months reads as "belongs to no project" to that
   *   project's tech_lead — so §2.3's "widening an Agent's permissions needs tech_lead"
   *   falls through and only an org admin can do it. Where it actually runs is where it
   *   actually belongs, and that is the hardest signal to fake.
   */
  const [registered, ran] = await Promise.all([
    db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(and(eq(projectMembers.actorType, 'agent'), eq(projectMembers.actorId, agentId))),
    db
      .selectDistinct({ projectId: agentRuns.projectId })
      .from(agentRuns)
      .where(eq(agentRuns.agentId, agentId)),
  ]);

  const projectIds = [...new Set([...registered, ...ran].map((r) => r.projectId))];
  if (projectIds.length === 0) return null;

  const mine = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.actorType, 'human'),
        eq(projectMembers.actorId, userId),
        inArray(projectMembers.projectId, projectIds),
      ),
    );

  /**
   * ★ Custom roles (dev / ops / …) are absent from the strength table and are skipped.
   *
   *   This path only serves the "org-level resource such as an Agent, no project visible
   *   in the URL" case, and what §2.3 names there is tech_lead / pm / agent_owner — all
   *   built-ins. Ranking custom roles is meaningless: their permission sets differ from
   *   one another and do not form an order. The real decision happens at the
   *   permission-set step (check's ④), which this does not affect.
   */
  let best: string | null = null;
  for (const row of mine) {
    const rank = ROLE_RANK[row.role];
    if (rank === undefined) continue;
    if (best === null || rank > (ROLE_RANK[best] ?? -1)) best = row.role;
  }
  return best;
}

/** Shapes for recovering a project id from the URL; same source as the membership gate */
export const PROJECT_SCOPED_URL = new RegExp(`^/api/v1/projects/(${UUID})(?:/|$)`, 'i');
export const RESOURCE_SCOPED_URL = new RegExp(
  `^/api/v1/(work-items|runs|decisions|plans|requirements|clarifications|policies|integrations|sync-conflicts|artifacts|assumptions)/(${UUID})(?:/|$)`,
  'i',
);

export interface RbacDeps {
  db: Database;
  /** Resource id → owning project. Supplied by routes.ts, which already keeps that registry */
  projectOfResource: (kind: string, id: string) => Promise<string | null>;
  /** The current identity, or throw 401. It comes from the Authorization: Bearer JWT (§1.3) */
  requireUserId: (req: FastifyRequest) => string;
}

export function createRbac({ db, projectOfResource, requireUserId }: RbacDeps) {
  /**
   * A picture of the caller.
   *
   * ★ The result is cached on the request: within one request the membership gate, the
   *   permission check, and the handler's second check all need it, and querying
   *   separately would be three round trips to the database.
   */
  async function resolveActor(
    req: FastifyRequest,
    userId: string,
    projectId: string | null,
  ): Promise<RequestActor> {
    const cache = (req as { rbacActor?: RequestActor }).rbacActor;
    if (cache && cache.userId === userId && cache.projectId === projectId) return cache;

    const user = await resolveCurrentOrg(db, userId, orgHeaderOf(req));

    /**
     * ★ The role and its permissions are read together (a single join).
     *
     *   Roles are data (an org can define dev / ops / qa / …), so "what can this role do"
     *   is no longer a constant in code and has to be read from the database. Built-in
     *   roles take the same path — two paths would drift apart, and the symptom of that
     *   drift is custom roles behaving differently from built-in ones.
     */
    let projectRole: string | null = null;
    let grantedPermissions: Permission[] | undefined;
    if (projectId) {
      const [membership] = await db
        .select({ role: projectMembers.role, permissions: roles.permissions })
        .from(projectMembers)
        .leftJoin(
          roles,
          and(eq(roles.orgId, projectMembers.orgId), eq(roles.key, projectMembers.role)),
        )
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.actorType, 'human'),
            eq(projectMembers.actorId, userId),
          ),
        );
      projectRole = membership?.role ?? null;
      grantedPermissions = membership?.permissions
        ? (membership.permissions as string[]).filter((p): p is Permission =>
            KNOWN_PERMISSIONS.has(p),
          )
        : undefined;
    }

    const actor: RequestActor = {
      userId,
      orgId: user.orgId,
      orgRole: (user.orgRole as OrgRole) ?? 'member',
      projectRole,
      grantedPermissions,
      /** In the MVP only human identities reach here; Agent callbacks authenticate elsewhere (§1.2) */
      actorType: 'human',
      projectId,
    };
    (req as { rbacActor?: RequestActor }).rbacActor = actor;
    return actor;
  }

  /**
   * Layer ②: may the caller touch this project's data at all.
   *
   * ★ Non-members get 404 rather than 403 — a 403 confirms "this project exists" and
   *   turns project ids into an enumerable probe. The wording keeps its "or" so it
   *   confirms nothing, yet still offers a way out: someone who was handed a shared link
   *   needs to know to switch identity.
   *
   * ★ Org admins of the same org pass (§2.2, "org_admin: everything"). Admins of another
   *   org do not — an admin's "everything" stops at the org boundary, and crossing it on
   *   a multi-tenant instance is a data leak.
   */
  async function assertProjectAccess(req: FastifyRequest, projectId: string, userId: string) {
    const actor = await projectAccess(req, projectId, userId);
    if (actor) return actor;

    throw fail(
      'NOT_FOUND',
      'project.not_visible',
      '项目不存在，或当前身份没有访问权限。可以试试切换右上角的身份',
      { details: { projectId } },
    );
  }

  /**
   * The **non-throwing** form of the same check: the actor when allowed, null when not.
   *
   * ★ SSE authorizes channel by channel (one connection may carry ten channels) and has
   *   to drop the ones that fail instead of failing the whole stream — it is a yes/no
   *   question, so let it answer yes/no rather than using exceptions as branches. There
   *   is exactly one implementation and both entry points share it; two copies would
   *   eventually diverge into "REST blocks it, SSE does not".
   *
   *   同一条判定的不抛版本：SSE 要逐频道判，没权限的剔掉而不是让整条流失败；判定逻辑
   *   只有这一份，两个入口共用。
   */
  async function projectAccess(
    req: FastifyRequest,
    projectId: string,
    userId: string,
  ): Promise<RequestActor | null> {
    const actor = await resolveActor(req, userId, projectId);
    if (actor.projectRole) return actor;

    if (isOrgAdmin(actor.orgRole)) {
      const [project] = await db
        .select({ orgId: projects.orgId })
        .from(projects)
        .where(eq(projects.id, projectId));
      if (project && project.orgId === actor.orgId) return actor;
    }

    return null;
  }

  /**
   * Layer ①: is the caller entitled to do this at all.
   *
   * Passing `resourceOwner` says the caller owns the target resource (`agent_owner`) —
   * the one role in §2.2 that does not come from project_members.
   */
  function assertPermission(
    actor: RbacActor,
    permission: Permission,
    details: Record<string, unknown> = {},
  ) {
    const verdict = check(actor, permission);
    if (verdict.allowed) return;
    throw fail('FORBIDDEN', 'auth.forbidden', verdict.reason ?? '权限不足', {
      details: { permission, projectRole: actor.projectRole, ...details },
    });
  }

  /** Does the caller own the target Agent — the data behind the agent_owner check */
  async function ownsAgent(userId: string, agentId: string): Promise<boolean> {
    const [row] = await db
      .select({ ownerId: agents.ownerId })
      .from(agents)
      .where(eq(agents.id, agentId));
    return row?.ownerId === userId;
  }

  /**
   * The subject used to judge actions against one particular Agent.
   *
   * ★ The handler checks again (widening and tightening permissions are two different
   *   bars) and must use the same subject as the preHandler — if the two compute
   *   different roles you get a 403 nobody can explain: the gate let the request through
   *   and the inner check turned it away.
   */
  async function subjectForAgent(
    req: FastifyRequest,
    userId: string,
    agentId: string,
  ): Promise<RbacActor> {
    const actor = await resolveActor(req, userId, null);
    return { ...actor, ...(await agentContext({ db, userId }, agentId)) };
  }

  /**
   * ★★ The complete gate for one request: resolve identity → layer ② project membership →
   *   layer ① permission matrix.
   *
   *   The order is fixed. Membership comes first because "not a member" has to answer 404
   *   without confirming existence; answering 403 first would turn project ids into an
   *   enumerable probe.
   *
   * ★ Routes in neither class (`/users`, `/runtimes`, listings where identity is optional)
   *   pass through untouched — each asks for identity in its own handler as needed, and
   *   demanding identity here would turn "first visit, no identity picked yet" into a
   *   screenful of errors.
   */
  async function guard(req: FastifyRequest): Promise<RequestActor | null> {
    const path = req.url.split('?')[0] ?? '';
    if (isExempt(req.method, path)) return null;

    const auth = req.routeOptions?.config?.auth;
    const required = permissionsOfAuth(auth, req);
    const needsIdentity = required.length > 0 || isDeferredAuth(auth);

    let projectId: string | null = null;
    const inProject = PROJECT_SCOPED_URL.exec(path);
    if (inProject) {
      projectId = inProject[1]!;
    } else if (RESOURCE_SCOPED_URL.test(path)) {
      const onResource = RESOURCE_SCOPED_URL.exec(path)!;
      // A missing resource is not a 404 here: let the handler say the more precise thing
      // ("decision not found"). The gate only covers "it exists but is not yours".
      projectId = await projectOfResource(onResource[1]!.toLowerCase(), onResource[2]!);
      if (projectId === null && !needsIdentity) return null;
    } else if (!needsIdentity) {
      return null;
    }

    const userId = requireUserId(req);
    const actor = projectId
      ? await assertProjectAccess(req, projectId, userId)
      : await resolveActor(req, userId, null);

    if (required.length === 0) return actor;

    const subject: RbacActor = auth?.context
      ? { ...actor, ...(await auth.context(req, { db, userId })) }
      : actor;

    for (const permission of required) assertPermission(subject, permission);
    return actor;
  }

  return {
    guard,
    resolveActor,
    assertProjectAccess,
    projectAccess,
    assertPermission,
    ownsAgent,
    subjectForAgent,
    permissionsOf,
    denyReasonsOf,
  };
}

export type Rbac = ReturnType<typeof createRbac>;

/**
 * Which permissions this route requires right now.
 *
 * ★ An empty array means "no extra permission needed" — the membership gate is enough.
 *   `deferred` also returns an empty array, but it does not mean the same thing: see
 *   {@link isDeferredAuth}.
 */
export function permissionsOfAuth(
  auth: RouteAuth | undefined,
  req: FastifyRequest,
): Permission[] {
  const rule = auth?.permission;
  if (rule === undefined) return [];
  if (typeof rule === 'object' && !Array.isArray(rule)) return []; // deferred
  const resolved = typeof rule === 'function' ? rule(req) : rule;
  if (resolved === null) return [];
  return Array.isArray(resolved) ? resolved : [resolved];
}

/**
 * Routes that need an identity but leave the permission to the handler.
 *
 * ★ The gate still has to recognize them: if it did not, a deferred route would turn into
 *   an anonymous endpoint that does not even require identity — far worse than skipping
 *   the permission check.
 */
export function isDeferredAuth(auth: RouteAuth | undefined): boolean {
  const rule = auth?.permission;
  return typeof rule === 'object' && rule !== null && !Array.isArray(rule) && 'deferred' in rule;
}

export function isExempt(method: string, url: string): string | null {
  const hit = EXEMPT.find((e) => (e.method === '*' || e.method === method) && e.pattern.test(url));
  return hit?.why ?? null;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * ★★ Fail at startup: a write route with no registered permission keeps the process from
 *   booting.
 *
 *   What this constraint buys is "every write route added from now on is closed by
 *   default" — not by the author remembering to add a check, nor by a reviewer happening
 *   to think of it during review. The cost is one extra edit when adding a route; the
 *   cost of forgetting is a quiet privilege-escalation hole.
 */
export function guardRouteCoverage(app: FastifyInstance) {
  const missing: string[] = [];
  const declared: Array<{ method: string; url: string; auth: RouteAuth }> = [];

  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (route.config?.auth) declared.push({ method, url: route.url, auth: route.config.auth });
      if (!MUTATING.has(method)) continue;
      if (isExempt(method, route.url)) continue;
      if (route.config?.auth?.permission === undefined) {
        missing.push(`${method} ${route.url}`);
      }
    }
  });

  /**
   * ★★ The declaration list is collected from the routes **actually seen at registration
   *   time**, not kept in a separate table.
   *
   *   A separate table lands us back at "two sources of truth" — the very thing this
   *   refactor set out to kill. The test uses this list to pin down "which route requires
   *   which permission": the declarations moved house, but that cross-reference still
   *   needs someone looking at it as a whole — it is now an **assertion** rather than a
   *   second runtime truth.
   */
  assertCovered.declarations = () =>
    [...declared].sort((a, b) => `${a.method} ${a.url}`.localeCompare(`${b.method} ${b.url}`));

  function assertCovered() {
    if (missing.length === 0) return;
    throw new Error(
      `以下写路由没有声明 config.auth.permission，等于不设防：\n  ${missing.join('\n  ')}\n` +
        `请在路由注册处补上 { config: { auth: { permission: … } } }；` +
        `确实不需要鉴权的（如回调、探针）加进 apps/api/src/http/rbac.ts 的 EXEMPT 并写明理由。`,
    );
  }

  return assertCovered;
}
