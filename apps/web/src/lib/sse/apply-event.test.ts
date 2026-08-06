import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { applyEventToCache } from './apply-event';
import { qk } from '../query/keys';
import { useBoardStore } from '../../stores/board';
import { board, card, event } from '../../test/fixtures';
import type { BoardResponse } from '../api/types';

const PROJECT = 'p-1';
const FILTERS = {};

function setup(cards = [card()]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(qk.board(PROJECT, FILTERS), board(cards));
  return qc;
}

function read(qc: QueryClient): BoardResponse {
  return qc.getQueryData(qk.board(PROJECT, FILTERS))!;
}

function stageOf(b: BoardResponse, id: string): string | null {
  for (const col of b.columns) if (col.items.some((c) => c.id === id)) return col.key;
  return null;
}

beforeEach(() => {
  useBoardStore.setState({ moves: new Map(), unseenMoves: [] });
});

describe('状态流转 → 卡片跨列移动', () => {
  it('把卡片从原列移到新列，并同步 count', () => {
    const qc = setup();
    applyEventToCache(
      qc,
      event({ payload: { from: 'ready', to: 'reviewing', trigger: 'agent_run_completed' } }),
    );

    const b = read(qc);
    expect(stageOf(b, 'wi-1')).toBe('review');
    expect(b.columns.find((c) => c.key === 'execution')!.count).toBe(0);
    expect(b.columns.find((c) => c.key === 'review')!.count).toBe(1);
  });

  it('记录移动供动画与来源角标使用', () => {
    const qc = setup();
    applyEventToCache(qc, event({ payload: { from: 'ready', to: 'reviewing' } }));

    const move = useBoardStore.getState().moves.get('wi-1');
    expect(move).toMatchObject({ from: 'execution', to: 'review', source: 'agent' });
    expect(useBoardStore.getState().unseenMoves).toHaveLength(1);
  });

  it('列内流转不算「移动」，不触发落位动画', () => {
    const qc = setup();
    applyEventToCache(qc, event({ payload: { from: 'ready', to: 'executing' } }));

    expect(stageOf(read(qc), 'wi-1')).toBe('execution');
    expect(useBoardStore.getState().moves.size).toBe(0);
  });

  /**
   * awaiting_decision 的 stage 由 previousStatus 决定 —— 执行前等审批的卡片
   * 必须留在 Execution，跳到 Review 会让人以为「已经做完了在审核」。
   */
  it('★ 等待决策的卡片留在原阶段，不跳到 Review', () => {
    const qc = setup();
    applyEventToCache(
      qc,
      event({ payload: { from: 'ready', to: 'awaiting_decision' } }),
    );

    expect(stageOf(read(qc), 'wi-1')).toBe('execution');
  });

  it('多份筛选缓存都会被打补丁', () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.board(PROJECT, {}), board([card()]));
    qc.setQueryData(qk.board(PROJECT, { blocked: true }), board([card()]));

    applyEventToCache(qc, event({ payload: { from: 'ready', to: 'reviewing' } }));

    expect(stageOf(qc.getQueryData(qk.board(PROJECT, {}))!, 'wi-1')).toBe('review');
    expect(stageOf(qc.getQueryData(qk.board(PROJECT, { blocked: true }))!, 'wi-1')).toBe('review');
  });
});

describe('高频事件只打补丁，不发请求', () => {
  it('★ agent_run.started 不触发 invalidate', () => {
    const qc = setup();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    applyEventToCache(
      qc,
      event({
        type: 'agent_run.started',
        subjectType: 'agent_run',
        subjectId: 'run-1',
        payload: { workItemId: 'wi-1' },
      }),
    );

    expect(spy).not.toHaveBeenCalled();
    expect(read(qc).columns.flatMap((c) => c.items)[0]!.runStatus).toBe('running');
  });

  it('阻塞事件把原因与时长写进卡片', () => {
    const qc = setup();
    applyEventToCache(
      qc,
      event({ type: 'work_item.blocked', payload: { reason: '等待 DBA 审批' } }),
    );

    const c = read(qc).columns.flatMap((col) => col.items)[0]!;
    expect(c.blockedReason).toBe('等待 DBA 审批');
    expect(c.blockedSince).not.toBeNull();
  });

  it('产物事件累加计数', () => {
    const qc = setup();
    applyEventToCache(
      qc,
      event({
        type: 'artifact.produced',
        subjectType: 'artifact',
        subjectId: 'a-1',
        payload: { workItemId: 'wi-1' },
      }),
    );

    expect(read(qc).columns.flatMap((c) => c.items)[0]!.artifactCount).toBe(1);
  });
});

describe('结构性变化直接重拉', () => {
  it('决策事件让看板与决策列表失效', () => {
    const qc = setup();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    applyEventToCache(
      qc,
      event({ type: 'decision.created', subjectType: 'decision', subjectId: 'd-1' }),
    );

    const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys.some((k) => k?.includes('decisions'))).toBe(true);
    expect(keys.some((k) => k?.includes('board'))).toBe(true);
  });

  it('未知事件类型被安全忽略', () => {
    const qc = setup();
    expect(() => applyEventToCache(qc, event({ type: 'some.future.event' }))).not.toThrow();
    expect(stageOf(read(qc), 'wi-1')).toBe('execution');
  });

  it('缓存里没有这张卡时不会凭空造出一张', () => {
    const qc = setup([card({ id: 'other' })]);
    applyEventToCache(qc, event({ payload: { from: 'ready', to: 'reviewing' } }));

    expect(read(qc).columns.flatMap((c) => c.items).map((c) => c.id)).toEqual(['other']);
  });
});
