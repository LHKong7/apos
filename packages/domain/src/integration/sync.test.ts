import { describe, expect, it } from 'vitest';
import type { SideSnapshot, SyncMapping } from '@apos/contracts';
import {
  applyPreset,
  conflictHotspots,
  defaultMappings,
  matchPreset,
  resolveSync,
  similarityKey,
  type SyncInput,
} from './sync';

const TAG = 'apos:proj-1';

function side(value: unknown, at: string, by = '李娜', actorType = 'human'): SideSnapshot {
  return { value, changedAt: at, changedBy: by, actorType };
}

function input(over: Partial<SyncInput> = {}): SyncInput {
  return {
    field: 'status',
    mapping: { field: 'status', sourceOfTruth: 'apos', strategy: 'writeback' },
    apos: side('reviewing', '2026-08-05T14:32:00Z', '系统', 'system'),
    external: side('done', '2026-08-05T14:45:00Z'),
    lastSynced: { value: 'executing', at: Date.parse('2026-08-05T10:00:00Z') },
    externalOriginTag: null,
    ownOriginTag: TAG,
    ...over,
  };
}

/**
 * Source of Truth 求解（产品文档 9.1）。
 *
 * 两个系统都能改同一个字段，就必然有一方的修改会被丢掉。
 * 这组测试锁的就是「谁被丢掉、丢掉之后怎么留痕」。
 */
describe('回声抑制', () => {
  /**
   * ★ 漏判回声的后果不是多一次无用写入，是循环：
   *   我们写过去 → 外部推回来 → 我们当成外部修改再处理一次 → 可能再写过去。
   *   所以它排在所有判断的最前面。
   */
  it('★ 外部推回来的是我们刚写过去的值，直接丢弃', () => {
    const r = resolveSync(input({ externalOriginTag: TAG }));
    expect(r.kind).toBe('echo');
  });

  it('别人写的同一个字段不算回声', () => {
    const r = resolveSync(input({ externalOriginTag: 'jira:user:李娜' }));
    expect(r.kind).not.toBe('echo');
  });

  it('没有来源标记时按正常变更处理', () => {
    const r = resolveSync(input({ externalOriginTag: null }));
    expect(r.kind).not.toBe('echo');
  });
});

describe('无争议的单边变更', () => {
  it('两侧一致时什么都不做', () => {
    const r = resolveSync(
      input({ apos: side('done', 'a'), external: side('done', 'b') }),
    );
    expect(r.kind).toBe('noop');
  });

  it('SoT 在外部且 APOS 没动过 —— 直接接受', () => {
    const r = resolveSync(
      input({
        mapping: { field: 'assignee', sourceOfTruth: 'external', strategy: 'writeback' },
        apos: side('张伟', 'a'),
        external: side('王强', 'b'),
        lastSynced: { value: '张伟', at: 0 },
      }),
    );
    expect(r).toEqual({ kind: 'accept', value: '王强' });
  });

  it('SoT 在 APOS 且外部没动过 —— 回写', () => {
    const r = resolveSync(
      input({
        apos: side('reviewing', 'a'),
        external: side('executing', 'b'),
        lastSynced: { value: 'executing', at: 0 },
      }),
    );
    expect(r).toEqual({ kind: 'writeback', value: 'reviewing' });
  });

  /**
   * ★ 没有同步基准时只能当作两侧都改过。
   *   猜「大概只有一边动了」会在首次同步时静默覆盖掉真实修改，
   *   而首次同步恰恰是最可能两边都有存量数据的时候。
   */
  it('没有 lastSynced 基准时按「两侧都改过」处理', () => {
    const r = resolveSync(
      input({
        mapping: { field: 'status', sourceOfTruth: 'apos', strategy: 'record_conflict' },
        lastSynced: null,
      }),
    );
    expect(r.kind).toBe('conflict');
  });
});

describe('非 SoT 端被改动时的三种策略', () => {
  const both = {
    apos: side('reviewing', '2026-08-05T14:32:00Z', '系统', 'system'),
    external: side('done', '2026-08-05T14:45:00Z', '李娜'),
    lastSynced: { value: 'executing', at: 0 },
  };

  it('忽略并回写：SoT 赢，另一端被覆盖', () => {
    const r = resolveSync(
      input({ ...both, mapping: { field: 'status', sourceOfTruth: 'apos', strategy: 'writeback' } }),
    );
    expect(r).toEqual({ kind: 'writeback', value: 'reviewing' });
  });

  it('记录冲突：两侧的值、时间、修改人都带出来', () => {
    const r = resolveSync(
      input({
        ...both,
        mapping: { field: 'status', sourceOfTruth: 'apos', strategy: 'record_conflict' },
      }),
    );
    expect(r.kind).toBe('conflict');
    if (r.kind !== 'conflict') return;
    expect(r.apos.value).toBe('reviewing');
    expect(r.apos.changedBy).toBe('系统');
    expect(r.external.value).toBe('done');
    expect(r.external.changedBy).toBe('李娜');
    // 界面上要写「状态字段的 Source of Truth 是 APOS」
    expect(r.sourceOfTruth).toBe('apos');
  });

  it('接受并告警：采纳非 SoT 端的值，但要通知', () => {
    const r = resolveSync(
      input({
        ...both,
        mapping: { field: 'status', sourceOfTruth: 'apos', strategy: 'accept_and_warn' },
      }),
    );
    expect(r.kind).toBe('accept_and_warn');
    if (r.kind !== 'accept_and_warn') return;
    expect(r.value).toBe('done');
    expect(r.note).toContain('外部系统');
  });

  /** 只有一侧有值时谈不上冲突，退回单边变更 */
  it('外部侧没有值时不生成冲突条目', () => {
    const r = resolveSync(
      input({
        apos: side('reviewing', 'a'),
        external: null,
        lastSynced: null,
        mapping: { field: 'status', sourceOfTruth: 'apos', strategy: 'record_conflict' },
      }),
    );
    expect(r).toEqual({ kind: 'writeback', value: 'reviewing' });
  });
});

