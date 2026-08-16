import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { agentRuns, agents, repositories } from '@apos/db';
import type { ResourceScope } from '@apos/contracts';
import { RuntimeRegistry } from '@apos/agent-runtimes';
import { createWorkItem, seedFixture, testDb, type Fixture } from '../../test/db';
import { seedAgent } from '../../test/agent-fixtures';
import { dispatchRun } from './dispatch';
import { resolveExecutor } from './matching';

/**
 * 项目级仓库对项目内 Agent 默认只读，在**派发快照**里必须如实标注出处。
 *
 * ★ 这几条测的是「授权从哪来」这件事在库里留没留痕。纯判定规则的穷举在
 *   packages/domain/src/permissions/resource-scopes.test.ts。
 */
const db = testDb();
let fx: Fixture;

beforeEach(async () => {
  fx = await seedFixture(db);
});

async function registerRepo(over: Partial<typeof repositories.$inferInsert> = {}) {
  const [row] = await db
    .insert(repositories)
    .values({
      orgId: fx.orgId,
      projectId: fx.projectId,
      ref: 'order-service',
      name: 'Order Service',
      remoteUrl: 'https://example.invalid/order-service.git',
      defaultBranch: 'main',
      createdBy: fx.userId,
      ...over,
    })
    .returning();
  return row!;
}

async function snapshotFor(agentId: string, registry: RuntimeRegistry): Promise<ResourceScope[]> {
  const item = await createWorkItem(db, fx);
  const dispatched = await dispatchRun(db, registry, {
    workItemId: item.id,
    agentId,
    correlationId: randomUUID(),
  });
  if (!dispatched.ok) throw new Error(`派发失败：${dispatched.code}`);

  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, dispatched.runId));
  if (!run?.permissionSnapshot) throw new Error('Run 没有权限快照');
  return run.permissionSnapshot.resourceScopes;
}

describe('★ 项目级仓库的默认只读', () => {
  it('没配过任何范围的 Agent，快照里带上默认只读且标明出处', async () => {
    await registerRepo();
    const registry = new RuntimeRegistry();
    const agent = await seedAgent(db, fx, { registry });

    const scopes = await snapshotFor(agent.agentId, registry);

    expect(scopes).toContainEqual({
      kind: 'repo',
      ref: 'order-service',
      access: 'read',
      origin: 'project_default',
    });
  });

  /**
   * ★★ 出处不标出来的话，审计时「这个 Agent 当时能读这个仓库」有两种读法 ——
   *   管理员授了权，还是平台默认给的。事后追责最需要区分的正是这两者。
   */
  it('显式配的授权标成 explicit，与默认档在快照里分得开', async () => {
    await registerRepo();
    const registry = new RuntimeRegistry();
    const agent = await seedAgent(db, fx, { registry });
    await db
      .update(agents)
      .set({ resourceScopes: [{ kind: 'repo', ref: 'order-service', access: 'write' }] })
      .where(eq(agents.id, agent.agentId));

    const scopes = await snapshotFor(agent.agentId, registry);

    expect(scopes).toContainEqual({
      kind: 'repo',
      ref: 'order-service',
      access: 'write',
      origin: 'explicit',
    });
    expect(scopes.some((s) => s.origin === 'project_default')).toBe(false);
  });

  it('org 级仓库不参与默认 —— 跨项目的授权必须是个决定', async () => {
    await registerRepo({ projectId: null, ref: 'shared-lib' });
    const registry = new RuntimeRegistry();
    const agent = await seedAgent(db, fx, { registry });

    const scopes = await snapshotFor(agent.agentId, registry);

    expect(scopes.some((s) => s.ref === 'shared-lib')).toBe(false);
  });

  /**
   * ★★ 候选筛选与派发必须用同一份生效范围。
   *   两边不一致的表现是「调度器说没有候选，而真派下去其实能跑」，
   *   而候选面板给出的理由会把人指去逐个 Agent 配授权 —— 那件事平台已经做了。
   */
  it('候选筛选认这条默认，不会把需要该仓库的任务判成无人可派', async () => {
    await registerRepo();
    const registry = new RuntimeRegistry();
    const agent = await seedAgent(db, fx, { registry });
    const item = await createWorkItem(db, fx, {
      typeData: { requiredResources: ['order-service'] },
    });

    const result = await resolveExecutor(db, item);

    /**
     * ★ 正面断言它进了候选，而不是只断言「没出现某条拒绝理由」——
     *   后者在候选列表整个为空时也是绿的，测不出任何东西。
     */
    expect(result.candidates.map((c) => c.agentId)).toContain(agent.agentId);
    expect(result.rejected.some((r) => r.reason.includes('资源范围里没有'))).toBe(false);
  });

  it('未登记的资源仍然要拦 —— 默认档只覆盖已登记的项目级仓库', async () => {
    const registry = new RuntimeRegistry();
    const agent = await seedAgent(db, fx, { registry });
    const item = await createWorkItem(db, fx, {
      typeData: { requiredResources: ['never-registered'] },
    });

    const result = await resolveExecutor(db, item);

    expect(result.candidates.map((c) => c.agentId)).not.toContain(agent.agentId);
    expect(result.rejected.some((r) => r.reason.includes('never-registered'))).toBe(true);
  });
});
