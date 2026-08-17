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
import { ApiError } from './errors';

/**
 * 授权闸门 —— docs/tech/09-security.md §2.1 的 ①② 层在 HTTP 上的落地。
 *
 * ★★ 判定规则本身在 `@apos/domain` 的权限目录里，这个文件只做三件事：
 *   1. 把「谁在调用」查出来（组织角色 + 在目标项目里的角色 + 资源归属）；
 *   2. 定义路由怎么声明它要什么权限（`config.auth`，见 {@link RouteAuth}）；
 *   3. 保证**没有一条写路由能不声明就上线**。
 *
 * ★ 第 3 条是这个文件存在的主要理由。
 *
 *   §2.1.1 已经论证过：这类漏洞的成因永远是「漏了一处」。成员关系闸门
 *   靠 URL 形状统一拦截解决了「新路由默认关着」，但权限矩阵做不到 ——
 *   「批准计划要 tech_lead」不可能从 URL 形状推出来，必须一条条声明。
 *
 *   所以改成**启动即失败**：注册路由时如果发现某条写路由没声明，
 *   进程直接起不来。这比任何测试都可靠 —— 忘了声明的人当场就知道，
 *   而不是等某天有人发现 viewer 能改自治等级。
 *
 * ★★ 声明**写在路由自己身上**，不再是这个文件里的一张集中表。
 *
 *   集中表挡得住「忘了加」（启动即失败），挡不住「加错了」：把隔壁那条
 *   路由的权限抄过来，在一千行外的表里和在 handler 旁边，是两种可读性。
 *   对照表还在，但它现在活在 rbac.test.ts 里当**断言**用 ——
 *   钉住每一条的取值，而不是充当运行时的第二个真相。
 */

/** 目录里认识的权限名。角色是数据，写进去的东西未必还认识 —— 见 roles.ts */
const KNOWN_PERMISSIONS = new Set<string>(PERMISSIONS);

/**
 * ★ UUID 的形状单独拿出来拼，不能用别处那个带 `^$` 锚点的
 *   `UUID_RE.source` —— 锚点嵌进来会变成永不匹配的正则，
 *   而「闸门永不触发」的表现恰恰是「一切正常」，最坏的一种失败方式。
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export interface RequestActor extends RbacActor {
  userId: string;
  orgId: string;
  orgRole: OrgRole;
  /** 角色 key —— 可能是内置的六个，也可能是组织自定义的（研发 / 运营…）*/
  projectRole: string | null;
  actorType: ActorType;
  /** 目标项目；组织级路由为 null */
  projectId: string | null;
}

/** 「当前在哪个组织」的请求头。身份走 Authorization: Bearer，组织走这个 */
export const ORG_HEADER = 'x-org-id';

