import { useT } from '../../lib/i18n';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { AssigneeChip, type ActorState } from '../../components/AssigneeChip';
import { HumanGateBadge } from '../../components/badges';
import { QueryBoundary } from '../../components/states';
import { api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { statusLabel, tokens } from '../../lib/format';
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
  const t = useT();
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
          message: t('agentView.empty'),
          hint: t('agentView.emptyHint'),
          action: { label: t('agentView.refresh'), onClick: () => void agents.refetch() },
        }}
      >
        {(data) =>
          data.agents.map((agent) => <AgentLane key={agent.id} agent={agent} actions={actions} />)
        }
      </QueryBoundary>

      {humanLanes.map((lane) => (
        <section
          key={lane.owner.id}
          className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
        >
          <header className="flex items-center gap-2.5 border-b border-slate-200/70 bg-slate-100/40 px-3 py-2.5">
            <AssigneeChip actor={{ type: 'human', ...lane.owner }} />
            <span className="text-xs tabular-nums text-slate-500">
              {t('agentView.pendingCount', { count: lane.cards.length })}
            </span>
            {lane.overdue > 0 && (
              <span className="rounded-full border border-red-300/50 bg-red-50 px-2 py-0.5 text-[11px] font-medium tabular-nums text-red-700">
                {t('agentView.overdueCount', { count: lane.overdue })}
              </span>
            )}
          </header>
          <ul className="divide-y divide-slate-200/60">
            {lane.cards.map((card) => (
              <li key={card.id}>
                <button
                  type="button"
                  onClick={() => actions.onOpen(card)}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-xs transition-colors hover:bg-slate-100/60"
                >
                  <span className="min-w-0 flex-1 truncate text-slate-700">{card.title}</span>
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
  const t = useT();
  const failing = agent.items.filter((i) => i.consecutiveFailures > 0);
  const state: ActorState =
    failing.length > 0 ? 'failed' : agent.load > 0 ? 'running' : 'idle';
  const successRate = Number(agent.stats['successRate'] ?? 0);

  const overloaded = agent.maxConcurrency > 0 && agent.load >= agent.maxConcurrency;

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      {/*
        ★ 这里此前画了两个一模一样的状态点：AssigneeChip 内部给 Agent 带一个，
          外面又跟了一个 StatusDot。在一条本来就窄的表头里，重复的点是纯噪声。
        ★ 三项指标改成「值大、单位小」并用竖线分组，扫的时候先读到数字。
      */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-slate-200/70 bg-slate-100/40 px-3 py-2.5">
        <AssigneeChip actor={{ type: 'agent', id: agent.id, name: agent.name }} state={state} />

        <span className="flex items-center gap-1 text-xs">
          <span className="text-slate-400">{t('agentView.load')}</span>
          <span
            className={clsx(
              'tabular-nums',
              overloaded ? 'font-medium text-orange-600' : 'text-slate-700',
            )}
            title={overloaded ? t('agentView.overloaded') : undefined}
          >
            {agent.load}/{agent.maxConcurrency}
          </span>
        </span>

        <span aria-hidden className="h-3 w-px bg-slate-200" />

        <span className="flex items-center gap-1 text-xs">
          <span className="text-slate-400">{t('agentView.successRate')}</span>
          <span
            className={clsx(
              'tabular-nums',
              successRate < 0.6 ? 'font-medium text-red-700' : 'text-slate-700',
            )}
          >
            {(successRate * 100).toFixed(0)}%
          </span>
        </span>

        <span className="ml-auto flex items-center gap-1 text-xs">
          <span className="text-slate-400">{t('agentView.cumulative')}</span>
          <span className="font-mono tabular-nums text-slate-700">
            {tokens(agent.todayTokens)}
          </span>
        </span>
      </header>

      {agent.items.length === 0 ? (
        <p className="px-3 py-3 text-[11px] text-slate-400">{t('agentView.idle')}</p>
      ) : (
        <ul className="divide-y divide-slate-200/60">
          {agent.items.map((item) => {
            const pct =
              item.progress && item.progress.total
                ? Math.round((item.progress.step / item.progress.total) * 100)
                : null;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => actions.onOpen({ id: item.id } as never)}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-xs transition-colors hover:bg-slate-100/60"
                >
                  <span className="min-w-0 flex-1 truncate text-slate-700">{item.title}</span>
                  {pct !== null && (
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span className="h-1 w-16 overflow-hidden rounded-full bg-slate-200">
                        <span
                          className="block h-full rounded-full bg-gradient-to-r from-agent/70 to-agent"
                          style={{ width: `${pct}%` }}
                        />
                      </span>
                      <span className="w-8 text-right tabular-nums text-slate-500">{pct}%</span>
                    </span>
                  )}
                  <span
                    className={clsx(
                      'w-24 shrink-0 text-right',
                      item.consecutiveFailures > 0 ? 'font-medium text-red-700' : 'text-slate-500',
                    )}
                  >
                    {item.consecutiveFailures > 0
                      ? t('agentView.failedTimes', { count: item.consecutiveFailures })
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
