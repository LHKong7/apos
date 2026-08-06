import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  agentRuntimes,
  agents,
  artifacts,
  projects,
  requirements,
  workItems,
  agentRuns,
  type Database,
} from '@apos/db';
import {
  ACTIVE_RUN_STATUSES,
  agentActor,
  SYSTEM_ACTOR,
  type AgentPermissions,
  type TaskDispatch,
} from '@apos/contracts';
import type { RuntimeRegistry } from '@apos/agent-runtimes';
import { emit } from '../event/emitter';
import { transition } from '../flow/transition';
import { ingestRunEvent } from './ingest';

export interface DispatchInput {
  workItemId: string;
  agentId: string;
  correlationId: string;
  /** 重试时补充的上下文 */
  additionalContext?: { title: string; content: string }[];
  /** 调用方自带的幂等键；不传时按 (workItemId, attempt) 生成 */
  idempotencyKey?: string;
}

export type DispatchResult =
  | { ok: true; runId: string; attempt: number; reused: boolean }
  | { ok: false; code: 'AGENT_UNAVAILABLE' | 'TRANSITION_REJECTED'; detail: unknown };

/**
 * 派发一次 Agent 执行。
 *
 * 三个关键点：
 * 1. idempotencyKey 防重复派发 —— 网络重试导致 Agent 重复改代码是真实风险
 * 2. dispatching 中间态 —— 区分「还没派发」与「派发了但不知道结果」
 * 3. 权限与工具集在派发时快照，Run 期间的配置变更不影响正在跑的执行
 */
export async function dispatchRun(
  db: Database,
  registry: RuntimeRegistry,
  input: DispatchInput,
): Promise<DispatchResult> {
  const [item] = await db.select().from(workItems).where(eq(workItems.id, input.workItemId));
  if (!item) return { ok: false, code: 'AGENT_UNAVAILABLE', detail: 'work item not found' };

  const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId));
  if (!agent || agent.status !== 'active') {
    return { ok: false, code: 'AGENT_UNAVAILABLE', detail: { agentId: input.agentId } };
  }

  const [runtime] = await db
    .select()
    .from(agentRuntimes)
    .where(eq(agentRuntimes.id, agent.runtimeId));
  if (!runtime || !registry.has(runtime.id)) {
    return { ok: false, code: 'AGENT_UNAVAILABLE', detail: { runtimeId: agent.runtimeId } };
  }

  const priorRuns = await db
    .select({ id: agentRuns.id, attempt: agentRuns.attempt, status: agentRuns.status })
    .from(agentRuns)
    .where(eq(agentRuns.workItemId, item.id));

  /**
   * ★ 核心不变式：一个 Work Item 同时只能有一个活跃 Run。
   *
   * 没有这条保护，调度器重入或回调重复投递会让两个 Agent 同时改同一份代码。
   * 这比基于 idempotencyKey 的去重更可靠 —— 后者依赖调用方生成正确的 key。
   */
  const active = priorRuns.find((r) =>
    (ACTIVE_RUN_STATUSES as readonly string[]).includes(r.status),
  );
  if (active) {
    return { ok: true, runId: active.id, attempt: active.attempt, reused: true };
  }

  const attempt = priorRuns.length + 1;
  const idempotencyKey = input.idempotencyKey ?? `${item.id}:${attempt}`;

  const permissionSnapshot: AgentPermissions = {
    allowedTools: agent.allowedTools,
    deniedTools: agent.deniedTools,
    resourceScopes: agent.resourceScopes,
  };

  const context = await buildRunContext(db, item, input.additionalContext);

  // 派发给某个 Agent 就意味着它是执行主体 —— 让 dispatchRun 自洽，
  // 无论是调度器调用还是手动「用这个 Agent 重试」都行为一致
  if (item.executorType !== 'agent' || item.executorId !== agent.id) {
    await db
      .update(workItems)
      .set({ executorType: 'agent', executorId: agent.id })
      .where(eq(workItems.id, item.id));
    item.executorType = 'agent';
    item.executorId = agent.id;
  }

  const runId = randomUUID();
  await db.insert(agentRuns).values({
    id: runId,
    orgId: item.orgId,
    projectId: item.projectId,
    workItemId: item.id,
    agentId: agent.id,
    attempt,
    previousRunId: priorRuns.at(-1)?.id ?? null,
    status: 'dispatching',
    idempotencyKey,
    goal: item.title,
    inputContext: context,
    model: agent.model,
    toolsSnapshot: agent.allowedTools,
    permissionSnapshot,
    timeoutAt: new Date(Date.now() + agent.timeoutSeconds * 1000),
  });

  await db.transaction(async (tx) => {
    await emit(tx, {
      type: 'agent_run.dispatched',
      orgId: item.orgId,
      projectId: item.projectId,
      actor: SYSTEM_ACTOR,
      subjectType: 'agent_run',
      subjectId: runId,
      payload: {
        workItemId: item.id,
        agentId: agent.id,
        attempt,
        idempotencyKey,
        contextSize: context.length,
      },
      correlationId: input.correlationId,
    });
  });

  // 状态流转：ready → executing。被 Guard 或 Policy 拦下时不真正派发。
  const moved = await transition(db, {
    workItemId: item.id,
    trigger: 'run_dispatched',
    actor: agentActor(agent.id),
    correlationId: input.correlationId,
  });

  if (!moved.ok) {
    await db
      .update(agentRuns)
      .set({ status: 'terminated', errorClass: 'invalid_task', errorMessage: '状态流转被拒绝' })
      .where(eq(agentRuns.id, runId));
    return { ok: false, code: 'TRANSITION_REJECTED', detail: moved };
  }

  // Policy 可能把任务改道到 awaiting_decision —— 那就不该真的启动 Agent
  if (moved.to !== 'executing') {
    await db
      .update(agentRuns)
      .set({ status: 'queued', errorMessage: null })
      .where(eq(agentRuns.id, runId));
    return { ok: true, runId, attempt, reused: false };
  }

  const adapter = registry.get(runtime.id);
  const task: TaskDispatch = {
    runId,
    idempotencyKey,
    goal: {
      title: item.title,
      description: item.description ?? '',
      acceptanceCriteria: item.acceptanceCriteria.map((c) => ({ id: c.id, text: c.text })),
      constraints: item.constraints.map((c) => ({
        type: c.type,
        value: c.value,
        description: c.description,
      })),
    },
    context,
    permissions: permissionSnapshot,
    limits: {
      maxCostUsd: Number(agent.costLimitPerRun ?? 20),
      maxDurationSeconds: agent.timeoutSeconds,
      maxTokens: null,
    },
    model: agent.model,
    callback: { eventsUrl: `/api/v1/agent-callback/runs/${runId}/events`, token: runId },
  };

  const ack = await adapter.dispatch(task);
  if (!ack.accepted) {
    await db
      .update(agentRuns)
      .set({
        status: 'failed',
        errorClass: 'runtime_error',
        errorMessage: ack.rejectReason ?? '运行时拒绝任务',
      })
      .where(eq(agentRuns.id, runId));
    return { ok: false, code: 'AGENT_UNAVAILABLE', detail: ack };
  }

  await db
    .update(agentRuns)
    .set({ status: 'running', startedAt: new Date(), lastHeartbeatAt: new Date() })
    .where(eq(agentRuns.id, runId));

  await adapter.subscribe(runId, async (event) => {
    await ingestRunEvent(db, { runId, event, correlationId: input.correlationId });
  });

  return { ok: true, runId, attempt, reused: false };
}

