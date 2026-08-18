import { and, desc, eq, isNull } from 'drizzle-orm';
import { agentRuns, decisions, projects, workItems, type Database } from '@apos/db';
import {
  SYSTEM_ACTOR,
  type AcceptanceCriterion,
  type AutonomyLevel,
  type RiskLevel,
} from '@apos/contracts';
import { emitAndPublish } from '../event/bus';
import { transition } from '../flow/transition';

export interface ReviewOptions {
  projectId?: string;
  correlationId: string;
  limit?: number;
}

export interface ReviewOutcome {
  workItemId: string;
  title: string;
  action: 'advanced' | 'awaiting_human' | 'sent_back' | 'skipped';
  reason: string;
  finalStatus?: string;
}

/**
 * reviewing → done 的自动化。
 *
 * ★ 这是「任务完成后自动进入下一项」断掉的确切位置。
 *
 *   Agent 跑完把任务推到 `reviewing` 就停了，后面 review_passed →
 *   release → accepted 四个 trigger 此前只有 seed 脚本手动打过。
 *   而 `finish_to_start` 依赖要求前置状态 ∈ {done, released, acceptance}，
 *   所以下游任务永远等不到解锁 —— 整条链断在这里。
 *
 * ★ 自动放行的门槛按项目自治等级分档，且**证据不足一律转人工**：
 *
 *   | 自治等级 | 放行条件 |
 *   | --- | --- |
 *   | human_led | 永不自动放行 |
 *   | agent_led_approval | 核验真的跑过且通过 + 验收标准全部自评通过 + 风险 ≤ medium |
 *   | agent_autonomous | 核验没失败 + 验收标准无明确未通过 |
 *
 *   注意 agent_led_approval 那一栏是「**跑过**且通过」，不是「没失败」。
 *   没配核验命令 = 没有证据 = 不自动放行。默认放行的话，
 *   这套自动化就等于把所有任务无条件推到 done。
 */
export async function reviewRound(
  db: Database,
  opts: ReviewOptions,
): Promise<ReviewOutcome[]> {
  const rows = await db
    .select()
    .from(workItems)
    .innerJoin(projects, eq(projects.id, workItems.projectId))
    .where(
      and(
        eq(workItems.status, 'reviewing'),
        isNull(workItems.deletedAt),
        eq(projects.status, 'active'),
        opts.projectId ? eq(workItems.projectId, opts.projectId) : undefined,
      ),
    )
    .limit(opts.limit ?? 50);

  const outcomes: ReviewOutcome[] = [];
  for (const row of rows) {
    outcomes.push(await reviewOne(db, row.work_items, row.projects.autonomyLevel, opts));
  }
  return outcomes;
}

type ItemRow = typeof workItems.$inferSelect;

async function reviewOne(
  db: Database,
  item: ItemRow,
  autonomy: AutonomyLevel,
  opts: ReviewOptions,
): Promise<ReviewOutcome> {
  const base = { workItemId: item.id, title: item.title };

  // 已经有待处理决策就别再插一脚
  const pending = await db
    .select({ id: decisions.id })
    .from(decisions)
    .where(and(eq(decisions.workItemId, item.id), eq(decisions.status, 'pending')));
  if (pending.length > 0) {
    return { ...base, action: 'skipped', reason: '已有待处理决策' };
  }

  const [run] = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.workItemId, item.id))
    .orderBy(desc(agentRuns.attempt))
    .limit(1);

  const quality = (item.typeData['qualityGate'] ?? {}) as Record<string, unknown>;
  const testsRan = quality['testSource'] === 'workspace_check' || quality['testsPassed'] !== undefined;
  const testsPassed = quality['testsPassed'] === true;
  const testsFailed = quality['testsPassed'] === false;

  const acceptance = deriveAcceptance(item.acceptanceCriteria, run?.agentSelfReport ?? null);

  // 验收自评落库，页面上要能看到「Agent 认为哪条没做到」
  if (acceptance.changed) {
    await db
      .update(workItems)
      .set({ acceptanceCriteria: acceptance.criteria })
      .where(eq(workItems.id, item.id));
  }

  await emitAndPublish(db, {
    orgId: item.orgId,
    projectId: item.projectId,
    actor: SYSTEM_ACTOR,
    type: 'work_item.quality_checked',
    subjectType: 'work_item',
    subjectId: item.id,
    payload: {
      testsRan,
      testsPassed,
      testCommand: quality['testCommand'] ?? null,
      acceptance: { passed: acceptance.passed, failed: acceptance.failed, unclear: acceptance.unclear },
      autonomy,
    },
    correlationId: opts.correlationId,
  });

  // ── 明确失败：退回返工，不需要人拍板 ──
  if (testsFailed || acceptance.failed > 0) {
    const why = [
      testsFailed ? `质量核验未通过（${quality['testCommand'] ?? '核验命令'}）` : '',
      acceptance.failed > 0 ? `${acceptance.failed} 项验收标准未满足` : '',
    ]
      .filter(Boolean)
      .join('；');

    const moved = await transition(db, {
      workItemId: item.id,
      trigger: 'review_rejected',
      actor: SYSTEM_ACTOR,
      reason: why,
      correlationId: opts.correlationId,
    });
    return moved.ok
      ? { ...base, action: 'sent_back', reason: why, finalStatus: 'changes_requested' }
      : { ...base, action: 'skipped', reason: `退回失败：${JSON.stringify(moved)}` };
  }

  // ── 能否自动放行 ──
  const verdict = canAutoPass(autonomy, item.riskLevel, {
    testsRan,
    testsPassed,
    unclear: acceptance.unclear,
  });

  if (!verdict.ok) {
    return awaitHuman(db, item, verdict.reason, opts);
  }

  return advance(db, item, verdict.reason, opts);
}

