import { create } from 'zustand';
import { setCurrentUserId } from '../lib/api/client';
import { queryClient } from '../lib/query/client';
import type { User } from '../lib/api/types';

const STORAGE_KEY = 'apos.userId';

interface AuthState {
  userId: string | null;
  user: User | null;
  users: User[];
  setUsers: (users: User[]) => void;
  switchUser: (id: string) => void;
}

/**
 * MVP 身份。
 *
 * 真实认证见 docs/tech/09-security.md —— 这里只是把 X-User-Id 头凑齐。
 * 之所以做成可切换：产品里有一整类行为只有换个人看才验证得了
 * （「只看需我处理」、决策不可代行、按角色的按钮禁用）。
 */
export const useAuthStore = create<AuthState>((set, get) => ({
  userId: readStored(),
  user: null,
  users: [],

  setUsers: (users) => {
    const current = get().userId;
    const resolved = users.find((u) => u.id === current) ?? users[0] ?? null;
    if (resolved && resolved.id !== current) {
      persist(resolved.id);
    }
    applyIdentity(resolved?.id ?? null, current);
    set({ users, user: resolved, userId: resolved?.id ?? null });
  },

  switchUser: (id) => {
    persist(id);
    applyIdentity(id, get().userId);
    set({ userId: id, user: get().users.find((u) => u.id === id) ?? null });
  },
}));

/**
 * ★ 换了身份就必须把缓存作废。
 *
 *   后端有一整类响应是按 X-User-Id 算的（决策收件箱的「待我处理」、
 *   总览的「需要你处理」、决策的 canAct）。这些查询的 key 里没有用户 id ——
 *   不作废的话，切换身份后页面会拿上一个人的答案接着显示，
 *   而且看起来完全正常：一个「决策不可代行」的系统，
 *   在界面上把张三的待办摆给李四看。
 *
 *   首次落定身份（null → 有值）同样要作废：应用启动时 /users 还没回来，
 *   期间发出的请求是匿名的，后端会如实返回「没有需要你处理的事」并被缓存。
 */
function applyIdentity(next: string | null, previous: string | null) {
  setCurrentUserId(next);
  if (next !== previous) void queryClient.invalidateQueries();
}

function readStored(): string | null {
  const id = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
  setCurrentUserId(id);
  return id;
}

function persist(id: string) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, id);
}
