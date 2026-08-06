import { create } from 'zustand';
import { setCurrentUserId } from '../lib/api/client';
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
    setCurrentUserId(resolved?.id ?? null);
    set({ users, user: resolved, userId: resolved?.id ?? null });
  },

  switchUser: (id) => {
    persist(id);
    setCurrentUserId(id);
    set({ userId: id, user: get().users.find((u) => u.id === id) ?? null });
  },
}));

function readStored(): string | null {
  const id = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
  setCurrentUserId(id);
  return id;
}

function persist(id: string) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, id);
}
