import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { AssigneeChip, StatusDot, type ActorState } from '../../components/AssigneeChip';
import { HumanGateBadge } from '../../components/badges';
import { QueryBoundary } from '../../components/states';
import { api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { money, statusLabel } from '../../lib/format';
import type { AgentSummary, BoardColumn } from '../../lib/api/types';
import type { CardActions } from '../../features/work-item/BoardCard';

interface Props {
  projectId: string;
  columns: BoardColumn[];
  actions: CardActions;
}

/**
 * Agent 视图（页面文档 05 §5.7）。
 *
 * 本产品特有：Kanban 回答「任务走到哪了」，这个视图回答「谁在忙、谁闲着、谁在反复失败」。
 * 人类泳道和 Agent 泳道并列，因为待决策的人同样是流动的瓶颈 ——
 * 只看 Agent 会漏掉「卡在王强那里两小时」这种最常见的堵点。
 */
export function AgentView({ projectId, columns, actions }: Props) {
  const agents = useQuery({
    queryKey: qk.agents(projectId),
    queryFn: () => api.agents(projectId),
  });

  const cards = columns.flatMap((c) => c.items);
  const humanLanes = buildHumanLanes(cards);

  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
      <QueryBoundary
        query={agents}
        isEmpty={(d) => d.agents.length === 0}
        empty={{
          icon: '🤖',
          message: '本项目还没有可用的 Agent',
          hint: '没有 Agent 时任务只能由人类执行，看板不会自动流动',
          action: { label: '刷新', onClick: () => void agents.refetch() },
        }}
      >
        {(data) =>
          data.agents.map((agent) => <AgentLane key={agent.id} agent={agent} actions={actions} />)
        }
      </QueryBoundary>

      {humanLanes.map((lane) => (
        <section key={lane.owner.id} className="rounded-lg border border-slate-200 bg-white">
          <header className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
            <AssigneeChip actor={{ type: 'human', ...lane.owner }} />
            <span className="text-xs text-slate-500">
              {lane.cards.length} 项待处理
            </span>
            {lane.overdue > 0 && (
              <span className="text-xs font-medium text-red-700">
                ⏰ {lane.overdue} 项已超时
              </span>
            )}
          </header>
          <ul className="divide-y divide-slate-100">
            {lane.cards.map((card) => (
              <li key={card.id}>
                <button
                  type="button"
                  onClick={() => actions.onOpen(card)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-slate-50"
                >
                  <span className="flex-1 truncate">{card.title}</span>
                  {card.humanGate && (
                    <HumanGateBadge
                      gate={card.humanGate}
                      dueInMinutes={card.decisionDueInMinutes}
                    />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function AgentLane({ agent, actions }: { agent: AgentSummary; actions: CardActions }) {
  const failing = agent.items.filter((i) => i.consecutiveFailures > 0);
  const state: ActorState =
    failing.length > 0 ? 'failed' : agent.load > 0 ? 'running' : 'idle';
  const successRate = Number(agent.stats['successRate'] ?? 0);

  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2">
        <AssigneeChip actor={{ type: 'agent', id: agent.id, name: agent.name }} state={state} />
        <StatusDot state={state} />
        <span className="text-xs text-slate-500">
          负载 {agent.load}/{agent.maxConcurrency}
        </span>
        <span className="text-xs text-slate-500">
          成功率 {(successRate * 100).toFixed(0)}%
        </span>
        <span className="ml-auto text-xs tabular-nums text-slate-500">
          累计 {money(agent.todaySpentUsd)}
        </span>
      </header>

      {agent.items.length === 0 ? (
        <p className="px-3 py-2 text-[11px] text-slate-400">空闲中</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {agent.items.map((item) => {
            const pct =
              item.progress && item.progress.total
                ? Math.round((item.progress.step / item.progress.total) * 100)
                : null;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() =>
                    actions.onOpen({ id: item.id } as never)
                  }
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-slate-50"
                >
                  <span className="flex-1 truncate">{item.title}</span>
                  {pct !== null && (
                    <span className="flex items-center gap-1">
                      <span className="h-1 w-16 overflow-hidden rounded-full bg-slate-200">
                        <span className="block h-full bg-agent" style={{ width: `${pct}%` }} />
                      </span>
                      <span className="tabular-nums text-slate-500">{pct}%</span>
                    </span>
                  )}
                  <span
                    className={clsx(
                      'w-20 text-right',
                      item.consecutiveFailures > 0 ? 'text-red-700' : 'text-slate-500',
                    )}
                  >
                    {item.consecutiveFailures > 0
                      ? `❌ 失败 ${item.consecutiveFailures} 次`
                      : statusLabel(item.status)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** 把「等着某个人拍板」的卡片按人聚成泳道 */
function buildHumanLanes(cards: BoardColumn['items']) {
  const lanes = new Map<
    string,
    { owner: { id: string; name: string }; cards: BoardColumn['items']; overdue: number }
  >();

  for (const card of cards) {
    if (!card.humanGate || !card.owner) continue;
    const lane = lanes.get(card.owner.id) ?? { owner: card.owner, cards: [], overdue: 0 };
    lane.cards.push(card);
    if (card.decisionDueInMinutes !== null && card.decisionDueInMinutes < 0) lane.overdue++;
    lanes.set(card.owner.id, lane);
  }

  return [...lanes.values()].sort((a, b) => b.overdue - a.overdue);
}
