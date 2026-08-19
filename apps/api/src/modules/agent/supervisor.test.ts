import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agentRuns, events as eventsTable, runEvents, workItems } from '@apos/db';
import { MockRuntime, RuntimeRegistry, degradedMockRuntime } from '@apos/agent-runtimes';
import { createWorkItem, resetDb, seedFixture, testDb, type Fixture } from '../../test/db';
import { seedAgent, waitFor } from '../../test/agent-fixtures';
import { dispatchRun } from './dispatch';
import { reclaimOnBoot, superviseRuns } from './supervisor';
import { runRecoveryRound } from './recovery';

const db = testDb();
let fx: Fixture;

beforeEach(async () => {
  await resetDb(db);
  fx = await seedFixture(db);
});

afterAll(async () => {
  await resetDb(db);
});

/**
 * 造一条真正卡住的 Run。
 *
 * ★ 必须等 run_started 落库之后再交给调用方改心跳 ——
 *   那条事件的 ingest 会把 lastHeartbeatAt 刷成 now，
 *   在它之前改的值会被无声地覆盖掉。
 */
async function stuckRun(opts: { registry?: RuntimeRegistry; runtime?: MockRuntime } = {}) {
  const runtime = opts.runtime ?? new MockRuntime({}, { steps: ['长任务'], stepDelayMs: 100_000 });
  const registry = opts.registry ?? new RuntimeRegistry();
  const agent = await seedAgent(db, fx, { runtime, registry });
  const item = await createWorkItem(db, fx, { status: 'ready' });

  await dispatchRun(db, registry, {
    workItemId: item.id,
    agentId: agent.agentId,
    correlationId: randomUUID(),
  });

  const run = await waitFor(async () => {
    const [r] = await db.select().from(agentRuns).where(eq(agentRuns.workItemId, item.id));
    if (!r || r.status !== 'running') return null;
    const events = await db.select().from(runEvents).where(eq(runEvents.runId, r.id));
    return events.some((e) => e.type === 'run_started') ? r : null;
  }, { label: 'run_started 落库' });

  return { run, item, registry, runtime, agentId: agent.agentId };
}

