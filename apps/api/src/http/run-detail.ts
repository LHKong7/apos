import { and, asc, desc, eq, gt, gte, inArray, lte, or, sql } from 'drizzle-orm';
import {
  agentRuns,
  agents,
  artifacts,
  decisions,
  events,
  projects,
  runEvents,
  users,
  workItems,
  type Database,
} from '@apos/db';
import type { AgentPermissions } from '@apos/contracts';
import { notFound } from './errors';
import { serializeEvent } from './serialize';

/**
 * 简明 / 详细（页面文档 09 §5.3）。
 *
 * ★ 两者的差别是**每条事件的深度**，不是**返回哪些事件**。
 *
 *   一度用 run_events.level 来分（简明只回 milestone），结果简明模式
 *   只剩三行「启动 / 产出 / 结束」—— 中间做了什么全没了，
 *   而「它做了什么」恰恰是这一页存在的理由。
 *   level 那个字段是给 SSE 降级和低成本扫表用的，不是给这里用的。
 *
 *   简明模式返回全部事件但不带 payload：省掉的正是体积的大头
 *   （推理全文、工具原始参数、上下文明细），也正是页面文档要求隐藏的东西。
 */
export type EventLevel = 'brief' | 'detailed';

/**
 * Run 详情（页面文档 09 §9）。
 *
 * 一次查全，不让前端分五次请求 —— 这是排障页面，
 * 打开慢一秒都会让人退回去用日志。
 */
export async function getRunDetail(db: Database, runId: string) {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  if (!run) throw notFound('Run');

  const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId));
  const [item] = await db.select().from(workItems).where(eq(workItems.id, run.workItemId));
  const [project] = await db.select().from(projects).where(eq(projects.id, run.projectId));

  const runEventRows = await db
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(asc(runEvents.seq));

  const artifactRows = await db.select().from(artifacts).where(eq(artifacts.runId, runId));

  const decisionRows = await db.select().from(decisions).where(eq(decisions.runId, runId));

  const siblings = await db
    .select({
      id: agentRuns.id,
      attempt: agentRuns.attempt,
      status: agentRuns.status,
      cost: agentRuns.cost,
      errorClass: agentRuns.errorClass,
    })
    .from(agentRuns)
    .where(eq(agentRuns.workItemId, run.workItemId))
    .orderBy(asc(agentRuns.attempt));

  const interventions = await loadInterventions(db, run);
  const policyHits = await loadPolicyHits(db, run);

  const toolCalls = countToolCalls(runEventRows);
  const startedAt = run.startedAt ?? run.createdAt;
  const endedAt = run.endedAt;

  return {
    run: {
      id: run.id,
      status: run.status,
      attempt: run.attempt,
      idempotencyKey: run.idempotencyKey,
      stepCurrent: run.stepCurrent,
      stepTotal: run.stepTotal,
      stepDescription: run.stepDescription,
      progressNote: run.progressNote,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt?.toISOString() ?? null,
      lastHeartbeatAt: run.lastHeartbeatAt?.toISOString() ?? null,
      timeoutAt: run.timeoutAt?.toISOString() ?? null,
    },
    agent: agent
      ? {
          id: agent.id,
          name: agent.name,
          type: agent.type,
          model: run.model ?? agent.model,
          runtimeRef: agent.runtimeRef,
          costLimitPerRun: agent.costLimitPerRun,
        }
      : null,
    workItem: item
      ? { id: item.id, title: item.title, status: item.status, estimatedCost: item.estimatedCost }
      : null,
    project: project ? { id: project.id, name: project.name } : null,

    /**
     * 输入区（页面文档 09 §5.4）。
     *
     * 上下文清单是排障的关键：很多失败的根因是「该给的没给」，
     * 把每一项列出来，缺什么一眼看得出。
     */
    input: {
      goal: run.goal,
      context: run.inputContext,
      model: run.model,
      modelConfig: run.modelConfig,
      tools: run.toolsSnapshot,
      /** ★ 派发时的权限快照。权限可能在 Run 之后被改，回溯必须看当时的 */
      permissions: run.permissionSnapshot as AgentPermissions | null,
    },

    metrics: {
      tokens: {
        input: run.tokensInput,
        output: run.tokensOutput,
        cacheRead: run.tokensCacheRead,
        total: run.tokensInput + run.tokensOutput + run.tokensCacheRead,
        // 缓存命中率直接决定成本，值得单独暴露
        cacheHitRate:
          run.tokensInput + run.tokensCacheRead > 0
            ? run.tokensCacheRead / (run.tokensInput + run.tokensCacheRead)
            : 0,
      },
      cost: run.cost,
      estimatedCost: item?.estimatedCost ?? null,
      costLimit: agent?.costLimitPerRun ?? null,
      durationMs: (endedAt ?? new Date()).getTime() - startedAt.getTime(),
      toolCalls,
      eventCount: runEventRows.length,
    },

    artifacts: artifactRows.map((a) => ({
      id: a.id,
      kind: a.kind,
      title: a.title,
      storage: a.storage,
      externalUrl: a.externalUrl,
      content: a.content,
      metadata: a.metadata,
      createdAt: a.createdAt.toISOString(),
    })),

    interventions,

    error: run.errorClass
      ? {
          class: run.errorClass,
          message: run.errorMessage,
          detail: run.errorDetail,
          selfReport: run.agentSelfReport,
          failedAt: failurePoint(runEventRows),
        }
      : null,

    related: {
      previousRun: siblings.find((s) => s.id === run.previousRunId) ?? null,
      attempts: siblings,
      decisions: decisionRows.map((d) => ({
        id: d.id,
        title: d.title,
        status: d.status,
        type: d.type,
      })),
      policies: policyHits,
    },
  };
}

