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
  /**
   * ★ 规划 Run 没有工作项 —— 这不是「工作项被删了」，是它本来就不该有。
   *   下面几处按工作项展开的关联（同批尝试、人工干预、Policy 命中）
   *   对它一律为空，而不是去查一个 id 为 null 的行。
   */
  const [item] = run.workItemId
    ? await db.select().from(workItems).where(eq(workItems.id, run.workItemId))
    : [];
  const [project] = await db.select().from(projects).where(eq(projects.id, run.projectId));

  const runEventRows = await db
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(asc(runEvents.seq));

  const artifactRows = await db.select().from(artifacts).where(eq(artifacts.runId, runId));

  const decisionRows = await db.select().from(decisions).where(eq(decisions.runId, runId));

  // ★ 「同一个工作项的历次尝试」对规划 Run 无意义，直接空列表
  const siblings = run.workItemId
    ? await db
        .select({
          id: agentRuns.id,
          attempt: agentRuns.attempt,
          status: agentRuns.status,
          tokensInput: agentRuns.tokensInput,
          tokensOutput: agentRuns.tokensOutput,
          tokensCacheRead: agentRuns.tokensCacheRead,
          tokensCacheWrite: agentRuns.tokensCacheWrite,
          errorClass: agentRuns.errorClass,
        })
        .from(agentRuns)
        .where(eq(agentRuns.workItemId, run.workItemId))
        .orderBy(asc(agentRuns.attempt))
    : [];

  /**
   * ★ 四类 token 在服务端就加好。丢四列给前端再加一遍，
   *   等于把「记账单位怎么定义」复制到了第二个地方 ——
   *   将来加一类 token，两处里必然有一处忘了改。
   */
  const attempts = siblings.map((s) => ({
    id: s.id,
    attempt: s.attempt,
    status: s.status,
    tokens: s.tokensInput + s.tokensOutput + s.tokensCacheRead + s.tokensCacheWrite,
    errorClass: s.errorClass,
  }));

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
          runtimeKind: agent.runtimeKind,
          tokenLimitPerRun: agent.tokenLimitPerRun,
        }
      : null,
    workItem: item
      ? { id: item.id, title: item.title, status: item.status, estimatedTokens: item.estimatedTokens }
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
        cacheWrite: run.tokensCacheWrite,
        total:
          run.tokensInput + run.tokensOutput + run.tokensCacheRead + run.tokensCacheWrite,
        // 缓存命中率直接决定用量，值得单独暴露
        cacheHitRate:
          run.tokensInput + run.tokensCacheRead > 0
            ? run.tokensCacheRead / (run.tokensInput + run.tokensCacheRead)
            : 0,
      },
      /** 运行时结算的美元值，界面标为参考值 —— 不参与任何判定 */
      costUsd: run.cost,
      estimatedTokens: item?.estimatedTokens ?? null,
      tokenLimit: agent?.tokenLimitPerRun ?? null,
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
      previousRun: attempts.find((s) => s.id === run.previousRunId) ?? null,
      attempts,
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
    tokensDelta: number | null;
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
      /** ★ 迁移之前的行是 NULL —— 那时没记，不是记了 0 */
      tokensDelta: r.tokensDelta,
    })),
    level,
    nextCursor: page.at(-1)?.seq ?? null,
    hasMore: rows.length > limit,
  };
}

export interface CostStep {
  step: number | null;
  description: string;
  tokens: number;
  eventCount: number;
}

/**
 * 按步骤的 token 分布（页面文档 09 §5.6）。
 *
 * 回答的是「哪一步烧配额」。没有这个视图，超支只能看到一个总数，
 * 而超支最常见的原因（上下文太大、某个工具反复重试）恰好都是分步骤才看得出来的。
 *
 * ★ 历史行的 tokens_delta 是 NULL（迁移之前没有这一列），按 0 计。
 *   这会让换单位之前的 Run 在这个视图上显示为全 0 —— 如实反映
 *   「那时候没记」，而不是拿美元换算出一个看起来有数的假分布。
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
    const entry = steps.get(key) ?? { ...current, tokens: 0, eventCount: 0 };
    entry.tokens += row.tokensDelta ?? 0;
    entry.eventCount += 1;
    steps.set(key, entry);
  }

  return [...steps.values()];
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
        // ★ 没有工作项时只按 Run 自己找，别拿 null 去比
        run.workItemId
          ? or(eq(events.subjectId, run.id), eq(events.subjectId, run.workItemId))
          : eq(events.subjectId, run.id),
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
  // ★ Policy 评估挂在工作项上；规划 Run 没有工作项，也就没有命中记录
  if (!run.workItemId) return [];
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
