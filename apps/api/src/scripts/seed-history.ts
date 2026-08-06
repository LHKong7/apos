import { randomUUID } from 'node:crypto';
import {
  agentRuns,
  decisions,
  events,
  workItems,
  type Database,
} from '@apos/db';
import type { WorkItemStatus } from '@apos/contracts';

/**
 * 造 60 天的历史，专供 Analytics 页面。
 *
 * ★ 这一段刻意**不走** transition()，与种子的其余部分相反。
 *   原因是 transition() 把事件戳成 now()，而 Analytics 是一张时间序列页 ——
 *   没有历史它只能显示「数据积累中」，页面的一大半（趋势、环比、
 *   系统发现里所有环比类判据）永远没法被验证。
 *
 *   代价是这批数据是「合成」的：状态跳转不经状态机校验，也没有 Run 事件明细。
 *   所以它只承担统计口径的验证，不用来演示看板行为 ——
 *   看板那部分仍然全走真实链路。两者混用会造出「看起来对但推不动」的卡片。
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** 固定种子的伪随机，保证每次 seed 出来的图一模一样，便于比对回归 */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 4_294_967_296;
  };
}

interface Ctx {
  db: Database;
  orgId: string;
  projectId: string;
  planId: string | null;
  agentIds: string[];
  userIds: string[];
  dbaId: string;
  now: number;
}

interface Track {
  status: WorkItemStatus;
  /** 在该状态停留的小时数 */
  hours: number;
}

