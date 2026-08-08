import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Stage, WorkItemStatus } from '@apos/contracts';
import { ApiError, api, type BoardFilters } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { useProjectStream } from '../../lib/sse/useProjectStream';
import { useBoardStore, type BoardView } from '../../stores/board';
import { ErrorState, CardSkeleton } from '../../components/states';
import { WorkItemDrawer } from '../../features/work-item/WorkItemDrawer';
import { DecisionDrawer } from '../../features/decision/DecisionDrawer';
import { ManualMoveDialog } from '../../features/work-item/ManualMoveDialog';
import type { CardActions } from '../../features/work-item/BoardCard';
import type { BoardCard } from '../../lib/api/types';
import { TopBar } from './TopBar';
import { KanbanView } from './KanbanView';
import { ListView } from './ListView';
import { AgentView } from './AgentView';
import { DecisionView } from './DecisionView';
import { MovedToast } from './MovedToast';

export function BoardPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();

  // ★ 筛选写进 URL：看板链接要能直接分享「你看这三张卡」（页面文档 05 §5.7）
  const filters = useMemo(() => parseFilters(params), [params]);
  const view = (params.get('view') as BoardView) ?? 'kanban';

  /**
   * ★ 卡片抽屉的开关写进 URL，和筛选同一个理由：
   *   执行图的「在看板中定位」必须能指到具体某张卡，而不是把人扔到看板首页
   *   让他自己找（页面文档 07 §5.6）。顺带让「你看这张卡」的链接可分享。
   *   `card` 不在 parseFilters 的取值范围内，因此不会触发看板重新请求。
   */
  const openCard = params.get('card');
  const setOpenCard = useCallback(
    (id: string | null) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id) next.set('card', id);
          else next.delete('card');
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const [openDecision, setOpenDecision] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<{
    card: BoardCard;
    toStatus: WorkItemStatus;
    toStage: Stage;
  } | null>(null);
  const [doneExpanded, setDoneExpanded] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useProjectStream(projectId);

  const project = useQuery({
    queryKey: qk.project(projectId!),
    queryFn: () => api.project(projectId!),
    enabled: Boolean(projectId),
  });

  const board = useQuery({
    queryKey: qk.board(projectId!, filters),
    queryFn: () => api.board(projectId!, filters),
    enabled: Boolean(projectId),
  });

  const setFilters = useCallback(
    (patch: Partial<BoardFilters>) => {
      const next = new URLSearchParams(params);
      applyFilters(next, { ...filters, ...patch });
      setParams(next, { replace: true });
    },
    [params, filters, setParams],
  );

  const clearFilters = useCallback(() => {
    const next = new URLSearchParams();
    if (view !== 'kanban') next.set('view', view);
    setParams(next, { replace: true });
  }, [view, setParams]);

  const invalidateBoard = useCallback(() => {
    void qc.invalidateQueries({ queryKey: qk.boardAll(projectId!) });
  }, [qc, projectId]);

  const manualMove = useMutation({
    mutationFn: (input: { reason: string; reasonCategory: string }) =>
      api.changeStatus(pendingMove!.card.id, {
        toStatus: pendingMove!.toStatus,
        reason: input.reason,
        reasonCategory: input.reasonCategory,
      }),
    onSuccess: () => {
      setPendingMove(null);
      invalidateBoard();
    },
  });

  const remind = useMutation({
    mutationFn: (decisionId: string) => api.remindDecision(decisionId),
    onSuccess: () => setToast('已催办，30 分钟内不重复提醒'),
    onError: (e) => setToast(e instanceof ApiError ? e.message : '催办失败'),
  });

  const retry = useMutation({
    mutationFn: (cards: BoardCard[]) => Promise.all(cards.map((c) => api.retry(c.id))),
    onSuccess: (r) => {
      setToast(`已重新派发 ${r.length} 个任务`);
      invalidateBoard();
    },
    onError: (e) => setToast(e instanceof ApiError ? e.message : '重试失败'),
  });

  const takeover = useMutation({
    mutationFn: (card: BoardCard) => api.takeover(card.id, '人工接管处理'),
    onSuccess: () => {
      setToast('已接管，执行主体切换为你');
      invalidateBoard();
    },
    onError: (e) => setToast(e instanceof ApiError ? e.message : '接管失败'),
  });

  const actions: CardActions = useMemo(
    () => ({
      onOpen: (card) => setOpenCard(card.id),
      onHandleGate: (card) => {
        if (card.humanGateRef) setOpenDecision(card.humanGateRef);
        else setOpenCard(card.id);
      },
      onRetry: (card) => retry.mutate([card]),
      onRemind: (card) => {
        if (card.humanGateRef) remind.mutate(card.humanGateRef);
      },
      onTakeover: (card) => takeover.mutate(card),
      onViewRun: (card) => {
        if (card.runId) navigate(`/runs/${card.runId}`);
        else setOpenCard(card.id);
      },
    }),
    [retry, remind, takeover, navigate, setOpenCard],
  );

  if (!projectId) return null;

  const hasFilters =
    Boolean(filters.onlyMine) ||
    Boolean(filters.blocked) ||
    Boolean(filters.humanGate) ||
    Boolean(filters.executorType) ||
    (filters.risk?.length ?? 0) > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar
        projectName={project.data?.project.name ?? '加载中'}
        onOpenGraph={() => navigate(`/projects/${projectId}/graph`)}
        onOpenAnalytics={() => navigate(`/projects/${projectId}/analytics`)}
        onOpenPolicies={() => navigate(`/projects/${projectId}/settings/policies`)}
        onOpenRequirements={() => navigate(`/projects/${projectId}/requirements`)}
        summary={board.data?.summary}
        view={view}
        filters={filters}
        onView={(v) => {
          const next = new URLSearchParams(params);
          if (v === 'kanban') next.delete('view');
          else next.set('view', v);
          setParams(next, { replace: true });
        }}
        onFilters={setFilters}
        onClearFilters={clearFilters}
      />

      {/* 项目已暂停时给出全局提示（页面文档 05 §7） */}
      {project.data?.project.status === 'paused' && (
        <div className="bg-slate-200 px-4 py-1 text-center text-[11px] text-slate-700">
          项目已暂停，卡片不会自动流动
        </div>
      )}

      {board.isError && (
        <div className="p-4">
          <ErrorState error={board.error} onRetry={() => void board.refetch()} />
        </div>
      )}

      {board.isPending && (
        <div className="board-scroll flex flex-1 gap-3 overflow-x-auto p-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="w-64 shrink-0 space-y-2 rounded-lg bg-slate-100/70 p-2">
              <div className="h-3 w-20 rounded bg-slate-200" />
              <CardSkeleton />
              <CardSkeleton />
            </div>
          ))}
        </div>
      )}

      {board.data && view === 'kanban' && (
        <KanbanView
          columns={board.data.columns}
          actions={actions}
          hasFilters={hasFilters}
          onClearFilters={clearFilters}
          doneExpanded={doneExpanded}
          onExpandDone={() => setDoneExpanded(true)}
          onManualMove={(card, toStatus, toStage) =>
            setPendingMove({ card, toStatus, toStage })
          }
        />
      )}

      {board.data && view === 'list' && (
        <ListView
          columns={board.data.columns}
          actions={actions}
          onBulkRetry={(cards) => retry.mutate(cards)}
        />
      )}

      {board.data && view === 'agent' && (
        <AgentView projectId={projectId} columns={board.data.columns} actions={actions} />
      )}

      {board.data && view === 'decision' && (
        <DecisionView columns={board.data.columns} actions={actions} />
      )}

      <MovedToast />

      {toast && (
        <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded bg-slate-900 px-3 py-1.5 text-xs text-white shadow-lg">
          {toast}
          <button
            type="button"
            className="pointer-events-auto ml-2 underline"
            onClick={() => setToast(null)}
          >
            知道了
          </button>
        </div>
      )}

      {pendingMove && (
        <ManualMoveDialog
          card={pendingMove.card}
          toStatus={pendingMove.toStatus}
          toStage={pendingMove.toStage}
          pending={manualMove.isPending}
          error={
            manualMove.error instanceof ApiError
              ? manualMove.error.message
              : manualMove.error
                ? '操作失败'
                : null
          }
          onCancel={() => {
            manualMove.reset();
            setPendingMove(null);
          }}
          onConfirm={({ reason, reasonCategory }) => manualMove.mutate({ reason, reasonCategory })}
        />
      )}

      {openCard && (
        <WorkItemDrawer
          workItemId={openCard}
          onClose={() => setOpenCard(null)}
          onOpenDecision={(id) => {
            setOpenCard(null);
            setOpenDecision(id);
          }}
        />
      )}

      {openDecision && (
        <DecisionDrawer decisionId={openDecision} onClose={() => setOpenDecision(null)} />
      )}
    </div>
  );
}

function parseFilters(params: URLSearchParams): BoardFilters {
  return {
    onlyMine: params.get('onlyMine') === 'true',
    blocked: params.get('blocked') === 'true',
    humanGate: params.get('humanGate') === 'true',
    executorType: params.get('executorType') ?? undefined,
    risk: params.get('risk')?.split(',').filter(Boolean) ?? [],
  };
}

function applyFilters(target: URLSearchParams, filters: BoardFilters) {
  setOrDelete(target, 'onlyMine', filters.onlyMine ? 'true' : '');
  setOrDelete(target, 'blocked', filters.blocked ? 'true' : '');
  setOrDelete(target, 'humanGate', filters.humanGate ? 'true' : '');
  setOrDelete(target, 'executorType', filters.executorType ?? '');
  setOrDelete(target, 'risk', filters.risk?.join(',') ?? '');
}

function setOrDelete(params: URLSearchParams, key: string, value: string) {
  if (value) params.set(key, value);
  else params.delete(key);
}

export { useBoardStore };