export interface EventPage {
  events: {
    seq: number;
    ts: string;
    type: string;
    level: string;
    summary: string;
    payload: Record<string, unknown> | null;
    costDelta: string | null;
  }[];
  level: EventLevel;
  nextCursor: number | null;
  hasMore: boolean;
}

/**
 * 事件分页。
 *
 * 一次 Run 可能上千条事件，全量返回会让页面卡在解析 JSON 上；
 * after 游标同时用于执行中 Run 的增量追加。
 */
export async function getRunEvents(
  db: Database,
  runId: string,
  opts: { level?: EventLevel; after?: number; limit?: number } = {},
): Promise<EventPage> {
  const level: EventLevel = opts.level === 'detailed' ? 'detailed' : 'brief';
  const limit = Math.min(opts.limit ?? 200, 500);

  const conditions = [eq(runEvents.runId, runId)];
  if (typeof opts.after === 'number') conditions.push(gt(runEvents.seq, opts.after));

  const rows = await db
    .select()
    .from(runEvents)
    .where(and(...conditions))
    .orderBy(asc(runEvents.seq))
    .limit(limit + 1);

  const page = rows.slice(0, limit);

  return {
    events: page.map((r) => ({
      seq: r.seq,
      ts: r.ts.toISOString(),
      type: r.type,
      level: r.level,
      summary: r.summary,
      // 简明模式不回 payload：体积的大头在这里，隐藏它也正是页面文档的要求
      payload: level === 'detailed' ? r.payload : null,
      costDelta: r.costDelta,
    })),
    level,
    nextCursor: page.at(-1)?.seq ?? null,
    hasMore: rows.length > limit,
  };
}

export interface CostStep {
  step: number | null;
  description: string;
  costUsd: number;
  eventCount: number;
}

/**
 * 按步骤的成本分布（页面文档 09 §5.6）。
 *
 * 回答的是「哪一步烧钱」。没有这个视图，成本超支只能看到一个总数，
 * 而超支最常见的原因（上下文太大、某个工具反复重试）恰好都是分步骤才看得出来的。
 */
export async function getCostBreakdown(db: Database, runId: string): Promise<CostStep[]> {
  const rows = await db
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(asc(runEvents.seq));

  const steps = new Map<string, CostStep>();
  let current: { step: number | null; description: string } = { step: null, description: '启动与上下文加载' };

  for (const row of rows) {
    if (row.type === 'progress') {
      const payload = row.payload ?? {};
      current = {
        step: typeof payload['step'] === 'number' ? payload['step'] : null,
        description: typeof payload['description'] === 'string' ? payload['description'] : row.summary,
      };
    }

    const key = `${current.step ?? 'pre'}`;
    const entry = steps.get(key) ?? { ...current, costUsd: 0, eventCount: 0 };
    entry.costUsd += Number(row.costDelta ?? 0);
    entry.eventCount += 1;
    steps.set(key, entry);
  }

  return [...steps.values()].map((s) => ({ ...s, costUsd: Math.round(s.costUsd * 1e6) / 1e6 }));
}

