import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { CardSkeleton, EmptyState, ErrorState } from '../../components/states';
import { CapabilityPanel } from '../Agents/CapabilityPanel';

/**
 * 集成设置 —— Agent 运行时（页面文档 14 §5.4）。
 *
 * ★ 这一页只做「Agent 运行时」这一块，因为只有它有真实后端：
 *   能力协商与降级矩阵已经在 Agent 协议里实现了。
 *   外部系统对接（Jira / GitHub / Slack、OAuth 授权、双向同步冲突）
 *   一行后端都没有 —— 与其画一套点了没反应的授权按钮，
 *   不如在页面上写清楚「这部分没做」。假的集成页比没有更糟：
 *   它会让人以为数据在同步。
 *
 * ★ 每个运行时先回答一个问题：它现在能不能派任务？
 *   「已配置」和「能用」是两回事 —— 数据库里有一行记录，
 *   不代表当前进程里注册了适配器。这个区别不摊开，
 *   用户会对着一个永远不动的任务查半天。
 */
export function RuntimeSettingsPage() {
  const { projectId } = useParams<{ projectId?: string }>();

  const list = useQuery({ queryKey: qk.runtimes(), queryFn: () => api.runtimes() });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold text-slate-900">集成设置 · Agent 运行时</h1>
          {projectId && (
            <Link
              to={`/projects/${projectId}`}
              className="text-xs text-slate-500 hover:text-slate-700"
            >
              ← 项目总览
            </Link>
          )}
        </div>
        <p className="mt-1 text-[11px] text-slate-500">
          运行时决定了 Agent 实际能做什么。协议缺失的能力会降级，降级后的行为都列在下面
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-3">
        <div className="mx-auto max-w-3xl space-y-3">
          {list.isPending && <CardSkeleton />}
          {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
          {list.data && list.data.runtimes.length === 0 && (
            <EmptyState icon="🔌" message="还没有配置任何 Agent 运行时" />
          )}

          {list.data?.runtimes.map((rt) => (
            <div key={rt.id} className="space-y-1.5">
              <section className="rounded border border-slate-200 bg-white px-3 py-2">
                <div className="flex flex-wrap items-baseline gap-2">
                  <h2 className="text-sm text-slate-900">{rt.name}</h2>
                  <span className="rounded bg-slate-100 px-1 text-[10px] text-slate-600">
                    {rt.kind}
                  </span>
                  <Health registered={rt.registered} reachable={rt.reachable} status={rt.status} />
                  <span className="ml-auto text-[11px] text-slate-400">
                    协议 {rt.protocolVersion ?? '未知'}
                  </span>
                </div>

                <p className="mt-0.5 text-[11px] text-slate-500">
                  {rt.agentCount === 0
                    ? '没有 Agent 使用这个运行时'
                    : `${rt.agentCount} 个 Agent 在用：${rt.agentNames.join('、')}`}
                </p>

                {/* ★ 「配置了但派不出去」是这一页最该喊出来的故障，
                    因为它在任何别的页面上都只表现为「任务不动」 */}
                {!rt.registered && (
                  <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                    当前进程没有注册这个运行时的适配器 —— 派给它的任务不会开始执行
                    {rt.agentCount > 0 && `，${rt.agentCount} 个 Agent 会一直排队`}
                  </p>
                )}
                {rt.registered && !rt.reachable && (
                  <p className="mt-1 rounded bg-red-50 px-2 py-1 text-[11px] text-red-800">
                    适配器已注册但拿不到能力清单，运行时可能不可达
                  </p>
                )}
              </section>

              {rt.capability && <CapabilityPanel report={rt.capability} runtimeName={rt.name} />}
            </div>
          ))}

          {/**
           * ★ 明说没做，而不是画个灰色的占位卡片。
           *   页面文档 14 的大头是外部系统双向同步（含冲突解决），
           *   那需要一整套后端；现在没有，就不假装有。
           */}
          <section className="rounded border border-dashed border-slate-300 bg-white px-3 py-2">
            <h2 className="text-xs font-medium text-slate-700">外部系统对接</h2>
            <p className="mt-0.5 text-[11px] text-slate-500">
              Jira / GitHub / Slack 的授权与双向同步还没有实现（没有后端），
              这里不放占位按钮 —— 一个点了没反应的「连接」按钮，
              会让人以为数据已经在同步了
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

/** 「已配置」和「能用」是两回事，所以这里给的是能不能派任务，不是数据库里的 status */
function Health({
  registered,
  reachable,
  status,
}: {
  registered: boolean;
  reachable: boolean;
  status: string;
}) {
  const usable = registered && reachable && status === 'active';
  return (
    <span className={clsx('text-[11px]', usable ? 'text-green-700' : 'text-amber-700')}>
      ● {usable ? '可派发' : registered ? '不可达' : '未注册'}
      {status !== 'active' && <span className="ml-1 text-slate-400">记录状态 {status}</span>}
    </span>
  );
}
