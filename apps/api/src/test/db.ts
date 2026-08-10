import { IntegrationRegistry, MemoryIntegrationAdapter } from '@apos/integrations';
import type { IntegrationProvider } from '@apos/contracts';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  createDatabase,
  organizations,
  projectMembers,
  projects,
  users,
  workItems,
  type Database,
} from '@apos/db';
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
      agent_runs, agent_permission_changes, agents,
      repositories, project_conventions,
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
  /**
   * ★ 夹具身份 = 项目 tech_lead + 组织管理员，与 seed-dev 里的「张伟」一致。
   *
   *   功能测试不该同时是权限测试：让夹具身份权限充足，
   *   「录需求 → 批计划 → 派发」这条链路才验证的是流程本身，
   *   而不是「这个角色能不能做第三步」。
   *
   * ★ 但夹具也不能因此比真实数据宽松（成员关系那条的教训见下）——
   *   所以权限相关的断言一律用 {@link createMember} 造明确角色的人，
   *   绝不复用这个身份。用它去测「viewer 不能改」只会永远是绿的。
   */
  const [user] = await db
    .insert(users)
    .values({
      orgId: org!.id,
      email: `u-${randomUUID()}@acme.dev`,
      name: '张伟',
      orgRole: 'org_admin',
    })
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

  /**
   * ★ 夹具必须建成员关系。
   *
   *   在此之前这里只写了 project.techLeadId，没有 project_members 行 ——
   *   也就是说夹具里的用户从来不是这个项目的成员。测试能过，
   *   只是因为服务端当时根本没查过成员关系（09-security §2.1 的第②层没实现）。
   *   夹具一旦比真实数据宽松，它就不再能证明真实路径是通的，
   *   反而会把漏洞焊死：补上检查时，先红的是测试而不是产品。
   */
  await db.insert(projectMembers).values({
    projectId: project!.id,
    actorType: 'human',
    actorId: user!.id,
    role: 'tech_lead',
  });

  return { orgId: org!.id, userId: user!.id, projectId: project!.id };
}

/** 造一个「不是本项目成员」的用户，用于验证越权被挡下 */
export async function createOutsider(db: Database, fx: Fixture) {
  const [org] = await db.insert(organizations).values({ name: 'Other Corp' }).returning();
  const [user] = await db
    .insert(users)
    .values({ orgId: org!.id, email: `outsider-${randomUUID()}@other.dev`, name: '外部人员' })
    .returning();
  return { orgId: org!.id, userId: user!.id, projectId: fx.projectId };
}

/**
 * 造一个角色明确的本组织用户。
 *
 * ★ 权限断言必须用它，不能用夹具身份 —— 夹具是组织管理员，
 *   拿它去测「谁不能做什么」永远是绿的。
 *
 * `projectRole` 传 null 表示「本组织但不是这个项目的成员」，
 * 用来区分「跨组织越权」与「同组织但没被加进项目」这两种情况。
 */
export async function createMember(
  db: Database,
  fx: Fixture,
  opts: {
    projectRole?: 'sponsor' | 'tech_lead' | 'pm' | 'member' | 'viewer' | null;
    orgRole?: 'org_admin' | 'member';
    name?: string;
  } = {},
): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      orgId: fx.orgId,
      email: `m-${randomUUID()}@acme.dev`,
      name: opts.name ?? opts.projectRole ?? 'member',
      orgRole: opts.orgRole ?? 'member',
    })
    .returning();

  const role = opts.projectRole === undefined ? 'member' : opts.projectRole;
  if (role !== null) {
    await db
      .insert(projectMembers)
      .values({ projectId: fx.projectId, actorType: 'human', actorId: user!.id, role });
  }
  return user!.id;
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

/**
 * 集成适配器注册表（测试用）。
 *
 * 进程内适配器就是真实实现的执行体 —— 拉取、回写、来源标记都真的发生，
 * 只是对面是一个 Map 而不是 github.com。测试拿到的是同一套代码路径。
 */
export function integrationRegistry(
  providers: readonly IntegrationProvider[] = ['jira', 'github', 'slack'],
): IntegrationRegistry {
  const registry = new IntegrationRegistry();
  for (const p of providers) registry.register(new MemoryIntegrationAdapter(p));
  return registry;
}

/** 拿到某个 provider 的进程内适配器，用来模拟「外部有人手改了字段」 */
export function memoryAdapter(
  registry: IntegrationRegistry,
  provider: IntegrationProvider,
): MemoryIntegrationAdapter {
  return registry.get(provider) as MemoryIntegrationAdapter;
}
