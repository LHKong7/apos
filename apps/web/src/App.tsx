import { useEffect } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from './lib/api/client';
import { qk } from './lib/query/keys';
import { useAuthStore } from './stores/auth';
import { ProjectListPage } from './pages/ProjectList';
import { BoardPage } from './pages/Board';
import { RunDetailPage } from './pages/RunDetail';
import { ConnectionBanner } from './components/ConnectionBanner';

export function App() {
  const setUsers = useAuthStore((s) => s.setUsers);
  const users = useQuery({ queryKey: qk.users(), queryFn: api.users, staleTime: Infinity });

  useEffect(() => {
    if (users.data) setUsers(users.data.users);
  }, [users.data, setUsers]);

  return (
    <div className="flex min-h-screen flex-col">
      <TopNav />
      <ConnectionBanner />
      <main className="flex min-h-0 flex-1 flex-col">
        <Routes>
          <Route path="/" element={<ProjectListPage />} />
          <Route path="/projects/:projectId/board" element={<BoardPage />} />
          <Route path="/runs/:runId" element={<RunDetailPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
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
