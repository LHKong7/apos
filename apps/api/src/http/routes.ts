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
  requirementAssumptions,
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
  Environment,
  humanActor,
  IntegrationProvider,
  NotificationConfig,
  OperationType,
  OrgRole,
  ProjectRole,
  STATUS_LABELS,
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
  refreshCompleteness,
} from '../modules/requirement/service';
import { approvePlan, generatePlan } from '../modules/planning/service';
import { scheduleRound } from '../modules/flow/scheduler';
import { transition, transitionInTransaction } from '../modules/flow/transition';
import {
  recordHumanAcceptance,
  recordHumanAcceptanceInTransaction,
  rollUpRequirementAcceptance,
  rollUpRequirementAcceptanceInTransaction,
} from '../modules/flow/review';
import { dispatchRun, resumeQueuedRun } from '../modules/agent/dispatch';
import type { WorkspaceService } from '../modules/workspace';
import { ingestRunEvent } from '../modules/agent/ingest';
import { emitAndPublish } from '../modules/event/bus';
import { emit, type EmittedEvent } from '../modules/event/emitter';
import {
  ChangePasswordInput,
  CreateAccountInput,
  LoginInput,
  RegisterInput,
  TokenError,
  assertSignupAllowed,
  assertSignupEnabled,
  changeOwnPassword,
  createAccount,
  login,
  registerAccount,
  signupEnabled,
  tokenFrom,
  verifyToken,
} from '../modules/auth';
import { ApiError, asClientInputError, fail, notFound, sendError } from './errors';
import { listMembers, listOrgUsers, removeMember, setMemberRole, setOrgRole } from './members';
import { cloneRole, createRole, deleteRole, listRoles, previewRole, updateRole } from './roles';
import {
  createRbac,
  agentContext,
  deferred,
  guardRouteCoverage,
  runOwnerContext,
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
import { authorizeChannels } from './sse-channels';
import { appendConstraints } from '../modules/work-item/json-merge';
import { getBoard } from './board';
import { getGraph } from './graph';
import { getAnalytics, getAnalyticsItems } from './analytics';
import { getOverview } from './overview';
import { getAgent, listAgents, listRuntimes } from './agents';
import {
  AgentCreateInput,
  AgentInput,
  createAgent,
  deleteAgent,
  listAgentsAdmin,
  listCapabilityCatalog,
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
import {
  createStorageTarget,
  deleteStorageTarget,
  listStorageTargets,
  probeStorageTarget,
  StorageTargetInput,
  updateStorageTarget,
} from './storage-targets';
import { AssigneeInput, listCandidates, setAssignee } from './assignment';
import {
  addAssumption,
  confirmAssumption,
  invalidateAssumption,
  listAssumptions,
  reopenRequirement,
  setRequirementAuthorAgent,
} from '../modules/requirement/service';
import { BindingInput, listProjectAgents, setProjectAgent } from './project-agents';
import {
  AgentAccessInput,
  getAgentAccess,
  previewAgentAccess,
  setAgentAccess,
} from '../modules/agent/access';
import { executeGovernedMutation } from './governed-mutation';
import { listArtifactFiles, openArtifactFile, readArtifactFile } from './artifact-files';
import { batchApprove, getDecisionInbox, type DecisionScope } from './decision-center';
import { comparePlans, getPlanDetail, listRequirements } from './intake';
import { listDeliveries } from '../modules/notification/service';
import {
  autonomyPreview,
  clearOperationSwitch,
  deletePolicy,
  evaluateScenario,
  getPolicies,
  getPolicyHistory,
  getPolicyHits,
  loadProjectPolicies,
  nextAuthoredPriority,
  runSimulation,
  savePolicy,
  setOperationSwitch,
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
  /** Workspace provisioning; omit it and no code directory is prepared for a Run (tests only) */
  workspaces?: WorkspaceService;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LABELS: Record<string, string> = {
  pause: '暂停',
  resume: '恢复',
  terminate: '终止',
  add_constraint: '追加约束',
};

/** Fallback action when the runtime lacks the capability — tells the user what to do instead */
const FALLBACK: Record<string, string | null> = {
  pause: '该运行时只能终止。终止不可恢复，确认后请改用「终止」。',
  resume: '该运行时不支持恢复，请改用「重试」创建新 Run。',
  terminate: null,
  add_constraint: '该运行时不支持执行中注入约束，请终止后补充上下文重试。',
};

/**
 * Where identity comes from: `Authorization: Bearer <JWT>` (docs/tech/09-security.md §1.3).
 *
 * ★★ This used to read `X-User-Id` — a header that carries **no proof of anything**:
 *   write someone else's uuid into it and you were them. The entire RBAC layer sat on
 *   top of that header, so the entire RBAC layer was decoration. Identity must now be
 *   proven by a server-signed token, and userId is read out of the signed claims —
 *   the caller does not get a vote.
 *
 * ★ An invalid token and a missing token both answer 401, but with **different
 *   messages**: "not signed in" and "your session expired" are two different situations
 *   for a user. The first sends them to the login page; the second tells them they
 *   really were signed in a moment ago and need not suspect their account.
 *
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
    throw fail('UNAUTHENTICATED', 'auth.missing_token', '未登录：请求缺少 Authorization: Bearer 令牌');
  }
  try {
    const claims = verifyToken(token);
    if (!UUID_RE.test(claims.sub)) {
      throw fail('UNAUTHENTICATED', 'auth.bad_token_subject', '令牌里的身份不是合法的用户 ID');
    }
    return { userId: claims.sub, actor: humanActor(claims.sub) };
  } catch (err) {
    if (err instanceof TokenError) throw fail(
      'UNAUTHENTICATED',
      err.reason,
      err.message,
      { params: err.params },
    );
    throw err;
  }
}

/**
 * For endpoints where identity is optional (list filters, the board's "only what needs me").
 *
 * No token means null; a token that *is* present must be valid. "Present but invalid"
 * can never be silently downgraded to "absent" — the user would be shown an empty
 * "nothing waiting on me" page whose real cause is an expired token.
 *
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
 * Role key → built-in role; anything unrecognized becomes null.
 *
 * ★ The narrow integration-settings check (canIntegration) only speaks built-in roles.
 *   A custom role degrades to "not built in" there, and that loosens nothing:
 *   preHandler has already judged the caller by their permission set, so this is a
 *   second gate that can only be stricter, never laxer.
 *
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

/** RFC 4122's 8-4-4-4-12. Case-insensitive, exactly like Postgres's own uuid input */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A caller can carry their own trace ID in via `X-Correlation-Id`, so that one
 * cross-system operation lines up in the logs on both sides.
 *
 * ★★ Only uuid-shaped values are accepted — `events.correlation_id` is a uuid column.
 *
 *   This used to pass the header straight through. A client sending `trace-abc-123`
 *   (W3C traceparent, a Jaeger span id… not one of them is a uuid) got all the way to
 *   the INSERT before Postgres threw it back as 22P02, which the error layer then
 *   rendered as a 400 reading "malformed path or query parameter".
 *
 *   ★ Misleading three ways over: the problem is in neither the path nor the query
 *     (it is a header), the message never says the words "correlation id", and what the
 *     caller experiences is "the register endpoint always 400s for me, and works fine
 *     from a different client".
 *
 * ★ An unrecognized value is replaced with a fresh uuid rather than rejected: a
 *   correlation id is a diagnostic aid, not a business contract. Blocking a real write
 *   over a tracing header is a wildly lopsided trade.
 *
 * 调用方可以用 `X-Correlation-Id` 把自己的追踪 ID 带进来，这样一次跨系统的
 * 操作在两边的日志里能对上。
 *
 * ★★ 但只认 uuid 形态 —— `events.correlation_id` 是 uuid 列。
 *
 *   之前这里是原样透传：客户端送一个 `trace-abc-123`（W3C traceparent、
 *   Jaeger 的 span id…… 没有一个是 uuid），请求会一路走到 INSERT 才被
 *   Postgres 以 22P02 顶回来，出口翻译成 400「路径或查询参数的格式不合法」。
 *
 *   ★ 三重误导：问题既不在路径也不在查询参数（在请求头），报错里不提
 *     correlation id 半个字，而调用方那边的现象是「注册接口对我永远返回
 *     400，换个客户端就好了」。
 *
 * ★ 认不出来就换一个新的，而不是报错：correlation id 是诊断辅助，
 *   不是业务契约。为了一个追踪头把真正的写入挡掉，代价不对等。
 */
function corr(req: { headers: Record<string, unknown> }): string {
  const header = req.headers['x-correlation-id'];
  return typeof header === 'string' && UUID_PATTERN.test(header) ? header : randomUUID();
}

/**
 * The caller's UI language — server-generated output has to be written in it.
 *
 * ★ An unrecognized value falls back to 'en' (the product default) rather than being
 *   passed through as nothing. Passing nothing hands the choice of language back to
 *   the model, and that is precisely the disease being treated: one project ending up
 *   with an English PRD and a Chinese one side by side, with no setting anywhere in
 *   the UI that governs which you get.
 *
 * 调用方的界面语言 —— 服务端生成的产出要用它来写。
 *
 * ★ 认不出的取值回落到 'en'（产品默认语言），**不是**沉默地不传：
 *   不传等于把语言的选择权交还给模型，而那正是要治的病
 *   —— 同一个项目里中英两份 PRD 并存，界面上没有设置左右得了它。
 */
function localeOf(req: { headers: Record<string, unknown> }): 'en' | 'zh' {
  return req.headers['x-locale'] === 'zh' ? 'zh' : 'en';
}

/**
 * Key-order-independent serialization for deep comparison — answering "did this field
 * really change?".
 *
 * ★★ You cannot just `JSON.stringify` both sides and compare.
 *
 *   A submitted object keeps whatever key order the client code wrote, while jsonb read
 *   back out of the database comes in Postgres's normalized order (by key length first,
 *   then lexicographically). One round trip is enough to make an identical acceptance
 *   criterion compare unequal, so every save looks like an edit — a person changes one
 *   field and the whole panel gets stamped "👤 human".
 *
 * 键序无关的深比较用序列化 —— 判断「这个字段真的变了吗」。
 *
 * ★★ 不能直接 `JSON.stringify` 两边比。
 *
 *   提交上来的对象保持代码里写的键序，而从库里读回来的 jsonb 是
 *   Postgres 归一化过的键序（先按键长、再按字典序）。同一份验收标准
 *   进出一趟就「不相等」了，于是每一次保存都被判定为改动过 ——
 *   人只改了一个字段，整块面板却全被标成「👤 人工」。
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return v;
  });
}

export async function registerRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  /**
   * ★★ Must be installed before any route is registered: it tallies routes one by one
   *   through the onRoute hook, so installing it late silently skips everything already
   *   registered — and a coverage checker with a hole in it looks exactly like "all
   *   good". The actual assertion runs at the end of this function, once every route
   *   is in place.
   *
   * ★★ 必须在注册任何路由之前挂上：它靠 onRoute 钩子逐条清点，
   *   挂晚了就漏掉前面那些 —— 而「清点器自己漏了」的表现是「一切正常」。
   *   实际断言在函数末尾，那时路由才注册完。
   */
  const assertRoutesCovered = guardRouteCoverage(app);

  app.setErrorHandler((error: unknown, _req, reply) => {
    if (error instanceof ApiError) return sendError(reply, error);
    if (error instanceof ZodError) {
      return sendError(reply, fail(
        'VALIDATION_FAILED',
        'request.invalid_params',
        '请求参数不合法',
        { details: error.issues },
      ));
    }
    const fastifyErr = error as { validation?: unknown; statusCode?: number; message?: string };
    if (fastifyErr.validation) {
      return sendError(
        reply,
        fail(
          'VALIDATION_FAILED',
          'request.invalid_params',
          '请求参数不合法',
          { details: fastifyErr.validation },
        ),
      );
    }
    // ★ A client error must never be swallowed as a 500 — that tells the caller the
    //   server is broken when the request was.
    if (fastifyErr.statusCode && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 500) {
      const code = fastifyErr.statusCode === 429 ? 'RATE_LIMITED' : 'VALIDATION_FAILED';
      return sendError(reply, fail(code, 'request.invalid', fastifyErr.message ?? '请求不合法'));
    }
    // The other half of the same rule: some bad client input is only caught down at the
    // SQL layer, which throws a PostgresError rather than a fastify 4xx, so it has to be
    // recognized separately.
    const inputErr = asClientInputError(error);
    if (inputErr) {
      app.log.warn({ err: error }, 'client input rejected by database');
      return sendError(reply, inputErr);
    }
    app.log.error({ err: error }, 'unhandled error');
    return sendError(reply, fail('INTERNAL', 'internal', '服务器内部错误'));
  });

  // Plenty of POST endpoints need no body at all (analyze, schedule). Sending the
  // content-type header with an empty body is a common client idiom and must not error.
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

  // ── Sign-in ─────────────────────────────────────────────────────────
  /**
   * Trade an email and password for a JWT (docs/tech/09-security.md §1.3).
   *
   * ★★ The one write route that needs no identity, hence its place on the rbac exempt
   *   list — "sign in before you may sign in" is not a coherent requirement. This route
   *   *is* the source of identity.
   *
   * ★ Accounts have exactly three origins: the first one (the superuser) comes from
   *   .env and is bootstrapped at startup (modules/auth/bootstrap.ts); accounts opened
   *   by an organization admin (POST /api/v1/admin/users); and self-service signup
   *   (the route just below).
   *
   * 用邮箱与口令换一张 JWT（docs/tech/09-security.md §1.3）。
   *
   * ★★ 这是唯一一条不需要身份的写路由，所以它在 rbac 的豁免清单里 ——
   *   要求「先登录才能登录」显然不成立。它自己就是身份的来源。
   *
   * ★ 账号有三个来源：第一个（超管）来自 .env，启动时自举
   *   （modules/auth/bootstrap.ts）；组织管理员开的号
   *   （POST /api/v1/admin/users）；以及自助注册（下面那条）。
   */
  app.post('/api/v1/auth/login', async (req) => {
    return login(db, LoginInput.parse(req.body));
  });

  /**
   * Self-service signup — every registration grows a **brand-new organization of its
   * own**, with the registrant as its org_admin.
   *
   * ★★ This is not "put yourself into some existing organization".
   *
   *   The line in 09-security about deliberately having no self-service signup guards
   *   against that second thing: the organization boundary *is* the tenant boundary, so
   *   letting anyone walk into an existing organization means there is no boundary. What
   *   happens here instead is an **empty new organization** each time; nobody lands
   *   inside anybody else's boundary. Getting into someone else's organization still has
   *   exactly one path: an admin of that organization adds you.
   *
   * ★ Unauthenticated, runs scrypt every time, and writes four tables — so it goes
   *   through a throttle first (modules/auth/throttle.ts). That is a coarse in-process
   *   gate and does not replace rate limiting at the edge.
   *
   * ★ The order of the two gates is deliberate: check the master switch first, record
   *   the throttle second. Reversed, an instance with signup turned off would still burn
   *   throttle budget on every attempt — and not one of those requests should have been
   *   entertained at all.
   *
   * 自助注册 —— 每次注册长出一个**自己的新组织**，注册者是它的 org_admin。
   *
   * ★★ 这不是「把自己放进某个已有组织」。
   *
   *   09-security 里那句「刻意没有自助注册」防的是后者：组织边界就是
   *   多租户边界，能自助进入已有组织等于边界不存在。而这里每次注册开的是
   *   一个**空的新组织**，谁也进不到别人的边界里 —— 要进别人的组织，
   *   仍然只有「被那个组织的管理员加进去」一条路。
   *
   * ★ 未鉴权 + 每次都跑 scrypt + 写四张表，所以先过一道限流
   *   （modules/auth/throttle.ts）。那是进程内的粗闸，不替代入口层限流。
   *
   * ★ 两道闸的次序是刻意的：先看总开关，再记限流。反过来的话，
   *   一个关着注册的实例仍然会为每次尝试消耗限流额度 ——
   *   而那些请求本来一个都不该被受理。
   */
  app.post('/api/v1/auth/register', async (req) => {
    assertSignupEnabled();
    assertSignupAllowed(req.ip);
    return registerAccount(db, { correlationId: corr(req) }, RegisterInput.parse(req.body));
  });

  /**
   * The small amount of server configuration the sign-in page needs to know.
   *
   * ★★ Whether signup is open is a **server-side** fact, so the frontend has to ask;
   *   it cannot be a build-time constant. One frontend bundle is served by many
   *   instances (web-app.ts mounts it inside the API process), so baking the flag in
   *   would mean shipping two separate bundles for a deployment with signup on and one
   *   with signup off.
   *
   * ★ No identity required — the whole point is that it is read by people who have not
   *   signed in yet. It returns one boolean and nothing that could be used for recon.
   *
   * 登录页要知道的那点服务端配置。
   *
   * ★★ 注册开不开是**服务端**的事，前端必须来问，不能靠构建期变量。
   *   同一份前端产物会被不同实例托管（web-app.ts 把它挂在 API 进程里），
   *   烤进构建里的话，一个开着注册、一个关着注册的两套部署就得出两份产物。
   *
   * ★ 无需身份 —— 它就是给还没登录的人看的。回的东西也只有这一个布尔，
   *   没有任何可以拿来做侦察的信息。
   */
  app.get('/api/v1/auth/config', async () => ({ allowSignup: signupEnabled() }));

  /** Who is signed in. The frontend uses it to confirm the token is still good and to show "who am I" */
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
     * ★ The token verified but the person is gone (account deleted) — that is a 401,
     *   not a 404. What the caller must conclude is "this token no longer stands for
     *   anyone, go sign in again", whereas a 404 gets treated by the frontend as "some
     *   resource is missing" and it carries on.
     *
     * ★ 令牌验过了但人没了（被删号）——  这是 401 不是 404：
     *   对调用方而言结论是「这张令牌不再代表任何人，去重新登录」，
     *   而 404 会被前端当成"某个资源不存在"接着往下走。
     */
    if (!row) throw fail('UNAUTHENTICATED', 'auth.account_gone', '账号不存在或已被删除，请重新登录');

    /**
     * ★ Use the lenient resolver: this endpoint has to be able to answer "who am I"
     *   even when the organization named in the request no longer exists. Reasoning is
     *   at {@link resolveCurrentOrgLenient} in rbac.ts — the strict check would lock the
     *   frontend out entirely.
     *
     * ★ 用 lenient 版：这个端点必须能回答「我是谁」，
     *   哪怕请求里带的组织已经不存在了。理由见 rbac.ts 的
     *   {@link resolveCurrentOrgLenient} —— 严格判定会把前端锁死。
     */
    const current = await resolveCurrentOrgLenient(db, userId, orgHeaderOf(req));
    return { user: row, currentOrgId: current.orgId, orgRole: current.orgRole };
  });

  /** Change your own password. The superuser's initial password comes from .env and should be changed on first sign-in */
  app.post('/api/v1/auth/password', async (req) => {
    const { userId } = actorFrom(req);
    const { orgId } = await resolveCurrentOrg(db, userId, orgHeaderOf(req));
    return changeOwnPassword(
      db,
      { userId, orgId, correlationId: corr(req) },
      ChangePasswordInput.parse(req.body),
    );
  });

  // ── Identity ────────────────────────────────────────────────────────
  /**
   * The people in this organization. Assigning an owner and filtering by "whose task"
   * both need it.
   *
   * ★★ Identity is mandatory, and only people in the **same organization** come back.
   *   Without identity this used to return every user in the database — a bootstrap hole
   *   left over from the X-User-Id era, when the identity switcher needed a roster
   *   before anyone could be picked. Identity now comes from signing in, so the hole is
   *   no longer needed, and without a purpose it reverts to what it always was: an
   *   unauthenticated global address-book export.
   *
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
     * ★ An org role belongs to a **membership**, so this roster has to be joined through
     *   the current organization. Reading it off `users` the old way would show someone's
     *   admin role from a *different* organization as their role here — and a reader
     *   would reasonably conclude they can approve things.
     *
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
   * ★★ The authorization gate — layers ① and ② of docs/tech/09-security.md §2.1.
   *
   *   ② Project membership: the spec calls for four layers where any one of them can
   *   deny, but layer ② used to exist only on the integration endpoints
   *   (assertIntegration); every other piece of project data checked no membership at
   *   all. Measured consequence: a user in organization A could read *and* write
   *   organization B's board, execution graph, analytics, policies, and requirements —
   *   cross-tenant data was wide open at the application layer.
   *
   *   ① Org/project role: membership only answers "is this one of us"; it cannot answer
   *   "approving a plan takes tech_lead" or "loosening a policy takes a simulation".
   *   The permission matrix (§2.3) is registered route by route in rbac.ts, and a write
   *   route that forgets to register keeps the server from starting.
   *
   * ★ It is a preHandler rather than one line inside forty handlers because "somebody
   *   forgot one" is the entire cause of this class of hole. The hook intercepts by URL
   *   shape, so a /projects/:id/* route added later is closed by default and its author
   *   does not have to remember anything.
   *
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
   * The project ids this caller can see.
   *
   * ★ List-shaped endpoints (the decision inbox, the agent roster) carry no project id
   *   in their URL, so the URL-shaped gate cannot reach them — in practice a user who
   *   belonged to exactly one project saw decisions from three projects across three
   *   organizations in their inbox. Endpoints like these have to scope themselves.
   *
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
   * Resource id → the project it belongs to.
   *
   * ★ A path like /work-items/:id shows no project, yet what it returns is project data
   *   all the same and must pass layer ②. Every new resource route has to be registered
   *   here — an unregistered route is an unguarded one.
   *
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
      /**
       * ★★ Artifacts must be registered here, or the file gateway is **unguarded**.
       *
       *   `/api/v1/artifacts/:id/files` does not match PROJECT_SCOPED_URL, so this table
       *   is the only way the gate learns which project it belongs to. Forgetting the
       *   entry shows up as "any signed-in user can read any project's artifact files" —
       *   the single property this gateway must never have.
       *
       * ★★ 产物必须登记在这里，否则文件网关就是**不设防**的。
       *
       *   `/api/v1/artifacts/:id/files` 不落在 PROJECT_SCOPED_URL 上，
       *   闸门只有靠这张表才知道它属于哪个项目。漏登记的表现是
       *   「任何登录用户都能读任意项目的产物文件」——
       *   而那正是这个网关最不该有的性质。
       */
      case 'artifacts':
        return one(await db.select({ projectId: artifacts.projectId }).from(artifacts).where(eq(artifacts.id, id)));
      /** ★ Same as artifacts: the URL shows no project, so skipping the entry leaves it unguarded */
      case 'assumptions': {
        const rows = await db
          .select({ projectId: requirements.projectId })
          .from(requirementAssumptions)
          .innerJoin(requirements, eq(requirements.id, requirementAssumptions.requirementId))
          .where(eq(requirementAssumptions.id, id));
        return one(rows);
      }
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

  /** Membership check for handlers that still need it (the role itself is cached by preHandler) */
  async function assertProjectMember(projectId: string, userId: string, req: FastifyRequest) {
    const actor = await rbac.assertProjectAccess(req, projectId, userId);
    return actor.projectRole;
  }

  // ── Projects ────────────────────────────────────────────────────────
  /**
   * ★ Returns only the projects the caller is a member of. This used to be an
   *   unconditional `select * from projects`, so anyone — including requests with no
   *   identity at all — could pull the project list of every organization.
   *
   * ★ 只返回调用者是成员的项目。
   *   此前是无条件 `select * from projects`，任何人（含不带身份的请求）
   *   都能拿到全部组织的项目清单。
   */
  app.get('/api/v1/projects', async (req) => {
    const { orgId, userId } = await callerOrg(req);
    /**
     * ★★ Narrow by the **current organization** as well, not by membership alone.
     *
     *   Once an account can belong to several organizations, "projects I am a member of"
     *   spans organizations — you switch to organization A and see organization B's
     *   projects, with no error on either side. The organization is the tenant boundary,
     *   so the list has to stop at it.
     *
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
    if (!project) throw notFound('project');

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
        tokensSpent: project.tokensSpent,
        tokenBudget: project.tokenBudget,
      },
    };
  });

  // ── Organizations (the top-level container; Plane calls it a Workspace) ──
  /**
   * ★★ Before this, an organization was just an `org_id` column: the table existed, the
   *   foreign keys existed, the tenant checks existed — but **no endpoint could create,
   *   rename, or switch one**, and the only source was the seed script. Multi-tenancy
   *   held at the database layer while the product was a single-tenant instance.
   *
   * ★★ 在此之前组织只是一列 `org_id`：表在、外键在、多租户判定也在，
   *   但**没有任何接口能创建、改名或切换它**，唯一的来源是 seed 脚本。
   *   于是「多租户」只在数据库层面成立，产品上是个单租户实例。
   */
  app.get('/api/v1/organizations', async (req) => {
    const { userId } = actorFrom(req);
    const list = await listMyOrganizations(db, userId);
    /**
     * ★ Ship "which one is current" alongside the list. The frontend must not guess the
     *   default — guessing wrong looks like the switcher showing A while the data is B,
     *   with no error on either side.
     *
     * ★★ This one **stays strict**: an org id that is passed but does not belong to the
     *   caller gets a flat 404, never a confirmation that the organization exists (see
     *   the matching case in organizations.test.ts). Self-healing from a stale orgId
     *   happens in `/auth/me` — that endpoint needs no org scope at all, so letting it
     *   alone be lenient is enough; there is no reason to open this one up too.
     *
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

  app.patch(
    '/api/v1/organizations/:id',
    {
      config: {
        auth: {
          permission: 'organization.update',
        },
      },
    },
    async (req) => {
      const { orgId, userId } = await callerOrg(req);
      assertCurrentOrg(req, orgId);
      const body = OrganizationPatch.parse(req.body);
      return updateOrganization(db, { orgId, actorId: userId, correlationId: corr(req) }, body);
    },
  );

  app.delete(
    '/api/v1/organizations/:id',
    {
      config: {
        auth: {
          permission: 'organization.delete',
        },
      },
    },
    async (req) => {
      const { orgId, userId } = await callerOrg(req);
      assertCurrentOrg(req, orgId);
      return deleteOrganization(db, { orgId, actorId: userId, correlationId: corr(req) });
    },
  );

  app.get('/api/v1/organizations/:id/members', async (req) => {
    const { orgId } = await callerOrg(req);
    assertCurrentOrg(req, orgId);
    return listOrganizationMembers(db, orgId);
  });

  app.post(
    '/api/v1/organizations/:id/members',
    {
      config: {
        auth: {
          permission: 'organization.members.manage',
        },
      },
    },
    async (req) => {
      const { orgId, userId } = await callerOrg(req);
      assertCurrentOrg(req, orgId);
      const body = z.object({ email: z.string().email(), orgRole: OrgRole.default('member') }).parse(
        req.body,
      );
      return addOrganizationMember(db, { orgId, actorId: userId, correlationId: corr(req) }, body);
    },
  );

  app.delete(
    '/api/v1/organizations/:id/members/:userId',
    {
      config: {
        auth: {
          permission: 'organization.members.manage',
        },
      },
    },
    async (req) => {
      const { orgId, userId: actorId } = await callerOrg(req);
      assertCurrentOrg(req, orgId);
      const { userId: targetId } = req.params as { userId: string };
      return removeOrganizationMember(
        db,
        { orgId, actorId, correlationId: corr(req) },
        targetId,
      );
    },
  );

  /**
   * ★★ The organization in the URL must be the **current** organization.
   *
   *   The permission check (rbac's resolveActor) reads the orgRole of the current
   *   organization, so if the handler then goes and modifies a *different* organization
   *   named in the URL, that check bought nothing: sitting in organization A where you
   *   are an admin, you send a request pointing at organization B and edit B with A's
   *   admin rights. This is the textbook shape of privilege escalation.
   *
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
      throw fail(
        'FORBIDDEN',
        'auth.wrong_org',
        '只能操作当前组织。请先切换到目标组织（X-Org-Id）后再试',
        { details: { currentOrgId: orgId, requested: id } },
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
    tokenBudget: z.number().int().positive().optional(),
    /**
     * Prefix for work item numbers (`ORD` → `ORD-19`). Derived from the project name
     * when omitted. Unique within the organization — collisions get a suffix.
     */
    identifier: z
      .string()
      .regex(IDENTIFIER_RE, '前缀只能用大写字母和数字，2–10 位，且以字母开头')
      .optional(),
    /** ★ Omitted means the current organization. If given, it must match it (checked below) */
    orgId: z.string().uuid().optional(),
  });

  app.post(
    '/api/v1/projects',
    {
      config: {
        auth: {
          permission: 'project.create',
        },
      },
    },
    async (req, reply) => {
      const { userId } = actorFrom(req);
      const body = CreateProject.parse(req.body);
      const actor = await rbac.resolveActor(req, userId, null);

      /**
       * ★ The orgId comes from the caller's current organization, never from the request
       *   body. Trusting body.orgId would let anyone drop a project into somebody else's
       *   organization, where it then lives in their project list and their cost totals.
       *
       * ★ Omitting it uses the current organization. Demanding the frontend know its own
       *   orgId before it can create a project turns an implementation detail into its
       *   burden — and the server already has the value.
       *
       * ★ orgId 以调用者的当前组织为准，不听请求体的。
       *   照抄 body.orgId 的话，任何人都能往别的组织里塞一个项目 ——
       *   而那个项目从此挂在对方的项目列表、对方的成本统计里。
       *
       * ★ 不传则用当前组织。要求前端必须知道自己的 orgId 才能建项目，
       *   是把实现细节变成了它的负担 —— 而这个值服务端本来就有。
       */
      if (body.orgId && body.orgId !== actor.orgId) {
        throw fail('FORBIDDEN', 'org.cross_org_create', '只能在当前组织下创建项目', { details: {
          orgId: actor.orgId,
        } });
      }

      const { orgId: _ignored, identifier, ...fields } = body;
      /**
       * ★ The prefix cannot be left to a default. If every project shares `TASK`, then
       *   `TASK-19` points at several rows across the organization — and the entire
       *   reason these numbers exist is that saying one out loud identifies exactly one
       *   item.
       *
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
       * ★★ The creator has to be written in as a member, or they cannot get into the
       *   project they just created: the membership gate (§2.1.1) does not read the
       *   techLeadId field, only project_members. Holes of this shape — the feature looks
       *   finished but the very first step is impassable — only surface once permissions
       *   are actually enforced.
       *
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
    },
  );

  // ── Members and roles (09-security §2.2) ─────────────────────────────
  /**
   * ★ The permission verdict itself has to be visible.
   *
   *   The frontend should not have to guess which buttons work: one call returns every
   *   permission the current identity holds in this project plus the reason behind each
   *   denial, and the UI grays buttons out and says who to go ask. The server still
   *   judges independently — sharing one rule set is not the same as trusting the client.
   *
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

  app.get(
    '/api/v1/projects/:id/members',
    {
      config: {
        auth: {
          permission: 'project.view',
        },
      },
    },
    async (req) => {
      const { userId } = actorFrom(req);
      const { id } = req.params as { id: string };
      const actor = await rbac.resolveActor(req, userId, id);
      return listMembers(db, id, actor.orgId);
    },
  );

  /**
   * Assign a role.
   *
   * ★ The `:memberId` in the path is either a user id or an agent id, told apart by
   *   `actorType`. Whether a seat is filled by a person or by an agent is, in this
   *   product, two answers to one question — it should not be two APIs.
   *
   * 指派角色。
   *
   * ★ 路径上的 `:memberId` 既可以是用户 id，也可以是 Agent id ——
   *   由 `actorType` 区分。一个岗位由人还是由 Agent 担任，
   *   在这个产品里是同一个问题的两个答案，不该是两条 API。
   */
  const MemberRoleBody = z.object({
    /**
     * ★ Optional — omitting it means "join on the default profile". Only agents may call
     *   it that way; a human is rejected inside setMemberRole (see the note there).
     *
     * ★ 可选 —— 省略表示「按默认档加入」。只有 Agent 能这么调，
     *   人由 setMemberRole 挡回去（见那里的注释）。
     */
    role: z.string().min(1).optional(),
    actorType: z.enum(['human', 'agent']).default('human'),
  });

  app.put(
    '/api/v1/projects/:id/members/:memberId',
    {
      config: {
        auth: {
          permission: 'project.members.manage',
        },
      },
    },
    async (req) => {
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
        body.role ?? null,
      );
    },
  );

  app.delete(
    '/api/v1/projects/:id/members/:memberId',
    {
      config: {
        auth: {
          permission: 'project.members.manage',
        },
      },
    },
    async (req) => {
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
    },
  );

  /** Organization address book and identity management (§2.2, "org_admin: identity management") */
  app.get('/api/v1/admin/users', async (req) => {
    const { orgId } = await callerOrg(req);
    return listOrgUsers(db, orgId);
  });

  /**
   * Open an account — an organization admin creates one for someone else and puts them
   * straight into this organization.
   *
   * ★★ The **only** way an account enters the system, apart from the superuser, who
   *   comes from .env. No self-service signup into an existing organization: in this
   *   product the organization boundary is the tenant boundary, so self-service signup
   *   would let anyone place themselves inside it.
   *
   * ★ The permission is `organization.members.manage`, not `org.members.manage`. The
   *   catalog keeps those two apart: the former is "bring an account from outside the
   *   boundary in", the latter is "change a role inside the organization". Creating an
   *   account is plainly the former — and a step earlier still.
   *
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
  app.post(
    '/api/v1/admin/users',
    {
      config: {
        auth: {
          /**
           * ★ Creating an account is "bring someone from outside the boundary in", a
           *   different tier from changing an org role (the next route): that one only
           *   moves permissions around inside the organization, while getting this one
           *   wrong puts data across a tenant line.
           *
           * ★ 建账号是「把边界外的人放进来」，与改组织角色（下一条）是两档：
           *   后者只在组织内部移动权限，前者错了是数据出了租户。
           */
          permission: 'organization.members.manage',
        },
      },
    },
    async (req, reply) => {
      const { orgId, userId: actorId } = await callerOrg(req);
      const created = await createAccount(
        db,
        { orgId, actorId, correlationId: corr(req) },
        CreateAccountInput.parse(req.body),
      );
      return reply.status(201).send(created);
    },
  );

  app.patch(
    '/api/v1/admin/users/:id/org-role',
    {
      config: {
        auth: {
          permission: 'org.members.manage',
        },
      },
    },
    async (req) => {
      const { orgId, userId: actorId } = await callerOrg(req);
      const { id } = req.params as { id: string };
      const body = z.object({ orgRole: OrgRole }).parse(req.body);
      return setOrgRole(
        db,
        { orgId, targetUserId: id, actorId, correlationId: corr(req) },
        body.orgRole,
      );
    },
  );

  // ── Role definitions (§2.2) ─────────────────────────────────────────
  /**
   * ★★ This is where an admin creates roles such as "engineering", "operations", or
   *   "QA".
   *
   *   The six built-in roles are seeded data, not the complete set: they cover "how a
   *   project runs" and cannot cover "how this particular organization divides work".
   *
   * ★★ 超管在这里造出「研发」「运营」「测试」这些角色。
   *
   *   内置的六个是预置数据，不是全集 —— 它们覆盖「项目怎么运转」，
   *   覆盖不了「这个组织怎么分工」。
   */
  app.get('/api/v1/admin/roles', async (req) => {
    const { orgId } = await callerOrg(req);
    return listRoles(db, orgId);
  });

  app.post(
    '/api/v1/admin/roles',
    {
      config: {
        auth: {
          permission: 'org.roles.manage',
        },
      },
    },
    async (req, reply) => {
      const { orgId, userId } = await callerOrg(req);
      const result = await createRole(db, { orgId, actorId: userId, correlationId: corr(req) }, req.body);
      return reply.status(201).send(result);
    },
  );

  app.patch(
    '/api/v1/admin/roles/:key',
    {
      config: {
        auth: {
          permission: 'org.roles.manage',
        },
      },
    },
    async (req) => {
      const { orgId, userId } = await callerOrg(req);
      const { key } = req.params as { key: string };
      return updateRole(db, { orgId, actorId: userId, correlationId: corr(req) }, key, req.body);
    },
  );

  app.delete(
    '/api/v1/admin/roles/:key',
    {
      config: {
        auth: {
          permission: 'org.roles.manage',
        },
      },
    },
    async (req) => {
      const { orgId, userId } = await callerOrg(req);
      const { key } = req.params as { key: string };
      return deleteRole(db, { orgId, actorId: userId, correlationId: corr(req) }, key);
    },
  );

  /**
   * ★★ "Clone and edit" is the other half of "built-in roles are immutable". Say only
   *   "you cannot change it" and the user's next move is to tick permissions from
   *   scratch — and what they tick will almost certainly not equal what they wanted,
   *   which was "exactly tech_lead, minus one line".
   *
   * ★★ 「复制并改」是内置角色不可改的另一半。只说「改不了」的话，
   *   用户的下一步是从零勾一遍权限，而勾出来的东西和他想要的
   *   「跟 tech_lead 一样但少一条」几乎一定不同。
   */
  app.post(
    '/api/v1/admin/roles/:key/clone',
    {
      config: {
        auth: {
          /** ★ Cloning a role is creating a role — same permission as POST /admin/roles */
          permission: 'org.roles.manage',
        },
      },
    },
    async (req, reply) => {
      const { orgId, userId } = await callerOrg(req);
      const { key } = req.params as { key: string };
      const result = await cloneRole(
        db,
        { orgId, actorId: userId, correlationId: corr(req) },
        key,
        req.body,
      );
      return reply.status(201).send(result);
    },
  );

  /**
   * ★ Impact preview before saving. Roles are **organization-level**: one edit can change
   *   what a dozen people across five projects are able to do, and after the save no
   *   screen anywhere tells the editor that happened.
   *
   * ★ 保存前的影响预览。角色是**组织级**的：改一次可能同时改掉五个项目里
   *   十几个人的可做操作，而那件事在保存之后没有任何界面会告诉他。
   */
  app.post(
    '/api/v1/admin/roles/:key/preview',
    {
      config: {
        auth: {
          /** The preview is read-only: it computes who a save would affect and writes nothing */
          permission: 'project.view',
        },
      },
    },
    async (req) => {
      const { orgId } = await callerOrg(req);
      const { key } = req.params as { key: string };
      return previewRole(db, orgId, key, req.body);
    },
  );

  // ── Requirements ────────────────────────────────────────────────────
  const CreateRequirement = z.object({
    rawInput: z.string().min(1),
    inputMethod: z.string().default('manual'),
  });

  app.post(
    '/api/v1/projects/:id/requirements',
    {
      config: {
        auth: {
          permission: 'requirement.create',
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = CreateRequirement.parse(req.body);

      const [project] = await db.select().from(projects).where(eq(projects.id, id));
      if (!project) throw notFound('project');

      const { userId } = actorFrom(req);
      const [requirement] = await db
        .insert(requirements)
        .values({ orgId: project.orgId, projectId: id, ...body })
        .returning();

      /**
       * ★★ requirement.created was **never actually emitted**: the event catalog declared
       *   it, and the create route just inserted the row and returned.
       *
       *   The effect was that a requirement's life story started in the middle — the
       *   first audit entry was `analyzed` or `approved`, and "who raised this, and
       *   when" was unanswerable. A requirement is the head of the whole chain, and a
       *   timeline missing its head reads as if an already-approved requirement
       *   materialized out of nowhere.
       *
       * ★★ requirement.created 此前**从没被发出来过** —— 事件类型目录里
       *   声明了它，而创建路由只是 insert 完就返回。
       *
       *   后果是需求的生命周期从中间开始：审计里第一条是 analyzed 或 approved，
       *   「谁在什么时候提的这条需求」查不到。而需求是整条链的起点，
       *   缺了起点的时间线读起来像是凭空冒出来一条已确认的需求。
       */
      await emitAndPublish(db, {
        type: 'requirement.created',
        orgId: project.orgId,
        projectId: id,
        actor: humanActor(userId),
        subjectType: 'requirement',
        subjectId: requirement!.id,
        payload: { title: requirement!.title ?? null, source: body.rawInput ? 'raw_input' : 'manual' },
        correlationId: corr(req),
      });

      return reply.status(201).send({ requirement });
    },
  );

  app.get('/api/v1/projects/:id/requirements', async (req) => {
    const { id } = req.params as { id: string };
    return listRequirements(db, id);
  });

  /**
   * Manual editing of the structured fields (page doc 03 §5.4).
   *
   * ★★ This path runs **in parallel with** AI analysis; it is not a patch on top of it.
   *
   *   The structured fields can be filled in entirely by hand with no analysis run
   *   first. A requirement that was already written clearly, a planning agent that was
   *   never configured, an analysis that timed out (the "fall back to filling it in by
   *   hand" escape hatch that product doc 03 §7 explicitly requires) are all legitimate
   *   ways to arrive here. That is why **every** structured field is exposed, not just
   *   the handful of AI outputs that look patchable: open half of them and the manual
   *   path can never produce a complete requirement.
   *
   * ★ The original text is never overwritten — `rawInput` is not an editable field. A
   *   user has to be able to check the structured result against what they wrote to
   *   confirm the AI did not distort their meaning, and that check is worthless the
   *   moment the structured result can write back over the original.
   *
   * 人工编辑结构化字段（页面文档 03 §5.4）。
   *
   * ★★ 这条路与 AI 分析是**并行**的，不是它的补丁。
   *
   *   结构化字段可以完全由人填出来，不必先跑一次分析 —— 需求本来就写得
   *   清楚、规划 Agent 没配好、分析超时（产品文档 03 §7 明确要求「转人工
   *   填写」的那条出路），都是这条路的正当来源。所以这里给的是**全部**
   *   结构化字段，而不是 AI 结果的几个可修补项：只开放一半的话，
   *   人工路径永远填不出一份完整的需求。
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
    userStories: z.array(z.string()).optional(),
    scope: z
      .object({
        inScope: z.array(z.string()).default([]),
        outOfScope: z.array(z.string()).default([]),
      })
      .optional(),
    nonFunctional: z.array(z.string()).optional(),
    successMetrics: z.array(z.string()).optional(),
    constraints: z.array(z.string()).optional(),
    /**
     * ★ Risks on a requirement are plain strings, not objects. The planner runs
     *   `risks.some(r => r.includes(...))`, so slipping an object in here does not fail
     *   until plan generation, and then only as `r.includes is not a function`.
     *
     * ★ 需求上的风险是一串字符串，不是对象。
     *   规划器会 `risks.some(r => r.includes('数据库'))` —— 放个对象进来，
     *   报错要等到生成计划那一步，而且是一句 `r.includes is not a function`。
     */
    risks: z.array(z.string()).optional(),
    /**
     * ★★ Hand-written acceptance criteria have to be normalized into **exactly** the
     *   shape the AI produces.
     *
     *   Downstream they drive verification dispatch in the Review stage (routed by
     *   `verification`) and the acceptance checklist on work items. A missing `id` or
     *   `status` shows up as that criterion never being verified by anyone, while on
     *   screen it looks identical to every other criterion.
     *
     * ★ `verification` defaults to human: for a line of free text a person typed, the
     *   platform has no basis for claiming it can be checked automatically. Defaulting
     *   to auto makes a promise on the user's behalf that they never made.
     *
     * ★★ 人工写的验收标准必须归一成和 AI 产出**完全一样**的形状。
     *
     *   它下游是 Review 阶段的核验调度（按 verification 分派）与工作项上的
     *   验收清单。少一个 id 或 status，表现是那条标准永远没人验，
     *   而页面上它和其它标准看起来一模一样。
     *
     * ★ verification 默认 human：一条人手写的自由文本，平台没有依据
     *   认定它能被自动核验。默认成 auto 是在替用户许一个他没许的承诺。
     */
    acceptanceCriteria: z
      .array(
        z.object({
          id: z.string().min(1).optional(),
          // ★ Trim before the emptiness check: `"   "` is three characters, so min(1)
          //   lets it through, and a blank acceptance criterion becomes a line of work
          //   in the Review stage that can never be decided either way
          text: z.string().trim().min(1, '验收标准不能是空的'),
          verification: z.enum(['auto', 'agent', 'human']).default('human'),
          status: z.enum(['pending', 'passed', 'failed']).default('pending'),
          evidenceRef: z.string().nullable().default(null),
          verifiedAt: z.string().datetime().nullable().default(null),
        }),
      )
      .optional(),
  });

  app.patch(
    '/api/v1/requirements/:id',
    {
      config: {
        auth: {
          permission: 'requirement.edit',
        },
      },
    },
    async (req) => {
      const { userId } = actorFrom(req);
      const { id } = req.params as { id: string };
      const body = EditRequirement.parse(req.body);

      const [before] = await db.select().from(requirements).where(eq(requirements.id, id));
      if (!before) throw notFound('requirement');
      if (before.status === 'approved') {
        throw fail(
          'INVALID_TRANSITION',
          'requirement.confirmed_readonly',
          '需求已确认，不能再编辑。如需修改请先重新打开。',
        );
      }

      const submitted = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));

      /**
       * Give newly written acceptance criteria an id — work items and verification
       * records both point back here by id.
       *
       * ★ When no id arrives, recover the old one by matching the text. Minting a fresh
       *   id every time would mean that saving the form unchanged hands every criterion
       *   a new identity, and every work item and verification record pointing at them
       *   becomes a dangling reference on the spot — with nothing visibly wrong on the
       *   page.
       *
       * 新写的验收标准补上 id —— 工作项与核验记录都按 id 指回这一条。
       *
       * ★ 没带 id 进来时先按原文找回旧的那一条。每次都新发一个 id 的话，
       *   「原样再存一遍」就会把所有标准换一批身份，而指向它们的工作项
       *   与核验记录当场变成悬空引用 —— 页面上看不出任何异样。
       */
      if (body.acceptanceCriteria) {
        const idByText = new Map(
          (before.acceptanceCriteria ?? []).map((c) => [c.text, c.id] as const),
        );
        submitted['acceptanceCriteria'] = body.acceptanceCriteria.map((c) => ({
          ...c,
          id: c.id ?? idByText.get(c.text) ?? randomUUID(),
        }));
      }

      /**
       * ★★ Only fields that **actually changed** count, not fields that were submitted.
       *
       *   The editor submits the whole structured requirement at once (it is one form,
       *   the fields are interdependent, and splitting it into many PATCHes would leave
       *   half a requirement behind whenever one failed midway). Recording provenance by
       *   what was submitted looks like this: the AI drafts, a person edits only the
       *   business goal, and the entire panel flips to "👤 human" — when the sole reason
       *   those markers exist is to let someone tell, before approving, which sentences
       *   they wrote themselves. Once one edit marks everything, the markers are worse
       *   than absent: they lie.
       *
       * ★★ 只认**真的变了**的字段，不认「提交了」的字段。
       *
       *   编辑器一次提交整份结构化需求（一份表单，字段之间互相关联，
       *   拆成一堆 PATCH 只会让中途失败留下半份需求）。按提交的字段记溯源，
       *   表现就是：AI 出稿之后人只改了业务目标，整块面板全变成「👤 人工」——
       *   而那一排标记存在的唯一理由，正是让人在确认前分清哪句话是自己写的。
       *   一改全变之后，它比没有还糟：它在撒谎。
       */
      const changed = Object.keys(submitted).filter(
        (k) =>
          stableJson(submitted[k]) !==
          stableJson((before as unknown as Record<string, unknown>)[k]),
      );
      if (changed.length === 0) return { requirement: before };

      const patch = Object.fromEntries(changed.map((k) => [k, submitted[k]]));

      const [updated] = await db
        .update(requirements)
        .set({ ...patch, updatedAt: new Date() } as never)
        .where(eq(requirements.id, id))
        .returning();

      // Fields a human edited must stay distinguishable from the AI's original values
      // (§5.4, "edited by a human")
      const provenance = { ...(before.fieldProvenance as Record<string, unknown>) };
      for (const field of changed) {
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
        payload: { fields: changed },
        correlationId: corr(req),
      });

      /**
       * ★★ After a manual edit, recompute completeness and advance the status, down the
       *   same path that answering a clarification takes.
       *
       *   Skip the recompute and someone can fill in the goal, the scope, and the
       *   acceptance criteria only to find the six-axis score in the header still frozen
       *   at whatever the analysis produced (zero, if no analysis ever ran) — and that
       *   score is exactly what a user reads to decide whether the requirement is ready
       *   to approve. The status has the same problem: a purely hand-written requirement
       *   stays stuck in draft, the approve button never appears, and the manual path
       *   simply has no end.
       *
       * ★★ 人工改完要重算完整度并推进状态，和回答澄清问题走同一条路径。
       *
       *   不重算的话，一个人把目标、范围、验收标准全填好之后，头部的六维
       *   评分还停在分析那一刻（没分析过就是 0 分），而用户正是照着那个分数
       *   判断「够不够格确认」的。状态同理：纯人工填出来的需求会一直卡在
       *   draft，确认按钮永远不出现 —— 人工这条路就走不到头。
       */
      const refreshed = await refreshCompleteness(db, id);

      return { requirement: refreshed ?? updated };
    },
  );

  app.post(
    '/api/v1/requirements/:id/reject',
    {
      config: {
        auth: {
          permission: 'requirement.approve',
        },
      },
    },
    async (req) => {
      const { userId } = actorFrom(req);
      const { id } = req.params as { id: string };
      const body = z
        .object({
          // ★ A rejection must carry a reason: whoever raised the requirement needs to
          //   know why, or they will simply raise the same thing again unchanged
          reason: z.string({ required_error: '驳回必须填写原因' }).min(1, '驳回必须填写原因'),
        })
        .parse(req.body);

      const [before] = await db.select().from(requirements).where(eq(requirements.id, id));
      if (!before) throw notFound('requirement');

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
    },
  );

  /**
   * Delete a requirement.
   *
   * ★★ Deleting and rejecting are two different things and cannot substitute for each
   *   other. Rejection says "this requirement does not hold" — a reasoned, traceable
   *   conclusion whose record has to survive. Deletion says "this row should never have
   *   existed" — a typo, a double submission, test data. With only rejection available,
   *   people use it for the second case too, the "rejected" list fills up with noise,
   *   and the real rejections stop being visible.
   *
   * ★ Only requirements with **nothing derived from them** can be deleted. Plans and
   *   work items have lives of their own; once they exist, this requirement has already
   *   affected something else and the correct move is to reject it. When the delete is
   *   blocked, name what is blocking it: "cannot delete" alone leaves the user with
   *   nothing to go act on.
   *
   * ★ Clarifications and assumptions are deleted along with the requirement — they
   *   belong to this one requirement and have no independent life. The database demands
   *   it too: `requirementId` is a NOT NULL foreign key in both tables.
   *
   * 删除需求。
   *
   * ★★ 与驳回是两件事，不能互相替代。
   *   驳回是「这个需求不成立」—— 一个有原因、可追溯的结论，记录必须留着。
   *   删除是「这条记录本不该存在」—— 录错了、重复提交、试验数据。
   *   只有驳回而没有删除的话，后者会被当成前者用，「已驳回」列表里堆满
   *   噪音，真正的驳回结论反而看不见。
   *
   * ★ 只删得掉**没有派生物**的需求。计划与工作项有独立的生命周期，
   *   它们一旦存在，这条需求就已经影响了别的东西 —— 此时正确的动作是
   *   驳回。挡下时必须报出挡在哪：只说「删不掉」，用户不知道该去处理什么。
   *
   * ★ 澄清项与假设随需求一起删 —— 它们只属于这一条需求，没有独立生命周期。
   *   这也是数据库层面必须的：那两张表的 requirementId 是 NOT NULL 外键。
   */
  app.delete(
    '/api/v1/requirements/:id',
    {
      config: {
        auth: {
          /**
           * ★ Deletion does not reuse requirement.approve. Rejection is a conclusion (a
           *   business judgment by a sponsor or PM); deletion is housekeeping on the
           *   record itself (PM or tech_lead) — the people answerable for the two are
           *   not the same set.
           *
           * ★ 删除不复用 requirement.approve。驳回是结论（sponsor / pm 的业务判断），
           *   删除是对记录本身的处置（pm / tech_lead）—— 两者的责任人不是同一批。
           */
          permission: 'requirement.delete',
        },
      },
    },
    async (req) => {
      const { userId } = actorFrom(req);
      const { id } = req.params as { id: string };

      const [existing] = await db.select().from(requirements).where(eq(requirements.id, id));
      if (!existing) throw notFound('requirement');

      const derivedPlans = await db
        .select({ id: plans.id })
        .from(plans)
        .where(eq(plans.requirementId, id));
      const derivedItems = await db
        .select({ id: workItems.id })
        .from(workItems)
        .where(eq(workItems.requirementId, id));

      if (derivedPlans.length > 0 || derivedItems.length > 0) {
        const blockers = [
          derivedPlans.length > 0 ? `${derivedPlans.length} 个计划` : null,
          derivedItems.length > 0 ? `${derivedItems.length} 个工作项` : null,
        ].filter((s): s is string => s !== null);
        throw fail(
          'GUARD_FAILED',
          'requirement.has_derived_work',
          `这条需求已经派生出${blockers.join(' 与 ')}，不能删除。要终止它请改用驳回。`,
          { details: { requirementId: id, plans: derivedPlans.length, workItems: derivedItems.length } },
        );
      }

      await db.transaction(async (tx) => {
        await tx
          .delete(requirementClarifications)
          .where(eq(requirementClarifications.requirementId, id));
        await tx.delete(requirementAssumptions).where(eq(requirementAssumptions.requirementId, id));
        await tx.delete(requirements).where(eq(requirements.id, id));
      });

      /**
       * ★ Publish only after the transaction commits (the rule in modules/event/bus.ts).
       *
       * ★ The payload carries the title and a snippet of the original text: the entity is
       *   gone, so this event is the only trace that it ever existed. Record just an id
       *   and an auditor reading this line still has no idea what was deleted.
       *
       * ★ 提交之后才发事件（modules/event/bus.ts 的纪律）。
       *
       * ★ payload 要带上标题与原文摘要：实体没了，这条事件是它存在过的
       *   唯一痕迹。只记一个 id 的话，审计时翻到这一行也不知道删的是什么。
       */
      await emitAndPublish(db, {
        orgId: existing.orgId,
        projectId: existing.projectId,
        type: 'requirement.deleted',
        actor: humanActor(userId),
        subjectType: 'requirement',
        subjectId: id,
        payload: {
          title: existing.title,
          status: existing.status,
          rawInput: existing.rawInput.slice(0, 200),
        },
        correlationId: corr(req),
      });

      return { ok: true };
    },
  );

  app.get('/api/v1/requirements/:id', async (req) => {
    const { id } = req.params as { id: string };
    const [requirement] = await db.select().from(requirements).where(eq(requirements.id, id));
    if (!requirement) throw notFound('requirement');

    const clarifications = await db
      .select()
      .from(requirementClarifications)
      .where(eq(requirementClarifications.requirementId, id));

    /**
     * ★★ The assigned author agent goes out with its **name**, not just its id.
     *
     *   The frontend dropdown only holds agents that are currently project members. Once
     *   that agent is removed from the project (or paused), the dropdown cannot find it
     *   and the UI renders "unset" — while the row still points at it, and the next
     *   analysis still fails on it. A choice silently erased is precisely the failure
     *   this feature exists to prevent.
     *
     * ★★ 指定的编写 Agent 连**名字**一起给出去，不能只给 id。
     *
     *   前端的下拉框只装得下「本项目现有的 Agent 成员」。那个 Agent 后来被
     *   移出项目（或停用）的话，下拉框里找不到它，界面就会显示成「未指定」——
     *   而库里明明还指着它，下一次分析也会照着它失败。选择被静默抹掉，
     *   正是这个功能最该避免的那种表现。
     */
    const [author] = requirement.authorAgentId
      ? await db
          .select({ id: agents.id, name: agents.name, status: agents.status })
          .from(agents)
          /**
           * ★ Constrain by orgId as well. The write side already rejects cross-org ids;
           *   repeating the constraint here means that if some future write path ever
           *   forgets, the symptom is "renders as unset" rather than "reads out the name
           *   of another organization's agent".
           *
           * ★ 顺手带上 orgId：写入那一侧已经拦了跨组织的 id，这里再限一次，
           *   万一哪天有别的写入路径漏了，表现是「显示成未指定」而不是
           *   「把别的组织的 Agent 名字念出来」。
           */
          .where(and(eq(agents.id, requirement.authorAgentId), eq(agents.orgId, requirement.orgId)))
      : [];

    return { requirement, clarifications, authorAgent: author ?? null };
  });

  app.post(
    '/api/v1/requirements/:id/analyze',
    {
      config: {
        auth: {
          permission: 'requirement.edit',
        },
      },
    },
    async (req) => {
      const { actor } = actorFrom(req);
      const { id } = req.params as { id: string };
      return analyzeRequirement(db, deps.provider, {
        requirementId: id,
        correlationId: corr(req),
        actor,
        locale: localeOf(req),
      });
    },
  );

  /**
   * Choose the agent that writes this requirement's PRD (page doc 03 §5.4).
   *
   * ★ A route of its own, deliberately not folded into PATCH /requirements/:id. That
   *   route means "a human edited the structured fields": it stamps changed fields as
   *   👤 human, recomputes completeness, and advances the status. Who writes the PRD is
   *   not part of the requirement's content, so folding it in would make the "who wrote
   *   this" markers start lying and would let a change of author push a state transition
   *   out of thin air.
   *
   * ★ PUT rather than POST: setting the same value twice has the same result as once.
   *
   * 指定这条需求的 PRD 编写 Agent（页面文档 03 §5.4）。
   *
   * ★ 单独一条路由，不并进 PATCH /requirements/:id。
   *   那条路的语义是「人工改结构化字段」：它会把改过的字段标成 👤 人工、
   *   重算完整度、推进状态。选谁来写不是需求的内容，混进去会让「谁写的」
   *   那排标记开始撒谎，也会让一次换人凭空推动一次状态流转。
   *
   * ★ PUT 而不是 POST：设定同一个值两次的结果与一次相同。
   */
  const AuthorAgentInput = z.object({
    /** null = clear the assignment, back to picking automatically via the project's bound planning agent */
    agentId: z.string().uuid().nullable(),
  });

  app.put(
    '/api/v1/requirements/:id/author-agent',
    {
      config: {
        auth: {
          /**
           * ★ Same tier as analyze (requirement.edit), not project.settings.update. The
           *   project-level binding changes the output of every requirement from here
           *   on and earns a higher tier; this route changes who writes *one*
           *   requirement — and whoever can press analyze already decides whether that
           *   requirement runs through AI at all, and can hand-edit every field anyway.
           *
           * ★ 与 analyze 同档（requirement.edit），不是 project.settings.update。
           *   项目级绑定改的是此后所有需求的产出，要更高一档；这一条只改这一条
           *   需求由谁写，而能点 analyze 的人本来就能决定这条需求要不要跑 AI，
           *   也能把每个字段手改一遍。
           */
          permission: 'requirement.edit',
        },
      },
    },
    async (req) => {
      const { userId } = actorFrom(req);
      const { id } = req.params as { id: string };
      const body = AuthorAgentInput.parse(req.body);

      const result = await setRequirementAuthorAgent(db, {
        requirementId: id,
        agentId: body.agentId,
        actorId: userId,
        correlationId: corr(req),
      });

      /**
       * ★ The three refusals each say their own thing; do not collapse them into one
       *   "cannot assign this agent". "The requirement is settled" means go reopen it,
       *   "not a member of this project" means go to the members page, and "no such
       *   agent" usually means it was deleted elsewhere. The ways out are completely
       *   different, and merged into one message the user can only try them in turn.
       *
       * ★ There used to be a fourth: "the agent's applicable types do not include
       *   requirement". That check is gone — any agent member of the project can write a
       *   PRD; see setRequirementAuthorAgent for why.
       *
       * ★ 三种拒绝各说各的，不要合并成一句「不能指定这个 Agent」——
       *   「需求已结案」要去重新打开，「不在这个项目里」要去成员页，
       *   「这个 Agent 不存在」多半是别处删掉了。出路各不相同，
       *   合并之后用户只能挨个试。
       *
       * ★ 这里曾经还有第四种：「适用类型没勾 requirement」。它已经取消 ——
       *   项目的 Agent 成员都能写 PRD，理由见 setRequirementAuthorAgent。
       */
      if (!result.ok) {
        if (result.code === 'REQUIREMENT_SETTLED') {
          throw fail(
            'INVALID_TRANSITION',
            'requirement.confirmed_cannot_change_agent',
            '需求已确认或已驳回，不能再更换 PRD 编写 Agent。如需修改请先重新打开。',
          );
        }
        if (result.code === 'AGENT_NOT_FOUND') throw notFound('agent');
        throw fail(
          'VALIDATION_FAILED',
          'agent.not_project_member',
          `${result.agentName} 不是这个项目的成员 —— 先在「成员与角色」里把它加进来`,
          { params: { name: result.agentName }, details: { agentId: body.agentId } },
        );
      }

      return result;
    },
  );

  const Answer = z.object({
    answer: z.string().min(1),
    usedSuggestion: z.boolean().default(false),
  });

  app.post(
    '/api/v1/clarifications/:id/answer',
    {
      config: {
        auth: {
          permission: 'clarification.answer',
        },
      },
    },
    async (req) => {
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
    },
  );

  /**
   * Reopen a requirement that was approved or rejected.
   *
   * ★★ Without it, approving a requirement is a **one-way door**: approve the wrong
   *   thing, or have the business change, and the only way out is to file a new
   *   requirement — which detaches every existing plan, task, and discussion from the
   *   original.
   *
   * ★ A reason is mandatory: reopening invalidates every plan already generated
   *   downstream, and three weeks later nobody remembers why it happened.
   *
   * 重新打开一条已确认 / 已驳回的需求。
   *
   * ★★ 缺了它，需求确认是一道**单向门**：批错了、或者业务变了，
   *   唯一的出路是新建一条 —— 而那会让已有的计划、任务、讨论全部与原需求脱钩。
   *
   * ★ 原因必填：重新打开会让下游已生成的计划全部作废，三周后没人记得为什么。
   */
  /**
   * Requirement assumptions — record, confirm, invalidate.
   *
   * ★★ Assumptions used to be producible only by AI analysis, so the hand-written
   *   requirement path had nowhere to record one. Assumptions now travel to the planning
   *   agent along with the requirement, which meant that path was permanently missing
   *   the single input that most shapes the resulting plan.
   *
   * 需求假设 —— 登记、确认、证伪。
   *
   * ★★ 此前假设只能由 AI 分析产生，手写需求的那条路根本没有地方记它 ——
   *   而假设现在会随需求一起传给规划 Agent，等于那条路永远少一块
   *   最影响规划结果的输入。
   */
  app.get('/api/v1/requirements/:id/assumptions', async (req) => {
    const { id } = req.params as { id: string };
    return listAssumptions(db, id);
  });

  /**
   * This requirement's past analysis and planning runs.
   *
   * ★★ Once planning runs are persisted, "what did that analysis actually do" is finally
   *   answerable — but only if the requirement page has a way in. Without this route the
   *   records sit in agent_runs with no screen able to reach them, and auditability is
   *   half-built.
   *
   * 这条需求的历次分析 / 规划 Run。
   *
   * ★★ 规划 Run 落库之后，「这次分析到底做了什么」终于查得到 —— 但前提是
   *   需求页上有入口指向它。没有这条路由的话，那些记录躺在 agent_runs 里
   *   而没有任何界面能找到它们，可审计只做了一半。
   */
  app.get('/api/v1/requirements/:id/runs', async (req) => {
    const { id } = req.params as { id: string };
    /**
     * ★★ Carry **who ran it**, not only which model was used.
     *
     *   Now that the author agent can be chosen by a person, "who wrote this version of
     *   the PRD" is the question this list most needs to answer. Showing only
     *   `claude-code:sonnet` makes the rows before and after an agent switch look
     *   identical, so the choice produces no visible feedback at all.
     *
     * ★ leftJoin rather than innerJoin: those runs still happened after the agent is
     *   deleted, and erasing them from history is far worse than showing a blank name.
     *
     * ★★ 带上**是谁跑的**，不只是用了什么模型。
     *
     *   既然编写 Agent 现在可以由人指定，「这一版 PRD 是谁写的」就是这张
     *   列表最该回答的问题 —— 只显示 `claude-code:sonnet` 的话，换了 Agent
     *   前后两行看起来一模一样，那个选择等于没有反馈。
     *
     * ★ leftJoin 而不是 innerJoin：Agent 被删掉之后这几次 Run 仍然发生过，
     *   把它们从历史里抹掉比显示一个空名字糟得多。
     */
    const rows = await db
      .select({
        id: agentRuns.id,
        status: agentRuns.status,
        goal: agentRuns.goal,
        tokensInput: agentRuns.tokensInput,
        tokensOutput: agentRuns.tokensOutput,
        tokensCacheRead: agentRuns.tokensCacheRead,
        tokensCacheWrite: agentRuns.tokensCacheWrite,
        model: agentRuns.model,
        agentId: agentRuns.agentId,
        agentName: agents.name,
        errorMessage: agentRuns.errorMessage,
        startedAt: agentRuns.startedAt,
        endedAt: agentRuns.endedAt,
      })
      .from(agentRuns)
      .leftJoin(agents, eq(agents.id, agentRuns.agentId))
      .where(eq(agentRuns.requirementId, id))
      .orderBy(desc(agentRuns.createdAt));

    return {
      runs: rows.map((r) => {
        const total = r.tokensInput + r.tokensOutput + r.tokensCacheRead + r.tokensCacheWrite;
        /**
         * ★ A planning run's `goal` stores the code itself ('structure' / 'plan'). A
         *   recognized value is treated as a code; an unrecognized one means a **legacy
         *   row** (back when a Chinese sentence was stored there) and falls back to
         *   displaying it verbatim — a stray Chinese sentence in the UI beats a blank.
         *
         * ★ 规划 Run 的 goal 存的就是码（'structure' / 'plan'）。
         *   认得就当码用，认不出说明是**存量行**（那时候存的是中文句子）——
         *   回落到原样显示，界面上宁可出现一句中文，也不要空白。
         */
        const goalCode = r.goal === 'structure' || r.goal === 'plan' ? r.goal : null;
        return {
          ...r,
          /**
           * ★★ All four counters at zero means **no usage was reported**, never "this run
           *   spent no tokens".
           *
           *   Some runtimes declare tokenReporting false in their capability list (a CLI
           *   that emits plain text has no structured usage to hand back). Collapsing
           *   unknown into zero puts "this analysis cost nothing" on screen — a false
           *   statement, and precisely the silent downgrade the capability list promises
           *   never to make. A run that actually executed cannot have consumed zero
           *   input tokens.
           *
           * ★★ 四个计数器全为 0 表示**没收到用量**，不是「这次没花 token」。
           *
           *   有些运行时的能力清单里 tokenReporting 就是 false（纯文本输出的
           *   CLI 拿不到结构化用量）。把 unknown 折叠成 0 之后，界面上显示的是
           *   「这次分析没花 token」—— 一句假话，而且正好违反能力清单
           *   「不静默降级」那条承诺。真跑起来的 Run 不可能一个 input token 都不消耗。
           */
          tokens: total > 0 ? total : null,
          /** The UI reads the code; when it is absent (legacy rows) the frontend falls back to the Chinese sentence in `goal` */
          goalCode,
          startedAt: r.startedAt?.toISOString() ?? null,
          endedAt: r.endedAt?.toISOString() ?? null,
        };
      }),
    };
  });

  app.post(
    '/api/v1/requirements/:id/assumptions',
    {
      config: {
        auth: {
          permission: 'requirement.edit',
        },
      },
    },
    async (req, reply) => {
      const { userId } = actorFrom(req);
      const { id } = req.params as { id: string };
      const body = z
        .object({ statement: z.string().trim().min(1, '假设内容不能为空').max(2000) })
        .parse(req.body);

      const created = await addAssumption(db, {
        requirementId: id,
        statement: body.statement,
        actorId: userId,
        correlationId: corr(req),
      });
      return reply.status(201).send(created);
    },
  );

  app.post(
    '/api/v1/assumptions/:id/confirm',
    {
      config: {
        auth: {
          /**
           * ★ Assumptions live at /assumptions/:id, where the URL shows no project — so
           *   `assumptions` has to be registered in both RESOURCE_SCOPED_URL and
           *   projectOfResource (see that regex and routes.ts below). Without it the
           *   membership gate cannot reach these two routes and they stand open to any
           *   signed-in user. Same rule as artifacts.
           *
           * ★ 假设走 /assumptions/:id，URL 上看不出项目 —— 所以 `assumptions` 必须
           *   登记进 RESOURCE_SCOPED_URL 与 projectOfResource（见下面那条正则与
           *   routes.ts），否则成员关系闸门够不着它，这两条路由对任何登录用户敞开。
           *   与 artifacts 是同一条纪律。
           */
          permission: 'requirement.edit',
        },
      },
    },
    async (req) => {
      const { userId } = actorFrom(req);
      const { id } = req.params as { id: string };
      return confirmAssumption(db, { assumptionId: id, actorId: userId });
    },
  );

  /** ★ Invalidating requires a reason: it knocks a premise out from under plans already generated */
  app.post(
    '/api/v1/assumptions/:id/invalidate',
    {
      config: {
        auth: {
          permission: 'requirement.edit',
        },
      },
    },
    async (req) => {
      const { userId } = actorFrom(req);
      const { id } = req.params as { id: string };
      const body = z
        .object({ reason: z.string().trim().min(1, '证伪必须写明原因').max(2000) })
        .parse(req.body);
      return invalidateAssumption(db, {
        assumptionId: id,
        reason: body.reason,
        actorId: userId,
        correlationId: corr(req),
      });
    },
  );

  app.post(
    '/api/v1/requirements/:id/reopen',
    {
      config: {
        auth: {
          /** ★ Reopening undoes an approval, so it sits at the same tier as approving */
          permission: 'requirement.approve',
        },
      },
    },
    async (req) => {
      const { userId } = actorFrom(req);
      const { id } = req.params as { id: string };
      const body = z
        .object({ reason: z.string().min(1, '重新打开必须写明原因').max(2000) })
        .parse(req.body ?? {});

      return reopenRequirement(db, {
        requirementId: id,
        actorId: userId,
        reason: body.reason,
        correlationId: corr(req),
      });
    },
  );

  app.post(
    '/api/v1/requirements/:id/approve',
    {
      config: {
        auth: {
          permission: 'requirement.approve',
        },
      },
    },
    async (req) => {
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
        /**
         * ★ An empty requirement needs **two** ways out. Saying only "run AI analysis
         *   first" is a dead end on a deployment with no planning agent configured — and
         *   this page has always allowed a person to fill in the structured fields
         *   themselves.
         *
         * ★ 空需求要给出**两条**出路。
         *   只说「先做 AI 分析」的话，没配规划 Agent 的部署就成了死路 ——
         *   而这一页本来就允许人自己把结构化字段填出来。
         */
        if (result.code === 'EMPTY_REQUIREMENT') {
          throw fail(
            'VALIDATION_FAILED',
            'requirement.no_structured_content',
            '这条需求还没有任何结构化内容，不能确认。先做一次 AI 分析，或者自己填写标题、业务目标与验收标准。',
          );
        }
        if (result.code === 'FALLBACK_REQUIRES_MANUAL_COMPLETION') {
          throw fail(
            'VALIDATION_FAILED',
            'requirement.fallback_needs_manual_completion',
            '规则占位内容不能直接确认。请人工填写标题、业务目标、范围和至少一条验收标准，或使用可用的规划 Agent 重新分析。',
          );
        }
        // Required clarifications are still unanswered — return exactly which ones so the
        // frontend can jump straight to them
        throw fail(
          'UNANSWERED_MUST_CONFIRM',
          'requirement.unanswered_must_confirm',
          '还有必答的澄清问题未回答',
          { details: result.questions },
        );
      }
      return result;
    },
  );

  // ── Plans ───────────────────────────────────────────────────────────
  /**
   * Approve a requirement and generate its plan — in **one call**.
   *
   * ★★ This used to be two consecutive requests from the browser (approve, then plans).
   *
   *   Break anywhere in between — a network blip, the user closing the tab, an error
   *   during generation — and what is left behind is "requirement approved, no plan":
   *   the state already moved, while what the user saw was an error, so they believe
   *   nothing happened. Pressing approve again then runs into "an approved requirement
   *   cannot be approved".
   *
   * ★ The two steps cannot share one database transaction: generating a plan calls an
   *   LLM and can run for minutes, and a transaction spanning that would pin a
   *   connection the whole time. So the guarantee is a **different** one: the approval
   *   either succeeds or does not happen, and whether the plan came out is reported
   *   honestly and separately. If generation fails the requirement stays approved (that
   *   step really did succeed) and the caller retries POST /requirements/:id/plans —
   *   they need not, and must not, approve a second time.
   *
   * 确认需求并立刻生成计划 —— **一次调用**。
   *
   * ★★ 此前这是浏览器里的两次连续请求（approve 然后 plans）。
   *
   *   中间任何一处断掉 —— 网络抖动、用户关了标签页、生成阶段报错 ——
   *   留下的都是「需求已确认，但没有计划」：状态已经变了，而用户看到的
   *   是一句报错，会以为什么都没发生。再点一次确认还会撞上
   *   「已确认的需求不能再确认」。
   *
   * ★ 不能把两步塞进一个数据库事务：生成计划要调 LLM，可能跑几分钟，
   *   一个横跨它的事务会一直占着连接。所以保证的是**另一件事**：
   *   确认这一步要么成功要么不发生，而计划有没有生成出来单独如实回报。
   *   生成失败时需求仍是 approved（那一步确实成功了），调用方可以重试
   *   POST /requirements/:id/plans —— 不需要也不能再确认一次。
   */
  app.post(
    '/api/v1/requirements/:id/approve-and-plan',
    {
      config: {
        auth: {
          /** ★ A combined command needs both permissions — it really does both things */
          permission: () => [
              'requirement.approve',
              'plan.generate',
            ],
          },
      },
    },
    async (req, reply) => {
      const { userId } = actorFrom(req);
      const { id } = req.params as { id: string };
      const note = (req.body as { note?: string } | undefined)?.note;

      const approved = await approveRequirement(db, {
        requirementId: id,
        approverId: userId,
        correlationId: corr(req),
        note,
      });

      if (!approved.ok) {
        if (approved.code === 'EMPTY_REQUIREMENT') {
          throw fail(
            'VALIDATION_FAILED',
            'requirement.no_structured_content',
            '这条需求还没有任何结构化内容，不能确认。先做一次 AI 分析，或者自己填写标题、业务目标与验收标准。',
          );
        }
        if (approved.code === 'FALLBACK_REQUIRES_MANUAL_COMPLETION') {
          throw fail(
            'VALIDATION_FAILED',
            'requirement.fallback_needs_manual_completion',
            '规则占位内容不能直接确认。请人工填写标题、业务目标、范围和至少一条验收标准，或使用可用的规划 Agent 重新分析。',
          );
        }
        throw fail(
          'UNANSWERED_MUST_CONFIRM',
          'requirement.unanswered_must_confirm',
          '还有必答的澄清问题未回答',
          { details: approved.questions },
        );
      }

      try {
        const summary = await generatePlan(db, deps.provider, {
          locale: localeOf(req),
          requirementId: id,
          correlationId: corr(req),
        });
        return reply.status(201).send({ requirementId: id, plan: summary, planError: null });
      } catch (err) {
        /**
         * ★ A failed generation does not roll the approval back. The approval was a
         *   judgment a person made, and it really happened; undoing it leaves "but I
         *   clicked approve" disagreeing with what the screen shows. Report honestly and
         *   let the caller decide whether to retry generation or go look at the
         *   requirement first.
         *
         * ★ 生成失败不回滚确认 —— 确认是人做的判断，它真的发生了。
         *   把它撤掉会让「我明明点了确认」和界面状态对不上。
         *   如实回报，让调用方决定是重试生成还是先去看需求。
         */
        return reply.status(201).send({
          requirementId: id,
          plan: null,
          planError: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  app.post(
    '/api/v1/requirements/:id/plans',
    {
      config: {
        auth: {
          permission: 'plan.generate',
        },
      },
    },
    async (req, reply) => {
      actorFrom(req);
      const { id } = req.params as { id: string };
      const summary = await generatePlan(db, deps.provider, {
        locale: localeOf(req),
        requirementId: id,
        correlationId: corr(req),
      });
      return reply.status(201).send(summary);
    },
  );

  app.get('/api/v1/plans/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getPlanDetail(db, id, { registry: deps.registry });
  });

  /**
   * Request changes (page doc 04 §5).
   *
   * ★ Generates a new version rather than editing in place: what a user approves is *a
   *   particular version* of a plan, and quietly turning v1 into v2's contents makes it
   *   impossible to say afterward what they approved. The old version is marked
   *   superseded, both are kept, and the frontend can diff them.
   *
   * 要求修改（页面文档 04 §5）。
   *
   * ★ 生成新版本而不是原地改：用户批准的是「某一版计划」，
   *   把 v1 悄悄改成 v2 的内容，事后就说不清他到底批准了什么。
   *   旧版标记 superseded，两版都留着，前端可以对比。
   */
  app.post(
    '/api/v1/plans/:id/revise',
    {
      config: {
        auth: {
          permission: 'plan.generate',
        },
      },
    },
    async (req, reply) => {
      actorFrom(req);
      const { id } = req.params as { id: string };
      const body = z
        .object({ feedback: z.string().min(1, '要求修改必须说明改什么') })
        .parse(req.body);

      const [plan] = await db.select().from(plans).where(eq(plans.id, id));
      if (!plan) throw notFound('plan');
      if (!plan.requirementId) {
        throw fail('INVALID_TRANSITION', 'plan.no_requirement', '这份计划没有关联需求，无法重新规划');
      }
      if (plan.status === 'approved') {
        throw fail('INVALID_TRANSITION', 'plan.approved_cannot_replan', '已批准的计划不能重新规划，请新建需求');
      }

      await db
        .update(plans)
        .set({ status: 'superseded', revisionFeedback: body.feedback })
        .where(eq(plans.id, id));

      const summary = await generatePlan(db, deps.provider, {
        locale: localeOf(req),
        requirementId: plan.requirementId,
        correlationId: corr(req),
        feedback: body.feedback,
      });
      return reply.status(201).send(summary);
    },
  );

  app.post(
    '/api/v1/plans/:id/approve',
    {
      config: {
        auth: {
          permission: 'plan.approve',
        },
      },
    },
    async (req) => {
      const { userId } = actorFrom(req);
      const { id } = req.params as { id: string };
      const body = z
        .object({
          acknowledgedOverrun: z.boolean().optional(),
          /** Acknowledges "let these human tasks go into the unclaimed queue for now" */
          acknowledgedUnassigned: z.boolean().optional(),
        })
        .parse(req.body ?? {});

      const result = await approvePlan(
        db,
        {
          planId: id,
          approverId: userId,
          correlationId: corr(req),
          ...body,
        },
        { registry: deps.registry },
      );

      if (!result.ok) {
        /**
         * ★ The two blocks get their own error codes. Merged into one, the frontend
         *   cannot tell which confirmation dialog to raise — one asks "accept going over
         *   budget", the other asks "accept that these items have no owner yet", and the
         *   judgment the user has to make is entirely different.
         *
         * ★ 两种拦截各用各的错误码。合成一个的话前端分不清该弹哪个确认框 ——
         *   一个是「确认超支」，一个是「确认这几项先没人认领」，
         *   用户要做的判断完全不同。
         */
        if (result.code === 'PREFLIGHT_FAILED') {
          throw fail(
            'GUARD_FAILED',
            'plan.preflight_failed',
            '执行前检查未通过，请先补齐规划 Agent、执行 Agent、工作区、验证命令、Token 估算和交付目标。',
            { details: { code: result.code, issues: result.issues } },
          );
        }
        if (result.code === 'PLAN_NOT_APPROVABLE') {
          throw fail(
            'VERSION_CONFLICT',
            'plan.not_approvable',
            '计划已经处理，或其中的任务已不再处于草稿状态。请刷新后查看最新状态。',
            { details: result },
          );
        }
        if (result.code === 'ACTIVATION_FAILED') {
          throw fail(
            'GUARD_FAILED',
            'plan.activation_failed',
            '计划任务激活失败，整次批准已回滚。请修复阻断项后重试。',
            { details: result },
          );
        }
        if (result.code === 'UNASSIGNED_HUMAN_TASKS') {
          throw fail(/** ★ Not a validation failure — the request is fine, it just needs one confirmation from the user (see errors.ts) */
            'CONFIRMATION_REQUIRED', 'plan.unassigned_human_tasks', `有 ${result.tasks.length} 项人工任务还没有指定负责人：${result.tasks
              .map((t) => t.title)
              .join('、')}。批下去它们会停在待执行里不动 —— 先指派，或确认让它们进待认领队列。`, { params: { count: result.tasks.length, titles: result.tasks.map((t) => t.title).join(', ') }, details: result });
        }
        throw fail(
          'BUDGET_EXCEEDED',
          'plan.over_budget',
          `计划预估 ${result.estimated} token，超出项目预算 ${result.budget} token`,
          { params: { estimated: result.estimated, budget: result.budget }, details: result },
        );
      }
      return result;
    },
  );

  // ── Board ───────────────────────────────────────────────────────────
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
      unclaimedOnly: q['unclaimed'] === 'true',
    });
  });

  /**
   * The Agent swimlane view (page doc 05 §5.7).
   *
   * Returns each agent's load and the tasks it currently carries — the whole data source
   * for the "swimlane per agent" view, fetched in one round trip so the frontend never
   * has to pull tasks agent by agent.
   *
   * ★★ It lives at `/agent-workload`, not `/agents`: the latter belongs to the
   *   project-agent *binding* pair (see the "Project agent bindings" section below).
   *   Both were once registered on `/agents`, and Fastify rejects duplicate routes — so
   *   the symptom was not a broken endpoint but `buildApp()` throwing, i.e. **the server
   *   never starting at all**.
   *
   *   The two were never meant to share a URL anyway: this one answers "who is working
   *   and how is it going", that one answers "which agent holds the planning /
   *   coordination / review seat", and their response shapes have nothing in common.
   *
   * Agent 视图（页面文档 05 §5.7）用。
   *
   * 返回负载与当前承担的任务 —— 这是「按 Agent 分泳道」视图的全部数据来源，
   * 一次查完，避免前端逐个 Agent 拉任务。
   *
   * ★★ 路径是 `/agent-workload` 而不是 `/agents`：`/agents` 属于项目 Agent
   *   绑定那对 GET/PUT（见下面「项目 Agent 绑定」一节）。两者一度都注册在
   *   `/agents` 上，而 Fastify 拒绝重复注册 —— 后果不是某个接口失灵，
   *   是 `buildApp()` 直接抛异常，**整个服务起不来**。
   *
   *   两件事本来就不该共用一个 URL：这里回的是「谁在干活、干得怎么样」，
   *   那里回的是「哪个 Agent 担任规划 / 协调 / 评审」，响应结构毫无交集。
   */
  app.get('/api/v1/projects/:id/agent-workload', async (req) => {
    const { id } = req.params as { id: string };
    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    if (!project) throw notFound('project');

    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        type: agents.type,
        status: agents.status,
        model: agents.model,
        maxConcurrency: agents.maxConcurrency,
        tokenLimitPerRun: agents.tokenLimitPerRun,
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
    for (const r of runs) {
      // ★ This query is by projectId, so planning runs land in it too — they have no
      //   work item, skip them
      if (!r.workItemId) continue;
      if (!latestRun.has(r.workItemId)) latestRun.set(r.workItemId, r);
    }

    return {
      agents: rows.map((a) => {
        const mine = items.filter((i) => i.executorId === a.id);
        return {
          ...a,
          load: mine.filter((i) => i.status === 'executing').length,
          todayTokens: runs
            .filter((r) => r.agentId === a.id)
            .reduce(
              (sum, r) =>
                sum + r.tokensInput + r.tokensOutput + r.tokensCacheRead + r.tokensCacheWrite,
              0,
            ),
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

  /** Execution graph (page doc 07). Layout is computed server-side; the frontend only renders and handles interaction */
  app.get('/api/v1/projects/:id/graph', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { layout?: string };
    const layout = (LAYOUTS as readonly string[]).includes(q.layout ?? '')
      ? (q.layout as LayoutKind)
      : 'layered';

    return getGraph(db, id, layout);
  });

  // ── Project overview (page doc 02) ──────────────────────────────────
  app.get('/api/v1/projects/:id/overview', async (req) => {
    const { id } = req.params as { id: string };
    return getOverview(db, id, optionalUserId(req));
  });

  // ── Agent Workspace (page doc 08) ───────────────────────────────────
  app.get('/api/v1/agents', async (req) => {
    const q = req.query as { projectId?: string };
    const projectId = q.projectId && UUID_RE.test(q.projectId) ? q.projectId : null;

    /**
     * ★ Agents are organization-level resources (they can span projects), so narrow by
     *   **organization** rather than by project. This used to narrow by nothing at all:
     *   the roster listed other organizations' agents along with their costs, success
     *   rates, and owners.
     *
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
   * Pause / resume an agent.
   *
   * ★ Pausing requires a reason, for the same reason disabling a policy does: three
   *   weeks later nobody remembers why this agent has been paused, and a paused agent
   *   quietly slows the whole project down.
   *
   * 暂停 / 恢复 Agent。
   *
   * ★ 暂停必须填原因，和停用 Policy 同理：三周后没人记得
   *   「这个 Agent 为什么一直是停的」，而一个停着的 Agent
   *   会安静地让整个项目慢下来。
   */
  app.post(
    '/api/v1/agents/:agentId/pause',
    {
      config: {
        auth: {
          permission: 'agent.pause',
          context: (req, ctx) =>
        agentContext(ctx, (req.params as { agentId: string }).agentId),
        },
      },
    },
    async (req) => {
      const { userId } = actorFrom(req);
      const { agentId } = req.params as { agentId: string };
      const body = z
        .object({
          paused: z.boolean(),
          reason: z.string().optional(),
        })
        .parse(req.body);

      if (body.paused && !body.reason?.trim()) {
        throw fail('VALIDATION_FAILED', 'agent.suspend_needs_reason', '暂停 Agent 必须填写原因');
      }

      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      if (!agent) throw notFound('agent');

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
    },
  );

  // ── Runtime capabilities (page doc 14 §5.4 — the only integration with a real backend) ──
  app.get('/api/v1/runtimes', async () => listRuntimes(db, deps.registry));

  /**
   * ── Configuration: runtime access / agent profiles / project conventions (page doc 08 §5.5) ──
   *
   * ★ Before this, the entire system had exactly one write operation (pausing an
   *   agent), and agents and runtimes could only be loaded by the seed script — "a user
   *   configures a code agent" was not possible for even one step.
   *
   * ★ 在此之前整个系统只有一个写操作（暂停 Agent），Agent 与运行时
   *   只能靠 seed 脚本灌进去 —— 「用户去配置 code agent」一步都做不了。
   */
  /**
   * "Which organization does this request belong to."
   *
   * ★★ Once an account can belong to several organizations, that answer can no longer be
   *   read off the account. It is carried explicitly in the `X-Org-Id` header, and
   *   falls back to a deterministic default when absent (see resolveCurrentOrg).
   *
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
   * Agent profile management.
   *
   * ★ There is no separate "runtime connection" resource: the CLI kind, the credential,
   *   and that CLI's own parameters all live inline on the agent. Creating N agents
   *   means N independent configurations.
   *
   * Agent 档案管理。
   *
   * ★ 没有单独的「运行时接入」资源：CLI 类型、凭证、该 CLI 的个性化参数
   *   全都内联在 Agent 上。建 N 个 Agent 就是 N 套独立配置。
   */
  app.get('/api/v1/admin/agents', async (req) => {
    const { orgId } = await callerOrg(req);
    return listAgentsAdmin(db, deps.registry, orgId);
  });

  /**
   * ★ A read-only catalog of **platform constants**: it holds no organization or project
   *   data, so it needs no scope. It declares `agent.view` to sit at the same tier as
   *   the other admin read endpoints — `/api/v1/admin/…` matches neither of the gate's
   *   two scope regexes, so declaring nothing would leave it readable anonymously.
   *
   * ★ 只读的**平台常量**目录：没有任何组织或项目数据，因此不需要作用域。
   *   声明 `agent.view` 是为了让它和别的 admin 读接口一档 ——
   *   `/api/v1/admin/…` 不在闸门的两条作用域正则里，不声明就等于匿名可读。
   */
  app.get(
    '/api/v1/admin/capabilities',
    { config: { auth: { permission: 'agent.view' } } },
    async () => listCapabilityCatalog(),
  );

  app.post(
    '/api/v1/admin/agents',
    {
      config: {
        auth: {
          permission: 'agent.create',
        },
      },
    },
    async (req, reply) => {
      const { orgId, userId } = await callerOrg(req);
      const body = AgentCreateInput.parse(req.body);
      const result = await createAgent(db, deps.registry, orgId, body, userId);

      await emitAndPublish(db, {
        orgId,
        /**
         * ★ 在项目里建的 Agent，这条事件就挂在那个项目上 —— 项目活动流里
         *   看得到「谁把这个 Agent 拉进来了」。从组织级页面建的仍然是 null。
         */
        projectId: body.projectId ?? null,
        type: 'agent.registered',
        actor: humanActor(userId),
        subjectType: 'agent',
        subjectId: result.agent.id,
        payload: {
          name: body.name,
          type: body.type,
          runtimeKind: body.runtimeKind,
          /** ★ 自动入项目也是一次授权，审计里要看得见 */
          joinedProject: result.joinedProject,
        },
        correlationId: corr(req),
      });

      return reply.status(201).send(result);
    },
  );

  app.patch(
    '/api/v1/admin/agents/:id',
    {
      config: {
        auth: {
          /**
           * ★ Editing a profile and editing permissions are different acts, and the
           *   second splits further into widening and narrowing. The route table can
           *   only establish "at minimum, able to edit a profile"; the directional check
           *   happens inside updateAgent (assertPermissionChange in agent-admin.ts).
           *
           * ★ 改档案与改权限是两回事，后者还分扩大 / 收紧。
           *   路由表只能判出「至少要能改档案」，权限维度的方向判定
           *   在 updateAgent 里（见 agent-admin.ts 的 assertPermissionChange）。
           */
          permission: 'agent.update',
          context: (req, ctx) =>
        agentContext(ctx, (req.params as { id: string }).id),
        },
      },
    },
    async (req) => {
      const { orgId, userId } = await callerOrg(req);
      const { id } = req.params as { id: string };
      const body = AgentInput.partial().extend({ reason: z.string().optional() }).parse(req.body);

      // Widening permissions takes tech_lead, narrowing only takes the owner — and which
      // direction it is only becomes known by comparing old against new (§2.3)
      const subject = await rbac.subjectForAgent(req, userId, id);
      const result = await updateAgent(db, deps.registry, orgId, id, body, userId, (permission) =>
        rbac.assertPermission(subject, permission, { agentId: id }),
      );

      if (result.permissionsChanged) {
        // ★ A permission change is an audit event (AUDIT_EVENTS) and must leave a trace
        await emitAndPublish(db, {
          orgId,
          projectId: null,
          type: 'agent.permissions_changed',
          actor: humanActor(userId),
          subjectType: 'agent',
          subjectId: id,
          payload: {
            /** ★ The organization level sets the **ceiling**, not what the agent can do — that is computed per project */
            scope: 'organization',
            capabilityCeiling: body.capabilityCeiling ?? null,
            deniedCapabilities: body.deniedCapabilities ?? null,
            reason: body.reason ?? null,
          },
          correlationId: corr(req),
        });
      }

      return result;
    },
  );

  app.delete(
    '/api/v1/admin/agents/:id',
    {
      config: {
        auth: {
          permission: 'agent.delete',
          context: (req, ctx) =>
        agentContext(ctx, (req.params as { id: string }).id),
        },
      },
    },
    async (req) => {
      const { orgId } = await callerOrg(req);
      const { id } = req.params as { id: string };
      return deleteAgent(db, orgId, id);
    },
  );

  /** Capability probe: tells "not registered", "cannot connect", and "missing capability" apart */
  app.post(
    '/api/v1/admin/agents/:id/probe',
    {
      config: {
        auth: {
          permission: 'agent.update',
          context: (req, ctx) =>
        agentContext(ctx, (req.params as { id: string }).id),
        },
      },
    },
    async (req) => {
      const { orgId } = await callerOrg(req);
      const { id } = req.params as { id: string };
      return probeAgent(db, deps.registry, orgId, id);
    },
  );

  // ── Code repository registry ────────────────────────────────────────
  app.get('/api/v1/admin/repositories', async (req) => {
    const { orgId } = await callerOrg(req);
    const q = req.query as { projectId?: string };
    const projectId = q.projectId && UUID_RE.test(q.projectId) ? q.projectId : null;
    return listRepositories(db, orgId, projectId);
  });

  app.post(
    '/api/v1/admin/repositories',
    {
      config: {
        auth: {
          permission: 'repository.manage',
        },
      },
    },
    async (req, reply) => {
      const { orgId, userId } = await callerOrg(req);
      const body = RepositoryInput.parse(req.body);
      return reply.status(201).send(await createRepository(db, orgId, userId, body));
    },
  );

  app.patch(
    '/api/v1/admin/repositories/:id',
    {
      config: {
        auth: {
          permission: 'repository.manage',
        },
      },
    },
    async (req) => {
      const { orgId } = await callerOrg(req);
      const { id } = req.params as { id: string };
      const body = RepositoryInput.partial()
        .extend({ status: z.enum(['active', 'disabled']).optional() })
        .parse(req.body);
      return updateRepository(db, orgId, id, body);
    },
  );

  /**
   * Connectivity probe. ★ A misconfigured credential has to surface on the settings page,
   *   not on the first dispatch — by then the error reads "failed to prepare workspace:
   *   … 401", which points nowhere near the real cause.
   *
   * 连通性探测。★ 凭证配错了要在配置页上知道，而不是等第一次派发 ——
   *   那时的错误是「准备工作区失败：… 401」，指不到真实原因。
   */
  app.post(
    '/api/v1/admin/repositories/:id/probe',
    {
      config: {
        auth: {
          permission: 'repository.manage',
        },
      },
    },
    async (req) => {
      const { orgId } = await callerOrg(req);
      const { id } = req.params as { id: string };
      return probeRepository(db, orgId, id);
    },
  );

  app.delete(
    '/api/v1/admin/repositories/:id',
    {
      config: {
        auth: {
          permission: 'repository.manage',
        },
      },
    },
    async (req) => {
      const { orgId } = await callerOrg(req);
      const { id } = req.params as { id: string };
      return deleteRepository(db, orgId, id);
    },
  );

  // ── Storage target registry (non-Git workspace sources) ─────────────
  app.get('/api/v1/admin/storage-targets', async (req) => {
    const { orgId } = await callerOrg(req);
    const q = req.query as { projectId?: string };
    const projectId = q.projectId && UUID_RE.test(q.projectId) ? q.projectId : null;
    return listStorageTargets(db, orgId, projectId);
  });

  app.post(
    '/api/v1/admin/storage-targets',
    {
      config: {
        auth: {
          /**
           * ★ probe also takes storage_target.manage even though it reads nothing. It
           *   connects to the remote using the registered credential, and being able to
           *   trigger an outbound authenticated request is itself part of "managing a
           *   storage target", not an ordinary query.
           *
           * ★ probe 也要 storage_target.manage，虽然它是只读的。
           *   它会拿着登记里的凭证去连远端 —— 能触发一次带凭证的出网请求，
           *   本身就是「管理存储目标」的一部分，不是一次普通的查询。
           */
          permission: 'storage_target.manage',
        },
      },
    },
    async (req, reply) => {
      const { orgId, userId } = await callerOrg(req);
      const body = StorageTargetInput.parse(req.body);
      return reply.status(201).send(await createStorageTarget(db, orgId, userId, body));
    },
  );

  app.patch(
    '/api/v1/admin/storage-targets/:id',
    {
      config: {
        auth: {
          permission: 'storage_target.manage',
        },
      },
    },
    async (req) => {
      const { orgId } = await callerOrg(req);
      const { id } = req.params as { id: string };
      /**
       * ★ Use innerType().partial() rather than StorageTargetInput.partial():
       *   StorageTargetInput is wrapped in a superRefine (ZodEffects), and ZodEffects has
       *   no partial(). That cross-field validation only holds for **complete** input
       *   anyway — on a partial update a missing bucket does not mean misconfigured, it
       *   means this request did not touch it.
       *
       * ★ 用 innerType().partial() 而不是 StorageTargetInput.partial()：
       *   StorageTargetInput 外面裹了一层 superRefine（ZodEffects），
       *   ZodEffects 上没有 partial()。而那层交叉校验本来也只对**完整**
       *   输入成立 —— 局部更新时缺 bucket 不代表配错了，代表这次没改它。
       */
      const body = StorageTargetInput.innerType()
        .partial()
        .extend({ status: z.enum(['active', 'disabled']).optional() })
        .parse(req.body);
      return updateStorageTarget(db, orgId, id, body);
    },
  );

  /** Connectivity probe. ★ Same as for repositories: a misconfiguration has to surface on the settings page, not on the first dispatch */
  app.post(
    '/api/v1/admin/storage-targets/:id/probe',
    {
      config: {
        auth: {
          permission: 'storage_target.manage',
        },
      },
    },
    async (req) => {
      const { orgId } = await callerOrg(req);
      const { id } = req.params as { id: string };
      return probeStorageTarget(db, orgId, id);
    },
  );

  app.delete(
    '/api/v1/admin/storage-targets/:id',
    {
      config: {
        auth: {
          permission: 'storage_target.manage',
        },
      },
    },
    async (req) => {
      const { orgId } = await callerOrg(req);
      const { id } = req.params as { id: string };
      return deleteStorageTarget(db, orgId, id);
    },
  );

  // ── Artifact files ──────────────────────────────────────────────────
  /**
   * ★★ Project membership is judged centrally by the gate — provided `artifacts` is
   *   registered in both projectOfResource and RESOURCE_SCOPED_URL (see the section
   *   above and rbac.ts). Without those two entries these three routes stand open to
   *   any signed-in user.
   *
   * ★ Read-only, and only for locally archived artifacts. Artifacts in git or object
   *   storage have their own clickable addresses and do not come back through here.
   *
   * ★★ 项目成员关系由闸门统一判过 —— 前提是 `artifacts` 已经登记进
   *   projectOfResource 与 RESOURCE_SCOPED_URL（见上面那段与 rbac.ts）。
   *   少了那两处登记，这三条路由对任何登录用户都是敞开的。
   *
   * ★ 只读，且只服务本地归档那一类产物。git / 对象存储的产物有自己的
   *   可点开地址，不从这里再走一遍。
   */
  app.get('/api/v1/artifacts/:id/files', async (req) => {
    const { id } = req.params as { id: string };
    return listArtifactFiles(db, id);
  });

  /**
   * ★ The path arrives as a wildcard segment: a `/` inside the file name is the norm
   *   (`src/app.ts`), and a query parameter would be encoded and decoded again by every
   *   layer of middleware, whereas the wildcard is native to Fastify.
   *
   * ★ 路径用通配符段接收：文件名里有 `/` 是常态（`src/app.ts`），
   *   用查询参数会被各层中间件反复编解码，而通配符是 Fastify 原生支持的。
   */
  app.get('/api/v1/artifacts/:id/files/*', async (req) => {
    const { id } = req.params as { id: string };
    const rel = (req.params as Record<string, string>)['*'] ?? '';
    return readArtifactFile(db, id, rel);
  });

  app.get('/api/v1/artifacts/:id/download/*', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rel = (req.params as Record<string, string>)['*'] ?? '';
    const file = await openArtifactFile(db, id, rel);
    return reply
      .header('content-type', file.mime)
      .header('content-length', String(file.size))
      // ★ Always attachment: artifact content is written by an agent, and rendering it
      //   inline means executing it under this site's origin — one HTML artifact would
      //   be enough to acquire same-origin privileges
      .header('content-disposition', `attachment; filename="${encodeURIComponent(file.name)}"`)
      .send(file.stream);
  });

  // ── Project agent bindings ──────────────────────────────────────────
  /**
   * ★ This layer answers only "which already-configured agent holds this seat". Choosing
   *   a runtime belongs to the agent settings page and is settled before we get here.
   *
   * ★ 这一层只回答「哪个已配置的 Agent 干这个角色」。
   *   选运行时是 Agent 配置页的事，到这里已经定好了。
   */
  app.get('/api/v1/projects/:id/agents', async (req) => {
    const { id } = req.params as { id: string };
    return listProjectAgents(db, id);
  });

  app.put(
    '/api/v1/projects/:id/agents',
    {
      config: {
        auth: {
          /**
           * ★ Merely setting an executor sits one tier below "start executing".
           *
           *   Hanging a card under someone's name is scheduling work, not spending
           *   budget; demanding work_item.execute would mean only people who can
           *   dispatch may schedule — and scheduling is exactly a PM's daily job. The
           *   step that actually spends money is /start, and that one still requires
           *   work_item.execute.
           *
           * ★ 只设执行者要的权限比「开始执行」低一档。
           *
           *   把卡片挂到某人名下是排活，不是动预算；要求 work_item.execute
           *   会让排活这件事只有能派发的人做得了，而排活恰恰是 PM 的日常。
           *   真正花钱的那一步在 /start，那里仍然是 work_item.execute。
           */
          permission: 'project.settings.update',
        },
      },
    },
    async (req) => {
      const { orgId, userId } = await callerOrg(req);
      const { id } = req.params as { id: string };
      const body = BindingInput.parse(req.body);
      const result = await setProjectAgent(db, { orgId, projectId: id, userId }, body);

      await emitAndPublish(db, {
        orgId,
        projectId: id,
        type: 'project.agent_bound',
        actor: humanActor(userId),
        subjectType: 'project',
        subjectId: id,
        payload: { role: result.role, agentId: result.agentId },
        correlationId: corr(req),
      });

      return result;
    },
  );

  /**
   * ── Project-level agent permissions ────────────────────────────────
   *
   * ★★ "What can this agent do **in this project**." The division of labor against the
   *   binding routes above: binding answers "who holds this seat", this answers "what it
   *   is authorized to do".
   *
   * ★ All three routes share one evaluator (see project-agent-access.ts). Preview and
   *   save reaching different conclusions is the hardest failure to notice in a UI like
   *   this, and the only reliable defense is leaving them no second implementation to
   *   disagree with.
   *
   * ★★ 「这个 Agent 在**这个项目**里能做什么」。与上面那组绑定路由的分工是：
   *   绑定回答「谁干这个角色」，这里回答「它被授权做什么」。
   *
   * ★ 三条路由共用一个求值器（见 project-agent-access.ts）。预览与保存
   *   给出不同结论是这类界面最难发现的一种失败，而唯一可靠的防法
   *   是让它们没有第二份实现可用。
   */
  app.get('/api/v1/projects/:id/agents/:agentId/access', async (req) => {
    const { orgId } = await callerOrg(req);
    const { id, agentId } = req.params as { id: string; agentId: string };
    return getAgentAccess(db, { orgId, projectId: id }, agentId);
  });

  app.post(
    '/api/v1/projects/:id/agents/:agentId/access/preview',
    {
      config: {
        auth: {
          /** The preview is read-only: it computes what a save would do and writes nothing */
          permission: 'agent.view',
          context: (req, ctx) =>
        agentContext(ctx, (req.params as { agentId: string }).agentId),
        },
      },
    },
    async (req) => {
      const { orgId } = await callerOrg(req);
      const { id, agentId } = req.params as { id: string; agentId: string };
      const body = AgentAccessInput.parse(req.body);
      const { next: _expanded, ...preview } = await previewAgentAccess(
        db,
        { orgId, projectId: id },
        agentId,
        body,
      );
      return preview;
    },
  );

  app.put(
    '/api/v1/projects/:id/agents/:agentId/access',
    {
      config: {
        auth: {
          /**
           * ★★ Project-level authorization can likewise only establish "at minimum, able
           *   to tighten"; the directional check lives in the handler
           *   (executeGovernedMutation: work out the direction first, then demand the
           *   matching permission).
           *
           *   Does the route table have to register the **stricter** of the two? No.
           *   `restrict` is registered because the gate is a coarse filter and the real
           *   check happens inside, where it is guaranteed to run again. Registering
           *   `expand` would instead shut out an owner who only wants to tighten, so
           *   nobody tightens anything — the exact opposite of what §2.3's asymmetric
           *   design is for.
           *
           * ★★ 项目级授权同样只能判出「至少要能收紧」，方向判定在 handler 里
           *   （executeGovernedMutation：先算方向，再要对应那条权限）。
           *
           *   这里登记的必须是**较严**的那一条吗 —— 不。登记 restrict 是因为
           *   闸门只做粗筛，真正的判定在里层，而里层一定会再判一次；
           *   登记 expand 反而会把「只想收紧」的 owner 挡在门外，
           *   于是没人再去收紧（§2.3 不对称设计的原意正好相反）。
           */
          permission: 'agent.permissions.restrict',
          /**
           * ★ Project-level authorization carries the agent_owner dimension too:
           *   tightening an agent you own should be allowed inside a project just as it
           *   is at the organization level.
           *
           * ★ 项目级授权要带上 agent_owner 这一维：收紧自己名下的 Agent
           *   在项目里同样该放行，与组织级那条保持一致。
           */
          context: (req, ctx) =>
        agentContext(ctx, (req.params as { agentId: string }).agentId),
        },
      },
    },
    async (req) => {
      const { orgId, userId } = await callerOrg(req);
      const { id, agentId } = req.params as { id: string; agentId: string };
      const body = AgentAccessInput.parse(req.body);

      /**
       * ★ The subject of the check is the same one preHandler used (subjectForAgent).
       *   Computing different roles on the two sides produces the incomprehensible 403
       *   where the gate lets a request through and the inner layer then rejects it.
       *
       * ★ 判定主体与 preHandler 用同一个（subjectForAgent）——
       *   两边算出不同的角色会出现「闸门放行了、里层又拦下」这种
       *   没人看得懂的 403。
       */
      const subject = await rbac.subjectForAgent(req, userId, agentId);

      const result = await setAgentAccess(
        db,
        { orgId, projectId: id, userId },
        agentId,
        body,
        ({ direction, reason, mutate }) =>
          executeGovernedMutation({
            assertPermission: (permission) =>
              rbac.assertPermission(subject, permission, { agentId, projectId: id }),
            direction,
            permissionForDirection: {
              loosen: 'agent.permissions.expand',
              tighten: 'agent.permissions.restrict',
              /**
               * ★ "Nothing changed" is still a write, and takes the tighten-tier
               *   permission. Waved through, a neutral request becomes a write entry
               *   point that requires no permission at all.
               *
               * ★ 「什么都没变」也是一次写操作，按收紧那一档要权限。
               *   放行掉的话，一次 neutral 请求会成为无需任何权限的写入口。
               */
              neutral: 'agent.permissions.restrict',
            },
            reason,
            mutate,
            audit: async (saved) => {
              await emitAndPublish(db, {
                orgId,
                projectId: id,
                type: 'agent.permissions_changed',
                actor: humanActor(userId),
                subjectType: 'agent',
                subjectId: agentId,
                payload: {
                  projectId: id,
                  direction: saved.direction,
                  profileKey: saved.profileKey,
                  profileVersion: saved.profileVersion,
                  addedCapabilities: saved.addedCapabilities,
                  removedCapabilities: saved.removedCapabilities,
                  reason,
                },
                correlationId: corr(req),
              });
            },
          }),
      );

      return result;
    },
  );

  // ── Project engineering conventions ─────────────────────────────────
  // 成员关系与 convention.manage 权限都由 preHandler 统一判过（见闸门那一节）
  app.get('/api/v1/projects/:id/conventions', async (req) => {
    const { id } = req.params as { id: string };
    return listConventions(db, id);
  });

  app.post(
    '/api/v1/projects/:id/conventions',
    {
      config: {
        auth: {
          permission: 'convention.manage',
        },
      },
    },
    async (req, reply) => {
      const { userId } = actorFrom(req);
      const { id } = req.params as { id: string };
      const body = ConventionInput.parse(req.body);
      return reply.status(201).send(await createConvention(db, id, userId, body));
    },
  );

  app.patch(
    '/api/v1/conventions/:id',
    {
      config: {
        auth: {
          permission: 'convention.manage',
        },
      },
    },
    async (req) => {
      actorFrom(req);
      const { id } = req.params as { id: string };
      return updateConvention(db, id, ConventionInput.partial().parse(req.body));
    },
  );

  app.delete(
    '/api/v1/conventions/:id',
    {
      config: {
        auth: {
          permission: 'convention.manage',
        },
      },
    },
    async (req) => {
      actorFrom(req);
      const { id } = req.params as { id: string };
      return deleteConvention(db, id);
    },
  );

  // ── Decision center (page doc 10) ───────────────────────────────────
  app.get('/api/v1/decision-inbox', async (req) => {
    const q = req.query as { scope?: string; projectId?: string };
    const scope = (['mine', 'all', 'watching'] as const).find((s) => s === q.scope) ?? 'mine';
    const projectId = q.projectId && UUID_RE.test(q.projectId) ? q.projectId : null;

    // ★ 收件箱必须带身份：它此前用 optionalUserId，匿名调用会返回**全部**
    //   项目的待决策 —— 跨组织的也在里面
    const { userId } = actorFrom(req);
    const visible = await visibleProjectIds(userId);
    if (projectId && !visible.includes(projectId)) throw notFound('project');

    return getDecisionInbox(db, userId, scope as DecisionScope, projectId, visible);
  });

  app.post(
    '/api/v1/decisions/batch-approve',
    {
      config: {
        auth: {
          permission: deferred(
              '一次提交的十条决策可能属于十个项目，URL 上一个都看不出来 —— 逐条按各自所属项目判（见 routes.ts 的 batch-approve）',
            ),
          },
      },
    },
    async (req) => {
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
    },
  );

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
  app.patch(
    '/api/v1/projects/:id/labor-cost',
    {
      config: {
        auth: {
          permission: 'project.settings.update',
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      actorFrom(req);
      const body = z
        .object({ laborHourlyCost: z.number().positive().nullable() })
        .parse(req.body);

      const [row] = await db.select().from(projects).where(eq(projects.id, id));
      if (!row) throw notFound('project');

      await db
        .update(projects)
        .set({
          laborHourlyCost: body.laborHourlyCost === null ? null : String(body.laborHourlyCost),
          updatedAt: new Date(),
        })
        .where(eq(projects.id, id));

      return { ok: true };
    },
  );

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
      throw fail('VALIDATION_FAILED', 'request.against_must_be_version', 'against 必须是版本号');
    }
    return comparePlans(db, id, against);
  });

  // ── Integration settings (page doc 14) ────────────────────────────────

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
      throw fail('FORBIDDEN', 'auth.forbidden', denyReason(actor, action) ?? '权限不足', {
        details: { action, projectRole: actor.projectRole },
      });
    }
    return actor;
  }

  /** 集成 id → projectId，权限判定要先知道是哪个项目 */
  async function projectOfIntegration(id: string): Promise<string> {
    const [row] = await db.select().from(integrations).where(eq(integrations.id, id));
    if (!row) throw notFound('integration');
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

  app.post(
    '/api/v1/projects/:id/integrations',
    {
      config: {
        auth: {
          /**
           * ★ 集成的写操作大多要看 body 才知道该判哪一档
           *   （连接时带不带写 scope、改的是不是 SoT），
           *   那些判定留在 handler 里（assertIntegration）。这里登记的是下限。
           */
          permission: 'integration.connect',
        },
      },
    },
    async (req, reply) => {
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
    },
  );

  app.patch(
    '/api/v1/integrations/:id/sync-mapping',
    {
      config: {
        auth: {
          permission: 'integration.change_sot',
        },
      },
    },
    async (req) => {
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
    },
  );

  /** 从代码仓库回流 CI 结果 —— 质量 Tab 的数据源（页面文档 12）*/
  app.post(
    '/api/v1/integrations/:id/ingest-ci',
    {
      config: {
        auth: {
          permission: 'integration.view',
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const { userId } = actorFrom(req);
      const projectId = await projectOfIntegration(id);
      await assertIntegration(projectId, userId, 'view', req);
      return ingestCiResults(db, deps.integrations, id);
    },
  );

  app.post(
    '/api/v1/integrations/:id/sync',
    {
      config: {
        auth: {
          permission: 'integration.view',
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const { userId } = actorFrom(req);
      const projectId = await projectOfIntegration(id);
      await assertIntegration(projectId, userId, 'view', req);

      return runSync(db, deps.integrations, id);
    },
  );

  app.get('/api/v1/projects/:id/sync-conflicts', async (req) => {
    const { id } = req.params as { id: string };
    return listConflicts(db, id);
  });

  app.post(
    '/api/v1/sync-conflicts/:id/resolve',
    {
      config: {
        auth: {
          permission: 'integration.resolve_conflict',
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const { userId, actor } = actorFrom(req);
      const body = z
        .object({
          winner: z.enum(['apos', 'external']),
          applyToSimilar: z.boolean().default(false),
        })
        .parse(req.body);

      const [conflict] = await db.select().from(syncConflicts).where(eq(syncConflicts.id, id));
      if (!conflict) throw notFound('conflict');
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
    },
  );

  app.post(
    '/api/v1/integrations/:id/objects',
    {
      config: {
        auth: {
          permission: 'integration.view',
        },
      },
    },
    async (req, reply) => {
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
    },
  );

  /** 断开前先看影响 —— 一个只问「确定吗」的确认框等于没问（§7） */
  app.get('/api/v1/integrations/:id/disconnect-impact', async (req) => {
    const { id } = req.params as { id: string };
    return disconnectImpact(db, id);
  });

  app.delete(
    '/api/v1/integrations/:id',
    {
      config: {
        auth: {
          permission: 'integration.disconnect',
        },
      },
    },
    async (req) => {
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
    },
  );

  app.patch(
    '/api/v1/integrations/:id/notifications',
    {
      config: {
        auth: {
          permission: 'integration.configure_notification',
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const { userId } = actorFrom(req);
      const config = NotificationConfig.parse(req.body);

      const projectId = await projectOfIntegration(id);
      await assertIntegration(projectId, userId, 'configure_notification', req);

      return updateNotificationConfig(db, id, config);
    },
  );

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
    if (!kind) throw fail(
      'VALIDATION_FAILED',
      'request.bad_enum_value',
      'kind 必须是 rework / wip / slow 之一',
    );
    const range = (ANALYTICS_RANGES as readonly string[]).includes(q.range ?? '')
      ? (q.range as AnalyticsRange)
      : '30d';

    return getAnalyticsItems(db, id, kind, range);
  });

  // ── Policy configuration ────────────────────────────────────────────
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
    /**
     * ★★ 可选。不给就由服务端往后追加（nextAuthoredPriority）。
     *
     *   优先级要求用户同时理解「越小越先」「命中即停」「组织规则占了前面
     *   那一段」三件事才填得对，而填错的表现是规则安静地不生效。
     *   界面上已经不再问这个数字；接口保留它，是因为改一条老规则时
     *   要能把它原样送回来，而不是在保存时被悄悄挪到队尾。
     */
    priority: z.number().int().min(1).optional(),
    condition: z.unknown(),
    action: z.unknown(),
    enabled: z.boolean().optional(),
    /** 模拟发现了与人类判断不一致的历史案例后，用户看过并坚持要保存 */
    acknowledgeMismatches: z.boolean().optional(),
  });

  /** 建新规则时没给优先级：往手写规则那一段的末尾追加 */
  async function resolvePriority(projectId: string, given: number | undefined) {
    if (given !== undefined) return given;
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) throw notFound('project');
    return nextAuthoredPriority(await loadProjectPolicies(db, project.orgId, projectId));
  }

  async function currentPriority(policyId: string) {
    const [row] = await db
      .select({ priority: policies.priority })
      .from(policies)
      .where(eq(policies.id, policyId));
    if (!row) throw notFound('policy');
    return row.priority;
  }

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

  app.post(
    '/api/v1/projects/:id/policies',
    {
      config: {
        auth: {
          /**
           * ★★ 收紧与放宽是两档权限（§2.3 的不对称设计）。
           *
           *   路由表在这里只能判出「至少要能收紧」；究竟是不是放宽
           *   要把新旧规则各跑一遍场景才知道，那在 savePolicy 里做
           *   （见 policies.ts 的 assertChangeAllowed）。这一层先挡掉
           *   连收紧都不够格的人，省掉后面的一大堆计算。
           */
          permission: 'policy.tighten',
        },
      },
    },
    async (req, reply) => {
      const { userId } = actorFrom(req);
      const { id } = req.params as { id: string };
      const body = PolicyDraftBody.parse(req.body);

      const result = await savePolicy(
        db,
        id,
        {
          name: body.name,
          description: body.description,
          priority: await resolvePriority(id, body.priority),
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
    },
  );

  app.patch(
    '/api/v1/projects/:id/policies/:policyId',
    {
      config: {
        auth: {
          permission: 'policy.tighten',
        },
      },
    },
    async (req) => {
      const { userId } = actorFrom(req);
      const { id, policyId } = req.params as { id: string; policyId: string };
      const body = PolicyDraftBody.parse(req.body);

      return savePolicy(
        db,
        id,
        {
          name: body.name,
          description: body.description,
          /** ★ 改一条老规则时不给优先级 = 保持原样，不是挪到队尾 */
          priority: body.priority ?? (await currentPriority(policyId)),
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
    },
  );

  app.post(
    '/api/v1/projects/:id/policies/:policyId/toggle',
    {
      config: {
        auth: {
          /** 停用一条规则就是把治理拿掉 —— 与放宽同档 */
          permission: (req) =>
            (req.body as { enabled?: unknown } | undefined)?.enabled === false
              ? 'policy.loosen'
              : 'policy.tighten',
          },
      },
    },
    async (req) => {
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
    },
  );

  app.delete(
    '/api/v1/projects/:id/policies/:policyId',
    {
      config: {
        auth: {
          permission: 'policy.loosen',
        },
      },
    },
    async (req) => {
      const { userId } = actorFrom(req);
      const { id, policyId } = req.params as { id: string; policyId: string };
      return deletePolicy(db, id, policyId, userId);
    },
  );

  /**
   * 操作开关矩阵（本轮新增）。
   *
   * ★★ 权限判定与「新建规则」完全一致：路由表只挡掉「连收紧都不够格」的人，
   *   这次切换算收紧还是放宽，要把新旧规则各跑一遍场景才知道，
   *   所以交给 savePolicy 的回调（§2.3 的不对称设计）。
   *
   *   开关看着像个轻量操作，但它生成的是一条真规则 ——
   *   给它开一条更松的权限路径，等于把整套不对称设计从后门绕过去。
   *
   * The switch matrix reuses exactly the save path of "new rule": the route
   * table only rejects those who cannot even tighten, and the tighten/loosen
   * call is made inside savePolicy once the direction is known. A switch looks
   * lightweight but produces a real rule; a laxer path here would be a back
   * door around the whole asymmetric design.
   */
  app.put(
    '/api/v1/projects/:id/policies/operation-switch',
    { config: { auth: { permission: 'policy.tighten' } } },
    async (req) => {
      const { userId } = actorFrom(req);
      const { id } = req.params as { id: string };
      const body = z
        .object({
          operationType: OperationType,
          verdict: z.enum(['auto', 'human']),
          /** 'any' = 所有环境，条件里不写 environment */
          environment: z.union([Environment, z.literal('any')]).optional(),
          approver: z.string().min(1).optional(),
          dueInHours: z.number().positive().optional(),
          /** 界面按用户当下的语言拼好的规则名 —— 名字是落库的数据 */
          name: z.string().min(1).max(200).optional(),
          acknowledgeMismatches: z.boolean().optional(),
        })
        .parse(req.body);

      return setOperationSwitch(
        db,
        id,
        {
          operationType: body.operationType,
          verdict: body.verdict,
          ...(body.environment ? { environment: body.environment } : {}),
          ...(body.approver ? { approver: body.approver } : {}),
          ...(body.dueInHours ? { dueInHours: body.dueInHours } : {}),
          ...(body.name ? { name: body.name } : {}),
        },
        userId,
        {
          ...(body.acknowledgeMismatches !== undefined
            ? { acknowledgeMismatches: body.acknowledgeMismatches }
            : {}),
          assertCan: await policyGuard(req, id),
        },
      );
    },
  );

  /** 关掉开关 = 删掉它建的那条规则，这一行回到「其余规则说了算」 */
  app.delete(
    '/api/v1/projects/:id/policies/operation-switch/:operationType',
    { config: { auth: { permission: 'policy.loosen' } } },
    async (req) => {
      const { userId } = actorFrom(req);
      const { id, operationType } = req.params as { id: string; operationType: string };
      return clearOperationSwitch(db, id, OperationType.parse(operationType), userId);
    },
  );

  /**
   * 模板 → 条件/动作。
   *
   * ★ 这个映射只在后端有一份实现（domain 的 templates.ts）。
   *   前端跟着算一遍就有两份，迟早对不上 —— 而这一页对不上的后果是
   *   「界面上写的规则」和「实际执行的规则」不是同一条。
   *   顺带把人话解释一起返回，编辑器改参数时能实时更新（页面文档 13 §5.6）。
   */
  app.post(
    '/api/v1/projects/:id/policies/from-template',
    {
      config: {
        auth: {
          permission: 'policy.view',
        },
      },
    },
    async (req) => {
      const body = z
        .object({ templateId: z.string(), values: z.record(z.union([z.string(), z.number()])) })
        .parse(req.body);

      const template = templateById(body.templateId);
      if (!template) throw notFound('template');

      const built = template.build(body.values);
      return { ...built, explanation: explainPolicy(built.condition, built.action) };
    },
  );

  app.post(
    '/api/v1/projects/:id/policies/simulate',
    {
      config: {
        auth: {
          /** 模拟 / 预演 / 套模板都是只读推演，不改任何东西 */
          permission: 'policy.view',
        },
      },
    },
    async (req) => {
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
    },
  );

  app.post(
    '/api/v1/projects/:id/policies/evaluate',
    {
      config: {
        auth: {
          permission: 'policy.view',
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = z.object({ context: z.record(z.unknown()) }).parse(req.body);
      return evaluateScenario(db, id, body.context as Partial<PolicyContext>);
    },
  );

  app.post(
    '/api/v1/projects/:id/policies/autonomy-preview',
    {
      config: {
        auth: {
          permission: 'policy.view',
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({ to: z.enum(['human_led', 'agent_led_approval', 'agent_autonomous']) })
        .parse(req.body);
      return autonomyPreview(db, id, body.to);
    },
  );

  app.patch(
    '/api/v1/projects/:id/autonomy',
    {
      config: {
        auth: {
          permission: 'project.autonomy.change',
        },
      },
    },
    async (req) => {
      const { userId } = actorFrom(req);
      const { id } = req.params as { id: string };
      const body = z
        .object({ autonomyLevel: z.enum(['human_led', 'agent_led_approval', 'agent_autonomous']) })
        .parse(req.body);

      const [before] = await db.select().from(projects).where(eq(projects.id, id));
      if (!before) throw notFound('project');

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
    },
  );

  app.get('/api/v1/policies/:policyId/history', async (req) => {
    const { policyId } = req.params as { policyId: string };
    return getPolicyHistory(db, policyId);
  });

  // ── Work Item ───────────────────────────────────────────────────────
  app.get('/api/v1/work-items/:id', async (req) => {
    const { id } = req.params as { id: string };
    const [item] = await db.select().from(workItems).where(eq(workItems.id, id));
    if (!item) throw notFound('work_item');

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

  app.post(
    '/api/v1/projects/:id/work-items',
    {
      config: {
        auth: {
          /**
           * ★★ 建任务本身门槛很低（能执行任务的人就能建），但**放行去执行**
           *   仍然要 `plan.approve` —— 那是在 handler 里判的（见 routes.ts
           *   的 draft → ready 分支），因为它取决于任务**当前**的状态，
           *   而路由表这一层看不到数据库。
           */
          permission: 'work_item.create',
        },
      },
    },
    async (req, reply) => {
      const { userId } = actorFrom(req);
      const { id } = req.params as { id: string };
      const body = WorkItemInput.parse(req.body);
      const result = await createWorkItem(
        db,
        { projectId: id, actorId: userId, correlationId: corr(req) },
        body,
      );
      return reply.status(201).send(result);
    },
  );

  app.patch(
    '/api/v1/work-items/:id/status',
    {
      config: {
        auth: {
          /**
           * ★ 勾了 overrideGuards 就是强制放行，要的是另一档权限（§2.3）。
           *   「改状态」和「让不达标的任务过去」共用一个端点，
           *   但绝不能共用一个权限。
           */
          permission: (req) => {
            const body = req.body as { overrideGuards?: unknown } | undefined;
            return body?.overrideGuards
              ? ['work_item.execute', 'work_item.force_pass']
              : 'work_item.execute';
          },
        },
      },
    },
    async (req) => {
      const { userId, actor } = actorFrom(req);
      const { id } = req.params as { id: string };
      const body = StatusChange.parse(req.body);

      const [current] = await db.select().from(workItems).where(eq(workItems.id, id));
      if (!current) throw notFound('work_item');

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
        throw fail(
          'INVALID_TRANSITION',
          'work_item.manual_status_not_allowed',
          `当前状态 ${current.status} 不能手动切换到 ${body.toStatus}`,
          { params: { to: body.toStatus }, details: { from: current.status, allowedTriggers: availableTriggers(WORK_ITEM_MACHINE, current.status) } },
        );
      }

      const correlationId = corr(req);
      if (
        trigger === 'review_passed' &&
        body.overrideGuards?.includes('acceptanceCriteriaMet')
      ) {
        await recordHumanAcceptance(db, {
          workItemId: id,
          evidenceRef: `manual-review:${correlationId}`,
          actor,
          reason: body.reason,
          correlationId,
        });
      }

      const result = await transition(db, {
        workItemId: id,
        trigger,
        actor,
        reason: body.reason,
        reasonCategory: body.reasonCategory,
        manual: true,
        overrideGuards: body.overrideGuards,
        correlationId,
      });

      if (!result.ok) return mapTransitionError(result);
      if (result.to === 'done') {
        await rollUpRequirementAcceptance(db, { workItemId: id, actor, correlationId });
      }
      return toTransitionResponse(result);
    },
  );

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
  /**
   * 「现在能不能开始」要先说清楚，而不是让它掉进流转错误里。
   *
   * ★ /assign 与 /start 共用同一条判据 —— 两处各写一份的话，
   *   同一张卡在两个入口上会得到两种说法。
   */
  function assertStartable(status: string) {
    const STARTABLE = ['ready', 'blocked', 'changes_requested'];
    if (!STARTABLE.includes(status)) {
      throw fail(
        'INVALID_TRANSITION',
        'work_item.not_startable',
        `任务当前状态是 ${status}，不能直接指派开始。失败的任务请用「重试」，执行中的请先终止。`,
        { details: { status, startable: STARTABLE } },
      );
    }
  }

  /** 真正派 Run 的那一段。/assign 与 /start 共用 */
  async function startRun(
    req: FastifyRequest,
    item: typeof workItems.$inferSelect,
    agentId: string,
    note: string | undefined,
    actor: ReturnType<typeof actorFrom>['actor'],
    userId: string,
  ) {
    const result = await dispatchRun(
      db,
      deps.registry,
      {
        workItemId: item.id,
        agentId,
        correlationId: corr(req),
        additionalContext: note ? [{ title: '派发人的补充说明', content: note }] : undefined,
      },
      { workspaces: deps.workspaces },
    );

    if (!result.ok) {
      /**
       * 工作区问题要用它自己的错误码，别混进「Agent 不可用」。
       *
       * ★ 两个分支是两条**码**，不是一条码配一个三元表达式挑句子。
       *   界面要按码取词，而一条码只能对应一句话 —— 让两种完全不同的
       *   处境共用一个码，等于把「工作区挂了」和「Agent 派不出去」
       *   在英文界面上说成同一句。
       */
      throw result.code === 'WORKSPACE_UNAVAILABLE'
        ? fail(
            'VALIDATION_FAILED',
            'work_item.workspace_unavailable',
            (result.detail as { reason?: string })?.reason ?? '工作区不可用',
            { details: result.detail },
          )
        : fail('AGENT_UNAVAILABLE', 'work_item.dispatch_failed', '派发失败', {
            details: result.detail,
          });
    }

    await emitAndPublish(db, {
      orgId: item.orgId,
      projectId: item.projectId,
      type: 'work_item.assigned',
      actor,
      subjectType: 'work_item',
      subjectId: item.id,
      payload: { executorType: 'agent', executorId: agentId, byUserId: userId, manual: true },
      correlationId: corr(req),
    });

    return {
      ok: true as const,
      executorType: 'agent' as const,
      runId: result.runId,
      attempt: result.attempt,
      reused: result.reused,
    };
  }

  /**
   * 候选执行者 —— 能选谁、以及为什么不能选谁。
   *
   * ★ 不可选的也返回。只回可选项的话，界面上是个空下拉框，
   *   而「没配 Agent / 没加进项目 / 满载 / 运行时没注册」这四种原因
   *   的下一步动作完全不同。
   */
  app.get('/api/v1/work-items/:id/candidates', async (req) => {
    const { id } = req.params as { id: string };
    return listCandidates(db, deps.registry, id);
  });

  /**
   * 只设置执行者，不开始执行。
   *
   * ★★ 这是从 /assign 里拆出来的那一半。选执行者是一个「选择」，
   *   不该有副作用 —— 而在拆开之前，它会立刻派 Run、改文件、烧预算。
   */
  app.patch(
    '/api/v1/work-items/:id/assignee',
    {
      config: {
        auth: {
          permission: 'work_item.assign',
        },
      },
    },
    async (req) => {
      const { actor, userId } = actorFrom(req);
      const { id } = req.params as { id: string };
      const body = AssigneeInput.parse(req.body ?? {});

      const [before] = await db.select().from(workItems).where(eq(workItems.id, id));
      if (!before) throw notFound('work_item');

      const result = await setAssignee(db, id, body, { registry: deps.registry });

      await emitAndPublish(db, {
        orgId: before.orgId,
        projectId: before.projectId,
        type: 'work_item.assignee_changed',
        actor,
        subjectType: 'work_item',
        subjectId: id,
        payload: {
          from: { executorType: before.executorType, executorId: before.executorId },
          to: { executorType: result.executorType, executorId: result.executorId },
          executionMode: result.executionMode,
          byUserId: userId,
          /** ★ 改派顺手终止了哪几次执行 —— 这是花过钱的事，必须留痕 */
          takeover: body.takeover ?? null,
          terminatedRuns: result.terminatedRuns,
        },
        correlationId: corr(req),
      });

      return result;
    },
  );

  /**
   * 开始执行 —— 真正派 Run 的那一步。
   *
   * ★ 不带执行者时用卡片上已经设好的那个。这样「先排活、回头再开跑」
   *   是两次独立的动作，而不是必须在一次调用里同时决定。
   */
  app.post(
    '/api/v1/work-items/:id/start',
    {
      config: {
        auth: {
          permission: 'work_item.execute',
        },
      },
    },
    async (req) => {
      const { actor, userId } = actorFrom(req);
      const { id } = req.params as { id: string };
      const body = z
        .object({ agentId: z.string().uuid().optional(), note: z.string().max(4000).optional() })
        .parse(req.body ?? {});

      const [item] = await db.select().from(workItems).where(eq(workItems.id, id));
      if (!item) throw notFound('work_item');

      assertStartable(item.status);

      const agentId = body.agentId ?? (item.executorType === 'agent' ? item.executorId : null);
      if (!agentId) {
        /** ★ 同上：两种处境两条码。「执行者是人」和「还没指定」的下一步动作不同 */
        throw item.executorType === 'human'
          ? fail(
              'VALIDATION_FAILED',
              'work_item.human_executor',
              '这张卡的执行者是人，不能派给 Agent 执行',
              { details: { executorType: item.executorType } },
            )
          : fail(
              'VALIDATION_FAILED',
              'work_item.no_agent_specified',
              '还没有指定执行 Agent —— 先设置执行者，或在请求里带上 agentId',
              { details: { executorType: item.executorType } },
            );
      }

      return startRun(req, item, agentId, body.note, actor, userId);
    },
  );

  app.post(
    '/api/v1/work-items/:id/assign',
    {
      config: {
        auth: {
          permission: 'work_item.execute',
        },
      },
    },
    async (req) => {
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
      if (!item) throw notFound('work_item');

      assertStartable(item.status);

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

      return startRun(req, item, body.agentId!, body.note, actor, userId);
    },
  );

  app.post(
    '/api/v1/work-items/:id/retry',
    {
      config: {
        auth: {
          permission: 'work_item.execute',
        },
      },
    },
    async (req) => {
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
      if (!item) throw notFound('work_item');

      const agentId = body.agentId ?? item.executorId;
      if (!agentId) throw fail('VALIDATION_FAILED', 'work_item.no_agent_specified', '未指定执行 Agent');

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

      if (!result.ok) throw fail(
        'AGENT_UNAVAILABLE',
        'work_item.dispatch_failed',
        '派发失败',
        { details: result.detail },
      );
      return result;
    },
  );

  app.post(
    '/api/v1/work-items/:id/takeover',
    {
      config: {
        auth: {
          permission: 'work_item.takeover',
        },
      },
    },
    async (req) => {
      const { actor } = actorFrom(req);
      const { id } = req.params as { id: string };
      const body = z
        .object({
          reason: z.string({ required_error: '接管必须填写原因' }).min(1, '接管必须填写原因'),
        })
        .parse(req.body);

      /**
       * ★★ 「接管」是一个**意图**，不是一个状态机触发器。
       *
       *   它此前恒等于 `human_took_over`，而那个触发器只在 executing 上成立。
       *   于是看板上一张 blocked / failed 的卡片，按钮点下去拿到的是
       *   「当前状态 ready 不支持该操作」—— 一句既没说清为什么、
       *   也和按钮出现的条件互相矛盾的话（问题记录 #16 / #27）。
       *
       *   同一个意图在不同状态下有不同的合法触发器：跑着的活是「换成我来跑」，
       *   卡住或失败的活是「升级给人处理」。两者的效果都是
       *   switchExecutorToHuman，用户看到的也该是同一个按钮。
       *
       *   "Take over" is an intent, not a trigger. It used to map to
       *   `human_took_over`, which is only legal from `executing`; on a blocked
       *   or failed card the button therefore always failed with a message that
       *   contradicted its own visibility.
       */
      const [current] = await db
        .select({ status: workItems.status })
        .from(workItems)
        .where(eq(workItems.id, id));
      if (!current) throw notFound('work_item');

      const trigger =
        current.status === 'executing'
          ? ('human_took_over' as const)
          : ('escalated_to_human' as const);

      const result = await transition(db, {
        workItemId: id,
        trigger,
        actor,
        reason: body.reason,
        correlationId: corr(req),
      });

      if (!result.ok) return mapTransitionError(result);
      return toTransitionResponse(result);
    },
  );

  // ── Run ─────────────────────────────────────────────────────────────
  app.get('/api/v1/runs/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getRunDetail(db, id);
  });

  app.get(
    '/api/v1/runs/:id/events',
    {
      config: {
        auth: {
          /** 详细模式可能含敏感上下文，简明模式不需要额外权限（§2.3）*/
          permission: (req) =>
            (req.query as { level?: string } | undefined)?.level === 'detailed'
              ? 'run.view_detailed'
              : null,
              context: (req, ctx) =>
            runOwnerContext(ctx, (req.params as { id: string }).id),
          },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const q = req.query as { level?: string; after?: string; limit?: string };

      return getRunEvents(db, id, {
        level: q.level === 'detailed' ? 'detailed' : 'brief',
        after: q.after !== undefined ? Number(q.after) : undefined,
        limit: q.limit !== undefined ? Number(q.limit) : undefined,
      });
    },
  );

  app.get('/api/v1/runs/:id/cost-breakdown', async (req) => {
    const { id } = req.params as { id: string };
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, id));
    if (!run) throw notFound('run');
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

  app.post(
    '/api/v1/runs/:id/control',
    {
      config: {
        auth: {
          permission: 'run.control',
          /** Run 自带 projectId，成员关系闸门已经解析出项目角色，只差 owner */
          context: (req, ctx) =>
        runOwnerContext(ctx, (req.params as { id: string }).id),
        },
      },
    },
    async (req) => {
      const { actor, userId } = actorFrom(req);
      const { id } = req.params as { id: string };
      const body = RunControl.parse(req.body);

      const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, id));
      if (!run) throw notFound('run');

      if (!(ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) {
        throw fail(
          'VERSION_CONFLICT',
          'run.already_final',
          `Run 已经是 ${run.status} 状态，无法再操作`,
          { params: { status: run.status }, details: { status: run.status, } },
        );
      }

      const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId));
      if (!agent) throw notFound('agent');
      if (!deps.registry.has(agent.id)) {
        throw fail(
          'AGENT_UNAVAILABLE',
          'agent.runtime_not_registered',
          '该 Agent 的运行时未在本进程注册，无法控制',
          { details: { agentId: agent.id, runtimeKind: agent.runtimeKind, } },
        );
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
          throw fail(
            'UNSUPPORTED_FEATURE',
            'runtime.action_unsupported',
            `运行时 ${adapter.kind} 不支持「${LABELS[body.action]}」`,
            { params: { runtimeKind: adapter.kind }, details: { feature: err.feature, runtimeKind: err.runtimeKind, fallback: FALLBACK[body.action] } },
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
    },
  );

  // ── Decisions ───────────────────────────────────────────────────────
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
    if (!decision) throw notFound('decision');

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
  app.post(
    '/api/v1/decisions/:id/remind',
    {
      config: {
        auth: {
          permission: 'decision.remind',
        },
      },
    },
    async (req) => {
      const { actor } = actorFrom(req);
      const { id } = req.params as { id: string };

      const [decision] = await db.select().from(decisions).where(eq(decisions.id, id));
      if (!decision) throw notFound('decision');
      if (decision.status !== 'pending') {
        throw fail(
          'VERSION_CONFLICT',
          'decision.already_handled',
          '该决策已被处理',
          { details: { status: decision.status } },
        );
      }

      const cooldownMs = 30 * 60_000;
      const since = decision.remindedAt ? Date.now() - decision.remindedAt.getTime() : Infinity;
      if (since < cooldownMs) {
        throw fail(
          'RATE_LIMITED',
          'work_item.nudge_too_soon',
          '刚刚已经催办过了，请稍后再试',
          { params: { retryAfterMinutes: Math.ceil((cooldownMs - since) / 60_000) }, details: { retryAfterMinutes: Math.ceil((cooldownMs - since) / 60_000), } },
        );
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
    },
  );

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
    const outbox: EmittedEvent[] = [];
    const finalized = await db.transaction(async (tx) => {
      const [decision] = await tx
        .select()
        .from(decisions)
        .where(eq(decisions.id, id))
        .for('update');
      if (!decision) throw notFound('decision');
      if (decision.status !== 'pending') {
        throw fail(
          'VERSION_CONFLICT',
          'decision.already_handled',
          '该决策已被处理',
          { details: { status: decision.status } },
        );
      }
      if (decision.assigneeId && decision.assigneeId !== userId) {
        throw fail(
          'FORBIDDEN',
          'decision.not_delegable',
          '决策责任不可代行。如需变更责任人，请使用改派功能。',
          { details: { assigneeId: decision.assigneeId } },
        );
      }

      await tx
        .update(decisions)
        .set({
          status: 'approved',
          resolvedBy: userId,
          resolvedAt: new Date(),
          resolutionNote: body.note,
          appliedConstraints: body.constraints as never,
        })
        .where(eq(decisions.id, id));
      outbox.push(
        await emit(tx, {
          orgId: decision.orgId,
          projectId: decision.projectId,
          actor,
          type: 'decision.approved',
          subjectType: 'decision',
          subjectId: id,
          payload: {
            workItemId: decision.workItemId,
            assigneeId: decision.assigneeId,
          },
          correlationId,
        }),
      );

      if (!decision.workItemId) {
        return {
          response: { ok: true as const, decisionId: id },
          resumeWorkItemId: null,
        };
      }

      if (body.constraints.length > 0) {
        /**
         * ★ 追加而不是「读出来再整个写回」。两条决策同时批准时，
         *   后写的那个会带着它读到的旧数组覆盖全列，
         *   先加的那几条约束就凭空消失了 —— 而约束是人类附加给 Agent 的
         *   执行限制，少一条没有任何迹象。见 work-item/json-merge.ts。
         */
        await tx
          .update(workItems)
          .set({
            constraints: appendConstraints(
              body.constraints.map((c) => ({ ...c, decisionId: id })),
            ) as never,
          })
          .where(eq(workItems.id, decision.workItemId));
      }

      /**
       * A review approval is not a detour from `awaiting_decision`: the task deliberately
       * remains in `reviewing` while the human inspects it. Sending `decision_approved`
       * here therefore cannot match the state machine and used to leave the decision
       * approved while the task stayed stuck forever. Human approval supplies the two
       * review-gate overrides, then follows the same release/acceptance chain as the
       * automatic reviewer.
       */
      if (decision.type === 'review_approval') {
        const reason = body.note ?? decision.whyHuman ?? 'Human approved the review';
        outbox.push(...await recordHumanAcceptanceInTransaction(tx, {
          workItemId: decision.workItemId,
          evidenceRef: `decision:${id}`,
          actor,
          reason,
          correlationId,
        }));
        const review = await transitionInTransaction(tx, {
          workItemId: decision.workItemId,
          trigger: 'review_passed',
          actor,
          overrideGuards: ['qualityGatePassed'],
          reason,
          correlationId,
        });
        if (!review.ok) throw mapTransitionError(review);
        outbox.push(...review.events);

        let result = review;
        for (const trigger of ['release_started', 'release_completed', 'accepted'] as const) {
          const moved = await transitionInTransaction(tx, {
            workItemId: decision.workItemId,
            trigger,
            actor,
            reason,
            correlationId,
          });
          if (!moved.ok) throw mapTransitionError(moved);
          outbox.push(...moved.events);
          result = moved;
        }
        outbox.push(...await rollUpRequirementAcceptanceInTransaction(tx, {
          workItemId: decision.workItemId,
          actor,
          correlationId,
        }));
        return {
          response: { ok: true as const, decisionId: id, workItem: toTransitionResponse(result) },
          resumeWorkItemId: null,
        };
      }

      const result = await transitionInTransaction(tx, {
        workItemId: decision.workItemId,
        trigger: 'decision_approved',
        actor,
        approvedDecisionId: id,
        correlationId,
      });
      if (!result.ok) throw mapTransitionError(result);
      outbox.push(...result.events);
      return {
        response: { ok: true as const, decisionId: id, workItem: toTransitionResponse(result) },
        resumeWorkItemId: result.to === 'executing' ? decision.workItemId : null,
      };
    });

    if (outbox.length > 0) deps.bus.publish(outbox);

    if (finalized.resumeWorkItemId) {
      const resumed = await resumeQueuedRun(
        db,
        deps.registry,
        { workItemId: finalized.resumeWorkItemId, correlationId },
        { workspaces: deps.workspaces },
      );
      if (resumed && !resumed.ok) {
        return { ...finalized.response, resume: { ok: false as const, detail: resumed.detail } };
      }
    }
    return finalized.response;
  }

  app.post(
    '/api/v1/decisions/:id/approve',
    {
      config: {
        auth: {
          permission: 'decision.act',
        },
      },
    },
    async (req) => {
      const { userId, actor } = actorFrom(req);
      const { id } = req.params as { id: string };
      const body = ApproveBody.parse(req.body ?? {});
      return approveDecisionById(id, userId, actor, body, corr(req));
    },
  );

  app.post(
    '/api/v1/decisions/:id/reject',
    {
      config: {
        auth: {
          permission: 'decision.act',
        },
      },
    },
    async (req) => {
      const { userId, actor } = actorFrom(req);
      const { id } = req.params as { id: string };
      const body = z
        .object({
          reason: z.string({ required_error: '驳回必须填写原因' }).min(1, '驳回必须填写原因'),
        })
        .parse(req.body);

      const correlationId = corr(req);
      const outbox: EmittedEvent[] = [];
      await db.transaction(async (tx) => {
        const [decision] = await tx
          .select()
          .from(decisions)
          .where(eq(decisions.id, id))
          .for('update');
        if (!decision) throw notFound('decision');
        if (decision.status !== 'pending') {
          throw fail(
            'VERSION_CONFLICT',
            'decision.already_handled',
            '该决策已被处理',
            { details: { status: decision.status } },
          );
        }
        if (decision.assigneeId && decision.assigneeId !== userId) {
          throw fail(
            'FORBIDDEN',
            'decision.not_delegable',
            '决策责任不可代行。如需变更责任人，请使用改派功能。',
            { details: { assigneeId: decision.assigneeId } },
          );
        }

        await tx
          .update(decisions)
          .set({
            status: 'rejected',
            resolvedBy: userId,
            resolvedAt: new Date(),
            resolutionNote: body.reason,
          })
          .where(eq(decisions.id, id));

        if (decision.workItemId) {
          const result = await transitionInTransaction(tx, {
            workItemId: decision.workItemId,
            trigger: decision.type === 'review_approval' ? 'review_rejected' : 'decision_rejected',
            actor,
            reason: body.reason,
            correlationId,
          });
          if (!result.ok) throw mapTransitionError(result);
          outbox.push(...result.events);
        }
        outbox.push(
          await emit(tx, {
            orgId: decision.orgId,
            projectId: decision.projectId,
            actor,
            type: 'decision.rejected',
            subjectType: 'decision',
            subjectId: id,
            payload: {
              workItemId: decision.workItemId,
              assigneeId: decision.assigneeId,
              reason: body.reason,
            },
            correlationId,
          }),
        );
      });
      if (outbox.length > 0) deps.bus.publish(outbox);
      return { ok: true, decisionId: id };
    },
  );

  // ── Scheduling ──────────────────────────────────────────────────────
  app.post(
    '/api/v1/projects/:id/schedule',
    {
      config: {
        auth: {
          permission: 'project.schedule',
        },
      },
    },
    async (req) => {
      actorFrom(req);
      const { id } = req.params as { id: string };
      return scheduleRound(db, deps.registry, {
        projectId: id,
        correlationId: corr(req),
        workspaces: deps.workspaces,
      });
    },
  );

  // ── Agent callbacks ─────────────────────────────────────────────────
  app.post('/api/v1/agent-callback/runs/:id/events', async (req) => {
    const { id } = req.params as { id: string };
    const auth = req.headers['authorization'];

    // Run 级令牌：仅对该 runId 有效，Run 结束即失效
    if (auth !== `Bearer ${id}`) {
      throw fail('UNAUTHENTICATED', 'auth.run_token_invalid', 'Run 令牌无效');
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
     * ★★ 身份**和**频道都要判。
     *
     *   只验令牌是不够的：频道名里带着项目 id，任何登录账号带上
     *   `?channels=project:<别人的项目>:board` 就能拿到那个项目的
     *   全部实时事件，而同一个人打 REST 的 `/projects/:id/board`
     *   会拿到 404。多租户边界不能只建立在 REST 那一半上。
     *   逐频道的判定在 authorizeChannels（sse-channels.ts）。
     *
     * ★ 令牌走 query 而不是 Authorization 头，是 EventSource 的限制：
     *   它不能带自定义头（同一页的 Last-Event-ID 也是因此走 query 的）。
     *   代价是令牌会进 access log，缓解靠短 TTL。
     */
    const { userId } = actorFrom(req);

    const q = req.query as { channels?: string };
    const requested = (q.channels ?? '').split(',').filter(Boolean);
    if (requested.length === 0) {
      throw fail('VALIDATION_FAILED', 'integration.channel_required', '必须指定至少一个频道');
    }

    const actor = await rbac.resolveActor(req, userId, null);
    const { allowed, denied } = await authorizeChannels(
      { db, projectAccess: rbac.projectAccess, projectOfResource },
      req,
      actor,
      requested,
    );

    /**
     * ★ 一条都没通过时拒掉整条连接，而不是开一条空流。
     *   空流的表现是「连上了但永远不动」—— 比一个明确的错误难查得多。
     *   与成员关系闸门同一个理由，回 404 不确认那些频道存不存在。
     */
    if (allowed.length === 0) {
      throw fail(
        'NOT_FOUND',
        'integration.channels_unavailable',
        '指定的频道都不存在，或当前身份没有访问权限',
        { details: { channels: denied, } },
      );
    }

    /**
     * 浏览器只在 EventSource 自己重连时才带 Last-Event-ID 头。
     * 前端因为频道变化主动新建连接时带不上，所以同时支持 query 参数。
     */
    const header = req.headers['last-event-id'];
    const fromQuery = (req.query as { lastEventId?: string }).lastEventId;
    const lastEventId = typeof header === 'string' ? header : fromQuery;

    return handleSse(req, reply, deps, {
      channels: allowed,
      denied,
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
      throw notFound('work_item');
    case 'INVALID_TRANSITION':
      /**
       * ★ `from` 用状态**标签**而不是枚举值。
       *   界面上那张卡片写着「已阻塞」，报错却说「当前状态 ready 不支持」——
       *   两个词指的是同一件事，但用户没有办法知道（问题记录 #16）。
       *   detail 里仍然带原始枚举，前端要判断时读那一栏。
       */
      throw fail(
        'INVALID_TRANSITION',
        'work_item.transition_not_allowed',
        `当前状态「${STATUS_LABELS[result.from] ?? result.from}」不支持该操作`,
        { details: { from: result.from, fromLabel: STATUS_LABELS[result.from] ?? result.from, allowedTriggers: result.allowedTriggers, } },
      );
    case 'GUARD_FAILED':
      /**
       * ★ Guard 的失败原因是 domain 层写好的一句句中文，这里原样串起来。
       *   界面对 GUARD_FAILED 也是原样显示 —— 这是**已知的剩余缺口**：
       *   要真正修好得让 guards.ts 里那五条理由各自带码，见 CLAUDE.md。
       *   码给到 `guard.failed`，至少让界面知道这是哪一类，
       *   而具体哪几条没过仍然只有中文。
       */
      throw fail('GUARD_FAILED', 'guard.failed', result.failures.map((f) => f.reason).join('；'), {
        details: { failures: result.failures },
      });
    case 'POLICY_DENIED':
      throw fail('POLICY_DENIED', 'policy.denied', result.message, {
        details: { verdict: result.verdict },
      });
  }
}

/**
 * 模板要发给前端，但 `build` 是函数，序列化不过去。
 * 前端只需要参数表单的描述，具体条件由后端在创建时用 build 拼出来 ——
 * 这样「模板 → 规则」的映射只有一份实现，前端改不了它。
 */
function serializeTemplates() {
  /** ★ 开关矩阵背后的两个模板不出现在这里 —— 同一件事不给两个入口 */
  return POLICY_TEMPLATES.filter((t) => !t.matrixOnly).map((t) => ({
    id: t.id,
    scenario: t.scenario,
    name: t.name,
    purpose: t.purpose,
    direction: t.direction,
    params: t.params,
  }));
}
