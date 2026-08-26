import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { requirements } from '@apos/db';
import { randomUUID } from 'node:crypto';
import { resetDb, seedFixture, testDb, type Fixture } from '../../test/db';
import { seedAgent } from '../../test/agent-fixtures';
import { StubPlanningProvider } from '../planning/stub-provider';
import type {
  GeneratedPlan,
  PlanningProvider,
  PlanningScope,
  StructureInput,
  StructuredRequirement,
} from '../planning/provider';
import { analyzeRequirement, approveRequirement, setRequirementAuthorAgent } from './service';

const db = testDb();
let fx: Fixture;

beforeEach(async () => {
  await resetDb(db);
  fx = await seedFixture(db);
});

/**
 * 记下调用方给了什么 scope —— 这一层要验的正是「需求上选定的编写 Agent
 * 有没有被传下去」，而挑执行者本身发生在 provider 里面。
 */
class CapturingProvider implements PlanningProvider {
  readonly name = 'capturing';
  scope: PlanningScope | undefined;
  /** 有没有把 agentId 这个键**摆上去**（区分「给了 undefined」和「没给」） */
  hasAgentIdKey = false;

  /** ★ 按接口类型持有：StubPlanningProvider 的 generatePlan 少声明了 scope 形参 */
  private readonly inner: PlanningProvider = new StubPlanningProvider();

  async structureRequirement(input: StructureInput): Promise<StructuredRequirement> {
    this.scope = input.scope;
    this.hasAgentIdKey = Boolean(input.scope && 'agentId' in input.scope);
    return this.inner.structureRequirement(input);
  }

  async generatePlan(
    req: StructuredRequirement,
    projectType: string,
    feedback?: string,
    scope?: PlanningScope,
  ): Promise<GeneratedPlan> {
    return this.inner.generatePlan(req, projectType, feedback, scope);
  }
}

async function createRequirement(rawInput = '订单查询太慢') {
  const [row] = await db
    .insert(requirements)
    .values({ orgId: fx.orgId, projectId: fx.projectId, rawInput })
    .returning();
  return row!.id;
}

describe('分析时把需求上选定的编写 Agent 传下去', () => {
  it('选过 Agent 的需求，scope 里带着它', async () => {
    const id = await createRequirement();
    const author = await seedAgent(db, fx, { name: 'prd-writer' });
    await setRequirementAuthorAgent(db, {
      requirementId: id,
      agentId: author.agentId,
      actorId: fx.userId,
      correlationId: randomUUID(),
    });

    const provider = new CapturingProvider();
    await analyzeRequirement(db, provider, { requirementId: id, correlationId: randomUUID() });

    expect(provider.scope?.agentId).toBe(author.agentId);
    expect(provider.scope?.requirementId).toBe(id);
  });

  /**
   * ★★ 没选过的时候连**键**都不该出现。
   *
   *   provider 那边是按「有没有 agentId」分岔的：塞一个空串或 null 进去，
   *   所有没选过的需求都会走进点名分支，然后一律以「指定的 Agent 已不存在」
   *   失败 —— 而这是绝大多数需求的默认状态。
   */
  it('没选过的需求，scope 里连 agentId 这个键都没有', async () => {
    const id = await createRequirement();

    const provider = new CapturingProvider();
    await analyzeRequirement(db, provider, { requirementId: id, correlationId: randomUUID() });

    expect(provider.hasAgentIdKey).toBe(false);
    expect(provider.scope?.projectId).toBe(fx.projectId);
  });

  it('换过一次之后，下一次分析跟着换', async () => {
    const id = await createRequirement();
    const first = await seedAgent(db, fx, { name: 'writer-1' });
    const second = await seedAgent(db, fx, { name: 'writer-2' });

    const provider = new CapturingProvider();
    await setRequirementAuthorAgent(db, {
      requirementId: id,
      agentId: first.agentId,
      actorId: fx.userId,
      correlationId: randomUUID(),
    });
    await analyzeRequirement(db, provider, { requirementId: id, correlationId: randomUUID() });
    expect(provider.scope?.agentId).toBe(first.agentId);

    await setRequirementAuthorAgent(db, {
      requirementId: id,
      agentId: second.agentId,
      actorId: fx.userId,
      correlationId: randomUUID(),
    });
    await analyzeRequirement(db, provider, { requirementId: id, correlationId: randomUUID() });
    expect(provider.scope?.agentId).toBe(second.agentId);
  });

  /**
   * ★ 分析本身不该动这个选择 —— 它是人做的决定，不是分析的产物。
   */
  it('分析不会清掉或改写已选的编写 Agent', async () => {
    const id = await createRequirement();
    const author = await seedAgent(db, fx, { name: 'prd-writer' });
    await setRequirementAuthorAgent(db, {
      requirementId: id,
      agentId: author.agentId,
      actorId: fx.userId,
      correlationId: randomUUID(),
    });

    await analyzeRequirement(db, new CapturingProvider(), {
      requirementId: id,
      correlationId: randomUUID(),
    });

    const [row] = await db.select().from(requirements).where(eq(requirements.id, id));
    expect(row!.authorAgentId).toBe(author.agentId);
  });
});

