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
  requirementClarifications,
  requirements,
  runEvents,
  users,
  workItems,
  type Database,
} from '@apos/db';
import { ACTIVE_RUN_STATUSES, humanActor, WorkItemStatus } from '@apos/contracts';
import {
  LAYOUTS,
  WORK_ITEM_MACHINE,
  availableTriggers,
  manualTriggerFor,
  type LayoutKind,
} from '@apos/domain';
import { UnsupportedFeatureError, type RuntimeRegistry } from '@apos/agent-runtimes';
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
import { ApiError, notFound, sendError } from './errors';
import { handleSse } from './sse';
import { getBoard } from './board';
import { getGraph } from './graph';
import { getCostBreakdown, getRunDetail, getRunEvents } from './run-detail';
import { serializeEvent } from './serialize';

export interface AppDeps {
  db: Database;
  bus: EventBus;
  registry: RuntimeRegistry;
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
    const [plan] = await db.select().from(plans).where(eq(plans.id, id));
    if (!plan) throw notFound('计划');

    const tasks = await db.select().from(workItems).where(eq(workItems.planId, id));
    return { plan, tasks };
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

  app.post('/api/v1/decisions/:id/approve', async (req) => {
    const { userId, actor } = actorFrom(req);
    const { id } = req.params as { id: string };
    const body = z
      .object({
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
      })
      .parse(req.body ?? {});

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
        correlationId: corr(req),
      });
      if (!result.ok) return mapTransitionError(result);
      return { ok: true, decisionId: id, workItem: toTransitionResponse(result) };
    }

    return { ok: true, decisionId: id };
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
