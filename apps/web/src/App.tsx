import { useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { api, ApiError } from './lib/api/client';
import { qk } from './lib/query/keys';
import { useAuthStore } from './stores/auth';
import { useOrgStore } from './stores/org';
import { Modal } from './features/work-item/ManualMoveDialog';
import { LoginPage } from './pages/Login';
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
import { AgentConfigPage } from './pages/Settings/AgentConfig';
import { MembersPage } from './pages/Settings/Members';
import { AccountsPage } from './pages/Settings/Accounts';
import { RolesPage } from './pages/Settings/Roles';
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
  const token = useAuthStore((s) => s.token);
  const resolving = useAuthStore((s) => s.resolving);
  const setUser = useAuthStore((s) => s.setUser);
  const signOut = useAuthStore((s) => s.signOut);

  /**
   * ★★ 拿着令牌先问一次「我是谁」。
   *
   *   localStorage 里的令牌可能已经过期、可能是被删掉的账号的。
   *   不先验一次就渲染的话，用户看到的是一整屏各自失败的组件，
   *   而真正的原因（该重新登录了）一个字都没写在页面上。
   */
  const me = useQuery({
    queryKey: qk.me(),
    queryFn: api.me,
    enabled: Boolean(token),
    retry: false,
    staleTime: Infinity,
  });

  const setOrganizations = useOrgStore((s) => s.setOrganizations);
  const adoptServerOrg = useOrgStore((s) => s.adoptServerOrg);
  const currentOrgId = useOrgStore((s) => s.orgId);

  /**
   * ★★ 浏览器记着的 orgId 可能已经失效（组织被删、人被移出、库被重建过），
   *   而它会被塞进每个请求的 X-Org-Id，让那些请求全部 404。
   *   `/auth/me` 是唯一不受影响的那条（服务端对它宽容，见 rbac.ts），
   *   所以拿它回来的 currentOrgId 纠正本地那个。
   *
   * ★★ 纠正**完成之前不能渲染任何页面**。
   *
   *   这不是保守：子组件的 effect 比父组件先跑，看板那几个查询会赶在
   *   这次纠正之前带着失效的 orgId 发出去。而 invalidateQueries 对
   *   **正在飞行中**的请求不起作用 —— 它们随后带着 404 落地，就停在那儿了，
   *   表现是看板永远停在骨架屏，且再也不会自己恢复。
   *
   * ★ 本地那个有效时，服务端回的就是它自己，`orgSynced` 首次渲染即为真，
   *   不会多等一帧。
   */
  const orgSynced = Boolean(me.data) && currentOrgId === me.data?.currentOrgId;

  const orgs = useQuery({
    queryKey: qk.organizations(),
    queryFn: api.organizations,
    enabled: Boolean(token) && orgSynced,
  });

  useEffect(() => {
    if (!me.data) return;
    setUser(me.data.user);
    adoptServerOrg(me.data.currentOrgId);
  }, [me.data, setUser, adoptServerOrg]);

  /**
   * ★ 令牌被服务端拒了就当场退出登录。
   *   留着一张废令牌的表现是「每个页面都在报错」，而不是「请重新登录」。
   */
  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) signOut();
  }, [me.error, signOut]);

  useEffect(() => {
    if (orgs.data) setOrganizations(orgs.data.organizations, orgs.data.currentOrgId);
  }, [orgs.data, setOrganizations]);

  if (!token) return <LoginPage />;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopNav />
      <ConnectionBanner />
      <main className="flex min-h-0 flex-1 flex-col">
        {/*
          ★ 身份确认之前不渲染任何页面。

            服务端按项目成员关系鉴权（09-security §2.1 第②层）。
            /auth/me 回来之前就渲染的话，用户第一眼看到的是一屏
            「加载失败」，刷新一下又好了 —— 这种偶发失败最难被报告清楚。
        */}
        {!orgSynced ? (
          <IdentityGate error={resolving ? null : me.error} />
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
          <Route path="/projects/:projectId/settings/agents" element={<AgentConfigPage />} />
          <Route path="/projects/:projectId/settings/members" element={<MembersPage />} />
          <Route path="/projects/:projectId/settings/accounts" element={<AccountsPage />} />
          <Route path="/projects/:projectId/settings/roles" element={<RolesPage />} />
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

/** 身份就绪之前的占位。用户几乎不会看到它 —— 除非 /auth/me 拿不到 */
function IdentityGate({ error }: { error: unknown }) {
  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-md text-center">
          <p className="text-sm text-slate-800">确认不了当前身份，页面无法加载</p>
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
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);

  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 py-2">
      <button
        type="button"
        onClick={() => navigate('/')}
        className="text-sm font-semibold tracking-tight text-slate-900"
      >
        Autonomous Project OS
      </button>

      <OrgSwitcher />

      <DecisionBadge />

      {/*
        ★ 此前这里是一个身份下拉框，选中谁就是谁。那是 X-User-Id 时代的
          遗物 —— 一个自助改名的界面。现在身份由登录决定，
          换人看只能退出再登录，这也正是它本来该有的样子。
      */}
      <div className="ml-auto flex items-center gap-2">
        <span className="text-xs text-slate-600" title={user?.email}>
          {user?.name ?? '…'}
        </span>
        <button
          type="button"
          onClick={signOut}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
        >
          退出登录
        </button>
      </div>
    </header>
  );
}

