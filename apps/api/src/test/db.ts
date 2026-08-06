import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDatabase, organizations, projects, users, workItems, type Database } from '@apos/db';
import { STATUS_STAGE, type WorkItemStatus } from '@apos/contracts';

/**
 * ★ 默认指向 apos_test，绝不是开发库。
 *
 * resetDb 会 TRUNCATE 全表 —— 默认值一旦和 DATABASE_URL 相同，
 * 跑一次测试就把正在调试的数据清空，而且现象是「页面突然 404」，
 * 很难第一时间联想到是测试干的。
 */
export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://apos@localhost:5433/apos_test';

let cached: Database | null = null;

export function testDb(): Database {
  cached ??= createDatabase({ url: TEST_DATABASE_URL, singleConnection: true });
  return cached;
}

/** 每个测试文件跑前清空业务表。顺序按外键依赖倒序。 */
export async function resetDb(db: Database) {
  await db.execute(sql`
    TRUNCATE TABLE
      events, run_events, artifacts,
      decision_approvals, decision_evidence, decision_options, decisions,
      agent_runs, agent_permission_changes, agents, agent_runtimes,
      work_item_dependencies, work_items, plans,
      requirement_assumptions, requirement_clarifications, requirements,
      policy_versions, policies,
      project_members, projects, users, organizations
    RESTART IDENTITY CASCADE
  `);
}

export interface Fixture {
  orgId: string;
  userId: string;
  projectId: string;
}

export async function seedFixture(
  db: Database,
  overrides: { autonomyLevel?: 'human_led' | 'agent_led_approval' | 'agent_autonomous' } = {},
): Promise<Fixture> {
  const [org] = await db.insert(organizations).values({ name: 'Acme' }).returning();
  const [user] = await db
    .insert(users)
    .values({ orgId: org!.id, email: `u-${randomUUID()}@acme.dev`, name: '张伟' })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({
      orgId: org!.id,
      name: '订单系统重构',
      techLeadId: user!.id,
      autonomyLevel: overrides.autonomyLevel ?? 'agent_led_approval',
      budgetAmount: '500.00',
    })
    .returning();

  return { orgId: org!.id, userId: user!.id, projectId: project!.id };
}

export async function createWorkItem(
  db: Database,
  fx: Fixture,
  overrides: Partial<typeof workItems.$inferInsert> = {},
) {
  const status = (overrides.status ?? 'ready') as WorkItemStatus;
  const [item] = await db
    .insert(workItems)
    .values({
      orgId: fx.orgId,
      projectId: fx.projectId,
      type: 'task',
      status,
      stage: STATUS_STAGE[status],
      title: '实现多条件查询 API',
      riskLevel: 'low',
      // 默认未分配 —— 真实路径是计划生成未分配的任务，由 Scheduler 匹配执行主体
      ...overrides,
    })
    .returning();
  return item!;
}
