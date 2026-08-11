import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { AssigneeChip, actorStateFrom } from '../../components/AssigneeChip';
import { HumanGateBadge } from '../../components/badges';
import { money, relativeTime, riskLabel, statusLabel, typeIcon } from '../../lib/format';
import type { CardActions } from '../../features/work-item/BoardCard';
import type { BoardCard, BoardColumn } from '../../lib/api/types';
import { Button } from '@/components/ui/button';

type SortKey = 'title' | 'status' | 'risk' | 'cost' | 'updatedAt';

const RISK_ORDER: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 };

interface Props {
  columns: BoardColumn[];
  actions: CardActions;
  onBulkRetry: (cards: BoardCard[]) => void;
}

/**
 * List 视图（页面文档 05 §5.8）。
 *
 * 存在的理由是批量操作：看板一次处理一张卡，
 * 但「把今天失败的 3 个任务一起重试」在看板上要点九次。
 */
export function ListView({ columns, actions, onBulkRetry }: Props) {
  const all = useMemo(() => columns.flatMap((c) => c.items), [columns]);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: 'updatedAt',
    desc: true,
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const rows = useMemo(() => sortRows(all, sort), [all, sort]);
  const selectedCards = rows.filter((r) => selected.has(r.id));
  const retriable = selectedCards.filter((c) => c.status === 'failed');
  const estimatedRetryCost = retriable.reduce(
    (sum, c) => sum + Number(c.estimatedCost ?? 2),
    0,
  );

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      {selected.size > 0 && (
        <div className="sticky top-0 z-20 mb-2 flex items-center gap-3 rounded-lg border border-brand/30 px-3 py-2 text-xs shadow-md glass-strong">
          <span className="font-medium text-slate-800">已选 {selected.size} 项</span>
          <Button variant="neutral"
            disabled={retriable.length === 0}
            onClick={() => onBulkRetry(retriable)}>
            批量重试 {retriable.length} 个失败任务
          </Button>
          {/* 批量操作前给出影响预估（页面文档 05 §5.8） */}
          {retriable.length > 0 && (
            <span className="text-slate-500">预计消耗 ~{money(estimatedRetryCost)}</span>
          )}
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="ml-auto text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-800"
          >
            取消选择
          </button>
        </div>
      )}

      {/*
        ★ 行高从 py-1.5 放到 py-2.5，并把除任务名之外的列全部 whitespace-nowrap。
          此前每一行都贴着上下两行，扫到第五行就串行了 —— 而这个视图存在的
          理由恰恰是「一次看很多行、挑出要批量处理的那几行」。
      */}
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-slate-50 text-left text-slate-500 shadow-[0_1px_0_0_rgb(var(--c-slate-200))]">
          <tr>
            <th className="w-9 px-3 py-2">
              <input
                type="checkbox"
                aria-label="全选"
                checked={selected.size > 0 && selected.size === rows.length}
                onChange={(e) =>
                  setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())
                }
                className="h-3.5 w-3.5 accent-brand"
              />
            </th>
            <SortHeader label="任务" sortKey="title" sort={sort} onSort={setSort} />
            <SortHeader label="状态" sortKey="status" sort={sort} onSort={setSort} />
            <th className="px-3 py-2 font-medium">执行者</th>
            <SortHeader label="风险" sortKey="risk" sort={sort} onSort={setSort} />
            <SortHeader label="成本" sortKey="cost" sort={sort} onSort={setSort} align="right" />
            <SortHeader label="更新" sortKey="updatedAt" sort={sort} onSort={setSort} />
          </tr>
        </thead>
        <tbody>
          {rows.map((card) => (
            <tr
              key={card.id}
              onClick={() => actions.onOpen(card)}
              className={clsx(
                'cursor-pointer border-t border-slate-200/60 transition-colors hover:bg-slate-100/60',
                selected.has(card.id) && 'bg-brand/5',
              )}
            >
              <td className="px-3 py-2.5 align-middle" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  aria-label={`选择 ${card.title}`}
                  checked={selected.has(card.id)}
                  onChange={() => toggle(card.id)}
                  className="h-3.5 w-3.5 accent-brand"
                />
              </td>
              {/*
                ★ w-full + max-w-0：表格里让某一列「吃掉剩余宽度并省略号截断」
                  只有这一种写法。此前是 max-w-xs 加一个 inline 的 truncate ——
                  truncate 的 overflow 对 inline 元素不生效，长标题照样把整张表撑宽。
              */}
              <td className="w-full max-w-0 px-3 py-2.5 align-middle">
                <div className="flex items-center gap-1.5">
                  <span aria-hidden className="shrink-0">
                    {typeIcon(card.type)}
                  </span>
                  <span className="truncate text-slate-800" title={card.title}>
                    {card.title}
                  </span>
                </div>
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 align-middle">
                {card.humanGate && card.humanGateRef ? (
                  <HumanGateBadge gate={card.humanGate} dueInMinutes={card.decisionDueInMinutes} />
                ) : (
                  <span className="text-slate-600">{statusLabel(card.status)}</span>
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 align-middle">
                {card.executor ? (
                  <AssigneeChip
                    actor={card.executor}
                    state={actorStateFrom(card.status, card.runStatus)}
                    size="sm"
                  />
                ) : (
                  <span className="text-slate-400">未分配</span>
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 align-middle text-slate-600">
                {riskLabel(card.riskLevel)}
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 text-right align-middle font-mono tabular-nums text-slate-600">
                {money(card.cost)}
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 align-middle text-slate-500">
                {relativeTime(card.updatedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  align = 'left',
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; desc: boolean };
  onSort: (s: { key: SortKey; desc: boolean }) => void;
  align?: 'left' | 'right';
}) {
  const active = sort.key === sortKey;
  return (
    <th
      className={clsx(
        'whitespace-nowrap px-3 py-2 font-medium',
        align === 'right' && 'text-right',
      )}
    >
      <button
        type="button"
        onClick={() => onSort({ key: sortKey, desc: active ? !sort.desc : true })}
        className={clsx(
          'inline-flex items-center gap-0.5 rounded px-0.5 hover:text-slate-900',
          active && 'text-slate-900',
        )}
      >
        {label}
        {/* 箭头位置固定占宽，否则每次换排序列整排表头都会横向抖一下 */}
        <span aria-hidden className={clsx('w-2 text-[10px]', !active && 'opacity-0')}>
          {sort.desc ? '↓' : '↑'}
        </span>
      </button>
    </th>
  );
}

function sortRows(rows: BoardCard[], sort: { key: SortKey; desc: boolean }): BoardCard[] {
  const dir = sort.desc ? -1 : 1;
  return [...rows].sort((a, b) => {
    switch (sort.key) {
      case 'title':
        return a.title.localeCompare(b.title, 'zh') * dir;
      case 'status':
        return a.status.localeCompare(b.status) * dir;
      case 'risk':
        return ((RISK_ORDER[a.riskLevel] ?? 0) - (RISK_ORDER[b.riskLevel] ?? 0)) * dir;
      case 'cost':
        return (Number(a.cost) - Number(b.cost)) * dir;
      case 'updatedAt':
        return (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()) * dir;
    }
  });
}
