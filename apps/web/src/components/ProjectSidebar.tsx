import type { ReactNode } from 'react';
import { NavLink, useLocation, useMatch } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { api } from '../lib/api/client';
import { qk } from '../lib/query/keys';
import { sidebarCollapsed, useSidebarStore } from '../stores/sidebar';
import { useT, type MessageKey } from '../lib/i18n';
import { Button } from '@/components/ui/button';
import { RoleBadge } from './Gated';

/**
 * 项目侧栏。
 *
 * ★★ 这一版之前，**只有总览页有项目导航**。
 *
 *   执行图、Analytics、Policy、Agent 团队、需求、决策中心、设置各页
 *   都只有一个 <h1>。从执行图想去 Analytics，除了浏览器后退没有别的路 ——
 *   而看板上那几个跳转按钮只是这个洞的一块补丁，补在了十五个控件挤成
 *   一行的地方。
 *
 *   所以导航提到这里：一份定义、每个项目页都在、当前在哪一直看得见。
 *   总览页那条十二个标签的横排导航因此删掉了，看板工具条上的四个跨页
 *   链接也删掉了 —— 它们都是这份导航的重复实现。
 *
 * ★ 分三组不是为了好看：「工作」是每天都在的地方，「洞察」是回头看的，
 *   「配置」是装一次就不再动的。混在一起的话，一天点二十次的看板和
 *   一年点两次的角色定义会长得一模一样。
 */
