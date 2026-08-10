import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import {
  agentRuns,
  agents,
  artifacts,
  decisionOptions,
  decisions,
  events,
  plans,
  policies,
  projects,
  integrations,
  organizationMembers,
  projectMembers,
  requirementClarifications,
  requirements,
  syncConflicts,
  users,
  workItems,
  type Database,
} from '@apos/db';
import {
  ACTIVE_RUN_STATUSES,
  Action,
  Condition,
  humanActor,
  IntegrationProvider,
  NotificationConfig,
  OrgRole,
  ProjectRole,
  SyncMapping,
  WorkItemStatus,
  type PolicyContext,
} from '@apos/contracts';
import {
  ANALYTICS_RANGES,
  LAYOUTS,
  POLICY_TEMPLATES,
  batchDenyReason,
  check,
  explainPolicy,
  templateById,
  WORK_ITEM_MACHINE,
  availableTriggers,
  manualTriggerFor,
  canIntegration,
  denyReason,
  integrationPermissions,
  type Actor,
  type AnalyticsRange,
  type LayoutKind,
} from '@apos/domain';
import { UnsupportedFeatureError, type RuntimeRegistry } from '@apos/agent-runtimes';
import type { IntegrationRegistry } from '@apos/integrations';
import type { EventBus } from '../modules/event/bus';
import type { PlanningProvider } from '../modules/planning/provider';
import {
  analyzeRequirement,
  answerClarification,
  approveRequirement,
} from '../modules/requirement/service';
import { approvePlan, generatePlan } from '../modules/planning/service';
import { scheduleRound } from '../modules/flow/scheduler';
import { transition } from '../modules/flow/transition';
import { dispatchRun } from '../modules/agent/dispatch';
import type { WorkspaceProvisioner } from '../modules/workspace/provisioner';
import { ingestRunEvent } from '../modules/agent/ingest';
import { emitAndPublish } from '../modules/event/bus';
import {
  ChangePasswordInput,
  CreateAccountInput,
  LoginInput,
  TokenError,
  changeOwnPassword,
  createAccount,
  login,
  tokenFrom,
  verifyToken,
} from '../modules/auth';
import { ApiError, asClientInputError, notFound, sendError } from './errors';
import { listMembers, listOrgUsers, removeMember, setMemberRole, setOrgRole } from './members';
import { createRole, deleteRole, listRoles, updateRole } from './roles';
import {
  createRbac,
  guardRouteCoverage,
  orgHeaderOf,
  resolveCurrentOrg,
  resolveCurrentOrgLenient,
} from './rbac';
import { formatRef, freeIdentifier, IDENTIFIER_RE } from '../modules/work-item/numbering';
import { createWorkItem, WorkItemInput } from './work-items';
import {
  addOrganizationMember,
  createOrganization,
  deleteOrganization,
  listMyOrganizations,
  listOrganizationMembers,
  OrganizationInput,
  OrganizationPatch,
  removeOrganizationMember,
  updateOrganization,
} from './organizations';
import { handleSse } from './sse';
import { getBoard } from './board';
import { getGraph } from './graph';
import { getAnalytics, getAnalyticsItems } from './analytics';
import { getOverview } from './overview';
import { getAgent, listAgents, listRuntimes } from './agents';
import {
  AgentInput,
  createAgent,
  deleteAgent,
  listAgentsAdmin,
  probeAgent,
  updateAgent,
} from './agent-admin';
import {
  ConventionInput,
  createConvention,
  createRepository,
  probeRepository,
  deleteConvention,
  deleteRepository,
  listConventions,
  listRepositories,
  RepositoryInput,
  updateConvention,
  updateRepository,
} from './project-config';
import { batchApprove, getDecisionInbox, type DecisionScope } from './decision-center';
import { comparePlans, getPlanDetail, listRequirements } from './intake';
import { listDeliveries } from '../modules/notification/service';
import {
  autonomyPreview,
  deletePolicy,
  evaluateScenario,
  getPolicies,
  getPolicyHistory,
  getPolicyHits,
  runSimulation,
  savePolicy,
  togglePolicy,
} from './policies';
import { getCostBreakdown, getRunDetail, getRunEvents } from './run-detail';
import {
  createIntegration,
  disconnectImpact,
  disconnectIntegration,
  ingestCiResults,
  linkObject,
  listConflicts,
  listIntegrations,
  resolveConflict,
  runSync,
  updateNotificationConfig,
  updateSyncMapping,
} from './integrations';
import { serializeEvent } from './serialize';

export interface AppDeps {
  db: Database;
  bus: EventBus;
  registry: RuntimeRegistry;
  integrations: IntegrationRegistry;
  provider: PlanningProvider;
  /** 工作区供给；不传则不为 Run 准备代码目录（仅测试用） */
  workspaces?: WorkspaceProvisioner;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LABELS: Record<string, string> = {
  pause: '暂停',
  resume: '恢复',
  terminate: '终止',
  add_constraint: '追加约束',
};

/** 能力不支持时的替代动作，直接告诉用户下一步能做什么 */
const FALLBACK: Record<string, string | null> = {
  pause: '该运行时只能终止。终止不可恢复，确认后请改用「终止」。',
  resume: '该运行时不支持恢复，请改用「重试」创建新 Run。',
  terminate: null,
  add_constraint: '该运行时不支持执行中注入约束，请终止后补充上下文重试。',
};

/**
 * 身份来源：`Authorization: Bearer <JWT>`（docs/tech/09-security.md §1.3）。
 *
 * ★★ 此前这里读的是 `X-User-Id` —— 一个**没有凭证**的头：任何人写上
 *   别人的 uuid 就是别人。整套 RBAC 建立在它之上，因此也就都是摆设。
 *   现在身份必须由服务端签发的令牌证明，userId 从签名过的声明里取，
 *   调用方说了不算。
 *
 * ★ 令牌不合法与没带令牌回同一个 401，但**消息不同**：
 *   「没登录」和「登录过期了」对用户是两件事，前者去登录，
 *   后者知道自己刚才是登着的、不用怀疑账号出了问题。
 */
function actorFrom(req: { headers: Record<string, unknown>; query?: unknown }) {
  const token = tokenFrom(req);
  if (!token) {
    throw new ApiError('UNAUTHENTICATED', '未登录：请求缺少 Authorization: Bearer 令牌');
  }
  try {
    const claims = verifyToken(token);
    if (!UUID_RE.test(claims.sub)) {
      throw new ApiError('UNAUTHENTICATED', '令牌里的身份不是合法的用户 ID');
    }
    return { userId: claims.sub, actor: humanActor(claims.sub) };
  } catch (err) {
    if (err instanceof TokenError) throw new ApiError('UNAUTHENTICATED', err.message);
    throw err;
  }
}

/**
 * 身份可选的端点用这个（列表筛选、看板的「只看需我处理」）。
 *
 * 没带令牌就返回 null，带了就必须合法 —— 「带了但不合法」不能被当成
 * 「没带」静默忽略：用户会看到一个「我的待办为空」的页面，
 * 而真实原因是令牌过期了。
 */
function optionalUserId(req: { headers: Record<string, unknown>; query?: unknown }): string | null {
  if (!tokenFrom(req)) return null;
  return actorFrom(req).userId;
}

/**
 * 角色 key → 内置角色，认不出就是 null。
 *
 * ★ 集成设置那个窄接口（canIntegration）只按内置角色判。自定义角色
 *   在那里退化成「非内置」，但这不会放宽任何东西 —— preHandler 已经
 *   按权限集合判过一次，这里是第二道，只会更严不会更松。
 */
function asBuiltinRole(role: string | null): ProjectRole | null {
  return role !== null && (ProjectRole.options as readonly string[]).includes(role)
    ? (role as ProjectRole)
    : null;
}

function corr(req: { headers: Record<string, unknown> }): string {
  const header = req.headers['x-correlation-id'];
  return typeof header === 'string' ? header : randomUUID();
}

export async function registerRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  /**
   * ★★ 必须在注册任何路由之前挂上：它靠 onRoute 钩子逐条清点，
   *   挂晚了就漏掉前面那些 —— 而「清点器自己漏了」的表现是「一切正常」。
   *   实际断言在函数末尾，那时路由才注册完。
   */
  const assertRoutesCovered = guardRouteCoverage(app);

  app.setErrorHandler((error: unknown, _req, reply) => {
    if (error instanceof ApiError) return sendError(reply, error);
    if (error instanceof ZodError) {
      return sendError(reply, new ApiError('VALIDATION_FAILED', '请求参数不合法', error.issues));
    }
    const fastifyErr = error as { validation?: unknown; statusCode?: number; message?: string };
    if (fastifyErr.validation) {
      return sendError(
        reply,
        new ApiError('VALIDATION_FAILED', '请求参数不合法', fastifyErr.validation),
      );
    }
    // ★ 客户端错误不能被吞成 500 —— 那会让调用方以为是服务端故障
    if (fastifyErr.statusCode && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 500) {
      const code = fastifyErr.statusCode === 429 ? 'RATE_LIMITED' : 'VALIDATION_FAILED';
      return sendError(reply, new ApiError(code, fastifyErr.message ?? '请求不合法'));
    }
    // 同一条纪律的下半段：客户端输错的值要到 SQL 才被发现，
    // 抛出来的是 PostgresError 而不是 fastify 的 4xx，得单独认一下
    const inputErr = asClientInputError(error);
    if (inputErr) {
      app.log.warn({ err: error }, 'client input rejected by database');
      return sendError(reply, inputErr);
    }
    app.log.error({ err: error }, 'unhandled error');
    return sendError(reply, new ApiError('INTERNAL', '服务器内部错误'));
  });