export async function seedHistory(ctx: Ctx): Promise<number> {
  const rand = lcg(20260806);
  const { db, orgId, projectId, now } = ctx;

  const itemRows: (typeof workItems.$inferInsert)[] = [];
  const eventRows: (typeof events.$inferInsert)[] = [];
  const runRows: (typeof agentRuns.$inferInsert)[] = [];
  const decisionRows: (typeof decisions.$inferInsert)[] = [];

  const TITLES = [
    '订单列表分页查询优化',
    '导出任务改为异步',
    '库存扣减幂等处理',
    '优惠券叠加规则重构',
    '退款流程状态机梳理',
    '商品详情页缓存预热',
    '风控规则接入灰度',
    '对账文件解析容错',
    '消息推送去重',
    '搜索联想词补全',
    '支付渠道超时重试',
    '用户地址簿去重',
    '结算单据批量生成',
    '物流轨迹拉取限流',
  ];

  let n = 0;
  // 60 天，前 30 天是「上一周期」，后 30 天是「本周期」
  for (let day = 59; day >= 1; day--) {
    // 每天 0~2 个任务；近期略多，制造吞吐提升
    const recent = day <= 30;
    const count = rand() < (recent ? 0.75 : 0.55) ? (rand() < 0.3 ? 2 : 1) : 0;

    for (let k = 0; k < count; k++) {
      const start = now - day * DAY + Math.floor(rand() * 8) * HOUR;
      const title = `${TITLES[n % TITLES.length]}${n >= TITLES.length ? ` (${Math.floor(n / TITLES.length) + 1})` : ''}`;
      const id = randomUUID();
      n++;

      /**
       * ★ 近期的决策等待明显更短。
       *   这是为了让「流动效率提升」这条正面发现有数据可依 ——
       *   一个只会报警的分析页会被用户回避，而正面发现这条路径
       *   如果永远跑不到，就等于没实现。
       */
      const waitHours = recent ? 2 + rand() * 6 : 8 + rand() * 22;
      const needsDecision = rand() < (recent ? 0.45 : 0.6);
      const reworks = rand() < 0.18;
      // 一个离群值：让中位数与均值分道扬镳，验证 §11 的异常值处理
      const outlier = n === 9;

      const track: Track[] = [
        { status: 'ready', hours: 1 + rand() * 4 },
        { status: 'executing', hours: outlier ? 60 : 2 + rand() * 5 },
      ];
      if (reworks) {
        track.push(
          { status: 'reviewing', hours: 0.5 + rand() },
          { status: 'changes_requested', hours: 3 + rand() * 8 },
          { status: 'executing', hours: 1 + rand() * 3 },
        );
      }
      track.push({ status: 'reviewing', hours: 0.5 + rand() * 2 });
      if (needsDecision) track.push({ status: 'awaiting_decision', hours: waitHours });
      track.push({ status: 'releasing', hours: 0.3 + rand() });

      // 铺时间线
      let cursor = start;
      let previous: WorkItemStatus = 'draft';
      let executingStart: number | null = null;

      for (const step of track) {
        eventRows.push(statusEvent(ctx, id, previous, step.status, cursor));
        if (step.status === 'executing' && executingStart === null) executingStart = cursor;
        if (step.status === 'awaiting_decision') {
          decisionRows.push(decisionFor(ctx, id, title, cursor, step.hours, rand));
        }
        // 每次流转都过一遍 Policy，自动放行的占多数
        eventRows.push(policyEvent(ctx, id, step.status, cursor, rand));
        previous = step.status;
        cursor += step.hours * HOUR;
      }
      eventRows.push(statusEvent(ctx, id, previous, 'done', cursor));

      const slot = n % ctx.agentIds.length;
      const agentId = ctx.agentIds[slot]!;
      /**
       * 0 号 Agent 更贵、更慢、更容易失败 —— 三项同时更差，
       * 「全面优于」这条建议才有机会成立。只在成本上拉开差距，
       * 得到的是一个权衡而不是结论，那条发现就永远不会出现。
       */
      const worst = slot === 0;
      const premium = worst ? 1.9 : 1;
      const runMinutes = (worst ? 22 : 7) + rand() * 8;
      const failed = rand() < (worst ? 0.24 : 0.05);
      // 一次离谱的开销，验证「成本异常」按中位数倍数报警。
      // 必须落在近 30 天里 —— 挂在最老的任务上，默认窗口根本看不见它
      const runaway = recent && n === 30;

      runRows.push({
        id: randomUUID(),
        orgId,
        projectId,
        workItemId: id,
        agentId,
        attempt: 1,
        status: failed ? 'failed' : 'completed',
        idempotencyKey: `hist-${id}-1`,
        goal: title,
        model: 'claude-opus-5',
        cost: ((0.4 * premium + rand() * 0.9 * premium) * (runaway ? 9 : 1)).toFixed(4),
        tokensInput: Math.floor(8000 + rand() * 40000),
        tokensOutput: Math.floor(1000 + rand() * 6000),
        errorClass: failed ? pick(rand, FAILURE_CLASSES) : null,
        errorMessage: failed ? '执行未完成' : null,
        startedAt: new Date(executingStart ?? start),
        endedAt: new Date((executingStart ?? start) + runMinutes * 60_000),
        createdAt: new Date(executingStart ?? start),
      });
      if (failed) {
        // 失败后重试一次并成功，让首次成功率与总成功率分开
        runRows.push({
          id: randomUUID(),
          orgId,
          projectId,
          workItemId: id,
          agentId,
          attempt: 2,
          status: 'completed',
          idempotencyKey: `hist-${id}-2`,
          goal: title,
          model: 'claude-opus-5',
          cost: (0.3 * premium + rand() * 0.6).toFixed(4),
          tokensInput: Math.floor(6000 + rand() * 20000),
          tokensOutput: Math.floor(800 + rand() * 3000),
          startedAt: new Date((executingStart ?? start) + runMinutes * 60_000),
          endedAt: new Date((executingStart ?? start) + (runMinutes + 8) * 60_000),
          createdAt: new Date((executingStart ?? start) + runMinutes * 60_000),
        });
      }

      itemRows.push({
        id,
        orgId,
        projectId,
        planId: ctx.planId,
        type: rand() < 0.25 ? 'bug' : 'task',
        status: 'done',
        stage: 'done',
        title,
        priority: 2,
        riskLevel: rand() < 0.15 ? 'high' : 'low',
        ownerId: ctx.userIds[n % ctx.userIds.length]!,
        executorType: 'agent',
        executorId: agentId,
        actualStart: new Date(executingStart ?? start),
        actualEnd: new Date(cursor),
        // 排期只给一部分 —— 让「按时交付率」有真实数据，而不是全空或全满。
        // 窗口刻意压到实际耗时附近，才会有一部分真的延期
        plannedEnd: rand() < 0.7 ? new Date(start + (8 + rand() * 16) * HOUR) : null,
        actualCost: '0',
        createdAt: new Date(start),
        position: 1000 + n,
      });
    }
  }

  // 少量人工覆盖，给「人工覆盖原因分布」喂数据。
  // 取最近的几项 —— 挂在最老的任务上会整批落在 30 天窗口之外，
  // 于是这一块永远是空的，而代码看起来完全正确
  for (let i = 0; i < 6 && i < itemRows.length; i++) {
    const target = itemRows[itemRows.length - 1 - i * 2]!;
    eventRows.push({
      orgId,
      projectId,
      type: 'work_item.status_changed',
      level: 'milestone',
      actorType: 'human',
      actorId: ctx.userIds[0]!,
      subjectType: 'work_item',
      subjectId: target.id!,
      payload: {
        from: 'reviewing',
        to: 'changes_requested',
        trigger: 'changes_requested',
        manual: true,
        reason: OVERRIDE_REASONS[i % OVERRIDE_REASONS.length]!.label,
        reasonCategory: OVERRIDE_REASONS[i % OVERRIDE_REASONS.length]!.value,
      },
      correlationId: randomUUID(),
      occurredAt: new Date(target.createdAt as Date),
    });
  }

  await insertChunked(db, workItems, itemRows);
  await insertChunked(db, agentRuns, runRows);
  await insertChunked(db, decisions, decisionRows);
  await insertChunked(db, events, eventRows);

  return itemRows.length;
}

