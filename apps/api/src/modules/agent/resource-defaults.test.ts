import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { agentRuns, repositories } from '@apos/db';
import type { ResourceScope } from '@apos/contracts';
import { RuntimeRegistry } from '@apos/agent-runtimes';
import { createWorkItem, seedFixture, testDb, type Fixture } from '../../test/db';
import { seedAgent } from '../../test/agent-fixtures';
import { dispatchRun } from './dispatch';
import { resolveExecutor } from './matching';

/**
 * A project-level repository is read-only by default for Agents in that project, and the
 * **dispatch snapshot** has to record truthfully where that access came from.
 *
 * ★ These cases test whether "where did this authorization come from" leaves a trace in the
 *   database. The exhaustive enumeration of the decision rules themselves lives in
 *   packages/domain/src/permissions/resource-scopes.test.ts.
 *
 *   项目级仓库对项目内 Agent 默认只读，派发快照里必须如实标注出处；这几条测的是
 *   「授权从哪来」有没有在库里留痕。
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

describe('★ 项目级仓库的默认档', () => {
  /**
   * ★★ 零配置建出来的 Agent 必须拿到一个**可写**的工作区。
   *
   *   默认档位以前恒定是 read，而默认档案（full_project）是有 workspace.write
   *   的 —— 两句话对不上的表现是 Agent 在一个改不动的目录里开工，
   *   然后报告「未找到相关代码，已创建新实现」，而管理员在配置页上
   *   看不出哪里配漏了：因为哪儿都没配漏，是默认值自相矛盾。
   *
   *   出处那一栏照旧标 project_default —— 审计要分得出「管理员授的权」
   *   和「平台默认给的」，这一条不因为档位变了而模糊。
   */
  it('★ 没配过任何范围的 Agent，快照里是可写的项目仓库，且标明是平台默认给的', async () => {
    await registerRepo();
    const registry = new RuntimeRegistry();
    const agent = await seedAgent(db, fx, { registry });

    const scopes = await snapshotFor(agent.agentId, registry);

    expect(scopes).toContainEqual({
      kind: 'repo',
      ref: 'order-service',
      access: 'write',
      origin: 'project_default',
    });
  });

  /** ★ 收窄过的 Agent 走反方向：只读档案下同一条默认范围留在 read */
  it('★ 只读档案的 Agent，同一条默认范围留在只读', async () => {
    await registerRepo();
    const registry = new RuntimeRegistry();
    const agent = await seedAgent(db, fx, {
      registry,
      grant: { profileKey: 'readonly_reviewer' },
    });

    const scopes = await snapshotFor(agent.agentId, registry);

    expect(scopes).toContainEqual({
      kind: 'repo',
      ref: 'order-service',
      access: 'read',
      origin: 'project_default',
    });
  });

  /**
   * ★★ Without the origin recorded, "this Agent could read that repository at the time" has two
   *   readings during an audit — an administrator granted it, or the platform handed it over by
   *   default. Telling those two apart is exactly what accountability after the fact needs.
   *
   *   出处不标出来，审计时分不清是管理员授的权还是平台默认给的。
   */
  it('显式配的授权标成 explicit，与默认档在快照里分得开', async () => {
    await registerRepo();
    const registry = new RuntimeRegistry();
    /** ★ Explicit grants now live on the **project**, no longer on the org-level Agent
     *  显式授权现在配在项目里，不再挂在组织级 Agent 上 */
    const agent = await seedAgent(db, fx, {
      registry,
      grant: { resourceScopes: [{ kind: 'repo', ref: 'order-service', access: 'write' }] },
    });

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
   * ★★ Candidate filtering and dispatch must use the same effective scopes.
   *   When the two disagree the symptom is "the scheduler says there is no candidate, yet
   *   dispatching by hand actually runs", and the reason shown on the candidate panel sends the
   *   user off to grant that access on each Agent one by one — something the platform already did.
   *
   *   两边不一致会让人去做一件平台已经替他做完的事。
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
     * ★ Assert positively that it made the candidate list, rather than only asserting that some
     *   rejection reason is absent — the latter stays green when the candidate list is entirely
     *   empty, which proves nothing.
     *
     *   只断言「没出现某条拒绝理由」的话，候选列表整个为空时也是绿的。
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
