import { useEffect, useState } from 'react';
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
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
import { WorkspaceSourcesPage } from './pages/Settings/WorkspaceSources';
import { MembersPage } from './pages/Settings/Members';
import { AccountsPage } from './pages/Settings/Accounts';
import { RolesPage } from './pages/Settings/Roles';
import { ConnectionBanner } from './components/ConnectionBanner';
import { BrandMark } from './components/BrandMark';
import { ProjectSidebar } from './components/ProjectSidebar';
import { useThemeStore } from './stores/theme';
import { useLocaleStore, useT } from './lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

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
  /**
   * ★★ 订阅语言，并把它当成内容区的 key —— 切换语言时整棵树重挂。
   *
   *   `lib/format` 里那些格式化函数（statusLabel / eventLabel / relativeTime）
   *   是**普通函数**，不是 hook：它们取不到订阅，切了语言不会自己重算。
   *   而它们散在几十个组件里，逐个改成 hook 是一次大范围重构。
   *
   *   重挂是钝但确定的办法：语言切换是低频的显式动作，丢掉瞬时 UI 状态
   *   （展开的面板、输入到一半的框）在这个动作下是可接受的，而「切了语言
   *   有几处还是旧的」不可接受 —— 后者会让人以为翻译漏了。
   *
   *   Formatters in lib/format are plain functions, not hooks, so they cannot
   *   subscribe to the locale. Remounting on switch is blunt but certain;
   *   a partial switch would read as missing translations.
   */
  const locale = useLocaleStore((s) => s.locale);
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
      {/*
        ★ 侧栏和内容并排，所以这一层是 flex-row。
        ★ 内容列必须 min-w-0：看板整体横滚靠的是子元素 overflow-x-auto，
          而 flex 子项默认 min-width:auto 会被内容撑开 —— 少了它，
          横滚会跑到整个页面上去，连顶栏和侧栏一起滚走。
      */}
      <main key={locale} className="flex min-h-0 flex-1">
        {orgSynced && <ProjectSidebar />}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
          {/*
            ★ 存储目标曾经是 Agent 配置里的一个标签页，没有自己的 URL ——
              所以这里不需要旧链接转发：那个标签是 useState，从来没有人
              能收藏或分享它。
          */}
          {/*
            ★ 路由沿用 /settings/storage 而不是换成 /settings/workspace-sources：
              这条路径已经被人存过书签、也出现在报错文案里（「没有在…登记」）。
              换路径换来的只是更贴切的字面，代价是所有旧链接 404。
          */}
          <Route path="/projects/:projectId/settings/storage" element={<WorkspaceSourcesPage />} />
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
          {/*
            ★★ 认不出的地址要**说**认不出，不能默默换一页。
              此前是 `<Navigate to="/" replace />`：打错一个字、或者顺着一条
              过期链接进来，看到的是项目列表 —— 页面正常、地址被换掉、
              没有任何痕迹说明刚才发生过什么。用户会以为那条链接指向的东西
              被删了，而真相往往只是路径少了一段。
          */}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
        )}
        </div>
      </main>
    </div>
  );
}

/** 身份就绪之前的占位。用户几乎不会看到它 —— 除非 /auth/me 拿不到 */
function IdentityGate({ error }: { error: unknown }) {
  const t = useT();
  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-md rounded-xl border border-red-200 bg-red-50/60 px-6 py-5 text-center">
          <p className="text-sm font-medium text-red-800">{t('identity.failed')}</p>
          <p className="mt-1 text-xs text-red-600">{t('identity.failedHint')}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
      <BrandMark className="h-8 w-8 animate-breathe" />
      <p className="text-xs text-slate-400">{t('identity.checking')}</p>
    </div>
  );
}

/** 旧的运行时设置页并入集成设置，保留跳转 */
/**
 * 认不出的地址。
 *
 * ★ 把原地址原样显示出来 —— 用户手上多半有一条链接，
 *   要判断是自己贴错了还是东西没了，只能靠对照那串路径。
 */
function NotFoundPage() {
  const t = useT();
  const location = useLocation();

  return (
    <div className="p-8 text-center">
      <h1 className="text-sm font-semibold text-slate-900">{t('notFound.title')}</h1>
      <p className="mt-1 text-xs text-slate-600">{t('notFound.body')}</p>
      <p className="mt-2 font-mono text-[11px] break-all text-slate-500">
        {location.pathname}
      </p>
      <Link
        to="/"
        className="mt-3 inline-block text-xs text-slate-700 underline hover:text-slate-900"
      >
        {t('notFound.backToProjects')}
      </Link>
    </div>
  );
}

function RuntimesRedirect() {
  const { projectId } = useParams<{ projectId: string }>();
  return <Navigate to={`/projects/${projectId}/settings/integrations`} replace />;
}

