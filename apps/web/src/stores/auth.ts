import { create } from 'zustand';
import { setAuthToken } from '../lib/api/client';
import { queryClient } from '../lib/query/client';
import type { User } from '../lib/api/types';

const TOKEN_KEY = 'apos.token';
/** X-User-Id 时代留在浏览器里的身份。见下面 clearLegacyIdentity 的理由 */
const LEGACY_USER_KEY = 'apos.userId';

interface AuthState {
  /** 会话令牌。null = 未登录 */
  token: string | null;
  user: User | null;
  /**
   * 当前用户 id —— 就是 `user?.id`。
   *
   * ★ 单独留一个字段，是因为有十来处只关心 id（「这条决策是不是我的」、
   *   权限查询的 enabled 条件）。让它们各写一次 `user?.id ?? null`
   *   等于把同一个空值判断抄十遍，而漏抄的那一处会在 user 还没回来时
   *   拿 undefined 去比对 —— 表现是「我的待办」短暂地空一下。
   */
  userId: string | null;
  /** /auth/me 还没回来时为 true —— 用来区分「没登录」和「还不知道」*/
  resolving: boolean;
  signIn: (token: string, user: User) => void;
  signOut: () => void;
  setUser: (user: User | null) => void;
  setResolving: (resolving: boolean) => void;
}

/**
 * 登录态。
 *
 * ★★ 此前这里是一个**身份切换器**：/users 拿回全库用户，右上角下拉选一个，
 *   选中谁就是谁。那不是身份，是一个自助改名的界面 ——
 *   服务端当时也只认一个没有凭证的 X-User-Id 头。
 *   现在身份由服务端签发的令牌证明，前端只负责存着它、过期了就退出登录。
 *
 * ★ 令牌放 localStorage 而不是 httpOnly Cookie：SSE 那条连接
 *   （EventSource）带不了自定义头，令牌要能被 JS 读出来拼进 query。
 *   代价是 XSS 能读到它 —— 缓解靠短 TTL（默认 12 小时）。
 */
export const useAuthStore = create<AuthState>((set, get) => ({
  token: readStoredToken(),
  user: null,
  userId: null,
  resolving: Boolean(readStoredToken()),

  signIn: (token, user) => {
    localStorage.setItem(TOKEN_KEY, token);
    clearLegacyIdentity();
    setAuthToken(token);
    /**
     * ★ 登录必须清缓存。上一个人的「待我处理」「需要你处理」
     *   还在 queryClient 里，而这些查询的 key 里没有用户 id ——
     *   不清的话，换个人登录会看到上一个人的待办，且界面上毫无异常。
     */
    void queryClient.invalidateQueries();
    set({ token, user, userId: user.id, resolving: false });
  },

  signOut: () => {
    if (get().token === null) return;
    localStorage.removeItem(TOKEN_KEY);
    clearLegacyIdentity();
    setAuthToken(null);
    /**
     * ★★ 退出必须把缓存**清掉**而不是作废。
     *   invalidateQueries 只是标记为陈旧，数据还在内存里，
     *   下一个人登录后在重新拉取回来之前会先看到上一个人的页面。
     */
    queryClient.clear();
    set({ token: null, user: null, userId: null, resolving: false });
  },

  setUser: (user) => set({ user, userId: user?.id ?? null, resolving: false }),
  setResolving: (resolving) => set({ resolving }),
}));

function readStoredToken(): string | null {
  const token = typeof localStorage === 'undefined' ? null : localStorage.getItem(TOKEN_KEY);
  setAuthToken(token);
  return token;
}

/**
 * ★ 清掉旧身份键。
 *
 *   老版本把选中的 userId 存在 `apos.userId` 里。它现在没有任何作用，
 *   但留在浏览器里会让「我明明退出了，怎么还记着我是谁」这种疑问
 *   永远查不清 —— 而且那是一条真实的身份痕迹。
 */
function clearLegacyIdentity() {
  if (typeof localStorage !== 'undefined') localStorage.removeItem(LEGACY_USER_KEY);
}
