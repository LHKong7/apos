import clsx from 'clsx';
import type { NodeKind } from '@apos/domain';
import { NODE_H, NODE_W } from './geometry';

/**
 * 节点形状（页面文档 07 §5.1）。
 *
 * ★ 七种类型形状各异，不是只换颜色 —— 色觉障碍用户看不出橙色和红色的差别，
 *   但看得出菱形和矩形。同理，状态也用「颜色 + 图标」双编码。
 */
export const KIND_META: Record<NodeKind, { icon: string; label: string }> = {
  human_task: { icon: '👤', label: '人类任务' },
  agent_task: { icon: '🤖', label: 'Agent 任务' },
  approval: { icon: '◆', label: '审批节点' },
  automation: { icon: '⚙', label: '自动化' },
  waiting: { icon: '⏸', label: '等待' },
  verification: { icon: '◇', label: '验证节点' },
  release: { icon: '🚀', label: '发布' },
};

export const STATUS_FILL: Record<string, string> = {
  done: '#dcfce7',
  released: '#dcfce7',
  acceptance: '#dcfce7',
  executing: '#dbeafe',
  blocked: '#ffedd5',
  failed: '#fee2e2',
  awaiting_decision: '#fef3c7',
  cancelled: '#f1f5f9',
};

export const STATUS_STROKE: Record<string, string> = {
  done: '#16a34a',
  released: '#16a34a',
  acceptance: '#16a34a',
  executing: '#2563eb',
  blocked: '#ea580c',
  failed: '#dc2626',
  awaiting_decision: '#d97706',
  cancelled: '#94a3b8',
};

interface ShapeProps {
  kind: NodeKind;
  status: string;
  emphasized: boolean;
  onCritical: boolean;
  inBlockedChain: boolean;
}

/**
 * 形状本体。
 *
 * 用 path/polygon 而不是给矩形加圆角变体 —— 菱形和六边形必须是真的多边形，
 * 缩小到「只剩图标」的层级时，轮廓是唯一还能分辨类型的东西。
 */
export function NodeShape({ kind, status, emphasized, onCritical, inBlockedChain }: ShapeProps) {
  const fill = STATUS_FILL[status] ?? '#f8fafc';
  const stroke = inBlockedChain ? '#dc2626' : (STATUS_STROKE[status] ?? '#cbd5e1');
  const strokeWidth = onCritical ? 3 : emphasized ? 2 : 1.25;

  const common = {
    fill,
    stroke,
    strokeWidth,
    // 审批节点用双线边框（页面文档 07 §5.1）
    ...(kind === 'approval' ? { strokeDasharray: undefined } : {}),
  };

  switch (kind) {
    case 'approval':
      return (
        <>
          <polygon points={diamondPoints(0)} {...common} />
          <polygon points={diamondPoints(5)} fill="none" stroke={stroke} strokeWidth={1} />
        </>
      );

    case 'verification':
      return <polygon points={hexagonPoints()} {...common} />;

    case 'waiting':
      return (
        <ellipse cx={NODE_W / 2} cy={NODE_H / 2} rx={NODE_W / 2} ry={NODE_H / 2} {...common} />
      );

    case 'human_task':
      return <rect width={NODE_W} height={NODE_H} rx={14} {...common} />;

    case 'automation':
      return <rect width={NODE_W} height={NODE_H} rx={2} strokeDasharray="5 3" {...common} />;

    case 'release':
      return <rect width={NODE_W} height={NODE_H} rx={2} {...common} strokeWidth={strokeWidth + 2} />;

    case 'agent_task':
    default:
      return <rect width={NODE_W} height={NODE_H} rx={2} {...common} />;
  }
}

function diamondPoints(inset: number): string {
  const w = NODE_W - inset * 2;
  const h = NODE_H - inset * 2;
  const x = inset;
  const y = inset;
  return [
    `${x + w / 2},${y}`,
    `${x + w},${y + h / 2}`,
    `${x + w / 2},${y + h}`,
    `${x},${y + h / 2}`,
  ].join(' ');
}

function hexagonPoints(): string {
  const cut = 18;
  return [
    `${cut},0`,
    `${NODE_W - cut},0`,
    `${NODE_W},${NODE_H / 2}`,
    `${NODE_W - cut},${NODE_H}`,
    `${cut},${NODE_H}`,
    `0,${NODE_H / 2}`,
  ].join(' ');
}

/** 图例。没有它，七种形状对第一次看图的人就是七种装饰 */
export function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
      {(Object.entries(KIND_META) as [NodeKind, { icon: string; label: string }][]).map(
        ([kind, meta]) => (
          <span key={kind} className="inline-flex items-center gap-1">
            <svg width={16} height={11} viewBox={`0 0 ${NODE_W} ${NODE_H}`} aria-hidden>
              <NodeShape
                kind={kind}
                status="ready"
                emphasized={false}
                onCritical={false}
                inBlockedChain={false}
              />
            </svg>
            {meta.icon} {meta.label}
          </span>
        ),
      )}
      <span className="inline-flex items-center gap-1">
        <svg width={20} height={6} aria-hidden>
          <line x1={0} y1={3} x2={20} y2={3} stroke="#0f172a" strokeWidth={3} />
        </svg>
        关键路径
      </span>
      <span className={clsx('inline-flex items-center gap-1')}>
        <svg width={20} height={6} aria-hidden>
          <line x1={0} y1={3} x2={20} y2={3} stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="4 2" />
        </svg>
        数据依赖
      </span>
    </div>
  );
}
