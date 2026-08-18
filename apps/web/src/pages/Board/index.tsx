import { useT } from '../../lib/i18n';
import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Stage, WorkItemStatus } from '@apos/contracts';
import { api, type BoardFilters } from '../../lib/api/client';
import { apiErrorMessage } from '../../lib/api/errors';
import { qk } from '../../lib/query/keys';
import { useProjectStream } from '../../lib/sse/useProjectStream';
import { useBoardStore, type BoardView } from '../../stores/board';
import { ErrorState, CardSkeleton } from '../../components/states';
import { WorkItemDrawer } from '../../features/work-item/WorkItemDrawer';
import { DecisionDrawer } from '../../features/decision/DecisionDrawer';
import { ManualMoveDialog } from '../../features/work-item/ManualMoveDialog';
import { CreateWorkItemDialog } from '../../features/work-item/CreateWorkItemDialog';
import type { CardActions } from '../../features/work-item/BoardCard';
import type { BoardCard } from '../../lib/api/types';
import { TopBar } from './TopBar';
import { KanbanView } from './KanbanView';
import { ListView } from './ListView';
import { AgentView } from './AgentView';
import { DecisionView } from './DecisionView';
import { MovedToast } from './MovedToast';
import { Button } from '@/components/ui/button';

export function BoardPage() {
  const t = useT();
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
  const [creating, setCreating] = useState(false);
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
    onSuccess: () => setToast(t('board.reminded')),
    onError: (e) => setToast(apiErrorMessage(e, t('board.remindFailed'))),
  });

  const retry = useMutation({
    mutationFn: (cards: BoardCard[]) => Promise.all(cards.map((c) => api.retry(c.id))),
    onSuccess: (r) => {
      setToast(t('board.redispatched', { count: r.length }));
      invalidateBoard();
    },
    onError: (e) => setToast(apiErrorMessage(e, t('board.retryFailed'))),
  });

  const takeover = useMutation({
    mutationFn: (card: BoardCard) => api.takeover(card.id, t('board.takeoverReason')),
    onSuccess: () => {
      setToast(t('board.takenOver'));
      invalidateBoard();
    },
    /**
     * ★★ 状态冲突时**顺手刷新看板**，而不是只弹一句错。
     *
     *   409 几乎总是「界面上这张卡过期了」：别人刚动过它，或者调度器
     *   刚把它推走了。不刷新的话用户会照着同一张过期卡片再点一次，
     *   拿到同一句错 —— 而那句错说的是一个界面上从没出现过的状态名
     *   （问题记录 #16 / #27）。
     */
    onError: (e) => {
      setToast(apiErrorMessage(e, t('board.takeoverFailed')));
      invalidateBoard();
    },
  });

  const actions: CardActions = useMemo(
    () => ({
      onOpen: (card) => setOpenCard(card.id),
      onOpenById: (id) => setOpenCard(id),
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
    Boolean(filters.unclaimed) ||
    (filters.risk?.length ?? 0) > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 项目名与跨页跳转都归项目侧栏（components/ProjectSidebar.tsx）*/}
      <TopBar
        onNewWorkItem={() => setCreating(true)}
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
          {t('board.projectPaused')}
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
          /*
           * ★ 整页跳转而不是抽屉：批准计划要逐条看任务、改配置、确认预算，
           *   那是 04 计划批准页一整页的事，塞进侧栏抽屉放不下。
           */
          onOpenPlan={(plan) => navigate(`/projects/${projectId}/plans/${plan.id}`)}
          /* ★ 列头那个超时计数点下去就筛出「在等人」的那批，而不是只报个数 */
          onFilterOverdue={() => setFilters({ humanGate: true })}
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
          <Button variant="ghost"
            className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent pointer-events-auto ml-2 underline"
            onClick={() => setToast(null)}
          >
            {t('common.gotIt')}
          </Button>
        </div>
      )}

      {creating && projectId && (
        <CreateWorkItemDialog projectId={projectId} onClose={() => setCreating(false)} />
      )}

      {pendingMove && (
        <ManualMoveDialog
          card={pendingMove.card}
          toStatus={pendingMove.toStatus}
          toStage={pendingMove.toStage}
          pending={manualMove.isPending}
          error={manualMove.error ? apiErrorMessage(manualMove.error, t('board.actionFailed')) : null}
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
