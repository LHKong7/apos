import { useEffect } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { api } from './lib/api/client';
import { qk } from './lib/query/keys';
import { useAuthStore } from './stores/auth';
import { ProjectListPage } from './pages/ProjectList';
import { OverviewPage } from './pages/Overview';
import { BoardPage } from './pages/Board';
import { RunDetailPage } from './pages/RunDetail';
import { GraphPage } from './pages/Graph';
import { AnalyticsPage } from './pages/Analytics';
import { PoliciesPage } from './pages/Policies';
import { RequirementListPage } from './pages/Requirement/List';
import { RequirementPage } from './pages/Requirement';
import { PlanPage } from './pages/Plan';
import { AgentListPage } from './pages/Agents';
import { AgentDetailPage } from './pages/Agents/Detail';
import { DecisionsPage } from './pages/Decisions';
import { IntegrationsPage } from './pages/Settings/Integrations';
import { ConnectionBanner } from './components/ConnectionBanner';

/**
 * ★ 外层用 h-screen 而不是 min-h-screen。
 *
 *   min-height 不构成「确定高度」，下面所有 flex-1 都没法据此分配，
 *   会退化成内容高度。执行图的画布因此塌成一百多像素，
 *   整张图被缩到 17% 摆在正中间 —— 看起来像渲染坏了，实际数据完全正确。
 *   页面本身不滚动，内部区域各自滚。
 */
export function App() {
  const setUsers = useAuthStore((s) => s.setUsers);
  const userId = useAuthStore((s) => s.userId);
  const users = useQuery({ queryKey: qk.users(), queryFn: api.users, staleTime: Infinity });

  useEffect(() => {
    if (users.data) setUsers(users.data.users);
  }, [users.data, setUsers]);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopNav />
      <ConnectionBanner />
      <main className="flex min-h-0 flex-1 flex-col">
        {/*
          ★ 身份没落定之前不渲染任何页面。

            服务端按项目成员关系鉴权（09-security §2.1 第②层），
            没有 X-User-Id 的请求一律拒。而首次访问时 localStorage 里没有身份，
            /users 回来之前发出的请求都是匿名的 —— 不挡住的话，
            用户第一眼看到的是一屏「加载失败」，刷新一下又好了，
            这种偶发失败最难被报告清楚。
        */}
        {!userId ? (
          <IdentityGate error={users.error} />
        ) : (
        <Routes>
          <Route path="/" element={<ProjectListPage />} />
          <Route path="/projects/:projectId" element={<OverviewPage />} />
          <Route path="/projects/:projectId/board" element={<BoardPage />} />
          <Route path="/projects/:projectId/graph" element={<GraphPage />} />
          <Route path="/projects/:projectId/analytics" element={<AnalyticsPage />} />
          <Route path="/projects/:projectId/agents" element={<AgentListPage />} />
          <Route path="/projects/:projectId/agents/:agentId" element={<AgentDetailPage />} />
          <Route path="/projects/:projectId/decisions" element={<DecisionsPage />} />
          <Route path="/projects/:projectId/settings/policies" element={<PoliciesPage />} />
          <Route path="/projects/:projectId/settings/integrations" element={<IntegrationsPage />} />
          {/* 运行时曾经是单独一页；页面文档 14 把它归为集成的一类，旧链接直接转过去 */}
          <Route
            path="/projects/:projectId/settings/runtimes"
            element={<RuntimesRedirect />}
          />
          <Route path="/projects/:projectId/requirements" element={<RequirementListPage />} />
          <Route path="/projects/:projectId/requirements/:reqId" element={<RequirementPage />} />
          <Route path="/projects/:projectId/plans/:planId" element={<PlanPage />} />
          <Route path="/agents/:agentId" element={<AgentDetailPage />} />
          <Route path="/decisions" element={<DecisionsPage />} />
          <Route path="/runs/:runId" element={<RunDetailPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        )}
      </main>
    </div>
  );
}

/** 身份就绪之前的占位。用户几乎不会看到它 —— 除非 /users 拿不到 */
function IdentityGate({ error }: { error: unknown }) {
  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-md text-center">
          <p className="text-sm text-slate-800">拿不到可用身份，页面无法加载</p>
          <p className="mt-1 text-xs text-slate-500">
            后端可能没起来。确认 API 可达后刷新重试。
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <p className="text-xs text-slate-400">正在确认身份…</p>
    </div>
  );
}

/** 旧的运行时设置页并入集成设置，保留跳转 */
function RuntimesRedirect() {
  const { projectId } = useParams<{ projectId: string }>();
  return <Navigate to={`/projects/${projectId}/settings/integrations`} replace />;
}

function TopNav() {
  const navigate = useNavigate();
  const { user, users, switchUser } = useAuthStore();

  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 py-2">
      <button
        type="button"
        onClick={() => navigate('/')}
        className="text-sm font-semibold tracking-tight text-slate-900"
      >
        Autonomous Project OS
      </button>

      <DecisionBadge />

      <div className="ml-auto flex items-center gap-2">
        <label className="text-[11px] text-slate-500" htmlFor="user-switch">
          当前身份
        </label>
        <select
          id="user-switch"
          value={user?.id ?? ''}
          onChange={(e) => switchUser(e.target.value)}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
        >
          {users.length === 0 && <option value="">加载中…</option>}
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}（{u.orgRole}）
            </option>
          ))}
        </select>
      </div>
    </header>
  );
}

/**
 * 顶栏的待办决策数。
 *
 * ★ 产品那句「你不需要盯着 Agent，需要你的时候我会来找你」，
 *   在界面上就是这一个数字：它必须在每一页都看得见，而且要自己变。
 *   把它藏在决策中心页里，等于要求用户定期去查有没有人找他 ——
 *   那就正好是这个产品声称要消灭的行为。
 *
 * ★ 数字来自 scope=mine，包含未分派的决策（后端口径）。
 *   只算「指名给我的」会让无人认领的决策永远静默，
 *   而无人认领恰恰是最该被看见的一类。
 */
function DecisionBadge() {
  const userId = useAuthStore((s) => s.userId);
  const inbox = useQuery({
    queryKey: qk.decisionInbox('mine'),
    queryFn: () => api.decisionInbox('mine'),
    enabled: Boolean(userId),
  });

  const stats = inbox.data?.stats;
  if (!stats || stats.mine === 0) return null;

  return (
    <Link
      to="/decisions"
      className={clsx(
        'rounded px-2 py-0.5 text-xs',
        stats.overdue > 0
          ? 'bg-red-50 text-red-700 hover:bg-red-100'
          : 'bg-amber-50 text-amber-800 hover:bg-amber-100',
      )}
    >
      ⏰ {stats.mine} 条待你决策
      {stats.overdue > 0 && <span className="ml-1 font-medium">（{stats.overdue} 条已超时）</span>}
    </Link>
  );
}
