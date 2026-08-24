import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useLocaleStore } from '../../lib/i18n';
import { useAuthStore } from '../../stores/auth';
import { api } from '../../lib/api/client';
import type { OperationSwitchResponse, Permission, ProjectPermissions } from '../../lib/api/types';
import { OperationSwitchDialog } from './OperationSwitchDialog';

/**
 * 翻一个开关前的确认。
 *
 * ★★ 这一组盯的是一件事：**规则存下来了 ≠ 这一行变成了用户要的状态**。
 *
 *   一键操作最危险的地方不是它做错事，是它看起来什么都没做。报「已保存」
 *   就收工的话，用户会以为自己放开了，实际被另一条规则或安全底线拦着 ——
 *   而这种误解只会在出事的时候才被发现。
 *
 * ★ 反过来也一样：限定了环境时「整行仍然是视情况」是**预期结果**。
 *   把它报成失败，用户会把刚配好的东西改回去。
 */
const PERMS = (): ProjectPermissions => ({
  projectId: 'p-1',
  userId: 'u-1',
  orgRole: 'member',
  projectRole: 'tech_lead',
  permissions: { 'policy.tighten': true, 'policy.loosen': true } as Record<Permission, boolean>,
  denyReasons: {},
});

function wrapper(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

const response = (over: Partial<OperationSwitchResponse> = {}): OperationSwitchResponse => ({
  policy: { id: 'pol-1', name: '部署：自动执行' } as OperationSwitchResponse['policy'],
  direction: 'loosen',
  loosenedScenarios: 0,
  simulation: null,
  outcome: {
    operationType: 'deploy',
    label: '部署发布',
    verdict: 'auto',
    by: null,
    byAction: null,
    when: null,
    gate: null,
    matchedPolicyIds: ['pol-1'],
  },
  applied: true,
  shadowedBy: [],
  blockedBy: null,
  ...over,
});

/** ★ 钉住中文：下面按中文文案定位，而默认语言是英文 */
beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh' });
  useAuthStore.setState({ token: 't', userId: 'u-1', user: null, resolving: false });
  vi.spyOn(api, 'permissions').mockResolvedValue(PERMS());
  vi.spyOn(api, 'buildFromTemplate').mockResolvedValue({
    condition: {},
    action: {},
    explanation: '当 操作类型 = 部署发布，则 放行',
  });
});

const open = (onDone = vi.fn()) => {
  render(
    wrapper(
      <OperationSwitchDialog
        projectId="p-1"
        operationType="deploy"
        verdict="auto"
        onClose={() => {}}
        onDone={onDone}
      />,
    ),
  );
  return { onDone };
};

