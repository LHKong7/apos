import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  agentRuns,
  decisionOptions,
  decisions,
  projects,
  users,
  workItems,
  type Database,
} from '@apos/db';
import { decisionLabel } from '@apos/domain';
import { notFound } from './errors';

/**
 * 决策中心（页面文档 10）。
 *
 * ★ 这是产品核心承诺的兑现处：*你不需要盯着 Agent，需要你的时候我会来找你。*
 *   如果用户仍然感到「我不知道什么时候该介入」，这一页就失败了。
 *
 * ★ 设计目标是「5 分钟内清空当日队列」。这个目标决定了接口形状：
 *   一次返回决策卡片所需的全部信息（选项、影响、关联任务、Agent 建议），
 *   让用户在列表里就能拍板，不必逐条点进详情页 ——
 *   每多一次跳转，清空队列就多花一分钟。
 */

export type DecisionScope = 'mine' | 'all' | 'watching';

export async function getDecisionInbox(
  db: Database,
  userId: string | null,
  scope: DecisionScope,
  projectId: string | null,
  /**
   * ★ 调用者是成员的项目。收件箱按它收窄 ——
   *   少了这一条，收件箱会把所有项目（含别的组织）的待决策都端出来。
   *   传空数组表示「一个项目都看不到」，结果必须是空，
   *   不能退化成「不过滤」。
   */
  visibleProjectIds: string[],
) {
  const now = Date.now();

  if (visibleProjectIds.length === 0) {
    return emptyInbox();
  }

  const conditions = [
    eq(decisions.status, 'pending'),
    inArray(decisions.projectId, visibleProjectIds),
  ];
  if (projectId) conditions.push(eq(decisions.projectId, projectId));

  const rows = await db
    .select()
    .from(decisions)
    .where(and(...conditions))
    .orderBy(decisions.dueAt);

  /**
   * ★ 「我的」= 指名给我的 + 没指定责任人的。
   *   把未分派的决策藏起来，它们就会一直没人管 ——
   *   而「没人管」正是这一页要消灭的东西。
   */
  const mine = userId
    ? rows.filter((d) => d.assigneeId === userId || d.assigneeId === null)
    : [];
  const visible = scope === 'mine' ? mine : rows;

  const ids = visible.map((d) => d.id);
  const options =
    ids.length > 0
      ? await db.select().from(decisionOptions).where(inArray(decisionOptions.decisionId, ids))
      : [];

  const itemIds = visible.map((d) => d.workItemId).filter((x): x is string => x !== null);
  const items =
    itemIds.length > 0
      ? await db.select().from(workItems).where(inArray(workItems.id, itemIds))
      : [];
  const itemById = new Map(items.map((i) => [i.id, i]));

  const runIds = visible.map((d) => d.runId).filter((x): x is string => x !== null);
  const runs =
    runIds.length > 0
      ? await db.select().from(agentRuns).where(inArray(agentRuns.id, runIds))
      : [];
  const runById = new Map(runs.map((r) => [r.id, r]));

  const projectRows = await db.select({ id: projects.id, name: projects.name }).from(projects);
  const projectName = new Map(projectRows.map((p) => [p.id, p.name]));

  const userRows = await db.select({ id: users.id, name: users.name }).from(users);
  const userName = new Map(userRows.map((u) => [u.id, u.name]));

  const cards = visible.map((d) => {
    const opts = options
      .filter((o) => o.decisionId === d.id)
      .sort((a, b) => a.position - b.position);
    const item = d.workItemId ? itemById.get(d.workItemId) : undefined;
    const run = d.runId ? runById.get(d.runId) : undefined;

    return {
      id: d.id,
      projectId: d.projectId,
      projectName: projectName.get(d.projectId) ?? '未知项目',
      type: d.type,
      typeLabel: decisionLabel(d.type),
      title: d.title,
      /** ★ 不处理会怎样 —— 把紧迫性从抽象的「高优先级」变成具体的后果 */
      consequence: d.consequence,
      whyHuman: d.whyHuman,
      /** ★ 界面优先读这份结构化的，读不到才回落到上面那句中文 */
      reasonDetail: d.reasonDetail ?? null,
      riskLevel: d.riskLevel,
      reversible: d.reversible,
      assigneeId: d.assigneeId,
      assigneeName: d.assigneeId ? (userName.get(d.assigneeId) ?? '未知') : null,
      /** ★ 决策不可代行：责任人不是自己时，界面只能看不能批 */
      canAct: userId !== null && (d.assigneeId === null || d.assigneeId === userId),
      createdAt: d.createdAt.toISOString(),
      dueAt: d.dueAt?.toISOString() ?? null,
      overdueMinutes:
        d.dueAt && d.dueAt.getTime() < now ? Math.round((now - d.dueAt.getTime()) / 60_000) : null,
      dueInMinutes:
        d.dueAt && d.dueAt.getTime() >= now
          ? Math.round((d.dueAt.getTime() - now) / 60_000)
          : null,
      waitingMinutes: Math.round((now - d.createdAt.getTime()) / 60_000),
      workItemId: d.workItemId,
      workItemTitle: item?.title ?? null,
      runId: d.runId,
      agentSelfReport: run?.agentSelfReport ?? null,
      options: opts.map((o) => ({
        id: o.id,
        name: o.name,
        description: o.description,
        isRecommended: o.isRecommended,
        rationale: o.rationale,
        uncertainties: o.uncertainties,
      })),
    };
  });

  /**
   * ★ 排序即优先级判断，不让用户自己扫一遍再排。
   *   超时的排最前，其次按剩余时间，再按风险 —— 一个「等着我拍板」的队列，
   *   顺序错了用户就得从头读到尾，5 分钟清空的目标立刻落空。
   */
  cards.sort((a, b) => {
    if ((b.overdueMinutes ?? -1) !== (a.overdueMinutes ?? -1)) {
      return (b.overdueMinutes ?? -1) - (a.overdueMinutes ?? -1);
    }
    if (a.dueInMinutes !== null && b.dueInMinutes !== null) return a.dueInMinutes - b.dueInMinutes;
    if (a.dueInMinutes !== null) return -1;
    if (b.dueInMinutes !== null) return 1;
    return (RISK_ORDER[b.riskLevel] ?? 0) - (RISK_ORDER[a.riskLevel] ?? 0);
  });

  /**
   * 重复决策提示（§2 第 3 问：「有没有重复出现的决策可以变成规则」）。
   * 只在队列里就地提示，不用等用户跑去 Analytics 才发现。
   */
  const byType = new Map<string, number>();
  for (const c of cards) byType.set(c.type, (byType.get(c.type) ?? 0) + 1);
  const repeated = [...byType.entries()]
    .filter(([, n]) => n >= 3)
    .map(([type, count]) => ({ type, label: decisionLabel(type), count }))
    .sort((a, b) => b.count - a.count);

  /**
   * ★★ 按项目拆一份计数。
   *
   *   顶栏那个「8 条待你决策」是**跨项目**的（收件箱本来就是跨项目的收件箱），
   *   而看板上那个「待决策 2」只数当前项目。两个数字并排出现在同一屏上，
   *   中间没有任何东西说明它们的范围不同 —— 用户看到的是系统在自相矛盾，
   *   而且是往吓人的方向矛盾（问题记录 #24）。
   *
   *   拆出来之后顶栏就能说「8 条，其中这个项目 2 条」。
   *
   *   The header badge counts across projects, the board counts one. Two
   *   numbers on one screen with nothing naming their scope reads as a bug.
   */
  const byProject: Record<string, { mine: number; overdue: number }> = {};
  for (const d of mine) {
    const bucket = (byProject[d.projectId] ??= { mine: 0, overdue: 0 });
    bucket.mine += 1;
    if (d.dueAt && d.dueAt.getTime() < now) bucket.overdue += 1;
  }

  return {
    stats: {
      total: rows.length,
      mine: mine.length,
      overdue: cards.filter((c) => c.overdueMinutes !== null).length,
      dueSoon: cards.filter((c) => c.dueInMinutes !== null && c.dueInMinutes <= 240).length,
      actionable: cards.filter((c) => c.canAct).length,
      byProject,
    },
    repeated,
    decisions: cards,
  };
}

