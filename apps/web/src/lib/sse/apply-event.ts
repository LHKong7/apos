import type { QueryClient } from '@tanstack/react-query';
import { stageFor, type Stage, type WorkItemStatus } from '@apos/contracts';
import { qk } from '../query/keys';
import { useBoardStore } from '../../stores/board';
import type { BoardCard, BoardResponse, StreamEvent, WorkItemDetail } from '../api/types';

/**
 * 事件 → 缓存补丁（docs/tech/08-frontend-architecture.md §4.2）。
 *
 * 分频处理是核心：
 * - 高频事件（进度、成本）只打补丁，绝不 invalidate —— 一次 invalidate
 *   就是一轮网络请求，Agent 每秒几条进度会把接口打爆
 * - 低频但影响面大的（状态流转）打补丁 + 让派生缓存失效
 * - 结构性变化（新建/删除）直接 invalidate，补丁拼不出来
 */
export function applyEventToCache(qc: QueryClient, event: StreamEvent) {
  switch (event.type) {
    case 'work_item.status_changed':
      return onStatusChanged(qc, event);

    case 'work_item.blocked':
    case 'work_item.unblocked':
      return patchBoardCard(qc, event.projectId, event.subjectId, (card) => ({
        ...card,
        blockedSince: event.type === 'work_item.blocked' ? event.occurredAt : null,
        blockedReason:
          event.type === 'work_item.blocked' ? String(event.payload['reason'] ?? '') : null,
        blockedMinutes: event.type === 'work_item.blocked' ? 0 : null,
      }));

    case 'agent_run.dispatched':
      return patchBoardCard(qc, event.projectId, asString(event.payload['workItemId']), (card) => ({
        ...card,
        runId: event.subjectId,
        runStatus: 'dispatching',
      }));

    case 'agent_run.started':
      return patchBoardCard(qc, event.projectId, cardIdOf(event), (card) => ({
        ...card,
        runId: event.subjectId,
        runStatus: 'running',
      }));

    case 'agent_run.completed':
    case 'agent_run.failed':
    case 'agent_run.terminated': {
      const id = cardIdOf(event);
      patchBoardCard(qc, event.projectId, id, (card) => ({
        ...card,
        runStatus: event.type.split('.')[1] ?? card.runStatus,
        consecutiveFailures:
          event.type === 'agent_run.failed'
            ? Number(event.payload['consecutiveFailures'] ?? card.consecutiveFailures)
            : card.consecutiveFailures,
      }));
      if (id) qc.invalidateQueries({ queryKey: qk.workItem(id) });
      return;
    }

    case 'artifact.produced': {
      const id = asString(event.payload['workItemId']);
      patchBoardCard(qc, event.projectId, id, (card) => ({
        ...card,
        artifactCount: card.artifactCount + 1,
      }));
      if (id) qc.invalidateQueries({ queryKey: qk.workItem(id) });
      return;
    }

    case 'decision.created':
    case 'decision.approved':
    case 'decision.rejected':
    case 'decision.escalated':
    case 'decision.expired':
      qc.invalidateQueries({ queryKey: qk.decisionsAll() });
      qc.invalidateQueries({ queryKey: qk.decision(event.subjectId) });
      /**
       * 决策中心的队列（含顶栏那个待办数）必须跟着动。
       * 「需要你的时候我会来找你」这句承诺，实现上就是这一行 ——
       * 少了它，新决策要等用户手动刷新才看得见。
       */
      qc.invalidateQueries({ queryKey: qk.decisionInboxAll() });
      // 决策会改变卡片上的 Human Gate，看板必须重新拉
      if (event.projectId) qc.invalidateQueries({ queryKey: qk.boardAll(event.projectId) });
      if (event.projectId) qc.invalidateQueries({ queryKey: qk.overview(event.projectId) });
      return;

    case 'project.budget_threshold_reached':
      if (event.projectId) qc.invalidateQueries({ queryKey: qk.project(event.projectId) });
      return;

    case 'work_item.created':
    case 'work_item.split':
    case 'work_item.merged':
    case 'plan.approved':
      // 结构性变化：补丁拼不出新卡片，直接重拉
      if (event.projectId) qc.invalidateQueries({ queryKey: qk.boardAll(event.projectId) });
      return;

    default:
      return;
  }
}

function onStatusChanged(qc: QueryClient, event: StreamEvent) {
  const workItemId = event.subjectId;
  const to = event.payload['to'] as WorkItemStatus | undefined;
  const from = event.payload['from'] as WorkItemStatus | undefined;
  if (!to) return;

  const targetStage = stageFor(to, from ?? null);

  qc.setQueryData<WorkItemDetail>(qk.workItem(workItemId), (old) =>
    old ? { ...old, item: { ...old.item, status: to, stage: targetStage } } : old,
  );

  let movedFrom: Stage | null = null;

  forEachBoard(qc, event.projectId, (board) => {
    const found = findCard(board, workItemId);
    if (!found) return board;
    movedFrom = found.stage;

    const updated: BoardCard = { ...found.card, status: to, stage: targetStage };
    return moveCard(board, workItemId, targetStage, updated);
  });

  // 记录移动供动画与来源角标使用；跨列才算「移动」
  if (movedFrom !== null && movedFrom !== targetStage) {
    useBoardStore.getState().recordMove({
      workItemId,
      from: movedFrom,
      to: targetStage,
      source: event.actorType,
      at: Date.now(),
    });
  }

  // 摘要（待决策数、阻塞数…）是派生值，补丁算不准，交给重拉
  if (event.projectId) {
    qc.invalidateQueries({ queryKey: qk.boardAll(event.projectId), refetchType: 'active' });
    qc.invalidateQueries({ queryKey: qk.project(event.projectId) });
  }
}

// ── 缓存操作 ─────────────────────────────────────────────────────────

/**
 * 同一个项目可能有多份看板缓存（不同筛选组合各一份）。
 * 逐份打补丁，否则切换筛选后会看到旧状态。
 */
function forEachBoard(
  qc: QueryClient,
  projectId: string | null,
  update: (board: BoardResponse) => BoardResponse,
) {
  if (!projectId) return;
  qc.setQueriesData<BoardResponse>({ queryKey: qk.boardAll(projectId) }, (old) =>
    old ? update(old) : old,
  );
}

function patchBoardCard(
  qc: QueryClient,
  projectId: string | null,
  workItemId: string | null,
  patch: (card: BoardCard) => BoardCard,
) {
  if (!workItemId) return;
  forEachBoard(qc, projectId, (board) => ({
    ...board,
    columns: board.columns.map((col) => ({
      ...col,
      items: col.items.map((c) => (c.id === workItemId ? patch(c) : c)),
    })),
  }));
}

function findCard(
  board: BoardResponse,
  workItemId: string,
): { card: BoardCard; stage: Stage } | null {
  for (const col of board.columns) {
    const card = col.items.find((c) => c.id === workItemId);
    if (card) return { card, stage: col.key };
  }
  return null;
}

function moveCard(
  board: BoardResponse,
  workItemId: string,
  toStage: Stage,
  updated: BoardCard,
): BoardResponse {
  return {
    ...board,
    columns: board.columns.map((col) => {
      const without = col.items.filter((c) => c.id !== workItemId);
      const had = without.length !== col.items.length;

      if (col.key === toStage) {
        return { ...col, items: [updated, ...without], count: col.count + (had ? 0 : 1) };
      }
      return { ...col, items: without, count: col.count - (had ? 1 : 0) };
    }),
  };
}

function cardIdOf(event: StreamEvent): string | null {
  return asString(event.payload['workItemId']);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
