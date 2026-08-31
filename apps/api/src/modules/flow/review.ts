import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  agentRuns,
  decisions,
  plans,
  projects,
  requirements,
  workItems,
  type Database,
  type DbTransaction,
} from '@apos/db';
import {
  SYSTEM_ACTOR,
  type AcceptanceCriterion,
  type ActorRef,
  type AutonomyLevel,
  type RiskLevel,
} from '@apos/contracts';
import { defaultBus, emitAndPublish } from '../event/bus';
import { emit, type EmittedEvent } from '../event/emitter';
import { transition } from '../flow/transition';
import { mergeTypeData } from '../work-item/json-merge';

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

  const acceptance = deriveAcceptance(
    item.acceptanceCriteria,
    run?.agentSelfReport ?? null,
    run ? `agent-run:${run.id}` : null,
  );

  // 验收自评落库，页面上要能看到「Agent 认为哪条没做到」
  if (acceptance.changed) {
    await db
      .update(workItems)
      .set({ acceptanceCriteria: acceptance.criteria })
      .where(eq(workItems.id, item.id));

    const before = new Map(item.acceptanceCriteria.map((criterion) => [criterion.id, criterion]));
    for (const criterion of acceptance.criteria) {
      const previous = before.get(criterion.id);
      if (
        previous?.status === criterion.status &&
        previous?.evidenceRef === criterion.evidenceRef &&
        previous?.verifiedAt === criterion.verifiedAt
      ) {
        continue;
      }
      await emitAndPublish(db, {
        orgId: item.orgId,
        projectId: item.projectId,
        actor: SYSTEM_ACTOR,
        type: 'work_item.acceptance_updated',
        level: 'detail',
        subjectType: 'work_item',
        subjectId: item.id,
        payload: {
          criterionId: criterion.id,
          passed: criterion.status === 'passed',
          status: criterion.status,
          verification: criterion.verification,
          evidenceRef: criterion.evidenceRef,
        },
        correlationId: opts.correlationId,
      });
    }
  }

  /**
   * ★★ 只在结论**变了**的时候写这条事件。
   *
   *   评审循环每 20 秒把同一批 reviewing 任务重新判一遍，而判据
   *   （核验结果、验收自评、自治等级）在人来处理之前通常一动不动。
   *   无条件写的代价和调度器那边的 markBlocked 是同一笔：Timeline 上
   *   每分钟堆三条一模一样的 `work_item.quality_checked`，把真正的状态
   *   变更淹掉，而 events 表是审计、Analytics、通知共同的数据源。
   *
   *   判据本身就是结论的全部输入，所以指纹直接用 payload —— 不必再维护
   *   一份「哪些字段算数」的清单，字段增减自动跟上。
   *
   * Only write when the verdict actually changed. The review loop re-derives
   * the same conclusion every 20s; writing unconditionally floods the very
   * table audit and analytics read.
   */
  const checkFacts = {
    testsRan,
    testsPassed,
    testCommand: quality['testCommand'] ?? null,
    acceptance: { passed: acceptance.passed, failed: acceptance.failed, unclear: acceptance.unclear },
    autonomy,
  };

  if (!sameQualityCheck(item.typeData['reviewCheck'], checkFacts)) {
    await db
      .update(workItems)
      .set({ typeData: mergeTypeData({ reviewCheck: checkFacts }) })
      .where(eq(workItems.id, item.id));

    await emitAndPublish(db, {
      orgId: item.orgId,
      projectId: item.projectId,
      actor: SYSTEM_ACTOR,
      type: 'work_item.quality_checked',
      subjectType: 'work_item',
      subjectId: item.id,
      payload: checkFacts,
      correlationId: opts.correlationId,
    });
  }

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

/**
 * 上一轮判据与这一轮是否一致。
 *
 * ★ 和 scheduler 的 sameBlockedDetail 一个用途、一个道理：定时循环写库前
 *   先问一句「变了吗」。这里比的是结构化的判据本身，不是渲染出来的句子 ——
 *   句子随时会改措辞，改一次措辞就等于全库任务各多一条事件。
 *
 * ★★ 必须**按规范化形式**比，不能直接 JSON.stringify 两边。
 *
 *   上一轮那份是从 jsonb 列里读回来的，而 jsonb **不保留键序**（Postgres
 *   按键长度再按字节重排）。直接序列化比较，两份内容完全相同的判据会因为
 *   `{testsRan,testsPassed,…}` 与 `{autonomy,testsRan,…}` 的顺序差异
 *   判成「变了」—— 于是这道防重复的闸门看起来装好了，实际一次都没拦住，
 *   而事件照旧每轮一条。这一条是被集成测试抓出来的，单测里两边都是内存
 *   对象、键序天然一致，永远发现不了。
 *
 * Whether this round's verdict matches the one already recorded. Same purpose
 * and same reasoning as the scheduler's sameBlockedDetail — but it must
 * compare canonicalized forms: the stored copy comes back from a jsonb column,
 * which does not preserve key order, so a plain JSON.stringify comparison
 * reports "changed" every single round and the guard silently does nothing.
 */
