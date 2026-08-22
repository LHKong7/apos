import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { policies } from '@apos/db';
import { AUTHORED_PRIORITY_MIN, OPERATION_SWITCH_PRIORITY } from '@apos/contracts';
import { resetDb, seedFixture, testDb, type Fixture } from '../test/db';
import {
  clearOperationSwitch,
  getPolicies,
  loadProjectPolicies,
  nextAuthoredPriority,
  savePolicy,
  setOperationSwitch,
} from './policies';

/**
 * The operation switch matrix / 操作开关矩阵。
 *
 * ★★ This group watches three things, each of them a risk the switch shape itself introduces:
 *
 *   1. One row, one rule. Flipping twice must not leave two rules behind — otherwise the
 *      promise "delete that rule and you are back where you started" is void, and that promise
 *      is the entire basis for trusting a one-click control.
 *   2. Hand-written rules are untouched. The switch only adds its own rule at the front; not
 *      one rule somebody else wrote is modified.
 *   3. A flip may not take effect, and when it does not, say so. An existing rule or the safety
 *      floor can still stand in front of it; reporting "saved" instead of reporting the outcome
 *      leaves the user believing they opened something up when they did not.
 *   这一组盯的是三件事，每一件都是「开关」这个形态本身带来的风险：
 *   1. 一行一条规则。切两次不该留下两条 —— 否则「删掉那条规则即还原」
 *      这个承诺当场作废，而它是一键操作能被信任的全部依据。
 *   2. 不碰手写规则。开关只在最前面加自己那一条，别人写的一条不动。
 *   3. 切换可能不生效，而不生效必须说出来。已有规则或安全底线仍然可能
 *      拦在前面；报「已保存」而不报结果，用户会以为自己放开了，实际没有。
 */
const db = testDb();
let fx: Fixture;

beforeEach(async () => {
  await resetDb(db);
  fx = await seedFixture(db);
});

afterAll(async () => {
  await resetDb(db);
});

const projectRules = async () =>
  (await db.select().from(policies).where(eq(policies.projectId, fx.projectId))).sort(
    (a, b) => a.priority - b.priority,
  );