/** 构建 Agent 上下文。外部来源的内容标记 trusted=false，防提示注入。 */
async function buildRunContext(
  db: Database,
  item: typeof workItems.$inferSelect,
  additional: DispatchInput['additionalContext'],
): Promise<TaskDispatch['context']> {
  const ctx: TaskDispatch['context'] = [];

  if (item.requirementId) {
    const [req] = await db
      .select()
      .from(requirements)
      .where(eq(requirements.id, item.requirementId));
    if (req) {
      ctx.push({
        kind: 'requirement',
        ref: req.id,
        title: req.title ?? '需求说明',
        content: [req.businessContext, req.businessGoal].filter(Boolean).join('\n\n'),
        priority: 'must_read',
        trusted: true,
      });
      // 原始输入可能来自外部系统，按不可信处理
      ctx.push({
        kind: 'requirement',
        ref: `${req.id}:raw`,
        title: '原始需求描述',
        content: req.rawInput,
        priority: 'reference',
        trusted: req.inputMethod === 'manual' || req.inputMethod === 'conversation',
      });
    }
  }

  // 上一次失败的 Run：把失败原因带上，这是「补充上下文重试」的核心
  const failed = await db
    .select({
      id: agentRuns.id,
      errorClass: agentRuns.errorClass,
      errorMessage: agentRuns.errorMessage,
      selfReport: agentRuns.agentSelfReport,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.workItemId, item.id), inArray(agentRuns.status, ['failed', 'timeout'])));

  for (const run of failed) {
    ctx.push({
      kind: 'previous_run',
      ref: run.id,
      title: `上次失败（${run.errorClass}）`,
      content: [run.errorMessage, run.selfReport].filter(Boolean).join('\n'),
      priority: 'must_read',
      trusted: true,
    });
  }

  for (const extra of additional ?? []) {
    ctx.push({
      kind: 'knowledge',
      ref: randomUUID(),
      title: extra.title,
      content: extra.content,
      priority: 'must_read',
      trusted: true,
    });
  }

  return ctx;
}

export { artifacts, projects };