function TopNav() {
  const t = useT();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);

  return (
    /*
     * ★ 顶栏用玻璃面而不是实色：它盖在内容之上，半透明能让人一直
     *   感觉到「下面那一屏还在」，滚动时也不会像被切掉一块。
     * ★ 顶上那道品牌渐变发丝线是全站唯一的品牌出场 —— 一像素，不抢内容。
     */
    <header className="relative z-30 shrink-0 border-b border-slate-200/80 glass">
      <div aria-hidden className="hairline-brand absolute inset-x-0 top-0 h-px" />
      <div className="flex items-center gap-2.5 px-4 py-2">
        <Button variant="ghost"
          onClick={() => navigate('/')}
          className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent group flex items-center gap-2 rounded-md py-0.5 pr-1"
          title={t('shell.backToProjects')}
        >
          <BrandMark className="h-6 w-6 transition group-hover:scale-105" />
          <span className="text-[13px] font-semibold tracking-tight text-slate-900">APOS</span>
          {/* 窄屏先让位给组织切换与待办数 —— 全称在这儿是说明，不是功能 */}
          <span className="hidden text-[11px] text-slate-400 lg:inline">
            Autonomous&nbsp;Project&nbsp;OS
          </span>
        </Button>

        <OrgSwitcher />

        <DecisionBadge />

        {/*
          ★ 此前这里是一个身份下拉框，选中谁就是谁。那是 X-User-Id 时代的
            遗物 —— 一个自助改名的界面。现在身份由登录决定，
            换人看只能退出再登录，这也正是它本来该有的样子。
        */}
        <div className="ml-auto flex items-center gap-2">
          <LocaleToggle />
          <ThemeToggle />
          <span
            className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-100/60 py-0.5 pl-0.5 pr-2.5"
            title={user?.email}
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br from-brand-alt to-brand-far text-[10px] font-semibold text-white">
              {user?.name?.slice(0, 1) ?? '·'}
            </span>
            <span className="text-xs text-slate-600">{user?.name ?? '…'}</span>
          </span>
          <Button variant="outline" size="sm"
            onClick={signOut}
            className="border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-800">
            {t('shell.signOut')}
          </Button>
        </div>
      </div>
    </header>
  );
}

/**
 * 深浅主题切换。
 *
 * ★ 深色是默认，但不能是唯一：白天靠窗、投屏演示、以及单纯就是不喜欢
 *   深色的人，都需要另一套。整个调色盘接在 CSS 令牌上（见 index.css），
 *   所以这里只是换 <html data-theme>，没有第二套样式要维护。
 */
function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme);
  const toggle = useThemeStore((s) => s.toggle);
  const t = useT();
  const label = theme === 'dark' ? t('theme.switchToLight') : t('theme.switchToDark');

  return (
    <Button variant="ghost"
      onClick={toggle}
      aria-label={label}
      title={label}
      className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:border-brand/50 hover:text-brand"
    >
      <span aria-hidden className="text-[13px] leading-none">
        {theme === 'dark' ? '☾' : '☀'}
      </span>
    </Button>
  );
}

/**
 * 界面语言切换 / UI language switcher.
 *
 * ★★ 按钮上写的是**要切过去的那个语言**，而且用那个语言自己的写法：
 *   英文界面上显示「中文」，中文界面上显示「EN」。
 *
 *   写成「切换语言」这种当前语言的说法，等于要求用户先看懂当前语言 ——
 *   而看不懂正是他要点它的原因。这也是默认英文的同一条理由
 *   （见 lib/i18n/locale.ts）。
 *
 *   The button always shows the language you'd switch **to**, written in
 *   that language. Labeling it "Switch language" in the current language
 *   assumes you can read the current language — which is exactly what a
 *   person reaching for this button cannot do.
 */
