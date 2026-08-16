import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { policies } from '@apos/db';
import type { TaskDispatch } from '@apos/contracts';
import { createWorkItem, seedFixture, testDb, type Fixture } from '../../test/db';
import { seedAgent } from '../../test/agent-fixtures';
import { dispatchRun } from './dispatch';

/**
 * 派发时下发「哪些情形会被拦下」。
 *
 * ★★ 这组测的是**接线**，不是筛选规则本身 —— 后者在
 *   packages/domain/src/policy/gates.test.ts 里穷举。
 *
 *   接线断在任何一处（契约字段没填、上下文快照没接上、规则没加载全），
 *   表现都是同一个：Agent 收到一份空的闸门清单，照常开工，然后在流转那步
 *   被冻住。整条链路上不会有任何报错，测试也全绿 —— 所以必须从
 *   真正下发出去的那份 TaskDispatch 上取值来断言。
 */
const db = testDb();
let fx: Fixture;

beforeEach(async () => {
  fx = await seedFixture(db);
});

async function dispatchedTask(): Promise<TaskDispatch> {
  const agent = await seedAgent(db, fx);
  const item = await createWorkItem(db, fx);

  const dispatched = await dispatchRun(db, agent.registry, {
    workItemId: item.id,
    agentId: agent.agentId,
    correlationId: randomUUID(),
  });
  if (!dispatched.ok) throw new Error(`派发失败：${dispatched.code}`);

  const task = agent.runtime.dispatchedTask(dispatched.runId);
  if (!task) throw new Error('运行时没收到派发任务');
  return task;
}

describe('派发时下发 Policy 闸门', () => {
  /**
   * ★ 派发时 operationType 还是默认的 code_change、environment 还是 null，
   *   照当前上下文直接求值的话八条基线规则一条都不命中。这条盯的正是
   *   「未定的 fact 按可能处理」这个语义有没有活着穿过整条链路。
   */
  it('★ 基线规则里会拦人的那几条要到达 Agent', async () => {
    const task = await dispatchedTask();
    const names = task.policyGates.map((g) => g.name);

    expect(names).toContain('生产环境发布需发布负责人审批');
    expect(names).toContain('生产数据库变更必须由 DBA 审批');
  });

  it('带上渲染好的人话，Agent 不需要自己解释规则', async () => {
    const task = await dispatchedTask();
    const deploy = task.policyGates.find((g) => g.name === '生产环境发布需发布负责人审批');

    expect(deploy?.explanation).toContain('操作环境是生产');
    expect(deploy?.explanation).toContain('发布负责人');
  });

  /**
   * ★ 项目自己配的规则也要进 —— 只发基线的话，用户在 Policy 页上写的东西
   *   对 Agent 完全不存在，而那恰恰是他最想让 Agent 知道的部分。
   */
  it('★ 项目级规则与基线一起下发', async () => {
    await db.insert(policies).values({
      orgId: fx.orgId,
      projectId: fx.projectId,
      name: '改支付文案要法务确认',
      description: '',
      priority: 120,
      enabled: true,
      createdBy: fx.userId,
      condition: { fact: 'externalFacing', op: 'eq', value: true },
      action: {
        type: 'require_human_review',
        assignee: { kind: 'project_role', role: 'pm' },
        dueInHours: 8,
      },
    });

    const task = await dispatchedTask();
    expect(task.policyGates.map((g) => g.name)).toContain('改支付文案要法务确认');
  });

  it('停用的项目规则不下发', async () => {
    await db.insert(policies).values({
      orgId: fx.orgId,
      projectId: fx.projectId,
      name: '这条停用了',
      description: '',
      priority: 121,
      enabled: false,
      createdBy: fx.userId,
      condition: { fact: 'externalFacing', op: 'eq', value: true },
      action: { type: 'pause', resumeCondition: 'human_decision' },
    });

    const task = await dispatchedTask();
    expect(task.policyGates.map((g) => g.name)).not.toContain('这条停用了');
  });

  /**
   * ★ 自动放行的规则不该出现。它对 Agent 没有任何可执行含义，
   *   而清单一长，真正会拦人的那几条就被稀释了。
   */
  it('自动放行的规则不下发', async () => {
    await db.insert(policies).values({
      orgId: fx.orgId,
      projectId: fx.projectId,
      name: '低风险自动放行',
      description: '',
      priority: 119,
      enabled: true,
      createdBy: fx.userId,
      condition: { fact: 'riskLevel', op: 'lte', value: 'low' },
      action: { type: 'allow' },
    });

    const task = await dispatchedTask();
    expect(task.policyGates.map((g) => g.name)).not.toContain('低风险自动放行');
  });
});
