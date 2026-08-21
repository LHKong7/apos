import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { artifacts, policies, workItems } from '@apos/db';
import { SYSTEM_ACTOR } from '@apos/contracts';
import { AgentPlanOutput } from '../planning/agent-output';
import { createWorkItem, resetDb, seedFixture, testDb, type Fixture } from '../../test/db';
import { transition } from './transition';

/**
 * 认不出来的 fact 取值一律拒收（§6.1）。
 *
 * ★★ 这一组守的是安全底线上的一个口子，而它的危险之处全在于**无声**。
 *
 *   `operationType` 以前是一次裸的 `as` 断言 + 一个 `?? 'code_change'` 兜底。
 *   于是模型（或某个手抖的写入口）写下 `"delete_resrouce"` —— 拼错一个
 *   字母 —— 那个值会原样进到 Policy 上下文里，`NEVER_AUTO_APPROVE`
 *   认不出它，「删资源永远不自动放行」就被整条绕过去了。
 *
 *   现场毫无迹象：任务照常跑完，规则一条都没命中，事件里那份上下文快照
 *   看起来也很正常。这类问题不会被发现，只会在某天被撞上。
 *
 * ★ 兜底成 `code_change` 同样不行 —— 那是往**宽**的一侧猜。
 *   一个我们读不懂的操作类型意味着这个任务此刻无法被治理，
 *   而无法治理时唯一说得过去的做法是停下来喊一声。
 */
const db = testDb();
let fx: Fixture;

beforeEach(async () => {
  await resetDb(db);
  fx = await seedFixture(db);
});

afterAll(async () => {
  await resetDb(db);
});

async function withArtifact(itemId: string) {
  await db.insert(artifacts).values({
    orgId: fx.orgId,
    projectId: fx.projectId,
    workItemId: itemId,
    kind: 'code',
    title: 'diff',
    producedByType: 'agent',
  });
}

const complete = (itemId: string) =>
  transition(db, {
    workItemId: itemId,
    trigger: 'agent_run_completed',
    actor: SYSTEM_ACTOR,
    correlationId: randomUUID(),
  });

describe('★ 认不出来的 operationType 不静默兜底', () => {
  it('★ 拼错的操作类型让评估停下来，而不是当成改代码放过去', async () => {
    const item = await createWorkItem(db, fx, {
      status: 'executing',
      typeData: { operationType: 'delete_resrouce' },
    });
    await withArtifact(item.id);

    await expect(complete(item.id)).rejects.toThrow(/operationType/);

    // 状态没动 —— 读不懂的任务不该被推着往前走
    const [after] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(after!.status).toBe('executing');
  });

  it('拼错的 environment 同样拒收', async () => {
    const item = await createWorkItem(db, fx, {
      status: 'executing',
      typeData: { operationType: 'deploy', environment: 'prod' },
    });
    await withArtifact(item.id);

    await expect(complete(item.id)).rejects.toThrow(/environment/);
  });

  it('没写 operationType 时照旧按「改代码」评估 —— 缺省与拼错是两回事', async () => {
    const item = await createWorkItem(db, fx, { status: 'executing' });
    await withArtifact(item.id);

    const result = await complete(item.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verdict.contextSnapshot.operationType).toBe('code_change');
  });

  /**
   * ★★ 正确拼写时安全底线仍然生效 —— 这条与上面那条是一对：
   *   一条证明「拼错了拦得住」，一条证明「拼对了拦得住」。
   *   少了后者，前者可能只是因为什么都没跑起来。
   */
  it('★ 拼对的 delete_resource 被安全底线拦下', async () => {
    const item = await createWorkItem(db, fx, {
      status: 'executing',
      typeData: { operationType: 'delete_resource' },
    });
    await withArtifact(item.id);

    const result = await complete(item.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verdict.requiresHuman).toBe(true);
    expect(result.to).toBe('awaiting_decision');
  });

  /**
   * ★ 规划阶段补上来的 dataSensitivity / externalFacing 要能被规则读到。
   *   这两项此前没有任何生产者：规则写着「访问受限数据要审批」，
   *   而 fact 永远是 null —— 规则看起来配好了，实际是死的。
   */
  it('★ dataSensitivity / externalFacing 进得了上下文，规则命得中', async () => {
    const [rule] = await db
      .insert(policies)
      .values({
        orgId: fx.orgId,
        projectId: fx.projectId,
        name: '受限数据要数据负责人批',
        description: '',
        priority: 100,
        enabled: true,
        createdBy: fx.userId,
        condition: { fact: 'dataSensitivity', op: 'eq', value: 'restricted' },
        action: {
          type: 'require_human_review',
          assignee: { kind: 'role', role: 'data_owner' },
          dueInHours: 8,
        },
      })
      .returning({ id: policies.id });

    const item = await createWorkItem(db, fx, {
      status: 'executing',
      typeData: { dataSensitivity: 'restricted', externalFacing: true },
    });
    await withArtifact(item.id);

    const result = await complete(item.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verdict.matchedPolicyId).toBe(rule!.id);
    expect(result.verdict.contextSnapshot.externalFacing).toBe(true);
  });
});

/**
 * 计划输出里的枚举 —— 拒收发生在解析那一步，也就是重试 / 澄清还来得及的地方。
 */
describe('★ 计划输出里的枚举严格校验', () => {
  const plan = (task: Record<string, unknown>) => ({
    tasks: [
      {
        ref: 't1',
        title: '一个任务',
        description: '描述',
        type: 'task',
        phase: '开发',
        estimatedHours: 4,
        estimatedTokens: 1000,
        riskLevel: 'low',
        ...task,
      },
    ],
    milestones: [],
    risks: [],
  });

  it('★ 拼错的 operationType 让整份计划解析失败', () => {
    const bad = AgentPlanOutput.safeParse(plan({ operationType: 'delete_resrouce' }));
    expect(bad.success).toBe(false);
  });

  it('★ 自造的 environment 让整份计划解析失败', () => {
    expect(AgentPlanOutput.safeParse(plan({ environment: 'prod' })).success).toBe(false);
  });

  it('拼对的值照常通过，并带上新增的两项 fact', () => {
    const ok = AgentPlanOutput.safeParse(
      plan({
        operationType: 'deploy',
        environment: 'production',
        dataSensitivity: 'restricted',
        externalFacing: true,
      }),
    );
    expect(ok.success).toBe(true);
    expect(ok.data!.tasks[0]!.dataSensitivity).toBe('restricted');
    expect(ok.data!.tasks[0]!.externalFacing).toBe(true);
  });

  it('三项都不填也通过 —— 它们是可选的，缺省与拼错是两回事', () => {
    expect(AgentPlanOutput.safeParse(plan({})).success).toBe(true);
  });
});
