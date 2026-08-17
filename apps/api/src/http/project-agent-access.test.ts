import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { agents, projectAgentPermissions, projects, projectMembers, repositories } from '@apos/db';
import { RuntimeRegistry } from '@apos/agent-runtimes';
import { buildApp } from '../app';
import { EventBus } from '../modules/event/bus';
import { StubPlanningProvider } from '../modules/planning/stub-provider';
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
import { seedAgent } from '../test/agent-fixtures';

/**
 * 项目级 Agent 权限。
 *
 * ★★ 这一组测的是产品在权限上最重要的那句承诺：
 *   **同一个 Agent 在两个项目里可以是两套权限，而且互不渗透。**
 *   旧模型（权限挂在 agents 上）表达不了它，绕开的办法是同一份配置
 *   建两个 Agent —— 而那两个的凭证、预算、统计从此各算各的。
 */

const db = testDb();
let app: FastifyInstance;
let fx: Fixture;
let agentId: string;

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
  agentId = (await seedAgent(db, fx)).agentId;
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await resetDb(db);
});

const auth = () => authFor(fx.userId);

const access = (headers = auth()) =>
  app.inject({
    method: 'GET',
    url: `/api/v1/projects/${fx.projectId}/agents/${agentId}/access`,
    headers,
  });

const save = (payload: Record<string, unknown>, headers = auth()) =>
  app.inject({
    method: 'PUT',
    url: `/api/v1/projects/${fx.projectId}/agents/${agentId}/access`,
    headers,
    payload,
  });