export function sameQualityCheck(previous: unknown, next: Record<string, unknown>): boolean {
  if (previous === null || typeof previous !== 'object') return false;
  return canonical(previous) === canonical(next);
}

/** 键序无关的序列化 —— 见 sameQualityCheck 里 jsonb 那一段 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
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
      const why = `${reason}；推进到 ${last} 后被拦下：${describeBlock(moved)}`;

      /**
       * ★★ 第一步就被拦下 = 任务**一步没动**，还停在 reviewing。
       *
       *   这一支以前只是回一个 `action: 'awaiting_human'` 的报告就结束了 ——
       *   而「awaiting_human」当时是句空话：没有人被通知，也没有待办产生。
       *   任务原地不动，下一轮 20 秒后又被扫到、又判一遍、又被同一道 guard
       *   拦下，如此往复；唯一的痕迹是 events 表里每 20 秒多一条
       *   `work_item.quality_checked`，把真正的状态变更淹掉。
       *
       *   最容易撞上的是 agent_autonomous + 验收标准没人确认：
       *   canAutoPass 这一档不看 unclear（那是有意的，见上表），
       *   但 review_passed 上的 acceptanceCriteriaMet 门禁看 —— 于是
       *   「可以自动放行」和「放不过去」在同一个任务上同时成立。
       *   这里的答案不是去放宽那道门禁（自评没说通过就当通过，正是
       *   deriveAcceptance 一直在防的事），而是把它交给人：
       *   人批准 review_approval 决策时会先如实把验收标准记成
       *   human/passed（recordHumanAcceptance），门禁随之自然通过。
       *
       * Blocked at the very first hop means the task has not moved at all.
       * Returning a bare report left it in `reviewing` with no Decision, so
       * the next round re-derived the same verdict forever. Hand it to a
       * human instead — that both unblocks it and stops the event churn.
       */
      if (last === item.status) return awaitHuman(db, item, why, opts);

      return {
        workItemId: item.id,
        title: item.title,
        action: 'advanced',
        reason: why,
        finalStatus: last,
      };
    }
    last = moved.to;
  }

  if (last === 'done') {
    await rollUpRequirementAcceptance(db, {
      workItemId: item.id,
      actor: SYSTEM_ACTOR,
      correlationId: opts.correlationId,
    });
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
  evidenceRef: string | null = null,
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
      if (c.status === 'pending' && c.evidenceRef === null && c.verifiedAt === null) return c;
      changed = true;
      return {
        ...c,
        status: 'pending' as const,
        evidenceRef: null,
        verifiedAt: null,
      };
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

    const nextEvidenceRef = status === 'pending' ? null : (evidenceRef ?? c.evidenceRef);
    const verifiedAt = status === 'pending' ? null : new Date().toISOString();
    if (
      status !== c.status ||
      nextEvidenceRef !== c.evidenceRef ||
      (status !== 'pending' && c.verifiedAt === null)
    ) {
      changed = true;
    }
    /**
     * ★ verification 标成 'agent'：这是**自评**，不是独立验证。
     *   prompt 要求 Agent 按 ID 逐条说明，但它说「满足」不等于真的满足 ——
     *   所以 agent_led_approval 档仍要求质量核验这条独立证据一起为真。
     */
    return {
      ...c,
      status,
      verification: 'agent' as const,
      evidenceRef: nextEvidenceRef,
      verifiedAt,
    };
  });

  return { criteria: next, passed, failed, unclear, changed };
}

/**
 * Human review is itself evidence. Persist it before evaluating the
 * acceptanceCriteriaMet guard so a task never reaches done with pending
 * criteria merely because the route force-passed the guard.
 */
export async function recordHumanAcceptance(
  db: Database,
  input: {
    workItemId: string;
    evidenceRef: string;
    actor: ActorRef;
    reason: string;
    correlationId: string;
  },
): Promise<void> {
  const events = await db.transaction((tx) => recordHumanAcceptanceInTransaction(tx, input));
  if (events.length > 0) defaultBus.publish(events);
}

export async function recordHumanAcceptanceInTransaction(
  tx: DbTransaction,
  input: {
    workItemId: string;
    evidenceRef: string;
    actor: ActorRef;
    reason: string;
    correlationId: string;
  },
): Promise<EmittedEvent[]> {
  const [item] = await tx.select().from(workItems).where(eq(workItems.id, input.workItemId));
  if (!item || item.acceptanceCriteria.length === 0) return [];

  const verifiedAt = new Date().toISOString();
  const criteria = item.acceptanceCriteria.map((criterion) => ({
    ...criterion,
    status: 'passed' as const,
    verification: 'human' as const,
    evidenceRef: input.evidenceRef,
    verifiedAt,
  }));

  await tx
    .update(workItems)
    .set({ acceptanceCriteria: criteria })
    .where(eq(workItems.id, item.id));

  const events: EmittedEvent[] = [];
  for (const criterion of criteria) {
    events.push(await emit(tx, {
      orgId: item.orgId,
      projectId: item.projectId,
      actor: input.actor,
      type: 'work_item.acceptance_updated',
      level: 'detail',
      subjectType: 'work_item',
      subjectId: item.id,
      payload: {
        criterionId: criterion.id,
        passed: true,
        status: 'passed',
        verification: 'human',
        evidenceRef: input.evidenceRef,
        reason: input.reason,
      },
      correlationId: input.correlationId,
    }));
  }
  return events;
}

