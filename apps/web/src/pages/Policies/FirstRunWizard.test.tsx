import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useLocaleStore } from '../../lib/i18n';
import { useAuthStore } from '../../stores/auth';
import { api } from '../../lib/api/client';
import type { Permission, ProjectPermissions } from '../../lib/api/types';
import { FirstRunWizard } from './FirstRunWizard';

/**
 * 首次引导向导（Policy 页 → 项目一条规则都没有时）。
 *
 * ★★ 这一组盯的是「用户按下按钮之前，看不看得见自己会得到什么」。
 *
 *   一键生成治理配置最容易变成「我不知道它给我配了什么」，
 *   而在治理配置上，「不知道自己有什么」和「什么都没有」一样危险 ——
 *   前者还多一层虚假的安全感。所以预览必须跟着答案实时变，
 *   而且列出来的每一条都必须真的被建出来。
 */
const PERMS = (over: Partial<Record<Permission, boolean>> = {}): ProjectPermissions => ({
  projectId: 'p-1',
  userId: 'u-1',
  orgRole: 'member',
  projectRole: 'tech_lead',
  permissions: { 'policy.tighten': true, 'policy.loosen': true, ...over } as Record<
    Permission,
    boolean
  >,
  denyReasons: { 'policy.tighten': '收紧规则需要 tech_lead' },
});

function wrapper(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

/** ★ 钉住中文：下面按中文标签定位控件，而默认语言是英文 */
beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh' });
  useAuthStore.setState({ token: 't', userId: 'u-1', user: null, resolving: false });
  vi.spyOn(api, 'permissions').mockResolvedValue(PERMS());
});

const renderWizard = (onDone = vi.fn(), onSkip = vi.fn()) => {
  render(wrapper(<FirstRunWizard projectId="p-1" onDone={onDone} onSkip={onSkip} />));
  return { onDone, onSkip };
};

describe('首次引导向导', () => {
  it('★ 按下按钮之前就列出会建哪几条规则', () => {
    renderWizard();

    // 默认（软件交付）：生产发布 + 两类数据库变更 + 预算，共四条
    expect(screen.getByText(/这会建 4 条项目规则/)).toBeTruthy();
    expect(screen.getByText(/生产发布停下来等人确认/)).toBeTruthy();
    expect(screen.getByText(/数据库结构变更停下来等人确认/)).toBeTruthy();
    expect(screen.getByText(/单次执行超过 20 USD/)).toBeTruthy();
  });

  /** ★ 改一个答案，预览当场跟着变 —— 否则预览就成了一句与实际无关的装饰 */
  it('★ 答案改了预览跟着变', async () => {
    renderWizard();

    await userEvent.click(screen.getAllByRole('radio', { name: '不要' })[1]!);

    expect(screen.getByText(/这会建 2 条项目规则/)).toBeTruthy();
    expect(screen.queryByText(/数据库结构变更停下来等人确认/)).toBeNull();
    expect(screen.getByText(/生产发布停下来等人确认/)).toBeTruthy();
  });

  /**
   * ★★ 列出来的每一条都要真的被建出来，一条不多一条不少。
   *   预览与实际不符的话，用户以为自己设了边界，实际没有 ——
   *   而这种误解只会在出事的时候才被发现。
   */
  it('★ 列出来的每一条都真的建出来了', async () => {
    const setSwitch = vi
      .spyOn(api, 'setOperationSwitch')
      .mockResolvedValue({ applied: true } as never);
    const build = vi
      .spyOn(api, 'buildFromTemplate')
      .mockResolvedValue({ condition: {}, action: {}, explanation: '' });
    const save = vi.spyOn(api, 'savePolicy').mockResolvedValue({} as never);
    const { onDone } = renderWizard();

    await userEvent.click(screen.getByRole('button', { name: '建这几条规则' }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(setSwitch.mock.calls.map((c) => c[1].operationType)).toEqual([
      'deploy',
      'db_ddl',
      'db_dml',
    ]);
    // 生产发布那条只管生产环境 —— 开发与测试环境照旧由 Agent 自己发
    expect(setSwitch.mock.calls[0]![1].environment).toBe('production');
    expect(setSwitch.mock.calls.every((c) => c[1].verdict === 'human')).toBe(true);
    expect(build).toHaveBeenCalledWith('p-1', 'cost-gate', { threshold: 20, approver: 'tech_lead' });
    expect(save).toHaveBeenCalledTimes(1);
  });

  /** 预算填 0 = 不要这条规则，预览与实际都得少这一条 */
  it('预算填 0 时不建预算规则', async () => {
    vi.spyOn(api, 'setOperationSwitch').mockResolvedValue({ applied: true } as never);
    const build = vi.spyOn(api, 'buildFromTemplate');
    renderWizard();

    await userEvent.clear(screen.getByLabelText(/单次执行超过多少/));
    await userEvent.type(screen.getByLabelText(/单次执行超过多少/), '0');

    expect(screen.getByText(/这会建 3 条项目规则/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '建这几条规则' }));
    await waitFor(() => expect(build).not.toHaveBeenCalled());
  });

  /**
   * ★★ 一条一条顺序建，不并发。
   *   并发发出去的话，几条请求读到的是同一份旧规则集，各自算出的优先级
   *   会撞在一起 —— 而撞了之后谁先谁后，要到很久以后某次判定出乎意料时
   *   才会被发现。
   */
  it('★ 顺序建，不并发', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(api, 'setOperationSwitch').mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { applied: true } as never;
    });
    vi.spyOn(api, 'buildFromTemplate').mockResolvedValue({
      condition: {},
      action: {},
      explanation: '',
    });
    vi.spyOn(api, 'savePolicy').mockResolvedValue({} as never);
    const { onDone } = renderWizard();

    await userEvent.click(screen.getByRole('button', { name: '建这几条规则' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(maxInFlight).toBe(1);
  });

  /**
   * ★ 中途失败就停下，已经建好的留着，并把服务端那句话原样显示出来。
   *   回滚掉反而更糟：用户看到「失败了」，而库里其实什么都没有，
   *   他只能从头再来一遍。
   */
  it('★ 中途失败时停下并说清楚，已建的不回滚', async () => {
    const setSwitch = vi
      .spyOn(api, 'setOperationSwitch')
      .mockResolvedValueOnce({ applied: true } as never)
      .mockRejectedValueOnce(new Error('boom'));
    const { onDone } = renderWizard();

    await userEvent.click(screen.getByRole('button', { name: '建这几条规则' }));

    await waitFor(() => expect(screen.getByText(/操作失败|Action failed/)).toBeTruthy());
    expect(setSwitch).toHaveBeenCalledTimes(2);
    expect(onDone).not.toHaveBeenCalled();
  });

  /**
   * ★ 一定要给「我自己来」这条路，而且它让出的是位置、不是把整块藏掉 ——
   *   已经想好要配什么的人，不该被一份他不想要的建议挡在门口。
   */
  it('★ 跳过时把位置让出来', async () => {
    const { onSkip } = renderWizard();
    await userEvent.click(screen.getByRole('button', { name: '跳过，我自己配' }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  /** 没有收紧权限的人，按钮灰着并说清楚该找谁 */
  it('没有 policy.tighten 时按钮灰着并说明原因', async () => {
    vi.spyOn(api, 'permissions').mockResolvedValue(PERMS({ 'policy.tighten': false }));
    renderWizard();

    const button = await screen.findByRole('button', { name: '建这几条规则' });
    await waitFor(() => expect(button.getAttribute('disabled')).not.toBeNull());
    expect(button.getAttribute('title')).toContain('tech_lead');
  });
});