export function orgHeaderOf(req: { headers: Record<string, unknown> }): string | null {
  const raw = req.headers[ORG_HEADER];
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/**
 * 解析「这次请求属于哪个组织」。
 *
 * ★★ 账号可以属于多个组织之后，这件事不再能从账号上读出来 ——
 *   必须由请求显式带上。带来的第一个后果是：**没带头时不能报错**。
 *
 *   老客户端、直接 curl 的脚本、seed 之后第一次打开的页面都不会带，
 *   而那时报 400 的表现是「整个站点白屏」。所以没带就取一个确定的
 *   缺省（按加入时间的第一个组织），并把它回给调用方。
 *
 * ★ 带了但不属于 → 404 而不是 403。403 等于确认「这个组织存在」，
 *   把组织 id 变成可枚举的探针，和项目那一层是同一条理由。
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
    throw new ApiError(
      'UNAUTHENTICATED',
      exists
        ? '这个账号还不属于任何组织。请先创建一个组织，或让管理员把你加进已有组织。'
        : '用户不存在',
      { userId },
    );
  }

  if (requested) {
    const hit = rows.find((r) => r.orgId === requested);
    if (!hit) {
      throw new ApiError('NOT_FOUND', '组织不存在，或当前身份不是它的成员', { orgId: requested });
    }
    return { orgId: hit.orgId, orgRole: (hit.orgRole as OrgRole) ?? 'member' };
  }

  const first = rows[0]!;
  return { orgId: first.orgId, orgRole: (first.orgRole as OrgRole) ?? 'member' };
}

/**
 * 「带的组织不认就退回缺省」——**只给 `/auth/me` 一个端点用**。
 *
 * ★★ 浏览器会一直记着上次选的组织并原样带回来（localStorage 的 apos.orgId）。
 *   那个组织可能已经被删、这个人可能已经被移出去、或者整个库被重建过。
 *   此时严格判定是 404，而这会**锁死**前端：每个请求都带着那个陈旧值，
 *   于是每个请求都 404，包括本该用来纠正它的那些。表现是登录成功但整站空白，
 *   退出重登也没用 —— 陈旧 id 还在 localStorage 里。
 *
 *   `/auth/me` 是打破死锁的地方：「我是谁」根本不需要组织作用域，
 *   它照常回答，并把**真实的** currentOrgId 给前端，让它纠正自己。
 *
 * ★★ 其余端点一律不能用它，包括 `/organizations` ——
 *   带错组织在别处必须是 404，那是多租户边界本身（§2.1.2），
 *   `assertCurrentOrg` 整条防线都建立在上面，
 *   而 404 同时也是「不确认这个组织存在」的那一层。
 *   「一个组织都不属于」仍然照旧抛：那是真的没有作用域，不是陈旧数据。
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
 * 一条路由需要什么权限。
 *
 * `permission` 给函数形态，是因为有一类操作的所需权限取决于**请求内容**
 * 而不是路径：改 Policy 是收紧还是放宽、改状态时有没有勾 overrideGuards。
 * 这类判定必须看过 body 才知道，放在路由表里用函数表达，
 * 好过散落在各 handler 里各写一段。
 */
export type PermissionResolver = (req: FastifyRequest) => Permission | Permission[] | null;

/**
 * 一条路由的鉴权声明，**写在路由自己身上**（`config.auth`）。
 *
 * ★★ 从一张集中表挪到路由旁边，换的是「加路由的人看得见它」。
 *
 *   集中表的问题不是难维护，是**距离**：新增一条写路由要去另一个文件加一行，
 *   而那一行与它保护的东西之间隔着一千行代码。启动即失败挡住了「忘了加」，
 *   但挡不住「加错了」—— 把 `work_item.execute` 抄到隔壁那条路由上，
 *   两处都长得完全正常。声明贴着 handler 时，这种错在 review 里是看得见的。
 *
 * ★ 只有**权限**挪过来了，作用域（项目 / 资源）仍然由 URL 形状推断。
 *
 *   这不是偷懒：URL 形状是**忘不掉**的，而声明可以忘。成员关系闸门必须对
 *   「新路由默认关着」成立，包括读路由 —— 而读路由没有启动检查兜底。
 *   把作用域也改成声明式，等于把一条不依赖人记性的防线换成依赖人记性的。
 *
 * The auth declaration lives on the route itself. Moving it out of a central
 * table buys proximity: the table could not be forgotten (startup fails), but
 * it could be filled in wrong, and a permission copied onto the neighbouring
 * route looks perfectly normal in both places. Scope stays URL-derived on
 * purpose — URL shape cannot be forgotten, and the membership gate has to hold
 * for read routes too, which no startup check covers.
 */
export interface RouteAuth {
  /**
   * 这条路由要什么权限。
   *
   * - 字符串 / 数组：静态
   * - 函数：取决于请求内容（勾没勾 overrideGuards、是收紧还是放宽）
   * - `deferred(...)`：由 handler 逐个资源判，必须写理由
   */
  permission?: Permission | Permission[] | PermissionResolver | { deferred: string };
  /**
   * 资源级角色补充（`agent_owner` 这类）。
   *
   * ★ 与 preHandler 用**同一个**主体：两边算出不同的角色，会出现
   *   「闸门放行了、里层又拦下」这种没人看得懂的 403。
   */
  context?: ContextResolver;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: RouteAuth;
  }
}

