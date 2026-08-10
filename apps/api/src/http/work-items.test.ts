import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { projects, workItems } from '@apos/db';
import { RuntimeRegistry } from '@apos/agent-runtimes';
import { buildApp } from '../app';
import { EventBus } from '../modules/event/bus';
import { StubPlanningProvider } from '../modules/planning/stub-provider';
import { allocateNumbers, suggestIdentifier } from '../modules/work-item/numbering';
import {
  createMember,
  integrationRegistry,
  resetDb,
  seedFixture,
  testDb,
  type Fixture,
} from '../test/db';

/**
 * 手工创建工作项 + 人类可读编号。
 *
 * ★★ 在此之前工作项只能被**生成**出来（需求 → 计划 → 批准 → 分解），
 *   而且只有 uuid。前者让「随手记一个 bug」在系统里做不到，
 *   后者让任何一条任务都没有能用嘴说出来的名字。
 */

const db = testDb();
let app: FastifyInstance;
let fx: Fixture;

beforeEach(async () => {
  await resetDb(db);
  fx = await seedFixture(db);
  app = await buildApp({
    db,
    bus: new EventBus(),
    registry: new RuntimeRegistry(),
    integrations: integrationRegistry(),
    provider: new StubPlanningProvider(),
  });
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await resetDb(db);
});

const as = (userId: string) => ({ 'x-user-id': userId });

