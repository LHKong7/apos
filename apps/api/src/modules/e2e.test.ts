import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  agentRuns,
  artifacts,
  events,
  requirementClarifications,
  requirements,
  workItems,
} from '@apos/db';
import { resetDb, seedFixture, testDb, type Fixture } from '../test/db';
import { seedAgent, waitFor } from '../test/agent-fixtures';
import { StubPlanningProvider } from './planning/stub-provider';
import { analyzeRequirement, answerClarification, approveRequirement } from './requirement/service';
import { approvePlan, generatePlan } from './planning/service';
import { scheduleRound } from './flow/scheduler';

const db = testDb();
const provider = new StubPlanningProvider();
let fx: Fixture;

beforeEach(async () => {
  await resetDb(db);
  fx = await seedFixture(db);
});

afterAll(async () => {
  await resetDb(db);
});

const corr = () => randomUUID();

const RAW_INPUT = `现在用户查订单要等好几秒，客服天天投诉。想优化一下，最好能支持按手机号、
订单号、时间段搜。另外老板要求这周五前上线。`;

async function createRequirement() {
  const [req] = await db
    .insert(requirements)
    .values({
      orgId: fx.orgId,
      projectId: fx.projectId,
      rawInput: RAW_INPUT,
      inputMethod: 'manual',
    })
    .returning();
  return req!;
}

/**
 * MVP 计划里阶段 1 的验收演示脚本，作为自动化测试。
 * docs/tech/10-mvp-plan.md §4
 */