describe('run-supervisor', () => {
  it('超过 timeoutAt 的 Run 被终止并判为 timeout', async () => {
    const { run, registry, runtime } = await stuckRun();

    await db
      .update(agentRuns)
      .set({ timeoutAt: new Date(Date.now() - 1000) })
      .where(eq(agentRuns.id, run.id));

    const report = await superviseRuns(db, registry, { correlationId: randomUUID() });

    expect(report.timedOut).toContain(run.id);
    const [after] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
    expect(after!.status).toBe('timeout');

    // ★ 先叫停外部执行再落状态，否则成本会在我们判完之后继续涨
    expect(runtime.controlsFor(run.id).some((c) => c.action === 'terminate')).toBe(true);
  });

  /**
   * ★ 这条是 supervisor 存在的意义。
   *   只按心跳判死，会把跑长任务（一次大重构二十分钟不产生事件）的 Agent
   *   误杀，而它其实好好的 —— 杀掉的代价是那二十分钟的成本白烧。
   */
  it('心跳超期但运行时说仍在跑时，只续心跳不误杀', async () => {
    const { run, registry } = await stuckRun();

    await db
      .update(agentRuns)
      .set({ lastHeartbeatAt: new Date(Date.now() - 10 * 60_000), timeoutAt: null })
      .where(eq(agentRuns.id, run.id));

    const report = await superviseRuns(db, registry, { correlationId: randomUUID() });

    expect(report.stillRunning).toContain(run.id);
    expect(report.orphanedResolved).not.toContain(run.id);

    const [after] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
    expect(after!.status).toBe('running');
    expect(after!.lastHeartbeatAt!.getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it('运行时已经不认这个 Run 时判为中断并流转到 failed', async () => {
    const { run, item, registry, runtime } = await stuckRun();

    // 运行时侧认为已终止
    await runtime.control(run.id, { action: 'terminate', reason: '外部终止' });
    await db
      .update(agentRuns)
      .set({ lastHeartbeatAt: new Date(Date.now() - 10 * 60_000), timeoutAt: null })
      .where(eq(agentRuns.id, run.id));

    const report = await superviseRuns(db, registry, { correlationId: randomUUID() });

    expect(report.orphanedResolved).toContain(run.id);
    const [after] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
    expect(after!.status).toBe('failed');

    const [afterItem] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(afterItem!.status).toBe('failed');
  });

  it('适配器没注册时按「已经不在跑」处理 —— 会话是本进程的子进程', async () => {
    const { run } = await stuckRun();
    await db
      .update(agentRuns)
      .set({ lastHeartbeatAt: new Date(Date.now() - 10 * 60_000), timeoutAt: null })
      .where(eq(agentRuns.id, run.id));

    // 空注册表 = 本进程没有这个运行时的适配器
    const report = await superviseRuns(db, new RuntimeRegistry(), { correlationId: randomUUID() });
    expect(report.orphanedResolved).toContain(run.id);
  });

  it('不支持状态查询的运行时超时后判失败，但分类标为推断', async () => {
    const runtime = degradedMockRuntime({ steps: [], stepDelayMs: 100_000 });
    const { run, registry } = await stuckRun({ runtime });

    await db
      .update(agentRuns)
      .set({ lastHeartbeatAt: new Date(Date.now() - 10 * 60_000), timeoutAt: null })
      .where(eq(agentRuns.id, run.id));

    await superviseRuns(db, registry, { correlationId: randomUUID() });

    const [after] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
    expect(after!.status).toBe('failed');
    expect(after!.errorDetail).toMatchObject({ classificationSource: 'inferred' });
  });

  /**
   * ★ 不认领的话，重启前留下的 running Run 会永远占着
   *   「一个 Work Item 只能有一个活跃 Run」的名额，把卡片钉死，
   *   而看板上它显示为「执行中」。
   */
  it('启动时认领上一轮进程留下的孤儿 Run', async () => {
    const { run } = await stuckRun();

    const reclaimed = await reclaimOnBoot(db, new RuntimeRegistry(), { correlationId: randomUUID() });
    expect(reclaimed).toBe(1);

    const [after] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
    expect(after!.status).toBe('failed');
  });

  it('健康的 Run 不会被扫到', async () => {
    const { run, registry } = await stuckRun();
    await db
      .update(agentRuns)
      .set({ lastHeartbeatAt: new Date(), timeoutAt: new Date(Date.now() + 3600_000) })
      .where(eq(agentRuns.id, run.id));

    const report = await superviseRuns(db, registry, { correlationId: randomUUID() });
    expect(report.scanned).toBe(0);
  });
});

describe('recovery-worker', () => {
  /** 让 Run 以指定错误类别失败 */
  async function failedRun(errorClass: string, opts: { stepDelayMs?: number } = {}) {
    const runtime = new MockRuntime(
      {},
      {
        steps: ['一步'],
        outcome: 'failed',
        error: { class: errorClass, message: `模拟 ${errorClass}` },
        stepDelayMs: opts.stepDelayMs ?? 0,
      },
    );
    const registry = new RuntimeRegistry();
    const agent = await seedAgent(db, fx, { runtime, registry });
    const item = await createWorkItem(db, fx, { status: 'ready' });

    await dispatchRun(db, registry, {
      workItemId: item.id,
      agentId: agent.agentId,
      correlationId: randomUUID(),
    });

    /**
     * ★ 等 recoveryAction 落库，不能只等 status 变 failed ——
     *   applyRunPatch 先写 status，handleFailure 才写恢复决策，
     *   中间有个窗口。等错了会随机失败，而且看起来像产品 bug。
     */
    await waitFor(async () => {
      const [r] = await db.select().from(agentRuns).where(eq(agentRuns.workItemId, item.id));
      return r?.recoveryAction != null;
    });

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.workItemId, item.id));
    return { run: run!, item, registry, agentId: agent.agentId };
  }

  it('把恢复决策落到 Run 行上，而不是只塞进事件 payload', async () => {
    const { run } = await failedRun('context_insufficient');
    expect(run.recoveryAction).toBe('retry_with_context');
    expect(run.recoveryReason).toBeTruthy();
  });

  it('permission_denied 不自动重试，升级为决策', async () => {
    const { run, item, registry } = await failedRun('permission_denied');
    expect(run.recoveryAction).toBe('request_decision');

    // 该动作不退避，立刻可执行
    await db.update(agentRuns).set({ recoveryNotBefore: null }).where(eq(agentRuns.id, run.id));
    const outcomes = await runRecoveryRound(db, registry, { correlationId: randomUUID() });

    expect(outcomes[0]?.applied).toBe(true);
    const [after] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(after!.status).toBe('awaiting_decision');
  });

  it('可重试的错误在退避到点后自动重试，并产生第二个 Run', async () => {
    const { run, item, registry } = await failedRun('context_insufficient');

    await db.update(agentRuns).set({ recoveryNotBefore: null }).where(eq(agentRuns.id, run.id));
    const outcomes = await runRecoveryRound(db, registry, { correlationId: randomUUID() });

    expect(outcomes[0]?.applied).toBe(true);
    const runs = await db.select().from(agentRuns).where(eq(agentRuns.workItemId, item.id));
    expect(runs.length).toBe(2);
    expect(runs.some((r) => r.attempt === 2)).toBe(true);
  });

  /**
   * ★ 退避没到点就重试，等于把 decideRecovery 里的退避策略架空。
   */
  it('退避未到点时不执行', async () => {
    const { registry } = await failedRun('context_insufficient');
    const outcomes = await runRecoveryRound(db, registry, { correlationId: randomUUID() });
    expect(outcomes.length).toBe(0);
  });

  /**
   * ★ 每个动作只执行一次。重复执行的后果是两个 Agent 同时改同一份代码。
   */
  it('同一条恢复决策只执行一次', async () => {
    const { run, item, registry } = await failedRun('context_insufficient');
    await db.update(agentRuns).set({ recoveryNotBefore: null }).where(eq(agentRuns.id, run.id));

    await runRecoveryRound(db, registry, { correlationId: randomUUID() });
    await runRecoveryRound(db, registry, { correlationId: randomUUID() });

    const runs = await db.select().from(agentRuns).where(eq(agentRuns.workItemId, item.id));
    // 第一次重试产生第 2 个 Run；第二次 round 不该再产生第 3 个
    expect(runs.filter((r) => r.attempt === 2).length).toBe(1);
  });

  /**
   * ★ 人已经接手了就别插一脚 —— 自动恢复会打断人的处置。
   */
  it('任务已被人工处置（离开 failed）时跳过自动恢复', async () => {
    const { run, item, registry } = await failedRun('context_insufficient');
    await db.update(agentRuns).set({ recoveryNotBefore: null }).where(eq(agentRuns.id, run.id));
    await db.update(workItems).set({ status: 'executing' }).where(eq(workItems.id, item.id));

    const outcomes = await runRecoveryRound(db, registry, { correlationId: randomUUID() });
    expect(outcomes[0]?.applied).toBe(false);
    expect(outcomes[0]?.detail).toContain('人工处置');
  });

  /**
   * ★ 连续失败计数要在 Run **执行期间**改，不能在派发前改。
   *   baseline policy 有一条「consecutiveFailures >= 3 就不许自动派发」，
   *   派发前设好的话任务会被直接拦成 blocked，压根跑不到失败那一步 ——
   *   那测的就是 Policy，不是恢复策略了。
   */
  it('连续失败三次时暂停并升级，不再自动重试', async () => {
    const runtime = new MockRuntime(
      {},
      {
        steps: ['一步'],
        outcome: 'failed',
        error: { class: 'tool_failure', message: '模拟 tool_failure' },
        stepDelayMs: 120,
      },
    );
    const registry = new RuntimeRegistry();
    const agent = await seedAgent(db, fx, { runtime, registry });
    const item = await createWorkItem(db, fx, { status: 'ready' });

    await dispatchRun(db, registry, {
      workItemId: item.id,
      agentId: agent.agentId,
      correlationId: randomUUID(),
    });
    await db
      .update(workItems)
      .set({ consecutiveFailures: 4 })
      .where(eq(workItems.id, item.id));

    const run = await waitFor(async () => {
      const [r] = await db.select().from(agentRuns).where(eq(agentRuns.workItemId, item.id));
      return r?.recoveryAction != null ? r : null;
    });

    expect(run.recoveryAction).toBe('pause_and_escalate');
    // 升级类动作不设退避 —— 再压 60 秒只会让待办晚一分钟出现
    expect(run.recoveryNotBefore).toBeNull();
  });

  /**
   * ★ hasAlternativeAgent 曾被硬编码成 false，
   *   于是 switch_agent 这条分支永远不可达。
   */
  it('存在可替换 Agent 时 capability_mismatch 走改派而不是转人工', async () => {
    const runtime = new MockRuntime(
      {},
      {
        steps: ['一步'],
        outcome: 'failed',
        error: { class: 'capability_mismatch', message: '超出能力' },
        stepDelayMs: 0,
      },
    );
    const registry = new RuntimeRegistry();
    const primary = await seedAgent(db, fx, { runtime, registry, name: 'agent-a' });
    // 同一组织里的第二个 Agent，能接同类任务
    await seedAgent(db, fx, { runtime: new MockRuntime(), registry, name: 'agent-b' });

    const item = await createWorkItem(db, fx, { status: 'ready' });
    await dispatchRun(db, registry, {
      workItemId: item.id,
      agentId: primary.agentId,
      correlationId: randomUUID(),
    });

    await waitFor(async () => {
      const [r] = await db.select().from(agentRuns).where(eq(agentRuns.workItemId, item.id));
      return r?.recoveryAction != null;
    });

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.workItemId, item.id));
    expect(run!.recoveryAction).toBe('switch_agent');
    expect(run!.recoveryAgentId).not.toBeNull();
    expect(run!.recoveryAgentId).not.toBe(primary.agentId);
  });
});

