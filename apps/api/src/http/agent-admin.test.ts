import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  agentPermissionChanges,
  agentRuns,
  agents,
  projectAgentBindings,
  projectAgentPermissions,
  projectMembers,
  repositories,
  requirements,
} from '@apos/db';
import { RuntimeRegistry } from '@apos/agent-runtimes';
import { expandProfile, STANDARD_EXECUTOR } from '@apos/domain';
import { buildApp } from '../app';
import { EventBus } from '../modules/event/bus';
import { StubPlanningProvider } from '../modules/planning/stub-provider';
import {
  auth as authFor,
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

const auth = () => authFor(fx.userId);

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
      capabilityCeiling: ['workspace.read', 'workspace.write', 'command.test'],
      deniedCapabilities: [],
      ...payload,
    },
  });
}

/**
 * 给某个 Agent 在夹具项目里配一份授权。
 *
 * ★ 授权行对 project_members 有复合外键 —— 数据库保证「有授权的 Agent
 *   一定是本项目成员」，所以这里必须先登记成员，不能只插授权行。
 */
async function grantInProject(
  agentId: string,
  scopes: { kind: string; ref: string; access: string }[],
) {
  await db
    .insert(projectMembers)
    .values({
      orgId: fx.orgId,
      projectId: fx.projectId,
      actorType: 'agent',
      actorId: agentId,
      role: 'executor',
    })
    .onConflictDoNothing();

  const expanded = expandProfile(STANDARD_EXECUTOR);
  await db
    .insert(projectAgentPermissions)
    .values({
      orgId: fx.orgId,
      projectId: fx.projectId,
      agentId,
      profileKey: expanded.profileKey,
      profileVersion: expanded.profileVersion,
      allowedCapabilities: expanded.allowedCapabilities,
      deniedCapabilities: expanded.deniedCapabilities,
      resourceScopes: scopes as never,
      updatedBy: fx.userId,
    })
    .onConflictDoNothing();
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

  /**
   * ★ 两个方向都不能拒：schema 删过的老字段（legacyField）要让老 Agent 还改得动，
   *   平台还不认识的新字段要让人现在就能用上。所以一律原样收下。
   */
  it('未知配置字段原样保存而不是被丢弃或报错', async () => {
    const res = await createAgent({
      runtimeKind: 'claude_code',
      credential: 'env:KEY',
      runtimeConfig: { effort: 'low', legacyField: 'whatever' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().agent.runtimeConfig.legacyField).toBe('whatever');
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

  /**
   * ★ 例子要挑一个**永远不会被支持**的名字。
   *   这里原本用的是 `gemini_cli` —— 后来它真的接进来了，
   *   于是这条测试开始红，而红的原因和它想验证的东西毫无关系。
   */
  it('未知运行时类型被拒绝，并列出支持的类型', async () => {
    const res = await createAgent({ runtimeKind: 'definitely-not-a-runtime' });
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

/**
 * 环境变量表 —— 用户直接写一份 JSON 下发给子进程的那个口子。
 *
 * ★ 它同时是一条**新的凭证入口**（接中转站时 token 就写在这里），
 *   所以它必须遵守和凭证栏一样的纪律：接口永不回显；配了主密钥就密文入库。
 *   这一组测试盯的就是这件事。
 */
describe('运行时配置里的环境变量表', () => {
  const envAgent = (env: Record<string, string>, extra: Record<string, unknown> = {}) =>
    createAgent({
      runtimeKind: 'claude_code',
      credential: 'env:MY_KEY',
      runtimeConfig: { env },
      ...extra,
    });

  async function storedEnv() {
    const [row] = await db.select().from(agents).where(eq(agents.runtimeKind, 'claude_code'));
    return (row!.runtimeConfig as { env?: Record<string, string> }).env ?? {};
  }

  it('非敏感值原样保存，看得见也改得动', async () => {
    const res = await envAgent({ ANTHROPIC_BASE_URL: 'https://gw.example.com' });

    expect(res.statusCode).toBe(201);
    expect(res.json().agent.runtimeConfig.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://gw.example.com',
    });
    expect(await storedEnv()).toEqual({ ANTHROPIC_BASE_URL: 'https://gw.example.com' });
  });

  it('敏感键的字面量加密入库，接口只回占位符', async () => {
    const res = await envAgent({
      ANTHROPIC_BASE_URL: 'https://gw.example.com',
      ANTHROPIC_AUTH_TOKEN: 'sk-gateway-secret-4321',
    });

    expect(res.statusCode).toBe(201);
    // ★ 明文一次都不能出现在响应里
    expect(res.payload).not.toContain('sk-gateway-secret');
    expect(res.json().agent.runtimeConfig.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://gw.example.com',
      ANTHROPIC_AUTH_TOKEN: 'secret://saved',
    });

    const stored = await storedEnv();
    expect(stored['ANTHROPIC_AUTH_TOKEN']).toMatch(/^secret:\/\/enc\//);
    expect(stored['ANTHROPIC_AUTH_TOKEN']).not.toContain('sk-gateway-secret');

    const list = await app.inject({ method: 'GET', url: '/api/v1/admin/agents', headers: auth() });
    expect(list.payload).not.toContain('sk-gateway-secret');
    expect(list.payload).not.toContain('secret://enc/');
  });

  it('env: 形态什么都不进库，回显成原来的写法', async () => {
    const res = await envAgent({ ANTHROPIC_AUTH_TOKEN: 'env:GATEWAY_TOKEN' });

    expect(res.json().agent.runtimeConfig.env).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'env:GATEWAY_TOKEN',
    });
    expect(await storedEnv()).toEqual({ ANTHROPIC_AUTH_TOKEN: 'secret://env/GATEWAY_TOKEN' });
  });

  /**
   * ★★ 这是占位符存在的全部理由。
   *
   *   界面上那是一个 JSON 文本框，改网关地址时整份 JSON 会一起提交。
   *   占位符不被兑现的话，改一个字段就把同一份 JSON 里的 token
   *   冲成了字面量 "secret://saved" —— 而这件事直到下一次派发报 401 才会被发现。
   */
  it('回存占位符表示「这一项不改」，密文原封不动', async () => {
    const created = await envAgent({ ANTHROPIC_AUTH_TOKEN: 'sk-keep-me-1111' });
    const id = created.json().agent.id;
    const before = (await storedEnv())['ANTHROPIC_AUTH_TOKEN'];

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/agents/${id}`,
      headers: auth(),
      payload: {
        runtimeConfig: {
          env: {
            ANTHROPIC_AUTH_TOKEN: 'secret://saved',
            ANTHROPIC_BASE_URL: 'https://new-gw.example.com',
          },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const after = await storedEnv();
    expect(after['ANTHROPIC_AUTH_TOKEN']).toBe(before);
    expect(after['ANTHROPIC_BASE_URL']).toBe('https://new-gw.example.com');
  });

  it('新增一项时填占位符会被拒 —— 没有旧值可以沿用', async () => {
    const res = await envAgent({ ANTHROPIC_AUTH_TOKEN: 'secret://saved' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('ANTHROPIC_AUTH_TOKEN');
  });

  /**
   * ★ 放行的话，任何能编辑 Agent 的人都可以粘一条
   *   `secret://env/DATABASE_URL` 进来，把 APOS 自己进程环境里的任意变量
   *   读给 Agent —— 那正是 passthroughEnv 那份白名单要挡住的事。
   */
  it('手工填写的 secret:// 引用被拒，不能借它读平台的任意环境变量', async () => {
    const res = await envAgent({ SOME_VALUE: 'secret://env/DATABASE_URL' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('secret://');
  });

  it('值不是字符串时在保存那一刻就被拒', async () => {
    const res = await createAgent({
      runtimeKind: 'claude_code',
      credential: 'env:MY_KEY',
      runtimeConfig: { env: { MAX_TOKENS: 4096 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('MAX_TOKENS');
  });

  /**
   * ★ 接中转站时凭证就写在环境变量表里，凭证栏是空的。
   *   只认凭证栏的话，一个配好了、也确实能跑的 Agent 存都存不下来。
   */
  it('凭证写在环境变量表里时，凭证栏可以留空', async () => {
    const res = await createAgent({
      runtimeKind: 'claude_code',
      runtimeConfig: {
        env: { ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_AUTH_TOKEN: 'sk-gw-0001' },
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it('取不到值的引用在配置页上就说清楚，不等派发才炸', async () => {
    delete process.env['MISSING_GATEWAY_TOKEN'];
    const created = await envAgent({ ANTHROPIC_AUTH_TOKEN: 'env:MISSING_GATEWAY_TOKEN' });

    /**
     * ★ 断言的是**码与参数**，不是那句中文。
     *   界面照码取词，所以码错了才是 bug；中文句子只是日志兜底，
     *   盯着它写断言的话，改一个标点都会红。
     */
    expect(created.json().agent.runtimeConfigProblems).toEqual([
      {
        key: 'ANTHROPIC_AUTH_TOKEN',
        problem: '环境变量 ANTHROPIC_AUTH_TOKEN：环境变量 MISSING_GATEWAY_TOKEN 未设置',
        problemCode: 'env_not_set',
        problemParams: { name: 'MISSING_GATEWAY_TOKEN' },
      },
    ]);
  });

  /**
   * ★★ 配置是一份自定义 JSON：平台不认识的键原样存下来，只把它们说出来。
   *
   *   丢弃的表现是「我明明填了它没了」，拒绝的表现是「运行时升级了、
   *   平台还没发版，于是这个 Agent 存不下」—— 两条都会把人逼去改数据库。
   */
  it('不认识的配置键原样保存，并回给界面提示', async () => {
    const res = await createAgent({
      runtimeKind: 'claude_code',
      credential: 'env:MY_KEY',
      runtimeConfig: { effort: 'low', anthropicBaseUrl: 'https://gw.example.com' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().unknownConfigKeys).toEqual(['anthropicBaseUrl']);
    expect(res.json().agent.runtimeConfig.anthropicBaseUrl).toBe('https://gw.example.com');

    const [row] = await db.select().from(agents).where(eq(agents.runtimeKind, 'claude_code'));
    expect((row!.runtimeConfig as Record<string, unknown>)['anthropicBaseUrl']).toBe(
      'https://gw.example.com',
    );
  });

  /** 自定义键的值不受平台类型判据的管 —— 平台不知道它该长什么样 */
  it('自定义键可以是任意 JSON 值', async () => {
    const res = await createAgent({
      runtimeKind: 'claude_code',
      credential: 'env:MY_KEY',
      runtimeConfig: { mcpServers: { fs: { command: 'npx', args: ['-y', 'mcp-fs'] } }, retries: 3 },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().agent.runtimeConfig.mcpServers).toEqual({
      fs: { command: 'npx', args: ['-y', 'mcp-fs'] },
    });
    expect(res.json().agent.runtimeConfig.retries).toBe(3);
  });

  /** ★ 自定义键放行了，不等于已知键的错值也一起放行 */
  it('已知键的值写错仍然在保存那一刻被拒', async () => {
    const res = await createAgent({
      runtimeKind: 'claude_code',
      credential: 'env:MY_KEY',
      runtimeConfig: { effort: 'ultra', myOwnKey: 'x' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('推理强度');
  });

  /**
   * ★ 编辑时自定义键必须活下来。
   *   「打开编辑、改个模型、保存」把它们抹掉的话，接中转站的人每改一次
   *   常规配置就要重新贴一遍那几行 —— 而丢失是静默的。
   */
  it('改别的字段时自定义键不会被抹掉', async () => {
    const created = await createAgent({
      runtimeKind: 'claude_code',
      credential: 'env:MY_KEY',
      runtimeConfig: { effort: 'low', myOwnKey: 'keep-me' },
    });
    const id = created.json().agent.id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/agents/${id}`,
      headers: auth(),
      payload: { runtimeConfig: { effort: 'high', myOwnKey: 'keep-me' } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().agent.runtimeConfig.myOwnKey).toBe('keep-me');
    expect(res.json().agent.runtimeConfig.effort).toBe('high');
  });

  it('接入地址对 Claude Code 也可配，可以接中转站', async () => {
    const res = await createAgent({
      runtimeKind: 'claude_code',
      credential: 'env:MY_KEY',
      endpoint: 'https://gw.example.com',
      runtimeConfig: { credentialEnv: 'ANTHROPIC_AUTH_TOKEN' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().agent.endpoint).toBe('https://gw.example.com');
    expect(res.json().agent.runtimeConfig.credentialEnv).toBe('ANTHROPIC_AUTH_TOKEN');
  });
});

/**
 * 没配 APOS_SECRET_KEY 的部署。
 *
 * ★★ 主密钥决定的是「存成密文还是明文」，不是「能不能存」。
 *
 *   此前没配主密钥时接口直接拒绝一切粘贴进来的值。但运行时配置是一份
 *   用户自己写的 JSON，键名带 TOKEN/KEY/AUTH 的都会走同一条判定 ——
 *   于是「配一下中转站」变成了「先去改部署的环境变量再重启」，
 *   本机开发和演示环境尤其吃这个亏。
 */
describe('没有主密钥时的保存行为', () => {
  beforeEach(() => {
    delete process.env['APOS_SECRET_KEY'];
  });

  it('运行时 JSON 里的敏感值照样存得下，且接口仍然不回显', async () => {
    const res = await createAgent({
      runtimeKind: 'claude_code',
      runtimeConfig: {
        env: {
          ANTHROPIC_BASE_URL: 'https://gw.example.com',
          ANTHROPIC_AUTH_TOKEN: 'sk-no-master-key-9876',
        },
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.payload).not.toContain('sk-no-master-key');
    expect(res.json().agent.runtimeConfig.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://gw.example.com',
      ANTHROPIC_AUTH_TOKEN: 'secret://saved',
    });

    // 明文进库是这条路径的代价，但它带前缀 —— 脱敏靠认前缀，裸值会漏出去
    const [row] = await db.select().from(agents).where(eq(agents.runtimeKind, 'claude_code'));
    const stored = (row!.runtimeConfig as { env: Record<string, string> }).env;
    expect(stored['ANTHROPIC_AUTH_TOKEN']!.startsWith('secret://plain/')).toBe(true);

    const list = await app.inject({ method: 'GET', url: '/api/v1/admin/agents', headers: auth() });
    expect(list.payload).not.toContain('sk-no-master-key');
  });

  it('直接粘贴的凭证也存得下，并判为可用', async () => {
    const res = await createAgent({ runtimeKind: 'claude_code', credential: 'sk-pasted-1234' });

    expect(res.statusCode).toBe(201);
    expect(res.payload).not.toContain('sk-pasted-1234');
    expect(res.json().agent.credentialHint).toBe('****1234');
    /**
     * ★ 明文形态是可用的，不该被显示成故障。
     *   「明文入库」是部署的选择，页面上由 encryptsInlineSecrets 统一说一次，
     *   混进每个 Agent 的 problem 里会把真正的故障淹掉。
     */
    expect(res.json().agent.credentialUsable).toBe(true);
    expect(res.json().agent.credentialProblem).toBeNull();
  });

  it('目录如实回「不加密」，界面据此提示而不是禁用输入', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/admin/agents', headers: auth() });
    expect(list.json().encryptsInlineSecrets).toBe(false);

    process.env['APOS_SECRET_KEY'] = 'test-master-key';
    const again = await app.inject({ method: 'GET', url: '/api/v1/admin/agents', headers: auth() });
    expect(again.json().encryptsInlineSecrets).toBe(true);
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

  /**
   * ★★ 被某条需求指定为 PRD 编写者的 Agent 只停用不删除。
   *
   *   requirements.author_agent_id 是外键，直接 DELETE 会撞上 23503，
   *   而那个码没有映射 —— 用户点「删除」会得到一句「服务器内部错误」，
   *   看不出真正拦住它的是一条需求。
   */
  it('有需求指定它写 PRD 时，删除转为停用并说清是被什么牵连', async () => {
    const agentId = (await createAgent()).json().agent.id as string;
    const [req] = await db
      .insert(requirements)
      .values({
        orgId: fx.orgId,
        projectId: fx.projectId,
        rawInput: '订单查询太慢',
        authorAgentId: agentId,
      })
      .returning();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/agents/${agentId}`,
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().retired).toBe(true);
    expect(res.json().reason).toContain('PRD');

    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row!.status).toBe('retired');
    /**
     * ★ 引用留着不清空：清掉等于替用户撤销了他做过的指定，
     *   而他下次进那条需求只会看到「未指定」，没有任何迹象说明发生过什么。
     */
    const [after] = await db.select().from(requirements).where(eq(requirements.id, req!.id));
    expect(after!.authorAgentId).toBe(agentId);
  });

  /**
   * ★★ 每一条指向 agents.id 的外键都要在 deleteAgent 里被清点到。
   *
   *   这两条曾经漏掉：项目角色绑定与没有工作项的规划 Run。表现不是「漏检」，
   *   而是 23503 一路冒到错误处理器，用户点「删除」等来一句
   *   「服务器内部错误」—— 也就是「删除按钮坏了」。
   */
  it('被项目角色绑着时，删除转为停用而不是 500', async () => {
    const agentId = (await createAgent()).json().agent.id as string;
    await db.insert(projectMembers).values({
      projectId: fx.projectId,
      orgId: fx.orgId,
      actorType: 'agent',
      actorId: agentId,
      role: 'executor',
    });
    const bind = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${fx.projectId}/agents`,
      headers: auth(),
      payload: { role: 'planner', agentId },
    });
    expect(bind.statusCode).toBe(200);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/agents/${agentId}`,
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().retired).toBe(true);
    /** 只说「删不掉」没用 —— 得说清是绑定拦住的，用户才知道该去改绑 */
    expect(res.json().reason).toContain('绑定');

    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row!.status).toBe('retired');
    /** 绑定本身留着：替用户清掉的话，下一次规划会在「planner 没人」上失败 */
    const bindings = await db
      .select()
      .from(projectAgentBindings)
      .where(eq(projectAgentBindings.agentId, agentId));
    expect(bindings).toHaveLength(1);
  });

  /**
   * ★ 规划 Run 没有工作项（work_item_id 可空），所以「工作项的执行者是它」
   *   数不到它 —— 而 agent_runs.agent_id 是外键，删除照样撞 23503。
   */
  it('只有规划 Run（无工作项）的 Agent，删除转为停用而不是 500', async () => {
    const agentId = (await createAgent()).json().agent.id as string;
    await db.insert(agentRuns).values({
      orgId: fx.orgId,
      projectId: fx.projectId,
      agentId,
      kind: 'planning',
      status: 'completed',
      goal: '结构化需求',
      idempotencyKey: `planning-${agentId}`,
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/agents/${agentId}`,
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().retired).toBe(true);
    expect(res.json().reason).toContain('历史执行记录');
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row!.status).toBe('retired');
  });

  /** ★ 多种牵连要一次说全：只报第一条的话，用户解掉它再点删除，等来的是下一条 */
  it('同时被多种记录牵连时，理由逐条列全', async () => {
    const agentId = (await createAgent()).json().agent.id as string;
    await db.insert(requirements).values({
      orgId: fx.orgId,
      projectId: fx.projectId,
      rawInput: '订单查询太慢',
      authorAgentId: agentId,
    });
    await db.insert(agentRuns).values({
      orgId: fx.orgId,
      projectId: fx.projectId,
      agentId,
      kind: 'planning',
      status: 'completed',
      goal: '结构化需求',
      idempotencyKey: `planning-${agentId}`,
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/agents/${agentId}`,
      headers: auth(),
    });

    expect(res.json().reason).toContain('历史执行记录');
    expect(res.json().reason).toContain('PRD');
  });

  it('停用之后解除牵连，再点删除就真的删掉了', async () => {
    const agentId = (await createAgent()).json().agent.id as string;
    await db.insert(projectMembers).values({
      projectId: fx.projectId,
      orgId: fx.orgId,
      actorType: 'agent',
      actorId: agentId,
      role: 'executor',
    });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${fx.projectId}/agents`,
      headers: auth(),
      payload: { role: 'planner', agentId },
    });
    const first = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/agents/${agentId}`,
      headers: auth(),
    });
    expect(first.json().retired).toBe(true);

    await db.delete(projectAgentBindings).where(eq(projectAgentBindings.agentId, agentId));

    const second = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/agents/${agentId}`,
      headers: auth(),
    });
    expect(second.json().retired).toBe(false);
    expect(await db.select().from(agents).where(eq(agents.id, agentId))).toHaveLength(0);
  });

  it('没有任何牵连的 Agent 仍然是真删除', async () => {
    const agentId = (await createAgent()).json().agent.id as string;
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/agents/${agentId}`,
      headers: auth(),
    });

    expect(res.json().retired).toBe(false);
    expect(await db.select().from(agents).where(eq(agents.id, agentId))).toHaveLength(0);
  });

  /**
   * ★ 同一条能力既在上限里又在硬拒绝里，是自相矛盾的两句话。
   *   不报错的话，界面上那条能力看起来是给了的，而实际永远拿不到。
   */
  it('同一条能力同时出现在上限与硬拒绝时拒绝', async () => {
    const res = await createAgent({
      capabilityCeiling: ['workspace.read', 'repository.push'],
      deniedCapabilities: ['repository.push'],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.conflict).toContain('repository.push');
  });

  /**
   * ★★ 空清单与「不设上限」含义相反，必须分得开。
   *   混为一谈的话，想说「不限制」的人会得到一个在所有项目里都干不了活的 Agent。
   */
  it('上限给成空清单时拒绝，并说清「不设上限」该怎么写', async () => {
    const res = await createAgent({ capabilityCeiling: [] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('留空');
  });

  it('不传上限 = 不设上限，建得出来', async () => {
    const res = await createAgent({ capabilityCeiling: null });
    expect(res.statusCode).toBe(201);
    expect(res.json().agent.ceiling.capabilityCeiling).toBeNull();
  });

  /** ★ 放宽权限的默认解释（「大概是需要吧」）几乎总是不够 */
  it('放宽权限必须填原因，收紧不强制', async () => {
    const id = (await createAgent()).json().agent.id;

    const widen = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/agents/${id}`,
      headers: auth(),
      payload: { capabilityCeiling: ['workspace.read', 'workspace.write', 'command.test', 'repository.push'] },
    });
    expect(widen.statusCode).toBe(400);
    expect(widen.json().error.message).toContain('必须填写原因');

    const narrow = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/agents/${id}`,
      headers: auth(),
      payload: { capabilityCeiling: ['workspace.read'] },
    });
    expect(narrow.statusCode).toBe(200);
  });

  it('填了原因的放宽被记入审计，含变更前后', async () => {
    const id = (await createAgent()).json().agent.id;
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/agents/${id}`,
      headers: auth(),
      payload: {
        capabilityCeiling: ['workspace.read', 'workspace.write', 'command.test', 'repository.push'],
        reason: '需要跑测试',
      },
    });

    const changes = await db
      .select()
      .from(agentPermissionChanges)
      .where(eq(agentPermissionChanges.agentId, id));
    const widen = changes.find((c) => c.reason === '需要跑测试')!;
    expect(widen.direction).toBe('grant');
    const before = widen.before as { capabilityCeiling: string[] | null };
    const after = widen.after as { capabilityCeiling: string[] | null };
    expect(before.capabilityCeiling).not.toContain('repository.push');
    expect(after.capabilityCeiling).toContain('repository.push');
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

/**
 * 租户边界 —— Agent 与仓库登记。
 *
 * ★★ 与存储目标那一组同一条纪律（见 storage-targets.test.ts）：
 *   `/api/v1/admin/…` 不在 rbac 的两条作用域正则里，闸门只答得了
 *   「够不够格」，答不了「这个资源是谁的」。
 *
 * ★ Agent 上这道口子比仓库更要紧：Agent 挂着凭证引用与能力上限，
 *   越界改一个 Agent 等于改别人的执行主体 —— 把上限放开，
 *   它在对方所有项目里能拿到的授权跟着变宽，而对方那边不会有任何异常。
 *   `ownsAgent` 比的只是 ownerId，同样不看组织，指望不上。
 */
describe('★ 跨组织越界', () => {
  const attacker = async () =>
    authFor((await createOutsider(db, fx, { orgRole: 'org_admin' })).userId);

  const seedRepo = async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/repositories',
      headers: auth(),
      payload: {
        ref: 'order-service',
        name: 'Order Service',
        remoteUrl: 'https://github.com/acme/order-service.git',
      },
    });
    return created.json().repository.id as string;
  };

  it('改不动别的组织的 Agent', async () => {
    const agentId = (await createAgent()).json().agent.id;

    const denied = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/agents/${agentId}`,
      headers: await attacker(),
      payload: { capabilityCeiling: ['repository.push'], name: '已被改掉' },
    });
    expect(denied.statusCode).toBe(404);

    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row!.name).toBe('code-agent-1');
    expect(row!.capabilityCeiling).toEqual(['workspace.read', 'workspace.write', 'command.test']);
  });

  it('删不掉别的组织的 Agent', async () => {
    const agentId = (await createAgent()).json().agent.id;

    const denied = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/agents/${agentId}`,
      headers: await attacker(),
    });
    expect(denied.statusCode).toBe(404);
    expect(await db.select().from(agents).where(eq(agents.id, agentId))).toHaveLength(1);
  });

  it('探测不到别的组织的 Agent', async () => {
    const agentId = (await createAgent()).json().agent.id;

    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/agents/${agentId}/probe`,
      headers: await attacker(),
    });
    expect(denied.statusCode).toBe(404);
  });

  /**
   * ★ 仓库越界改的破坏力在 remoteUrl 上：把它指向攻击者的地址，
   *   对方后续的产出就推到攻击者手里，而两边都不会报错。
   */
  it('改不动别的组织的仓库登记', async () => {
    const repoId = await seedRepo();

    const denied = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/repositories/${repoId}`,
      headers: await attacker(),
      payload: { remoteUrl: 'https://github.com/attacker/evil.git' },
    });
    expect(denied.statusCode).toBe(404);

    const [row] = await db.select().from(repositories).where(eq(repositories.id, repoId));
    expect(row!.remoteUrl).toBe('https://github.com/acme/order-service.git');
  });

  it('删不掉别的组织的仓库登记', async () => {
    const repoId = await seedRepo();

    const denied = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/repositories/${repoId}`,
      headers: await attacker(),
    });
    expect(denied.statusCode).toBe(404);
    expect(await db.select().from(repositories).where(eq(repositories.id, repoId))).toHaveLength(1);
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

  /**
   * ★★ checkCommand 此前在界面上填不了：前端表单 state 里有它，
   *   提交时被丢掉，RepositoryInput 也不接受这个字段 ——
   *   而 schema 注释说它是「reviewing 阶段唯一的真实测试数据源」。
   *   也就是说这道质量门禁只能靠直接改数据库才配得上。
   */
  it('★ 质量核验命令能配、能改、能清空', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/repositories',
      headers: auth(),
      payload: {
        ref: 'order-service',
        name: 'Order Service',
        remoteUrl: 'https://github.com/acme/order-service.git',
        checkCommand: 'pnpm test',
        checkTimeoutSeconds: 600,
      },
    });
    expect(create.statusCode).toBe(201);

    const listed = async () =>
      (await app.inject({ method: 'GET', url: '/api/v1/admin/repositories', headers: auth() }))
        .json().repositories[0];

    expect(await listed()).toMatchObject({ checkCommand: 'pnpm test', checkTimeoutSeconds: 600 });

    const id = create.json().repository.id;
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/repositories/${id}`,
      headers: auth(),
      payload: { checkCommand: 'pnpm test -- --run' },
    });
    expect((await listed()).checkCommand).toBe('pnpm test -- --run');

    // null = 清空，回到「不跑核验」
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/repositories/${id}`,
      headers: auth(),
      payload: { checkCommand: null },
    });
    expect((await listed()).checkCommand).toBeNull();
  });

  /** ★ 不填核验命令时，reviewing 的门禁没有数据可依据 —— 这一条要说出来 */
  it('没配核验命令时给出警告', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/admin/repositories',
      headers: auth(),
      payload: {
        ref: 'order-service',
        name: 'Order Service',
        remoteUrl: 'https://github.com/acme/order-service.git',
      },
    });
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/repositories',
      headers: auth(),
    });
    expect(list.json().repositories[0].warnings.join()).toContain('Agent 自述');
  });

  /**
   * ★★ 凭证用户名占位：填错就是 401，而 401 的报错里没有任何东西指向它。
   *   在此之前它恒为 x-access-token，GitLab 私有仓库从来没通过。
   */
  describe('★ 凭证用户名占位', () => {
    const register = (over: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/repositories',
        headers: auth(),
        payload: {
          ref: 'r1',
          name: 'R',
          remoteUrl: 'https://github.com/acme/app.git',
          credential: 'env:PATH',
          ...over,
        },
      });

    const first = async () =>
      (await app.inject({ method: 'GET', url: '/api/v1/admin/repositories', headers: auth() }))
        .json().repositories[0];

    it('GitHub 推断成 x-access-token', async () => {
      await register({});
      expect(await first()).toMatchObject({
        authUsername: 'x-access-token',
        authUsernameSource: 'host',
        authProvider: 'GitHub',
      });
    });

    it('★ GitLab 推断成 oauth2', async () => {
      await register({ remoteUrl: 'https://gitlab.com/acme/app.git' });
      expect(await first()).toMatchObject({ authUsername: 'oauth2', authProvider: 'GitLab' });
    });

    it('★ 自建域名认不出来时警告，且明确点名 oauth2', async () => {
      await register({ remoteUrl: 'https://git.acme.internal/team/app.git' });
      const repo = await first();
      expect(repo.authUsernameSource).toBe('default');
      expect(repo.warnings.join()).toContain('oauth2');
    });

    it('显式指定优先于域名推断', async () => {
      await register({ remoteUrl: 'https://github.com/acme/app.git', authUsername: 'oauth2' });
      expect(await first()).toMatchObject({ authUsername: 'oauth2', authUsernameSource: 'explicit' });
    });

  });

  /**
   * ★★ SSH 形态。
   *
   *   这一整条链路的失败都不指向真实原因：带密码的私钥会让派发挂住而不是
   *   报错，主机公钥不固定的话 TOFU 等于没有校验，把 .pub 贴进 known_hosts
   *   的表现是「连不上」。所以每一条都要在**配置页上**被拦住或说出来。
   */
  describe('★ SSH 形态', () => {
    /** 现生成一把真 key —— 仓库里放私钥是绝对不行的，哪怕是测试用的 */
    const freshKey = (passphrase?: string) =>
      generateKeyPairSync('ed25519', {
        publicKeyEncoding: { format: 'pem', type: 'spki' },
        privateKeyEncoding: passphrase
          ? { format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase }
          : { format: 'pem', type: 'pkcs8' },
      }).privateKey;

    const register = (over: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/repositories',
        headers: auth(),
        payload: {
          ref: 'r1',
          name: 'R',
          remoteUrl: 'git@github.com:acme/app.git',
          ...over,
        },
      });

    const first = async () =>
      (await app.inject({ method: 'GET', url: '/api/v1/admin/repositories', headers: auth() }))
        .json().repositories[0];

    it('ssh 地址标成 ssh_key 形态，凭证 hint 认得出是私钥', async () => {
      expect((await register({ credential: freshKey() })).statusCode).toBe(201);
      const repo = await first();
      expect(repo.authKind).toBe('ssh_key');
      // ★ 私钥的后四位是 `----`，显示出来等于什么都没说
      expect(repo.credentialHint).toContain('私钥');
      expect(repo.credentialHint).not.toContain('----');
    });

    /**
     * ★★ 带密码的私钥必须在保存那一刻被拒。
     *   放进库的话失败会推迟到第一次派发，而且不是报错 ——
     *   是 ssh-add 挂在那里等密码，表现成「任务一直在执行中」。
     */
    it('★ 带密码短语的私钥当场拒绝，不进库', async () => {
      const res = await register({ credential: freshKey('hunter2') });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('密码短语');
      expect(await db.select().from(repositories)).toHaveLength(0);
    });

    it('★ 把 token 填给 ssh 地址会被拦下来', async () => {
      const res = await register({ credential: 'ghp_token_abcd1234' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('私钥');
    });

    it('★ 没配私钥时说明会回退到宿主机 ~/.ssh —— 容器里通常没有', async () => {
      await register({});
      expect((await first()).warnings.join()).toContain('~/.ssh');
    });

    /**
     * ★★ 不固定主机公钥的话 accept-new 等于 no：每次都是全新的临时
     *   known_hosts，「未知主机」这个条件永远成立。所以「什么时候会自动
     *   固定」这件事必须说出来 —— 不说没人猜得到。
     */
    it('★ 配了私钥但没固定主机公钥时给出说明', async () => {
      await register({ credential: freshKey() });
      const repo = await first();
      expect(repo.sshHostKeyPinned).toBe(false);
      expect(repo.warnings.join()).toContain('TOFU');
    });

    it('固定过之后不再警告，并回显固定了哪台主机', async () => {
      await register({
        credential: freshKey(),
        sshKnownHosts: 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoq',
      });
      const repo = await first();
      expect(repo.sshHostKeyPinned).toBe(true);
      expect(repo.sshHosts).toEqual(['github.com']);
      expect(repo.warnings.join()).not.toContain('TOFU');
    });

    /**
     * ★★ 这一栏**不加密**。把私钥贴进来等于私钥明文进库，
     *   而且没有任何提示 —— 必须在入口拦住。
     */
    it('★ 把私钥贴进「主机公钥」一栏要被拒', async () => {
      const res = await register({ credential: freshKey(), sshKnownHosts: freshKey() });
      expect(res.statusCode).toBe(400);
      expect(res.payload).toContain('不是私钥');
    });

    it('贴成 .pub 公钥格式也被拒，并指出该用 ssh-keyscan', async () => {
      const res = await register({
        sshKnownHosts: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMq me@laptop',
      });
      expect(res.statusCode).toBe(400);
      expect(res.payload).toContain('ssh-keyscan');
    });

    /** null = 清空，回到重新学习（服务器真换了密钥时要用） */
    it('主机公钥能改、能清空', async () => {
      const id = (await register({ credential: freshKey() })).json().repository.id;

      const patch = (sshKnownHosts: unknown) =>
        app.inject({
          method: 'PATCH',
          url: `/api/v1/admin/repositories/${id}`,
          headers: auth(),
          payload: { sshKnownHosts },
        });

      await patch('github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ');
      expect((await first()).sshHosts).toEqual(['github.com']);

      await patch(null);
      expect(await first()).toMatchObject({ sshKnownHosts: null, sshHostKeyPinned: false });
    });

    /**
     * ★ 凭证要按**改完之后**的地址验：把 https 仓库改成 ssh 地址、
     *   同时换上私钥，是一次提交里的两个字段。拿旧地址去验会把这一步
     *   判成「往 https 仓库里填了一把私钥」。
     */
    it('★ 同一次改动里换地址 + 换凭证，按新地址判定', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/repositories',
        headers: auth(),
        payload: {
          ref: 'r2',
          name: 'R2',
          remoteUrl: 'https://github.com/acme/app.git',
          credential: 'ghp_token_abcd1234',
        },
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/repositories/${create.json().repository.id}`,
        headers: auth(),
        payload: { remoteUrl: 'git@github.com:acme/app.git', credential: freshKey() },
      });

      expect(res.statusCode).toBe(200);
      expect(await first()).toMatchObject({ authKind: 'ssh_key' });
    });
  });

  /**
   * ★ 连通性探测存在的全部理由：凭证配错了要在配置页上知道，
   *   而不是等第一次派发看到「准备工作区失败：… 401」。
   */
  it('★ 探测在凭证取不到时直接说清楚，不去连远端', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/repositories',
      headers: auth(),
      payload: {
        ref: 'order-service',
        name: 'Order Service',
        remoteUrl: 'https://github.com/acme/order-service.git',
        credential: 'env:APOS_DEFINITELY_NOT_SET',
      },
    });

    const probe = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/repositories/${create.json().repository.id}/probe`,
      headers: auth(),
    });
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toMatchObject({ ok: false, stage: 'credential' });
    expect(probe.json().message).toContain('APOS_DEFINITELY_NOT_SET');
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
  /**
   * ★ 引用检查读的是**项目级**授权（project_agent_permissions），
   *   不再是 agents 上那份组织级旧字段 —— 后者自 Phase 5 起不再写入，
   *   还照着它查的话这道把关会永远查出 0 条，而删除仍然会打断在跑的项目。
   */
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
    const agentId = (await createAgent()).json().agent.id as string;
    await grantInProject(agentId, [{ kind: 'repo', ref: 'order-service', access: 'read' }]);

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
