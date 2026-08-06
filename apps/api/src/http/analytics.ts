import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import {
  agentRuns,
  agents,
  decisions,
  events,
  projects,
  workItems,
  type Database,
} from '@apos/db';
import { STATUS_STAGE, type Stage, type WorkItemStatus } from '@apos/contracts';
import {
  computeAnalytics,
  previousWindow,
  windowFor,
  type AnalyticsInput,
  type AnalyticsRange,
  type OverrideRow,
  type PolicyEvalRow,
  type StatusChange,
  type Window,
} from '@apos/domain';
import { notFound } from './errors';

/**
 * 项目 Analytics（页面文档 12 §9）。
 *
 * ★ 一个接口返回四个 Tab，而不是文档里列的五个接口。
 *   原因是「系统发现」需要跨 Tab 的事实（「决策等待占总周期 34%」
 *   同时要 flow 和 hitl），而四个 Tab 读的是同一批原始行。
 *   拆成五个接口 = 把同一段事件流拉五遍，还拼不出发现。
 *
 * ★ 也没有做文档 §9 提的预聚合表。项目级的窗口内事件量在几千条量级，
 *   实时算完的代价远低于维护一套聚合管道 + 处理它的延迟和回补。
 *   代价是数据量真的涨上来时要回头做 —— 那时再做，而不是现在假装做了。
 */
export async function getAnalytics(
  db: Database,
  projectId: string,
  range: AnalyticsRange,
  compare: boolean,
  now = Date.now(),
) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw notFound('项目');

  const window = windowFor(range, now);
  const prevWindow = previousWindow(window);
  // 上一周期也要算，所以原始数据要拉到更早
  const since = compare ? prevWindow.from : window.from;

  const items = await db
    .select()
    .from(workItems)
    .where(and(eq(workItems.projectId, projectId), isNull(workItems.deletedAt)));

  const itemRows = items.map((i) => ({
    id: i.id,
    title: i.title,
    type: i.type as string,
    status: i.status as WorkItemStatus,
    riskLevel: i.riskLevel as string,
    createdAt: i.createdAt.getTime(),
    actualStart: i.actualStart?.getTime() ?? null,
    actualEnd: i.actualEnd?.getTime() ?? null,
    plannedEnd: i.plannedEnd?.getTime() ?? null,
    actualCost: Number(i.actualCost),
    blockedSince: i.blockedSince?.getTime() ?? null,
    ownerId: i.ownerId,
    executorType: i.executorType,
    executorId: i.executorId,
  }));

  const runRows = (
    await db.select().from(agentRuns).where(eq(agentRuns.projectId, projectId))
  ).map((r) => ({
    id: r.id,
    workItemId: r.workItemId,
    agentId: r.agentId,
    attempt: r.attempt,
    status: r.status as string,
    cost: Number(r.cost),
    startedAt: r.startedAt?.getTime() ?? null,
    endedAt: r.endedAt?.getTime() ?? null,
    createdAt: r.createdAt.getTime(),
    errorClass: r.errorClass,
    model: r.model,
  }));

  const stageOf = new Map(itemRows.map((i) => [i.id, STATUS_STAGE[i.status]]));
  const decisionRows = (
    await db.select().from(decisions).where(eq(decisions.projectId, projectId))
  ).map((d) => ({
    id: d.id,
    type: d.type,
    title: d.title,
    status: d.status as string,
    riskLevel: d.riskLevel as string,
    createdAt: d.createdAt.getTime(),
    resolvedAt: d.resolvedAt?.getTime() ?? null,
    dueAt: d.dueAt?.getTime() ?? null,
    workItemId: d.workItemId,
    stage: (d.workItemId ? (stageOf.get(d.workItemId) ?? null) : null) as Stage | null,
  }));

  const agentIds = [...new Set(runRows.map((r) => r.agentId))];
  const agentRows =
    agentIds.length > 0
      ? (await db.select().from(agents).where(inArray(agents.id, agentIds))).map((a) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          model: a.model,
        }))
      : [];

  const { changes, overrides, policyEvals } = await loadEventDerived(db, projectId, since);

  const build = (w: Window): AnalyticsInput => ({
    window: w,
    items: itemRows,
    changes,
    runs: runRows,
    decisions: decisionRows,
    agents: agentRows,
    overrides,
    policyEvals,
    budget: project.budgetAmount === null ? null : Number(project.budgetAmount),
    costSpentTotal: Number(project.costSpent),
  });

  return {
    project: { id: project.id, name: project.name },
    ...computeAnalytics(range, build(window), compare ? build(prevWindow) : null, now),
    generatedAt: new Date(now).toISOString(),
  };
}