// ── 内部 ──────────────────────────────────────────────────────────────

type RunRow = typeof agentRuns.$inferSelect;
type RunEventRow = typeof runEvents.$inferSelect;

function countToolCalls(rows: RunEventRow[]) {
  const byTool = new Map<string, number>();
  for (const row of rows) {
    if (row.type !== 'tool_call') continue;
    const tool = String(row.payload?.['tool'] ?? '未知');
    byTool.set(tool, (byTool.get(tool) ?? 0) + 1);
  }
  return {
    total: [...byTool.values()].reduce((a, b) => a + b, 0),
    byTool: Object.fromEntries([...byTool.entries()].sort((a, b) => b[1] - a[1])),
  };
}

/** 失败发生在哪一步 —— 定位比「失败了」有用得多 */
function failurePoint(rows: RunEventRow[]): { step: number | null; total: number | null; at: string | null } {
  const errorAt = rows.findIndex((r) => r.type === 'error');
  if (errorAt === -1) return { step: null, total: null, at: null };

  for (let i = errorAt; i >= 0; i--) {
    const row = rows[i]!;
    if (row.type !== 'progress') continue;
    const payload = row.payload ?? {};
    return {
      step: typeof payload['step'] === 'number' ? payload['step'] : null,
      total: typeof payload['totalSteps'] === 'number' ? payload['totalSteps'] : null,
      at: rows[errorAt]!.ts.toISOString(),
    };
  }
  return { step: null, total: null, at: rows[errorAt]!.ts.toISOString() };
}

/**
 * 人类在这次 Run 期间做了什么。
 *
 * 按时间窗口而不是按 subject 取 —— 人类的干预可能落在 Work Item 上
 * （接管、附加约束、强制放行），只查 agent_run 会全部漏掉。
 */
async function loadInterventions(db: Database, run: RunRow) {
  const from = run.startedAt ?? run.createdAt;
  const to = run.endedAt ?? new Date();

  const rows = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.actorType, 'human'),
        or(eq(events.subjectId, run.id), eq(events.subjectId, run.workItemId)),
        gte(events.occurredAt, from),
        lte(events.occurredAt, to),
      ),
    )
    .orderBy(asc(events.id));

  if (rows.length === 0) return [];

  const actorIds = [...new Set(rows.map((r) => r.actorId).filter((id): id is string => Boolean(id)))];
  const userRows = actorIds.length
    ? await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, actorIds))
    : [];
  const nameOf = new Map(userRows.map((u) => [u.id, u.name]));

  return rows.map((r) => ({
    ...serializeEvent(r),
    actorName: r.actorId ? (nameOf.get(r.actorId) ?? '未知') : '未知',
  }));
}

/** Run 期间命中的 Policy —— 审计回溯要能回答「当时是哪条规则放行/拦下的」 */
async function loadPolicyHits(db: Database, run: RunRow) {
  const from = run.startedAt ?? run.createdAt;
  const to = run.endedAt ?? new Date();

  const rows = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.type, 'policy.evaluated'),
        eq(events.subjectId, run.workItemId),
        gte(events.occurredAt, from),
        lte(events.occurredAt, to),
      ),
    )
    .orderBy(desc(events.id))
    .limit(20);

  return rows
    .map((r) => {
      const payload = r.payload ?? {};
      return {
        eventId: String(r.id),
        policyId: (payload['matchedPolicyId'] as string | null) ?? null,
        policyName: (payload['matchedPolicyName'] as string | null) ?? null,
        action: payload['action'] ?? null,
        occurredAt: r.occurredAt.toISOString(),
      };
    })
    // 没命中任何规则的评估对排障没有信息量，滤掉
    .filter((p) => p.policyName !== null);
}

export { sql };
