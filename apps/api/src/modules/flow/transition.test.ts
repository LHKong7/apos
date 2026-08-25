import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { artifacts, decisions, events, policies, workItemDependencies, workItems } from '@apos/db';
import { humanActor, SYSTEM_ACTOR, agentActor } from '@apos/contracts';
import { decisionLabel } from '@apos/domain';
import { createWorkItem, resetDb, seedFixture, testDb, type Fixture } from '../../test/db';
import { decisionTypeFor, transition } from './transition';

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

/**
 * 往库里放一条规则。
 *
 * ★★ 平台不再自带任何硬编码基线 —— 生效的规则只有库里这些，一条都没有
 *   就是零条。所以每个「Policy 会拦住它」的用例都必须自己先把那条规则
 *   建出来；不建就等于在测「没有规则时会发生什么」，而那是另一回事。
 *
 * ★ `projectId: null` = 组织级规则。它和项目规则的差别只有一个：优先级
 *   排在前面（1–99 vs 100+），因此项目规则挡不住它。
 */
async function insertRule(
  scope: 'org' | 'project',
  rule: { name: string; priority: number; condition: unknown; action: unknown },
  fixture?: Fixture,
): Promise<string> {
  const f = fixture ?? fx;
  const [row] = await db
    .insert(policies)
    .values({
      orgId: f.orgId,
      projectId: scope === 'org' ? null : f.projectId,
      name: rule.name,
      priority: rule.priority,
      condition: rule.condition as never,
      action: rule.action as never,
      createdBy: f.userId,
    })
    .returning({ id: policies.id });
  return row!.id;
}

const PROD_DB_RULE = {
  name: '生产数据库变更必须由 DBA 审批',
  priority: 5,
  condition: {
    all: [
      { fact: 'environment', op: 'eq', value: 'production' },
      { fact: 'operationType', op: 'in', value: ['db_ddl', 'db_dml'] },
    ],
  },
  action: { type: 'require_human_review', assignee: { kind: 'role', role: 'dba' }, dueInHours: 4 },
};

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
      'runTokens', 'projectTokensSpent', 'projectTokenBudget', 'budgetUsedPct',
      'testsResult', 'testCoverage', 'securityScan', 'agentReview', 'autonomyLevel',
    ]) {
      expect(snapshot, `快照缺少 fact: ${key}`).toHaveProperty(key);
    }
  });

  it('快照反映真实的项目 token 预算与用量', async () => {
    const item = await createWorkItem(db, fx, { ...assigned, actualTokens: 410_000 });

    await transition(db, {
      workItemId: item.id,
      trigger: 'run_dispatched',
      actor: SYSTEM_ACTOR,
      correlationId: corr(),
    });

    const rows = await eventsFor(item.id);
    const snapshot = rows.find((r) => r.type === 'policy.evaluated')!.contextSnapshot!;
    expect(snapshot.runTokens).toBe(410_000);
    expect(snapshot.projectTokenBudget).toBe(5_000_000);
  });
});

/**
 * ★★ Policy 的 `pause` 走的是另一条停靠路径：任务停在 `blocked` 而不是
 *   `awaiting_decision`，但一样挂着一条待批的决策。
 *
 *   这组用例锁住的是「停下来」和「能再走」必须成对出现。以前只有前半截：
 *   决策建出来了，任务也确实停住了，而 `blocked` 上没有 decision_approved
 *   这条边 —— 批准撞在 INVALID_TRANSITION 上，整个批准事务回滚，
 *   于是任务永远停在 blocked、决策永远 pending，再点多少次批准都一样。
 *   两处代码（这里选 finalStatus、routes.ts 发 decision_approved）
 *   分开看都完全正常，只有连起来跑才看得见。
 *
 * A Policy `pause` parks the task in `blocked` rather than
 * `awaiting_decision`. These lock down that parking it and resuming it come as
 * a pair — approving used to hit INVALID_TRANSITION and roll back, stranding
 * the task and its Decision forever.
 */
