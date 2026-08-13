import { IntegrationRegistry, MemoryIntegrationAdapter } from '@apos/integrations';
import type { IntegrationProvider } from '@apos/contracts';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  createDatabase,
  organizationMembers,
  organizations,
  projectMembers,
  projects,
  users,
  workItems,
  type Database,
} from '@apos/db';
import { STATUS_STAGE, type WorkItemStatus } from '@apos/contracts';
import { syncBuiltinRoles } from '../http/roles';
import { signToken } from '../modules/auth';
import { allocateNumbers } from '../modules/work-item/numbering';

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
      repositories, storage_targets, project_conventions,
      work_item_dependencies, work_items, plans,
      requirement_assumptions, requirement_clarifications, requirements,
      policy_versions, policies,
      project_members, roles, projects, organization_members, users, organizations
    RESTART IDENTITY CASCADE
  `);
}

export interface Fixture {
  orgId: string;
  userId: string;
  projectId: string;
}

/**
 * 测试用的认证头。
 *
 * ★★ 测试必须走**真实的**认证路径 —— 也就是一张签名过的令牌，
 *   而不是某个「测试模式」旁路。旁路一旦存在，它就成了唯一没被
 *   测过的那条路径，而它恰恰是鉴权的入口。
 *
 * ★ 用 signToken 而不是手写字符串：签名算法、声明字段、过期时间
 *   任何一处改了，测试跟着变，不需要改这里。
 */
export function auth(userId: string): Record<string, string> {
  return { authorization: `Bearer ${signToken(userId)}` };
}

export async function seedFixture(
  db: Database,
  overrides: { autonomyLevel?: 'human_led' | 'agent_led_approval' | 'agent_autonomous' } = {},
): Promise<Fixture> {
  const [org] = await db
    .insert(organizations)
    .values({ name: 'Acme', slug: `acme-${randomUUID().slice(0, 8)}` })
    .returning();
  /**
   * ★★ 建组织就要预置内置角色。
   *
   *   成员表对 roles 有外键 —— 不预置的话，插第一条成员就报约束错误，
   *   而报错信息是「违反外键」，看不出真正的原因是「这个组织还没有角色」。
   *   真实路径（createOrganization / 迁移）同样会做这一步，
   *   夹具跳过它就等于测的不是真实形态。
   */
  await syncBuiltinRoles(db, org!.id);
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
    .values({ email: `u-${randomUUID()}@acme.dev`, name: '张伟' })
    .returning();
  /**
   * ★ 归属与组织角色在 organization_members —— 账号本身不属于任何组织。
   *   漏了这一行的表现是每个请求都 401「还不属于任何组织」。
   */
  await db
    .insert(organizationMembers)
    .values({ orgId: org!.id, userId: user!.id, orgRole: 'org_admin' });
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
    orgId: org!.id,
    projectId: project!.id,
    actorType: 'human',
    actorId: user!.id,
    role: 'tech_lead',
  });

  return { orgId: org!.id, userId: user!.id, projectId: project!.id };
}

/**
 * 造一个「不是本项目成员」的用户，用于验证越权被挡下。
 *
 * ★★ `orgRole: 'org_admin'` 是测跨组织越权时**必须**传的。
 *
 *   默认的 member 在权限矩阵那一层就被挡下了，于是断言 404 的测试
 *   不管产品代码查不查组织都是绿的 —— 它测的是权限，不是租户边界。
 *   要证明边界本身成立，越界的那个人得在**自己组织**里权限拉满：
 *   自助注册默认开着，注册即是新组织的 org_admin，所以这既是最强的
 *   攻击者，也是最现实的那一个。
 */
export async function createOutsider(
  db: Database,
  fx: Fixture,
  opts: { orgRole?: 'org_admin' | 'member' } = {},
) {
  const [org] = await db
    .insert(organizations)
    .values({ name: 'Other Corp', slug: `other-${randomUUID().slice(0, 8)}` })
    .returning();
  const [user] = await db
    .insert(users)
    .values({ email: `outsider-${randomUUID()}@other.dev`, name: '外部人员' })
    .returning();
  await db
    .insert(organizationMembers)
    .values({ orgId: org!.id, userId: user!.id, orgRole: opts.orgRole ?? 'member' });
  await syncBuiltinRoles(db, org!.id);
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
    /** 内置角色或组织自定义角色的 key；null 表示「本组织但不是这个项目的成员」 */
    projectRole?: string | null;
    orgRole?: 'org_admin' | 'member';
    name?: string;
  } = {},
): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `m-${randomUUID()}@acme.dev`,
      name: opts.name ?? opts.projectRole ?? 'member',
    })
    .returning();
  await db
    .insert(organizationMembers)
    .values({ orgId: fx.orgId, userId: user!.id, orgRole: opts.orgRole ?? 'member' });

  const role = opts.projectRole === undefined ? 'member' : opts.projectRole;
  if (role !== null) {
    await db
      .insert(projectMembers)
      .values({ orgId: fx.orgId, projectId: fx.projectId, actorType: 'human', actorId: user!.id, role });
  }
  return user!.id;
}

export async function createWorkItem(
  db: Database,
  fx: Fixture,
  overrides: Partial<typeof workItems.$inferInsert> = {},
) {
  const status = (overrides.status ?? 'ready') as WorkItemStatus;
  /**
   * ★ 夹具也要分配编号 —— 真实路径（计划分解 / 手工创建）都会分配，
   *   夹具跳过它就等于测的不是真实形态，而 `ref` 会显示成 `ORD-?`。
   */
  const [number] = await allocateNumbers(db, fx.projectId, 1);
  const [item] = await db
    .insert(workItems)
    .values({
      orgId: fx.orgId,
      projectId: fx.projectId,
      number: number!,
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
