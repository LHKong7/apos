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

    /**
     * ★★ 结构化的 `detail` 必须跟着补进来，`reason` 只是兜底句。
     *
     *   卡片上的说明由 `useBlockedSummary()` 渲染，它是 detail 优先、
     *   fallback 兜底。补丁不写 detail 的话，实时推来的那张卡片永远走兜底 ——
     *   而兜底按设计就是**存量中文句子**。症状是：调度器一判定阻塞，
     *   英文界面上就冒出一句中文，刷新之后又变回英文。
     *   原因码这套设计在实时路径上等于没有生效（「界面读码，日志读句子」）。
     *
     * ★ `blockedSince` 只在**第一次**被阻塞时写。
     *
     *   服务端在原因没变时刻意不动这个字段（sameBlockedDetail），为的是
     *   让界面上的「已阻塞 N 分钟」从真正的起点开始算。补丁无条件写成
     *   事件时间的话，每轮调度都把它推回现在 —— 时长恒等于 0，
     *   而这正是 CLAUDE.md 点名要防的那个症状。
     *
     * Patch the structured detail too, and never reset the start time: the
     * server deliberately preserves `blockedSince` across re-evaluations so the
     * UI can show how long this has really been stuck.
     */
    case 'work_item.blocked':
    case 'work_item.unblocked':
      return patchBoardCard(qc, event.projectId, event.subjectId, (card) => {
        if (event.type === 'work_item.unblocked') {
          return { ...card, blockedSince: null, blockedReason: null, blockedDetail: null, blockedMinutes: null };
        }
        const detail = (event.payload['detail'] ?? null) as BoardCard['blockedDetail'];
        return {
          ...card,
          blockedSince: card.blockedSince ?? event.occurredAt,
          blockedReason: String(event.payload['reason'] ?? ''),
          blockedDetail: detail,
          blockedMinutes: card.blockedSince ? card.blockedMinutes : 0,
        };
      });

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

    /**
     * 结构性变化：补丁拼不出新卡片，直接重拉。
     *
     * ★ plan.* 这四条都要在这里，因为看板的 Planning 列现在会渲染
     *   「待批准的计划」。
     *
     *   在此之前只认 plan.approved —— 于是计划刚生成时那张卡不会出现，
     *   要等用户手动刷新；而「要求修改」之后旧计划变 superseded、
     *   新计划生成，列里会留着一张**已经不存在**的卡，点进去 404。
     */
    case 'work_item.created':
    case 'work_item.split':
    case 'work_item.merged':
    case 'plan.generated':
    case 'plan.approved':
    case 'plan.revision_requested':
    case 'plan.superseded':
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
