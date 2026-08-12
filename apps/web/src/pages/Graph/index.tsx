import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { LAYOUTS, formatHours, type GraphNode, type LayoutKind } from '@apos/domain';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { useProjectStream } from '../../lib/sse/useProjectStream';
import { useAuthStore } from '../../stores/auth';
import { CardSkeleton, EmptyState, ErrorState } from '../../components/states';
import { WorkItemDrawer } from '../../features/work-item/WorkItemDrawer';
import { DecisionDrawer } from '../../features/decision/DecisionDrawer';
import { GraphCanvas } from '../../features/graph/GraphCanvas';
import { Legend } from '../../features/graph/shapes';
import {
  HIGHLIGHT_MODES,
  MODE_LABELS,
  computeHighlight,
  type HighlightMode,
} from '../../features/graph/highlight';
import { resolveDiagnosticAction } from '../../features/graph/diagnostic-actions';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { Checkbox } from '@/components/ui/checkbox';

const LAYOUT_LABELS: Record<LayoutKind, string> = {
  layered: '分层',
  stage: '阶段泳道',
  executor: '执行者泳道',
};

/** 超过这个节点数，SVG 渲染开始吃力（页面文档 07 §7 建议改 Canvas） */
const LARGE_GRAPH = 100;
/** 少于这个节点数，图的价值不大 */
const TINY_GRAPH = 5;