/** 一个项目都看不到时的空收件箱。形状必须与正常返回一致，前端不做特判 */
function emptyInbox() {
  return {
    stats: { total: 0, mine: 0, overdue: 0, dueSoon: 0, actionable: 0, byProject: {} },
    repeated: [],
    decisions: [],
  };
}

const RISK_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * 批量批准（页面文档 10 §2「5 分钟内清空当日队列」）。
 *
 * ★ 只允许批量批准，不做批量驳回。
 *   驳回必须写原因，而每条的原因各不相同 —— 批量驳回要么逼用户写一句
 *   放之四海皆准的废话，要么干脆不写。两种都在破坏
 *   「每次覆盖都要留下为什么」这条底线。
 *
 * ★ 逐条走**单条批准的同一个函数**，一个捷径都不留。
 *   批量省掉的是点击，不是规则：不可代行、状态机、Policy 全都照走。
 *   为批量另写一条快路径，是这类功能出事故最常见的原因。
 */
export async function batchApprove(
  ids: string[],
  approveOne: (id: string) => Promise<unknown>,
) {
  const results: { id: string; ok: boolean; error?: string }[] = [];

  for (const id of ids) {
    try {
      await approveOne(id);
      results.push({ id, ok: true });
    } catch (e) {
      results.push({ id, ok: false, error: e instanceof Error ? e.message : '处理失败' });
    }
  }

  return {
    approved: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok),
    results,
  };
}

void desc;
void notFound;
