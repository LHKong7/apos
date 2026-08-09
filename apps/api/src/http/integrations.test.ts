import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { events, integrations, projectMembers, syncConflicts, users, workItems } from '@apos/db';
import type { IntegrationRegistry } from '@apos/integrations';
import { buildApp } from '../app';
import { EventBus } from '../modules/event/bus';
import { RuntimeRegistry } from '@apos/agent-runtimes';
import { StubPlanningProvider } from '../modules/planning/stub-provider';
import {
  createWorkItem,
  integrationRegistry,
  memoryAdapter,
  resetDb,
  seedFixture,
  testDb,
  type Fixture,
} from '../test/db';

const db = testDb();
let app: FastifyInstance;
let fx: Fixture;
let ints: IntegrationRegistry;

/** fx.userId 默认是 techLead，但项目角色要单独写进 project_members */
async function asRole(role: string, userId = fx.userId) {
  await db
    .insert(projectMembers)
    .values({ projectId: fx.projectId, actorType: 'human', actorId: userId, role })
    .onConflictDoUpdate({
      target: [projectMembers.projectId, projectMembers.actorType, projectMembers.actorId],
      set: { role },
    });
}

async function newUser(name: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ orgId: fx.orgId, email: `${randomUUID()}@acme.dev`, name })
    .returning();
  return u!.id;
}

function auth(userId = fx.userId) {
  return { 'x-user-id': userId };
}

beforeEach(async () => {
  await resetDb(db);
  fx = await seedFixture(db);
  ints = integrationRegistry();
  app = await buildApp({
    db,
    bus: new EventBus(),
    registry: new RuntimeRegistry(),
    integrations: ints,
    provider: new StubPlanningProvider(),
  });
  await asRole('tech_lead');
});

afterEach(async () => {
  await app.close();
});

async function connectJira() {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${fx.projectId}/integrations`,
    headers: auth(),
    payload: {
      provider: 'jira',
      displayName: 'ORDER',
      config: { projectKey: 'ORDER' },
      credential: 'jira-token-abcd1234',
      grantWrite: true,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

describe('凭证安全（§9）', () => {
  /**
   * ★ 一个能从接口读出 token 的系统，早晚会有人把它贴进日志或截图。
   *   所以这条不是「最好别回显」，是「接口里根本没有这个字段」。
   */
  it('★ 接口任何地方都不回显凭证明文，只给后四位', async () => {
    await connectJira();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}/integrations`,
      headers: auth(),
    });

    const raw = res.payload;
    expect(raw).not.toContain('jira-token-abcd1234');
    expect(raw).not.toContain('credentialRef');

    const row = res.json().integrations[0];
    expect(row.credentialHint).toBe('****1234');
  });

  it('明文不落业务库，库里只有引用', async () => {
    await connectJira();
    const [row] = await db.select().from(integrations).where(eq(integrations.projectId, fx.projectId));
    expect(row!.credentialRef).toMatch(/^secret:\/\//);
    expect(JSON.stringify(row)).not.toContain('jira-token-abcd1234');
  });
});

describe('权限（§8）', () => {
  /**
   * ★ 「能连上」和「能让它改我的代码 / 改我的 Jira」是两个量级的授权。
   *   pm 能连接，开写权限必须 tech_lead。
   */
  it('★ pm 能连接，但要写权限时被拦下', async () => {
    const pm = await newUser('李娜');
    await asRole('pm', pm);

    const withWrite = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${fx.projectId}/integrations`,
      headers: auth(pm),
      payload: { provider: 'jira', displayName: 'ORDER', credential: null, grantWrite: true },
    });
    expect(withWrite.statusCode).toBe(403);
    expect(withWrite.json().error.message).toContain('tech_lead');

    const readOnly = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${fx.projectId}/integrations`,
      headers: auth(pm),
      payload: { provider: 'jira', displayName: 'ORDER', credential: null, grantWrite: false },
    });
    expect(readOnly.statusCode).toBe(201);
  });

  it('普通成员改不了 Source of Truth', async () => {
    const id = await connectJira();
    const member = await newUser('王强');
    await asRole('member', member);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/integrations/${id}/sync-mapping`,
      headers: auth(member),
      payload: { mappings: [{ field: 'status', sourceOfTruth: 'external', strategy: 'writeback' }] },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('哪一边的修改会被丢掉');
  });

  it('普通成员可以处理冲突 —— 卡住的结果是冲突没人清', async () => {
    const permissions = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}/integrations`,
      headers: auth(),
    });
    expect(permissions.json().permissions.resolve_conflict).toBe(true);
  });
});