/**
 * 「这条路由的权限由 handler 自己判」。
 *
 * ★ 唯一合法的用法：一次请求跨多个项目，权限必须逐个资源判
 *   （批量批准就是这样 —— 十条决策可能属于十个项目，
 *   闸门在 URL 上看不出任何一个）。
 *
 * ★ 必须写理由，理由会跟着出现在路由清单里。这不是形式：
 *   「先 deferred 着回头补」是这套启动即失败机制唯一的绕过方式，
 *   让绕过带上一句必须当场写出来的解释，成本刚好够让人先想一想。
 */
export function deferred(why: string): { deferred: string } {
  return { deferred: why };
}

/**
 * ★ 豁免清单。加进来必须有理由，理由会出现在启动日志里。
 *
 *   `agent-callback` 用的是 Run 级令牌（§1.1），它的鉴权在 handler 里
 *   （校验 runToken），不走人类身份这条路 —— 这正是 §1.2「Agent 绝不
 *   借用人类身份」的体现，不是遗漏。
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
   * ★ 唯一一条「还没有组织」时也要能走通的写路由：四层判定的第①层
   *   在这一刻没有输入。它开的是一个空的新组织，进不到别人的边界里。
   */
  {
    method: 'POST',
    pattern: /^\/api\/v1\/organizations$/,
    why: '建组织时还不存在"在哪个组织里"，四层判定的第①层没有输入 —— 门槛只有"是不是一个登录账号"，在 handler 里判',
  },
];


/**
 * 资源级角色的解析（§2.2 的 `agent_owner`）。
 *
 * ★ Agent 是**组织级**资源，它的路由 URL 里没有项目 id ——
 *   光靠成员关系闸门解析不出调用者的项目角色，于是 §2.3 里
 *   「终止 Run 需要 tech_lead / pm / agent_owner」的前两个角色会落空，
 *   只剩 owner 和组织管理员能动。这里把角色补回来：
 *   Agent 参与了哪些项目是查得到的（project_members 里 Agent 与人类同表），
 *   调用者在那些项目里的角色就是他对这个 Agent 的角色。
 */
export type ContextResolver = (
  req: FastifyRequest,
  ctx: { db: Database; userId: string },
) => Promise<Partial<RbacActor>>;

/** 角色强弱序。跨项目取最强的那个 —— 见 highestRoleOverAgent 的说明 */
const ROLE_RANK: Record<string, number> = {
  viewer: 0,
  executor: 1,
  member: 2,
  sponsor: 3,
  pm: 4,
  tech_lead: 5,
};


/**
 * ★ 供路由声明使用：`config.auth.context` 里直接引用它。
 *   Agent 是组织级资源，URL 里没有项目 id —— 光靠成员关系闸门解析不出
 *   调用者的项目角色，于是「终止 Run 要 tech_lead / pm / agent_owner」
 *   的前两个角色会落空，只剩 owner 与组织管理员能动。
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

/** Run 自带 projectId，成员关系闸门已经解析出项目角色，只差 owner */
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
 * 调用者在「这个 Agent 参与的项目」里的最强角色。
 *
 * ★ 取最强而不是逐项目判：一个人在 A 项目是 tech_lead、B 项目是 member，
 *   而这个 Agent 两个项目都在跑 —— 他对这个 Agent 就是 tech_lead。
 *   反过来按最弱算的话，管理者会发现自己管不了自己项目里的 Agent。
 *
 * ★ 只用于 Agent 这类组织级资源。项目内的判定一律用 URL 上那个项目的角色，
 *   不走这条路 —— 否则一个项目的 tech_lead 就能操作另一个项目的数据。
 */