  // 不少 POST 端点本就不需要 body（如 analyze / schedule），
  // 客户端带着 content-type 但空 body 是常见写法，不该报错
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body: string, done) => {
      if (!body || body.trim() === '') return done(null, {});
      try {
        done(null, JSON.parse(body));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.get('/health', async () => ({ ok: true }));

  // ── 登录 ────────────────────────────────────────────────────────────
  /**
   * 用邮箱与口令换一张 JWT（docs/tech/09-security.md §1.3）。
   *
   * ★★ 这是唯一一条不需要身份的写路由，所以它在 rbac 的豁免清单里 ——
   *   要求「先登录才能登录」显然不成立。它自己就是身份的来源。
   *
   * ★ 账号从哪来：第一个（超管）来自 .env，启动时自举
   *   （modules/auth/bootstrap.ts）；其余由组织管理员创建
   *   （POST /api/v1/admin/users）。**没有自助注册** ——
   *   一个能自助注册的实例，等于任何人都能进到某个组织的边界里。
   */
  app.post('/api/v1/auth/login', async (req) => {
    return login(db, LoginInput.parse(req.body));
  });

  /** 当前登录者。前端拿它确认令牌还有效，以及显示"我是谁" */
  app.get('/api/v1/auth/me', async (req) => {
    const { userId } = actorFrom(req);
    const [row] = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        avatarUrl: users.avatarUrl,
        approvalScopes: users.approvalScopes,
      })
      .from(users)
      .where(eq(users.id, userId));
    /**
     * ★ 令牌验过了但人没了（被删号）——  这是 401 不是 404：
     *   对调用方而言结论是「这张令牌不再代表任何人，去重新登录」，
     *   而 404 会被前端当成"某个资源不存在"接着往下走。
     */
    if (!row) throw new ApiError('UNAUTHENTICATED', '账号不存在或已被删除，请重新登录');

    /**
     * ★ 用 lenient 版：这个端点必须能回答「我是谁」，
     *   哪怕请求里带的组织已经不存在了。理由见 rbac.ts 的
     *   {@link resolveCurrentOrgLenient} —— 严格判定会把前端锁死。
     */
    const current = await resolveCurrentOrgLenient(db, userId, orgHeaderOf(req));
    return { user: row, currentOrgId: current.orgId, orgRole: current.orgRole };
  });

  /** 改自己的口令。超管的初始口令来自 .env，登录后应当第一时间改掉 */
  app.post('/api/v1/auth/password', async (req) => {
    const { userId } = actorFrom(req);
    const { orgId } = await resolveCurrentOrg(db, userId, orgHeaderOf(req));
    return changeOwnPassword(
      db,
      { userId, orgId, correlationId: corr(req) },
      ChangePasswordInput.parse(req.body),
    );
  });

  // ── 身份 ────────────────────────────────────────────────────────────
  /**
   * 本组织的人。指派负责人、筛选「谁的任务」都要它。
   *
   * ★★ 必须带身份，而且只返回**同组织**的人。
   *   此前不带身份时会返回全库用户 —— 那是 X-User-Id 时代身份切换器的
   *   自举缺口（第一次打开时得先有一份名单才选得出人）。
   *   现在身份来自登录，这个缺口不再需要，于是它变回它本来的样子：
   *   一个未认证的全局通讯录导出接口。
   */
  app.get('/api/v1/users', async (req) => {
    const { userId } = actorFrom(req);
    const { orgId } = await resolveCurrentOrg(db, userId, orgHeaderOf(req));

    /**
     * ★ 组织角色跟着**归属**走，所以这份名单必须按当前组织 join 出来。
     *   照旧从 users 上读的话，同一个人在别的组织的管理员身份
     *   会被显示成他在这里的身份 —— 而那会让人以为他能批准东西。
     */
    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        avatarUrl: users.avatarUrl,
        orgRole: organizationMembers.orgRole,
        approvalScopes: users.approvalScopes,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(organizationMembers.orgId, orgId))
      .orderBy(users.name);
    return { users: rows };
  });

  /**
   * ★★ 授权闸门 —— docs/tech/09-security.md §2.1 的 ①② 两层。
   *
   *   ② 项目成员：规格写的是四层判定「任一层拒绝即拒绝」，但②层此前只在
   *   集成端点上实现了（assertIntegration），其余项目数据一律没查成员关系。
   *   实测后果：A 组织的用户可以读、也可以写 B 组织项目的看板、执行图、
   *   Analytics、Policy、需求 —— 跨租户数据在应用层是敞开的。
   *
   *   ① 组织/项目角色：成员关系只回答「是不是自己人」，回答不了
   *   「批准计划要 tech_lead」「放宽 Policy 要模拟结果」。权限矩阵（§2.3）
   *   在 rbac.ts 的路由表里逐条登记，写路由漏登记则服务起不来。
   *
   * ★ 做成 preHandler 而不是在四十个 handler 里各写一行，是因为这一类
   *   漏洞的成因就是「漏了一处」。钩子按 URL 形状统一拦截，
   *   以后新增的 /projects/:id/* 路由默认就是关着的，
   *   不需要作者记得加检查。
   */
  /**
   * 调用者能看见的项目 id。
   *
   * ★ 列表类端点（决策收件箱、Agent 花名册）的 URL 里没有项目 id，
   *   按 URL 形状的闸门够不着它们 —— 实测中一个只属于一个项目的用户，
   *   收件箱里能看到三个项目、跨三个组织的决策。这类端点必须自己带上范围。
   */
  async function visibleProjectIds(userId: string): Promise<string[]> {
    const rows = await db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(and(eq(projectMembers.actorType, 'human'), eq(projectMembers.actorId, userId)));
    return rows.map((r) => r.projectId);
  }

  /**
   * 资源 id → 它属于哪个项目。
   *
   * ★ /work-items/:id 这类路径上看不出项目，但它们返回的同样是项目数据，
   *   一样要过②层。加新的资源路由时必须在这里登记 ——
   *   没登记就等于这条路由不设防。
   */
  async function projectOfResource(kind: string, id: string): Promise<string | null> {
    const one = async <T extends { projectId: string | null }>(rows: T[]) =>
      rows[0]?.projectId ?? null;

    switch (kind) {
      case 'work-items':
        return one(await db.select({ projectId: workItems.projectId }).from(workItems).where(eq(workItems.id, id)));
      case 'runs':
        return one(await db.select({ projectId: agentRuns.projectId }).from(agentRuns).where(eq(agentRuns.id, id)));
      case 'decisions':
        return one(await db.select({ projectId: decisions.projectId }).from(decisions).where(eq(decisions.id, id)));
      case 'plans':
        return one(await db.select({ projectId: plans.projectId }).from(plans).where(eq(plans.id, id)));
      case 'requirements':
        return one(await db.select({ projectId: requirements.projectId }).from(requirements).where(eq(requirements.id, id)));
      case 'policies':
        return one(await db.select({ projectId: policies.projectId }).from(policies).where(eq(policies.id, id)));
      case 'integrations':
        return one(await db.select({ projectId: integrations.projectId }).from(integrations).where(eq(integrations.id, id)));
      case 'sync-conflicts':
        return one(await db.select({ projectId: syncConflicts.projectId }).from(syncConflicts).where(eq(syncConflicts.id, id)));
      case 'clarifications': {
        const rows = await db
          .select({ projectId: requirements.projectId })
          .from(requirementClarifications)
          .innerJoin(requirements, eq(requirements.id, requirementClarifications.requirementId))
          .where(eq(requirementClarifications.id, id));
        return one(rows);
      }
      default:
        return null;
    }
  }

  const rbac = createRbac({
    db,
    projectOfResource,
    requireUserId: (req) => actorFrom(req).userId,
  });

  app.addHook('preHandler', async (req) => {
    await rbac.guard(req);
  });

  /** handler 里还要用的成员关系判定（角色本身是 preHandler 已经查过的缓存） */
  async function assertProjectMember(projectId: string, userId: string, req: FastifyRequest) {
    const actor = await rbac.assertProjectAccess(req, projectId, userId);
    return actor.projectRole;
  }

  // ── 项目 ────────────────────────────────────────────────────────────
  /**
   * ★ 只返回调用者是成员的项目。
   *   此前是无条件 `select * from projects`，任何人（含不带身份的请求）
   *   都能拿到全部组织的项目清单。
   */
  app.get('/api/v1/projects', async (req) => {
    const { orgId, userId } = await callerOrg(req);
    /**
     * ★★ 必须同时按**当前组织**收窄，不能只按成员关系。
     *
     *   一个账号能属于多个组织之后，「我是成员的项目」会横跨组织 ——
     *   切到 A 组织却看见 B 组织的项目，而两边都不会报错。
     *   组织是多租户的边界，列表就得停在这条边界上。
     */
    const rows = await db
      .select()
      .from(projects)
      .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
      .where(
        and(
          eq(projects.orgId, orgId),
          eq(projectMembers.actorType, 'human'),
          eq(projectMembers.actorId, userId),
        ),
      )
      .orderBy(desc(projects.updatedAt));
    return { projects: rows.map((r) => r.projects) };
  });

  app.get('/api/v1/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    if (!project) throw notFound('项目');

    const items = await db.select().from(workItems).where(eq(workItems.projectId, id));
    const pending = await db
      .select()
      .from(decisions)
      .where(and(eq(decisions.projectId, id), eq(decisions.status, 'pending')));

    return {
      project,
      metrics: {
        totalTasks: items.length,
        done: items.filter((i) => i.status === 'done').length,
        blocked: items.filter((i) => i.blockedSince).length,
        executing: items.filter((i) => i.status === 'executing').length,
        pendingDecisions: pending.length,
        overdueDecisions: pending.filter((d) => d.dueAt && d.dueAt < new Date()).length,
        costSpent: project.costSpent,
        budget: project.budgetAmount,
      },
    };
  });

  // ── 组织（顶层容器；Plane 里叫 Workspace）────────────────────────────
  /**
   * ★★ 在此之前组织只是一列 `org_id`：表在、外键在、多租户判定也在，
   *   但**没有任何接口能创建、改名或切换它**，唯一的来源是 seed 脚本。
   *   于是「多租户」只在数据库层面成立，产品上是个单租户实例。
   */
  app.get('/api/v1/organizations', async (req) => {
    const { userId } = actorFrom(req);
    const list = await listMyOrganizations(db, userId);
    /**
     * ★ 把「当前是哪个」一并回出去。前端不该自己猜缺省值 ——
     *   猜错的表现是切换器显示 A、实际数据是 B，而两边都没有报错。
     *
     * ★★ 这里**保持严格**：带了但不是成员一律 404，不确认这个组织存在
     *   （见下方 organizations.test.ts 的同名用例）。
     *   陈旧 orgId 的自愈走 `/auth/me` —— 那个端点根本不需要组织作用域，
     *   让它一个人宽容就够了，不必把这条也放开。
     */
    const { orgId } = await resolveCurrentOrg(db, userId, orgHeaderOf(req));
    return { ...list, currentOrgId: orgId };
  });

  app.post('/api/v1/organizations', async (req, reply) => {
    const { userId } = actorFrom(req);
    const body = OrganizationInput.parse(req.body);
    const result = await createOrganization(
      db,
      { actorId: userId, correlationId: corr(req) },
      body,
    );
    return reply.status(201).send(result);
  });

  app.patch('/api/v1/organizations/:id', async (req) => {
    const { orgId, userId } = await callerOrg(req);
    assertCurrentOrg(req, orgId);
    const body = OrganizationPatch.parse(req.body);
    return updateOrganization(db, { orgId, actorId: userId, correlationId: corr(req) }, body);
  });

  app.delete('/api/v1/organizations/:id', async (req) => {
    const { orgId, userId } = await callerOrg(req);
    assertCurrentOrg(req, orgId);
    return deleteOrganization(db, { orgId, actorId: userId, correlationId: corr(req) });
  });

  app.get('/api/v1/organizations/:id/members', async (req) => {
    const { orgId } = await callerOrg(req);
    assertCurrentOrg(req, orgId);
    return listOrganizationMembers(db, orgId);
  });

  app.post('/api/v1/organizations/:id/members', async (req) => {
    const { orgId, userId } = await callerOrg(req);
    assertCurrentOrg(req, orgId);
    const body = z.object({ email: z.string().email(), orgRole: OrgRole.default('member') }).parse(
      req.body,
    );
    return addOrganizationMember(db, { orgId, actorId: userId, correlationId: corr(req) }, body);
  });

  app.delete('/api/v1/organizations/:id/members/:userId', async (req) => {
    const { orgId, userId: actorId } = await callerOrg(req);
    assertCurrentOrg(req, orgId);
    const { userId: targetId } = req.params as { userId: string };
    return removeOrganizationMember(
      db,
      { orgId, actorId, correlationId: corr(req) },
      targetId,
    );
  });

  /**
   * ★★ URL 里的组织必须就是**当前**组织。
   *
   *   权限判定（rbac 的 resolveActor）拿的是当前组织的 orgRole，
   *   如果 handler 转头去改 URL 里的另一个组织，那次判定就白判了 ——
   *   在自己是管理员的 A 组织里发一个指向 B 组织的请求，
   *   就能拿 A 的管理员身份去改 B。这是最典型的一类越权。
   */
  function assertCurrentOrg(req: FastifyRequest, orgId: string) {
    const { id } = req.params as { id?: string };
    if (id && id !== orgId) {
      throw new ApiError(
        'FORBIDDEN',
        '只能操作当前组织。请先切换到目标组织（X-Org-Id）后再试',
        { currentOrgId: orgId, requested: id },
      );
    }
  }

  const CreateProject = z.object({
    name: z.string().min(1),
    goal: z.string().optional(),
    type: z.string().default('development'),
    autonomyLevel: z
      .enum(['human_led', 'agent_led_approval', 'agent_autonomous'])
      .default('agent_led_approval'),
    budgetAmount: z.string().optional(),
    /**
     * 工作项编号的前缀（`ORD` → `ORD-19`）。不传则从项目名推。
     * 组织内唯一 —— 撞车时自动加序号。
     */
    identifier: z
      .string()
      .regex(IDENTIFIER_RE, '前缀只能用大写字母和数字，2–10 位，且以字母开头')
      .optional(),
    /** ★ 不传就是当前组织。传了必须和当前组织一致（见下面的判定）*/
    orgId: z.string().uuid().optional(),
  });

  app.post('/api/v1/projects', async (req, reply) => {
    const { userId } = actorFrom(req);
    const body = CreateProject.parse(req.body);
    const actor = await rbac.resolveActor(req, userId, null);

    /**
     * ★ orgId 以调用者的当前组织为准，不听请求体的。
     *   照抄 body.orgId 的话，任何人都能往别的组织里塞一个项目 ——
     *   而那个项目从此挂在对方的项目列表、对方的成本统计里。
     *
     * ★ 不传则用当前组织。要求前端必须知道自己的 orgId 才能建项目，
     *   是把实现细节变成了它的负担 —— 而这个值服务端本来就有。
     */
    if (body.orgId && body.orgId !== actor.orgId) {
      throw new ApiError('FORBIDDEN', '只能在当前组织下创建项目', {
        orgId: actor.orgId,
      });
    }

    const { orgId: _ignored, identifier, ...fields } = body;
    /**
     * ★ 前缀不能留给默认值。所有项目共用 `TASK` 的话，
     *   `TASK-19` 在组织里指向好几条 —— 而编号存在的全部理由
     *   就是"说出来能指到唯一一条"。
     */
    const prefix = identifier ?? (await freeIdentifier(db, actor.orgId, body.name));
    const [project] = await db
      .insert(projects)
      .values({ ...fields, identifier: prefix, orgId: actor.orgId, techLeadId: userId })
      .returning();

    /**
     * ★★ 创建者必须落成成员，否则他建完就进不去自己的项目 ——
     *   成员关系闸门（§2.1.1）不认 techLeadId 这个字段，只认 project_members。
     *   这类「功能看起来完成了，实际第一步就走不通」的缺口，
     *   只有在权限真的生效之后才暴露得出来。
     */
    await db.insert(projectMembers).values({
      orgId: actor.orgId,
      projectId: project!.id,
      actorType: 'human',
      actorId: userId,
      role: 'tech_lead',
    });

    await emitAndPublish(db, {
      orgId: actor.orgId,
      projectId: project!.id,
      type: 'project.member_added',
      actor: humanActor(userId),
      subjectType: 'user',
      subjectId: userId,
      payload: { from: null, to: 'tech_lead', projectId: project!.id, reason: 'project_creator' },
      correlationId: corr(req),
    });

    return reply.status(201).send({ project });
  });

  // ── 成员与角色（09-security §2.2）────────────────────────────────────
  /**
   * ★ 权限判定本身也要能被看见。
   *
   *   前端不该靠猜哪个按钮能点：一次拿全当前身份在这个项目里的
   *   全部权限与拒绝理由，界面据此灰按钮并给出「该找谁」。
   *   服务端仍然独立判一遍 —— 共用一份规则不等于信任前端。
   */
  app.get('/api/v1/projects/:id/permissions', async (req) => {
    const { userId } = actorFrom(req);
    const { id } = req.params as { id: string };
    const actor = await rbac.resolveActor(req, userId, id);

    return {
      projectId: id,
      userId,
      orgRole: actor.orgRole,
      projectRole: actor.projectRole,
      permissions: rbac.permissionsOf(actor),
      denyReasons: rbac.denyReasonsOf(actor),
    };
  });

  app.get('/api/v1/projects/:id/members', async (req) => {
    const { userId } = actorFrom(req);
    const { id } = req.params as { id: string };
    const actor = await rbac.resolveActor(req, userId, id);
    return listMembers(db, id, actor.orgId);
  });

  /**
   * 指派角色。
   *
   * ★ 路径上的 `:memberId` 既可以是用户 id，也可以是 Agent id ——
   *   由 `actorType` 区分。一个岗位由人还是由 Agent 担任，
   *   在这个产品里是同一个问题的两个答案，不该是两条 API。
   */
  const MemberRoleBody = z.object({
    role: z.string().min(1),
    actorType: z.enum(['human', 'agent']).default('human'),
  });

  app.put('/api/v1/projects/:id/members/:memberId', async (req) => {
    const { userId: actorId } = actorFrom(req);
    const { id, memberId } = req.params as { id: string; memberId: string };
    const body = MemberRoleBody.parse(req.body);

    return setMemberRole(
      db,
      {
        projectId: id,
        actorType: body.actorType,
        targetId: memberId,
        actorId,
        correlationId: corr(req),
      },
      body.role,
    );
  });

  app.delete('/api/v1/projects/:id/members/:memberId', async (req) => {
    const { userId: actorId } = actorFrom(req);
    const { id, memberId } = req.params as { id: string; memberId: string };
    const q = req.query as { actorType?: string };
    return removeMember(db, {
      projectId: id,
      actorType: q.actorType === 'agent' ? 'agent' : 'human',
      targetId: memberId,
      actorId,
      correlationId: corr(req),
    });
  });

  /** 组织通讯录与身份管理（§2.2「org_admin：身份管理」）*/
  app.get('/api/v1/admin/users', async (req) => {
    const { orgId } = await callerOrg(req);
    return listOrgUsers(db, orgId);
  });

  /**
   * 开账号 —— 组织管理员给别人建号并直接加进本组织。
   *
   * ★★ 这是账号进入系统的**唯一**入口（超管那一个除外，他来自 .env）。
   *   没有自助注册：这个产品的组织边界就是多租户边界，
   *   能自助注册等于任何人都能把自己放进那条边界里。
   *
   * ★ 权限用 `organization.members.manage` 而不是 `org.members.manage`：
   *   catalog 里这两条是分开的，前者是「把边界外的账号放进来」，
   *   后者是「在组织内部改角色」。建号显然是前者 —— 而且更靠前一步。
   */
  app.post('/api/v1/admin/users', async (req, reply) => {
    const { orgId, userId: actorId } = await callerOrg(req);
    const created = await createAccount(
      db,
      { orgId, actorId, correlationId: corr(req) },
      CreateAccountInput.parse(req.body),
    );
    return reply.status(201).send(created);
  });

  app.patch('/api/v1/admin/users/:id/org-role', async (req) => {
    const { orgId, userId: actorId } = await callerOrg(req);
    const { id } = req.params as { id: string };
    const body = z.object({ orgRole: OrgRole }).parse(req.body);
    return setOrgRole(
      db,
      { orgId, targetUserId: id, actorId, correlationId: corr(req) },
      body.orgRole,
    );
  });

  // ── 角色定义（§2.2）─────────────────────────────────────────────────
  /**
   * ★★ 超管在这里造出「研发」「运营」「测试」这些角色。
   *
   *   内置的六个是预置数据，不是全集 —— 它们覆盖「项目怎么运转」，
   *   覆盖不了「这个组织怎么分工」。
   */
  app.get('/api/v1/admin/roles', async (req) => {
    const { orgId } = await callerOrg(req);
    return listRoles(db, orgId);
  });

  app.post('/api/v1/admin/roles', async (req, reply) => {
    const { orgId, userId } = await callerOrg(req);
    const result = await createRole(db, { orgId, actorId: userId, correlationId: corr(req) }, req.body);
    return reply.status(201).send(result);
  });

  app.patch('/api/v1/admin/roles/:key', async (req) => {
    const { orgId, userId } = await callerOrg(req);
    const { key } = req.params as { key: string };
    return updateRole(db, { orgId, actorId: userId, correlationId: corr(req) }, key, req.body);
  });

  app.delete('/api/v1/admin/roles/:key', async (req) => {
    const { orgId, userId } = await callerOrg(req);
    const { key } = req.params as { key: string };
    return deleteRole(db, { orgId, actorId: userId, correlationId: corr(req) }, key);
  });

  // ── 需求 ────────────────────────────────────────────────────────────
  const CreateRequirement = z.object({
    rawInput: z.string().min(1),
    inputMethod: z.string().default('manual'),
  });

  app.post('/api/v1/projects/:id/requirements', async (req, reply) => {
    actorFrom(req);
    const { id } = req.params as { id: string };
    const body = CreateRequirement.parse(req.body);

    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    if (!project) throw notFound('项目');

    const [requirement] = await db
      .insert(requirements)
      .values({ orgId: project.orgId, projectId: id, ...body })
      .returning();

    return reply.status(201).send({ requirement });
  });

  app.get('/api/v1/projects/:id/requirements', async (req) => {
    const { id } = req.params as { id: string };
    return listRequirements(db, id);
  });

  /**
   * 人工编辑结构化字段（页面文档 03 §5.4）。
   *
   * ★ 原文永不覆盖：`rawInput` 不在可改字段里。
   *   用户必须能对照原文验证 AI 没有曲解自己的意思 ——
   *   一旦原文可被结构化结果反向覆盖，这个对照就失去意义了。
   */
  const EditRequirement = z.object({
    title: z.string().optional(),
    businessContext: z.string().optional(),
    userProblem: z.string().optional(),
    businessGoal: z.string().optional(),
    acceptanceCriteria: z.array(z.unknown()).optional(),
  });

  app.patch('/api/v1/requirements/:id', async (req) => {
    const { userId } = actorFrom(req);
    const { id } = req.params as { id: string };
    const body = EditRequirement.parse(req.body);

    const [before] = await db.select().from(requirements).where(eq(requirements.id, id));
    if (!before) throw notFound('需求');
    if (before.status === 'approved') {
      throw new ApiError('INVALID_TRANSITION', '需求已确认，不能再编辑。如需修改请先重新打开。');
    }

    const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    if (Object.keys(patch).length === 0) return { requirement: before };

    const [updated] = await db
      .update(requirements)
      .set({ ...patch, updatedAt: new Date() } as never)
      .where(eq(requirements.id, id))
      .returning();

    // 人类改过的字段要能与 AI 原值区分（§5.4「已由人类修改」）
    const provenance = { ...(before.fieldProvenance as Record<string, unknown>) };
    for (const field of Object.keys(patch)) {
      provenance[field] = { source: 'human', editedBy: userId, editedAt: new Date().toISOString() };
    }
    await db.update(requirements).set({ fieldProvenance: provenance }).where(eq(requirements.id, id));

    await emitAndPublish(db, {
      orgId: before.orgId,
      projectId: before.projectId,
      type: 'requirement.field_edited',
      actor: humanActor(userId),
      subjectType: 'requirement',
      subjectId: id,
      payload: { fields: Object.keys(patch) },
      correlationId: corr(req),
    });

    return { requirement: updated };
  });

  app.post('/api/v1/requirements/:id/reject', async (req) => {
    const { userId } = actorFrom(req);
    const { id } = req.params as { id: string };
    const body = z
      .object({
        // ★ 驳回必须填原因：提出人要知道为什么，否则只会原样再提一遍
        reason: z.string({ required_error: '驳回必须填写原因' }).min(1, '驳回必须填写原因'),
      })
      .parse(req.body);

    const [before] = await db.select().from(requirements).where(eq(requirements.id, id));
    if (!before) throw notFound('需求');

    const [updated] = await db
      .update(requirements)
      .set({ status: 'rejected', rejectReason: body.reason, updatedAt: new Date() })
      .where(eq(requirements.id, id))
      .returning();

    await emitAndPublish(db, {
      orgId: before.orgId,
      projectId: before.projectId,
      type: 'requirement.rejected',
      actor: humanActor(userId),
      subjectType: 'requirement',
      subjectId: id,
      payload: { reason: body.reason },
      correlationId: corr(req),
    });

    return { requirement: updated };
  });

  app.get('/api/v1/requirements/:id', async (req) => {
    const { id } = req.params as { id: string };
    const [requirement] = await db.select().from(requirements).where(eq(requirements.id, id));
    if (!requirement) throw notFound('需求');

    const clarifications = await db
      .select()
      .from(requirementClarifications)
      .where(eq(requirementClarifications.requirementId, id));

    return { requirement, clarifications };
  });

  app.post('/api/v1/requirements/:id/analyze', async (req) => {
    const { actor } = actorFrom(req);
    const { id } = req.params as { id: string };
    return analyzeRequirement(db, deps.provider, {
      requirementId: id,
      correlationId: corr(req),
      actor,
    });
  });

  const Answer = z.object({
    answer: z.string().min(1),
    usedSuggestion: z.boolean().default(false),
  });

  app.post('/api/v1/clarifications/:id/answer', async (req) => {
    const { userId } = actorFrom(req);
    const { id } = req.params as { id: string };
    const body = Answer.parse(req.body);

    const row = await answerClarification(db, {
      clarificationId: id,
      ...body,
      actorId: userId,
      correlationId: corr(req),
    });
    return { clarification: row };
  });

  app.post('/api/v1/requirements/:id/approve', async (req) => {
    const { userId } = actorFrom(req);
    const { id } = req.params as { id: string };
    const note = (req.body as { note?: string } | undefined)?.note;

    const result = await approveRequirement(db, {
      requirementId: id,
      approverId: userId,
      correlationId: corr(req),
      note,
    });

    if (!result.ok) {
      // 必答问题未回答 —— 返回具体是哪几个，前端可直接定位
      throw new ApiError('UNANSWERED_MUST_CONFIRM', '还有必答的澄清问题未回答', result.questions);
    }
    return result;
  });

  // ── 计划 ────────────────────────────────────────────────────────────
  app.post('/api/v1/requirements/:id/plans', async (req, reply) => {
    actorFrom(req);
    const { id } = req.params as { id: string };
    const summary = await generatePlan(db, deps.provider, {
      requirementId: id,
      correlationId: corr(req),
    });
    return reply.status(201).send(summary);
  });

  app.get('/api/v1/plans/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getPlanDetail(db, id);
  });

  /**
   * 要求修改（页面文档 04 §5）。
   *
   * ★ 生成新版本而不是原地改：用户批准的是「某一版计划」，
   *   把 v1 悄悄改成 v2 的内容，事后就说不清他到底批准了什么。
   *   旧版标记 superseded，两版都留着，前端可以对比。
   */
  app.post('/api/v1/plans/:id/revise', async (req, reply) => {
    actorFrom(req);
    const { id } = req.params as { id: string };
    const body = z
      .object({ feedback: z.string().min(1, '要求修改必须说明改什么') })
      .parse(req.body);

    const [plan] = await db.select().from(plans).where(eq(plans.id, id));
    if (!plan) throw notFound('计划');
    if (!plan.requirementId) {
      throw new ApiError('INVALID_TRANSITION', '这份计划没有关联需求，无法重新规划');
    }
    if (plan.status === 'approved') {
      throw new ApiError('INVALID_TRANSITION', '已批准的计划不能重新规划，请新建需求');
    }

    await db
      .update(plans)
      .set({ status: 'superseded', revisionFeedback: body.feedback })
      .where(eq(plans.id, id));

    const summary = await generatePlan(db, deps.provider, {
      requirementId: plan.requirementId,
      correlationId: corr(req),
      feedback: body.feedback,
    });
    return reply.status(201).send(summary);
  });

  app.post('/api/v1/plans/:id/approve', async (req) => {
    const { userId } = actorFrom(req);
    const { id } = req.params as { id: string };
    const body = z
      .object({ acknowledgedOverrun: z.boolean().optional() })
      .parse(req.body ?? {});

    const result = await approvePlan(db, {
      planId: id,
      approverId: userId,
      correlationId: corr(req),
      ...body,
    });

    if (!result.ok) {
      throw new ApiError(
        'BUDGET_EXCEEDED',
        `计划预估成本 $${result.estimated} 超出项目预算 $${result.budget}`,
        result,
      );
    }
    return result;
  });

  // ── 看板 ────────────────────────────────────────────────────────────
  app.get('/api/v1/projects/:id/board', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string | undefined>;

    const userId = optionalUserId(req);

    return getBoard(db, id, {
      onlyMine: q['onlyMine'] === 'true' && userId ? userId : undefined,
      riskLevel: q['risk']?.split(','),
      executorType: q['executorType'],
      humanGateOnly: q['humanGate'] === 'true',
      blockedOnly: q['blocked'] === 'true',
    });
  });

  /**
   * Agent 视图（页面文档 05 §5.7）用。
   *
   * 返回负载与当前承担的任务 —— 这是「按 Agent 分泳道」视图的全部数据来源，
   * 一次查完，避免前端逐个 Agent 拉任务。
   */
  app.get('/api/v1/projects/:id/agents', async (req) => {
    const { id } = req.params as { id: string };
    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    if (!project) throw notFound('项目');

    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        type: agents.type,
        status: agents.status,
        model: agents.model,
        skills: agents.skills,
        maxConcurrency: agents.maxConcurrency,
        costLimitPerRun: agents.costLimitPerRun,
        stats: agents.stats,
      })
      .from(agents)
      .where(eq(agents.orgId, project.orgId));

    const items = await db
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.projectId, id),
          eq(workItems.executorType, 'agent'),
          isNull(workItems.deletedAt),
        ),
      );

    const runs = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.projectId, id))
      .orderBy(desc(agentRuns.attempt));
    const latestRun = new Map<string, (typeof runs)[number]>();
    for (const r of runs) if (!latestRun.has(r.workItemId)) latestRun.set(r.workItemId, r);

    return {
      agents: rows.map((a) => {
        const mine = items.filter((i) => i.executorId === a.id);
        return {
          ...a,
          load: mine.filter((i) => i.status === 'executing').length,
          todaySpentUsd: runs
            .filter((r) => r.agentId === a.id)
            .reduce((sum, r) => sum + Number(r.cost ?? 0), 0),
          items: mine.map((i) => {
            const run = latestRun.get(i.id);
            return {
              id: i.id,
              title: i.title,
              status: i.status,
              consecutiveFailures: i.consecutiveFailures,
              progress:
                run && run.stepCurrent !== null
                  ? { step: run.stepCurrent, total: run.stepTotal }
                  : null,
            };
          }),
        };
      }),
    };
  });

  /** 执行图（页面文档 07）。布局在服务端算好，前端只负责渲染与交互 */
  app.get('/api/v1/projects/:id/graph', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { layout?: string };
    const layout = (LAYOUTS as readonly string[]).includes(q.layout ?? '')
      ? (q.layout as LayoutKind)
      : 'layered';

    return getGraph(db, id, layout);
  });

  // ── 项目总览（页面文档 02）──────────────────────────────────────────
  app.get('/api/v1/projects/:id/overview', async (req) => {
    const { id } = req.params as { id: string };
    return getOverview(db, id, optionalUserId(req));
  });

  // ── Agent Workspace（页面文档 08）───────────────────────────────────
  app.get('/api/v1/agents', async (req) => {
    const q = req.query as { projectId?: string };
    const projectId = q.projectId && UUID_RE.test(q.projectId) ? q.projectId : null;

    /**
     * ★ Agent 是组织级资源（可跨项目），所以按**组织**收窄而不是按项目。
     *   此前完全不收窄：花名册会把别的组织的 Agent 一起列出来，
     *   连带它们的成本、成功率、负责人。
     */
    const { userId } = actorFrom(req);
    if (projectId) await assertProjectMember(projectId, userId, req);
    const { orgId } = await resolveCurrentOrg(db, userId, orgHeaderOf(req));

    return listAgents(db, projectId, orgId);
  });

  app.get('/api/v1/agents/:agentId', async (req) => {
    const { agentId } = req.params as { agentId: string };
    return getAgent(db, deps.registry, agentId);
  });

  /**
   * 暂停 / 恢复 Agent。
   *
   * ★ 暂停必须填原因，和停用 Policy 同理：三周后没人记得
   *   「这个 Agent 为什么一直是停的」，而一个停着的 Agent
   *   会安静地让整个项目慢下来。
   */
  app.post('/api/v1/agents/:agentId/pause', async (req) => {
    const { userId } = actorFrom(req);
    const { agentId } = req.params as { agentId: string };
    const body = z
      .object({
        paused: z.boolean(),
        reason: z.string().optional(),
      })
      .parse(req.body);

    if (body.paused && !body.reason?.trim()) {
      throw new ApiError('VALIDATION_FAILED', '暂停 Agent 必须填写原因');
    }

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) throw notFound('Agent');

    await db
      .update(agents)
      .set({
        status: body.paused ? 'paused' : 'active',
        pausedReason: body.paused ? (body.reason ?? null) : null,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId));

    await emitAndPublish(db, {
      orgId: agent.orgId,
      projectId: null,
      type: body.paused ? 'agent.paused' : 'agent.registered',
      actor: humanActor(userId),
      subjectType: 'agent',
      subjectId: agentId,
      payload: { paused: body.paused, reason: body.reason ?? null },
      correlationId: corr(req),
    });

    return { ok: true as const, paused: body.paused };
  });

  // ── 运行时能力（页面文档 14 §5.4 —— 集成里唯一有真实后端的一块）──
  app.get('/api/v1/runtimes', async () => listRuntimes(db, deps.registry));

  /**
   * ── 配置：运行时接入 / Agent 档案 / 项目工程约定（页面文档 08 §5.5）──
   *
   * ★ 在此之前整个系统只有一个写操作（暂停 Agent），Agent 与运行时
   *   只能靠 seed 脚本灌进去 —— 「用户去配置 code agent」一步都做不了。
   */
  /**
   * 「这次请求属于哪个组织」。
   *
   * ★★ 账号可以属于多个组织之后，这个答案不再能从账号上读出来 ——
   *   由 `X-Org-Id` 头显式带上，没带则回落到确定的缺省（见 resolveCurrentOrg）。
   */
  async function callerOrg(req: {
    headers: Record<string, unknown>;
  }): Promise<{ orgId: string; userId: string }> {
    const { userId } = actorFrom(req);
    const { orgId } = await resolveCurrentOrg(db, userId, orgHeaderOf(req));
    return { orgId, userId };
  }

  /**
   * Agent 档案管理。
   *
   * ★ 没有单独的「运行时接入」资源：CLI 类型、凭证、该 CLI 的个性化参数
   *   全都内联在 Agent 上。建 N 个 Agent 就是 N 套独立配置。
   */
  app.get('/api/v1/admin/agents', async (req) => {
    const { orgId } = await callerOrg(req);
    return listAgentsAdmin(db, deps.registry, orgId);
  });

  app.post('/api/v1/admin/agents', async (req, reply) => {
    const { orgId, userId } = await callerOrg(req);
    const body = AgentInput.parse(req.body);
    const result = await createAgent(db, deps.registry, orgId, body, userId);

    await emitAndPublish(db, {
      orgId,
      projectId: null,
      type: 'agent.registered',
      actor: humanActor(userId),
      subjectType: 'agent',
      subjectId: result.agent.id,
      payload: { name: body.name, type: body.type, runtimeKind: body.runtimeKind },
      correlationId: corr(req),
    });

    return reply.status(201).send(result);
  });

  app.patch('/api/v1/admin/agents/:id', async (req) => {
    const { orgId, userId } = await callerOrg(req);
    const { id } = req.params as { id: string };
    const body = AgentInput.partial().extend({ reason: z.string().optional() }).parse(req.body);

    // 扩大权限要 tech_lead，收紧只要 owner —— 方向要比过新旧才知道（§2.3）
    const subject = await rbac.subjectForAgent(req, userId, id);
    const result = await updateAgent(db, deps.registry, id, body, userId, (permission) =>
      rbac.assertPermission(subject, permission, { agentId: id }),
    );

    if (result.permissionsChanged) {
      // ★ 权限变更是审计事件（AUDIT_EVENTS），必须留痕
      await emitAndPublish(db, {
        orgId,
        projectId: null,
        type: 'agent.permissions_changed',
        actor: humanActor(userId),
        subjectType: 'agent',
        subjectId: id,
        payload: {
          allowedTools: body.allowedTools ?? null,
          deniedTools: body.deniedTools ?? null,
          resourceScopes: body.resourceScopes ?? null,
          reason: body.reason ?? null,
        },
        correlationId: corr(req),
      });
    }

    return result;
  });

  app.delete('/api/v1/admin/agents/:id', async (req) => {
    await callerOrg(req);
    const { id } = req.params as { id: string };
    return deleteAgent(db, id);
  });

  /** 能力探测：区分「没注册」「连不上」「缺能力」三种状态 */
  app.post('/api/v1/admin/agents/:id/probe', async (req) => {
    await callerOrg(req);
    const { id } = req.params as { id: string };
    return probeAgent(db, deps.registry, id);
  });

  // ── 代码仓库登记 ────────────────────────────────────────────────────
  app.get('/api/v1/admin/repositories', async (req) => {
    const { orgId } = await callerOrg(req);
    const q = req.query as { projectId?: string };
    const projectId = q.projectId && UUID_RE.test(q.projectId) ? q.projectId : null;
    return listRepositories(db, orgId, projectId);
  });

  app.post('/api/v1/admin/repositories', async (req, reply) => {
    const { orgId, userId } = await callerOrg(req);
    const body = RepositoryInput.parse(req.body);
    return reply.status(201).send(await createRepository(db, orgId, userId, body));
  });

  app.patch('/api/v1/admin/repositories/:id', async (req) => {
    await callerOrg(req);
    const { id } = req.params as { id: string };
    const body = RepositoryInput.partial()
      .extend({ status: z.enum(['active', 'disabled']).optional() })
      .parse(req.body);
    return updateRepository(db, id, body);
  });

  /**
   * 连通性探测。★ 凭证配错了要在配置页上知道，而不是等第一次派发 ——
   *   那时的错误是「准备工作区失败：… 401」，指不到真实原因。
   */
  app.post('/api/v1/admin/repositories/:id/probe', async (req) => {
    await callerOrg(req);
    const { id } = req.params as { id: string };
    return probeRepository(db, id);
  });

  app.delete('/api/v1/admin/repositories/:id', async (req) => {
    await callerOrg(req);
    const { id } = req.params as { id: string };
    return deleteRepository(db, id);
  });

  // ── 项目工程约定 ────────────────────────────────────────────────────
  // 成员关系与 convention.manage 权限都由 preHandler 统一判过（见闸门那一节）
  app.get('/api/v1/projects/:id/conventions', async (req) => {
    const { id } = req.params as { id: string };
    return listConventions(db, id);
  });

  app.post('/api/v1/projects/:id/conventions', async (req, reply) => {
    const { userId } = actorFrom(req);
    const { id } = req.params as { id: string };
    const body = ConventionInput.parse(req.body);
    return reply.status(201).send(await createConvention(db, id, userId, body));
  });

  app.patch('/api/v1/conventions/:id', async (req) => {
    actorFrom(req);
    const { id } = req.params as { id: string };
    return updateConvention(db, id, ConventionInput.partial().parse(req.body));
  });

  app.delete('/api/v1/conventions/:id', async (req) => {
    actorFrom(req);
    const { id } = req.params as { id: string };
    return deleteConvention(db, id);
  });

  // ── 决策中心（页面文档 10）──────────────────────────────────────────
  app.get('/api/v1/decision-inbox', async (req) => {
    const q = req.query as { scope?: string; projectId?: string };
    const scope = (['mine', 'all', 'watching'] as const).find((s) => s === q.scope) ?? 'mine';
    const projectId = q.projectId && UUID_RE.test(q.projectId) ? q.projectId : null;

    // ★ 收件箱必须带身份：它此前用 optionalUserId，匿名调用会返回**全部**
    //   项目的待决策 —— 跨组织的也在里面
    const { userId } = actorFrom(req);
    const visible = await visibleProjectIds(userId);
    if (projectId && !visible.includes(projectId)) throw notFound('项目');

    return getDecisionInbox(db, userId, scope as DecisionScope, projectId, visible);
  });

  app.post('/api/v1/decisions/batch-approve', async (req) => {
    const { userId, actor } = actorFrom(req);
    const body = z
      .object({ ids: z.array(z.string().uuid()).min(1, '至少选一条'), note: z.string().optional() })
      .parse(req.body);
    const correlationId = corr(req);

    /**
     * ★★ 批量资格必须在服务端判。
     *
     *   此前这里只校验了 id 格式，然后逐条调单条批准 —— 而单条批准
     *   只管「你是不是责任人」，不管「这条能不能被批量处理」。
     *   于是「高风险/不可逆决策不给勾选框」这条设计，实际上只存在于
     *   前端的 isBatchable 里：直接调 API，或者用一个旧版本的前端，
     *   就能把不可逆的生产操作一次批掉。灰按钮不是权限。
     *
     *   判定用 @apos/domain 的同一个函数，和界面共用一份口径。
     */
    const targets = await db
      .select({
        id: decisions.id,
        projectId: decisions.projectId,
        riskLevel: decisions.riskLevel,
        reversible: decisions.reversible,
        assigneeId: decisions.assigneeId,
      })
      .from(decisions)
      .where(inArray(decisions.id, body.ids));
    const byId = new Map(targets.map((d) => [d.id, d]));

    /**
     * ★★ 权限也必须逐条判，按**这条决策所属的项目**。
     *
     *   批量接口的 URL 里没有项目 id，闸门（②层）够不着它 ——
     *   而这里此前只判了「是不是责任人」。一条无人认领的决策
     *   （assigneeId 为空，产品口径里它照样进批量）因此对任何人开放：
     *   把 id 猜出来或从别处拿到，非成员就能替别的项目做批准。
     *   一次跨项目的提交要按每条各自的归属判，不能按调用者「大概是谁」判。
     */
    const visible = new Set(await visibleProjectIds(userId));
    const blocked: { id: string; ok: false; error: string }[] = [];
    const allowed: string[] = [];
    for (const id of body.ids) {
      const d = byId.get(id);
      if (!d) {
        // 不存在的 id 交给单条批准去报「决策不存在」，口径一致
        allowed.push(id);
        continue;
      }
      if (!visible.has(d.projectId)) {
        // 与②层同一口径：不确认「这条决策存在」，只说够不着
        blocked.push({ id, ok: false, error: '决策不存在，或当前身份没有访问权限' });
        continue;
      }
      const permission = check(await rbac.resolveActor(req, userId, d.projectId), 'decision.act');
      if (!permission.allowed) {
        blocked.push({ id, ok: false, error: permission.reason ?? '权限不足' });
        continue;
      }
      const candidate = {
        canAct: d.assigneeId === null || d.assigneeId === userId,
        reversible: d.reversible,
        riskLevel: d.riskLevel,
      };
      const reason = batchDenyReason(candidate);
      if (reason) blocked.push({ id, ok: false, error: reason });
      else allowed.push(id);
    }

    // 逐条走单条批准的同一个函数 —— 批量省的是点击，不是规则
    const result = await batchApprove(allowed, (id) =>
      approveDecisionById(id, userId, actor, { note: body.note, constraints: [] }, correlationId),
    );

    return {
      ...result,
      failed: [...result.failed, ...blocked],
      results: [...result.results, ...blocked],
    };
  });

  /**
   * 通知投递记录（产品文档十一）。
   *
   * ★ 「发过没有」必须查得到。通知最典型的故障是静默失败 ——
   *   webhook 被撤销、群被解散、被免打扰吃掉，而用户只会觉得
   *   「这系统从来不提醒我」，根本不会想到去查投递。
   */
  app.get('/api/v1/projects/:id/notifications', async (req) => {
    const { id } = req.params as { id: string };
    return listDeliveries(db, id);
  });

  /**
   * 开发用的 webhook 接收端。
   *
   * ★ 只是为了让「配置 → 判定 → 投递 → 记录」这条链路在演示环境里
   *   能真的跑通一遍。生产部署里 webhookUrl 指向真的 Slack / 飞书，
   *   这个端点不该存在 —— 所以它由环境变量开关，默认在开发环境开。
   */
  if (process.env['DEV_WEBHOOK_SINK'] !== 'off') {
    app.post('/api/v1/dev/webhook-sink', async (req, reply) => {
      app.log.info({ body: req.body }, '[dev-webhook] 收到通知');
      return reply.type('text/plain').send('ok');
    });
  }

  /**
   * 人力成本基准（成本效益换算用）。
   *
   * ★ 允许清空。系统不替用户猜一个时薪 —— 用户改主意了要能回到「不换算」，
   *   否则一旦填过就再也去不掉，那个数字会一直挂在页面上被当成事实。
   */
  app.patch('/api/v1/projects/:id/labor-cost', async (req) => {
    const { id } = req.params as { id: string };
    actorFrom(req);
    const body = z
      .object({ laborHourlyCost: z.number().positive().nullable() })
      .parse(req.body);

    const [row] = await db.select().from(projects).where(eq(projects.id, id));
    if (!row) throw notFound('项目');

    await db
      .update(projects)
      .set({
        laborHourlyCost: body.laborHourlyCost === null ? null : String(body.laborHourlyCost),
        updatedAt: new Date(),
      })
      .where(eq(projects.id, id));

    return { ok: true };
  });

  /** 一条规则的命中明细 —— 无法审计的规则没人敢改（页面文档 13）*/
  app.get('/api/v1/projects/:id/policies/:policyId/hits', async (req) => {
    const { id, policyId } = req.params as { id: string; policyId: string };
    return getPolicyHits(db, id, policyId);
  });

  /**
   * 计划版本对比（页面文档 04）。
   *
   * 不带 against 时和上一版比 —— 用户点进来 99% 想看的是「这一版改了什么」。
   */
  app.get('/api/v1/plans/:id/diff', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { against?: string };
    const against = q.against === undefined ? undefined : Number(q.against);
    if (against !== undefined && !Number.isInteger(against)) {
      throw new ApiError('VALIDATION_FAILED', 'against 必须是版本号');
    }
    return comparePlans(db, id, against);
  });

  // ── 集成设置（页面文档 14）────────────────────────────────────────────

  /**
   * 项目角色 + 组织角色 → 权限判定。
   *
   * ★ 判定本身在 @apos/domain 的权限目录，前后端共用一份 —— 界面上灰掉的
   *   按钮和服务端真正拦住的请求必须是同一条规则。这一页管的是
   *   「谁能给外部系统开写权限」，两边说法不一致的代价太高。
   */
  async function integrationActor(
    projectId: string,
    userId: string,
    req: FastifyRequest,
  ): Promise<Actor> {
    const actor = await rbac.resolveActor(req, userId, projectId);
    /**
     * ★ 集成设置那个窄接口只认内置角色。自定义角色在这里退化成
     *   「不是内置角色」（null）—— 但它们的权限判定并不受影响：
     *   assertIntegration 之外，preHandler 已经按权限集合判过一次了。
     */
    return { projectRole: asBuiltinRole(actor.projectRole), orgRole: actor.orgRole };
  }

  async function assertIntegration(
    projectId: string,
    userId: string,
    action: Parameters<typeof canIntegration>[1],
    req: FastifyRequest,
  ) {
    const actor = await integrationActor(projectId, userId, req);
    if (!canIntegration(actor, action)) {
      throw new ApiError('FORBIDDEN', denyReason(actor, action) ?? '权限不足', {
        action,
        projectRole: actor.projectRole,
      });
    }
    return actor;
  }

  /** 集成 id → projectId，权限判定要先知道是哪个项目 */
  async function projectOfIntegration(id: string): Promise<string> {
    const [row] = await db.select().from(integrations).where(eq(integrations.id, id));
    if (!row) throw notFound('集成');
    return row.projectId;
  }

  app.get('/api/v1/projects/:id/integrations', async (req) => {
    const { id } = req.params as { id: string };
    const userId = optionalUserId(req);
    const data = await listIntegrations(db, deps.integrations, id);
    const actor = userId
      ? await integrationActor(id, userId, req)
      : ({ projectRole: null, orgRole: 'member' } as Actor);

    return { ...data, permissions: integrationPermissions(actor) };
  });

  app.post('/api/v1/projects/:id/integrations', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { userId, actor } = actorFrom(req);
    const body = z
      .object({
        provider: IntegrationProvider,
        displayName: z.string().min(1),
        config: z.record(z.unknown()).default({}),
        credential: z.string().nullable().default(null),
        /** 是否需要写权限 —— 单独一档授权，见 §8 */
        grantWrite: z.boolean().default(false),
      })
      .parse(req.body);

    await assertIntegration(id, userId, 'connect', req);
    /**
     * ★ 写权限是比「连上」高一个量级的授权，单独判一次。
     *   pm 能连 GitHub，但让它能改代码需要 tech_lead。
     */
    if (body.grantWrite) await assertIntegration(id, userId, 'grant_write', req);

    const created = await createIntegration(db, deps.integrations, {
      projectId: id,
      provider: body.provider,
      displayName: body.displayName,
      config: body.config,
      credential: body.credential,
      userId,
    });

    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    await emitAndPublish(db, {
      orgId: project!.orgId,
      projectId: id,
      actor,
      type: 'integration.connected',
      subjectType: 'integration',
      subjectId: created.id,
      // ★ 授予了什么权限要进审计。事后追责时「谁开的写权限」必须查得到
      payload: { provider: body.provider, scopes: created.scopes, grantWrite: body.grantWrite },
      correlationId: corr(req),
    });

    reply.code(201);
    return created;
  });

  app.patch('/api/v1/integrations/:id/sync-mapping', async (req) => {
    const { id } = req.params as { id: string };
    const { userId, actor } = actorFrom(req);
    const body = z.object({ mappings: z.array(SyncMapping).min(1) }).parse(req.body);

    const projectId = await projectOfIntegration(id);
    await assertIntegration(projectId, userId, 'change_sot', req);

    const result = await updateSyncMapping(db, id, body.mappings, userId);

    /**
     * ★ SoT 变更必须留痕。它决定以后哪一边的修改会被丢掉，
     *   而且改错之后不会立刻显现 —— 等到发现数据对不上时，
     *   唯一能回答「什么时候变的、谁变的」的就是这条事件。
     */
    if (result.changed.length > 0) {
      await emitAndPublish(db, {
        orgId: result.orgId,
        projectId: result.projectId,
        actor,
        type: 'integration.synced',
        subjectType: 'integration',
        subjectId: id,
        payload: { kind: 'sot_changed', changes: result.changed },
        correlationId: corr(req),
      });
    }

    return { ok: true, changed: result.changed };
  });

  /** 从代码仓库回流 CI 结果 —— 质量 Tab 的数据源（页面文档 12）*/
  app.post('/api/v1/integrations/:id/ingest-ci', async (req) => {
    const { id } = req.params as { id: string };
    const { userId } = actorFrom(req);
    const projectId = await projectOfIntegration(id);
    await assertIntegration(projectId, userId, 'view', req);
    return ingestCiResults(db, deps.integrations, id);
  });

  app.post('/api/v1/integrations/:id/sync', async (req) => {
    const { id } = req.params as { id: string };
    const { userId } = actorFrom(req);
    const projectId = await projectOfIntegration(id);
    await assertIntegration(projectId, userId, 'view', req);

    return runSync(db, deps.integrations, id);
  });

  app.get('/api/v1/projects/:id/sync-conflicts', async (req) => {
    const { id } = req.params as { id: string };
    return listConflicts(db, id);
  });

  app.post('/api/v1/sync-conflicts/:id/resolve', async (req) => {
    const { id } = req.params as { id: string };
    const { userId, actor } = actorFrom(req);
    const body = z
      .object({
        winner: z.enum(['apos', 'external']),
        applyToSimilar: z.boolean().default(false),
      })
      .parse(req.body);

    const [conflict] = await db.select().from(syncConflicts).where(eq(syncConflicts.id, id));
    if (!conflict) throw notFound('冲突');
    await assertIntegration(conflict.projectId, userId, 'resolve_conflict', req);

    const result = await resolveConflict(db, deps.integrations, {
      conflictId: id,
      winner: body.winner,
      applyToSimilar: body.applyToSimilar,
      userId,
    });

    await emitAndPublish(db, {
      orgId: result.orgId,
      projectId: result.projectId,
      actor,
      type: 'integration.conflict_resolved',
      subjectType: 'integration',
      subjectId: conflict.integrationId,
      payload: {
        field: result.field,
        winner: result.winner,
        workItemId: result.workItemId,
        applyToSimilar: body.applyToSimilar,
      },
      correlationId: corr(req),
    });

    return result;
  });

  app.post('/api/v1/integrations/:id/objects', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { userId } = actorFrom(req);
    const body = z
      .object({
        workItemId: z.string().uuid(),
        externalKey: z.string().min(1),
        externalUrl: z.string().url().optional(),
      })
      .parse(req.body);

    const projectId = await projectOfIntegration(id);
    await assertIntegration(projectId, userId, 'connect', req);

    const link = await linkObject(db, { integrationId: id, ...body });
    reply.code(201);
    return link;
  });

  /** 断开前先看影响 —— 一个只问「确定吗」的确认框等于没问（§7） */
  app.get('/api/v1/integrations/:id/disconnect-impact', async (req) => {
    const { id } = req.params as { id: string };
    return disconnectImpact(db, id);
  });

  app.delete('/api/v1/integrations/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { userId, actor } = actorFrom(req);
    const body = z.object({ confirmImpact: z.literal(true) }).parse(req.body ?? {});
    void body;

    const projectId = await projectOfIntegration(id);
    await assertIntegration(projectId, userId, 'disconnect', req);

    const result = await disconnectIntegration(db, id);
    await emitAndPublish(db, {
      orgId: result.orgId,
      projectId: result.projectId,
      actor,
      type: 'integration.disconnected',
      subjectType: 'integration',
      subjectId: id,
      payload: { provider: result.provider },
      correlationId: corr(req),
    });

    return { ok: true };
  });

  app.patch('/api/v1/integrations/:id/notifications', async (req) => {
    const { id } = req.params as { id: string };
    const { userId } = actorFrom(req);
    const config = NotificationConfig.parse(req.body);

    const projectId = await projectOfIntegration(id);
    await assertIntegration(projectId, userId, 'configure_notification', req);

    return updateNotificationConfig(db, id, config);
  });

  // ── Analytics ───────────────────────────────────────────────────────
  app.get('/api/v1/projects/:id/analytics', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { range?: string; compare?: string };
    const range = (ANALYTICS_RANGES as readonly string[]).includes(q.range ?? '')
      ? (q.range as AnalyticsRange)
      : '30d';

    // 默认开启对比 —— 绝对值不重要，趋势才重要（页面文档 12 §5.8）
    return getAnalytics(db, id, range, q.compare !== 'false');
  });

  app.get('/api/v1/projects/:id/analytics/items', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { kind?: string; range?: string };
    const kind = (['rework', 'wip', 'slow'] as const).find((k) => k === q.kind);
    if (!kind) throw new ApiError('VALIDATION_FAILED', 'kind 必须是 rework / wip / slow 之一');
    const range = (ANALYTICS_RANGES as readonly string[]).includes(q.range ?? '')
      ? (q.range as AnalyticsRange)
      : '30d';

    return getAnalyticsItems(db, id, kind, range);
  });

  // ── Policy 配置 ─────────────────────────────────────────────────────
  // ★ 这些端点只认 X-User-Id（人类身份）。Agent 回调走 run-scoped token，
  //   到不了这里 —— Agent 不能修改约束自己的规则（产品文档 十）。
  app.get('/api/v1/projects/:id/policies', async (req) => {
    const { id } = req.params as { id: string };
    return getPolicies(db, id);
  });

  app.get('/api/v1/policy-templates', async () => ({ templates: serializeTemplates() }));

  const PolicyDraftBody = z.object({
    name: z.string().min(1, '规则必须有名字'),
    description: z.string().optional(),
    priority: z.number().int().min(1),
    condition: z.unknown(),
    action: z.unknown(),
    enabled: z.boolean().optional(),
    /** 模拟发现了与人类判断不一致的历史案例后，用户看过并坚持要保存 */
    acknowledgeMismatches: z.boolean().optional(),
  });

  /**
   * ★ 收紧还是放宽，要把新旧规则各跑一遍场景才知道 ——
   *   路由表只挡掉「连收紧都不够格」的人，方向判定交给 savePolicy 回调。
   */
  async function policyGuard(req: FastifyRequest, projectId: string) {
    const { userId } = actorFrom(req);
    const actor = await rbac.resolveActor(req, userId, projectId);
    return (permission: 'policy.tighten' | 'policy.loosen') =>
      rbac.assertPermission(actor, permission, { projectId });
  }

  app.post('/api/v1/projects/:id/policies', async (req, reply) => {
    const { userId } = actorFrom(req);
    const { id } = req.params as { id: string };
    const body = PolicyDraftBody.parse(req.body);

    const result = await savePolicy(
      db,
      id,
      {
        name: body.name,
        description: body.description,
        priority: body.priority,
        condition: Condition.parse(body.condition),
        action: Action.parse(body.action),
        enabled: body.enabled,
      },
      userId,
      {
        acknowledgeMismatches: body.acknowledgeMismatches,
        assertCan: await policyGuard(req, id),
      },
    );
    return reply.code(201).send(result);
  });

  app.patch('/api/v1/projects/:id/policies/:policyId', async (req) => {
    const { userId } = actorFrom(req);
    const { id, policyId } = req.params as { id: string; policyId: string };
    const body = PolicyDraftBody.parse(req.body);

    return savePolicy(
      db,
      id,
      {
        name: body.name,
        description: body.description,
        priority: body.priority,
        condition: Condition.parse(body.condition),
        action: Action.parse(body.action),
        enabled: body.enabled,
      },
      userId,
      {
        policyId,
        acknowledgeMismatches: body.acknowledgeMismatches,
        assertCan: await policyGuard(req, id),
      },
    );
  });

  app.post('/api/v1/projects/:id/policies/:policyId/toggle', async (req) => {
    const { userId } = actorFrom(req);
    const { id, policyId } = req.params as { id: string; policyId: string };
    const body = z
      .object({
        enabled: z.boolean(),
        // ★ 停用规则必须填原因（页面文档 13 §8）——
        //   规则的变更历史本身就是组织知识，「为什么停用」比「停用了」重要
        reason: z.string().min(1, '停用规则必须填写原因'),
      })
      .parse(req.body);

    return togglePolicy(db, id, policyId, body.enabled, body.reason, userId);
  });

  app.delete('/api/v1/projects/:id/policies/:policyId', async (req) => {
    actorFrom(req);
    const { id, policyId } = req.params as { id: string; policyId: string };
    return deletePolicy(db, id, policyId);
  });

  /**
   * 模板 → 条件/动作。
   *
   * ★ 这个映射只在后端有一份实现（domain 的 templates.ts）。
   *   前端跟着算一遍就有两份，迟早对不上 —— 而这一页对不上的后果是
   *   「界面上写的规则」和「实际执行的规则」不是同一条。
   *   顺带把人话解释一起返回，编辑器改参数时能实时更新（页面文档 13 §5.6）。
   */
  app.post('/api/v1/projects/:id/policies/from-template', async (req) => {
    const body = z
      .object({ templateId: z.string(), values: z.record(z.union([z.string(), z.number()])) })
      .parse(req.body);

    const template = templateById(body.templateId);
    if (!template) throw notFound('模板');

    const built = template.build(body.values);
    return { ...built, explanation: explainPolicy(built.condition, built.action) };
  });

  app.post('/api/v1/projects/:id/policies/simulate', async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        condition: z.unknown(),
        action: z.unknown(),
        range: z.enum(['7d', '30d', '90d']).default('30d'),
      })
      .parse(req.body);

    return runSimulation(
      db,
      id,
      { condition: Condition.parse(body.condition), action: Action.parse(body.action) },
      body.range,
    );
  });

  app.post('/api/v1/projects/:id/policies/evaluate', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ context: z.record(z.unknown()) }).parse(req.body);
    return evaluateScenario(db, id, body.context as Partial<PolicyContext>);
  });

  app.post('/api/v1/projects/:id/policies/autonomy-preview', async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({ to: z.enum(['human_led', 'agent_led_approval', 'agent_autonomous']) })
      .parse(req.body);
    return autonomyPreview(db, id, body.to);
  });

  app.patch('/api/v1/projects/:id/autonomy', async (req) => {
    const { userId } = actorFrom(req);
    const { id } = req.params as { id: string };
    const body = z
      .object({ autonomyLevel: z.enum(['human_led', 'agent_led_approval', 'agent_autonomous']) })
      .parse(req.body);

    const [before] = await db.select().from(projects).where(eq(projects.id, id));
    if (!before) throw notFound('项目');

    await db
      .update(projects)
      .set({ autonomyLevel: body.autonomyLevel, updatedAt: new Date() })
      .where(eq(projects.id, id));

    await emitAndPublish(db, {
      orgId: before.orgId,
      projectId: id,
      type: 'project.autonomy_changed',
      actor: humanActor(userId),
      subjectType: 'project',
      subjectId: id,
      payload: { from: before.autonomyLevel, to: body.autonomyLevel },
      correlationId: corr(req),
    });

    return { ok: true as const, autonomyLevel: body.autonomyLevel };
  });

  app.get('/api/v1/policies/:policyId/history', async (req) => {
    const { policyId } = req.params as { policyId: string };
    return getPolicyHistory(db, policyId);
  });

  // ── Work Item ───────────────────────────────────────────────────────
  app.get('/api/v1/work-items/:id', async (req) => {
    const { id } = req.params as { id: string };
    const [item] = await db.select().from(workItems).where(eq(workItems.id, id));
    if (!item) throw notFound('任务');

    const runs = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.workItemId, id))
      .orderBy(desc(agentRuns.attempt));
    const arts = await db.select().from(artifacts).where(eq(artifacts.workItemId, id));
    const timeline = await db
      .select()
      .from(events)
      .where(and(eq(events.subjectType, 'work_item'), eq(events.subjectId, id)))
      .orderBy(desc(events.id))
      .limit(50);

    const [project] = await db
      .select({ identifier: projects.identifier })
      .from(projects)
      .where(eq(projects.id, item.projectId));

    return {
      // ★ 人类可读编号跟着详情一起回 —— 详情页的标题栏要显示它
      item: { ...item, ref: formatRef(project?.identifier ?? 'TASK', item.number) },
      runs,
      artifacts: arts,
      timeline: timeline.map(serializeEvent),
    };
  });

  const StatusChange = z.object({
    toStatus: WorkItemStatus,
    /** ★ 人类覆盖系统判断必须记录原因（产品文档 8.4.4） */
    reason: z
      .string({ required_error: '手动调整状态必须填写原因' })
      .min(1, '手动调整状态必须填写原因'),
    reasonCategory: z.string().optional(),
    overrideGuards: z.array(z.string()).optional(),
  });

  app.post('/api/v1/projects/:id/work-items', async (req, reply) => {
    const { userId } = actorFrom(req);
    const { id } = req.params as { id: string };
    const body = WorkItemInput.parse(req.body);
    const result = await createWorkItem(
      db,
      { projectId: id, actorId: userId, correlationId: corr(req) },
      body,
    );
    return reply.status(201).send(result);
  });

  app.patch('/api/v1/work-items/:id/status', async (req) => {
    const { userId, actor } = actorFrom(req);
    const { id } = req.params as { id: string };
    const body = StatusChange.parse(req.body);

    const [current] = await db.select().from(workItems).where(eq(workItems.id, id));
    if (!current) throw notFound('任务');

    /**
     * ★★ `draft → ready` 是把一个任务放进**可派发队列**，
     *   那正是 `plan.approve` 这道 Human Gate 的内容。
     *
     *   手工建的任务不经过「需求 → 计划 → 批准」那条链，如果这一步
     *   只要 `work_item.execute`，那么任何能建任务的人都能让 Agent
     *   去做任意事情 —— 两道 Human Gate 就都被绕开了。
     *
     * ★ 判定放在 handler 而不是路由表：路由表看不到任务**当前**的状态，
     *   而 `changes_requested → ready`（返工重新开始）同样落在 ready 上，
     *   那一步的计划早就批过了，不该再要一次批准权限。
     */
    if (current.status === 'draft' && body.toStatus === 'ready') {
      const gateActor = await rbac.resolveActor(req, userId, current.projectId);
      rbac.assertPermission(gateActor, 'plan.approve', {
        workItemId: id,
        why: '手工建的任务没有经过计划批准，放行去执行等同于批准一份计划',
      });
    }

    const trigger = manualTriggerFor(current.status, body.toStatus);
    if (!trigger) {
      throw new ApiError(
        'INVALID_TRANSITION',
        `当前状态 ${current.status} 不能手动切换到 ${body.toStatus}`,
        { from: current.status, allowedTriggers: availableTriggers(WORK_ITEM_MACHINE, current.status) },
      );
    }

    const result = await transition(db, {
      workItemId: id,
      trigger,
      actor,
      reason: body.reason,
      reasonCategory: body.reasonCategory,
      manual: true,
      overrideGuards: body.overrideGuards,
      correlationId: corr(req),
    });

    if (!result.ok) return mapTransitionError(result);
    return toTransitionResponse(result);
  });

  /**
   * 指派 Agent 并开始执行（页面文档 05/06 的卡片操作）。
   *
   * ★ 与 `/retry` 分开。此前卡片上的「派发」借用的是重试接口 ——
   *   能用，但语义别扭：它会给 Agent 带上「上次失败原因」的上下文
   *   （首次派发时那是空的），错误信息也说的是「重试失败」。
   *   更要紧的是，重试接口不校验「这张卡现在能不能开始」，
   *   于是在 draft / reviewing 状态的卡片上点派发会得到一个
   *   看不懂的流转错误。
   */
  app.post('/api/v1/work-items/:id/assign', async (req) => {
    const { actor, userId } = actorFrom(req);
    const { id } = req.params as { id: string };
    const body = z
      .object({
        agentId: z.string().uuid().optional(),
        /** 指派给人时用 */
        userId: z.string().uuid().optional(),
        /** 派发时附加的说明，进 must_read 上下文 */
        note: z.string().max(4000).optional(),
      })
      .refine((v) => Boolean(v.agentId) !== Boolean(v.userId), {
        message: '必须且只能指定 agentId 或 userId 其中之一',
      })
      .parse(req.body ?? {});

    const [item] = await db.select().from(workItems).where(eq(workItems.id, id));
    if (!item) throw notFound('任务');

    // ★ 先说清楚「现在不能开始」，而不是让它掉进流转错误里
    const STARTABLE = ['ready', 'blocked', 'changes_requested'];
    if (!STARTABLE.includes(item.status)) {
      throw new ApiError(
        'INVALID_TRANSITION',
        `任务当前状态是 ${item.status}，不能直接指派开始。失败的任务请用「重试」，执行中的请先终止。`,
        { status: item.status, startable: STARTABLE },
      );
    }

    if (body.userId) {
      const moved = await transition(db, {
        workItemId: id,
        trigger: 'assigned_to_human',
        actor,
        reason: body.note ?? '人工指派',
        correlationId: corr(req),
      });
      if (!moved.ok) return mapTransitionError(moved);

      await db
        .update(workItems)
        .set({ executorType: 'human', executorId: body.userId })
        .where(eq(workItems.id, id));

      return { ok: true as const, executorType: 'human' as const, executorId: body.userId };
    }

    const result = await dispatchRun(
      db,
      deps.registry,
      {
        workItemId: id,
        agentId: body.agentId!,
        correlationId: corr(req),
        additionalContext: body.note
          ? [{ title: '派发人的补充说明', content: body.note }]
          : undefined,
      },
      { workspaces: deps.workspaces },
    );

    if (!result.ok) {
      // 工作区问题要用它自己的错误码，别混进「Agent 不可用」
      throw new ApiError(
        result.code === 'WORKSPACE_UNAVAILABLE' ? 'VALIDATION_FAILED' : 'AGENT_UNAVAILABLE',
        result.code === 'WORKSPACE_UNAVAILABLE'
          ? ((result.detail as { reason?: string })?.reason ?? '工作区不可用')
          : '派发失败',
        result.detail,
      );
    }

    await emitAndPublish(db, {
      orgId: item.orgId,
      projectId: item.projectId,
      type: 'work_item.assigned',
      actor,
      subjectType: 'work_item',
      subjectId: id,
      payload: { executorType: 'agent', executorId: body.agentId, byUserId: userId, manual: true },
      correlationId: corr(req),
    });

    return {
      ok: true as const,
      executorType: 'agent' as const,
      runId: result.runId,
      attempt: result.attempt,
      reused: result.reused,
    };
  });

  app.post('/api/v1/work-items/:id/retry', async (req) => {
    actorFrom(req);
    const { id } = req.params as { id: string };
    const body = z
      .object({
        agentId: z.string().uuid().optional(),
        additionalContext: z
          .array(z.object({ title: z.string(), content: z.string() }))
          .optional(),
      })
      .parse(req.body ?? {});

    const [item] = await db.select().from(workItems).where(eq(workItems.id, id));
    if (!item) throw notFound('任务');

    const agentId = body.agentId ?? item.executorId;
    if (!agentId) throw new ApiError('VALIDATION_FAILED', '未指定执行 Agent');

    // 先把任务拉回 ready，再派发
    if (item.status === 'failed') {
      await transition(db, {
        workItemId: id,
        trigger: 'retry_requested',
        actor: actorFrom(req).actor,
        correlationId: corr(req),
      });
    }

    const result = await dispatchRun(
      db,
      deps.registry,
      { workItemId: id, agentId, correlationId: corr(req), additionalContext: body.additionalContext },
      { workspaces: deps.workspaces },
    );

    if (!result.ok) throw new ApiError('AGENT_UNAVAILABLE', '派发失败', result.detail);
    return result;
  });

  app.post('/api/v1/work-items/:id/takeover', async (req) => {
    const { actor } = actorFrom(req);
    const { id } = req.params as { id: string };
    const body = z
      .object({
        reason: z.string({ required_error: '接管必须填写原因' }).min(1, '接管必须填写原因'),
      })
      .parse(req.body);

    const result = await transition(db, {
      workItemId: id,
      trigger: 'human_took_over',
      actor,
      reason: body.reason,
      correlationId: corr(req),
    });

    if (!result.ok) return mapTransitionError(result);
    return toTransitionResponse(result);
  });

  // ── Run ─────────────────────────────────────────────────────────────
  app.get('/api/v1/runs/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getRunDetail(db, id);
  });

  app.get('/api/v1/runs/:id/events', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { level?: string; after?: string; limit?: string };

    return getRunEvents(db, id, {
      level: q.level === 'detailed' ? 'detailed' : 'brief',
      after: q.after !== undefined ? Number(q.after) : undefined,
      limit: q.limit !== undefined ? Number(q.limit) : undefined,
    });
  });

  app.get('/api/v1/runs/:id/cost-breakdown', async (req) => {
    const { id } = req.params as { id: string };
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, id));
    if (!run) throw notFound('Run');
    return { steps: await getCostBreakdown(db, id) };
  });

  /**
   * 运行时控制（页面文档 09 §5.1）。
   *
   * ★ 能力不足要如实报，不能悄悄降级 —— Claude Code 没有暂停语义，
   *   点「暂停」实际会变成终止。这个差别对用户是决定性的
   *   （暂停可恢复、终止不可），必须让他自己选。
   */
  const RunControl = z
    .object({
      action: z.enum(['pause', 'resume', 'terminate', 'add_constraint']),
      reason: z.string().optional(),
      constraint: z
        .object({
          type: z.string().default('freeform'),
          description: z.string().min(1),
        })
        .optional(),
    })
    .superRefine((v, ctx) => {
      // 终止是不可逆操作，必须留痕（agent_run.terminated 属于 REASON_REQUIRED_EVENTS）
      if (v.action === 'terminate' && !v.reason?.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '终止必须填写原因', path: ['reason'] });
      }
      if (v.action === 'add_constraint' && !v.constraint?.description.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '追加约束必须填写内容',
          path: ['constraint'],
        });
      }
    });

  app.post('/api/v1/runs/:id/control', async (req) => {
    const { actor, userId } = actorFrom(req);
    const { id } = req.params as { id: string };
    const body = RunControl.parse(req.body);

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, id));
    if (!run) throw notFound('Run');

    if (!(ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) {
      throw new ApiError('VERSION_CONFLICT', `Run 已经是 ${run.status} 状态，无法再操作`, {
        status: run.status,
      });
    }

    const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId));
    if (!agent) throw notFound('Agent');
    if (!deps.registry.has(agent.id)) {
      throw new ApiError('AGENT_UNAVAILABLE', '该 Agent 的运行时未在本进程注册，无法控制', {
        agentId: agent.id,
        runtimeKind: agent.runtimeKind,
      });
    }

    const adapter = deps.registry.get(agent.id);
    const command =
      body.action === 'terminate'
        ? ({ action: 'terminate', reason: body.reason ?? '人工终止' } as const)
        : body.action === 'add_constraint'
          ? ({
              action: 'add_constraint',
              constraint: {
                type: (body.constraint?.type ?? 'freeform') as never,
                value: null,
                description: body.constraint!.description,
                // 运行中注入的约束只能靠 Agent 自觉遵守，如实标注
                enforcement: 'agent' as const,
                decisionId: null,
              },
            } as const)
          : ({ action: body.action } as const);

    try {
      await adapter.control(id, command);
    } catch (err) {
      if (err instanceof UnsupportedFeatureError) {
        // 降级矩阵：不支持的能力如实报回，由调用方决定要不要换个动作
        throw new ApiError(
          'UNSUPPORTED_FEATURE',
          `运行时 ${adapter.kind} 不支持「${LABELS[body.action]}」`,
          { feature: err.feature, runtimeKind: err.runtimeKind, fallback: FALLBACK[body.action] },
        );
      }
      throw err;
    }

    await emitAndPublish(db, {
      orgId: run.orgId,
      projectId: run.projectId,
      actor,
      type: body.action === 'terminate' ? 'agent_run.terminated' : 'agent_run.constraint_added',
      subjectType: 'agent_run',
      subjectId: id,
      payload: {
        workItemId: run.workItemId,
        action: body.action,
        reason: body.reason ?? `人工${LABELS[body.action]}`,
        constraint: body.constraint?.description ?? null,
        byUserId: userId,
      },
      correlationId: corr(req),
    });

    return { ok: true, action: body.action };
  });

  // ── 决策 ────────────────────────────────────────────────────────────
  app.get('/api/v1/decisions', async (req) => {
    const userId = optionalUserId(req);
    const scope = (req.query as { scope?: string }).scope ?? 'mine';

    const rows = await db
      .select()
      .from(decisions)
      .where(
        scope === 'mine' && userId
          ? and(eq(decisions.assigneeId, userId), eq(decisions.status, 'pending'))
          : eq(decisions.status, 'pending'),
      )
      .orderBy(decisions.dueAt);

    const now = Date.now();
    return {
      stats: {
        pending: rows.length,
        overdue: rows.filter((d) => d.dueAt && d.dueAt.getTime() < now).length,
        dueSoon: rows.filter(
          (d) => d.dueAt && d.dueAt.getTime() > now && d.dueAt.getTime() - now < 4 * 3600_000,
        ).length,
      },
      decisions: rows.map((d) => ({
        ...d,
        dueInMinutes: d.dueAt ? Math.round((d.dueAt.getTime() - now) / 60_000) : null,
      })),
    };
  });

  app.get('/api/v1/decisions/:id', async (req) => {
    const { id } = req.params as { id: string };
    const [decision] = await db.select().from(decisions).where(eq(decisions.id, id));
    if (!decision) throw notFound('决策');

    const options = await db
      .select()
      .from(decisionOptions)
      .where(eq(decisionOptions.decisionId, id))
      .orderBy(decisionOptions.position);

    const item = decision.workItemId
      ? (
          await db.select().from(workItems).where(eq(workItems.id, decision.workItemId))
        )[0]
      : null;

    return {
      decision: {
        ...decision,
        dueInMinutes: decision.dueAt
          ? Math.round((decision.dueAt.getTime() - Date.now()) / 60_000)
          : null,
      },
      options,
      workItem: item ?? null,
    };
  });

  /**
   * 催办（页面文档 05 §5.6「处理阻塞」）。
   *
   * 冷却期存在的理由很实际：阻塞卡片就在眼前，不设冷却会被连点，
   * 决策人一分钟收十条提醒之后就会把通知静音。
   */
  app.post('/api/v1/decisions/:id/remind', async (req) => {
    const { actor } = actorFrom(req);
    const { id } = req.params as { id: string };

    const [decision] = await db.select().from(decisions).where(eq(decisions.id, id));
    if (!decision) throw notFound('决策');
    if (decision.status !== 'pending') {
      throw new ApiError('VERSION_CONFLICT', '该决策已被处理', { status: decision.status });
    }

    const cooldownMs = 30 * 60_000;
    const since = decision.remindedAt ? Date.now() - decision.remindedAt.getTime() : Infinity;
    if (since < cooldownMs) {
      throw new ApiError('RATE_LIMITED', '刚刚已经催办过了，请稍后再试', {
        retryAfterMinutes: Math.ceil((cooldownMs - since) / 60_000),
      });
    }

    await db.update(decisions).set({ remindedAt: new Date() }).where(eq(decisions.id, id));

    await emitAndPublish(db, {
      orgId: decision.orgId,
      projectId: decision.projectId,
      actor,
      type: 'decision.reminded',
      subjectType: 'decision',
      subjectId: id,
      payload: { assigneeId: decision.assigneeId, workItemId: decision.workItemId },
      correlationId: corr(req),
    });

    return { ok: true, decisionId: id };
  });

  const ApproveBody = z.object({
    note: z.string().optional(),
    constraints: z
      .array(
        z.object({
          type: z.string(),
          value: z.unknown(),
          description: z.string(),
          enforcement: z.enum(['system', 'agent', 'manual']).default('agent'),
        }),
      )
      .default([]),
  });

  /**
   * 单条批准。批量批准逐条调它 —— 不可代行、状态机、Policy 一个都不绕。
   * 为批量另写一条快路径，是这类功能出事故最常见的原因。
   */
  async function approveDecisionById(
    id: string,
    userId: string,
    actor: ReturnType<typeof actorFrom>['actor'],
    body: z.infer<typeof ApproveBody>,
    correlationId: string,
  ) {
    const [decision] = await db.select().from(decisions).where(eq(decisions.id, id));
    if (!decision) throw notFound('决策');
    if (decision.status !== 'pending') {
      throw new ApiError('VERSION_CONFLICT', '该决策已被处理', { status: decision.status });
    }
    // 决策责任不可代行（docs/tech/09-security.md §2.4）
    if (decision.assigneeId && decision.assigneeId !== userId) {
      throw new ApiError(
        'FORBIDDEN',
        '决策责任不可代行。如需变更责任人，请使用改派功能。',
        { assigneeId: decision.assigneeId },
      );
    }

    await db
      .update(decisions)
      .set({
        status: 'approved',
        resolvedBy: userId,
        resolvedAt: new Date(),
        resolutionNote: body.note,
        appliedConstraints: body.constraints as never,
      })
      .where(eq(decisions.id, id));

    if (decision.workItemId) {
      // 人类附加的约束写入任务，Agent 执行时必须遵守
      if (body.constraints.length > 0) {
        const [item] = await db
          .select()
          .from(workItems)
          .where(eq(workItems.id, decision.workItemId));
        await db
          .update(workItems)
          .set({
            constraints: [
              ...(item?.constraints ?? []),
              ...body.constraints.map((c) => ({ ...c, decisionId: id })),
            ] as never,
          })
          .where(eq(workItems.id, decision.workItemId));
      }

      const result = await transition(db, {
        workItemId: decision.workItemId,
        trigger: 'decision_approved',
        actor,
        correlationId,
      });
      if (!result.ok) throw mapTransitionError(result);
      return { ok: true as const, decisionId: id, workItem: toTransitionResponse(result) };
    }

    return { ok: true as const, decisionId: id };
  }

  app.post('/api/v1/decisions/:id/approve', async (req) => {
    const { userId, actor } = actorFrom(req);
    const { id } = req.params as { id: string };
    const body = ApproveBody.parse(req.body ?? {});
    return approveDecisionById(id, userId, actor, body, corr(req));
  });

  app.post('/api/v1/decisions/:id/reject', async (req) => {
    const { userId, actor } = actorFrom(req);
    const { id } = req.params as { id: string };
    const body = z
      .object({
        reason: z.string({ required_error: '驳回必须填写原因' }).min(1, '驳回必须填写原因'),
      })
      .parse(req.body);

    const [decision] = await db.select().from(decisions).where(eq(decisions.id, id));
    if (!decision) throw notFound('决策');

    await db
      .update(decisions)
      .set({
        status: 'rejected',
        resolvedBy: userId,
        resolvedAt: new Date(),
        resolutionNote: body.reason,
      })
      .where(eq(decisions.id, id));

    if (decision.workItemId) {
      await transition(db, {
        workItemId: decision.workItemId,
        trigger: 'decision_rejected',
        actor,
        reason: body.reason,
        correlationId: corr(req),
      });
    }
    return { ok: true, decisionId: id };
  });

  // ── 调度 ────────────────────────────────────────────────────────────
  app.post('/api/v1/projects/:id/schedule', async (req) => {
    actorFrom(req);
    const { id } = req.params as { id: string };
    return scheduleRound(db, deps.registry, {
      projectId: id,
      correlationId: corr(req),
      workspaces: deps.workspaces,
    });
  });

  // ── Agent 回调 ──────────────────────────────────────────────────────
  app.post('/api/v1/agent-callback/runs/:id/events', async (req) => {
    const { id } = req.params as { id: string };
    const auth = req.headers['authorization'];

    // Run 级令牌：仅对该 runId 有效，Run 结束即失效
    if (auth !== `Bearer ${id}`) {
      throw new ApiError('UNAUTHENTICATED', 'Run 令牌无效');
    }

    const payload = req.body;
    const batch = Array.isArray(payload) ? payload : [payload];
    const results = [];
    for (const event of batch) {
      results.push(
        await ingestRunEvent(
          db,
          { runId: id, event: event as never, correlationId: corr(req) },
          { workspaces: deps.workspaces },
        ),
      );
    }
    return { accepted: results.length, results };
  });

  // ── SSE ─────────────────────────────────────────────────────────────
  app.get('/api/v1/stream', async (req, reply) => {
    /**
     * ★★ 这条流此前**完全不鉴权**：任何人猜到频道名就能拿到那个项目
     *   实时推送的全部事件 —— 状态流转、决策、Run 的产出。REST 那边
     *   查同样的数据要过成员关系闸门，这里绕过去了。
     *
     * ★ 令牌走 query 而不是 Authorization 头，是 EventSource 的限制：
     *   它不能带自定义头（同一页的 Last-Event-ID 也是因此走 query 的）。
     *   代价是令牌会进 access log，缓解靠短 TTL。
     */
    actorFrom(req);

    const q = req.query as { channels?: string };
    const channels = (q.channels ?? '').split(',').filter(Boolean);
    if (channels.length === 0) {
      throw new ApiError('VALIDATION_FAILED', '必须指定至少一个频道');
    }

    /**
     * 浏览器只在 EventSource 自己重连时才带 Last-Event-ID 头。
     * 前端因为频道变化主动新建连接时带不上，所以同时支持 query 参数。
     */
    const header = req.headers['last-event-id'];
    const fromQuery = (req.query as { lastEventId?: string }).lastEventId;
    const lastEventId = typeof header === 'string' ? header : fromQuery;

    return handleSse(req, reply, deps, {
      channels,
      lastEventId: typeof lastEventId === 'string' && lastEventId ? lastEventId : undefined,
    });
  });

  // ★ 全部路由注册完，清点一次：有写路由没登记权限就在这里炸，服务起不来
  assertRoutesCovered();
}

