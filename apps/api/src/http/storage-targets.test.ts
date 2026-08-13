import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { agents, storageTargets } from '@apos/db';
import { RuntimeRegistry } from '@apos/agent-runtimes';
import { buildApp } from '../app';
import { EventBus } from '../modules/event/bus';
import { StubPlanningProvider } from '../modules/planning/stub-provider';
import { seedAgent } from '../test/agent-fixtures';
import {
  auth as authFor,
  createMember,
  createOutsider,
  integrationRegistry,
  resetDb,
  seedFixture,
  testDb,
  type Fixture,
} from '../test/db';

const db = testDb();
let app: FastifyInstance;
let fx: Fixture;

const ORIGINAL_KEY = process.env['APOS_SECRET_KEY'];
const ORIGINAL_ROOTS = process.env['APOS_LOCAL_MOUNT_ROOTS'];

beforeEach(async () => {
  process.env['APOS_SECRET_KEY'] = 'test-master-key';
  delete process.env['APOS_LOCAL_MOUNT_ROOTS'];
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

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env['APOS_SECRET_KEY'];
  else process.env['APOS_SECRET_KEY'] = ORIGINAL_KEY;
  if (ORIGINAL_ROOTS === undefined) delete process.env['APOS_LOCAL_MOUNT_ROOTS'];
  else process.env['APOS_LOCAL_MOUNT_ROOTS'] = ORIGINAL_ROOTS;
});

const auth = () => authFor(fx.userId);

const S3 = {
  ref: 'reports',
  name: '报告归档',
  kind: 'object_storage' as const,
  endpoint: 'https://s3.us-east-1.amazonaws.com',
  bucket: 'apos-reports',
  prefix: 'runs/',
};

const create = (payload: Record<string, unknown>, headers = auth()) =>
  app.inject({ method: 'POST', url: '/api/v1/admin/storage-targets', headers, payload });

const list = async (headers = auth()) =>
  (await app.inject({ method: 'GET', url: '/api/v1/admin/storage-targets', headers })).json();

