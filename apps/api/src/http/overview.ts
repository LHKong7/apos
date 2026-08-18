import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  agentRuns,
  agents,
  decisions,
  events,
  plans,
  projectMembers,
  projects,
  users,
  workItems,
  type Database,
} from '@apos/db';
import { ACTIVE_RUN_STATUSES } from '@apos/contracts';
import {
  computeAgents,
  computeFlow,
  computeHealth,
  computeProgress,
  predictDelay,
  windowFor,
  type AnalyticsInput,
} from '@apos/domain';
import { notFound } from './errors';
import { loadAnalyticsInput } from './analytics';
import { serializeEvent } from './serialize';
import { getProjectDiagnostics } from './graph';

/**
 * 项目总览（页面文档 02）。
 *
 * ★ 「本页不是数据大屏。每个指标旁都必须有下一步动作，否则不放。」
 *   所以这里返回的每一块都自带一个可跳转的落点：
 *   待处理项带 decisionId、阻塞项带 workItemId、Agent 卡带 agentId。
 *   一个只能看不能点的数字，在这一页上没有位置。
 */
export async function getOverview(db: Database, projectId: string, userId: string | null) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw notFound('项目');

  const now = Date.now();
  const items = await db
    .select()
    .from(workItems)
    .where(and(eq(workItems.projectId, projectId), isNull(workItems.deletedAt)));

  const pending = await db
    .select()
    .from(decisions)
    .where(and(eq(decisions.projectId, projectId), eq(decisions.status, 'pending')))
    .orderBy(decisions.dueAt);

  const userRows = await db.select().from(users);
  const userName = new Map(userRows.map((u) => [u.id, u.name]));

  // ── 指标：复用 Analytics 的口径，不另起一套 ──
  // 同一个「流动效率」在两页给出不同数字，用户会不知道该信哪个
  const window = windowFor('30d', now);
  const input: AnalyticsInput = await loadAnalyticsInput(db, project, window, now);
  const flow = computeFlow(input, now);
  const agentMetrics = computeAgents(input);

  const runs = agentMetrics.agents.reduce((s, a) => s + a.runs, 0);
  const agentSuccessRate =
    runs === 0 ? null : agentMetrics.agents.reduce((s, a) => s + a.successRate * a.runs, 0) / runs;

  const done = items.filter((i) => i.status === 'done').length;
  const blocked = items.filter((i) => i.blockedSince !== null || i.status === 'blocked');
  const overdueDecisions = pending.filter((d) => d.dueAt && d.dueAt.getTime() < now).length;

  const health = computeHealth({
    flow,
    hitl: { ...EMPTY_HITL },
    agentSuccessRate,
    totalTasks: items.length,
    doneTasks: done,
    blockedTasks: blocked.length,
    overdueDecisions,
    tokensSpent: project.tokensSpent,
    tokenBudget: project.tokenBudget,
  });

  const delay = predictDelay({
    flow,
    agentSuccessRate,
    remainingTasks: items.filter((i) => i.status !== 'done' && i.status !== 'cancelled').length,
    blockedTasks: blocked.length,
    overdueDecisions,
    plannedEnd: project.endsAt ? new Date(project.endsAt).getTime() : null,
    now,
  });

  // ── 需要你处理 ──
  // 只列真正等着这个人的，不把全项目的待办堆给他看
  const mine = userId ? pending.filter((d) => d.assigneeId === userId || d.assigneeId === null) : [];
  const [awaitingPlan] = await db
    .select()
    .from(plans)
    .where(and(eq(plans.projectId, projectId), eq(plans.status, 'awaiting_approval')))
    .orderBy(desc(plans.version))
    .limit(1);

  // ── Agent 团队 ──
  const agentIds = [...new Set(input.runs.map((r) => r.agentId))];
  const agentRows =
    agentIds.length > 0
      ? await db.select().from(agents).where(inArray(agents.id, agentIds))
      : [];
  const active = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.projectId, projectId),
        inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
      ),
    );
  const perfById = new Map(agentMetrics.agents.map((a) => [a.agentId, a]));
  const itemTitle = new Map(items.map((i) => [i.id, i.title]));

  // ── 人类成员 ──
  const memberRows = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.actorType, 'human')));

  /**
   * ── 问题诊断 ──
   *
   * ★★ 「延期主因是决策等了 5.6 天」这类归因此前只在执行图那一页 ——
   *   而它恰恰是「负责人该去解决什么」的浓缩，理应出现在他每天先看的这一页
   *   （问题记录 #38 / #40）。与执行图共用同一套 domain 判定，跳过布局。
   */
  const { metrics: graphMetrics, diagnostics } = await getProjectDiagnostics(db, projectId);

  // ── 最近活动 ──
  const recent = await db
    .select()
    .from(events)
    .where(and(eq(events.projectId, projectId), eq(events.level, 'milestone')))
    .orderBy(desc(events.id))
    .limit(12);

  return {
    project: {
      id: project.id,
      name: project.name,
      goal: project.goal,
      status: project.status,
      autonomyLevel: project.autonomyLevel,
      pausedReason: project.pausedReason,
    },
    health,
    progress: computeProgress(done, items.length),
    delay,
    tokens: {
      spent: project.tokensSpent,
      budget: project.tokenBudget,
    },
    decisions: {
      pending: pending.length,
      overdue: overdueDecisions,
      /**
       * ★ 没指派责任人的决策要单独报出来。
       *   把它们摊进成员列表里，每个人都显示 0，看起来像「没人有待办」——
       *   而真相是「有 5 件事没人认领」。无主的决策正是最容易烂在队列里的那批。
       */
      unassigned: pending.filter((d) => d.assigneeId === null).length,
    },

    /** ★ 每一条都能直接点进去处理，这一区的存在意义就是这个 */
    actionItems: [
      ...(awaitingPlan
        ? [
            {
              kind: 'plan' as const,
              id: awaitingPlan.id,
              title: `执行计划 v${awaitingPlan.version} 待批准`,
              riskLevel: 'medium',
              overdueMinutes: null as number | null,
              dueInMinutes: null as number | null,
            },
          ]
        : []),
      ...mine.map((d) => ({
        kind: 'decision' as const,
        id: d.id,
        title: d.title,
        riskLevel: d.riskLevel as string,
        overdueMinutes:
          d.dueAt && d.dueAt.getTime() < now
            ? Math.round((now - d.dueAt.getTime()) / 60_000)
            : null,
        dueInMinutes:
          d.dueAt && d.dueAt.getTime() >= now
            ? Math.round((d.dueAt.getTime() - now) / 60_000)
            : null,
      })),
    ],

    blocked: blocked.slice(0, 6).map((i) => ({
      id: i.id,
      title: i.title,
      reason: i.blockedReason,
      detail: i.blockedDetail ?? null,
      minutes: i.blockedSince ? Math.round((now - i.blockedSince.getTime()) / 60_000) : null,
      ownerName: i.ownerId ? (userName.get(i.ownerId) ?? '未知') : null,
      humanGateRef: i.humanGateRef,
    })),

    agents: agentRows.map((a) => {
      const running = active.find((r) => r.agentId === a.id);
      const perf = perfById.get(a.id);
      return {
        id: a.id,
        name: a.name,
        type: a.type,
        status: running ? 'running' : a.status === 'paused' ? 'paused' : 'idle',
        currentTask:
          running && running.workItemId ? (itemTitle.get(running.workItemId) ?? null) : null,
        currentRunId: running?.id ?? null,
        successRate: perf?.successRate ?? null,
        runs: perf?.runs ?? 0,
        tokens: perf?.totalTokens ?? 0,
      };
    }),

    members: memberRows.map((m) => ({
      id: m.actorId,
      name: userName.get(m.actorId) ?? '未知',
      role: m.role,
      pendingDecisions: pending.filter((d) => d.assigneeId === m.actorId).length,
      overdueDecisions: pending.filter(
        (d) => d.assigneeId === m.actorId && d.dueAt && d.dueAt.getTime() < now,
      ).length,
    })),

    /** 近 7 日完成与阻塞，给的是趋势不是精确值 */
    trend: {
      wip: flow.wipTrend.slice(-7),
      blocked: flow.blockedTrend.slice(-7),
    },

    /**
     * ★ 只给前三条 —— 总览是指挥台不是问题清单。
     *   看全的入口是执行图，那里每条都带着可执行按钮。
     */
    diagnostics: diagnostics.slice(0, 3),
    delayCause: graphMetrics.primaryCause,

    recentActivity: recent.map(serializeEvent),
  };
}

const EMPTY_HITL = {
  totalDecisions: 0,
  resolved: 0,
  resolutionTime: { median: 0, mean: 0, count: 0, maxValue: 0, maxItemId: null },
  overdue: 0,
  automationRate: null,
  autoPassed: 0,
  policyEvaluations: 0,
  overrides: 0,
  blockedByHumanHours: 0,
  byStage: [],
  responseBuckets: [],
  repeated: [],
  overrideReasons: [],
};
