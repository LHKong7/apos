import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { policies } from '@apos/db';
import type { TaskDispatch } from '@apos/contracts';
import { createWorkItem, seedFixture, testDb, type Fixture } from '../../test/db';
import { seedAgent } from '../../test/agent-fixtures';
import { dispatchRun } from './dispatch';

/**
 * Ship "what will get you stopped" along with the dispatch / 派发时下发哪些情形会被拦下。
 *
 * ★★ This suite tests the **wiring**, not the selection rules themselves — those are enumerated
 *   in packages/domain/src/policy/gates.test.ts.
 *
 *   Break the wiring anywhere (an unfilled contract field, a context snapshot that never got
 *   plugged in, rules that were not all loaded) and the symptom is identical: the Agent receives
 *   an empty gate list, starts work as usual, and then freezes at the transition step. Nothing
 *   along that chain throws and every test stays green — which is why the assertions have to read
 *   values off the TaskDispatch that was actually handed out.
 *
 *   这组测的是接线，不是筛选规则本身。接线断在任何一处，表现都是 Agent 收到空清单、
 *   照常开工、在流转那步被冻住，全程无报错 —— 所以必须从真正下发的 TaskDispatch 上断言。
 */
const db = testDb();
let fx: Fixture;

beforeEach(async () => {
  fx = await seedFixture(db);
});

/**
 * Two high-risk rules shaped like real ones / 两条真实形状的高风险规则。
 *
 * ★★ The platform no longer ships hard-coded baselines — with no rules in the database, an empty
 *   gate list is the correct answer. So this suite has to create its own rules first; otherwise
 *   it is testing "what happens with no rules at all", which proves nothing about the wiring.
 *
 *   平台不再自带硬编码基线，库里没规则时清单本来就该是空的，所以这里必须自己先建规则。
 */
async function seedGovernanceRules() {
  await db.insert(policies).values([
    {
      orgId: fx.orgId,
      projectId: null,
      name: '生产环境发布需发布负责人审批',
      description: '',
      priority: 8,
      enabled: true,
      createdBy: fx.userId,
      condition: {
        all: [
          { fact: 'environment', op: 'eq', value: 'production' },
          { fact: 'operationType', op: 'eq', value: 'deploy' },
        ],
      },
      action: {
        type: 'require_human_review',
        assignee: { kind: 'role', role: 'release_manager' },
        dueInHours: 4,
      },
    },
    {
      orgId: fx.orgId,
      projectId: null,
      name: '生产数据库变更必须由 DBA 审批',
      description: '',
      priority: 5,
      enabled: true,
      createdBy: fx.userId,
      condition: {
        all: [
          { fact: 'environment', op: 'eq', value: 'production' },
          { fact: 'operationType', op: 'in', value: ['db_ddl', 'db_dml'] },
        ],
      },
      action: { type: 'require_human_review', assignee: { kind: 'role', role: 'dba' }, dueInHours: 4 },
    },
  ]);
}

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
   * ★ At dispatch time operationType is still the default code_change and environment is still
   *   null, so evaluating against the current context hits neither rule. This test watches
   *   whether the "an undetermined fact counts as possible" semantics survives the whole chain.
   *
   *   派发时两条规则按当前上下文都不命中，这条盯的是「未定的 fact 按可能处理」有没有
   *   活着穿过整条链路。
   */
  it('★ 会拦人的规则要到达 Agent', async () => {
    await seedGovernanceRules();
    const task = await dispatchedTask();
    const names = task.policyGates.map((g) => g.name);

    expect(names).toContain('生产环境发布需发布负责人审批');
    expect(names).toContain('生产数据库变更必须由 DBA 审批');
  });

  /** ★ With no rules at all the list is empty — not "some default list" / 不是一份默认清单 */
  it('★ 库里没有规则时下发空清单', async () => {
    const task = await dispatchedTask();
    expect(task.policyGates).toEqual([]);
  });

  it('带上渲染好的人话，Agent 不需要自己解释规则', async () => {
    await seedGovernanceRules();
    const task = await dispatchedTask();
    const deploy = task.policyGates.find((g) => g.name === '生产环境发布需发布负责人审批');

    expect(deploy?.explanation).toContain('操作环境是生产');
    expect(deploy?.explanation).toContain('发布负责人');
  });

  /**
   * ★ Rules a project configured for itself must go out too. Ship only org-level rules and
   *   everything the user wrote on the Policy page simply does not exist for the Agent — and
   *   that is exactly the part they most wanted the Agent to know.
   *
   *   只发组织级规则的话，用户在 Policy 页上写的东西对 Agent 完全不存在。
   */
  it('★ 项目级规则与组织级规则一起下发', async () => {
    await seedGovernanceRules();
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
   * ★ Auto-allow rules must not appear. They carry no actionable meaning for an Agent, and a
   *   longer list dilutes the few entries that will actually stop it.
   *
   *   自动放行的规则对 Agent 没有可执行含义，清单一长就把真正会拦人的那几条稀释了。
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