describe('存储目标登记', () => {
  it('对象存储：登记、回显、改、删', async () => {
    const created = await create(S3);
    expect(created.statusCode).toBe(201);
    const id = created.json().storageTarget.id;

    const [row] = await list().then((d) => d.storageTargets);
    expect(row).toMatchObject({
      ref: 'reports',
      kind: 'object_storage',
      bucket: 'apos-reports',
      prefix: 'runs/',
      // ★ 默认 path-style —— MinIO / Ceph / 自建网关基本只支持它
      forcePathStyle: true,
      // ★ 默认只读：默认可写会让「挂进来当参考」的数据集被顺手写回
      writable: false,
      scope: 'organization',
    });

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/storage-targets/${id}`,
      headers: auth(),
      payload: { writable: true, prefix: 'archive/' },
    });
    expect((await list()).storageTargets[0]).toMatchObject({ writable: true, prefix: 'archive/' });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/storage-targets/${id}`,
      headers: auth(),
    });
    expect(removed.statusCode).toBe(200);
    expect((await list()).storageTargets).toHaveLength(0);
  });

  it('本地目录：登记与回显', async () => {
    const created = await create({
      ref: 'dataset',
      name: '训练集',
      kind: 'local',
      rootPath: '/srv/data/train',
    });
    expect(created.statusCode).toBe(201);
    expect((await list()).storageTargets[0]).toMatchObject({
      kind: 'local',
      rootPath: '/srv/data/train',
      endpoint: null,
      bucket: null,
    });
  });

  /**
   * ★★ 两类各自的必填项必须在入口就卡住，并指到**具体哪一栏**。
   *
   *   只靠库里的 check 约束的话，报出来的是一句 storage_targets_shape_check，
   *   管理员看不出该补什么。
   */
  it('★ 缺必填项时报错指到具体字段', async () => {
    const noBucket = await create({ ...S3, bucket: undefined });
    expect(noBucket.statusCode).toBe(400);
    expect(noBucket.payload).toContain('bucket');

    const noEndpoint = await create({ ...S3, endpoint: undefined });
    expect(noEndpoint.statusCode).toBe(400);

    const noPath = await create({ ref: 'd', name: 'd', kind: 'local' });
    expect(noPath.statusCode).toBe(400);
  });

  /**
   * ★ 相对路径会被 resolve 成**服务进程的当前目录** —— 而那通常是代码仓库
   *   本身。放进去的表现是「Agent 在源码目录里干活」，且没有任何地方会说破。
   */
  it('★ 本地目录必须是绝对路径', async () => {
    const relative = await create({ ref: 'd', name: 'd', kind: 'local', rootPath: 'data/train' });
    expect(relative.statusCode).toBe(400);
    expect(relative.payload).toContain('绝对路径');
  });

  it('★ 标识与代码仓库共用命名空间，撞名要拒', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/admin/repositories',
      headers: auth(),
      payload: { ref: 'shared', name: 'Shared', remoteUrl: 'https://github.com/acme/shared.git' },
    });

    const clash = await create({ ...S3, ref: 'shared' });
    expect(clash.statusCode).toBe(409);
    expect(clash.payload).toContain('代码仓库');
  });

  /**
   * ★ 改类型要拒：两类的必填列完全不重叠，改一半会被库约束整个拒掉，
   *   而报错指向的是约束名不是字段。
   */
  /**
   * ★★ PATCH 上没有 superRefine（路由用 innerType().partial()），
   *   所以「把必填项清空」此前是一路走到库里被 check 约束拒掉的 ——
   *   回给管理员的是一句 storage_targets_shape_check，看不出该补哪一栏。
   */
  it('★ 局部更新清空必填项，要报到具体字段而不是库约束名', async () => {
    const id = (await create(S3)).json().storageTarget.id;

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/storage-targets/${id}`,
      headers: auth(),
      payload: { bucket: null },
    });
    expect(cleared.statusCode).toBe(400);
    expect(cleared.json().error.message).toContain('bucket');
    expect(cleared.json().error.message).not.toContain('shape_check');

    // ★ 没提到的字段不该被当成「要清空」
    const kept = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/storage-targets/${id}`,
      headers: auth(),
      payload: { name: '改个名字' },
    });
    expect(kept.statusCode).toBe(200);
  });

  it('★ 不能修改类型', async () => {
    const id = (await create(S3)).json().storageTarget.id;
    const changed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/storage-targets/${id}`,
      headers: auth(),
      payload: { kind: 'local', rootPath: '/srv/x' },
    });
    expect(changed.statusCode).toBe(400);
  });

  /**
   * ★★ 凭证只以引用入库，接口永远读不回原值。
   */
  it('★ 凭证不回显，只回 hint', async () => {
    await create({ ...S3, credential: 'AKIAEXAMPLE:sUpErSeCrEt9876' });
    const payload = JSON.stringify(await list());
    expect(payload).not.toContain('sUpErSeCrEt');
    expect(payload).not.toContain('AKIAEXAMPLE');

    const [row] = await db.select().from(storageTargets);
    expect(row!.credentialRef).not.toContain('sUpErSeCrEt');
    expect(row!.credentialHint).toBeTruthy();
  });

  /**
   * ★ 还有 Agent 授权指向它就不能删 —— 删掉之后那些 Agent 的 dataset 范围
   *   会变成解析不出来的字符串，表现是「派发时突然全部失败」。
   */
  it('★ 还有 Agent 授权指向它时不能删', async () => {
    const id = (await create(S3)).json().storageTarget.id;
    const { agentId } = await seedAgent(db, fx);
    await db
      .update(agents)
      .set({ resourceScopes: [{ kind: 'dataset', ref: 'reports', access: 'write' }] })
      .where(eq(agents.id, agentId));

    const blocked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/storage-targets/${id}`,
      headers: auth(),
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toContain('reports');
  });
});

