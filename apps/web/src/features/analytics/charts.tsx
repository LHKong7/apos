import { useId, useState } from 'react';
import clsx from 'clsx';
import type { Point } from '@apos/domain';
import { CHROME, MARK, SERIES, type STATUS } from './palette';

/**
 * 本页用到的四种图形。刻意手写 SVG 而不是引图表库：
 * 这里全是「带标签的条」和「一条线」，Recharts 的体积换不来任何东西，
 * 而 tooltip、直接标注、表格视图这些真正要紧的行为反而要绕开它的默认样式重做。
 */

// ── 横向条 ────────────────────────────────────────────────────────────────

export interface BarDatum {
  label: string;
  value: number;
  /** 右侧显示的文本，不给就显示 value */
  display?: string;
  /** 二类着色；不给一律用主色 */
  tone?: 'primary' | 'waiting';
  /** 标出这一条并配图标 + 文字说明，颜色永远不是唯一线索 */
  flag?: { icon: string; text: string; tone: keyof typeof STATUS };
  onClick?: () => void;
}

/**
 * 横向条列表。
 *
 * ★ 这个形态本身就是一张表：左边标签、右边数值，条只是把数量关系画出来。
 *   所以它天然满足「不能只靠颜色编码」——不需要额外做表格视图。
 */
