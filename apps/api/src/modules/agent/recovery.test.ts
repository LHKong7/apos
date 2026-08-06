import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agentRuns, events, runEvents, workItems } from '@apos/db';
import { MockRuntime, RuntimeRegistry, classifyError } from '@apos/agent-runtimes';
import { createWorkItem, resetDb, seedFixture, testDb, type Fixture } from '../../test/db';
import { seedAgent, waitFor, waitForRunEnd } from '../../test/agent-fixtures';
import { scheduleRound } from '../flow/scheduler';
import { dispatchRun } from './dispatch';

const db = testDb();
let fx: Fixture;

beforeEach(async () => {
  await resetDb(db);
  fx = await seedFixture(db);
});

afterAll(async () => {
  await resetDb(db);
});

const corr = () => randomUUID();

async function runFailing(error: { class: string; message: string; selfReport?: string }) {
  const registry = new RuntimeRegistry();
  const runtime = new MockRuntime({}, { outcome: 'failed', error, steps: ['尝试'] });
  const agent = await seedAgent(db, fx, { registry, runtime });
  const item = await createWorkItem(db, fx, { estimatedCost: '2.0000' });

  await scheduleRound(db, registry, { projectId: fx.projectId, correlationId: corr() });
  const run = await waitForRunEnd(db, item.id);
  return { item, run, agent, registry, runtime };
}

describe('★ 失败恢复 —— 阶段 1 最容易被低估的环节', () => {
  it('失败的 Run 落库完整信息，任务流转到 failed', async () => {
    const { item, run } = await runFailing({
      class: 'context_insufficient',
      message: '无法定位订单表结构定义',
      selfReport: '我需要 orders 表的结构定义来设计索引，但在仓库中未找到 schema 文件。',
    });

    expect(run.status).toBe('failed');
    expect(run.errorClass).toBe('context_insufficient');
    // Agent 自述比堆栈有用得多 —— 它直接告诉人类该补什么
    expect(run.agentSelfReport).toContain('未找到 schema 文件');

    await waitFor(async () => {
      const [w] = await db.select().from(workItems).where(eq(workItems.id, item.id));
      return w?.status === 'failed' ? w : null;
    }, { label: '任务未流转到 failed' });

    const [after] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(after!.consecutiveFailures).toBe(1);
  });

  it('★ 恢复决策按错误分类分流，写进事件供追溯', async () => {
    const { item } = await runFailing({
      class: 'permission_denied',
      message: 'access denied: merge_pr',
    });

    const failedEvent = await waitFor(async () => {
      const rows = await db.select().from(events).where(eq(events.type, 'agent_run.failed'));
      return rows[0] ?? null;
    }, { label: '未产生 agent_run.failed 事件' });

    const recovery = failedEvent.payload['recovery'] as { action: string; decisionType?: string };
    // permission_denied 重试 100 次也不会成功，必须直接找人
    expect(recovery.action).toBe('request_decision');
    expect(recovery.decisionType).toBe('permission_request');
    expect(failedEvent.payload['workItemId'] ?? item.id).toBeTruthy();
  });

  it('上下文不足时首次建议补充上下文重试，而不是原样重试', async () => {
    await runFailing({ class: 'context_insufficient', message: 'missing context' });

    const failedEvent = await waitFor(async () => {
      const rows = await db.select().from(events).where(eq(events.type, 'agent_run.failed'));
      return rows[0] ?? null;
    });

    const recovery = failedEvent.payload['recovery'] as { action: string };
    expect(recovery.action).toBe('retry_with_context');
  });

  it('★ 重试时把上次失败原因带进新 Run 的上下文', async () => {
    const { item, agent, registry, runtime } = await runFailing({
      class: 'context_insufficient',
      message: '无法定位订单表结构定义',
      selfReport: '缺少 orders 表 schema',
    });

    await waitFor(async () => {
      const [w] = await db.select().from(workItems).where(eq(workItems.id, item.id));
      return w?.status === 'failed' ? w : null;
    });

    // 人工补充上下文后重试
    await db.update(workItems).set({ status: 'ready', stage: 'execution' }).where(eq(workItems.id, item.id));
    runtime.setScript('', {});

    const retry = await dispatchRun(db, registry, {
      workItemId: item.id,
      agentId: agent.agentId,
      correlationId: corr(),
      additionalContext: [{ title: 'orders 表结构说明', content: 'CREATE TABLE orders (...)' }],
    });

    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.attempt).toBe(2);

    const [newRun] = await db.select().from(agentRuns).where(eq(agentRuns.id, retry.runId));
    const context = newRun!.inputContext as { kind: string; title: string; content?: string }[];

    // 两类上下文都要在：人工补充的知识 + 上次失败的原因
    expect(context.some((c) => c.title === 'orders 表结构说明')).toBe(true);
    const prev = context.find((c) => c.kind === 'previous_run');
    expect(prev).toBeTruthy();
    expect(prev!.content).toContain('缺少 orders 表 schema');
  });

  it('★ 连续失败 3 次触发暂停升级，压过一切错误分类', async () => {
    const registry = new RuntimeRegistry();
    const runtime = new MockRuntime({}, {
      outcome: 'failed',
      error: { class: 'tool_failure', message: 'transient' },
      steps: ['尝试'],
    });
    const agent = await seedAgent(db, fx, { registry, runtime });
    const item = await createWorkItem(db, fx, { consecutiveFailures: 2 });

    await scheduleRound(db, registry, { projectId: fx.projectId, correlationId: corr() });
    await waitForRunEnd(db, item.id);

    const failedEvent = await waitFor(async () => {
      const rows = await db.select().from(events).where(eq(events.type, 'agent_run.failed'));
      return rows[0] ?? null;
    });

    const recovery = failedEvent.payload['recovery'] as { action: string };
    expect(recovery.action).toBe('pause_and_escalate');
    expect(failedEvent.payload['consecutiveFailures']).toBe(3);
  });
});

