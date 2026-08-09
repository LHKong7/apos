import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { agentPermissionChanges, agentRuntimes, agents } from '@apos/db';
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

async function createRuntime(payload: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/admin/runtimes',
    headers: auth(),
    payload: { name: 'mock-1', kind: 'mock', ...payload },
  });
}

async function createAgent(runtimeId: string, payload: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/admin/agents',
    headers: auth(),
    payload: {
      name: 'code-agent-1',
      type: 'code',
      runtimeId,
      ownerId: fx.userId,
      allowedTools: ['Read', 'Grep'],
      deniedTools: [],
      resourceScopes: [{ kind: 'repo', ref: 'order-service', access: 'read' }],
      ...payload,
    },
  });
}

describe('运行时接入', () => {
  it('新建后立刻注册到本进程，不必等下一轮同步', async () => {
    const res = await createRuntime();
    expect(res.statusCode).toBe(201);

    const rt = res.json().runtime;
    expect(rt.registered).toBe(true);
    expect(rt.reachable).toBe(true);
    expect(registry.has(rt.id)).toBe(true);
  });

  /** ★ 一个能从接口读出 token 的系统，早晚会有人把它贴进日志或截图 */
  it('凭证永不回显，只给后四位', async () => {
    const res = await createRuntime({
      kind: 'claude_code',
      name: 'claude',
      credential: 'sk-ant-secret-value-9876',
    });
    expect(res.statusCode).toBe(201);

    const raw = res.payload;
    expect(raw).not.toContain('sk-ant-secret-value');
    expect(res.json().runtime.credentialHint).toBe('****9876');

    const list = await app.inject({ method: 'GET', url: '/api/v1/admin/runtimes', headers: auth() });
    expect(list.payload).not.toContain('sk-ant-secret-value');
    expect(list.payload).not.toContain('credentialRef');
  });

  it('库里存的是引用不是明文', async () => {
    await createRuntime({ kind: 'claude_code', name: 'claude', credential: 'sk-ant-plain-1234' });
    const [row] = await db.select().from(agentRuntimes).where(eq(agentRuntimes.kind, 'claude_code'));
    expect(row!.credentialRef).toMatch(/^secret:\/\/enc\//);
    expect(row!.credentialRef).not.toContain('sk-ant-plain');
  });

  it('env: 形态不在库里留任何密文', async () => {
    await createRuntime({ kind: 'claude_code', name: 'claude', credential: 'env:MY_ANTHROPIC_KEY' });
    const [row] = await db.select().from(agentRuntimes).where(eq(agentRuntimes.kind, 'claude_code'));
    expect(row!.credentialRef).toBe('secret://env/MY_ANTHROPIC_KEY');
    expect(row!.credentialHint).toBe('env:MY_ANTHROPIC_KEY');
  });

  it('需要凭证的运行时不填凭证时拒绝，并给出 env: 的替代写法', async () => {
    const res = await createRuntime({ kind: 'claude_code', name: 'claude' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('env:');
  });

  it('未知运行时类型被拒绝，并列出支持的类型', async () => {
    const res = await createRuntime({ kind: 'gemini_cli' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.supported).toContain('claude_code');
  });

  /**
   * ★ 删掉还在用的运行时，会让挂在它上面的 Agent 立刻派不出任务，
   *   而错误信息不会提到有人删了一个运行时。
   */
  it('还有 Agent 挂着的运行时不能删', async () => {
    const rt = (await createRuntime()).json().runtime;
    await createAgent(rt.id);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/runtimes/${rt.id}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.agents).toContain('code-agent-1');
  });

  it('能力探测把「没注册」「连不上」「缺能力」分开报', async () => {
    const rt = (await createRuntime()).json().runtime;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/runtimes/${rt.id}/probe`,
      headers: auth(),
    });

    const body = res.json();
    expect(body.registered).toBe(true);
    expect(body.reachable).toBe(true);
    expect(body.capability.supported).toContain('streamingEvents');
    // mock 不支持子 Agent 委派 —— 缺什么要摊开说
    expect(body.capability.missing.map((m: { feature: string }) => m.feature)).toContain(
      'subAgentDelegation',
    );
  });
});

describe('Agent 档案', () => {
  it('建档写入权限变更审计', async () => {
    const rt = (await createRuntime()).json().runtime;
    const res = await createAgent(rt.id);
    expect(res.statusCode).toBe(201);

    const changes = await db
      .select()
      .from(agentPermissionChanges)
      .where(eq(agentPermissionChanges.agentId, res.json().agent.id));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.direction).toBe('grant');
  });

  /**
   * ★ 这类组合不在配置时报错的话，表现是 Agent 一动手就被拒，
   *   而配置页上明明勾着 Edit。
   */
  it('给了写工具却没有可写仓库范围时，配置阶段就拒绝', async () => {
    const rt = (await createRuntime()).json().runtime;
    const res = await createAgent(rt.id, {
      allowedTools: ['Read', 'Edit'],
      resourceScopes: [{ kind: 'repo', ref: 'order-service', access: 'read' }],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('可写的代码仓库范围');
  });

  it('同一个工具同时出现在允许与禁止列表时拒绝 —— 用户以为自己授权了', async () => {
    const rt = (await createRuntime()).json().runtime;
    const res = await createAgent(rt.id, {
      allowedTools: ['Read', 'Bash'],
      deniedTools: ['Bash'],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.conflict).toContain('Bash');
  });

  it('一个工具都不给时拒绝', async () => {
    const rt = (await createRuntime()).json().runtime;
    const res = await createAgent(rt.id, { allowedTools: [] });
    expect(res.statusCode).toBe(400);
  });

  /** ★ 放宽权限的默认解释（「大概是需要吧」）几乎总是不够 */
  it('放宽权限必须填原因，收紧不强制', async () => {
    const rt = (await createRuntime()).json().runtime;
    const agentId = (await createAgent(rt.id)).json().agent.id;

    const widen = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/agents/${agentId}`,
      headers: auth(),
      payload: { allowedTools: ['Read', 'Grep', 'Bash'] },
    });
    expect(widen.statusCode).toBe(400);
    expect(widen.json().error.message).toContain('必须填写原因');

    const narrow = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/agents/${agentId}`,
      headers: auth(),
      payload: { allowedTools: ['Read'] },
    });
    expect(narrow.statusCode).toBe(200);
  });

  it('填了原因的放宽被记入审计，含变更前后', async () => {
    const rt = (await createRuntime()).json().runtime;
    const agentId = (await createAgent(rt.id)).json().agent.id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/agents/${agentId}`,
      headers: auth(),
      payload: { allowedTools: ['Read', 'Grep', 'Bash'], reason: '需要跑测试' },
    });
    expect(res.statusCode).toBe(200);

    const changes = await db
      .select()
      .from(agentPermissionChanges)
      .where(eq(agentPermissionChanges.agentId, agentId));
    const widen = changes.find((c) => c.reason === '需要跑测试');
    expect(widen).toBeTruthy();
    expect(widen!.direction).toBe('grant');
    expect(widen!.before.allowedTools).not.toContain('Bash');
    expect(widen!.after.allowedTools).toContain('Bash');
  });

  it('停用的运行时不能挂新 Agent', async () => {
    const rt = (await createRuntime()).json().runtime;
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/runtimes/${rt.id}`,
      headers: auth(),
      payload: { status: 'disabled' },
    });

    const res = await createAgent(rt.id, { name: 'agent-2' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('已停用');
  });

  it('没有历史记录的 Agent 可以真删', async () => {
    const rt = (await createRuntime()).json().runtime;
    const agentId = (await createAgent(rt.id)).json().agent.id;

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/agents/${agentId}`,
      headers: auth(),
    });
    expect(res.json().retired).toBe(false);
    expect(await db.select().from(agents).where(eq(agents.id, agentId))).toHaveLength(0);
  });

  it('负责人不存在时拒绝 —— 问责链条不能断', async () => {
    const rt = (await createRuntime()).json().runtime;
    const res = await createAgent(rt.id, { ownerId: '11111111-1111-4111-8111-111111111111' });
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
    const rt = (await createRuntime()).json().runtime;
    await createAgent(rt.id);

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
    expect(res.statusCode).toBe(200);
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

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/conventions/${id}`,
      headers: auth(),
    });
    expect(del.statusCode).toBe(200);
  });
});