const FAILURE_CLASSES = ['context_insufficient', 'capability_mismatch', 'tool_failure', 'timeout'];

const OVERRIDE_REASONS = [
  { value: 'review_found_issue', label: '审核发现问题，需返工' },
  { value: 'requirement_changed', label: '需求变更' },
  { value: 'system_misjudged', label: '系统状态判断有误' },
];

/**
 * 决策类型的分布是刻意设计的：
 * - test_env_release 全部批准 → 高自动化潜力，「创建规则」按钮有得点
 * - db_change 批准与驳回各半 → 低潜力，验证「有分歧的决策不推荐规则化」
 */
function decisionFor(
  ctx: Ctx,
  itemId: string,
  title: string,
  at: number,
  waitHours: number,
  rand: () => number,
): typeof decisions.$inferInsert {
  const roll = rand();
  const type = roll < 0.5 ? 'test_env_release' : roll < 0.78 ? 'release_approval' : 'db_change';
  const rejected = type === 'db_change' && rand() < 0.45;

  return {
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    workItemId: itemId,
    type,
    status: rejected ? 'rejected' : 'approved',
    riskLevel: type === 'db_change' ? 'high' : 'low',
    title: `${title} —— ${type === 'db_change' ? '数据库变更审批' : '发布审批'}`,
    whyHuman: '触发了需要人工确认的策略',
    assigneeId: type === 'db_change' ? ctx.dbaId : ctx.userIds[0]!,
    resolvedBy: type === 'db_change' ? ctx.dbaId : ctx.userIds[0]!,
    dueAt: new Date(at + 8 * HOUR),
    resolvedAt: new Date(at + waitHours * HOUR),
    createdAt: new Date(at),
  };
}

function statusEvent(
  ctx: Ctx,
  itemId: string,
  from: WorkItemStatus,
  to: WorkItemStatus,
  at: number,
): typeof events.$inferInsert {
  return {
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    type: 'work_item.status_changed',
    level: 'milestone',
    actorType: 'system',
    actorId: null,
    subjectType: 'work_item',
    subjectId: itemId,
    payload: { from, to, trigger: 'seed_history' },
    correlationId: randomUUID(),
    occurredAt: new Date(at),
  };
}

function policyEvent(
  ctx: Ctx,
  itemId: string,
  status: WorkItemStatus,
  at: number,
  rand: () => number,
): typeof events.$inferInsert {
  const action =
    status === 'awaiting_decision'
      ? 'require_human_review'
      : rand() < 0.85
        ? 'allow'
        : 'allow_and_notify';

  return {
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    type: 'policy.evaluated',
    level: 'detail',
    actorType: 'system',
    actorId: null,
    subjectType: 'work_item',
    subjectId: itemId,
    payload: { action: { type: action }, matchedPolicyName: '历史数据', trace: [] },
    correlationId: randomUUID(),
    occurredAt: new Date(at),
  };
}

function pick<T>(rand: () => number, list: T[]): T {
  return list[Math.floor(rand() * list.length)]!;
}

/** Postgres 单条 INSERT 的参数上限是 65535，分批插 */
async function insertChunked<T extends { $inferInsert: object }>(
  db: Database,
  table: T,
  rows: unknown[],
): Promise<void> {
  const SIZE = 200;
  for (let i = 0; i < rows.length; i += SIZE) {
    const chunk = rows.slice(i, i + SIZE);
    if (chunk.length === 0) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.insert(table as any).values(chunk as any);
  }
}