describe('幂等与重复投递', () => {
  it('★ 同一 (runId, seq) 重复投递只落一次', async () => {
    const agent = await seedAgent(db, fx);
    const item = await createWorkItem(db, fx);

    await scheduleRound(db, agent.registry, { projectId: fx.projectId, correlationId: corr() });
    const run = await waitForRunEnd(db, item.id);

    const before = await db.select().from(runEvents).where(eq(runEvents.runId, run.id));

    // 重放整条事件流
    const { ingestRunEvent } = await import('./ingest');
    for (const row of before) {
      await ingestRunEvent(db, {
        runId: run.id,
        event: row.payload as never,
        correlationId: corr(),
      });
    }

    const after = await db.select().from(runEvents).where(eq(runEvents.runId, run.id));
    expect(after.length).toBe(before.length);
  });

  it('★ 一个 Work Item 不能同时有两个活跃 Run', async () => {
    // 用带延迟的运行时保证第二次派发时首个 Run 仍在执行
    const registry = new RuntimeRegistry();
    const runtime = new MockRuntime({}, { steps: ['慢步骤'], stepDelayMs: 300 });
    const agent = await seedAgent(db, fx, { registry, runtime });
    const item = await createWorkItem(db, fx);

    const first = await dispatchRun(db, registry, {
      workItemId: item.id,
      agentId: agent.agentId,
      correlationId: corr(),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.reused).toBe(false);

    const second = await dispatchRun(db, registry, {
      workItemId: item.id,
      agentId: agent.agentId,
      correlationId: corr(),
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.reused).toBe(true);
    expect(second.runId).toBe(first.runId);

    // 没有产生第二个 Run —— 否则两个 Agent 会同时改同一份代码
    expect(await db.select().from(agentRuns)).toHaveLength(1);
  });

  it('前一次 Run 结束后，重新派发产生新的 attempt', async () => {
    const agent = await seedAgent(db, fx);
    const item = await createWorkItem(db, fx);

    const first = await dispatchRun(db, agent.registry, {
      workItemId: item.id,
      agentId: agent.agentId,
      correlationId: corr(),
    });
    expect(first.ok && first.attempt).toBe(1);

    await waitForRunEnd(db, item.id);
    await db.update(workItems).set({ status: 'ready', stage: 'execution' }).where(eq(workItems.id, item.id));

    const second = await dispatchRun(db, agent.registry, {
      workItemId: item.id,
      agentId: agent.agentId,
      correlationId: corr(),
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.reused).toBe(false);
    expect(second.attempt).toBe(2);
  });
});

describe('启发式错误分类（运行时不上报分类时的降级）', () => {
  it('从错误消息推断常见分类', () => {
    expect(classifyError('access denied: cannot merge')).toBe('permission_denied');
    expect(classifyError('operation timed out after 30s')).toBe('timeout');
    expect(classifyError('ECONNREFUSED 10.0.0.1:443')).toBe('external_unavailable');
    expect(classifyError('cost limit exceeded')).toBe('budget_exceeded');
    expect(classifyError('no such file or directory: schema.sql')).toBe('context_insufficient');
  });

  it('无法识别时返回 unknown 而不是猜一个', () => {
    expect(classifyError('something weird happened')).toBe('unknown');
  });
});
