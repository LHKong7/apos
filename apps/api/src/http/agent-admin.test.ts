import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { agentPermissionChanges, agents } from '@apos/db';
import { RuntimeRegistry } from '@apos/agent-runtimes';
import { buildApp } from '../app';
import { EventBus } from '../modules/event/bus';
import { StubPlanningProvider } from '../modules/planning/stub-provider';
import { integrationRegistry, resetDb, seedFixture, testDb, type Fixture } from '../test/db';

const db = testDb();
let app: FastifyInstance;
let fx: Fixture;
let registry: RuntimeRegistry;

const ORIGINAL_KEY = process.env['APOS_SECRET_KEY'];

beforeEach(async () => {
  process.env['APOS_SECRET_KEY'] = 'test-master-key';
  await resetDb(db);
  fx = await seedFixture(db);
  registry = new RuntimeRegistry();
  app = await buildApp({
    db,
    bus: new EventBus(),
    registry,
    integrations: integrationRegistry(),
    provider: new StubPlanningProvider(),
  });
});

afterEach(async () => {
  await app.close();
  if (ORIGINAL_KEY === undefined) delete process.env['APOS_SECRET_KEY'];
  else process.env['APOS_SECRET_KEY'] = ORIGINAL_KEY;
});

afterAll(async () => {
  await resetDb(db);
});

const auth = () => ({ 'x-user-id': fx.userId });

async function createAgent(payload: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/admin/agents',
    headers: auth(),
    payload: {
      name: 'code-agent-1',
      type: 'code',
      runtimeKind: 'mock',
      ownerId: fx.userId,
      allowedTools: ['Read', 'Grep'],
      deniedTools: [],
      resourceScopes: [{ kind: 'repo', ref: 'order-service', access: 'read' }],
      ...payload,
    },
  });
}