describe('权限最小化（§5.2）', () => {
  it('★ 授权里出现 merge_pr 一律拒绝，不管适配器怎么说', async () => {
    // 直接篡改适配器的授权结果，模拟「适配器有 bug 或外部给多了」
    const github = memoryAdapter(ints, 'github');
    github.grantedScopes = async () => ({
      allowed: ['read_code', 'merge_pr'],
      denied: [],
      probed: true,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${fx.projectId}/integrations`,
      headers: auth(),
      payload: { provider: 'github', displayName: 'order-service', credential: null },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('merge_pr');
    expect(res.json().error.message).toContain('Policy');
  });

  it('正常授权时禁止项被完整列出，页面能回答「它不能合并我的代码」', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${fx.projectId}/integrations`,
      headers: auth(),
      payload: { provider: 'github', displayName: 'order-service', credential: null },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}/integrations`,
      headers: auth(),
    });
    const gh = res.json().integrations.find((i: { provider: string }) => i.provider === 'github');
    expect(gh.scopes.denied).toContain('merge_pr');
    expect(gh.neverGranted).toContain('merge_pr');
    // ★ 这份清单是探测到的，不是探测失败后的兜底
    expect(gh.scopes.probed).toBe(true);
  });
});

describe('同步与冲突（§5.3 / §11）', () => {
  async function linked() {
    const id = await connectJira();
    const item = await createWorkItem(db, fx, { status: 'reviewing', title: '数据库索引变更' });

    await memoryAdapter(ints, 'jira').seed({
      externalKey: 'ORDER-142',
      url: 'https://jira.example/ORDER-142',
      fields: { status: 'reviewing' },
      lastChange: { originTag: null, by: '李娜', at: '2026-08-05T10:00:00Z' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/${id}/objects`,
      headers: auth(),
      payload: { workItemId: item.id, externalKey: 'ORDER-142' },
    });
    expect(res.statusCode).toBe(201);

    // 建立同步基准
    await app.inject({ method: 'POST', url: `/api/v1/integrations/${id}/sync`, headers: auth() });
    return { id, item };
  }

  it('★ 一个任务只能映射一个外部对象', async () => {
    const { id, item } = await linked();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/${id}/objects`,
      headers: auth(),
      payload: { workItemId: item.id, externalKey: 'ORDER-999' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('没有确定的方向');
  });

  /**
   * ★ 状态的 SoT 是 APOS，默认策略是记录冲突。
   *   悄悄回写会让 Jira 里那个人看到自己刚点的 Done 被弹回去且毫无解释。
   */
  it('★ 外部手改状态 → 生成冲突，两侧的值与修改人都摆出来', async () => {
    const { id } = await linked();
    await memoryAdapter(ints, 'jira').externalEdit(
      'ORDER-142',
      'status',
      'done',
      '李娜',
      '2026-08-05T14:45:00Z',
    );

    const sync = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/${id}/sync`,
      headers: auth(),
    });
    expect(sync.json().conflicts).toBe(1);

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}/sync-conflicts`,
      headers: auth(),
    });
    const c = list.json().conflicts[0];
    expect(c.fieldLabel).toBe('状态');
    expect(c.external.value).toBe('done');
    expect(c.external.changedBy).toBe('李娜');
    expect(c.apos.value).toBe('reviewing');
    expect(c.sotNote).toContain('APOS');
    expect(c.workItemTitle).toBe('数据库索引变更');
  });

  it('★ 以 APOS 为准 → 值真的被写回外部系统', async () => {
    const { id } = await linked();
    const jira = memoryAdapter(ints, 'jira');
    await jira.externalEdit('ORDER-142', 'status', 'done', '李娜', 'x');

    await app.inject({ method: 'POST', url: `/api/v1/integrations/${id}/sync`, headers: auth() });
    const [conflict] = await db.select().from(syncConflicts);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sync-conflicts/${conflict!.id}/resolve`,
      headers: auth(),
      payload: { winner: 'apos', applyToSimilar: false },
    });

    expect(res.statusCode).toBe(200);
    expect((await jira.snapshot('ORDER-142'))?.fields.status).toBe('reviewing');
  });

  /**
   * ★ 勾了「以后同类冲突自动按此处理」，同一字段的下一次冲突不再打扰用户。
   *   记的是字段级规则，不是这条对象级 —— 用户勾它时想表达的显然是前者。
   */
  it('★ 勾选「以后同类自动处理」后，同一字段的下次冲突自动解决', async () => {
    const { id } = await linked();
    const jira = memoryAdapter(ints, 'jira');

    await jira.externalEdit('ORDER-142', 'status', 'done', '李娜', 'x');
    await app.inject({ method: 'POST', url: `/api/v1/integrations/${id}/sync`, headers: auth() });
    const [first] = await db.select().from(syncConflicts);

    await app.inject({
      method: 'POST',
      url: `/api/v1/sync-conflicts/${first!.id}/resolve`,
      headers: auth(),
      payload: { winner: 'apos', applyToSimilar: true },
    });

    // 外部再改一次同一个字段
    await jira.externalEdit('ORDER-142', 'status', 'cancelled', '李娜', 'y');
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/${id}/sync`,
      headers: auth(),
    });

    expect(second.json().autoResolved).toBe(1);
    expect(second.json().conflicts).toBe(0);

    const pending = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}/sync-conflicts`,
      headers: auth(),
    });
    expect(pending.json().conflicts).toHaveLength(0);
  });

  /**
   * ★ 解决之后基准要推进，否则下一轮同一个冲突原样再来一次 ——
   *   用户会以为自己的处理没生效。
   */
  it('★ 冲突处理完不会在下一轮原样复发', async () => {
    const { id } = await linked();
    const jira = memoryAdapter(ints, 'jira');
    await jira.externalEdit('ORDER-142', 'status', 'done', '李娜', 'x');

    await app.inject({ method: 'POST', url: `/api/v1/integrations/${id}/sync`, headers: auth() });
    const [conflict] = await db.select().from(syncConflicts);
    await app.inject({
      method: 'POST',
      url: `/api/v1/sync-conflicts/${conflict!.id}/resolve`,
      headers: auth(),
      payload: { winner: 'apos', applyToSimilar: false },
    });

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/${id}/sync`,
      headers: auth(),
    });
    expect(again.json().conflicts).toBe(0);
  });

  /**
   * ★ 冲突未解决时基准不推进（这是对的），于是每一轮同步都会重新判出
   *   同一个冲突。不去重的话，一个每 5 分钟拉一次的集成一天能堆出
   *   近三百条一模一样的记录 —— 功能在测试里是好的，在生产上没法用。
   */
  it('★ 反复同步不会把同一个冲突堆成一叠', async () => {
    const { id } = await linked();
    const jira = memoryAdapter(ints, 'jira');
    await jira.externalEdit('ORDER-142', 'status', 'done', '李娜', 'x');

    for (let i = 0; i < 4; i++) {
      await app.inject({ method: 'POST', url: `/api/v1/integrations/${id}/sync`, headers: auth() });
    }

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}/sync-conflicts`,
      headers: auth(),
    });
    expect(list.json().conflicts).toHaveLength(1);
  });

  it('★ 已有冲突的快照跟着外部变化更新，展示的是现在的值', async () => {
    const { id } = await linked();
    const jira = memoryAdapter(ints, 'jira');

    await jira.externalEdit('ORDER-142', 'status', 'done', '李娜', 'x');
    await app.inject({ method: 'POST', url: `/api/v1/integrations/${id}/sync`, headers: auth() });

    await jira.externalEdit('ORDER-142', 'status', 'cancelled', '王强', 'y');
    await app.inject({ method: 'POST', url: `/api/v1/integrations/${id}/sync`, headers: auth() });

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}/sync-conflicts`,
      headers: auth(),
    });
    const c = list.json().conflicts;
    expect(c).toHaveLength(1);
    expect(c[0].external.value).toBe('cancelled');
    expect(c[0].external.changedBy).toBe('王强');
  });

  /** §11：本地数据不跟着删，只打标 */
  it('★ 外部对象被删除时本地任务保留，只标注', async () => {
    const { id, item } = await linked();
    await memoryAdapter(ints, 'jira').externalDelete('ORDER-142');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/${id}/sync`,
      headers: auth(),
    });

    expect(res.json().externalDeleted).toBe(1);
    expect(res.json().notes[0]).toContain('本地数据保留');

    const [still] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    expect(still).toBeDefined();
  });

  /** §11：外部不可用时标记异常并暂停，不把整轮失败写成一堆假冲突 */
  it('★ 外部服务不可用时暂停同步并留下原因，不生成假冲突', async () => {
    const { id } = await linked();
    memoryAdapter(ints, 'jira').failWith('服务不可达');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/${id}/sync`,
      headers: auth(),
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toContain('同步已暂停');

    const [row] = await db.select().from(integrations).where(eq(integrations.id, id));
    expect(row!.status).toBe('paused');
    expect(row!.statusReason).toContain('服务不可达');
    expect(await db.select().from(syncConflicts)).toHaveLength(0);
  });
});

describe('Source of Truth 配置', () => {
  it('产物链接不允许以外部为准 —— APOS 是产物的产生方', async () => {
    const id = await connectJira();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/integrations/${id}/sync-mapping`,
      headers: auth(),
      payload: {
        mappings: [{ field: 'artifact_links', sourceOfTruth: 'external', strategy: 'writeback' }],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('产物的产生方');
  });

  /** ★ 改错之后不会立刻显现，唯一能回答「谁什么时候改的」就是这条事件 */
  it('★ SoT 变更写事件留痕', async () => {
    const id = await connectJira();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/integrations/${id}/sync-mapping`,
      headers: auth(),
      payload: {
        mappings: [{ field: 'status', sourceOfTruth: 'external', strategy: 'writeback' }],
      },
    });

    expect(res.json().changed).toEqual([{ field: 'status', from: 'apos', to: 'external' }]);

    const rows = await db.select().from(events).where(eq(events.subjectId, id));
    const sot = rows.find((e) => (e.payload as { kind?: string }).kind === 'sot_changed');
    expect(sot).toBeDefined();
    expect(sot!.actorType).toBe('human');
  });

  it('★ 用户填的连接对象名不被适配器探测结果覆盖', async () => {
    await connectJira();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}/integrations`,
      headers: auth(),
    });
    expect(res.json().integrations[0].displayName).toBe('ORDER');
  });

  it('默认配置是「APOS 管执行，外部管计划」', async () => {
    await connectJira();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}/integrations`,
      headers: auth(),
    });
    const row = res.json().integrations[0];
    expect(row.sotPreset).toBe('split');
    // 每个字段都要带上「为什么默认是这个」
    expect(row.syncMappings.every((m: { why: string }) => m.why.length > 0)).toBe(true);
  });
});

describe('断开连接（§7）', () => {
  /** 一个只问「确定吗」的确认框等于没问 */
  it('★ 断开前先给出具体影响，而不是一句「确定吗」', async () => {
    const id = await connectJira();
    const item = await createWorkItem(db, fx);
    await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/${id}/objects`,
      headers: auth(),
      payload: { workItemId: item.id, externalKey: 'ORDER-1' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/integrations/${id}/disconnect-impact`,
      headers: auth(),
    });

    expect(res.json().effects.join(' ')).toContain('1 个任务');
    expect(res.json().linkedItems).toBe(1);
  });
});

describe('传输层未实现时如实报错', () => {
  it('★ 没有注册适配器的 provider 连不上，且说明原因', async () => {
    const empty = integrationRegistry([]);
    const bare = await buildApp({
      db,
      bus: new EventBus(),
      registry: new RuntimeRegistry(),
      integrations: empty,
      provider: new StubPlanningProvider(),
    });

    const res = await bare.inject({
      method: 'POST',
      url: `/api/v1/projects/${fx.projectId}/integrations`,
      headers: auth(),
      payload: { provider: 'github', displayName: 'x', credential: null },
    });

    expect(res.statusCode).toBe(501);
    expect(res.json().error.message).toContain('传输层还没有实现');
    await bare.close();
  });
});
