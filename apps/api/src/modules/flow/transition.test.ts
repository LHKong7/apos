import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { artifacts, decisions, events, policies, workItemDependencies, workItems } from '@apos/db';
import { humanActor, SYSTEM_ACTOR, agentActor } from '@apos/contracts';
import { createWorkItem, resetDb, seedFixture, testDb, type Fixture } from '../../test/db';
import { transition } from './transition';

const db = testDb();
let fx: Fixture;

beforeEach(async () => {
  await resetDb(db);
  fx = await seedFixture(db);
});

afterAll(async () => {
  await resetDb(db);
});

function corr() {
  return randomUUID();
}

/** 真实完成的 Agent Run 一定有产出，否则会被 hasOutput guard 拦下 */
async function withArtifact(itemId: string) {
  await db.insert(artifacts).values({
    orgId: fx.orgId,
    projectId: fx.projectId,
    workItemId: itemId,
    kind: 'pull_request',
    title: 'PR #42',
    producedByType: 'agent',
  });
}

/** transition 不经过 Scheduler，需要显式执行主体才能过 executorAssigned guard */
const assigned = { executorType: 'agent' as const, executorId: randomUUID() };

async function eventsFor(subjectId: string) {
  return db
    .select()
    .from(events)
    .where(eq(events.subjectId, subjectId))
    .orderBy(events.id);
}