/**
 * ★★ 运行时**拒收**派发，和运行时跑到一半失败，是两条完全不同的代码路径。
 *
 *   前者在真实部署里远比后者常见（缺凭证、没有可用工具、工作目录没准备好），
 *   而它此前没有任何测试：dispatch 只把 Run 标成 failed 就 return，
 *   工作项停在 executing 上，看板照样按 `status = 'executing'`
 *   数出「1 个 Agent 在跑」，而没有任何循环能再碰到它。
 *
 * Dispatch-time rejection is a different path from an in-flight failure, and
 * the far more common one in real deployments.
 */
describe('运行时拒收派发', () => {
  async function rejectedRun(reason = '工作目录没准备好') {
    const runtime = new MockRuntime({}, { rejectDispatch: reason });
    const registry = new RuntimeRegistry();
    const agent = await seedAgent(db, fx, { runtime, registry });
    const item = await createWorkItem(db, fx, { status: 'ready' });

    const result = await dispatchRun(db, registry, {
      workItemId: item.id,
      agentId: agent.agentId,
      correlationId: randomUUID(),
    });

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.workItemId, item.id));
    return { result, run: run!, item, registry };
  }

  it('工作项不会停在 executing 上', async () => {
    const { result, item } = await rejectedRun();

    expect(result.ok).toBe(false);

    const [after] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(after!.status).not.toBe('executing');
    expect(after!.status).toBe('failed');
  });

  it('Run 结算完整：failed + endedAt + 拒收理由', async () => {
    const { run } = await rejectedRun('缺少凭证');

    expect(run.status).toBe('failed');
    expect(run.errorClass).toBe('runtime_error');
    expect(run.errorMessage).toContain('缺少凭证');
    // ★ endedAt 为空的 failed Run 会让「跑了多久」永远算不出来
    expect(run.endedAt).not.toBeNull();
  });

  /** CLAUDE.md 第一条：状态变更必须产生事件 */
  it('状态变了就有对应事件 —— run_ended 与 agent_run.failed 都在', async () => {
    const { run } = await rejectedRun();

    const events = await db.select().from(runEvents).where(eq(runEvents.runId, run.id));
    expect(events.some((e) => e.type === 'run_ended')).toBe(true);

    const domain = await db.select().from(eventsTable).where(eq(eventsTable.subjectId, run.id));
    expect(domain.some((e) => e.type === 'agent_run.failed')).toBe(true);
  });

  it('拒收后交给恢复策略，不是无声停住', async () => {
    const { run } = await rejectedRun();
    const [after] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
    expect(after!.recoveryAction).not.toBeNull();
  });
});

/**
 * 兜底层：即便派发路径再出新漏洞，停在 executing 却没有活跃 Run 的
 * 工作项也必须能被收回来 —— 它是所有循环都够不着的那一类。
 */
describe('停在 executing 却没有活跃 Run 的工作项', () => {
  it('被 supervisor 收回并流转出 executing', async () => {
    const { run, item, registry } = await stuckRun();

    // 只结算 Run，不动工作项 —— 复现进程在两次写之间挂掉的现场
    await db
      .update(agentRuns)
      .set({ status: 'failed', endedAt: new Date() })
      .where(eq(agentRuns.id, run.id));

    const [before] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(before!.status).toBe('executing');

    const report = await superviseRuns(db, registry, { correlationId: randomUUID() });

    expect(report.strandedItems).toContain(item.id);
    const [after] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(after!.status).toBe('failed');
  });

  it('还在跑的 Run 不会被误收', async () => {
    const { item, registry } = await stuckRun();

    const report = await superviseRuns(db, registry, { correlationId: randomUUID() });

    expect(report.strandedItems).not.toContain(item.id);
    const [after] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(after!.status).toBe('executing');
  });
});