describe('操作开关矩阵', () => {
  it('切一次开关生成一条项目规则，排在手写规则前面', async () => {
    const result = await setOperationSwitch(
      db,
      fx.projectId,
      { operationType: 'code_change', verdict: 'human', name: 'Code changes need a person' },
      fx.userId,
    );

    const rows = await projectRules();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.priority).toBe(OPERATION_SWITCH_PRIORITY);
    expect(rows[0]!.name).toBe('Code changes need a person');
    expect(rows[0]!.condition).toEqual({ fact: 'operationType', op: 'eq', value: 'code_change' });
    expect(result.applied).toBe(true);
    expect(result.outcome?.verdict).toBe('human');
  });

  /**
   * ★★ Flipping again **edits that same rule**; it does not stack a new one on top.
   *   Stacking would leave "deploy → auto → human → auto" as three rules, and the user can
   *   neither tell which one to delete nor see which one is still in force.
   *   再切一次是**改这一条**，不是叠一条新的。
   *   叠加的话「部署 → 自动 → 需人 → 自动」会留下三条规则，
   *   用户不知道该删哪一条，也看不出哪一条还在生效。
   */
  it('★ 同一行再切一次是改那一条，不是叠一条新的', async () => {
    await setOperationSwitch(db, fx.projectId, { operationType: 'code_change', verdict: 'human' }, fx.userId);
    const first = (await projectRules())[0]!;

    await setOperationSwitch(db, fx.projectId, { operationType: 'code_change', verdict: 'auto' }, fx.userId);

    const rows = await projectRules();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first.id);
    expect(rows[0]!.action).toEqual({ type: 'allow' });
  });

  it('不同操作类型各占一条，互不影响', async () => {
    await setOperationSwitch(db, fx.projectId, { operationType: 'code_change', verdict: 'auto' }, fx.userId);
    await setOperationSwitch(db, fx.projectId, { operationType: 'deploy', verdict: 'human' }, fx.userId);

    const rows = await projectRules();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.action).map((a) => (a as { type: string }).type).sort()).toEqual([
      'allow',
      'require_human_review',
    ]);
  });

  /**
   * ★ A hand-written rule is intent the user has already expressed; one click must not quietly
   *   rewrite it / 用户手写的规则是他表达过的意图，一次点击不该把它悄悄改写
   */
  it('★ 不改也不删手写规则', async () => {
    const authored = await savePolicy(
      db,
      fx.projectId,
      {
        name: '手写的：预算八成时提醒',
        priority: 200,
        condition: { fact: 'budgetUsedPct', op: 'gte', value: 80 },
        action: { type: 'ask', assignee: { kind: 'project_role', role: 'tech_lead' } },
      },
      fx.userId,
    );

    await setOperationSwitch(db, fx.projectId, { operationType: 'code_change', verdict: 'auto' }, fx.userId);

    const [kept] = await db.select().from(policies).where(eq(policies.id, authored.policy.id));
    expect(kept!.priority).toBe(200);
    expect(kept!.action).toEqual(authored.policy.action);
    expect(await projectRules()).toHaveLength(2);
  });

  /** Picking an environment as the scope adds that one term to the condition; every other
   *  environment keeps following whatever rule it followed before */
  it('限定环境时条件里带上 environment', async () => {
    await setOperationSwitch(
      db,
      fx.projectId,
      { operationType: 'deploy', verdict: 'human', environment: 'production' },
      fx.userId,
    );

    const rows = await projectRules();
    expect(rows[0]!.condition).toEqual({
      all: [
        { fact: 'operationType', op: 'eq', value: 'deploy' },
        { fact: 'environment', op: 'eq', value: 'production' },
      ],
    });
    // Only production is governed here; other environments are still decided by other rules or
    // the default policy, so this row reads as "it depends"
    const { summary } = await getPolicies(db, fx.projectId);
    expect(summary.depends.map((o) => o.operationType)).toContain('deploy');
  });

  /**
   * ★★ A flip may not take effect, and when it does not, say so.
   *   Deleting a resource is never auto-approved (a safety floor, hard-coded in the evaluator) —
   *   the switch still stores the rule, but the row's real state remains "needs a human".
   *   Reporting "saved" instead of reporting the outcome is exactly the lie this page must avoid.
   *   切换可能不生效，而不生效必须说出来。
   *   删除资源永远不自动放行（安全底线，硬编码在求值器里）——
   *   开关照样存下了那条规则，但这一行的实际状态仍然是「需人」。
   *   报「已保存」而不报结果，正是这一页最该避免的那种谎。
   */
  it('★ 安全底线挡下的切换如实报告「没生效」', async () => {
    const result = await setOperationSwitch(
      db,
      fx.projectId,
      { operationType: 'delete_resource', verdict: 'auto' },
      fx.userId,
    );

    expect(result.applied).toBe(false);
    expect(result.outcome?.verdict).toBe('human');
    expect(result.blockedBy).toBe('safety_floor');
  });

  /**
   * ★ When another rule stands in the way, name it — reporting only "did not take effect" hands
   *   the investigation back to the user /
   *   被别的规则挡住时要说出是哪一条，只报「没生效」等于把排查退回给用户
   */
  it('★ 被组织规则挡住时报出挡路的规则', async () => {
    await db.insert(policies).values({
      orgId: fx.orgId,
      projectId: null,
      name: '组织规则：部署一律要人',
      description: '',
      priority: 10,
      enabled: true,
      createdBy: fx.userId,
      condition: { fact: 'operationType', op: 'eq', value: 'deploy' },
      action: {
        type: 'require_human_review',
        assignee: { kind: 'role', role: 'release_manager' },
        dueInHours: 4,
      },
    });

    /**
     * The switch wants to open up production deploys — the org rule sorts ahead of it
     * (10 < 100), so it wins. The "a project rule may not loosen an org rule" gate only fires
     * when the **outcome actually gets looser**; here the outcome is unchanged, so the rule
     * saves fine — it simply never matches a single scenario.
     * 开关想放开生产部署 —— 组织规则排在前面（10 < 100），拦得住。
     * 「项目规则不能放宽组织规则」那道闸只在**结果变松**时才拦，
     * 这里结果没变，所以规则存得下来，但它一条场景都命不中。
     */
    const result = await setOperationSwitch(
      db,
      fx.projectId,
      { operationType: 'deploy', verdict: 'auto' },
      fx.userId,
    );

    expect(result.applied).toBe(false);
    expect(result.blockedBy).toBe('other_rules');
    expect(result.shadowedBy.map((p) => p.name)).toContain('组织规则：部署一律要人');
  });

  it('关掉开关就把那条规则删掉，这一行回到其余规则说了算', async () => {
    const { policy } = await setOperationSwitch(
      db,
      fx.projectId,
      { operationType: 'code_change', verdict: 'human' },
      fx.userId,
    );
    expect(await projectRules()).toHaveLength(1);

    await clearOperationSwitch(db, fx.projectId, 'code_change', fx.userId);
    expect(await projectRules()).toHaveLength(0);

    /**
     * ★★ The deletion itself stays in the change history.
     *   Delete without recording it and, when someone later asks "was there once a rule
     *   blocking this?", a deletion looks exactly like nothing ever having happened.
     *   删除本身留在变更历史里。
     *   只删不记的话，事后查「这里以前是不是有条规则拦着」时，
     *   一次删除在历史上长得和「什么都没发生」一样。
     */
    const { policyVersions } = await import('@apos/db');
    const versions = await db
      .select()
      .from(policyVersions)
      .where(eq(policyVersions.policyId, policy.id));
    expect(versions).toHaveLength(2);
    expect(versions.at(-1)!.snapshot).toMatchObject({ after: null });
  });

  it('这一行没有开关规则时，关掉它是 404 而不是静默成功', async () => {
    await expect(clearOperationSwitch(db, fx.projectId, 'code_change')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  /**
   * ★★ The switch takes exactly the same save path as a hand-written rule — permission check
   *   included. Giving it a looser path would route around the asymmetric design of §2.3
   *   through the back door.
   *   开关走的是和手写规则完全一样的保存路径 —— 权限判定一起。
   *   给它一条更松的路径，等于把 §2.3 的不对称设计从后门绕过去。
   */
  it('★ 放开一类操作要 policy.loosen，不是 policy.tighten', async () => {
    const asked: string[] = [];

    await setOperationSwitch(
      db,
      fx.projectId,
      { operationType: 'code_change', verdict: 'auto' },
      fx.userId,
      { assertCan: (p) => void asked.push(p) },
    );
    expect(asked).toEqual(['policy.loosen']);

    asked.length = 0;
    await setOperationSwitch(
      db,
      fx.projectId,
      { operationType: 'db_ddl', verdict: 'human' },
      fx.userId,
      { assertCan: (p) => void asked.push(p) },
    );
    expect(asked).toEqual(['policy.tighten']);
  });

  it('切换写进变更历史 —— Policy 变更是高敏感操作，一键的也不例外', async () => {
    const { policy } = await setOperationSwitch(
      db,
      fx.projectId,
      { operationType: 'code_change', verdict: 'human' },
      fx.userId,
    );

    const { policyVersions } = await import('@apos/db');
    const versions = await db
      .select()
      .from(policyVersions)
      .where(eq(policyVersions.policyId, policy.id));
    expect(versions).toHaveLength(1);
    expect(versions[0]!.changedBy).toBe(fx.userId);
  });
});

/**
 * Automatic priority assignment (P3) / 优先级自动分配（P3）。
 *
 * ★★ Priority disappeared from the editing UI; the server now appends. Two things are pinned
 *   here: a new rule lands **behind** the existing ones (it never quietly cuts the line), and
 *   slot 100 stays reserved for the switch matrix — a switch is a stance the user took moments
 *   ago, and having it silently overridden by a rule written six months back is the hardest
 *   kind of problem to track down.
 *   优先级从编辑界面消失了，由服务端往后追加。这里钉住两件事：
 *   新规则排在已有规则**后面**（不会悄悄插队），
 *   以及 100 那一格始终留给开关矩阵 —— 开关是用户刚刚做出的表态，
 *   被一条半年前写的规则默默盖掉是最难查的一类问题。
 */
describe('优先级自动分配', () => {
  const authored = async () => nextAuthoredPriority(await loadProjectPolicies(db, fx.orgId, fx.projectId));

  it('一条规则都没有时从 AUTHORED_PRIORITY_MIN 起', async () => {
    expect(await authored()).toBe(AUTHORED_PRIORITY_MIN);
  });

  it('★ 往后追加，不插队', async () => {
    await savePolicy(
      db,
      fx.projectId,
      {
        name: '第一条',
        priority: await authored(),
        condition: { fact: 'riskLevel', op: 'eq', value: 'high' },
        action: { type: 'ask', assignee: { kind: 'project_role', role: 'pm' } },
      },
      fx.userId,
    );
    const second = await authored();
    expect(second).toBe(AUTHORED_PRIORITY_MIN + 1);
  });

  /**
   * ★★ The switch's slot takes no part in the append.
   *   Count it in and the next hand-written rule lands **behind** the switch while looking, by
   *   number, as if it sits right next to it — and which of the two comes first is the whole
   *   of the verdict.
   *   开关那一格不参与追加。
   *   把它算进去的话，下一条手写规则会排到开关**后面**、
   *   却在编号上看起来紧挨着它 —— 而两者的先后正是判定结果的全部。
   */
  it('★ 开关矩阵占的那一格不参与追加', async () => {
    await setOperationSwitch(db, fx.projectId, { operationType: 'deploy', verdict: 'human' }, fx.userId);
    const rows = await projectRules();
    expect(rows[0]!.priority).toBe(OPERATION_SWITCH_PRIORITY);
    expect(await authored()).toBe(AUTHORED_PRIORITY_MIN);
  });

  /** Org rules take no part — they occupy 1-99, a band no project can touch */
  it('组织规则不参与追加', async () => {
    await db.insert(policies).values({
      orgId: fx.orgId,
      projectId: null,
      name: '组织规则',
      description: '',
      priority: 10,
      enabled: true,
      createdBy: fx.userId,
      condition: { fact: 'operationType', op: 'eq', value: 'payment' },
      action: { type: 'pause', resumeCondition: 'human_decision' },
    });
    expect(await authored()).toBe(AUTHORED_PRIORITY_MIN);
  });
});
