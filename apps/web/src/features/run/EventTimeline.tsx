import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { eventIcon, groupEvents, isNoise, type TimelineEntry } from './group-events';
import { useFollowTail } from './useFollowTail';
import { money } from '../../lib/format';
import type { RunEventRow } from '../../lib/api/types';

interface Props {
  events: RunEventRow[];
  detailed: boolean;
  /** 执行中的 Run 才跟随底部；已结束的应停在用户看的位置 */
  live: boolean;
  onJumpToFailure?: () => void;
}

/**
 * 执行流（页面文档 09 §5.3）。
 *
 * 这是本页的核心区域，回答「它到底做了什么」。
 * 简明模式给「发生了什么」的可读叙述，详细模式给排障需要的原始数据 ——
 * 两者的差别不是字段多少，是叙事粒度。
 */
export function EventTimeline({ events, detailed, live, onJumpToFailure }: Props) {
  const entries = useMemo(() => {
    const visible = detailed ? events : events.filter((e) => !isNoise(e.type));
    return groupEvents(visible, !detailed);
  }, [events, detailed]);

  const { ref, unseen, scrollToBottom, onScroll } = useFollowTail<HTMLDivElement>(
    live ? entries.length : 0,
  );

  const failureIndex = entries.findIndex((e) => e.type === 'error');

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {failureIndex > -1 && onJumpToFailure && (
        <button
          type="button"
          onClick={onJumpToFailure}
          className="mb-1 self-start text-[11px] text-red-700 underline"
        >
          跳到失败点 ↓
        </button>
      )}

      <div ref={ref} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto pr-1">
        <ol className="space-y-0">
          {entries.map((entry, i) => (
            <Entry
              key={entry.seq}
              entry={entry}
              detailed={detailed}
              last={i === entries.length - 1}
            />
          ))}
        </ol>

        {entries.length === 0 && (
          <p className="py-6 text-center text-xs text-slate-400">
            {detailed ? '还没有事件' : '还没有里程碑事件，切到详细模式看全部'}
          </p>
        )}

        {live && (
          <div className="flex items-center gap-2 py-2 pl-1 text-xs text-slate-500">
            <span className="inline-block h-1.5 w-1.5 animate-breathe rounded-full bg-emerald-500" />
            执行中…
          </div>
        )}
      </div>

      {/* ★ 不自动滚动去追新事件，改为提示（页面文档 09 §5.3） */}
      {unseen > 0 && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-slate-900 px-3 py-1 text-[11px] text-white shadow-lg"
        >
          ↓ {unseen} 条新事件
        </button>
      )}
    </div>
  );
}

function Entry({
  entry,
  detailed,
  last,
}: {
  entry: TimelineEntry;
  detailed: boolean;
  last: boolean;
}) {
  const [open, setOpen] = useState(false);
  const expandable = detailed || entry.members.length > 1 || hasDetail(entry);
  const isError = entry.type === 'error';

  return (
    <li className="relative flex gap-2 pb-2 pl-1" id={isError ? 'run-failure-point' : undefined}>
      {/* 时间轴竖线 */}
      {!last && <span aria-hidden className="absolute left-[13px] top-5 bottom-0 w-px bg-slate-200" />}

      <span
        aria-hidden
        className={clsx(
          'relative z-10 mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px]',
          isError ? 'bg-red-100' : 'bg-slate-100',
        )}
      >
        {eventIcon(entry.type)}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <time className="shrink-0 font-mono text-[10px] tabular-nums text-slate-400">
            {formatTime(entry.ts)}
          </time>
          <p
            className={clsx(
              'min-w-0 flex-1 break-words text-xs leading-5',
              isError ? 'font-medium text-red-700' : 'text-slate-700',
            )}
          >
            {entry.summary}
          </p>
          {entry.costDelta && Number(entry.costDelta) !== 0 && (
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-slate-400">
              {money(entry.costDelta)}
            </span>
          )}
          {expandable && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="shrink-0 text-[10px] text-slate-400 hover:text-slate-600"
            >
              {open ? '收起' : '展开'}
            </button>
          )}
        </div>

        {open && (
          <div className="mt-1 space-y-1">
            {entry.members.map((m) => (
              <Detail key={m.seq} row={m} showSummary={entry.members.length > 1} />
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

/** 单条事件的原始内容。超长内容折叠，避免一个工具返回撑爆整页 */
function Detail({ row, showSummary }: { row: RunEventRow; showSummary: boolean }) {
  const text = JSON.stringify(row.payload ?? {}, null, 2);
  const truncated = text.length > 4000;

  return (
    <div className="rounded bg-slate-50 p-1.5">
      {showSummary && (
        <p className="mb-1 font-mono text-[10px] text-slate-500">
          #{row.seq} {row.summary}
        </p>
      )}
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-[10px] leading-4 text-slate-600">
        {truncated ? `${text.slice(0, 4000)}\n…（已截断，共 ${text.length} 字符）` : text}
      </pre>
    </div>
  );
}

function hasDetail(entry: TimelineEntry): boolean {
  const payload = entry.payload;
  if (!payload) return false;
  return Object.keys(payload).length > 0;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
