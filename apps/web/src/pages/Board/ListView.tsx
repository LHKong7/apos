import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { AssigneeChip, actorStateFrom } from '../../components/AssigneeChip';
import { HumanGateBadge } from '../../components/badges';
import { money, relativeTime, riskLabel, statusLabel, typeIcon } from '../../lib/format';
import type { CardActions } from '../../features/work-item/BoardCard';
import type { BoardCard, BoardColumn } from '../../lib/api/types';

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
        <div className="mb-2 flex items-center gap-3 rounded border border-slate-300 bg-white px-3 py-1.5 text-xs">
          <span className="text-slate-600">已选 {selected.size} 项</span>
          <button
            type="button"
            disabled={retriable.length === 0}
            onClick={() => onBulkRetry(retriable)}
            className="rounded bg-slate-900 px-2 py-0.5 text-white disabled:opacity-40"
          >
            批量重试 {retriable.length} 个失败任务
          </button>
          {/* 批量操作前给出影响预估（页面文档 05 §5.8） */}
          {retriable.length > 0 && (
            <span className="text-slate-500">预计消耗 ~{money(estimatedRetryCost)}</span>
          )}
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="ml-auto text-slate-500 underline"
          >
            取消选择
          </button>
        </div>
      )}

      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-slate-50 text-left text-slate-500">
          <tr>
            <th className="w-8 px-2 py-1.5">
              <input
                type="checkbox"
                checked={selected.size > 0 && selected.size === rows.length}
                onChange={(e) =>
                  setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())
                }
                className="accent-slate-900"
              />
            </th>
            <SortHeader label="任务" sortKey="title" sort={sort} onSort={setSort} />
            <SortHeader label="状态" sortKey="status" sort={sort} onSort={setSort} />
            <th className="px-2 py-1.5 font-medium">执行者</th>
            <SortHeader label="风险" sortKey="risk" sort={sort} onSort={setSort} />
            <SortHeader label="成本" sortKey="cost" sort={sort} onSort={setSort} />
            <SortHeader label="更新" sortKey="updatedAt" sort={sort} onSort={setSort} />
          </tr>
        </thead>
        <tbody>
          {rows.map((card) => (
            <tr
              key={card.id}
              onClick={() => actions.onOpen(card)}
              className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
            >
              <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selected.has(card.id)}
                  onChange={() => toggle(card.id)}
                  className="accent-slate-900"
                />
              </td>
              <td className="max-w-xs px-2 py-1.5">
                <span aria-hidden className="mr-1">
                  {typeIcon(card.type)}
                </span>
                <span className="truncate">{card.title}</span>
              </td>
              <td className="px-2 py-1.5">
                {card.humanGate && card.humanGateRef ? (
                  <HumanGateBadge
                    gate={card.humanGate}
                    dueInMinutes={card.decisionDueInMinutes}
                  />
                ) : (
                  <span className="text-slate-600">{statusLabel(card.status)}</span>
                )}
              </td>
              <td className="px-2 py-1.5">
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
              <td className="px-2 py-1.5 text-slate-600">{riskLabel(card.riskLevel)}</td>
              <td className="px-2 py-1.5 tabular-nums text-slate-600">{money(card.cost)}</td>
              <td className="px-2 py-1.5 text-slate-500">{relativeTime(card.updatedAt)}</td>
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
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; desc: boolean };
  onSort: (s: { key: SortKey; desc: boolean }) => void;
}) {
  const active = sort.key === sortKey;
  return (
    <th className="px-2 py-1.5 font-medium">
      <button
        type="button"
        onClick={() => onSort({ key: sortKey, desc: active ? !sort.desc : true })}
        className={clsx('inline-flex items-center gap-0.5', active && 'text-slate-900')}
      >
        {label}
        {active && <span aria-hidden>{sort.desc ? '↓' : '↑'}</span>}
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