function canAutoPass(
  autonomy: AutonomyLevel,
  risk: RiskLevel,
  facts: { testsRan: boolean; testsPassed: boolean; unclear: number },
): { ok: true; reason: string } | { ok: false; reason: string } {
  if (autonomy === 'human_led') {
    return { ok: false, reason: '项目自治等级为「人类主导」，评审始终由人完成' };
  }

  if (autonomy === 'agent_autonomous') {
    return facts.testsRan && !facts.testsPassed
      ? { ok: false, reason: '质量核验未通过' }
      : { ok: true, reason: '自治等级为「Agent 自主」，无阻断项，自动放行' };
  }

  // agent_led_approval
  if (!facts.testsRan) {
    return {
      ok: false,
      reason:
        '没有质量核验证据（该仓库未配置核验命令），无法自动放行 —— ' +
        '在「代码仓库」里配置核验命令后可自动化',
    };
  }
  if (!facts.testsPassed) return { ok: false, reason: '质量核验未通过' };
  if (facts.unclear > 0) {
    return { ok: false, reason: `${facts.unclear} 项验收标准无法从执行报告中确认` };
  }
  if (risk === 'high' || risk === 'critical') {
    return { ok: false, reason: `任务风险等级为 ${risk}，高风险变更必须由人确认` };
  }
  return { ok: true, reason: '质量核验通过且验收标准全部自评满足，自动放行' };
}

/**
 * 自动推进：review_passed → release → acceptance → done。
 *
 * ★ 一路推到底而不是停在 waiting_for_release，是因为依赖判定认的是
 *   {done, released, acceptance} —— 停在中间那几站，下游任务照样解锁不了，
 *   自动化就只做了一半。真正需要人工发布动作的项目，
 *   把自治等级设成 human_led 或用 Policy 拦在 release 上。
 */
async function advance(
  db: Database,
  item: ItemRow,
  reason: string,
  opts: ReviewOptions,
): Promise<ReviewOutcome> {
  const chain = ['review_passed', 'release_started', 'release_completed', 'accepted'] as const;
  let last = item.status;

  for (const trigger of chain) {
    const moved = await transition(db, {
      workItemId: item.id,
      trigger,
      actor: SYSTEM_ACTOR,
      reason,
      correlationId: opts.correlationId,
    });

    if (!moved.ok) {
      /**
       * ★ 中途被 Guard 或 Policy 拦下不是错误，是设计。
       *   停在哪一站就是哪一站，但要把原因说清楚 ——
       *   「自动推进到 waiting_for_release，被 xx 拦住」是可行动的信息。
       */
      return {
        workItemId: item.id,
        title: item.title,
        action: last === item.status ? 'awaiting_human' : 'advanced',
        reason: `${reason}；推进到 ${last} 后被拦下：${describeBlock(moved)}`,
        finalStatus: last,
      };
    }
    last = moved.to;
  }

  return {
    workItemId: item.id,
    title: item.title,
    action: 'advanced',
    reason,
    finalStatus: last,
  };
}