describe('setRequirementAuthorAgent 的判据', () => {
  it('不是本项目成员的 Agent 被拒，库里不动', async () => {
    const id = await createRequirement();
    const outsider = await seedAgent(db, fx, { name: 'outsider', inProject: false });

    const result = await setRequirementAuthorAgent(db, {
      requirementId: id,
      agentId: outsider.agentId,
      actorId: fx.userId,
      correlationId: randomUUID(),
    });

    expect(result).toMatchObject({ ok: false, code: 'NOT_PROJECT_MEMBER' });
    const [row] = await db.select().from(requirements).where(eq(requirements.id, id));
    expect(row!.authorAgentId).toBeNull();
  });

  /**
   * ★★ 项目里的**任何**一个 Agent 成员都写得了 PRD。
   *
   *   这里以前卡一条从派工作项那边借来的判据（按 applicableTypes 匹配
   *   执行者），而写 PRD 不派工作项 —— 借过来的后果是一个配了整队 Agent
   *   的项目，能写 PRD 的却是零个。那一栏现在整个不存在了。
   */
  it('任何一个 Agent 成员都能被指定为编写者，并且真的落库', async () => {
    const id = await createRequirement();
    const coder = await seedAgent(db, fx, { name: 'coder' });

    const result = await setRequirementAuthorAgent(db, {
      requirementId: id,
      agentId: coder.agentId,
      actorId: fx.userId,
      correlationId: randomUUID(),
    });

    expect(result).toMatchObject({ ok: true, agentId: coder.agentId, agentName: 'coder' });
    const [row] = await db.select().from(requirements).where(eq(requirements.id, id));
    expect(row!.authorAgentId).toBe(coder.agentId);
  });

  /**
   * ★ 成员校验是**授权**，与「谁写得了 PRD」那条放宽是两回事 ——
   *   放宽了后者，前者一道不减。规划 Run 会把项目资源只读挂进 Agent 的工作区。
   */
  it('放宽编写者判据之后，非成员仍然被拒 —— 授权那道没跟着松', async () => {
    const id = await createRequirement();
    const outsider = await seedAgent(db, fx, { name: 'outsider-coder', inProject: false });

    const result = await setRequirementAuthorAgent(db, {
      requirementId: id,
      agentId: outsider.agentId,
      actorId: fx.userId,
      correlationId: randomUUID(),
    });

    expect(result).toMatchObject({ ok: false, code: 'NOT_PROJECT_MEMBER' });
  });
});

describe('规则占位需求不能冒充完整 PRD', () => {
  it('占位模式不编造验收标准，且未经人工补全不能批准', async () => {
    const id = await createRequirement('做一个最小待办事项应用');
    const result = await analyzeRequirement(db, new StubPlanningProvider({ placeholder: true }), {
      requirementId: id,
      correlationId: randomUUID(),
    });

    expect(result.completeness.goal).toBe(0);
    expect(result.completeness.acceptance).toBe(0);
    const [row] = await db.select().from(requirements).where(eq(requirements.id, id));
    expect(row!.acceptanceCriteria).toEqual([]);
    expect(row!.scope).toEqual({ inScope: [], outOfScope: [] });

    const approved = await approveRequirement(db, {
      requirementId: id,
      approverId: fx.userId,
      correlationId: randomUUID(),
    });
    expect(approved).toMatchObject({
      ok: false,
      code: 'FALLBACK_REQUIRES_MANUAL_COMPLETION',
    });
  });
});