export function BarChart({
  data,
  legend,
  emptyHint = '这段时间没有数据',
}: {
  data: BarDatum[];
  legend?: { label: string; tone: 'primary' | 'waiting' }[];
  emptyHint?: string;
}) {
  const max = Math.max(...data.map((d) => d.value), 0);
  if (data.length === 0 || max === 0) {
    return <p className="py-3 text-center text-xs text-slate-400">{emptyHint}</p>;
  }

  return (
    <div>
      {legend && legend.length >= 2 && <Legend items={legend} />}
      <ul className="space-y-1">
        {data.map((d) => {
          const pct = (d.value / max) * 100;
          const Tag = d.onClick ? 'button' : 'div';
          return (
            <li key={d.label}>
              <Tag
                {...(d.onClick ? { type: 'button' as const, onClick: d.onClick } : {})}
                className={clsx(
                  'flex w-full items-center gap-2 rounded py-0.5 text-left text-xs',
                  d.onClick && 'hover:bg-slate-50',
                )}
              >
                <span className="w-20 shrink-0 truncate text-slate-600" title={d.label}>
                  {d.label}
                </span>
                <span className="relative h-3 flex-1 rounded-sm bg-slate-100">
                  <span
                    className="absolute inset-y-0 left-0 rounded-r-[4px]"
                    style={{
                      // 0 就画成 0：留一条细缝会被读成「有一点」，那是假的
                      width: `${d.value === 0 ? 0 : Math.max(pct, 1.5)}%`,
                      background: d.tone === 'waiting' ? SERIES.waiting : SERIES.primary,
                    }}
                  />
                </span>
                <span className="w-24 shrink-0 text-right tabular-nums text-slate-700">
                  {d.display ?? d.value}
                </span>
                {d.flag && (
                  <span
                    className="w-28 shrink-0 truncate text-[11px]"
                    style={{ color: FLAG_COLORS[d.flag.tone] }}
                    title={d.flag.text}
                  >
                    {d.flag.icon} {d.flag.text}
                  </span>
                )}
              </Tag>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const FLAG_COLORS = {
  good: '#166534',
  warning: '#b45309',
  serious: '#c2410c',
  critical: '#b91c1c',
} as const;

function Legend({ items }: { items: { label: string; tone: 'primary' | 'waiting' }[] }) {
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-sm"
            style={{ background: i.tone === 'waiting' ? SERIES.waiting : SERIES.primary }}
          />
          {i.label}
        </span>
      ))}
    </div>
  );
}

// ── 趋势线 ────────────────────────────────────────────────────────────────

/**
 * 单序列时间趋势。
 *
 * 只画一条线所以不需要图例（标题已经说了画的是什么）。
 * 峰值与最新值直接标在图上，其余靠 hover 与表格视图 ——
 * 每个点都标数字只会变成一团噪声，没人会读。
 */
export function TrendChart({
  points,
  format = (v) => String(v),
  height = 96,
  tone = 'primary',
  emptyHint = '这段时间没有数据',
}: {
  points: Point[];
  format?: (v: number) => string;
  height?: number;
  tone?: 'primary' | 'waiting';
  emptyHint?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const clipId = useId();

  if (points.length === 0 || points.every((p) => p.value === 0)) {
    return <p className="py-3 text-center text-xs text-slate-400">{emptyHint}</p>;
  }

  const W = 100;
  const PAD_T = 10;
  const PAD_B = 16;
  const plot = height - PAD_T - PAD_B;
  const max = Math.max(...points.map((p) => p.value));
  const color = tone === 'waiting' ? SERIES.waiting : SERIES.primary;

  const x = (i: number) => (points.length === 1 ? W / 2 : (i / (points.length - 1)) * W);
  const y = (v: number) => PAD_T + plot - (max === 0 ? 0 : (v / max) * plot);

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.value)}`).join(' ');
  const area = `${line} L ${x(points.length - 1)} ${PAD_T + plot} L ${x(0)} ${PAD_T + plot} Z`;

  const peakIdx = points.reduce((best, p, i) => (p.value > points[best]!.value ? i : best), 0);
  const lastIdx = points.length - 1;
  const active = hover ?? null;

  return (
    <div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${height}`}
          preserveAspectRatio="none"
          className="h-24 w-full"
          role="img"
          aria-label={`趋势，峰值 ${format(points[peakIdx]!.value)}`}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = (e.clientX - rect.left) / rect.width;
            setHover(Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1)))));
          }}
        >
          {/* 基线与中线：实线细发丝，退到背景里 */}
          <line x1={0} y1={PAD_T + plot} x2={W} y2={PAD_T + plot} stroke={CHROME.axis} strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
          <line x1={0} y1={PAD_T + plot / 2} x2={W} y2={PAD_T + plot / 2} stroke={CHROME.grid} strokeWidth={0.5} vectorEffect="non-scaling-stroke" />

          <clipPath id={clipId}>
            <rect x={0} y={0} width={W} height={height} />
          </clipPath>
          <g clipPath={`url(#${clipId})`}>
            <path d={area} fill={color} opacity={0.1} />
            <path
              d={line}
              fill="none"
              stroke={color}
              strokeWidth={MARK.lineWidth}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </g>

          {active !== null && (
            <line
              x1={x(active)}
              y1={PAD_T}
              x2={x(active)}
              y2={PAD_T + plot}
              stroke={CHROME.axis}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          )}

          {/* 端点与峰值加白色描边，压在线上也读得清 */}
          {[peakIdx, lastIdx, ...(active !== null ? [active] : [])].map((i, k) => (
            <circle
              key={`${i}-${k}`}
              cx={x(i)}
              cy={y(points[i]!.value)}
              r={MARK.dotRadius / 2}
              fill={color}
              stroke={CHROME.surface}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>

        {/* 直接标注：只标峰值与最新，其余交给 hover 和表格 */}
        <div className="flex items-center justify-between text-[11px] text-slate-500">
          <span>{points[0]!.day.slice(5)}</span>
          <span className="tabular-nums">
            峰值 {format(points[peakIdx]!.value)}（{points[peakIdx]!.day.slice(5)}）· 最新{' '}
            {format(points[lastIdx]!.value)}
          </span>
          <span>{points[lastIdx]!.day.slice(5)}</span>
        </div>

        {active !== null && (
          <div className="pointer-events-none absolute -top-1 left-1/2 -translate-x-1/2 rounded bg-slate-900 px-1.5 py-0.5 text-[11px] text-white">
            {points[active]!.day.slice(5)} · {format(points[active]!.value)}
          </div>
        )}
      </div>

      {/* ★ tooltip 不能是读到数字的唯一途径 */}
      <button
        type="button"
        onClick={() => setTable((v) => !v)}
        className="mt-0.5 text-[11px] text-slate-400 underline hover:text-slate-600"
      >
        {table ? '收起数据' : '看数据'}
      </button>
      {table && (
        <div className="mt-1 max-h-32 overflow-y-auto">
          <table className="w-full text-[11px]">
            <tbody>
              {points
                .filter((p) => p.value !== 0)
                .map((p) => (
                  <tr key={p.day} className="border-b border-slate-100">
                    <td className="py-0.5 text-slate-500">{p.day}</td>
                    <td className="py-0.5 text-right tabular-nums text-slate-700">
                      {format(p.value)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── 指标卡 ────────────────────────────────────────────────────────────────

/**
 * 单个数字 + 环比。
 *
 * ★ 环比的好坏方向由 `higherIsBetter` 决定，不能看正负号：
 *   前置时间 -20% 是好消息，吞吐 -20% 是坏消息。
 */
export function StatTile({
  label,
  value,
  sub,
  delta,
  higherIsBetter = true,
  hint,
  onClick,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: number | null;
  higherIsBetter?: boolean;
  /** 计算口径。页面文档 §11 要求每个指标都能说清自己怎么算的 */
  hint?: string;
  onClick?: () => void;
}) {
  const good = delta != null && delta !== 0 && (delta > 0) === higherIsBetter;
  const Tag = onClick ? 'button' : 'div';

  return (
    <Tag
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={clsx(
        'min-w-0 flex-1 rounded border border-slate-200 bg-white px-3 py-2 text-left',
        onClick && 'hover:border-slate-300',
      )}
    >
      <div className="flex items-center gap-1">
        <span className="truncate text-[11px] text-slate-500">{label}</span>
        {hint && (
          <span className="cursor-help text-[10px] text-slate-400" title={hint}>
            ⓘ
          </span>
        )}
      </div>
      <div className="mt-0.5 flex items-baseline gap-1.5">
        <span className="text-lg font-semibold text-slate-900">{value}</span>
        {delta != null && (
          <span className={clsx('text-[11px]', good ? 'text-green-700' : 'text-red-700')}>
            {delta > 0 ? '▲' : '▼'} {Math.abs(Math.round(delta * 100))}%
          </span>
        )}
      </div>
      {sub && <p className="mt-0.5 truncate text-[11px] text-slate-400">{sub}</p>}
    </Tag>
  );
}

/** 数据源没接通时的占位。★ 显示 0 会被当成「真的是 0」，那是误导。 */
export function NotWired({ label, why }: { label: string; why: string }) {
  return (
    <div className="min-w-0 flex-1 rounded border border-dashed border-slate-200 px-3 py-2">
      <p className="truncate text-[11px] text-slate-500">{label}</p>
      <p className="mt-0.5 text-sm text-slate-400">未接入</p>
      <p className="mt-0.5 text-[11px] text-slate-400">{why}</p>
    </div>
  );
}
