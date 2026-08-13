import { t } from '../../lib/i18n';
import type { DependencyType } from '@apos/contracts';

/** 与服务端布局用的尺寸必须一致，否则连线会对不上节点边框 */
export const NODE_W = 168;
export const NODE_H = 64;

export interface Point {
  x: number;
  y: number;
}

/**
 * 连线路径。
 *
 * 用三次贝塞尔而不是折线：分层布局里同一层往往有多条平行边，
 * 折线会重叠成一条，看不出有几条依赖；曲线自然错开。
 */
export function edgePath(from: Point, to: Point): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;

  // 控制点距离随水平跨度变化，跨列远的边弯得更缓
  const dx = Math.max(Math.abs(x2 - x1) * 0.5, 32);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

export interface EdgeStyle {
  stroke: string;
  strokeWidth: number;
  strokeDasharray?: string;
  /** 双线依赖额外画一条平行线 */
  double: boolean;
  label: string;
}

/** 边的六种样式（页面文档 07 §5.2） */
export function edgeStyle(type: DependencyType, critical: boolean, dim: boolean): EdgeStyle {
  // ★ 走 CSS 变量：写死 hex 的话，深色主题下这些线会留在浅色值上
  //   （关键路径那条近黑的线在深底上等于消失）。令牌见 src/index.css
  const base: EdgeStyle = {
    stroke: critical ? 'var(--graph-edge-critical)' : 'var(--graph-edge)',
    strokeWidth: critical ? 2.5 : 1.25,
    double: false,
    label: t('edge.prerequisite'),
  };

  const styled: EdgeStyle = (() => {
    switch (type) {
      case 'data':
        return { ...base, strokeDasharray: '4 3', label: t('edge.data') };
      case 'artifact':
        return { ...base, strokeDasharray: '6 2', label: t('edge.artifact') };
      case 'decision':
      case 'permission':
        return { ...base, double: true, label: type === 'decision' ? t('edge.approval') : t('edge.permission') };
      case 'external':
        return { ...base, strokeDasharray: '2 3', label: t('edge.external') };
      case 'start_to_start':
        return { ...base, label: t('edge.syncStart') };
      case 'finish_to_start':
      default:
        return base;
    }
  })();

  return dim ? { ...styled, stroke: 'var(--graph-lane-stroke)', strokeWidth: 1 } : styled;
}

/** 视口自适应：把整张图缩放到容器内并留白 */
export function fitTransform(
  graph: { width: number; height: number },
  viewport: { width: number; height: number },
): { scale: number; tx: number; ty: number } {
  const pad = 48;
  if (graph.width === 0 || graph.height === 0) return { scale: 1, tx: pad, ty: pad };

  const scale = Math.min(
    (viewport.width - pad * 2) / (graph.width + NODE_W),
    (viewport.height - pad * 2) / (graph.height + NODE_H),
    // 不放大：小图铺满整屏会让节点大得可笑，也失去了「一眼看全」的意义
    1,
  );

  const safeScale = Math.max(scale, 0.15);
  return {
    scale: safeScale,
    tx: (viewport.width - (graph.width + NODE_W) * safeScale) / 2,
    ty: (viewport.height - (graph.height + NODE_H) * safeScale) / 2,
  };
}