async function highestRoleOverAgent(
  db: Database,
  userId: string,
  agentId: string,
): Promise<string | null> {
  /**
   * ★ 「这个 Agent 属于哪些项目」有两个来源，缺一不可：
   *   - 显式登记（project_members 里 actor_type='agent' 的行）；
   *   - 它实际跑过的项目（agent_runs.project_id）。
   *
   *   只看第一个的话，一个从没被显式登记、但已经在项目里跑了三个月的
   *   Agent，对这个项目的 tech_lead 是「不属于任何项目」—— 于是
   *   §2.3 的「扩大 Agent 权限需 tech_lead」落空，只剩组织管理员做得了。
   *   实际在哪跑就是实际属于哪，这是最不容易骗人的判据。
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
   * ★ 自定义角色（研发 / 运营…）不在这张强弱表里，直接跳过。
   *
   *   这条路径只服务于「Agent 这类组织级资源，URL 上看不出项目」的场景，
   *   而 §2.3 在那里点名的是 tech_lead / pm / agent_owner —— 都是内置角色。
   *   拿自定义角色去比强弱没有意义：它们的权限集合各不相同，排不出序。
   *   真正的判定走的是权限集合那一步（check 的④），不受这里影响。
   */
  let best: string | null = null;
  for (const row of mine) {
    const rank = ROLE_RANK[row.role];
    if (rank === undefined) continue;
    if (best === null || rank > (ROLE_RANK[best] ?? -1)) best = row.role;
  }
  return best;
}

/** 从 URL 反查项目 id 用的形状，与成员关系闸门同源 */
export const PROJECT_SCOPED_URL = new RegExp(`^/api/v1/projects/(${UUID})(?:/|$)`, 'i');
export const RESOURCE_SCOPED_URL = new RegExp(
  `^/api/v1/(work-items|runs|decisions|plans|requirements|clarifications|policies|integrations|sync-conflicts|artifacts|assumptions)/(${UUID})(?:/|$)`,
  'i',
);

export interface RbacDeps {
  db: Database;
  /** 资源 id → 所属项目。由 routes.ts 提供，那里已经有一份登记表 */
  projectOfResource: (kind: string, id: string) => Promise<string | null>;
  /** 取当前身份，取不到就抛 401。身份来自 Authorization: Bearer 的 JWT（§1.3） */
  requireUserId: (req: FastifyRequest) => string;
}