/**
 * 从事件流里取三样东西。
 *
 * 事件表只允许 INSERT，是唯一不会被后续状态覆盖的历史 ——
 * work_items 上的 `status` 只告诉你「现在在哪」，
 * 而所有时间类指标问的都是「路上花了多久」，只有事件能回答。
 */
async function loadEventDerived(db: Database, projectId: string, since: number) {
  const rows = await db
    .select({
      type: events.type,
      subjectId: events.subjectId,
      payload: events.payload,
      actorType: events.actorType,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .where(
      and(
        eq(events.projectId, projectId),
        inArray(events.type, ['work_item.status_changed', 'policy.evaluated']),
        gte(events.occurredAt, new Date(since)),
      ),
    )
    .orderBy(events.id);

  const changes: StatusChange[] = [];
  const overrides: OverrideRow[] = [];
  const policyEvals: PolicyEvalRow[] = [];

  for (const row of rows) {
    const at = row.occurredAt.getTime();
    const payload = row.payload as Record<string, unknown>;

    if (row.type === 'policy.evaluated') {
      const action = (payload.action as { type?: string } | null)?.type;
      if (action) policyEvals.push({ at, action, itemId: row.subjectId });
      continue;
    }

    changes.push({
      itemId: row.subjectId,
      from: (payload.from as WorkItemStatus | undefined) ?? null,
      to: payload.to as WorkItemStatus,
      at,
    });

    /**
     * 人工覆盖 = 人在看板上手动改了状态（payload.manual）。
     *
     * ★ 判据不能只看 actorType 是不是 human：批准决策、回答澄清也是人触发的，
     *   但那些是「人在回路」按设计工作，不是覆盖系统判断。
     *   这个指标衡量的是系统自动判断有多准，应该随时间下降 ——
     *   把正常的人类参与算进去，它就再也降不下来，也就不再是个指标了。
     */
    if (payload.manual === true && row.actorType === 'human') {
      overrides.push({
        itemId: row.subjectId,
        at,
        category: (payload.reasonCategory as string | undefined) ?? null,
        reason: (payload.reason as string | undefined) ?? null,
      });
    }
  }

  return { changes, overrides, policyEvals };
}

/**
 * 「返工的任务」「在制任务」这类下钻。
 *
 * 系统发现里的每个动作都要能落到具体任务上 —— 只能跳到一个筛选好的列表，
 * 才算真的把数据变成了行动。
 */
export async function getAnalyticsItems(
  db: Database,
  projectId: string,
  kind: 'rework' | 'wip' | 'slow',
  range: AnalyticsRange,
  now = Date.now(),
) {
  const window = windowFor(range, now);

  if (kind === 'wip') {
    const rows = await db
      .select()
      .from(workItems)
      .where(and(eq(workItems.projectId, projectId), isNull(workItems.deletedAt)));
    return {
      kind,
      items: rows
        .filter((i) => i.status !== 'draft' && i.status !== 'done' && i.status !== 'cancelled')
        .map(brief),
    };
  }

  if (kind === 'rework') {
    const reworkEvents = await db
      .select({ subjectId: events.subjectId })
      .from(events)
      .where(
        and(
          eq(events.projectId, projectId),
          eq(events.type, 'work_item.status_changed'),
          gte(events.occurredAt, new Date(window.from)),
          sql`${events.payload}->>'to' in ('changes_requested','failed')`,
        ),
      );
    const ids = [...new Set(reworkEvents.map((e) => e.subjectId))];
    if (ids.length === 0) return { kind, items: [] };
    const rows = await db.select().from(workItems).where(inArray(workItems.id, ids));
    return { kind, items: rows.map(brief) };
  }

  // slow：窗口内完成、耗时最长的几个 —— 「异常值单独标注可点击查看」（§11）
  const rows = await db
    .select()
    .from(workItems)
    .where(and(eq(workItems.projectId, projectId), isNull(workItems.deletedAt)));
  return {
    kind,
    items: rows
      .filter((i) => i.actualEnd !== null && i.actualEnd.getTime() >= window.from)
      .sort((a, b) => elapsed(b) - elapsed(a))
      .slice(0, 10)
      .map(brief),
  };
}

function elapsed(i: typeof workItems.$inferSelect): number {
  return (i.actualEnd?.getTime() ?? 0) - i.createdAt.getTime();
}

function brief(i: typeof workItems.$inferSelect) {
  return {
    id: i.id,
    title: i.title,
    status: i.status,
    stage: i.stage,
    riskLevel: i.riskLevel,
    ownerId: i.ownerId,
    elapsedHours: i.actualEnd ? Math.round(elapsed(i) / 36_000) / 100 : null,
  };
}