describe('★★ 阶段 1 验收：需求 → 计划 → 执行 → 看板自动流转', () => {
  it('端到端跑通，全程无需手动拖动任何卡片', async () => {
    const agent = await seedAgent(db, fx);
    const c = corr();

    // ── 1. 录入口语化需求 ────────────────────────────────────────────
    const req = await createRequirement();
    expect(req.status).toBe('draft');

    // ── 2. AI 结构化 ────────────────────────────────────────────────
    const analysis = await analyzeRequirement(db, provider, {
      requirementId: req.id,
      correlationId: c,
    });

    expect(analysis.mustConfirmCount).toBeGreaterThan(0);
    // 原文永不覆盖
    const [afterAnalyze] = await db.select().from(requirements).where(eq(requirements.id, req.id));
    expect(afterAnalyze!.rawInput).toBe(RAW_INPUT);
    expect(afterAnalyze!.title).toBeTruthy();
    expect(afterAnalyze!.status).toBe('clarifying');
    // 字段级溯源存在，页面才能做原文对照高亮
    expect(afterAnalyze!.fieldProvenance).toHaveProperty('title');

    // ── 3. 必答问题未回答时不能确认需求 ──────────────────────────────
    const premature = await approveRequirement(db, {
      requirementId: req.id,
      approverId: fx.userId,
      correlationId: c,
    });
    expect(premature.ok).toBe(false);
    if (!premature.ok && premature.code === 'UNANSWERED_MUST_CONFIRM') {
      expect(premature.questions.length).toBe(analysis.mustConfirmCount);
    } else {
      expect.unreachable('必答问题未回答时应当以 UNANSWERED_MUST_CONFIRM 阻断');
    }

    // ── 4. 回答澄清问题（多数一键采纳 Agent 倾向）────────────────────
    const questions = await db
      .select()
      .from(requirementClarifications)
      .where(eq(requirementClarifications.requirementId, req.id));

    for (const q of questions.filter((x) => x.level === 'must_confirm')) {
      // 每个必答问题都必须带影响说明与 Agent 倾向
      expect(q.impact, `问题「${q.question}」缺少影响说明`).toBeTruthy();
      expect(q.agentSuggestion, `问题「${q.question}」缺少 Agent 倾向`).toBeTruthy();

      await answerClarification(db, {
        clarificationId: q.id,
        answer: q.agentSuggestion!,
        usedSuggestion: true,
        actorId: fx.userId,
        correlationId: c,
      });
    }

    // 回答后完整度回升，状态转为待确认
    const [clarified] = await db.select().from(requirements).where(eq(requirements.id, req.id));
    expect(clarified!.status).toBe('awaiting_approval');
    const before = (afterAnalyze!.completeness as { total: number }).total;
    const after = (clarified!.completeness as { total: number }).total;
    expect(after).toBeGreaterThan(before);

    // ── 5. 人类确认需求 ─────────────────────────────────────────────
    const approved = await approveRequirement(db, {
      requirementId: req.id,
      approverId: fx.userId,
      correlationId: c,
    });
    expect(approved.ok).toBe(true);

    // ── 6. 生成执行计划 ─────────────────────────────────────────────
    const plan = await generatePlan(db, provider, { requirementId: req.id, correlationId: c });

    expect(plan.taskCount).toBeGreaterThanOrEqual(5);
    expect(plan.humanTaskCount).toBeGreaterThan(0);

    // ★ 「批准后将自动发生」清单必须存在且可读
    expect(plan.autoActions.length).toBeGreaterThan(0);
    expect(plan.autoActions.map((a) => a.description).join(' ')).toContain('自动执行');
    // 反向清单同样重要：用户要知道安全网在哪
    expect(plan.humanGates.length).toBeGreaterThan(0);
    expect(plan.humanGates.some((g) => g.taskTitle.includes('发布'))).toBe(true);

    // 计划里的任务先是 draft，还不会被调度
    const drafts = await db.select().from(workItems).where(eq(workItems.planId, plan.planId));
    expect(drafts.every((t) => t.status === 'draft')).toBe(true);

    const idleRound = await scheduleRound(db, agent.registry, {
      projectId: fx.projectId,
      correlationId: c,
    });
    expect(idleRound.scanned).toBe(0);

    // ── 7. 人类批准计划 ─────────────────────────────────────────────
    /**
     * ★ acknowledgedUnassigned：计划里的人工任务这会儿还没指定负责人，
     *   而 approvePlan 会为此先拦一次（见 planning/service.ts 的
     *   UNASSIGNED_HUMAN_TASKS）。这里代表用户确认「让它们进待认领队列」——
     *   这条用例验的是自动流转，不是排人，那一步在 Plan 页上单独测。
     */
    const activation = await approvePlan(db, {
      planId: plan.planId,
      approverId: fx.userId,
      correlationId: c,
      acknowledgedUnassigned: true,
    });
    expect(activation.ok).toBe(true);
    if (!activation.ok) return;
    expect(activation.activatedTasks).toBe(plan.taskCount);

    // ── 8. 调度器接手，卡片自己开始流动 ──────────────────────────────
    const round1 = await scheduleRound(db, agent.registry, {
      projectId: fx.projectId,
      correlationId: c,
    });

    // 只有无前置依赖的任务被调度
    expect(round1.outcomes.filter((o) => o.action === 'dispatched')).toHaveLength(1);
    expect(round1.outcomes[0]?.title).toContain('现状分析');

    await waitFor(async () => {
      const [t] = await db
        .select()
        .from(workItems)
        .where(and(eq(workItems.planId, plan.planId), eq(workItems.status, 'reviewing')));
      return t ?? null;
    }, { label: '首个任务未流转到 reviewing' });

    // ── 9. 全程零手动拖动：所有状态变更的 actor 都不是人类 ────────────
    const statusChanges = await db
      .select()
      .from(events)
      .where(eq(events.type, 'work_item.status_changed'));

    const manualMoves = statusChanges.filter(
      (e) => e.actorType === 'human' && e.payload['trigger'] !== 'plan_approved',
    );
    expect(manualMoves, '出现了人工拖动卡片的状态变更').toHaveLength(0);

    // ── 10. 产物与成本落库 ──────────────────────────────────────────
    const arts = await db.select().from(artifacts);
    expect(arts.length).toBeGreaterThan(0);

    const runs = await db.select().from(agentRuns);
    expect(runs.every((r) => r.permissionSnapshot !== null)).toBe(true);
  });

  it('★ 高风险任务在计划阶段就被识别为 Human Gate', async () => {
    await seedAgent(db, fx);
    const c = corr();
    const req = await createRequirement();

    await analyzeRequirement(db, provider, { requirementId: req.id, correlationId: c });
    const questions = await db
      .select()
      .from(requirementClarifications)
      .where(eq(requirementClarifications.requirementId, req.id));
    for (const q of questions.filter((x) => x.level === 'must_confirm')) {
      await answerClarification(db, {
        clarificationId: q.id,
        answer: q.agentSuggestion ?? 'ok',
        usedSuggestion: true,
        actorId: fx.userId,
        correlationId: c,
      });
    }
    await approveRequirement(db, { requirementId: req.id, approverId: fx.userId, correlationId: c });

    const plan = await generatePlan(db, provider, { requirementId: req.id, correlationId: c });

    // 生产发布与生产 DDL 都要出现在 Human Gate 清单里
    const gateTitles = plan.humanGates.map((g) => g.taskTitle).join('|');
    expect(gateTitles).toContain('发布');
    expect(gateTitles).toContain('数据库');

    // 且这些任务不计入「将自动执行」
    const autoText = plan.autoActions.map((a) => a.description).join(' ');
    expect(autoText).not.toContain('发布到生产环境');
    expect(autoText).not.toContain('数据库索引变更');
  });

  it('★ 计划预估成本超预算时阻断批准', async () => {
    const c = corr();
    const req = await createRequirement();
    await analyzeRequirement(db, provider, { requirementId: req.id, correlationId: c });
    const questions = await db
      .select()
      .from(requirementClarifications)
      .where(eq(requirementClarifications.requirementId, req.id));
    for (const q of questions.filter((x) => x.level === 'must_confirm')) {
      await answerClarification(db, {
        clarificationId: q.id,
        answer: 'ok',
        usedSuggestion: false,
        actorId: fx.userId,
        correlationId: c,
      });
    }
    await approveRequirement(db, { requirementId: req.id, approverId: fx.userId, correlationId: c });

    const { projects } = await import('@apos/db');
    await db.update(projects).set({ budgetAmount: '1.00' }).where(eq(projects.id, fx.projectId));

    const plan = await generatePlan(db, provider, { requirementId: req.id, correlationId: c });
    const result = await approvePlan(db, {
      planId: plan.planId,
      approverId: fx.userId,
      correlationId: c,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('BUDGET_EXCEEDED');

    // 任务仍是 draft，没被激活
    const tasks = await db.select().from(workItems).where(eq(workItems.planId, plan.planId));
    expect(tasks.every((t) => t.status === 'draft')).toBe(true);

    /**
     * 显式知晓超支后可以放行。
     *
     * ★ 两个确认要分别给：超支与「人工任务没人认领」是两次独立的拦截，
     *   各用各的错误码，acknowledgedOverrun 不顺带把另一条也放过去。
     *   合成一个的话，用户点「确认超支」会连带默许了一件他没被问过的事。
     */
    const forced = await approvePlan(db, {
      planId: plan.planId,
      approverId: fx.userId,
      correlationId: c,
      acknowledgedOverrun: true,
      acknowledgedUnassigned: true,
    });
    expect(forced.ok).toBe(true);
  });

  it('计划批准的事件里带自动化清单快照，供追溯「他到底批准了什么」', async () => {
    const c = corr();
    const req = await createRequirement();
    await analyzeRequirement(db, provider, { requirementId: req.id, correlationId: c });
    const questions = await db
      .select()
      .from(requirementClarifications)
      .where(eq(requirementClarifications.requirementId, req.id));
    for (const q of questions.filter((x) => x.level === 'must_confirm')) {
      await answerClarification(db, {
        clarificationId: q.id,
        answer: 'ok',
        usedSuggestion: false,
        actorId: fx.userId,
        correlationId: c,
      });
    }
    await approveRequirement(db, { requirementId: req.id, approverId: fx.userId, correlationId: c });
    const plan = await generatePlan(db, provider, { requirementId: req.id, correlationId: c });
    await approvePlan(db, {
      planId: plan.planId,
      approverId: fx.userId,
      correlationId: c,
      /** 人工任务先进待认领队列 —— 这条用例验的不是排人 */
      acknowledgedUnassigned: true,
    });

    const [approvedEvent] = await db
      .select()
      .from(events)
      .where(eq(events.type, 'plan.approved'));

    const snapshot = approvedEvent!.payload['autoActionsSnapshot'] as unknown[];
    expect(Array.isArray(snapshot)).toBe(true);
    expect(snapshot.length).toBeGreaterThan(0);
  });

  it('依赖链按序执行：后置任务在前置完成后才被调度', async () => {
    const agent = await seedAgent(db, fx);
    const c = corr();
    const req = await createRequirement();

    await analyzeRequirement(db, provider, { requirementId: req.id, correlationId: c });
    const questions = await db
      .select()
      .from(requirementClarifications)
      .where(eq(requirementClarifications.requirementId, req.id));
    for (const q of questions.filter((x) => x.level === 'must_confirm')) {
      await answerClarification(db, {
        clarificationId: q.id,
        answer: 'ok',
        usedSuggestion: false,
        actorId: fx.userId,
        correlationId: c,
      });
    }
    await approveRequirement(db, { requirementId: req.id, approverId: fx.userId, correlationId: c });
    const plan = await generatePlan(db, provider, { requirementId: req.id, correlationId: c });
    await approvePlan(db, {
      planId: plan.planId,
      approverId: fx.userId,
      correlationId: c,
      /** 人工任务先进待认领队列 —— 这条用例验的不是排人 */
      acknowledgedUnassigned: true,
    });

    // 第一轮：只有 research 无依赖
    const round1 = await scheduleRound(db, agent.registry, {
      projectId: fx.projectId,
      correlationId: c,
    });
    const dispatched1 = round1.outcomes.filter((o) => o.action === 'dispatched');
    expect(dispatched1).toHaveLength(1);

    // 手工把 research 标记完成，模拟审核通过
    const researchId = dispatched1[0]!.workItemId;
    await waitFor(async () => {
      const [t] = await db.select().from(workItems).where(eq(workItems.id, researchId));
      return t?.status === 'reviewing' ? t : null;
    });
    await db.update(workItems).set({ status: 'done', stage: 'done' }).where(eq(workItems.id, researchId));

    // 第二轮：design 解除阻塞
    const round2 = await scheduleRound(db, agent.registry, {
      projectId: fx.projectId,
      correlationId: c,
    });
    const dispatched2 = round2.outcomes.filter((o) => o.action === 'dispatched');
    expect(dispatched2).toHaveLength(1);
    expect(dispatched2[0]!.title).toContain('设计');
  });
});
