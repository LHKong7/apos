import { useState } from 'react';
import { useT, type MessageKey } from '../../lib/i18n';
import type { NodeKind } from '@apos/domain';
import { NODE_H, NODE_W } from './geometry';

/**
 * 节点形状（页面文档 07 §5.1）。
 *
 * ★ 七种类型形状各异，不是只换颜色 —— 色觉障碍用户看不出橙色和红色的差别，
 *   但看得出菱形和矩形。同理，状态也用「颜色 + 图标」双编码。
 */
export const KIND_META: Record<NodeKind, { icon: string; labelKey: MessageKey }> = {
  human_task: { icon: '👤', labelKey: 'shape.humanTask' },
  agent_task: { icon: '🤖', labelKey: 'shape.agentTask' },
  approval: { icon: '◆', labelKey: 'shape.approval' },
  automation: { icon: '⚙', labelKey: 'shape.automation' },
  waiting: { icon: '⏸', labelKey: 'shape.waiting' },
  verification: { icon: '◇', labelKey: 'shape.verification' },
  release: { icon: '🚀', labelKey: 'shape.release' },
};

/**
 * ★ 走 CSS 变量而不是写死的 hex。
 *
 *   SVG 的 fill/stroke 是属性不是 class，Tailwind 的色阶够不到这里 ——
 *   写死的话，换到深色主题时整张执行图会留在原地：
 *   一张白纸上摆着几个浅粉浅蓝的方块。令牌定义见 src/index.css 的 --graph-*。
 */
export const STATUS_FILL: Record<string, string> = {
  done: 'var(--graph-fill-done)',
  released: 'var(--graph-fill-done)',
  acceptance: 'var(--graph-fill-done)',
  executing: 'var(--graph-fill-exec)',
  blocked: 'var(--graph-fill-blocked)',
  failed: 'var(--graph-fill-failed)',
  awaiting_decision: 'var(--graph-fill-decision)',
  cancelled: 'var(--graph-fill-cancelled)',
};

export const STATUS_STROKE: Record<string, string> = {
  done: 'var(--graph-stroke-done)',
  released: 'var(--graph-stroke-done)',
  acceptance: 'var(--graph-stroke-done)',
  executing: 'var(--graph-stroke-exec)',
  blocked: 'var(--graph-stroke-blocked)',
  failed: 'var(--graph-stroke-failed)',
  awaiting_decision: 'var(--graph-stroke-decision)',
  cancelled: 'var(--graph-stroke-cancelled)',
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
  const fill = STATUS_FILL[status] ?? 'var(--graph-fill-default)';
  const stroke = inBlockedChain
    ? 'var(--graph-danger)'
    : (STATUS_STROKE[status] ?? 'var(--graph-stroke-default)');
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
/**
 * 图例。
 *
 * ★★ 默认**收起**。
 *
 *   九个条目每个带一个形状加一段文字，摊开占掉页面下半部分好大一块 ——
 *   而图例是「第一次看这张图」时才需要的东西，之后每一次打开都要为它
 *   让出一条横带（问题记录 #37）。收起后只留一行按钮，展开状态记在这里，
 *   同一次会话里不用反复展开。
 *
 * ★ 收起时仍然留一行最要紧的两条（关键路径 / 数据依赖）—— 它们解释的是
 *   **线**，而线没有 tooltip 可点，图例是唯一的出处。节点那九种有 tooltip
 *   兜着，可以收。
 *
 * Nine entries with a shape each ate the bottom band of the page on every
 * visit, though a legend is only needed the first time. Edge styles stay
 * visible because edges have no tooltip — the legend is their only explanation.
 */
export function Legend() {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="rounded border border-slate-200 px-1.5 py-0.5 text-slate-600 hover:bg-slate-100"
      >
        {open ? t('graph.legend.hide') : t('graph.legend.show')}
      </button>

      {/* ★ 线型常驻：线没有 tooltip，这里是它唯一的解释 */}
      <span className="inline-flex items-center gap-1">
        <svg width={20} height={6} aria-hidden>
          <line x1={0} y1={3} x2={20} y2={3} stroke="var(--graph-edge-critical)" strokeWidth={3} />
        </svg>
        {t('graph.criticalPath')}
      </span>
      <span className="inline-flex items-center gap-1">
        <svg width={20} height={6} aria-hidden>
          <line x1={0} y1={3} x2={20} y2={3} stroke="var(--graph-edge)" strokeWidth={1.5} strokeDasharray="4 2" />
        </svg>
        {t('graph.dataDependency')}
      </span>

      {open &&
        (Object.entries(KIND_META) as [NodeKind, { icon: string; labelKey: MessageKey }][]).map(
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
              <span aria-hidden>{meta.icon}</span> {t(meta.labelKey)}
            </span>
          ),
        )}
    </div>
  );
}
