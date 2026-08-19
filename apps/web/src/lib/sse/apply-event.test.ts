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

  /**
   * ★★ 断言的是**结构化 detail**，不是那句兜底中文。
   *
   *   这条用例原本只断言 `blockedReason === '等待 DBA 审批'` —— 而那正是
   *   兜底路径。补丁不写 `blockedDetail` 时它照样绿，于是「实时推来的卡片
   *   在英文界面上显示中文」这个缺口有测试覆盖却没被发现。
   *   界面读码，所以测试也读码。
   */
  it('阻塞事件把结构化原因写进卡片（界面据此读码，不走兜底句）', () => {
    const qc = setup();
    const detail = {
      at: '2026-08-18T14:07:54.309Z',
      kind: 'no_matching_agent' as const,
      detail: null,
      candidates: [
        {
          agentId: 'a-1',
          agentName: 'code-agent',
          code: 'type_not_applicable' as const,
          scope: 'org' as const,
          params: { type: 'research' },
          reason: '不适用于 research 类型任务',
        },
      ],
    };
    applyEventToCache(
      qc,
      event({ type: 'work_item.blocked', payload: { reason: '无匹配 Agent', detail } }),
    );

    const c = read(qc).columns.flatMap((col) => col.items)[0]!;
    expect(c.blockedDetail?.candidates?.[0]?.code).toBe('type_not_applicable');
    expect(c.blockedReason).toBe('无匹配 Agent');
    expect(c.blockedSince).not.toBeNull();
  });

  /**
   * ★ 反复判定同一个阻塞不能把「已阻塞多久」推回 0。
   *   服务端在原因没变时刻意不动 blocked_since，补丁必须跟上同一口径 ——
   *   否则界面上的时长每轮调度归零，而那正是 CLAUDE.md 点名的症状。
   */
  it('再次推同一个阻塞时不重置起点', () => {
    const qc = setup();
    const first = event({ type: 'work_item.blocked', payload: { reason: '无匹配 Agent' } });
    applyEventToCache(qc, first);
    const started = read(qc).columns.flatMap((col) => col.items)[0]!.blockedSince;

    applyEventToCache(
      qc,
      { ...first, occurredAt: new Date(Date.parse(first.occurredAt) + 600_000).toISOString() },
    );

    expect(read(qc).columns.flatMap((col) => col.items)[0]!.blockedSince).toBe(started);
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