describe('Agent 自带运行时配置', () => {
  it('列表带上平台定义的配置目录，前端据此渲染表单', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/agents', headers: auth() });
    const body = res.json();

    expect(body.kinds.map((k: { kind: string }) => k.kind)).toEqual(
      expect.arrayContaining(['claude_code', 'codex', 'mock']),
    );
    const claude = body.kinds.find((k: { kind: string }) => k.kind === 'claude_code');
    expect(claude.fields.map((f: { key: string }) => f.key)).toEqual(
      expect.arrayContaining(['model', 'effort', 'maxTurns', 'onUngrantedTool']),
    );
  });

  it('新建后立刻注册到本进程，不必等下一轮同步', async () => {
    const res = await createAgent();
    expect(res.statusCode).toBe(201);

    const agent = res.json().agent;
    expect(agent.registered).toBe(true);
    expect(agent.reachable).toBe(true);
    expect(registry.has(agent.id)).toBe(true);
  });

  /**
   * ★ 这是「取消接入层」的核心收益：同一种 CLI，两个 Agent 各带一套参数。
   *   按运行时键控的话后注册的会覆盖先注册的。
   */
  it('同一种 CLI 的两个 Agent 拿到各自独立的配置与实例', async () => {
    const a = await createAgent({
      name: 'refactor-agent',
      runtimeKind: 'claude_code',
      credential: 'env:KEY_A',
      runtimeConfig: { effort: 'max', maxTurns: 120, model: 'claude-opus-5' },
    });
    const b = await createAgent({
      name: 'review-agent',
      runtimeKind: 'claude_code',
      credential: 'env:KEY_A',
      runtimeConfig: { effort: 'low', maxTurns: 20, model: 'claude-haiku-4-5' },
    });

    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().agent.runtimeConfig.effort).toBe('max');
    expect(b.json().agent.runtimeConfig.effort).toBe('low');

    // 两个不同的适配器实例
    expect(registry.get(a.json().agent.id)).not.toBe(registry.get(b.json().agent.id));
  });

  it('未填的配置项补上平台默认值，适配器侧永远拿到完整配置', async () => {
    const res = await createAgent({
      runtimeKind: 'claude_code',
      credential: 'env:KEY',
      runtimeConfig: { effort: 'low' },
    });

    const cfg = res.json().agent.runtimeConfig;
    expect(cfg.effort).toBe('low');
    expect(cfg.maxTurns).toBe(60);
    expect(cfg.onUngrantedTool).toBe('escalate');
  });

  /**
   * ★ 放行的表现是派发成功、CLI 启动时报一句没人看的参数错误，
   *   而界面上这个 Agent 显示为配置完好。
   */
  it('非法配置值在保存那一刻就被拒', async () => {
    const res = await createAgent({
      runtimeKind: 'claude_code',
      credential: 'env:KEY',
      runtimeConfig: { effort: 'ultra' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('推理强度');
  });

  it('超出范围的数字被拒并说明边界', async () => {
    const res = await createAgent({
      runtimeKind: 'claude_code',
      credential: 'env:KEY',
      runtimeConfig: { maxTurns: 9999 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.issues[0].message).toContain('500');
  });

  it('未知配置字段被丢弃而不是报错 —— schema 演进不能让老 Agent 改不动', async () => {
    const res = await createAgent({
      runtimeKind: 'claude_code',
      credential: 'env:KEY',
      runtimeConfig: { effort: 'low', legacyField: 'whatever' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().agent.runtimeConfig.legacyField).toBeUndefined();
  });

  it('改配置会替换注册表里的实例，而不是留着旧的', async () => {
    const created = await createAgent({ runtimeKind: 'mock', runtimeConfig: { stepDelayMs: 10 } });
    const id = created.json().agent.id;
    const before = registry.get(id);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/agents/${id}`,
      headers: auth(),
      payload: { runtimeConfig: { stepDelayMs: 500 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent.runtimeConfig.stepDelayMs).toBe(500);
    expect(registry.get(id)).not.toBe(before);
  });

  it('换 CLI 类型时旧参数不被原样带过去', async () => {
    const created = await createAgent({
      runtimeKind: 'claude_code',
      credential: 'env:KEY',
      runtimeConfig: { effort: 'max', maxTurns: 120 },
    });
    const id = created.json().agent.id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/agents/${id}`,
      headers: auth(),
      payload: { runtimeKind: 'codex' },
    });

    expect(res.statusCode).toBe(200);
    const cfg = res.json().agent.runtimeConfig;
    expect(cfg.effort).toBeUndefined();
    expect(cfg.approvalPolicy).toBe('never');
  });

  it('未知运行时类型被拒绝，并列出支持的类型', async () => {
    const res = await createAgent({ runtimeKind: 'gemini_cli' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.supported).toContain('claude_code');
  });
});

describe('凭证', () => {
  /** ★ 一个能从接口读出 token 的系统，早晚会有人把它贴进日志或截图 */
  it('永不回显，只给后四位', async () => {
    const res = await createAgent({
      runtimeKind: 'claude_code',
      credential: 'sk-ant-secret-value-9876',
    });
    expect(res.statusCode).toBe(201);
    expect(res.payload).not.toContain('sk-ant-secret-value');
    expect(res.json().agent.credentialHint).toBe('****9876');

    const list = await app.inject({ method: 'GET', url: '/api/v1/admin/agents', headers: auth() });
    expect(list.payload).not.toContain('sk-ant-secret-value');
    expect(list.payload).not.toContain('credentialRef');
  });

  it('库里存的是引用不是明文', async () => {
    await createAgent({ runtimeKind: 'claude_code', credential: 'sk-ant-plain-1234' });
    const [row] = await db.select().from(agents).where(eq(agents.runtimeKind, 'claude_code'));
    expect(row!.credentialRef).toMatch(/^secret:\/\/enc\//);
    expect(row!.credentialRef).not.toContain('sk-ant-plain');
  });

  it('env 形态不在库里留任何密文', async () => {
    await createAgent({ runtimeKind: 'claude_code', credential: 'env:MY_ANTHROPIC_KEY' });
    const [row] = await db.select().from(agents).where(eq(agents.runtimeKind, 'claude_code'));
    expect(row!.credentialRef).toBe('secret://env/MY_ANTHROPIC_KEY');
    expect(row!.credentialHint).toBe('env:MY_ANTHROPIC_KEY');
  });

  it('需要凭证的运行时不填时拒绝，并给出 env: 的替代写法', async () => {
    const res = await createAgent({ runtimeKind: 'claude_code' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('env:');
  });

  it('mock 不需要凭证', async () => {
    expect((await createAgent({ runtimeKind: 'mock' })).statusCode).toBe(201);
  });

  /**
   * ★ 取消接入层之后「这把凭证被谁在用」失去了天然的答案位置，
   *   靠聚合补回来 —— 轮换前能一眼看到要动几个 Agent。
   */
  it('凭证使用情况聚合出轮换成本', async () => {
    await createAgent({ name: 'a1', runtimeKind: 'claude_code', credential: 'env:SHARED_KEY' });
    await createAgent({ name: 'a2', runtimeKind: 'claude_code', credential: 'env:SHARED_KEY' });
    await createAgent({ name: 'a3', runtimeKind: 'claude_code', credential: 'sk-ant-inline-0001' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/agents', headers: auth() });
    const usage = res.json().credentialUsage as {
      hint: string;
      agents: string[];
      rotationCost: string;
    }[];

    const shared = usage.find((u) => u.hint === 'env:SHARED_KEY')!;
    expect(shared.agents.sort()).toEqual(['a1', 'a2']);
    // env 形态：改一个环境变量，两个 Agent 一起生效
    expect(shared.rotationCost).toBe('one_place');

    const inline = usage.find((u) => u.hint === '****0001')!;
    expect(inline.rotationCost).toBe('1_places');
  });
});

describe('Agent 档案与权限', () => {
  it('建档写入权限变更审计', async () => {
    const res = await createAgent();
    const changes = await db
      .select()
      .from(agentPermissionChanges)
      .where(eq(agentPermissionChanges.agentId, res.json().agent.id));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.direction).toBe('grant');
  });

  it('给了写工具却没有可写仓库范围时，配置阶段就拒绝', async () => {
    const res = await createAgent({
      allowedTools: ['Read', 'Edit'],
      resourceScopes: [{ kind: 'repo', ref: 'order-service', access: 'read' }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('可写的代码仓库范围');
  });

  it('同一个工具同时出现在允许与禁止列表时拒绝', async () => {
    const res = await createAgent({ allowedTools: ['Read', 'Bash'], deniedTools: ['Bash'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.conflict).toContain('Bash');
  });

  it('一个工具都不给时拒绝', async () => {
    expect((await createAgent({ allowedTools: [] })).statusCode).toBe(400);
  });

  /** ★ 放宽权限的默认解释（「大概是需要吧」）几乎总是不够 */
  it('放宽权限必须填原因，收紧不强制', async () => {
    const id = (await createAgent()).json().agent.id;

    const widen = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/agents/${id}`,
      headers: auth(),
      payload: { allowedTools: ['Read', 'Grep', 'Bash'] },
    });
    expect(widen.statusCode).toBe(400);
    expect(widen.json().error.message).toContain('必须填写原因');

    const narrow = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/agents/${id}`,
      headers: auth(),
      payload: { allowedTools: ['Read'] },
    });
    expect(narrow.statusCode).toBe(200);
  });

  it('填了原因的放宽被记入审计，含变更前后', async () => {
    const id = (await createAgent()).json().agent.id;
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/agents/${id}`,
      headers: auth(),
      payload: { allowedTools: ['Read', 'Grep', 'Bash'], reason: '需要跑测试' },
    });

    const changes = await db
      .select()
      .from(agentPermissionChanges)
      .where(eq(agentPermissionChanges.agentId, id));
    const widen = changes.find((c) => c.reason === '需要跑测试')!;
    expect(widen.direction).toBe('grant');
    expect(widen.before.allowedTools).not.toContain('Bash');
    expect(widen.after.allowedTools).toContain('Bash');
  });

  it('能力探测把缺失能力摊开', async () => {
    const id = (await createAgent()).json().agent.id;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/agents/${id}/probe`,
      headers: auth(),
    });

    const body = res.json();
    expect(body.registered).toBe(true);
    expect(body.capability.supported).toContain('streamingEvents');
    expect(body.capability.missing.map((m: { feature: string }) => m.feature)).toContain(
      'subAgentDelegation',
    );
  });

  it('没有历史记录的 Agent 可以真删', async () => {
    const id = (await createAgent()).json().agent.id;
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/agents/${id}`,
      headers: auth(),
    });
    expect(res.json().retired).toBe(false);
    expect(await db.select().from(agents).where(eq(agents.id, id))).toHaveLength(0);
  });

  it('负责人不存在时拒绝 —— 问责链条不能断', async () => {
    const res = await createAgent({ ownerId: '11111111-1111-4111-8111-111111111111' });
    expect(res.statusCode).toBe(404);
  });
});

describe('代码仓库与工程约定', () => {
  it('仓库凭证同样只回 hint，且 remoteUrl 里的内嵌凭证被抹掉', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/repositories',
      headers: auth(),
      payload: {
        ref: 'order-service',
        name: 'Order Service',
        remoteUrl: 'https://user:secretpass@github.com/acme/order-service.git',
        credential: 'ghp_token_abcd1234',
      },
    });
    expect(create.statusCode).toBe(201);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/repositories',
      headers: auth(),
    });
    expect(list.payload).not.toContain('secretpass');
    expect(list.payload).not.toContain('ghp_token_abcd');
    expect(list.json().repositories[0].credentialHint).toBe('****1234');
  });

  it('仓库标识重复时拒绝', async () => {
    const payload = {
      ref: 'order-service',
      name: 'Order Service',
      remoteUrl: 'https://github.com/acme/order-service.git',
    };
    await app.inject({ method: 'POST', url: '/api/v1/admin/repositories', headers: auth(), payload });
    const dup = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/repositories',
      headers: auth(),
      payload,
    });
    expect(dup.statusCode).toBe(409);
  });

  /** ★ 删了仓库，指向它的 Agent 会突然全部派发失败，而错误里不会提到删除 */
  it('还有 Agent 资源范围指向的仓库不能删', async () => {
    const repo = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/repositories',
      headers: auth(),
      payload: {
        ref: 'order-service',
        name: 'Order Service',
        remoteUrl: 'https://github.com/acme/order-service.git',
      },
    });
    await createAgent();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/repositories/${repo.json().repository.id}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.agents).toContain('code-agent-1');
  });

  it('工程约定列表带上「这里不配置治理规则」的说明', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}/conventions`,
      headers: auth(),
    });
    expect(res.json().notice).toContain('治理规则');
  });

  it('工程约定可增改删', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${fx.projectId}/conventions`,
      headers: auth(),
      payload: { title: '提交规范', content: '每个提交只做一件事', appliesTo: [] },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().convention.id;

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/conventions/${id}`,
      headers: auth(),
      payload: { enabled: false },
    });

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}/conventions`,
      headers: auth(),
    });
    expect(list.json().conventions[0].enabled).toBe(false);

    expect(
      (await app.inject({ method: 'DELETE', url: `/api/v1/conventions/${id}`, headers: auth() }))
        .statusCode,
    ).toBe(200);
  });
});
