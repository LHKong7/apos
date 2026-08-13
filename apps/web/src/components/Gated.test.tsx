import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useLocaleStore } from '../lib/i18n';
import { Gated, GatedButton, RoleBadge } from './Gated';
import { api } from '../lib/api/client';
import { useAuthStore } from '../stores/auth';
import type { Permission, ProjectPermissions } from '../lib/api/types';

/**
 * 按权限灰按钮（docs/tech/09-security.md §2）。
 *
 * ★ 这一组验的是**说不说得清楚**，不只是灰没灰。
 *   一个「无权限」的灰按钮会让用户反复点它、然后去问同事是不是坏了；
 *   而带着「需要 tech_lead」的灰按钮，用户当场就知道该去找谁。
 */

const PERMS = (over: Partial<Record<Permission, boolean>> = {}): ProjectPermissions => ({
  projectId: 'p-1',
  userId: 'u-1',
  orgRole: 'member',
  projectRole: 'pm',
  permissions: { 'policy.tighten': true, 'policy.loosen': false, ...over } as Record<
    Permission,
    boolean
  >,
  denyReasons: { 'policy.loosen': '放宽规则需要 tech_lead，并且必须先看过模拟结果' },
});

function wrapper(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  useAuthStore.setState({ token: 't', userId: 'u-1', user: null, resolving: false });
  vi.spyOn(api, 'permissions').mockResolvedValue(PERMS());
});

/** ★ 钉住中文：这条断言查的是「技术负责人」四个字，默认语言是英文 */
beforeEach(() => useLocaleStore.setState({ locale: 'zh' }));

describe('GatedButton', () => {
  it('有权限时正常可点', async () => {
    const onClick = vi.fn();
    render(
      wrapper(
        <GatedButton permission="policy.tighten" projectId="p-1" onClick={onClick}>
          收紧
        </GatedButton>,
      ),
    );

    const btn = await screen.findByRole('button', { name: '收紧' });
    await vi.waitFor(() => expect(btn).not.toBeDisabled());
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('★ 没权限时灰掉，并把「该找谁」挂在提示上', async () => {
    const onClick = vi.fn();
    render(
      wrapper(
        <GatedButton permission="policy.loosen" projectId="p-1" onClick={onClick}>
          放宽
        </GatedButton>,
      ),
    );

    const btn = await screen.findByRole('button', { name: '放宽' });
    // ★ 等具体理由而不是等 disabled：加载中同样是 disabled，
    //   等它会在判定回来之前就通过，测试于是什么都没验到
    await vi.waitFor(() =>
      expect(btn).toHaveAttribute('title', expect.stringContaining('tech_lead')),
    );
    expect(btn).toBeDisabled();

    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  /**
   * ★ 判定没回来之前一律当作没权限。
   *
   *   乐观的默认会在加载的那半秒里把所有按钮点亮 —— 手快的人点下去，
   *   拿到一个 403 弹窗。宁可短暂地少几个按钮。
   */
  it('★ 权限还没拿到时按钮是灰的，而不是先亮着', () => {
    render(
      wrapper(
        <GatedButton permission="policy.tighten" projectId="p-1" onClick={vi.fn()}>
          收紧
        </GatedButton>,
      ),
    );
    const btn = screen.getByRole('button', { name: '收紧' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', '正在确认权限…');
  });

  /** 两个原因都在时，「你没资格」比「现在还不能」更根本 */
  it('★ 权限与状态都不允许时，先说权限', async () => {
    render(
      wrapper(
        <GatedButton
          permission="policy.loosen"
          projectId="p-1"
          disabled
          disabledReason="正在派发中"
          onClick={vi.fn()}
        >
          放宽
        </GatedButton>,
      ),
    );

    const btn = await screen.findByRole('button', { name: '放宽' });
    await vi.waitFor(() =>
      expect(btn).toHaveAttribute('title', expect.stringContaining('tech_lead')),
    );
  });

  it('有权限但状态不允许时，说状态的原因', async () => {
    render(
      wrapper(
        <GatedButton
          permission="policy.tighten"
          projectId="p-1"
          disabled
          disabledReason="正在派发中"
          onClick={vi.fn()}
        >
          收紧
        </GatedButton>,
      ),
    );

    const btn = await screen.findByRole('button', { name: '收紧' });
    await vi.waitFor(() => expect(btn).toHaveAttribute('title', '正在派发中'));
  });
});

describe('Gated 整块隐藏', () => {
  it('没权限就不渲染，可给替代内容', async () => {
    render(
      wrapper(
        <Gated permission="policy.loosen" projectId="p-1" fallback={<p>只有 tech_lead 能改</p>}>
          <p>规则编辑器</p>
        </Gated>,
      ),
    );

    expect(await screen.findByText('只有 tech_lead 能改')).toBeTruthy();
    expect(screen.queryByText('规则编辑器')).toBeNull();
  });
});

describe('RoleBadge', () => {
  it('显示当前身份在本项目的角色', async () => {
    render(wrapper(<RoleBadge projectId="p-1" />));
    expect(await screen.findByText('项目经理')).toBeTruthy();
  });

  it('非成员不显示角色标签', async () => {
    vi.spyOn(api, 'permissions').mockResolvedValue({ ...PERMS(), projectRole: null });
    const { container } = render(wrapper(<RoleBadge projectId="p-1" />));
    await vi.waitFor(() => expect(container.textContent).toBe(''));
  });
});