/**
 * 组织切换器。
 *
 * ★★ 和身份切换器分开放，因为两者正交：同一个人在 A 组织是管理员、
 *   在 B 组织是普通成员。合成一个下拉框的话，「切身份」会顺手把组织
 *   也改掉 —— 用户看到的是「我只换了个人，项目全没了」。
 *
 * ★ 切完要跳回项目列表：当前 URL 里的 projectId 属于上一个组织，
 *   留在原地的表现是一屏 404，而用户刚做的动作是"换个组织看看"。
 */
function OrgSwitcher() {
  const navigate = useNavigate();
  const { org, orgId, organizations, switchOrg } = useOrgStore();
  const [creating, setCreating] = useState(false);

  if (organizations.length === 0) return null;

  return (
    <>
      <div className="flex items-center gap-1.5 border-l border-slate-200 pl-3">
        <span className="text-[11px] text-slate-400">组织</span>
        <select
          aria-label="切换组织"
          value={orgId ?? ''}
          onChange={(e) => {
            if (e.target.value === '__new__') {
              setCreating(true);
              return;
            }
            switchOrg(e.target.value);
            navigate('/');
          }}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
        >
          {organizations.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
          <option value="__new__">+ 新建组织…</option>
        </select>
        {org && (
          <code className="text-[10px] text-slate-400">{org.slug}</code>
        )}
      </div>
      {creating && <CreateOrgModal onClose={() => setCreating(false)} />}
    </>
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

/**
 * 建组织。
 *
 * ★★ 这是 Plane 的 Workspace 在这里的对应物。在此之前组织只能由
 *   seed 脚本造出来 —— 于是「多租户」只在数据库层面成立。
 *
 * ★ slug 留空就按名字推（中文名回落到 org-xxxx）。要求用户先想一个
 *   英文短名，是把实现细节变成了他的问题。
 */
function CreateOrgModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const qc = useQueryClient();
  const switchOrg = useOrgStore((s) => s.switchOrg);
  const navigate = useNavigate();

  const create = useMutation({
    mutationFn: () =>
      api.createOrganization({ name: name.trim(), ...(slug.trim() ? { slug: slug.trim() } : {}) }),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: qk.organizations() });
      // ★ 建完直接切过去 —— 建了却停在原来的组织，是让用户再点一次
      switchOrg(res.organization.id);
      navigate('/');
      onClose();
    },
  });

  return (
    <Modal onClose={onClose}>
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">新建组织</h2>
        <p className="text-[11px] text-slate-500">
          组织是一切数据的顶层容器：项目、Agent、代码仓库、成员都属于某一个组织，
          彼此之间完全隔离。
        </p>

        <label className="block">
          <span className="text-xs font-medium text-slate-700">组织名</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme 科技"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-slate-700">
            slug
            <span className="ml-1 font-normal text-slate-400">选填</span>
          </span>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder={slugPreview(name)}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 font-mono text-xs"
          />
          <p className="mt-1 text-[11px] text-slate-500">
            出现在链接里，全局唯一。留空按组织名推断。
          </p>
        </label>

        {create.error instanceof ApiError && (
          <p className="text-xs text-rose-600">{create.error.message}</p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-slate-300 px-3 py-1.5 text-xs"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!name.trim() || create.isPending}
            onClick={() => create.mutate()}
            className="rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {create.isPending ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** 和服务端 slugify 同一套判据；这里只用于**提示**，真正生效的是服务端算的那份 */
function slugPreview(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'org-xxxxxxxx';
}
