import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { decisions, events, workItems } from '@apos/db';
import { createWorkItem, resetDb, seedFixture, testDb, type Fixture } from '../../test/db';
import { reviewRound } from './review';

const db = testDb();
let fx: Fixture;

afterAll(async () => {
  await resetDb(db);
});

function corr() {
  return randomUUID();
}

async function qualityCheckedFor(itemId: string) {
  const rows = await db.select().from(events).where(eq(events.subjectId, itemId));
  return rows.filter((r) => r.type === 'work_item.quality_checked');
}

async function pendingDecisionsFor(itemId: string) {
  return db
    .select()
    .from(decisions)
    .where(eq(decisions.workItemId, itemId));
}

/**
 * ★★ 「可以自动放行」与「放得过去」是两道各自独立的判断，而它们会在
 *   同一个任务上同时给出相反的答案。
 *
 *   agent_autonomous 这一档的 canAutoPass 不看 unclear（有意为之，见
 *   review.ts 顶部那张表），但 review_passed 上的 acceptanceCriteriaMet
 *   门禁看 —— Agent 没留自评报告时，验收标准全是 pending，于是
 *   「放行」判过、推进被拦。
 *
 *   以前这一支只回一个 action: 'awaiting_human' 的报告就结束了，而那是句
 *   空话：没有决策产生，任务原地不动，20 秒后整套重来一遍。唯一的痕迹是
 *   events 表里每 20 秒多一条 quality_checked，把真正的状态变更淹掉 ——
 *   而这张表同时是审计、Analytics 和通知的数据源。
 *
 * "Can auto-pass" and "actually passes" are separate judgements that can
 * disagree on the same task. This used to leave it circling in `reviewing`
 * forever with no human todo and a duplicate event every round.
 */
describe('★ 评审循环：被门禁拦下的任务必须落到人手上，而不是空转', () => {
  beforeEach(async () => {
    await resetDb(db);
    fx = await seedFixture(db, { autonomyLevel: 'agent_autonomous' });
  });

  /** Agent 跑完但没留自评报告 —— 验收标准无从确认，这是最常见的形态 */
  async function itemWithUnconfirmedCriteria() {
    return createWorkItem(db, fx, {
      status: 'reviewing',
      acceptanceCriteria: [
        { id: 'AC1', text: '查询接口支持按状态过滤', status: 'pending', verification: 'agent', evidenceRef: null, verifiedAt: null },
      ],
    });
  }

  it('★★ 第一步就被拦下时建出决策，任务不再无人认领', async () => {
    const item = await itemWithUnconfirmedCriteria();

    const [outcome] = await reviewRound(db, { correlationId: corr() });

    expect(outcome!.action).toBe('awaiting_human');
    // ★ 关键：'awaiting_human' 必须真的有人被叫到，而不只是报告里的一个词
    const pending = await pendingDecisionsFor(item.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe('pending');
    expect(pending[0]!.type).toBe('review_approval');
    // 拦下它的那道门禁要说得出名字，否则人不知道该确认什么
    expect(pending[0]!.background).toContain('验收标准');
  });

  it('★★ 下一轮不再重复处理 —— 决策在，就轮不到自动判定了', async () => {
    const item = await itemWithUnconfirmedCriteria();

    await reviewRound(db, { correlationId: corr() });
    const [second] = await reviewRound(db, { correlationId: corr() });

    expect(second!.action).toBe('skipped');
    // 决策只有一条，不是每轮堆一条
    expect(await pendingDecisionsFor(item.id)).toHaveLength(1);
  });

  /**
   * ★ CLAUDE.md：定时循环写库前先问一句「变了吗」。
   *   两个方向都要断言 —— 只测「没变不写」的话，一个永远返回 true 的
   *   比较函数照样能通过，而它的表现是「结论变了但界面不动」。
   */
  it('判据没变时不重复写 quality_checked', async () => {
    const item = await createWorkItem(db, fx, { status: 'reviewing' });

    await reviewRound(db, { correlationId: corr() });
    const afterFirst = await qualityCheckedFor(item.id);
    expect(afterFirst).toHaveLength(1);

    // 任务此刻已离开 reviewing，把它放回去再扫一轮：判据一个字没变
    await db.update(workItems).set({ status: 'reviewing' }).where(eq(workItems.id, item.id));
    await reviewRound(db, { correlationId: corr() });

    expect(await qualityCheckedFor(item.id)).toHaveLength(1);
  });

  it('判据变了时记一条新的', async () => {
    const item = await createWorkItem(db, fx, { status: 'reviewing' });

    await reviewRound(db, { correlationId: corr() });
    expect(await qualityCheckedFor(item.id)).toHaveLength(1);

    // 核验结果回灌进来了 —— 这是真的变化，必须留下痕迹
    await db
      .update(workItems)
      .set({
        status: 'reviewing',
        typeData: { qualityGate: { testsPassed: true, testCommand: 'pnpm test', testSource: 'workspace_check' } },
      })
      .where(eq(workItems.id, item.id));
    await reviewRound(db, { correlationId: corr() });

    expect(await qualityCheckedFor(item.id)).toHaveLength(2);
  });
});
