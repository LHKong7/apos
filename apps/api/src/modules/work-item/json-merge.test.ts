import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { workItems } from '@apos/db';
import { createWorkItem, resetDb, seedFixture, testDb, type Fixture } from '../../test/db';
import { appendConstraints, mergeTypeData, mergeTypeDataNested } from './json-merge';

/**
 * ★★ 丢更新。
 *
 *   这几列此前都是「SELECT 出来 → 在 JS 里展开 → 整列写回」，三步之间
 *   没有锁。两个写入者并发时，后写的那个带着**它读到的旧值**覆盖全列，
 *   先写的那次就没了。`typeData.qualityGate` 上这件事是真会发生的：
 *   Agent 收尾的工作区核验与 CI 结果回灌各写其中几个字段。
 *
 *   下面每条用例都**同时**发两个写入 —— 串行跑的话它们全都会通过，
 *   问题只在并发下才出现，所以必须 Promise.all。
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

const read = async (id: string) => {
  const [row] = await db.select().from(workItems).where(eq(workItems.id, id));
  return row!;
};

describe('work_items 上的 jsonb 原子合并', () => {
  it('★ 并发写 qualityGate 的不同字段，两边都留下来', async () => {
    const item = await createWorkItem(db, fx);

    await Promise.all([
      db
        .update(workItems)
        .set({
          typeData: mergeTypeDataNested('qualityGate', {
            testsPassed: true,
            testSource: 'workspace_check',
          }),
        })
        .where(eq(workItems.id, item.id)),
      db
        .update(workItems)
        .set({
          typeData: mergeTypeDataNested('qualityGate', { ciSha: 'abc123', coverage: 0.81 }),
        })
        .where(eq(workItems.id, item.id)),
    ]);

    const gate = (await read(item.id)).typeData['qualityGate'] as Record<string, unknown>;
    // 两个写入者各自的字段都在 —— 谁都没被对方整列覆盖掉
    expect(gate['testSource']).toBe('workspace_check');
    expect(gate['ciSha']).toBe('abc123');
    expect(gate['coverage']).toBe(0.81);
  });

  it('合并只动指定的键，typeData 里其余内容原样保留', async () => {
    const item = await createWorkItem(db, fx, {
      typeData: { requiredTools: ['create_pr'], executionMode: 'auto' },
    });

    await db
      .update(workItems)
      .set({ typeData: mergeTypeDataNested('qualityGate', { testsPassed: false }) })
      .where(eq(workItems.id, item.id));

    const data = (await read(item.id)).typeData;
    expect(data['requiredTools']).toEqual(['create_pr']);
    expect(data['executionMode']).toBe('auto');
    expect((data['qualityGate'] as Record<string, unknown>)['testsPassed']).toBe(false);
  });

  it('★ 改执行方式不会顺手抹掉同时写入的质量门禁证据', async () => {
    const item = await createWorkItem(db, fx);

    await Promise.all([
      db
        .update(workItems)
        .set({ typeData: mergeTypeData({ executionMode: 'human' }) })
        .where(eq(workItems.id, item.id)),
      db
        .update(workItems)
        .set({ typeData: mergeTypeDataNested('qualityGate', { testsPassed: true }) })
        .where(eq(workItems.id, item.id)),
    ]);

    const data = (await read(item.id)).typeData;
    expect(data['executionMode']).toBe('human');
    expect((data['qualityGate'] as Record<string, unknown>)['testsPassed']).toBe(true);
  });

  it('★ 并发追加约束，一条都不丢', async () => {
    const item = await createWorkItem(db, fx);
    const constraint = (description: string) => ({
      type: 'scope_limit' as const,
      description,
      enforcement: 'agent' as const,
      decisionId: null,
    });

    await Promise.all([
      db
        .update(workItems)
        .set({ constraints: appendConstraints([constraint('不要动生产库')]) as never })
        .where(eq(workItems.id, item.id)),
      db
        .update(workItems)
        .set({ constraints: appendConstraints([constraint('先跑一遍测试')]) as never })
        .where(eq(workItems.id, item.id)),
    ]);

    const descriptions = (await read(item.id)).constraints.map((c) => c.description);
    expect(descriptions).toHaveLength(2);
    expect(descriptions).toContain('不要动生产库');
    expect(descriptions).toContain('先跑一遍测试');
  });
});