function LocaleToggle() {
  const locale = useLocaleStore((s) => s.locale);
  const toggle = useLocaleStore((s) => s.toggle);
  const t = useT();
  const label = locale === 'en' ? t('locale.switchToZh') : t('locale.switchToEn');

  return (
    <Button variant="ghost"
      onClick={toggle}
      aria-label={label}
      title={label}
      className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent flex h-7 items-center justify-center rounded-full border border-slate-200 px-2 text-[11px] font-medium text-slate-500 transition hover:border-brand/50 hover:text-brand"
    >
      {locale === 'en' ? '中文' : 'EN'}
    </Button>
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
  const t = useT();
  const navigate = useNavigate();
  const { org, orgId, organizations, switchOrg } = useOrgStore();
  const [creating, setCreating] = useState(false);

  if (organizations.length === 0) return null;

  return (
    <>
      <div className="ml-1 flex items-center gap-1.5 border-l border-slate-200 pl-3">
        <span className="hidden text-[11px] text-slate-400 sm:inline">{t('org.label')}</span>
        <Select
          value={orgId ?? ''}
          onValueChange={(v) => {
            if (v === '__new__') {
              setCreating(true);
              return;
            }
            switchOrg(v);
            navigate('/');
          }}
        >
          <SelectTrigger
            className="h-auto w-auto border-slate-200 bg-slate-100/60 px-2 py-1 font-medium text-slate-700"
            aria-label={t('org.switch')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {organizations.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.name}
              </SelectItem>
            ))}
            <SelectItem value="__new__">{t('org.new')}</SelectItem>
          </SelectContent>
        </Select>
        {org && (
          <code className="hidden font-mono text-[10px] text-slate-400 md:inline">{org.slug}</code>
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
/**
 * 顶栏的待决策徽标。
 *
 * ★★ 这个数字是**跨项目**的，而看板上那个「待决策 N」只数当前项目。
 *   两个数字并排出现在同一屏、中间没有任何东西说明它们范围不同的时候，
 *   用户看到的是系统在自相矛盾 —— 而且是往吓人的方向矛盾
 *   （顶栏 8、看板 2，问题记录 #24）。所以在项目内的页面上，
 *   徽标要自己说清「8 条里这个项目 2 条」。
 *
 * ★ 超时与未超时视觉上分开：一个既没图标也不变色的长条，
 *   「有 8 件事要做」和「有 8 件事已经晚了」长得一模一样（#3）。
 *   超时用红 + 会扩散的圆点，未超时用琥珀 + 静止圆点。
 */
function DecisionBadge() {
  const t = useT();
  const userId = useAuthStore((s) => s.userId);
  const { pathname } = useLocation();
  const inbox = useQuery({
    queryKey: qk.decisionInbox('mine'),
    queryFn: () => api.decisionInbox('mine'),
    enabled: Boolean(userId),
  });

  const stats = inbox.data?.stats;
  if (!stats || stats.mine === 0) return null;

  const overdue = stats.overdue > 0;

  /**
   * ★ 从路径里取项目 id —— TopNav 在 <Routes> 之外，拿不到 useParams。
   *   取不到就退回纯跨项目的说法，不猜。
   */
  const projectId = /^\/projects\/([0-9a-f-]{36})/i.exec(pathname)?.[1] ?? null;
  const here = projectId ? stats.byProject[projectId] : undefined;
  /** ★ 只有在「这个项目的数 ≠ 全部」时才说范围。相等时那句话是废话 */
  const showScope = here !== undefined && here.mine !== stats.mine;

  return (
    <Link
      to={projectId ? `/projects/${projectId}/decisions` : '/decisions'}
      title={
        showScope
          ? t('shell.decisionScopeHint', { here: here.mine, total: stats.mine })
          : t('shell.decisionHint')
      }
      className={clsx(
        'group inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition',
        overdue
          ? 'border-red-300/60 bg-red-50 text-red-700 glow-overdue hover:bg-red-100'
          : 'border-amber-300/50 bg-amber-50 text-amber-800 glow-gate hover:bg-amber-100',
      )}
    >
      {/* 会扩散的圆点：它替代了「⏰」那个 emoji —— 一个真的在动的东西
          比一个画着时钟的字符更像「现在正有事等着你」。
          ★ 只有超时的才扩散：不停跳动的东西一多就等于没有重点 */}
      <span aria-hidden className="relative flex h-1.5 w-1.5 shrink-0">
        {overdue && (
          <span className="absolute inset-0 rounded-full bg-overdue animate-ping-soft" />
        )}
        <span
          className={clsx('relative h-1.5 w-1.5 rounded-full', overdue ? 'bg-overdue' : 'bg-gate')}
        />
      </span>
      <span className="tabular-nums">
        {t('shell.pendingDecisions', { count: stats.mine })}
      </span>
      {overdue && (
        <span className="font-medium tabular-nums">
          {t('shell.overdue', { count: stats.overdue })}
        </span>
      )}
      {showScope && (
        <span className="tabular-nums opacity-70">
          {t('shell.decisionsHere', { count: here.mine })}
        </span>
      )}
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
  const t = useT();
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
    <Modal onClose={onClose} title={t('org.create.title')}>
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">{t('org.create.title')}</h2>
        <p className="text-[11px] text-slate-500">{t('org.create.intro')}</p>

        <Label className="block">
          <span className="text-xs font-medium text-slate-700">{t('org.create.name')}</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('org.create.namePlaceholder')}
            className="mt-1" />
        </Label>

        <Label className="block">
          <span className="text-xs font-medium text-slate-700">
            slug
            <span className="ml-1 font-normal text-slate-400">{t('login.field.optional')}</span>
          </span>
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder={slugPreview(name)}
            className="mt-1 font-mono" />
          <p className="mt-1 text-[11px] text-slate-500">{t('org.create.slugHint')}</p>
        </Label>

        {create.error instanceof ApiError && (
          <p className="text-xs text-rose-600">{create.error.message}</p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm"
            onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="neutral" size="sm"
            disabled={!name.trim() || create.isPending}
            onClick={() => create.mutate()}>
            {create.isPending ? t('org.create.creating') : t('org.create.submit')}
          </Button>
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
