import { create } from 'zustand';
import { setCurrentOrgId } from '../lib/api/client';
import { queryClient } from '../lib/query/client';
import type { OrganizationRow } from '../lib/api/types';

const STORAGE_KEY = 'apos.orgId';

interface OrgState {
  orgId: string | null;
  org: OrganizationRow | null;
  organizations: OrganizationRow[];
  setOrganizations: (orgs: OrganizationRow[], currentOrgId: string) => void;
  switchOrg: (id: string) => void;
  /** 启动时用 `/auth/me` 给的组织纠正本地记着的那个。见实现处 */
  adoptServerOrg: (orgId: string) => void;
}

/**
 * 当前组织 —— 一切数据的顶层容器（Plane 里叫 Workspace）。
 *
 * ★★ 和身份分开存。
 *
 *   两者是正交的：同一个人在 A 组织是管理员、在 B 组织是普通成员，
 *   而同一个组织里可以切换不同的人。合成一个的话，
 *   「切身份」会顺手把组织也改掉，反过来也一样 —— 用户看到的是
 *   「我明明只换了个人，项目全没了」。
 *
 * ★ 不叫 workspace：这个代码库里 `workspace` 已经指 Agent 的 git 工作区。
 */
export const useOrgStore = create<OrgState>((set, get) => ({
  orgId: readStored(),
  org: null,
  organizations: [],

  /**
   * ★ 缺省值由**服务端**给（currentOrgId），前端不自己猜。
   *   猜错的表现是切换器显示 A、数据来自 B，而两边都不会报错。
   */
  setOrganizations: (organizations, currentOrgId) => {
    const stored = get().orgId;
    const resolved = organizations.some((o) => o.id === stored) ? stored! : currentOrgId;
    if (resolved !== stored) persist(resolved);
    apply(resolved, stored);
    set({
      organizations,
      orgId: resolved,
      org: organizations.find((o) => o.id === resolved) ?? null,
    });
  },

  switchOrg: (id) => {
    persist(id);
    apply(id, get().orgId);
    set({ orgId: id, org: get().organizations.find((o) => o.id === id) ?? null });
  },

  /**
   * ★★ 用 `/auth/me` 回来的组织纠正本地记着的那个。
   *
   *   localStorage 里的 orgId 可能已经失效（组织被删、人被移出、库被重建过）。
   *   失效之后它会被塞进每个请求的 X-Org-Id，而那些请求一律 404 ——
   *   包括本该用来纠正它的 `/organizations`。于是死锁：登录成功但整站空白，
   *   退出重登也没用，因为陈旧值还在浏览器里。
   *
   * ★ 「不相等就采纳」这条规则不会干扰正常的组织切换：
   *   本地那个**有效**时，服务端拿到 X-Org-Id 后回的 currentOrgId
   *   就是它自己，两者相等，什么都不会发生。只有失效时才会不等。
   */
  adoptServerOrg: (orgId) => {
    const stored = get().orgId;
    if (stored === orgId) return;
    persist(orgId);
    apply(orgId, stored);
    set({ orgId, org: get().organizations.find((o) => o.id === orgId) ?? null });
  },
}));

/**
 * ★★ 换了组织必须把缓存整个作废。
 *
 *   组织是多租户的边界：项目列表、Agent 花名册、仓库登记、决策收件箱
 *   全都按它收窄，而这些查询的 key 里没有 orgId。不作废的话，
 *   切过去之后页面会拿上一个组织的数据接着显示 —— 看起来完全正常，
 *   实际是把 A 公司的东西摆在 B 公司的界面上。
 */
function apply(next: string | null, previous: string | null) {
  setCurrentOrgId(next);
  if (next !== previous) void queryClient.invalidateQueries();
}

function readStored(): string | null {
  const id = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
  setCurrentOrgId(id);
  return id;
}

function persist(id: string) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, id);
}