describe('操作开关的确认弹窗', () => {
  it('按下按钮之前先用人话说出会加哪一条规则', async () => {
    open();
    expect(await screen.findByText('当 操作类型 = 部署发布，则 放行')).toBeTruthy();
    // ★ 「删掉这条规则即还原」是一键操作能被信任的前提，必须说出来
    expect(screen.getByText(/删掉这条规则，一切回到现在的样子/)).toBeTruthy();
  });

  it('生效了就关窗并报一句', async () => {
    vi.spyOn(api, 'setOperationSwitch').mockResolvedValue(response());
    const { onDone } = open();

    await userEvent.click(await screen.findByRole('button', { name: '应用' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone.mock.calls[0]![0]).toContain('已生效');
  });

  /**
   * ★★ 没生效必须说出来，而且要说清是谁挡着 ——
   *   只报「没生效」等于把排查工作原样退回给用户。
   */
  it('★ 被别的规则挡住时留在弹窗里，并报出挡路的规则', async () => {
    vi.spyOn(api, 'setOperationSwitch').mockResolvedValue(
      response({
        applied: false,
        blockedBy: 'other_rules',
        outcome: { ...response().outcome!, verdict: 'human' },
        shadowedBy: [{ id: 'o-1', name: '组织规则：部署一律要人', scope: 'org' }],
      }),
    );
    const { onDone } = open();

    await userEvent.click(await screen.findByRole('button', { name: '应用' }));

    await waitFor(() => expect(screen.getByText(/规则已保存，但/)).toBeTruthy());
    expect(screen.getByText(/组织规则：部署一律要人/)).toBeTruthy();
    // 没生效就不关窗 —— 让用户读完自己决定下一步
    expect(onDone).not.toHaveBeenCalled();
  });

  /**
   * ★ 安全底线与「被别的规则挡住」是两种成因，说法必须分开：
   *   前者用户改不动（再试也没用），后者他改得动（去看那几条规则）。
   */
  it('★ 安全底线挡下时说清楚「任何规则都改不了」', async () => {
    vi.spyOn(api, 'setOperationSwitch').mockResolvedValue(
      response({
        applied: false,
        blockedBy: 'safety_floor',
        outcome: { ...response().outcome!, verdict: 'human' },
      }),
    );
    open();

    await userEvent.click(await screen.findByRole('button', { name: '应用' }));
    await waitFor(() => expect(screen.getByText(/安全底线不允许/)).toBeTruthy());
  });

  /**
   * ★★ 限定了环境时，整行仍然是「视情况」正是用户要的结果。
   *   把它报成失败，用户会把刚配好的东西改回去。
   */
  it('★ 限定环境后整行是「视情况」，按成功处理', async () => {
    const setSwitch = vi.spyOn(api, 'setOperationSwitch').mockResolvedValue(
      response({
        applied: false,
        blockedBy: 'autonomy_default',
        outcome: { ...response().outcome!, verdict: 'depends' },
      }),
    );
    const { onDone } = open();

    await userEvent.click(await screen.findByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: '仅生产环境' }));
    await userEvent.click(screen.getByRole('button', { name: '应用' }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone.mock.calls[0]![0]).toContain('其余环境仍按原来的规则走');
    expect(screen.queryByText(/规则已保存，但/)).toBeNull();
    expect(setSwitch.mock.calls[0]![1].environment).toBe('production');
  });

  /**
   * ★ 服务端拦下放宽时把模拟结果摊开，而不是简单地说「保存失败」——
   *   「其中 N 次人类当时是驳回的」比任何说明都更能帮用户看出规则的漏洞。
   */
  it('★ 与历史判断相悖时摊开模拟结果，并允许看过之后坚持', async () => {
    const { ApiError } = await import('../../lib/api/client');
    const setSwitch = vi.spyOn(api, 'setOperationSwitch').mockRejectedValueOnce(
      new ApiError(
        'POLICY_DENIED',
        '这条规则会自动放行 12 次评估…',
        {
          requiresAcknowledgment: true,
          simulation: {
            totalSamples: 12,
            wouldAutoHandle: 12,
            confidence: 'medium',
            mismatches: [
              {
                eventId: 'e1',
                workItemId: 'w1',
                occurredAt: '2026-08-01T00:00:00.000Z',
                workItemTitle: '一次被驳回的发布',
                humanDecision: 'rejected',
                humanNote: null,
              },
            ],
            suggestions: [],
            caveats: [],
          },
        },
        422,
      ),
    );
    open();

    await userEvent.click(await screen.findByRole('button', { name: '应用' }));
    await waitFor(() => expect(screen.getByText(/一次被驳回的发布/)).toBeTruthy());

    // 看过之后仍要继续 —— 这一次必须带上 acknowledgeMismatches
    setSwitch.mockResolvedValueOnce(response());
    await userEvent.click(screen.getByRole('button', { name: /仍然启用|知道风险/ }));
    await waitFor(() => expect(setSwitch).toHaveBeenCalledTimes(2));
    expect(setSwitch.mock.calls[1]![1].acknowledgeMismatches).toBe(true);
  });
});
