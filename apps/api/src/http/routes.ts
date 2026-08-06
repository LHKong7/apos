import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import {
  agentRuns,
  artifacts,
  decisions,
  events,
  plans,
  projects,
  requirementClarifications,
  requirements,
  runEvents,
  workItems,
  type Database,
} from '@apos/db';
import { humanActor, WorkItemStatus } from '@apos/contracts';
import type { RuntimeRegistry } from '@apos/agent-runtimes';
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
import { ApiError, notFound, sendError } from './errors';
import { handleSse } from './sse';
import { getBoard } from './board';
import { serializeEvent } from './serialize';

export interface AppDeps {
  db: Database;
  bus: EventBus;
  registry: RuntimeRegistry;
  provider: PlanningProvider;
}

/** MVP 阶段的身份来源：请求头。真实认证见 docs/tech/09-security.md */
function actorFrom(req: { headers: Record<string, unknown> }) {
  const id = req.headers['x-user-id'];
  if (typeof id !== 'string') {
    throw new ApiError('UNAUTHENTICATED', '缺少 X-User-Id 头');
  }
  return { userId: id, actor: humanActor(id) };
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

    return getBoard(db, id, {
      onlyMine: q['onlyMine'] === 'true' ? (req.headers['x-user-id'] as string) : undefined,
      riskLevel: q['risk']?.split(','),
      executorType: q['executorType'],
      humanGateOnly: q['humanGate'] === 'true',
      blockedOnly: q['blocked'] === 'true',
    });
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

    const trigger = triggerFor(body.toStatus);
    if (!trigger) {
      throw new ApiError('INVALID_TRANSITION', `不支持手动切换到 ${body.toStatus}`);
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
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, id));
    if (!run) throw notFound('Run');

    const level = (req.query as { level?: string }).level ?? 'brief';
    const rows = await db
      .select()
      .from(runEvents)
      .where(
        level === 'detailed'
          ? eq(runEvents.runId, id)
          : and(eq(runEvents.runId, id), eq(runEvents.level, 'milestone')),
      )
      .orderBy(runEvents.seq);

    return { run, events: rows, level };
  });

  // ── 决策 ────────────────────────────────────────────────────────────
  app.get('/api/v1/decisions', async (req) => {
    const userId = req.headers['x-user-id'];
    const scope = (req.query as { scope?: string }).scope ?? 'mine';

    const rows = await db
      .select()
      .from(decisions)
      .where(
        scope === 'mine' && typeof userId === 'string'
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

    const lastEventId = req.headers['last-event-id'];
    return handleSse(req, reply, deps, {
      channels,
      lastEventId: typeof lastEventId === 'string' ? lastEventId : undefined,
    });
  });
}

/** 手动状态调整支持的目标状态 → trigger */
function triggerFor(status: string) {
  const map: Record<string, Parameters<typeof transition>[1]['trigger']> = {
    ready: 'retry_requested',
    executing: 'human_work_started',
    reviewing: 'human_work_completed',
    waiting_for_release: 'review_passed',
    changes_requested: 'review_rejected',
    releasing: 'release_started',
    acceptance: 'release_completed',
    done: 'accepted',
    cancelled: 'cancelled',
  };
  return map[status];
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
