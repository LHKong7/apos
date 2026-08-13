import { t, useT } from '../../lib/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { GraphEdge, GraphNode, LayoutResult } from '@apos/domain';
import { NODE_H, NODE_W, edgePath, edgeStyle, fitTransform } from './geometry';
import { KIND_META, NodeShape } from './shapes';
import { edgeKey, type HighlightResult } from './highlight';
import { money } from '../../lib/format';

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  layout: LayoutResult;
  highlight: HighlightResult;
  focusId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (node: GraphNode) => void;
  onContextMenu: (node: GraphNode, at: { x: number; y: number }) => void;
}

interface Transform {
  scale: number;
  tx: number;
  ty: number;
}

const MIN_SCALE = 0.15;
const MAX_SCALE = 2.5;
/** 缩到这个比例以下，节点上的文字已经读不清，只留图标 */
const ICON_ONLY_BELOW = 0.5;
/** 放大到这个比例以上才有空间显示执行者、成本 */
const DETAIL_ABOVE = 0.85;

export function GraphCanvas({
  nodes,
  edges,
  layout,
  highlight,
  focusId,
  onHover,
  onSelect,
  onContextMenu,
}: Props) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [transform, setTransform] = useState<Transform>({ scale: 1, tx: 0, ty: 0 });
  const [dragging, setDragging] = useState<{ x: number; y: number } | null>(null);
  /** 用户是否手动缩放/平移过 —— 之后就别再自动重置他的视口 */
  const touched = useRef(false);

  const position = new Map(layout.positions.map((p) => [p.id, p]));

  const fit = useCallback(() => {
    const el = containerRef.current;
    // 容器还没拿到尺寸时算出来的缩放是错的（会得到 15% 这种下限值），
    // 宁可不动也不要把图缩成一个点
    if (!el || el.clientWidth < 50 || el.clientHeight < 50) return;
    setTransform(fitTransform(layout, { width: el.clientWidth, height: el.clientHeight }));
  }, [layout]);

  /**
   * ★ 首次适应窗口要等容器真正拿到尺寸。
   *
   *   直接在 useEffect 里读 clientHeight，此时 flex 布局还没结算完，
   *   读到的是一个很小的值 —— 图会被缩到 17% 摆在画布正中间，
   *   看起来像「渲染坏了」，而实际数据完全正确。
   *   用 ResizeObserver 等尺寸稳定，比 setTimeout 猜一个延时可靠。
   */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    fit();
    const observer = new ResizeObserver(() => {
      // 只在用户没手动缩放过时跟随窗口，否则会打断他的操作
      if (!touched.current) fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit]);

  // 切换布局等于换了一张图，用户之前的视口没有意义，重新适应
  useEffect(() => {
    touched.current = false;
  }, [layout]);

  // 深链 ?focus=<id> 把视口移到该节点
  useEffect(() => {
    if (!focusId) return;
    touched.current = true;
    const el = containerRef.current;
    const pos = position.get(focusId);
    if (!el || !pos) return;
    setTransform((t) => ({
      scale: Math.max(t.scale, 0.8),
      tx: el.clientWidth / 2 - (pos.x + NODE_W / 2) * Math.max(t.scale, 0.8),
      ty: el.clientHeight / 2 - (pos.y + NODE_H / 2) * Math.max(t.scale, 0.8),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, layout]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    touched.current = true;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    setTransform((t) => {
      const next = clamp(t.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12), MIN_SCALE, MAX_SCALE);
      // 以光标为锚点缩放 —— 以画布中心缩放会让人一直找不到自己看的那块
      const k = next / t.scale;
      return { scale: next, tx: px - (px - t.tx) * k, ty: py - (py - t.ty) * k };
    });
  };

  const detail = transform.scale >= DETAIL_ABOVE;
  const iconOnly = transform.scale < ICON_ONLY_BELOW;

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-slate-50">
      <div
        ref={containerRef}
        className={clsx('h-full w-full', dragging ? 'cursor-grabbing' : 'cursor-grab')}
        onWheel={onWheel}
        onMouseDown={(e) => {
          touched.current = true;
          setDragging({ x: e.clientX - transform.tx, y: e.clientY - transform.ty });
        }}
        onMouseMove={(e) => {
          if (!dragging) return;
          setTransform((t) => ({ ...t, tx: e.clientX - dragging.x, ty: e.clientY - dragging.y }));
        }}
        onMouseUp={() => setDragging(null)}
        onMouseLeave={() => setDragging(null)}
      >
        <svg className="h-full w-full" role="img" aria-label={t('graph.aria')}>
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 8 8"
              refX={7}
              refY={4}
              markerWidth={6}
              markerHeight={6}
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 8 4 L 0 7 z" fill="var(--graph-edge)" />
            </marker>
            <marker
              id="arrow-critical"
              viewBox="0 0 8 8"
              refX={7}
              refY={4}
              markerWidth={6}
              markerHeight={6}
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 8 4 L 0 7 z" fill="var(--graph-edge-critical)" />
            </marker>
          </defs>

          <g transform={`translate(${transform.tx} ${transform.ty}) scale(${transform.scale})`}>
            {/* 泳道背景先画，节点压在上面 */}
            {layout.lanes.map((lane) => (
              <g key={lane.key}>
                <rect
                  x={-24}
                  y={lane.y}
                  width={layout.width + NODE_W + 48}
                  height={lane.height}
                  fill="var(--graph-lane-fill)"
                  stroke="var(--graph-lane-stroke)"
                />
                <text x={-16} y={lane.y + 16} fontSize={11} fill="var(--graph-sub)">
                  {lane.label}
                </text>
              </g>
            ))}

            {edges.map((edge) => {
              const from = position.get(edge.from);
              const to = position.get(edge.to);
              if (!from || !to) return null;

              const critical = highlight.criticalEdges.has(edgeKey(edge.from, edge.to));
              const dim =
                highlight.dimOthers &&
                !(highlight.emphasized.has(edge.from) && highlight.emphasized.has(edge.to));
              const style = edgeStyle(edge.type, critical, dim);
              const d = edgePath(from, to);

              return (
                <g key={edgeKey(edge.from, edge.to)}>
                  <path
                    d={d}
                    fill="none"
                    stroke={style.stroke}
                    strokeWidth={style.strokeWidth}
                    strokeDasharray={style.strokeDasharray}
                    markerEnd={`url(#${critical ? 'arrow-critical' : 'arrow'})`}
                  />
                  {style.double && (
                    <path
                      d={d}
                      fill="none"
                      stroke={style.stroke}
                      strokeWidth={style.strokeWidth}
                      transform="translate(0 3)"
                    />
                  )}
                </g>
              );
            })}

            {nodes.map((node) => {
              const pos = position.get(node.id);
              if (!pos) return null;

              const dim = highlight.dimOthers && !highlight.emphasized.has(node.id);
              const onCritical = highlight.criticalEdges.size > 0 && highlight.emphasized.has(node.id);

              return (
                <g
                  key={node.id}
                  transform={`translate(${pos.x} ${pos.y})`}
                  opacity={dim ? 0.4 : 1}
                  className="cursor-pointer"
                  onMouseEnter={() => onHover(node.id)}
                  onMouseLeave={() => onHover(null)}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(node);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onContextMenu(node, { x: e.clientX, y: e.clientY });
                  }}
                >
                  <title>{tooltipOf(node)}</title>

                  <NodeShape
                    kind={node.kind}
                    status={node.status}
                    emphasized={highlight.emphasized.has(node.id)}
                    onCritical={onCritical}
                    inBlockedChain={highlight.blockedChain.has(node.id)}
                  />

                  {iconOnly ? (
                    <text x={NODE_W / 2} y={NODE_H / 2 + 8} textAnchor="middle" fontSize={22}>
                      {KIND_META[node.kind].icon}
                    </text>
                  ) : (
                    <>
                      {/*
                        ★ 文字一律居中。
                          菱形、六边形、椭圆在上下边缘处宽度很窄，
                          左对齐的标题会直接戳出轮廓，看起来像渲染错位。
                          能用的字数也随形状收窄（narrow 系列只有矩形的六成）。
                      */}
                      <text
                        x={NODE_W / 2}
                        y={detail ? NODE_H / 2 - 4 : NODE_H / 2 + 4}
                        textAnchor="middle"
                        fontSize={11}
                        fill="var(--graph-ink)"
                      >
                        {KIND_META[node.kind].icon} {truncate(node.title, titleBudget(node.kind))}
                      </text>

                      {detail && (
                        <>
                          <text
                            x={NODE_W / 2}
                            y={NODE_H / 2 + 10}
                            textAnchor="middle"
                            fontSize={9}
                            fill="var(--graph-sub)"
                          >
                            {truncate(node.executor?.name ?? t('graph.unassigned'), titleBudget(node.kind))}
                          </text>
                          <text
                            x={NODE_W / 2}
                            y={NODE_H / 2 + 22}
                            textAnchor="middle"
                            fontSize={9}
                            fill="var(--graph-meta)"
                          >
                            {node.durationHours}h
                            {node.durationEstimated ? t('graph.estimated') : ''} · {money(node.cost)}
                            {node.progressPct !== null && ` · ${node.progressPct}%`}
                          </text>
                        </>
                      )}

                      {/* 进度条只画在矩形类节点上 —— 菱形底部太窄，画上去会溢出 */}
                      {node.progressPct !== null && isRectangular(node.kind) && (
                        <>
                          <rect
                            x={10}
                            y={NODE_H - 8}
                            width={NODE_W - 20}
                            height={3}
                            fill="var(--graph-track)"
                            rx={2}
                          />
                          <rect
                            x={10}
                            y={NODE_H - 8}
                            width={((NODE_W - 20) * node.progressPct) / 100}
                            height={3}
                            fill="var(--graph-progress)"
                            rx={2}
                          />
                        </>
                      )}

                      {node.blockedMinutes !== null && (
                        <text x={NODE_W / 2} y={13} textAnchor="middle" fontSize={9} fill="var(--graph-warn)">
                          ⛔
                        </text>
                      )}
                      {node.decisionDueInMinutes !== null && node.decisionDueInMinutes < 0 && (
                        <text x={NODE_W / 2} y={13} textAnchor="middle" fontSize={9} fill="var(--graph-danger)">
                          ⏰
                        </text>
                      )}
                      {(node.riskLevel === 'high' || node.riskLevel === 'critical') && (
                        <circle cx={NODE_W / 2} cy={NODE_H - 6} r={3.5} fill="var(--graph-danger)" />
                      )}
                    </>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      <div className="absolute bottom-2 right-2 flex items-center gap-1 rounded border border-slate-300 bg-white/90 px-1.5 py-1 text-[11px]">
        <button
          type="button"
          onClick={() => {
            touched.current = true;
            setTransform((t) => zoom(t, 1.2));
          }}
          className="px-1"
        >
          ＋
        </button>
        <span className="w-9 text-center tabular-nums text-slate-500">
          {Math.round(transform.scale * 100)}%
        </span>
        <button
          type="button"
          onClick={() => {
            touched.current = true;
            setTransform((t) => zoom(t, 1 / 1.2));
          }}
          className="px-1"
        >
          －
        </button>
        <button
          type="button"
          onClick={() => {
            touched.current = false;
            fit();
          }}
          className="ml-1 text-slate-600 hover:text-slate-900"
        >
          {t('graph.fitToWindow')}
        </button>
      </div>
    </div>
  );
}

function zoom(t: Transform, factor: number): Transform {
  return { ...t, scale: clamp(t.scale * factor, MIN_SCALE, MAX_SCALE) };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 菱形/六边形/椭圆的有效宽度比矩形窄得多，能放的字数也得跟着减 */
function titleBudget(kind: GraphNode['kind']): number {
  return isRectangular(kind) ? 15 : 9;
}

function isRectangular(kind: GraphNode['kind']): boolean {
  return kind === 'agent_task' || kind === 'human_task' || kind === 'automation' || kind === 'release';
}

/** 悬停提示：把节点上放不下的信息补齐（页面文档 07 §5.6） */
function tooltipOf(node: GraphNode): string {
  const lines = [
    node.title,
    `${t(KIND_META[node.kind].labelKey)} · ${node.status}`,
    t('graph.executorLine', { name: node.executor?.name ?? t('graph.unassigned') }),
    t('graph.durationLine', { hours: node.durationHours, estimated: node.durationEstimated ? t('graph.defaultEstimate') : '', cost: money(node.cost) }),
  ];
  if (node.blockedReason) lines.push(t('graph.blockedLine', { reason: node.blockedReason }));
  if (node.decisionDueInMinutes !== null) {
    lines.push(
      node.decisionDueInMinutes < 0
        ? t('graph.decisionOverdue', { hours: Math.round(Math.abs(node.decisionDueInMinutes) / 60) })
        : t('graph.decisionLeft', { hours: Math.round(node.decisionDueInMinutes / 60) }),
    );
  }
  return lines.join('\n');
}