/**
 * 交货目标 —— 「产出送到哪」在**保存那一刻**就验。
 *
 * ★★ 等到收尾才发现目标不存在 / 只读，代价是这次 Run 的产出没了去处，
 *   而它是在任务跑完之后才暴露的 —— 那时工作区已经在回收路上。
 */
describe('交货目标', () => {
  const writableTarget = async (ref = 'archive') =>
    (await create({ ...S3, ref, bucket: 'apos-archive', writable: true })).json().storageTarget.id;

  it('存储目标可以把产出投递到另一个目标', async () => {
    const dest = await writableTarget();
    const src = await create({ ...S3, ref: 'dataset', deliveryTargetId: dest });
    expect(src.statusCode).toBe(201);

    const row = (await list()).storageTargets.find(
      (t: { ref: string }) => t.ref === 'dataset',
    );
    expect(row.deliveryTargetId).toBe(dest);
  });

  it('代码仓库也能配交货目标 —— 「拉代码、把报告投递到对象存储」', async () => {
    const dest = await writableTarget();
    const repo = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/repositories',
      headers: auth(),
      payload: {
        ref: 'order-service',
        name: 'Order Service',
        remoteUrl: 'https://github.com/acme/order-service.git',
        deliveryTargetId: dest,
      },
    });
    expect(repo.statusCode).toBe(201);

    const repos = (
      await app.inject({ method: 'GET', url: '/api/v1/admin/repositories', headers: auth() })
    ).json().repositories;
    expect(repos[0].deliveryTargetId).toBe(dest);
  });

  /**
   * ★ 只读目标现在就拒。它在收尾时会被跳过，而「配了交货目标但产出没到」
   *   是最难自己想到的一种失败。
   */
  it('★ 交货目标是只读的就拒绝保存，并说清楚要改什么', async () => {
    const readonly = (await create({ ...S3, ref: 'ro', writable: false })).json().storageTarget.id;
    const denied = await create({ ...S3, ref: 'dataset', deliveryTargetId: readonly });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error.message).toContain('只读');
  });

  it('★ 交货目标不能是它自己', async () => {
    const id = await writableTarget('self');
    const denied = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/storage-targets/${id}`,
      headers: auth(),
      payload: { deliveryTargetId: id },
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error.message).toContain('自己');
  });

  it('★ 不存在的交货目标要当场拒，不是存下来等收尾', async () => {
    const denied = await create({
      ...S3,
      ref: 'dataset',
      deliveryTargetId: '00000000-0000-0000-0000-000000000000',
    });
    expect(denied.statusCode).toBe(400);
  });

  /**
   * ★★ delivery_target_id 刻意没有外键，所以这道检查是唯一的把关。
   *   少了它，删除会成功，而那些登记的产出在下一次收尾时静默落回
   *   「不交货」—— 任务照样成功、产物页照样有记录，只是东西哪儿都没到。
   */
  it('★ 还有登记把产出交货到它时，不能删', async () => {
    const dest = await writableTarget();
    await create({ ...S3, ref: 'dataset', deliveryTargetId: dest });

    const blocked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/storage-targets/${dest}`,
      headers: auth(),
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toContain('dataset');
  });

  /**
   * ★★ 保存那一刻拒了只读的目标，可只读是后来也能改的 —— 从这一头关掉，
   *   等于绕过那道检查：收尾时被跳过，任务照样成功、产物页照样有记录，
   *   只是东西哪儿都没到。删除那条路早就在挡同一件事。
   */
  it('★ 还有登记交货到它时，不能把它改成只读', async () => {
    const dest = await writableTarget();
    await create({ ...S3, ref: 'dataset', deliveryTargetId: dest });

    const blocked = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/storage-targets/${dest}`,
      headers: auth(),
      payload: { writable: false },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toContain('dataset');

    // ★ 断言库里没变 —— 「先改再报错」照样能让上面那行通过
    const [row] = await db.select().from(storageTargets).where(eq(storageTargets.id, dest));
    expect(row!.writable).toBe(true);
  });

  it('没有登记指向它时，改成只读是允许的', async () => {
    const dest = await writableTarget();
    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/storage-targets/${dest}`,
      headers: auth(),
      payload: { writable: false },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('null 清空，回到默认交货', async () => {
    const dest = await writableTarget();
    const id = (await create({ ...S3, ref: 'dataset', deliveryTargetId: dest })).json()
      .storageTarget.id;

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/storage-targets/${id}`,
      headers: auth(),
      payload: { deliveryTargetId: null },
    });

    const row = (await list()).storageTargets.find((t: { id: string }) => t.id === id);
    expect(row.deliveryTargetId).toBeNull();
  });
});

describe('权限', () => {
  /**
   * ★★ 权限断言一律用 createMember 造明确角色的人。
   *   用夹具身份（组织管理员）去测「谁不能改」永远是绿的。
   */
  it('★ 非组织管理员登记不了存储目标', async () => {
    const lead = await createMember(db, fx, { projectRole: 'tech_lead' });
    const denied = await create(S3, authFor(lead));
    expect(denied.statusCode).toBe(403);

    const member = await createMember(db, fx, { projectRole: 'member' });
    expect((await create(S3, authFor(member))).statusCode).toBe(403);
  });

  /**
   * ★ probe 是只读的，但它会拿着登记里的凭证去连远端 —— 能触发一次带凭证的
   *   出网请求本身就是「管理存储目标」的一部分，所以同样要 storage_target.manage。
   */
  it('★ 探测同样要 storage_target.manage', async () => {
    const id = (await create(S3)).json().storageTarget.id;
    const lead = await createMember(db, fx, { projectRole: 'tech_lead' });
    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/storage-targets/${id}/probe`,
      headers: authFor(lead),
    });
    expect(denied.statusCode).toBe(403);
  });
});

