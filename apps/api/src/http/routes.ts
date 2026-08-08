import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import {
  agentRuns,
  agents,
  artifacts,
  decisionOptions,
  decisions,
  events,
  plans,
  projects,
  integrations,
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
  SyncMapping,
  WorkItemStatus,
  type PolicyContext,
} from '@apos/contracts';
import {
  ANALYTICS_RANGES,
  LAYOUTS,
  POLICY_TEMPLATES,
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
import { ingestRunEvent } from '../modules/agent/ingest';
import { emitAndPublish } from '../modules/event/bus';
import { ApiError, asClientInputError, notFound, sendError } from './errors';
import { handleSse } from './sse';
import { getBoard } from './board';
import { getGraph } from './graph';
import { getAnalytics, getAnalyticsItems } from './analytics';
import { getOverview } from './overview';
import { getAgent, listAgents, listRuntimes } from './agents';
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
 * MVP 阶段的身份来源：请求头。真实认证见 docs/tech/09-security.md
 *
 * ★ 必须校验格式。不校验的话，`X-User-Id: null`（客户端常见的
 *   「变量是 null 被拼成字符串」）会一路走到 SQL，报
 *   `invalid input syntax for type uuid` 变成 500 —— 调用方以为服务端挂了，
 *   实际是自己传错了。客户端的错必须以 4xx 的形式还给客户端。
 */
function actorFrom(req: { headers: Record<string, unknown> }) {
  const id = req.headers['x-user-id'];
  if (typeof id !== 'string' || id === '') {
    throw new ApiError('UNAUTHENTICATED', '缺少 X-User-Id 头');
  }
  if (!UUID_RE.test(id)) {
    throw new ApiError('UNAUTHENTICATED', 'X-User-Id 不是合法的用户 ID', { received: id });
  }
  return { userId: id, actor: humanActor(id) };
}

/**
 * 身份可选的端点用这个（列表筛选、看板的「只看需我处理」）。
 *
 * 没带头就返回 null，带了就必须合法 —— 「带了但格式不对」不能被当成
 * 「没带」静默忽略：用户会看到一个「我的待办为空」的页面，
 * 而真实原因是请求头拼错了。
 */
function optionalUserId(req: { headers: Record<string, unknown> }): string | null {
  const id = req.headers['x-user-id'];
  if (typeof id !== 'string' || id === '') return null;
  if (!UUID_RE.test(id)) {
    throw new ApiError('UNAUTHENTICATED', 'X-User-Id 不是合法的用户 ID', { received: id });
  }
  return id;
}

function corr(req: { headers: Record<string, unknown> }): string {
  const header = req.headers['x-correlation-id'];
  return typeof header === 'string' ? header : randomUUID();
}

export async function registerRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

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

  // ── 身份 ────────────────────────────────────────────────────────────
  // MVP 用 X-User-Id 头认证，前端需要一份可选身份列表来切换视角
  // （验证「只看需我处理」和「决策不可代行」都要换人看）
  app.get('/api/v1/users', async () => {
    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        avatarUrl: users.avatarUrl,
        orgRole: users.orgRole,
        approvalScopes: users.approvalScopes,
      })
      .from(users)
      .orderBy(users.name);
    return { users: rows };
  });

  // ── 项目 ────────────────────────────────────────────────────────────
  app.get('/api/v1/projects', async () => {
    const rows = await db.select().from(projects).orderBy(desc(projects.updatedAt));
    return { projects: rows };
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

  const CreateProject = z.object({
    name: z.string().min(1),
    goal: z.string().optional(),
    type: z.string().default('development'),
    autonomyLevel: z
      .enum(['human_led', 'agent_led_approval', 'agent_autonomous'])
      .default('agent_led_approval'),
    budgetAmount: z.string().optional(),
    orgId: z.string().uuid(),
  });

  app.post('/api/v1/projects', async (req, reply) => {
    const { userId } = actorFrom(req);
    const body = CreateProject.parse(req.body);

    const [project] = await db
      .insert(projects)
      .values({ ...body, techLeadId: userId })
      .returning();

    return reply.status(201).send({ project });
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
    return listAgents(db, projectId);
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

  // ── 决策中心（页面文档 10）──────────────────────────────────────────
  app.get('/api/v1/decision-inbox', async (req) => {
    const q = req.query as { scope?: string; projectId?: string };
    const scope = (['mine', 'all', 'watching'] as const).find((s) => s === q.scope) ?? 'mine';
    const projectId = q.projectId && UUID_RE.test(q.projectId) ? q.projectId : null;
    return getDecisionInbox(db, optionalUserId(req), scope as DecisionScope, projectId);
  });

  app.post('/api/v1/decisions/batch-approve', async (req) => {
    const { userId, actor } = actorFrom(req);
    const body = z
      .object({ ids: z.array(z.string().uuid()).min(1, '至少选一条'), note: z.string().optional() })
      .parse(req.body);
    const correlationId = corr(req);

    // 逐条走单条批准的同一个函数 —— 批量省的是点击，不是规则
    return batchApprove(body.ids, (id) =>
      approveDecisionById(id, userId, actor, { note: body.note, constraints: [] }, correlationId),
    );
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
   * ★ 判定本身在 @apos/domain，前后端共用一份 —— 界面上灰掉的按钮
   *   和服务端真正拦住的请求必须是同一条规则。这一页管的是
   *   「谁能给外部系统开写权限」，两边说法不一致的代价太高。
   */
  async function integrationActor(projectId: string, userId: string): Promise<Actor> {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) throw new ApiError('UNAUTHENTICATED', '用户不存在');

    const [membership] = await db
      .select()
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.actorType, 'human'),
          eq(projectMembers.actorId, userId),
        ),
      );

    return {
      projectRole: (membership?.role as Actor['projectRole']) ?? null,
      orgRole: (user.orgRole as Actor['orgRole']) ?? 'member',
    };
  }

  async function assertIntegration(
    projectId: string,
    userId: string,
    action: Parameters<typeof canIntegration>[1],
  ) {
    const actor = await integrationActor(projectId, userId);
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
      ? await integrationActor(id, userId)
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

    await assertIntegration(id, userId, 'connect');
    /**
     * ★ 写权限是比「连上」高一个量级的授权，单独判一次。
     *   pm 能连 GitHub，但让它能改代码需要 tech_lead。
     */
    if (body.grantWrite) await assertIntegration(id, userId, 'grant_write');

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
    await assertIntegration(projectId, userId, 'change_sot');

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
    await assertIntegration(projectId, userId, 'view');
    return ingestCiResults(db, deps.integrations, id);
  });

  app.post('/api/v1/integrations/:id/sync', async (req) => {
    const { id } = req.params as { id: string };
    const { userId } = actorFrom(req);
    const projectId = await projectOfIntegration(id);
    await assertIntegration(projectId, userId, 'view');

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
    await assertIntegration(conflict.projectId, userId, 'resolve_conflict');

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
    await assertIntegration(projectId, userId, 'connect');

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
    await assertIntegration(projectId, userId, 'disconnect');

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
    await assertIntegration(projectId, userId, 'configure_notification');

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
      { acknowledgeMismatches: body.acknowledgeMismatches },
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
      { policyId, acknowledgeMismatches: body.acknowledgeMismatches },
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

    return { item, runs, artifacts: arts, timeline: timeline.map(serializeEvent) };
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

  app.patch('/api/v1/work-items/:id/status', async (req) => {
    const { actor } = actorFrom(req);
    const { id } = req.params as { id: string };
    const body = StatusChange.parse(req.body);

    const [current] = await db.select().from(workItems).where(eq(workItems.id, id));
    if (!current) throw notFound('任务');

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

    const result = await dispatchRun(db, deps.registry, {
      workItemId: id,
      agentId,
      correlationId: corr(req),
      additionalContext: body.additionalContext,
    });

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
    if (!deps.registry.has(agent.runtimeId)) {
      throw new ApiError('AGENT_UNAVAILABLE', '该 Run 的运行时未注册，无法控制', {
        runtimeId: agent.runtimeId,
      });
    }

    const adapter = deps.registry.get(agent.runtimeId);
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
    return scheduleRound(db, deps.registry, { projectId: id, correlationId: corr(req) });
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
        await ingestRunEvent(db, { runId: id, event: event as never, correlationId: corr(req) }),
      );
    }
    return { accepted: results.length, results };
  });

  // ── SSE ─────────────────────────────────────────────────────────────
  app.get('/api/v1/stream', async (req, reply) => {
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