/**
 * Roll completed work-item evidence up to the requirement criterion it was
 * planned to verify. The explicit requirementCriterionId lineage is preferred;
 * same-id criteria remain supported for rule-based and historical plans.
 */
export async function rollUpRequirementAcceptance(
  db: Database,
  input: { workItemId: string; actor: ActorRef; correlationId: string },
): Promise<void> {
  const events = await db.transaction((tx) => rollUpRequirementAcceptanceInTransaction(tx, input));
  if (events.length > 0) defaultBus.publish(events);
}

export async function rollUpRequirementAcceptanceInTransaction(
  tx: DbTransaction,
  input: { workItemId: string; actor: ActorRef; correlationId: string },
): Promise<EmittedEvent[]> {
  const [completedItem] = await tx
    .select({ requirementId: workItems.requirementId, planId: workItems.planId })
    .from(workItems)
    .where(eq(workItems.id, input.workItemId));
  if (!completedItem?.requirementId) return [];

  /**
   * A requirement may retain tasks from an older plan for audit and comparison.
   * Only the newest approved plan is authoritative: otherwise unfinished tasks
   * from a superseded/fallback plan keep current acceptance pending forever.
   */
  if (completedItem.planId) {
    const [activePlan] = await tx
      .select({ id: plans.id })
      .from(plans)
      .where(and(eq(plans.requirementId, completedItem.requirementId), eq(plans.status, 'approved')))
      .orderBy(desc(plans.version))
      .limit(1);
    if (activePlan && activePlan.id !== completedItem.planId) return [];
  }

  const [requirement] = await tx
    .select()
    .from(requirements)
    .where(eq(requirements.id, completedItem.requirementId));
  if (!requirement || requirement.acceptanceCriteria.length === 0) return [];

  const items = await tx
    .select({
      id: workItems.id,
      status: workItems.status,
      acceptanceCriteria: workItems.acceptanceCriteria,
    })
    .from(workItems)
    .where(
      and(
        eq(workItems.requirementId, requirement.id),
        completedItem.planId
          ? eq(workItems.planId, completedItem.planId)
          : isNull(workItems.planId),
        isNull(workItems.deletedAt),
      ),
    );

  const verifiedAt = new Date().toISOString();
  const next = requirement.acceptanceCriteria.map((criterion) => {
    const evidence = items.flatMap((item) =>
      item.acceptanceCriteria
        .filter(
          (candidate) =>
            candidate.requirementCriterionId === criterion.id || candidate.id === criterion.id,
        )
        .map((candidate) => ({ item, candidate })),
    );
    if (evidence.length === 0) return criterion;

    const failed = evidence.some(({ candidate }) => candidate.status === 'failed');
    const passed = evidence.every(
      ({ item, candidate }) => item.status === 'done' && candidate.status === 'passed',
    );
    const status: AcceptanceCriterion['status'] = failed
      ? 'failed'
      : passed
        ? 'passed'
        : 'pending';

    const refs = [...new Set(evidence.map(({ candidate }) => candidate.evidenceRef).filter(Boolean))];
    const evidenceRef =
      status === 'pending'
        ? null
        : refs.length === 1
          ? refs[0]!
          : `work-items:${[...new Set(evidence.map(({ item }) => item.id))].join(',')}`;

    return {
      ...criterion,
      status,
      evidenceRef,
      verifiedAt: status === 'pending' ? null : verifiedAt,
    };
  });

  if (JSON.stringify(next) === JSON.stringify(requirement.acceptanceCriteria)) return [];

  await tx
    .update(requirements)
    .set({ acceptanceCriteria: next, updatedAt: new Date() })
    .where(eq(requirements.id, requirement.id));

  return [await emit(tx, {
    orgId: requirement.orgId,
    projectId: requirement.projectId,
    actor: input.actor,
    type: 'requirement.acceptance_updated',
    subjectType: 'requirement',
    subjectId: requirement.id,
    payload: {
      sourceWorkItemId: input.workItemId,
      passed: next.filter((criterion) => criterion.status === 'passed').length,
      failed: next.filter((criterion) => criterion.status === 'failed').length,
      pending: next.filter((criterion) => criterion.status === 'pending').length,
    },
    correlationId: input.correlationId,
  })];
}

function describeBlock(moved: Awaited<ReturnType<typeof transition>>): string {
  if (moved.ok) return '';
  const r = moved as { reason?: string; failures?: { reason: string }[]; code?: string };
  if (r.failures?.length) return r.failures.map((f) => f.reason).join('；');
  return r.reason ?? r.code ?? '未说明原因';
}