describe('★ Policy pause：停在 blocked 的任务必须能被批准放行', () => {
  const PAUSE_RULE = {
    name: '生产数据库变更先暂停',
    priority: 5,
    condition: {
      all: [
        { fact: 'environment', op: 'eq', value: 'production' },
        { fact: 'operationType', op: 'in', value: ['db_ddl', 'db_dml'] },
      ],
    },
    action: { type: 'pause', resumeCondition: 'human_decision' },
  };

  async function pausedItem() {
    const ruleId = await insertRule('org', PAUSE_RULE);
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
    return { ruleId, item, result };
  }

  it('pause 把任务压进 blocked 并建出决策', async () => {
    const { ruleId, result } = await pausedItem();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 目标本是 reviewing，被 pause 改道到 blocked（而不是 awaiting_decision）
    expect(result.to).toBe('blocked');
    expect(result.verdict.matchedPolicyId).toBe(ruleId);
    expect(result.createdDecisionId).toBeTruthy();
  });

  /**
   * ★ 停在哪之外还得记住「本来要去哪」。这一栏为空的话，就算后来能批准，
   *   $previous 也只会回落到 ready —— 任务默默倒退一个阶段，没有任何报错。
   */
  it('记住批准后的目的地，而不是把它丢掉', async () => {
    const { item } = await pausedItem();

    const [row] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(row!.previousStatus).toBe('reviewing');
    // 看板要看得出它在等人，而不是一张静静停住的卡片
    expect(row!.humanGate).toBe('waiting_for_decision');
  });

  /**
   * ★ 「已阻塞」而阻塞原因一栏是空的，是这条路径以前的样子。
   *   这是唯一一种阻塞是平台自己造成的情形 —— 说得出是哪条规则拦的，
   *   用户才知道该去批哪条决策。
   */
  it('把阻塞原因一起写上，卡片能自己解释', async () => {
    const { item } = await pausedItem();

    const [row] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(row!.blockedReason).toContain(PAUSE_RULE.name);
    expect(row!.blockedSince).toBeTruthy();

    // ★ 界面读的是这份结构化的，不是上面那句中文（CLAUDE.md：原因码 + 参数）
    const detail = row!.blockedDetail as { kind: string; detail: string | null };
    expect(detail.kind).toBe('policy_paused');
    // 规则名字是用户自己起的，原样带过去 —— 翻译它等于改名
    expect(detail.detail).toBe(PAUSE_RULE.name);
  });

  it('★★ 批准决策后任务回到本来要去的状态，而不是卡死在 blocked', async () => {
    const { item, result } = await pausedItem();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await db
      .update(decisions)
      .set({ status: 'approved', resolvedAt: new Date() })
      .where(eq(decisions.id, result.createdDecisionId!));

    const approved = await transition(db, {
      workItemId: item.id,
      trigger: 'decision_approved',
      actor: humanActor(randomUUID()),
      approvedDecisionId: result.createdDecisionId!,
      correlationId: corr(),
    });

    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.to).toBe('reviewing');

    const [row] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(row!.status).toBe('reviewing');
    // 阻塞的痕迹随之清掉，否则卡片会一直挂着一条早已解决的阻塞原因
    expect(row!.blockedReason).toBeNull();
    expect(row!.blockedSince).toBeNull();
    expect(row!.previousStatus).toBeNull();
    expect(row!.humanGate).toBe('approved');

    // ★ 核心不变式照旧：状态变了就必须有事件
    const rows = await eventsFor(item.id);
    const changes = rows.filter((r) => r.type === 'work_item.status_changed');
    expect(changes.at(-1)!.payload).toMatchObject({ from: 'blocked', to: 'reviewing' });
  });
});

describe('Policy 拦截与决策创建', () => {
  it('★ 生产数据库变更被规则拦截，任务进入 awaiting_decision', async () => {
    const ruleId = await insertRule('org', PROD_DB_RULE);
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
    expect(result.verdict.matchedPolicyId).toBe(ruleId);
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

    await db
      .update(decisions)
      .set({ status: 'approved', resolvedAt: new Date() })
      .where(eq(decisions.id, result.createdDecisionId!));

    const approved = await transition(db, {
      workItemId: item.id,
      trigger: 'decision_approved',
      actor: humanActor(randomUUID()),
      approvedDecisionId: result.createdDecisionId!,
      correlationId: corr(),
    });

    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.to).toBe('reviewing');
    expect(approved.createdDecisionId).toBeNull();

    // humanGate is presentation state, not the durable authorization record.
    // Human takeover legitimately replaces the badge after approval.
    await db
      .update(workItems)
      .set({ humanGate: 'human_took_over' })
      .where(eq(workItems.id, item.id));

    const continued = await transition(db, {
      workItemId: item.id,
      trigger: 'review_passed',
      actor: humanActor(randomUUID()),
      overrideGuards: ['acceptanceCriteriaMet', 'qualityGatePassed'],
      reason: 'Human verified the approved operation output',
      correlationId: corr(),
    });

    expect(continued.ok).toBe(true);
    if (!continued.ok) return;
    expect(continued.to).toBe('waiting_for_release');
    expect(continued.createdDecisionId).toBeNull();
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

  it('★ 项目级规则排在组织规则之后，绕不过它', async () => {
    const orgRuleId = await insertRule('org', PROD_DB_RULE);
    // 项目试图放行生产 DDL —— 优先级 100 永远排在组织规则之后
    await insertRule('project', {
      name: '放行一切',
      priority: 100,
      condition: { all: [] },
      action: { type: 'allow' },
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
    expect(result.verdict.matchedPolicyId).toBe(orgRuleId);
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

describe('决策类型的中文名', () => {
  /**
   * ★ 规则命中后会生成一个决策，决策类型必须有中文名。
   *   这两处分别在 apps/api 和 packages/domain，谁也不 import 谁 ——
   *   之前它们就是这么各写各的：运行时发 high_risk_operation，
   *   标签表里只有 db_change，页面上于是印出一串下划线。
   */
  it('规则命中产出的决策类型有中文名', () => {
    const type = decisionTypeFor({ matchedPolicyId: randomUUID() } as never);
    expect(decisionLabel(type), `${type} 没有中文名`).not.toBe(type);
  });

  it('没有命中规则时的兜底类型也有中文名', () => {
    const type = decisionTypeFor({ matchedPolicyId: null } as never);
    expect(decisionLabel(type)).not.toBe(type);
  });

  /**
   * ★ 规则 id 是用户建规则时生成的 UUID，从它推不出这条规则管的是发布
   *   还是预算。以前按 `baseline-` 前缀分出的那些细分类型因此全部下线 ——
   *   猜出来的分类会在决策中心上贴一个可能是错的标签。
   */
  it('★ 不再从规则 id 猜决策类型', () => {
    expect(decisionTypeFor({ matchedPolicyId: randomUUID() } as never)).toBe('approval');
    expect(decisionTypeFor({ matchedPolicyId: null } as never)).toBe('approval');
  });
});