export function ProjectSidebar() {
  const projectMatch = useMatch({ path: '/projects/:projectId', end: false });
  /**
   * ★ Run 详情的 URL 里没有项目：它是 /runs/:runId，从看板点「看日志」过来。
   *   但那次执行**属于**某个项目 —— 侧栏在这里消失，等于用户一点日志
   *   就被扔出了项目，回去只能靠浏览器后退。
   *
   * ★ 由侧栏自己去问，而不是让 Run 详情页把 projectId 存到某个全局态里：
   *   那种写法要靠每个页面记得设、记得清，漏一处就是「侧栏指着上一个项目」。
   *   这里的查询和 Run 详情页用的是同一个 key，React Query 会合并成一次请求。
   */
  const runMatch = useMatch('/runs/:runId');
  const runId = runMatch?.params.runId;
  const { pathname } = useLocation();
  const manual = useSidebarStore((s) => s.manual);
  const setManual = useSidebarStore((s) => s.setManual);

  const run = useQuery({
    queryKey: qk.run(runId!),
    queryFn: () => api.run(runId!),
    enabled: Boolean(runId),
  });

  const projectId = projectMatch?.params.projectId ?? run.data?.project?.id;

  const project = useQuery({
    queryKey: qk.project(projectId!),
    queryFn: () => api.project(projectId!),
    enabled: Boolean(projectId),
  });

  const collapsed = sidebarCollapsed(manual, pathname);
  const t = useT();

  if (!projectId) {
    /*
     * ★ Run 还在路上时先把宽度占住。
     *   等数据回来再插进来的话，整个内容区会在那一刻横向平移 224px ——
     *   用户正在读的日志会跳走。项目真的为空（极少数没有项目的 Run）时，
     *   下一帧它会消失，那一次跳动无法避免，但那是罕见分支。
     */
    if (runId && run.isPending) {
      return (
        <div aria-hidden className={clsx('shrink-0 border-r border-slate-200/80 glass', collapsed ? 'w-14' : 'w-56')} />
      );
    }
    return null;
  }

  const groups = navGroups(projectId);

  return (
    <aside
      aria-label={t('nav.aria.projectNav')}
      className={clsx(
        'relative z-10 flex shrink-0 flex-col border-r border-slate-200/80 glass',
        'transition-[width] duration-200 ease-out',
        collapsed ? 'w-14' : 'w-56',
      )}
    >
      {/* ── 项目头 ── */}
      <div className={clsx('shrink-0 border-b border-slate-200/70 px-3 py-2.5', collapsed && 'px-2')}>
        {collapsed ? (
          <div
            className="flex h-7 w-full items-center justify-center rounded-md bg-gradient-to-br from-brand-alt/20 to-brand-far/20 text-[11px] font-semibold text-brand"
            title={project.data?.project.name}
          >
            {project.data?.project.name.slice(0, 1) ?? '·'}
          </div>
        ) : (
          <>
            <p className="truncate text-xs font-semibold tracking-tight text-slate-900">
              {project.data?.project.name ?? ' '}
            </p>
            <p className="mt-0.5 truncate text-[10px] text-slate-400">
              {project.data?.project.autonomyLevel ?? ''}
            </p>
          </>
        )}
      </div>

      {/* ── 导航 ── */}
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {groups.map((group, gi) => (
          <div key={group.titleKey} className={clsx(gi > 0 && 'mt-3')}>
            {collapsed ? (
              gi > 0 && <div aria-hidden className="mx-2 mb-2 h-px bg-slate-200/70" />
            ) : (
              <p className="px-2 pb-1 text-[10px] uppercase tracking-[0.14em] text-slate-400">
                {t(group.titleKey)}
              </p>
            )}
            <ul className="space-y-0.5">
              {group.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    title={collapsed ? t(item.labelKey) : undefined}
                    className={({ isActive }) =>
                      clsx(
                        'group relative flex items-center rounded-md text-xs transition',
                        collapsed ? 'h-8 justify-center' : 'gap-2.5 px-2 py-1.5',
                        isActive
                          ? 'bg-brand/10 font-medium text-brand'
                          : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {/* 左侧那道亮条是「我在这儿」唯一不依赖颜色的线索 */}
                        {isActive && (
                          <span
                            aria-hidden
                            className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-brand"
                          />
                        )}
                        <span aria-hidden className="shrink-0">
                          {item.icon}
                        </span>
                        {!collapsed && <span className="truncate">{t(item.labelKey)}</span>}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {/* ── 页脚：我在这个项目里是什么角色 + 折叠开关 ── */}
      <div
        className={clsx(
          'flex shrink-0 items-center gap-2 border-t border-slate-200/70 px-2 py-2',
          collapsed && 'justify-center',
        )}
      >
        {/*
          ★ 角色徽标从总览页搬到这里。它回答的是「为什么那个按钮是灰的」，
            而灰按钮在每一页都可能出现 —— 只在总览看得到就等于没有。
          ★★ 收窄时**换形态而不是藏起来**（问题记录 #5）。
            此前它整个消失，于是「我是什么角色」这个问题的唯一答案
            跟着侧栏一起被折走了。收窄形态是一个人形轮廓 + 完整角色名的
            tooltip，点它就展开 —— 徽标由此成了「展开」的入口，
            而这正是它和旁边那个折叠按钮该有的关联。
        */}
        <RoleBadge
          projectId={projectId}
          compact={collapsed}
          onClick={() => setManual(false)}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setManual(!collapsed)}
          aria-label={collapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
          title={collapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
          className={clsx(
            'h-6 w-6 shrink-0 text-slate-400 hover:bg-slate-100 hover:text-slate-700',
            !collapsed && 'ml-auto',
          )}
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d={collapsed ? 'M6 3l5 5-5 5' : 'M10 3L5 8l5 5'} />
          </svg>
        </Button>
      </div>
    </aside>
  );
}

interface NavItem {
  to: string;
  /**
   * ★ 存词条键而不是译好的字符串：navGroups 是普通函数，不是组件，
   *   在里面调 useT 会违反 Hook 规则；而提前译好又意味着切换语言时
   *   这张表不会重算。存键、渲染处再译，两个问题一起没了。
   *
   *   Nav items carry message keys, not translated strings: navGroups is a
   *   plain function (no hooks), and pre-translating would freeze the labels
   *   at build time of the array rather than at render.
   */
  labelKey: MessageKey;
  icon: ReactNode;
  /** 总览的路径是其余所有页的前缀，不加 end 会一直高亮 */
  end?: boolean;
}

function navGroups(id: string): { titleKey: MessageKey; items: NavItem[] }[] {
  const p = `/projects/${id}`;
  return [
    {
      titleKey: 'nav.group.work',
      items: [
        { to: p, labelKey: 'nav.overview', icon: <Icon.Overview />, end: true },
        { to: `${p}/board`, labelKey: 'nav.board', icon: <Icon.Board /> },
        { to: `${p}/graph`, labelKey: 'nav.graph', icon: <Icon.Graph /> },
        { to: `${p}/requirements`, labelKey: 'nav.requirements', icon: <Icon.Requirement /> },
        { to: `${p}/decisions`, labelKey: 'nav.decisions', icon: <Icon.Decision /> },
      ],
    },
    {
      titleKey: 'nav.group.insight',
      items: [
        { to: `${p}/analytics`, labelKey: 'nav.analytics', icon: <Icon.Analytics /> },
        { to: `${p}/agents`, labelKey: 'nav.agents', icon: <Icon.Agents /> },
      ],
    },
    {
      titleKey: 'nav.group.config',
      items: [
        { to: `${p}/settings/policies`, labelKey: 'nav.policies', icon: <Icon.Policy /> },
        { to: `${p}/settings/integrations`, labelKey: 'nav.integrations', icon: <Icon.Integration /> },
        { to: `${p}/settings/agents`, labelKey: 'nav.agentConfig', icon: <Icon.AgentConfig /> },
        /**
         * ★ 工作区来源是一格独立的导航（代码仓库 + 对象存储 + 宿主机目录）。
         *   三类都是项目级的资源登记，不属于任何一个 Agent ——
         *   而藏在 Agent 配置的标签页里的设置，对没读过文档的人等于不存在：
         *   想登记一个仓库或挂一个数据目录的人，脑子里没有 Agent。
         */
        { to: `${p}/settings/storage`, labelKey: 'nav.workspaceSources', icon: <Icon.Storage /> },
        { to: `${p}/settings/members`, labelKey: 'nav.members', icon: <Icon.Members /> },
        { to: `${p}/settings/roles`, labelKey: 'nav.roles', icon: <Icon.Roles /> },
      ],
    },
  ];
}

/**
 * 图标。
 *
 * ★ 用线性 SVG 而不是 emoji：收窄之后图标是导航仅剩的线索，
 *   十二个 emoji 排下来颜色各异、粗细不一，扫的时候像一排贴纸。
 *   线性图标跟着 currentColor 走，选中态、hover、深浅主题全都自动对。
 */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

const Icon = {
  Overview: () => (
    <Glyph>
      <rect x="2.25" y="2.25" width="5" height="5" rx="1.2" />
      <rect x="8.75" y="2.25" width="5" height="5" rx="1.2" />
      <rect x="2.25" y="8.75" width="5" height="5" rx="1.2" />
      <rect x="8.75" y="8.75" width="5" height="5" rx="1.2" />
    </Glyph>
  ),
  Board: () => (
    <Glyph>
      <rect x="2.25" y="2.5" width="3.4" height="11" rx="1.1" />
      <rect x="6.3" y="2.5" width="3.4" height="7.5" rx="1.1" />
      <rect x="10.35" y="2.5" width="3.4" height="4.5" rx="1.1" />
    </Glyph>
  ),
  // 和品牌标记同形：两条上游汇进一个决策点，再往下流
  Graph: () => (
    <Glyph>
      <circle cx="4" cy="3.75" r="1.9" />
      <circle cx="12" cy="3.75" r="1.9" />
      <circle cx="8" cy="12.25" r="1.9" />
      <path d="M5.2 5.25 L7 10.4M10.8 5.25 L9 10.4" />
    </Glyph>
  ),
  Requirement: () => (
    <Glyph>
      <path d="M4 2.25h4.6L12 5.6v8.15H4z" />
      <path d="M8.4 2.4v3.3h3.3M6.2 8.6h3.6M6.2 11h2.6" />
    </Glyph>
  ),
  Decision: () => (
    <Glyph>
      <path d="M8 2.1l5.9 5.9L8 13.9 2.1 8z" />
      <path d="M5.9 8l1.5 1.5L10.3 6.6" />
    </Glyph>
  ),
  Analytics: () => (
    <Glyph>
      <path d="M2.5 13.5h11" />
      <path d="M4.75 13.5V8.5M8 13.5V3.5M11.25 13.5V6.5" strokeWidth="1.8" />
    </Glyph>
  ),
  Agents: () => (
    <Glyph>
      <rect x="2.5" y="4.75" width="11" height="8" rx="2.2" />
      <path d="M8 4.75V2.25" />
      <circle cx="6" cy="8.75" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10" cy="8.75" r="0.9" fill="currentColor" stroke="none" />
    </Glyph>
  ),
  Policy: () => (
    <Glyph>
      <path d="M8 2l5 1.9v4.3c0 3-2 5.4-5 6.3-3-.9-5-3.3-5-6.3V3.9z" />
      <path d="M6.1 7.9l1.4 1.4 2.6-2.7" />
    </Glyph>
  ),
  Integration: () => (
    <Glyph>
      <path d="M6.4 9.6l3.2-3.2" />
      <path d="M9.1 4.6l1.1-1.1a2.9 2.9 0 014.1 4.1l-1.1 1.1" />
      <path d="M6.9 11.4l-1.1 1.1a2.9 2.9 0 01-4.1-4.1l1.1-1.1" />
    </Glyph>
  ),
  AgentConfig: () => (
    <Glyph>
      <path d="M2.5 5h3.2M9.3 5h4.2M2.5 11h2.2M8.3 11h5.2" />
      <circle cx="7.5" cy="5" r="1.7" />
      <circle cx="6.5" cy="11" r="1.7" />
    </Glyph>
  ),
  /** 叠起来的盘片 —— 桶与目录共用的那个形状 */
  Storage: () => (
    <Glyph>
      <ellipse cx="8" cy="4" rx="5.5" ry="2" />
      <path d="M2.5 4v8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V4" />
      <path d="M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" />
    </Glyph>
  ),
  Members: () => (
    <Glyph>
      <circle cx="6.3" cy="5.6" r="2.4" />
      <path d="M2 13.4c0-2.3 1.9-3.7 4.3-3.7s4.3 1.4 4.3 3.7" />
      <path d="M11 4.1a2.3 2.3 0 010 4.4M12.1 13.4c0-1.5-.5-2.6-1.4-3.3" />
    </Glyph>
  ),
  Roles: () => (
    <Glyph>
      <circle cx="5.4" cy="8" r="2.7" />
      <path d="M8.1 8h5.6M11.6 8v2.4" />
    </Glyph>
  ),
};