async function awaitHuman(
  db: Database,
  item: ItemRow,
  reason: string,
  opts: ReviewOptions,
): Promise<ReviewOutcome> {
  const [decision] = await db
    .insert(decisions)
    .values({
      orgId: item.orgId,
      projectId: item.projectId,
      workItemId: item.id,
      type: 'review_approval',
      status: 'pending',
      riskLevel: item.riskLevel,
      reversible: true,
      title: `评审：${item.title}`,
      background: reason,
      whyHuman: reason,
      consequence: '不处理则该任务停在评审阶段，其下游任务无法开始',
      /** ★ 结构化副本，界面读它（见 contracts/work-item/decision-reason.ts） */
      reasonDetail: {
        whyHuman: { code: 'review_required' as const },
        consequence: { code: 'stuck_in_review' as const },
      },
      impact: { workItemId: item.id, stage: 'review' },
      dueAt: new Date(Date.now() + 8 * 3600_000),
    })
    .returning({ id: decisions.id });

  await emitAndPublish(db, {
    orgId: item.orgId,
    projectId: item.projectId,
    actor: SYSTEM_ACTOR,
    type: 'decision.created',
    subjectType: 'decision',
    subjectId: decision!.id,
    payload: { workItemId: item.id, source: 'review', reason },
    correlationId: opts.correlationId,
  });

  return {
    workItemId: item.id,
    title: item.title,
    action: 'awaiting_human',
    reason,
  };
}

/**
 * 从 Agent 的最终报告里读出各条验收标准的自评。
 *
 * ★ 这是**自评**，不是独立验证 —— prompt 明确要求 Agent 按 ID 逐条说明，
 *   但它说「满足」不等于真的满足。所以 status 标为 passed 的同时，
 *   `verification` 记成 'agent'，而 agent_led_approval 档
 *   仍要求质量核验这条独立证据一起为真才放行。
 *
 * ★ 读不出来的算 unclear，不算 passed。默认通过的话，
 *   一个什么都没写的报告会让所有验收标准自动变绿。
 */
const NEGATIVE_RE =
  /未满足|不满足|未完成|没有完成|没完成|未实现|未通过|不通过|未做|失败|not met|not implemented|failed|missing\b/gi;

const POSITIVE_RE = /满足|完成|实现|通过|met\b|passed|done\b|yes\b|✓|✅/i;

export function deriveAcceptance(
  criteria: AcceptanceCriterion[],
  report: string | null,
): {
  criteria: AcceptanceCriterion[];
  passed: number;
  failed: number;
  unclear: number;
  changed: boolean;
} {
  if (criteria.length === 0) {
    return { criteria, passed: 0, failed: 0, unclear: 0, changed: false };
  }
  if (!report?.trim()) {
    return {
      criteria,
      passed: 0,
      failed: 0,
      unclear: criteria.length,
      changed: false,
    };
  }

  const lines = report.split('\n');
  let changed = false;
  let passed = 0;
  let failed = 0;
  let unclear = 0;

  const next = criteria.map((c) => {
    // 已由人确认过的不覆盖 —— 人的判断优先于 Agent 的自评
    if (c.verification === 'human' && c.status !== 'pending') {
      if (c.status === 'passed') passed++;
      else failed++;
      return c;
    }

    const line = lines.find((l) => l.includes(c.id));
    if (!line) {
      unclear++;
      return c.status === 'pending' ? c : { ...c, status: 'pending' as const };
    }

    /**
     * ★ 先把否定短语整体挖掉再判肯定，否则「未满足」里的「满足」
     *   会同时点亮两边，把一条明确的失败读成「说不清」。
     */
    const cleaned = line.replace(NEGATIVE_RE, '§');
    const negative = cleaned.includes('§');
    const positive = POSITIVE_RE.test(cleaned);

    // ★ 两边都命中就算不清楚。「主流程已满足，但边界情况未完成」
    //   这种句子判成 passed 是危险的 —— 它恰恰是最该有人看一眼的那类
    const status: AcceptanceCriterion['status'] =
      negative && !positive ? 'failed' : positive && !negative ? 'passed' : 'pending';

    if (status === 'passed') passed++;
    else if (status === 'failed') failed++;
    else unclear++;

    if (status !== c.status) changed = true;
    /**
     * ★ verification 标成 'agent'：这是**自评**，不是独立验证。
     *   prompt 要求 Agent 按 ID 逐条说明，但它说「满足」不等于真的满足 ——
     *   所以 agent_led_approval 档仍要求质量核验这条独立证据一起为真。
     */
    return {
      ...c,
      status,
      verification: 'agent' as const,
      verifiedAt: new Date().toISOString(),
    };
  });

  return { criteria: next, passed, failed, unclear, changed };
}

function describeBlock(moved: Awaited<ReturnType<typeof transition>>): string {
  if (moved.ok) return '';
  const r = moved as { reason?: string; failures?: { reason: string }[]; code?: string };
  if (r.failures?.length) return r.failures.map((f) => f.reason).join('；');
  return r.reason ?? r.code ?? '未说明原因';
}
