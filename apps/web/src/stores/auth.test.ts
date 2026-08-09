import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../lib/query/client';
import { getCurrentUserId } from '../lib/api/client';
import { useAuthStore } from './auth';

const USERS = [
  { id: 'u-1', name: '张伟', email: 'a@x.dev', orgRole: 'admin' },
  { id: 'u-2', name: '李娜', email: 'b@x.dev', orgRole: 'pm' },
] as never as Parameters<ReturnType<typeof useAuthStore.getState>['setUsers']>[0];

beforeEach(() => {
  localStorage.clear();
  queryClient.clear();
  useAuthStore.setState({ userId: null, user: null, users: [] });
});

/**
 * 身份与缓存。
 *
 * ★ 后端有一整类响应按 X-User-Id 计算（决策收件箱的「待我处理」、
 *   总览的「需要你处理」、决策卡片的 canAct）。这些查询的 key 里没有用户 id，
 *   所以身份一变就必须让缓存失效 —— 否则界面会拿上一个人的答案继续显示，
 *   而且看起来毫无异常：一个声称「决策不可代行」的系统，
 *   把张三的待办摆给李四看。
 */
describe('身份变化让查询缓存失效', () => {
  it('★ 首次落定身份（匿名 → 有人）也要作废：启动时那批匿名请求已经被缓存了', () => {
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    useAuthStore.getState().setUsers(USERS);

    expect(getCurrentUserId()).toBe('u-1');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('★ 切换身份让缓存失效，并同步请求头', () => {
    useAuthStore.getState().setUsers(USERS);

    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    useAuthStore.getState().switchUser('u-2');

    expect(useAuthStore.getState().userId).toBe('u-2');
    expect(getCurrentUserId()).toBe('u-2');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('身份没变时不动缓存 —— 每次 /users 回来都清一遍等于关掉了缓存', () => {
    useAuthStore.getState().setUsers(USERS);

    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    useAuthStore.getState().setUsers(USERS);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('记住的身份仍在名单里时不被顶掉', () => {
    localStorage.setItem('apos.userId', 'u-2');
    useAuthStore.setState({ userId: 'u-2', user: null, users: [] });

    useAuthStore.getState().setUsers(USERS);

    expect(useAuthStore.getState().userId).toBe('u-2');
    expect(getCurrentUserId()).toBe('u-2');
  });
});
