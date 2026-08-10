import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../lib/query/client';
import { getAuthToken } from '../lib/api/client';
import { useAuthStore } from './auth';

const USER = {
  id: 'u-1',
  name: '张伟',
  email: 'a@x.dev',
  avatarUrl: null,
  orgRole: 'org_admin',
  approvalScopes: [],
};
const OTHER = { ...USER, id: 'u-2', name: '李娜', email: 'b@x.dev' };

beforeEach(() => {
  localStorage.clear();
  queryClient.clear();
  useAuthStore.setState({ token: null, user: null, userId: null, resolving: false });
});

/**
 * 登录态与缓存。
 *
 * ★★ 后端有一整类响应是按当前身份算的（决策收件箱的「待我处理」、
 *   总览的「需要你处理」、决策卡片的 canAct）。这些查询的 key 里没有
 *   用户 id —— 所以换人就必须动缓存，否则界面会拿上一个人的答案继续显示，
 *   而且看起来毫无异常：一个声称「决策不可代行」的系统，
 *   把张三的待办摆给李四看。
 */
describe('登录', () => {
  it('登录后令牌进 localStorage 并同步到请求头', () => {
    useAuthStore.getState().signIn('token-abc', USER);

    expect(useAuthStore.getState().userId).toBe('u-1');
    expect(getAuthToken()).toBe('token-abc');
    expect(localStorage.getItem('apos.token')).toBe('token-abc');
  });

  it('★ 登录让上一个人的缓存作废', () => {
    useAuthStore.getState().signIn('token-abc', USER);

    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    useAuthStore.getState().signIn('token-def', OTHER);

    expect(useAuthStore.getState().userId).toBe('u-2');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  /**
   * ★★ 退出要 clear 而不是 invalidate。
   *
   *   invalidateQueries 只是把数据标记为陈旧，它仍然在内存里 ——
   *   下一个人登录后，在重新拉取回来之前会先看到上一个人的页面。
   */
  it('★ 退出登录清空缓存与令牌，而不只是标记陈旧', () => {
    useAuthStore.getState().signIn('token-abc', USER);

    const clear = vi.spyOn(queryClient, 'clear');
    useAuthStore.getState().signOut();

    expect(clear).toHaveBeenCalled();
    expect(useAuthStore.getState().token).toBeNull();
    expect(useAuthStore.getState().userId).toBeNull();
    expect(getAuthToken()).toBeNull();
    expect(localStorage.getItem('apos.token')).toBeNull();
    clear.mockRestore();
  });

  it('没登录时退出不做任何事 —— 否则每次渲染都清一遍缓存', () => {
    const clear = vi.spyOn(queryClient, 'clear');
    useAuthStore.getState().signOut();
    expect(clear).not.toHaveBeenCalled();
    clear.mockRestore();
  });

  /**
   * ★ X-User-Id 时代的 `apos.userId` 必须被清掉。
   *   它现在不起作用，但留在浏览器里是一条真实的身份痕迹，
   *   而且会让「我明明退出了」这类疑问永远查不清。
   */
  it('★ 登录与退出都清掉旧版遗留的身份键', () => {
    localStorage.setItem('apos.userId', 'u-9');
    useAuthStore.getState().signIn('token-abc', USER);
    expect(localStorage.getItem('apos.userId')).toBeNull();

    localStorage.setItem('apos.userId', 'u-9');
    useAuthStore.getState().signOut();
    expect(localStorage.getItem('apos.userId')).toBeNull();
  });
});
