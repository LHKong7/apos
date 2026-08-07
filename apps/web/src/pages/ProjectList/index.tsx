import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { QueryBoundary } from '../../components/states';
import { money, relativeTime } from '../../lib/format';

const AUTONOMY_LABELS: Record<string, string> = {
  human_led: '人主导',
  agent_led_approval: 'Agent 主导 + 人审批',
  agent_autonomous: 'Agent 自主',
};

export function ProjectListPage() {
  const projects = useQuery({ queryKey: qk.projects(), queryFn: api.projects });

  return (
    <div className="mx-auto w-full max-w-4xl p-6">
      <h1 className="mb-4 text-lg font-semibold text-slate-900">项目</h1>

      <QueryBoundary
        query={projects}
        isEmpty={(d) => d.projects.length === 0}
        empty={{
          icon: '📁',
          message: '还没有项目',
          hint: '先跑一遍 pnpm --filter @apos/api seed 造一份演示数据',
          action: { label: '刷新', onClick: () => void projects.refetch() },
        }}
      >
        {(data) => (
          <ul className="space-y-2">
            {data.projects.map((p) => (
              <li key={p.id}>
                {/* 进项目先到总览 —— 「现在什么情况、要不要我管」比一屏卡片先回答 */}
                <Link
                  to={`/projects/${p.id}`}
                  className="flex items-center gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3 hover:border-slate-300 hover:shadow-sm"
                >
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-sm font-medium text-slate-900">{p.name}</h2>
                    {p.goal && (
                      <p className="mt-0.5 truncate text-xs text-slate-500">{p.goal}</p>
                    )}
                  </div>
                  <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                    {AUTONOMY_LABELS[p.autonomyLevel] ?? p.autonomyLevel}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-slate-500">
                    {money(p.costSpent)}
                    {p.budgetAmount && ` / ${money(p.budgetAmount)}`}
                  </span>
                  <span className="shrink-0 text-[11px] text-slate-400">
                    {relativeTime(p.updatedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
    </div>
  );
}