const create = (payload: Record<string, unknown>, userId = fx.userId) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/projects/${fx.projectId}/work-items`,
    headers: as(userId),
    payload,
  });

describe('编号', () => {
  it('建项目时按项目名推前缀，撞车自动加序号', async () => {
    expect(suggestIdentifier('Order Service')).toBe('ORDE');
    expect(suggestIdentifier('订单系统')).toBe('PRJ');

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: as(fx.userId),
      payload: { name: 'Order Service' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: as(fx.userId),
      payload: { name: 'Order Service' },
    });

    expect(first.json().project.identifier).toBe('ORDE');
    expect(second.json().project.identifier).toBe('ORDE2');
  });

  it('显式指定前缀，非法值当场拒绝', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: as(fx.userId),
      payload: { name: '任意名字', identifier: 'ORD' },
    });
    expect(ok.json().project.identifier).toBe('ORD');

    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: as(fx.userId),
      payload: { name: '任意名字', identifier: 'lowercase' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.payload).toContain('大写字母');
  });

  it('编号从 1 开始按项目递增，看板与详情都带上它', async () => {
    const a = await create({ title: '第一条' });
    const b = await create({ title: '第二条' });

    expect(a.json().item.number).toBe(1);
    expect(b.json().item.number).toBe(2);

    const [project] = await db.select().from(projects).where(eq(projects.id, fx.projectId));
    expect(a.json().item.ref).toBe(`${project!.identifier}-1`);

    const board = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}/board`,
      headers: as(fx.userId),
    });
    const refs = board
      .json()
      .columns.flatMap((c: { items: { ref: string }[] }) => c.items)
      .map((i: { ref: string }) => i.ref);
    expect(refs).toEqual(expect.arrayContaining([`${project!.identifier}-1`]));

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/work-items/${a.json().item.id}`,
      headers: as(fx.userId),
    });
    expect(detail.json().item.ref).toBe(`${project!.identifier}-1`);
  });

  /**
   * ★★ 读-改-写在并发下会把同一个号发给两个调用者，而后果不是报错 ——
   *   唯一约束会让**第二个插入**失败，表现成「建任务偶尔失败」，
   *   一个只在有人同时操作时出现、复现不了的故障。
   */
  it('★ 并发分配不重号', async () => {
    const batches = await Promise.all(
      Array.from({ length: 8 }, () => allocateNumbers(db, fx.projectId, 3)),
    );
    const all = batches.flat();

    expect(all).toHaveLength(24);
    expect(new Set(all).size).toBe(24);
    expect([...all].sort((x, y) => x - y)).toEqual(
      Array.from({ length: 24 }, (_, i) => i + 1),
    );
  });

  /**
   * ★ 同一份计划分解出来的任务编号必须连续 —— 中间插进别人的号，
   *   读起来像是丢了几条。
   */
  it('★ 一次要 n 个是连号', async () => {
    await allocateNumbers(db, fx.projectId, 1);
    expect(await allocateNumbers(db, fx.projectId, 4)).toEqual([2, 3, 4, 5]);
  });
});

describe('手工建任务', () => {
  it('建出来的是草稿，并说明下一步要谁放行', async () => {
    const res = await create({ title: '修一个线上报错', type: 'bug', priority: 1 });

    expect(res.statusCode).toBe(201);
    expect(res.json().item).toMatchObject({ status: 'draft', type: 'bug', priority: 1 });
    expect(res.json().notice).toContain('tech_lead');
  });

  /**
   * ★★ 这一条是整个入口能不能加的前提。
   *
   *   手工建的任务如果建完就能派发，那么任何能建任务的人都可以让 Agent
   *   去做任意事情 —— requirement.approve 与 plan.approve 两道
   *   Human Gate 就都被绕开了，而且绕开的方式在接口清单上看不出来。
   */
  it('★ 不接受调用方指定状态 —— 一律停在 draft', async () => {
    const res = await create({ title: '想直接跑', status: 'ready' });
    expect(res.json().item.status).toBe('draft');
  });

  it('★ draft → ready 要 plan.approve，普通成员放行不了', async () => {
    const executor = await createMember(db, fx, { projectRole: 'executor', orgRole: 'member' });
    const id = (await create({ title: '待放行' }, executor)).json().item.id;

    const denied = await app.inject({
      method: 'PATCH',
      url: `/api/v1/work-items/${id}/status`,
      headers: as(executor),
      payload: { toStatus: 'ready', reason: '我想让它跑' },
    });
    expect(denied.statusCode).toBe(403);

    const lead = await createMember(db, fx, { projectRole: 'tech_lead', orgRole: 'member' });
    const allowed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/work-items/${id}/status`,
      headers: as(lead),
      payload: { toStatus: 'ready', reason: '已确认范围，放行' },
    });
    expect(allowed.statusCode).toBe(200);

    const [after] = await db.select().from(workItems).where(eq(workItems.id, id));
    expect(after!.status).toBe('ready');
  });

  /**
   * ★ 返工重新开始（changes_requested → ready）同样落在 ready 上，
   *   但那一步的计划早就批过了 —— 再要一次批准权限，会让每次返工
   *   都要惊动 tech_lead，而返工是执行者的日常动作。
   */
  it('★ 返工回到 ready 不要 plan.approve —— 那份计划已经批过了', async () => {
    const executor = await createMember(db, fx, { projectRole: 'executor', orgRole: 'member' });
    const id = (await create({ title: '返工的任务' })).json().item.id;

    await db.update(workItems).set({ status: 'changes_requested' }).where(eq(workItems.id, id));

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/work-items/${id}/status`,
      headers: as(executor),
      payload: { toStatus: 'ready', reason: '改完了，重新开始' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('只读角色建不了任务', async () => {
    const viewer = await createMember(db, fx, { projectRole: 'viewer', orgRole: 'member' });
    expect((await create({ title: '试试' }, viewer)).statusCode).toBe(403);
  });

  /** ★ 审计时「它是怎么来的」要答得上：计划分解的还是人手建的 */
  it('★ 手工建的任务留下 origin 痕迹', async () => {
    const id = (await create({ title: '手建的' })).json().item.id;
    const [row] = await db.select().from(workItems).where(eq(workItems.id, id));
    expect(row!.typeData).toMatchObject({ origin: 'manual', createdBy: fx.userId });
  });

  it('跨项目的父任务被拒', async () => {
    const other = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: as(fx.userId),
      payload: { name: '另一个项目' },
    });
    const foreign = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${other.json().project.id}/work-items`,
      headers: as(fx.userId),
      payload: { title: '别处的任务' },
    });

    const res = await create({ title: '子任务', parentId: foreign.json().item.id });
    expect(res.statusCode).toBe(404);
  });

  it('不填负责人时默认记在创建者名下 —— 问责链条不能断', async () => {
    const res = await create({ title: '没指定负责人' });
    expect(res.json().item.ownerId).toBe(fx.userId);
  });
});