/**
 * 流转结果的对外形状。
 *
 * 不能直接返回 transition 的结果：它带 EmittedEvent，其 id 是 bigint，
 * JSON 序列化会抛异常。顺带也避免把内部结构泄漏到 API 契约里。
 */
function toTransitionResponse(
  result: Extract<Awaited<ReturnType<typeof transition>>, { ok: true }>,
) {
  return {
    ok: true as const,
    from: result.from,
    to: result.to,
    stage: result.stage,
    createdDecisionId: result.createdDecisionId,
    policy: {
      matchedPolicyId: result.verdict.matchedPolicyId,
      matchedPolicyName: result.verdict.matchedPolicyName,
      action: result.verdict.action,
      requiresHuman: result.verdict.requiresHuman,
    },
    eventIds: result.events.map((e) => String(e.id)),
  };
}

function mapTransitionError(result: Extract<Awaited<ReturnType<typeof transition>>, { ok: false }>) {
  switch (result.code) {
    case 'NOT_FOUND':
      throw notFound('任务');
    case 'INVALID_TRANSITION':
      throw new ApiError('INVALID_TRANSITION', `当前状态 ${result.from} 不支持该操作`, {
        from: result.from,
        allowedTriggers: result.allowedTriggers,
      });
    case 'GUARD_FAILED':
      throw new ApiError('GUARD_FAILED', result.failures.map((f) => f.reason).join('；'), {
        failures: result.failures,
      });
    case 'POLICY_DENIED':
      throw new ApiError('POLICY_DENIED', result.message, { verdict: result.verdict });
  }
}

/**
 * 模板要发给前端，但 `build` 是函数，序列化不过去。
 * 前端只需要参数表单的描述，具体条件由后端在创建时用 build 拼出来 ——
 * 这样「模板 → 规则」的映射只有一份实现，前端改不了它。
 */
function serializeTemplates() {
  return POLICY_TEMPLATES.map((t) => ({
    id: t.id,
    scenario: t.scenario,
    name: t.name,
    purpose: t.purpose,
    direction: t.direction,
    params: t.params,
  }));
}