describe('★ 核心不变式：状态变更必须写事件', () => {
  it('成功流转同时写入 status_changed 与 policy.evaluated', async () => {
    const item = await createWorkItem(db, fx, assigned);

    const result = await transition(db, {
      workItemId: item.id,
      trigger: 'run_dispatched',
      actor: SYSTEM_ACTOR,
      correlationId: corr(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.to).toBe('executing');

    const rows = await eventsFor(item.id);
    const types = rows.map((r) => r.type);
    expect(types).toContain('policy.evaluated');
    expect(types).toContain('work_item.status_changed');

    const changed = rows.find((r) => r.type === 'work_item.status_changed')!;
    expect(changed.payload).toMatchObject({ from: 'ready', to: 'executing' });
  });

  it('★ 流转被拒绝时不写任何事件，也不改状态', async () => {
    const item = await createWorkItem(db, fx, { ...assigned, status: 'ready' });

    const result = await transition(db, {
      workItemId: item.id,
      trigger: 'release_completed', // ready 状态下非法
      actor: SYSTEM_ACTOR,
      correlationId: corr(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_TRANSITION');
    if (result.code === 'INVALID_TRANSITION') {
      expect(result.allowedTriggers).toContain('run_dispatched');
    }

    expect(await eventsFor(item.id)).toHaveLength(0);
    const [after] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(after!.status).toBe('ready');
    expect(after!.version).toBe(1);
  });

  it('★ Guard 失败时事务整体回滚，事件与状态都不变', async () => {
    const blocker = await createWorkItem(db, fx, { status: 'executing', title: '前置任务' });
    const item = await createWorkItem(db, fx, assigned);
    await db.insert(workItemDependencies).values({
      projectId: fx.projectId,
      fromId: blocker.id,
      toId: item.id,
      type: 'finish_to_start',
      createdByType: 'system',
    });

    const result = await transition(db, {
      workItemId: item.id,
      trigger: 'run_dispatched',
      actor: SYSTEM_ACTOR,
      correlationId: corr(),
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.code !== 'GUARD_FAILED') throw new Error('应因依赖未满足被拦截');
    expect(result.failures[0]?.reason).toContain('前置依赖未满足');

    expect(await eventsFor(item.id)).toHaveLength(0);
    const [after] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(after!.status).toBe('ready');
  });

  it('事件带因果链：status_changed 的 causation 指向 policy.evaluated', async () => {
    const item = await createWorkItem(db, fx, assigned);
    const correlationId = corr();

    await transition(db, {
      workItemId: item.id,
      trigger: 'run_dispatched',
      actor: SYSTEM_ACTOR,
      correlationId,
    });

    const rows = await eventsFor(item.id);
    const policyEvent = rows.find((r) => r.type === 'policy.evaluated')!;
    const changed = rows.find((r) => r.type === 'work_item.status_changed')!;

    expect(changed.causationId).toBe(policyEvent.id);
    expect(rows.every((r) => r.correlationId === correlationId)).toBe(true);
  });
});

describe('★ 上下文快照 —— Policy 模拟回放的前提', () => {
  it('policy.evaluated 事件携带完整快照', async () => {
    const item = await createWorkItem(db, fx, assigned);

    await transition(db, {
      workItemId: item.id,
      trigger: 'run_dispatched',
      actor: SYSTEM_ACTOR,
      correlationId: corr(),
    });

    const rows = await eventsFor(item.id);
    const snapshot = rows.find((r) => r.type === 'policy.evaluated')!.contextSnapshot!;

    expect(snapshot).toBeTruthy();
    // 23 个 fact 一个都不能少 —— 缺了的字段事后无法补
    for (const key of [
      'projectType', 'workItemType', 'riskLevel', 'reversible', 'externalFacing',
      'environment', 'dataSensitivity', 'impactTaskCount', 'impactServices', 'operationType',
      'agentType', 'agentConfidence', 'agentSuccessRate', 'consecutiveFailures',
      'runCost', 'projectCostSpent', 'projectBudget', 'budgetUsedPct',
      'testsResult', 'testCoverage', 'securityScan', 'agentReview', 'autonomyLevel',
    ]) {
      expect(snapshot, `快照缺少 fact: ${key}`).toHaveProperty(key);
    }
  });

  it('快照反映真实的项目预算与成本', async () => {
    const item = await createWorkItem(db, fx, { ...assigned, actualCost: '8.2000' });

    await transition(db, {
      workItemId: item.id,
      trigger: 'run_dispatched',
      actor: SYSTEM_ACTOR,
      correlationId: corr(),
    });

    const rows = await eventsFor(item.id);
    const snapshot = rows.find((r) => r.type === 'policy.evaluated')!.contextSnapshot!;
    expect(snapshot.runCost).toBe(8.2);
    expect(snapshot.projectBudget).toBe(500);
  });
});

describe('Policy 拦截与决策创建', () => {
  it('★ 生产数据库变更被基线规则拦截，任务进入 awaiting_decision', async () => {
    const item = await createWorkItem(db, fx, {
      status: 'executing',
      typeData: { environment: 'production', operationType: 'db_ddl' },
    });
    await withArtifact(item.id);

    const result = await transition(db, {
      workItemId: item.id,
      trigger: 'agent_run_completed',
      actor: agentActor(randomUUID()),
      correlationId: corr(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 目标本是 reviewing，被 Policy 改道
    expect(result.to).toBe('awaiting_decision');
    expect(result.verdict.matchedPolicyId).toBe('baseline-prod-db');
    expect(result.createdDecisionId).toBeTruthy();

    const [decision] = await db
      .select()
      .from(decisions)
      .where(eq(decisions.id, result.createdDecisionId!));
    expect(decision!.whyHuman).toContain('生产数据库变更');
    expect(decision!.dueAt).toBeTruthy();

    // 决策创建也要有事件
    const decisionEvents = await eventsFor(result.createdDecisionId!);
    expect(decisionEvents.map((e) => e.type)).toContain('decision.created');
  });

  it('低风险任务在 agent_led_approval 下自动放行', async () => {
    const item = await createWorkItem(db, fx, { status: 'executing', riskLevel: 'low' });
    await withArtifact(item.id);

    const result = await transition(db, {
      workItemId: item.id,
      trigger: 'agent_run_completed',
      actor: agentActor(randomUUID()),
      correlationId: corr(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.to).toBe('reviewing');
    expect(result.createdDecisionId).toBeNull();
  });

  it('★ 项目级规则无法绕过组织基线', async () => {
    // 项目试图放行生产 DDL
    await db.insert(policies).values({
      orgId: fx.orgId,
      projectId: fx.projectId,
      name: '放行一切',
      priority: 100,
      condition: { all: [] },
      action: { type: 'allow' },
      createdBy: fx.userId,
    });

    const item = await createWorkItem(db, fx, {
      status: 'executing',
      typeData: { environment: 'production', operationType: 'db_ddl' },
    });
    await withArtifact(item.id);

    const result = await transition(db, {
      workItemId: item.id,
      trigger: 'agent_run_completed',
      actor: SYSTEM_ACTOR,
      correlationId: corr(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verdict.matchedPolicyId).toBe('baseline-prod-db');
    expect(result.to).toBe('awaiting_decision');
  });

  it('★ 删除资源即使在 agent_autonomous 下也不自动放行', async () => {
    const autonomous = await seedFixture(db, { autonomyLevel: 'agent_autonomous' });
    const item = await createWorkItem(db, autonomous, {
      status: 'executing',
      typeData: { operationType: 'delete_resource' },
    });
    await db.insert(artifacts).values({
      orgId: autonomous.orgId,
      projectId: autonomous.projectId,
      workItemId: item.id,
      kind: 'code',
      title: 'diff',
      producedByType: 'agent',
    });

    const result = await transition(db, {
      workItemId: item.id,
      trigger: 'agent_run_completed',
      actor: SYSTEM_ACTOR,
      correlationId: corr(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verdict.requiresHuman).toBe(true);
    expect(result.to).toBe('awaiting_decision');
  });
});

describe('$previous 机制', () => {
  it('决策批准后回到进入等待前的状态', async () => {
    const item = await createWorkItem(db, fx, { status: 'executing' });

    const enter = await transition(db, {
      workItemId: item.id,
      trigger: 'decision_required',
      actor: SYSTEM_ACTOR,
      correlationId: corr(),
    });
    expect(enter.ok && enter.to).toBe('awaiting_decision');

    const [mid] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(mid!.previousStatus).toBe('executing');

    const approve = await transition(db, {
      workItemId: item.id,
      trigger: 'decision_approved',
      actor: humanActor(fx.userId),
      correlationId: corr(),
    });

    expect(approve.ok).toBe(true);
    if (!approve.ok) return;
    expect(approve.to).toBe('executing');

    const [after] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(after!.previousStatus).toBeNull();
    expect(after!.humanGate).toBe('approved');
  });
});

describe('effects', () => {
  it('人工接管切换执行主体并打上 Human Gate 标记', async () => {
    const item = await createWorkItem(db, fx, { status: 'executing' });

    await transition(db, {
      workItemId: item.id,
      trigger: 'human_took_over',
      actor: humanActor(fx.userId),
      reason: 'Agent 陷入循环',
      correlationId: corr(),
    });

    const [after] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(after!.executorType).toBe('human');
    expect(after!.executorId).toBe(fx.userId);
    expect(after!.humanGate).toBe('human_took_over');
    expect(after!.status).toBe('executing');
  });

  it('改派清零连续失败计数，避免新 Agent 立刻撞上失败阈值', async () => {
    const item = await createWorkItem(db, fx, { status: 'failed', consecutiveFailures: 2 });

    await transition(db, {
      workItemId: item.id,
      trigger: 'reassigned',
      actor: humanActor(fx.userId),
      correlationId: corr(),
    });

    const [after] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(after!.consecutiveFailures).toBe(0);
    expect(after!.status).toBe('ready');
  });

  it('解除阻塞清空阻塞字段', async () => {
    const item = await createWorkItem(db, fx, {
      status: 'blocked',
      blockedSince: new Date(),
      blockedReason: '等待 DBA 审批',
    });

    await transition(db, {
      workItemId: item.id,
      trigger: 'blocker_cleared',
      actor: SYSTEM_ACTOR,
      correlationId: corr(),
    });

    const [after] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(after!.blockedSince).toBeNull();
    expect(after!.blockedReason).toBeNull();
  });
});

describe('强制放行', () => {
  it('override guard 时额外写 force_passed 事件并要求原因', async () => {
    const item = await createWorkItem(db, fx, {
      status: 'reviewing',
      acceptanceCriteria: [
        { id: 'a', text: 'P95 < 500ms', verification: 'auto', status: 'pending', evidenceRef: null, verifiedAt: null },
      ],
    });

    const result = await transition(db, {
      workItemId: item.id,
      trigger: 'review_passed',
      actor: humanActor(fx.userId),
      overrideGuards: ['acceptanceCriteriaMet', 'qualityGatePassed'],
      reason: '性能测试环境不可用，已人工验证',
      correlationId: corr(),
    });

    expect(result.ok).toBe(true);
    const rows = await eventsFor(item.id);
    const forced = rows.find((r) => r.type === 'work_item.force_passed')!;
    expect(forced).toBeTruthy();
    expect(forced.payload['reason']).toBe('性能测试环境不可用，已人工验证');
  });

  it('★ 强制放行缺少原因时整个事务回滚', async () => {
    const item = await createWorkItem(db, fx, {
      status: 'reviewing',
      acceptanceCriteria: [
        { id: 'a', text: '未完成项', verification: 'auto', status: 'pending', evidenceRef: null, verifiedAt: null },
      ],
    });

    await expect(
      transition(db, {
        workItemId: item.id,
        trigger: 'review_passed',
        actor: humanActor(fx.userId),
        overrideGuards: ['acceptanceCriteriaMet', 'qualityGatePassed'],
        // 故意不给 reason
        correlationId: corr(),
      }),
    ).rejects.toThrow(/必须在 payload 中携带 reason/);

    // 事务回滚：状态未变、无事件残留
    const [after] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(after!.status).toBe('reviewing');
    expect(await eventsFor(item.id)).toHaveLength(0);
  });
});

describe('乐观锁与版本', () => {
  it('每次成功流转递增版本号', async () => {
    const item = await createWorkItem(db, fx, assigned);
    expect(item.version).toBe(1);

    await transition(db, {
      workItemId: item.id,
      trigger: 'run_dispatched',
      actor: SYSTEM_ACTOR,
      correlationId: corr(),
    });

    const [after] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(after!.version).toBe(2);
  });
});

describe('stage 与 status 保持同步', () => {
  it('流转后 stage 由 status 推导，不会脱节', async () => {
    const item = await createWorkItem(db, fx, { status: 'executing' });
    await db.insert(artifacts).values({
      orgId: fx.orgId,
      projectId: fx.projectId,
      workItemId: item.id,
      kind: 'code',
      title: 'diff',
      producedByType: 'agent',
    });

    const result = await transition(db, {
      workItemId: item.id,
      trigger: 'agent_run_completed',
      actor: SYSTEM_ACTOR,
      correlationId: corr(),
    });

    expect(result.ok && result.stage).toBe('review');
    const [after] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(after!.stage).toBe('review');
  });
});

describe('NOT_FOUND', () => {
  it('不存在的 Work Item 返回 NOT_FOUND 而不是抛异常', async () => {
    const result = await transition(db, {
      workItemId: randomUUID(),
      trigger: 'run_dispatched',
      actor: SYSTEM_ACTOR,
      correlationId: corr(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_FOUND');
  });
});