export function createRbac({ db, projectOfResource, requireUserId }: RbacDeps) {
  /**
   * 调用者画像。
   *
   * ★ 结果挂在 req 上缓存：一次请求里成员关系闸门、权限判定、
   *   handler 里的二次判定都要用，各查一遍就是三趟数据库。
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
     * ★ 角色与它的权限一起查出来（一次 join）。
     *
     *   角色是数据（组织可自定义研发 / 运营 / 测试…），所以「这个角色能做什么」
     *   不再是代码里的常量，必须读库。内置角色也走同一条路 ——
     *   两条路会分叉，而分叉的表现是「自定义角色和内置角色行为不一致」。
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
      /** MVP 只有人类身份走到这里；Agent 回调是另一条鉴权路径（§1.2）*/
      actorType: 'human',
      projectId,
    };
    (req as { rbacActor?: RequestActor }).rbacActor = actor;
    return actor;
  }

  /**
   * ②层：能不能接触这个项目的数据。
   *
   * ★ 非成员回 404 而不是 403 —— 403 等于确认「这个项目存在」，
   *   把项目 id 变成可枚举的探针。文案保持「或」，不确认存在性，
   *   但要给出路：被分享链接的人得知道该去切换身份。
   *
   * ★ 同组织的组织管理员放行（§2.2「org_admin：全部」）。
   *   跨组织的不行 —— 管理员的「全部」以组织为界，
   *   多租户实例上越界就是数据泄露。
   */
  async function assertProjectAccess(req: FastifyRequest, projectId: string, userId: string) {
    const actor = await projectAccess(req, projectId, userId);
    if (actor) return actor;

    throw new ApiError(
      'NOT_FOUND',
      '项目不存在，或当前身份没有访问权限。可以试试切换右上角的身份',
      { projectId },
    );
  }

  /**
   * 同一条判定的**不抛版本**：有权限回 actor，没有回 null。
   *
   * ★ SSE 要逐频道判（一次连接可能带十个频道），没权限的那几个要剔掉
   *   而不是让整条流失败 —— 那是个是非题，就让它回是非，
   *   不必拿异常当分支用。判定逻辑只有这一份，两个入口共用，
   *   否则迟早分叉成「REST 拦得住、SSE 拦不住」。
   *
   * The non-throwing form of the same check. SSE authorizes channel by
   * channel and drops the ones that fail, so it needs a yes/no answer rather
   * than an exception. Both entry points share this single implementation —
   * two copies would eventually diverge into "REST blocks it, SSE does not".
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
   * ①层：有没有资格做这件事。
   *
   * 传 `resourceOwner` 表示调用者是目标资源的 owner（`agent_owner`）——
   * 这是 §2.2 里唯一不来自 project_members 的角色。
   */
  function assertPermission(
    actor: RbacActor,
    permission: Permission,
    details: Record<string, unknown> = {},
  ) {
    const verdict = check(actor, permission);
    if (verdict.allowed) return;
    throw new ApiError('FORBIDDEN', verdict.reason ?? '权限不足', {
      permission,
      projectRole: actor.projectRole,
      ...details,
    });
  }

  /** 目标 Agent 是不是调用者的 —— agent_owner 判定的数据来源 */
  async function ownsAgent(userId: string, agentId: string): Promise<boolean> {
    const [row] = await db
      .select({ ownerId: agents.ownerId })
      .from(agents)
      .where(eq(agents.id, agentId));
    return row?.ownerId === userId;
  }

  /**
   * 针对某个 Agent 的判定主体。
   *
   * ★ handler 里还要再判一次（扩大 / 收紧权限是两档），必须和 preHandler
   *   用同一个主体 —— 两边算出不同的角色，就会出现「闸门放行了、
   *   里层又拦下」这种没人看得懂的 403。
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
   * ★★ 一次请求的完整闸门：解析身份 → ②层项目成员 → ①层权限矩阵。
   *
   *   顺序不能换。先判成员关系是因为「不是成员」要回 404 不确认存在性；
   *   先回 403 会把项目 id 变成可枚举的探针。
   *
   * ★ 不属于这两类的路由（`/users`、`/runtimes`、身份可选的列表）
   *   原样放过 —— 它们各自在 handler 里按需要身份，闸门在这里
   *   强求身份只会把「首次访问还没选身份」变成一屏错误。
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
      // 资源不存在时不在这里报 404：让 handler 去说「决策不存在」
      // 这类更准确的话，闸门只管「存在但不属于你」
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
 * 这条路由此刻要哪几条权限。
 *
 * ★ 空数组表示「不需要额外权限」——成员关系闸门已经够了。
 *   `deferred` 也返回空数组，但它与「不需要」不是一回事：见 {@link isDeferredAuth}。
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
 * 需要身份、但权限交给 handler 判的路由。
 *
 * ★ 闸门仍然要认出它们：不认的话，deferred 路由会变成
 *   「连身份都不要」的匿名端点 —— 那比不判权限严重得多。
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
 * ★★ 启动即失败：没登记权限的写路由让进程起不来。
 *
 *   这条约束换来的是「以后新增的写路由默认是关着的」——
 *   不是靠作者记得加检查，也不是靠 review 的时候有人想起来。
 *   代价只是加路由时多改一处，而漏加的代价是一个安静的越权口子。
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
   * ★★ 声明清单从**注册时实际看到的**路由收集，不是另存一张表。
   *
   *   另存一张表就又回到了「两份真相」—— 而这次重构整件事就是为了消灭它。
   *   测试拿它来钉住「哪条路由要哪条权限」：声明搬了家，那张对照表
   *   仍然要有人看着，只是它现在是**断言**而不是运行时的第二个真相。
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