/**
 * 租户边界。
 *
 * ★★ 这一组测的不是「够不够格」，而是「这条登记是不是你的」—— 两件事，
 *   而 rbac 那道闸只答得了前一件。
 *
 *   `/api/v1/admin/…` 不落在 PROJECT_SCOPED_URL / RESOURCE_SCOPED_URL
 *   任何一条正则里（见 rbac.ts），所以闸门判的是「调用者在**自己当前组织**里
 *   有没有 storage_target.manage」。越界的人在自己组织里权限是满的 ——
 *   于是闸门放行，剩下的全靠 handler 自己按 orgId 收窄。
 *
 * ★ 攻击者用 org_admin 而不是普通成员：普通成员在权限矩阵那层就被 403 挡下，
 *   拿它来断言 404 的话，产品代码查不查组织都是绿的。而自助注册默认开着，
 *   注册即是新组织的 org_admin —— 这个身份不是假想的，是默认可得的。
 *
 * ★ 越界一律 404 而不是 403：403 等于确认「这个 id 存在」，
 *   把 id 变成可枚举的探针。与 assertProjectAccess 的选择一致。
 */
describe('★ 跨组织越界', () => {
  /** 别的组织里权限拉满的人 —— 自助注册就能得到这个身份 */
  const attacker = async () =>
    authFor((await createOutsider(db, fx, { orgRole: 'org_admin' })).userId);

  it('改不动别的组织的登记', async () => {
    const id = (await create(S3)).json().storageTarget.id;

    const denied = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/storage-targets/${id}`,
      headers: await attacker(),
      payload: { endpoint: 'https://attacker.example.com', name: '已被改掉' },
    });
    expect(denied.statusCode).toBe(404);

    /**
     * ★ 断言库里没变，不只断言状态码。少了这一条，一个「先改再报错」的
     *   实现照样能让上面那行通过 —— 而那正是最坏的情况。
     */
    const [row] = await db.select().from(storageTargets).where(eq(storageTargets.id, id));
    expect(row!.endpoint).toBe(S3.endpoint);
    expect(row!.name).toBe(S3.name);
  });

  it('删不掉别的组织的登记', async () => {
    const id = (await create(S3)).json().storageTarget.id;

    const denied = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/storage-targets/${id}`,
      headers: await attacker(),
    });
    expect(denied.statusCode).toBe(404);

    const rows = await db.select().from(storageTargets).where(eq(storageTargets.id, id));
    expect(rows).toHaveLength(1);
  });

  /**
   * ★ 探测越界比改删更隐蔽：它是只读的，却会拿着**对方的**凭证去连远端，
   *   并把对象名回给调用者。挡在这里，不能等它连出去。
   */
  it('探测不到别的组织的登记', async () => {
    const id = (await create(S3)).json().storageTarget.id;

    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/storage-targets/${id}/probe`,
      headers: await attacker(),
    });
    expect(denied.statusCode).toBe(404);
  });

  it('列表里也看不见别的组织的登记', async () => {
    await create(S3);

    const seen = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/storage-targets',
      headers: await attacker(),
    });
    expect(seen.json().storageTargets).toEqual([]);
  });
});

describe('探测', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'apos-target-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const probe = async (id: string) =>
    (
      await app.inject({
        method: 'POST',
        url: `/api/v1/admin/storage-targets/${id}/probe`,
        headers: auth(),
      })
    ).json();

  it('本地目录：存在就通过，并报出顶层条目数', async () => {
    await writeFile(join(dir, 'a.csv'), 'x', 'utf8');
    const id = (await create({ ref: 'd', name: 'd', kind: 'local', rootPath: dir })).json()
      .storageTarget.id;

    const result = await probe(id);
    expect(result).toMatchObject({ ok: true, stage: 'ok', objectCount: 1 });
    expect(result.samples).toContain('a.csv');
  });

  it('★ 目录不存在要当场说，而不是等派发', async () => {
    const id = (await create({
      ref: 'd',
      name: 'd',
      kind: 'local',
      rootPath: join(dir, 'nope'),
    })).json().storageTarget.id;

    expect(await probe(id)).toMatchObject({ ok: false, stage: 'not_found' });
  });

  /**
   * ★★ 白名单要用与 LocalMaterializer **同一个**判据。
   *
   *   抄第二遍的代价是界面上说「可以挂」而派发时报「不在允许范围内」——
   *   而管理员看着那条绿色的探测结果，根本不会想到去查环境变量。
   */
  it('★ 被 APOS_LOCAL_MOUNT_ROOTS 挡住的路径，探测就要报出来', async () => {
    const id = (await create({ ref: 'd', name: 'd', kind: 'local', rootPath: dir })).json()
      .storageTarget.id;

    process.env['APOS_LOCAL_MOUNT_ROOTS'] = join(tmpdir(), 'somewhere-else');
    try {
      const result = await probe(id);
      expect(result).toMatchObject({ ok: false, stage: 'allowlist' });
      // ★ 要说清楚这道闸在部署环境里，改数据库没有用
      expect(result.message).toContain('APOS_LOCAL_MOUNT_ROOTS');
    } finally {
      delete process.env['APOS_LOCAL_MOUNT_ROOTS'];
    }
  });

  it('★ 白名单会在列表里回显 —— 它是环境变量，界面上否则看不到', async () => {
    await create({ ref: 'd', name: 'd', kind: 'local', rootPath: dir });
    expect(await list()).toMatchObject({ localMountRestricted: false, localMountRoots: [] });

    process.env['APOS_LOCAL_MOUNT_ROOTS'] = '/srv/data:/mnt/share';
    try {
      const data = await list();
      expect(data.localMountRestricted).toBe(true);
      expect(data.localMountRoots).toEqual(['/srv/data', '/mnt/share']);
      // 这条登记不在白名单里，列表上就要有警告
      expect(data.storageTargets[0].warnings.join('')).toContain('APOS_LOCAL_MOUNT_ROOTS');
    } finally {
      delete process.env['APOS_LOCAL_MOUNT_ROOTS'];
    }
  });

  it('★ 对象存储没凭证时直接报凭证问题，不去连网络', async () => {
    const id = (await create(S3)).json().storageTarget.id;
    expect(await probe(id)).toMatchObject({ ok: false, stage: 'credential' });
  });
});