const preview = (payload: Record<string, unknown>, headers = auth()) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/projects/${fx.projectId}/agents/${agentId}/access/preview`,
    headers,
    payload,
  });

describe('★ 没配置不等于没权限', () => {
  /**
   * ★★ 整个能力档案层存在的理由。
   *   默认值不安全（或不可用）的系统里，真正的默认值是用户从别处抄来的配置。
   */
  it('没配过的 Agent 走默认档案，能在工作区里干活', async () => {
    const res = await access();

    expect(res.statusCode).toBe(200);
    expect(res.json().usingDefault).toBe(true);
    expect(res.json().profileKey).toBe('standard_executor');
    expect(res.json().capabilities).toContain('workspace.write');
    expect(res.json().capabilities).toContain('command.test');
  });

  it('默认 Agent 推不了、合不了、发不了、读不到凭证', async () => {
    const caps = (await access()).json().capabilities as string[];
    for (const forbidden of [
      'repository.push',
      'pull_request.merge',
      'environment.deploy',
      'database.write',
      'secret.read',
      'permission.manage',
      'policy.manage',
    ]) {
      expect(caps).not.toContain(forbidden);
    }
  });

  /** ★ 界面拿到的是人话，不是工具名 —— 用户不该再见到 Read / Edit / Bash */
  it('生效权限用人话说明，不出现运行时工具名', async () => {
    const body = (await access()).json();
    const explained = body.explained as { label: string }[];
    expect(explained.length).toBeGreaterThan(0);
    expect(JSON.stringify(explained)).not.toContain('Bash');
    expect(JSON.stringify(explained)).not.toContain('read_file');
  });
});

describe('★ 项目之间不渗透', () => {
  /**
   * ★★ 同一个 Agent，A 项目能推分支，B 项目不能。
   *   这是 project_agent_permissions 这张表存在的全部理由。
   */
  it('在 A 项目放宽不会带到 B 项目', async () => {
    const [other] = await db
      .insert(projects)
      .values({ orgId: fx.orgId, name: '另一个项目', identifier: 'OTHER' })
      .returning();
    await db.insert(projectMembers).values({
      orgId: fx.orgId,
      projectId: other!.id,
      actorType: 'agent',
      actorId: agentId,
      role: 'executor',
    });
    await db.insert(projectMembers).values({
      orgId: fx.orgId,
      projectId: other!.id,
      actorType: 'human',
      actorId: fx.userId,
      role: 'tech_lead',
    });

    const widened = await save({ profileKey: 'code_developer', reason: '这个项目要它自己开 PR' });
    expect(widened.statusCode).toBe(200);
    expect((await access()).json().capabilities).toContain('repository.push');

    const inOther = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${other!.id}/agents/${agentId}/access`,
      headers: auth(),
    });
    expect(inOther.json().usingDefault).toBe(true);
    expect(inOther.json().capabilities).not.toContain('repository.push');
  });

  it('不是本项目成员的 Agent 配不了权限', async () => {
    const [stranger] = await db
      .insert(agents)
      .values({
        orgId: fx.orgId,
        name: '外来 Agent',
        type: 'code',
        runtimeKind: 'mock',
        ownerId: fx.userId,
      })
      .returning();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fx.projectId}/agents/${stranger!.id}/access`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('成员');
  });

  it('看不到别的组织的 Agent 权限', async () => {
    const outsider = authFor((await createOutsider(db, fx, { orgRole: 'org_admin' })).userId);
    const res = await access(outsider);
    expect([403, 404]).toContain(res.statusCode);
  });
});

describe('★ 能力上限', () => {
  /**
   * ★★ 项目授予不得超过组织给这个 Agent 的上限。
   *   没有这条，谁能建项目谁就能给任意 Agent 任意权限。
   */
  it('超过 Agent 上限的能力授不出去', async () => {
    await db
      .update(agents)
      .set({ capabilityCeiling: ['workspace.read', 'workspace.write', 'command.test'] })
      .where(eq(agents.id, agentId));

    await save({ profileKey: 'code_developer', reason: '想让它自己开 PR' });

    const body = (await access()).json();
    expect(body.capabilities).not.toContain('repository.push');
    expect(body.sources).toContainEqual({
      capability: 'repository.push',
      source: 'agent_ceiling',
      denied: true,
    });
  });

  it('组织级硬拒绝压过项目档案', async () => {
    await db
      .update(agents)
      .set({ deniedCapabilities: ['repository.push'] })
      .where(eq(agents.id, agentId));

    await save({ profileKey: 'code_developer', reason: '试试' });
    expect((await access()).json().capabilities).not.toContain('repository.push');
  });
});

describe('★ 预览与保存', () => {
  /**
   * ★★ 预览和保存必须给出同一个结论。
   *   两边各算一套的话，「保存前告诉你会发生什么」就成了一句空话，
   *   而它失效的方式最难发现 —— 两条记录都各自自洽。
   */
  it('预览与保存给出同一个方向和同一批新增能力', async () => {
    const body = { profileKey: 'code_developer', reason: '要它自己开 PR' };

    const previewed = await preview(body);
    expect(previewed.json().direction).toBe('loosen');
    expect(previewed.json().addedCapabilities).toContain('repository.push');
    expect(previewed.json().requiresReason).toBe(true);

    const saved = await save(body);
    expect(saved.json().direction).toBe('loosen');
    expect(saved.json().addedCapabilities).toEqual(previewed.json().addedCapabilities);
  });

  /** ★ 预览是只读的：它不能顺手把东西存进去 */
  it('预览不写库', async () => {
    await preview({ profileKey: 'code_developer', reason: 'x' });
    const rows = await db
      .select()
      .from(projectAgentPermissions)
      .where(eq(projectAgentPermissions.agentId, agentId));
    expect(rows).toHaveLength(0);
  });

  it('预览把后果说成人话，最重的那条排在前面', async () => {
    const warnings = (await preview({ profileKey: 'code_developer' })).json().warnings as string[];
    expect(warnings[0]).toContain('远端');
  });

  it('收紧不要求填原因', async () => {
    await save({ profileKey: 'code_developer', reason: '先放宽' });
    const tightened = await save({ profileKey: 'readonly_reviewer' });
    expect(tightened.statusCode).toBe(200);
    expect(tightened.json().direction).toBe('tighten');
  });
});

describe('★ 放宽的治理要求', () => {
  /**
   * ★★ 放宽必须填原因 —— 由 PERMISSION_SPECS.governance 驱动，
   *   而不是各 handler 自己记得写。目录说要，就一定要。
   */
  it('放宽不填原因时被拒', async () => {
    const res = await save({ profileKey: 'code_developer' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('原因');

    const rows = await db
      .select()
      .from(projectAgentPermissions)
      .where(eq(projectAgentPermissions.agentId, agentId));
    expect(rows, '被拒的放宽不该留下任何记录').toHaveLength(0);
  });

  /**
   * ★★ 不对称设计：收紧门槛低（owner 就行），放宽门槛高（tech_lead）。
   *   判错方向两边都会坏 —— 见 domain 的 change-direction 那段。
   */
  it('只能收紧的人放宽不了', async () => {
    const memberId = await createMember(db, fx, { projectRole: 'executor' });
    const res = await save(
      { profileKey: 'code_developer', reason: '想要更多权限' },
      authFor(memberId),
    );
    expect(res.statusCode).toBe(403);
  });

  it('放宽写进领域事件，带上方向与原因', async () => {
    await save({ profileKey: 'code_developer', reason: '要它自己开 PR' });

    const { events } = await import('@apos/db');
    const rows = await db
      .select()
      .from(events)
      .where(eq(events.type, 'agent.permissions_changed'));

    const payload = rows.at(-1)!.payload as Record<string, unknown>;
    expect(payload['direction']).toBe('loosen');
    expect(payload['reason']).toBe('要它自己开 PR');
    expect(payload['addedCapabilities']).toContain('repository.push');
  });
});

describe('★ 档案升级不动既有 Agent', () => {
  /**
   * ★★ 存的是展开后的能力，不是一个指向档案的指针。
   *   存指针的话，平台给档案加一条能力，所有在跑的 Agent 会在没有任何人
   *   做过决定的情况下一起变宽 —— 权限累积最典型的发生方式。
   */
  it('保存的是展开后的能力清单，不是档案指针', async () => {
    await save({ profileKey: 'standard_executor', reason: null });

    const [row] = await db
      .select()
      .from(projectAgentPermissions)
      .where(eq(projectAgentPermissions.agentId, agentId));

    expect(row!.allowedCapabilities).toContain('workspace.write');
    expect(row!.deniedCapabilities).toContain('pull_request.merge');
    expect(row!.profileVersion).toBe(1);
  });
});

describe('★ 资源范围', () => {
  /**
   * ★ 加一条资源范围就是放宽：未列出的资源默认 none（§3.1 默认拒绝），
   *   从 none 升到 read 是放宽而不是中性。不这样判的话，
   *   「悄悄多授一个仓库」就成了一条不需要任何理由的操作。
   */
  it('新增资源范围算放宽，不填原因存不进去', async () => {
    const res = await save({
      profileKey: 'standard_executor',
      resourceScopes: [{ kind: 'repo', ref: 'order-service', access: 'read' }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('原因');
  });

  it('多条资源范围一起保存，一条都不丢', async () => {
    const scopes = [
      { kind: 'repo', ref: 'order-service', access: 'write' },
      { kind: 'repo', ref: 'payment-service', access: 'read' },
      { kind: 'dataset', ref: 'orders-2024', access: 'read' },
    ];
    /** ★ 新增资源范围是放宽（未列出的资源默认 none），所以要带原因 */
    const res = await save({
      profileKey: 'standard_executor',
      resourceScopes: scopes,
      reason: '这个项目要它同时读两个仓库和一份数据集',
    });
    expect(res.statusCode).toBe(200);

    const refs = ((await access()).json().resourceScopes as { ref: string }[]).map((s) => s.ref);
    expect(refs).toEqual(expect.arrayContaining(['order-service', 'payment-service', 'orders-2024']));
  });

  /**
   * ★ 只读档案配上可写仓库是自相矛盾的两句话，而运行时只看得到后者。
   *   让能力那一侧说了算。
   */
  it('只读档案下可写仓库被降级为只读', async () => {
    await save({
      profileKey: 'readonly_reviewer',
      resourceScopes: [{ kind: 'repo', ref: 'order-service', access: 'write' }],
      reason: '让它读这个仓库',
    });

    const scopes = (await access()).json().resourceScopes as { ref: string; access: string }[];
    expect(scopes.find((s) => s.ref === 'order-service')?.access).toBe('read');
  });

  it('项目级仓库默认只读，并标明是平台给的', async () => {
    await db.insert(repositories).values({
      orgId: fx.orgId,
      projectId: fx.projectId,
      ref: 'order-service',
      name: 'Order Service',
      remoteUrl: 'https://github.com/acme/order-service.git',
      createdBy: fx.userId,
    });

    const scopes = (await access()).json().resourceScopes as {
      ref: string;
      access: string;
      origin?: string;
    }[];
    expect(scopes.find((s) => s.ref === 'order-service')).toMatchObject({
      access: 'read',
      origin: 'project_default',
    });
  });
});

describe('★ 数据库守住成员关系', () => {
  /**
   * ★★ 「有权限记录的 Agent 一定是本项目成员」由外键保证，不是靠应用层记得查。
   *   放在应用层的话，先删成员再删权限之间有一个窗口，
   *   而那个窗口里的 Agent 拿着一份没人管的授权。
   */
  it('非成员的授权行插不进去', async () => {
    const [stranger] = await db
      .insert(agents)
      .values({
        orgId: fx.orgId,
        name: '外来 Agent',
        type: 'code',
        runtimeKind: 'mock',
        ownerId: fx.userId,
      })
      .returning();

    await expect(
      db.insert(projectAgentPermissions).values({
        orgId: fx.orgId,
        projectId: fx.projectId,
        agentId: stranger!.id,
        profileKey: 'standard_executor',
        profileVersion: 1,
        updatedBy: fx.userId,
      }),
    ).rejects.toThrow();
  });

  it('同一个项目里一个 Agent 只有一份授权', async () => {
    await save({ profileKey: 'standard_executor' });
    await save({ profileKey: 'readonly_reviewer' });

    const rows = await db
      .select()
      .from(projectAgentPermissions)
      .where(
        and(
          eq(projectAgentPermissions.projectId, fx.projectId),
          eq(projectAgentPermissions.agentId, agentId),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.profileKey).toBe('readonly_reviewer');
  });
});