describe('评论合并', () => {
  it('两侧评论合并且按时间排序', () => {
    const r = resolveSync(
      input({
        field: 'comments',
        mapping: { field: 'comments', sourceOfTruth: 'merge', strategy: 'writeback' },
        apos: side([{ externalId: 'a', createdAt: '2026-08-05T10:00:00Z', body: 'APOS 这边' }], 'x'),
        external: side(
          [{ externalId: 'b', createdAt: '2026-08-05T09:00:00Z', body: 'Jira 那边' }],
          'y',
        ),
      }),
    );
    expect(r.kind).toBe('merge');
    if (r.kind !== 'merge') return;
    const rows = r.value as { body: string }[];
    expect(rows.map((x) => x.body)).toEqual(['Jira 那边', 'APOS 这边']);
  });

  /**
   * ★ 按外部 id 去重而不是按内容：
   *   两个人先后说了同一句「收到」是两条评论，
   *   同一条评论被两侧各拉了一次才是一条。
   */
  it('按外部 id 去重，内容相同的两条不会被合成一条', () => {
    const r = resolveSync(
      input({
        field: 'comments',
        mapping: { field: 'comments', sourceOfTruth: 'merge', strategy: 'writeback' },
        apos: side(
          [
            { externalId: 'a', createdAt: '1', body: '收到' },
            { externalId: 'b', createdAt: '2', body: '收到' },
          ],
          'x',
        ),
        external: side([{ externalId: 'a', createdAt: '1', body: '收到' }], 'y'),
      }),
    );
    if (r.kind !== 'merge') throw new Error('应为 merge');
    expect((r.value as unknown[]).length).toBe(2);
  });
});

describe('预设与默认值', () => {
  it('默认配置匹配「APOS 管执行，外部管计划」', () => {
    expect(matchPreset(defaultMappings())).toBe('split');
  });

  it('切换预设只改 SoT，保留已选的策略', () => {
    const current: SyncMapping[] = defaultMappings().map((m) =>
      m.field === 'assignee' ? { ...m, strategy: 'accept_and_warn' } : m,
    );

    const next = applyPreset('apos_led', current);

    expect(next.find((m) => m.field === 'assignee')?.sourceOfTruth).toBe('apos');
    expect(next.find((m) => m.field === 'assignee')?.strategy).toBe('accept_and_warn');
    expect(matchPreset(next)).toBe('apos_led');
  });

  it('自定义组合不匹配任何预设', () => {
    const custom = defaultMappings().map((m) =>
      m.field === 'artifact_links' ? { ...m, sourceOfTruth: 'external' as const } : m,
    );
    expect(matchPreset(custom)).toBeNull();
  });

  /**
   * ★ 状态默认「记录冲突」而不是默认「回写」。
   *   状态是唯一驱动流程往下走的字段：悄悄回写会让外部系统里那个人
   *   看到自己刚点的 Done 被弹回去，且没有任何解释。
   */
  it('★ 状态字段的默认策略是记录冲突，不是静默回写', () => {
    const status = defaultMappings().find((m) => m.field === 'status');
    expect(status?.strategy).toBe('record_conflict');
    const assignee = defaultMappings().find((m) => m.field === 'assignee');
    expect(assignee?.strategy).toBe('writeback');
  });
});

describe('同类冲突与热点', () => {
  it('同类的归类键只含集成与字段，不含具体对象', () => {
    expect(similarityKey('int-1', 'status')).toBe('int-1:status');
    expect(similarityKey('int-1', 'status')).toBe(similarityKey('int-1', 'status'));
    expect(similarityKey('int-1', 'status')).not.toBe(similarityKey('int-1', 'assignee'));
  });

  it('冲突集中的字段被指出来', () => {
    const hot = conflictHotspots([
      { field: 'status' },
      { field: 'status' },
      { field: 'status' },
      { field: 'assignee' },
    ]);
    expect(hot[0]).toMatchObject({ field: 'status', count: 3 });
    expect(hot[0]!.hint).toContain('配反');
  });
});