export function GraphPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const currentUserId = useAuthStore((s) => s.userId);

  const layout = (params.get('layout') as LayoutKind) ?? 'layered';
  const focusId = params.get('focus');
  /**
   * ★ 必须 memo：这里每次渲染都会新建一个数组，而它是下面 computeHighlight
   *   那个 useMemo 的依赖 —— 不 memo 的话依赖每次都「变了」，
   *   整张图的高亮计算就变成每次渲染都重算一遍，memo 等于白写。
   *   节点多的项目上这条路径是可感知的卡顿。
   */
  const highlightParam = params.get('highlight');
  const modes = useMemo(
    () => (highlightParam?.split(',').filter(Boolean) ?? ['critical']) as HighlightMode[],
    [highlightParam],
  );

  const [hovered, setHovered] = useState<string | null>(null);
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [openDecision, setOpenDecision] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ node: GraphNode; x: number; y: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useProjectStream(projectId);

  const graph = useQuery({
    queryKey: qk.graph(projectId!, layout),
    queryFn: () => api.graph(projectId!, layout),
    enabled: Boolean(projectId),
  });

  const remind = useMutation({
    mutationFn: (decisionId: string) => api.remindDecision(decisionId),
    onSuccess: () => setToast('已催办，30 分钟内不重复提醒'),
    onError: (e) => setToast(e instanceof ApiError ? e.message : '催办失败'),
  });

  const highlight = useMemo(
    () =>
      computeHighlight({
        nodes: graph.data?.nodes ?? [],
        edges: graph.data?.edges ?? [],
        modes,
        criticalPaths: graph.data?.metrics.criticalPaths ?? [],
        currentUserId,
        hovered,
      }),
    [graph.data, modes, currentUserId, hovered],
  );

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const toggleMode = (mode: HighlightMode) => {
    const next = modes.includes(mode) ? modes.filter((m) => m !== mode) : [...modes, mode];
    setParam('highlight', next.join(','));
  };

  if (!projectId) return null;

  const nodeCount = graph.data?.nodes.length ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ── 工具栏 ── */}
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold text-slate-900">执行图</h1>
          <Link
            to={`/projects/${projectId}/board`}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            ← 回到看板
          </Link>

          <select
            value={layout}
            onChange={(e) => setParam('layout', e.target.value)}
            className="ml-2 rounded border border-slate-300 px-1.5 py-1 text-xs"
            aria-label="布局"
          >
            {LAYOUTS.map((l) => (
              <option key={l} value={l}>
                {LAYOUT_LABELS[l]}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-400">高亮</span>
            {HIGHLIGHT_MODES.map((mode) => (
              <label key={mode} className="flex cursor-pointer items-center gap-1 text-xs text-slate-600">
                <Checkbox
                  tone="neutral"
                  checked={modes.includes(mode)}
                  onCheckedChange={() => toggleMode(mode)}
                />
                {MODE_LABELS[mode]}
              </label>
            ))}
          </div>
        </div>

        {/* ── 关键路径信息条（页面文档 07 §5.3）── */}
        {graph.data && nodeCount > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs">
            <span className="text-slate-600">
              关键路径 {formatHours(graph.data.metrics.totalHours)} · 剩余{' '}
              {formatHours(graph.data.metrics.remainingHours)}
            </span>
            <span
              className={clsx(
                'font-medium',
                graph.data.metrics.delayRisk > 0.5
                  ? 'text-red-700'
                  : graph.data.metrics.delayRisk > 0.2
                    ? 'text-amber-700'
                    : 'text-slate-500',
              )}
            >
              {graph.data.metrics.delayRisk > 0 &&
                `⚠ 延期风险 ${Math.round(graph.data.metrics.delayRisk * 100)}%`}
            </span>
            {/* ★ 归因是本页价值的浓缩：直接告诉负责人该去解决什么 */}
            {graph.data.metrics.primaryCause && (
              <span className="text-slate-700">主因：{graph.data.metrics.primaryCause}</span>
            )}
            {graph.data.metrics.criticalPaths.length > 1 && (
              <span className="text-slate-500">
                存在 {graph.data.metrics.criticalPaths.length} 条等长关键路径
              </span>
            )}
          </div>
        )}
      </div>

      {graph.isError && (
        <div className="p-4">
          <ErrorState error={graph.error} onRetry={() => void graph.refetch()} />
        </div>
      )}

      {graph.isPending && (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="w-64 space-y-2">
            <CardSkeleton />
            <CardSkeleton />
          </div>
        </div>
      )}

      {graph.data && nodeCount === 0 && (
        <div className="p-8">
          <EmptyState
            icon="🕸"
            message="这个项目还没有任务"
            hint="计划批准后任务会出现在这里，依赖关系也会一并画出"
            action={{ label: '回到看板', onClick: () => history.back() }}
          />
        </div>
      )}

      {graph.data && nodeCount > 0 && nodeCount < TINY_GRAPH && graph.data.edges.length === 0 && (
        <p className="bg-sky-50 px-4 py-1 text-center text-[11px] text-sky-800">
          任务较少且相互独立，看板可能比执行图更合适
        </p>
      )}

      {nodeCount > LARGE_GRAPH && (
        <p className="bg-amber-50 px-4 py-1 text-center text-[11px] text-amber-800">
          共 {nodeCount} 个节点，当前用 SVG 渲染可能卡顿。建议开「关键路径」高亮后聚焦主链
        </p>
      )}

      {graph.data && nodeCount > 0 && (
        <>
          <GraphCanvas
            nodes={graph.data.nodes}
            edges={graph.data.edges}
            layout={graph.data.layout}
            highlight={highlight}
            focusId={focusId}
            onHover={setHovered}
            onSelect={(node) => setOpenCard(node.id)}
            onContextMenu={(node, at) => setMenu({ node, x: at.x, y: at.y })}
          />

          <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-1.5">
            <Legend />
          </div>

          <DiagnosticsPanel
            diagnostics={graph.data.diagnostics}
            onFocus={(nodeId) => setParam('focus', nodeId)}
            onAction={(action) => {
              const intent = resolveDiagnosticAction(action, projectId!);
              switch (intent.kind) {
                case 'navigate':
                  navigate(intent.to);
                  break;
                case 'open-card':
                  setOpenCard(intent.nodeId);
                  break;
                case 'remind': {
                  // 催办的对象是决策，不是任务 —— 要从节点上取 humanGateRef
                  const node = graph.data.nodes.find((n) => n.id === intent.nodeId);
                  if (node?.humanGateRef) remind.mutate(node.humanGateRef);
                  else setToast('这个节点上没有待办决策，无法催办');
                  break;
                }
                case 'explain':
                  setToast(intent.message);
                  break;
              }
            }}
          />
        </>
      )}

      {menu && (
        <>
          <button
            type="button"
            aria-label="关闭菜单"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setMenu(null)}
          />
          <div
            className="fixed z-50 min-w-32 rounded border border-slate-200 bg-white py-1 text-xs shadow-lg"
            style={{ left: menu.x, top: menu.y }}
          >
            <MenuItem
              onClick={() => {
                setOpenCard(menu.node.id);
                setMenu(null);
              }}
            >
              查看详情
            </MenuItem>
            {menu.node.humanGateRef && (
              <MenuItem
                onClick={() => {
                  setOpenDecision(menu.node.humanGateRef!);
                  setMenu(null);
                }}
              >
                处理决策
              </MenuItem>
            )}
            {menu.node.humanGateRef && (
              <MenuItem
                onClick={() => {
                  remind.mutate(menu.node.humanGateRef!);
                  setMenu(null);
                }}
              >
                催办
              </MenuItem>
            )}
            {menu.node.runId && (
              <MenuItem
                onClick={() => {
                  navigate(`/runs/${menu.node.runId}`);
                  setMenu(null);
                }}
              >
                查看执行记录
              </MenuItem>
            )}
            <MenuItem
              onClick={() => {
                navigate(`/projects/${projectId}/board?card=${menu.node.id}`);
                setMenu(null);
              }}
            >
              在看板中定位
            </MenuItem>
          </div>
        </>
      )}

      {toast && (
        <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2 animate-fade-in-up rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-800 shadow-lg glass-strong">
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
        <DecisionDrawer
          decisionId={openDecision}
          onClose={() => {
            setOpenDecision(null);
            void qc.invalidateQueries({ queryKey: qk.graphAll(projectId) });
          }}
        />
      )}
    </div>
  );
}

function MenuItem({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full px-3 py-1 text-left text-slate-700 hover:bg-slate-100"
    >
      {children}
    </button>
  );
}
