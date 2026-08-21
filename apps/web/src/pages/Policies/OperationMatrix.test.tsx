import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { OperationOutcome } from '@apos/domain';
import { useLocaleStore } from '../../lib/i18n';
import { useAuthStore } from '../../stores/auth';
import { api } from '../../lib/api/client';
import type { Permission, PolicyRow, ProjectPermissions } from '../../lib/api/types';
import { OperationMatrix, type OperationRow } from './OperationMatrix';

/**
 * 操作开关矩阵。
 *
 * ★★ 这一组盯的是三件事：
 *   1. 当前是哪一档，读屏软件也读得出来（底色对它不存在，而这一页管的是
 *      「Agent 能自己做什么」，读错一档的代价不小）；
 *   2. 「视情况」不可点 —— 它是系统报告出来的状态，不是用户能选的选项，
 *      做成按钮等于让用户选一个系统兑现不了的承诺；
 *   3. 那句「什么情况下需要人」按结构在界面这一侧拼，不照抄服务端的中文。
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
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

const outcome = (over: Partial<OperationOutcome> = {}): OperationOutcome => ({
  operationType: 'deploy',
  label: '部署发布',
  verdict: 'auto',
  by: null,
  byAction: null,
  when: null,
  gate: null,
  matchedPolicyIds: [],
  ...over,
});

const rows = (...list: OperationRow[]) => list;

beforeEach(() => {
  useAuthStore.setState({ token: 't', userId: 'u-1', user: null, resolving: false });
  vi.spyOn(api, 'permissions').mockResolvedValue(PERMS());
  useLocaleStore.setState({ locale: 'en' });
});

const renderMatrix = (list: OperationRow[], over: Partial<Parameters<typeof OperationMatrix>[0]> = {}) => {
  const onSet = vi.fn();
  const onClear = vi.fn();
  render(
    wrapper(
      <OperationMatrix
        rows={list}
        projectId="p-1"
        onSet={onSet}
        onClear={onClear}
        busyOperation={null}
        {...over}
      />,
    ),
  );
  return { onSet, onClear };
};

describe('操作开关矩阵', () => {
  /** ★ 当前档位不能只靠底色说 —— 读屏软件读不到颜色 */
  it('★ 当前档位用 aria-pressed 表态，不只靠底色', async () => {
    renderMatrix(rows({ outcome: outcome({ verdict: 'auto' }), switchRule: null }));

    const auto = await screen.findByRole('button', { name: 'Runs automatically' });
    const human = screen.getByRole('button', { name: 'Needs human confirmation' });
    expect(auto.getAttribute('aria-pressed')).toBe('true');
    expect(human.getAttribute('aria-pressed')).toBe('false');
  });

  it('点一档把操作类型与目标状态原样交出去', async () => {
    const { onSet } = renderMatrix(rows({ outcome: outcome(), switchRule: null }));

    await userEvent.click(await screen.findByRole('button', { name: 'Needs human confirmation' }));
    expect(onSet).toHaveBeenCalledWith('deploy', 'human');
  });

  /**
   * ★★ 「视情况」只显示不可点。它背后是条件更细的规则，从这一行选不出来 ——
   *   做成可点的第三个按钮，等于让用户选一个系统无法兑现的承诺。
   */
  it('★ 「视情况」只是一个状态，不是第三个按钮', async () => {
    renderMatrix(
      rows({
        outcome: outcome({
          verdict: 'depends',
          gate: { environments: ['production'], riskLevels: [], gatedCount: 4, totalCount: 20 },
        }),
        switchRule: null,
      }),
    );

    await screen.findByRole('button', { name: 'Runs automatically' });
    expect(screen.queryByRole('button', { name: 'Depends on the situation' })).toBeNull();
    expect(screen.getByText('Depends on the situation')).toBeTruthy();
  });

  /**
   * ★★ 那句「什么情况下需要人」按结构在界面这一侧拼。
   *   服务端那句 `when` 是中文，整句照抄等于把中文抄进英文界面。
   */
  it('★ 英文界面上按结构拼出整句英文，不照抄服务端那句中文', async () => {
    renderMatrix(
      rows({
        outcome: outcome({
          verdict: 'depends',
          when: '在生产环境，或风险等级为高时需要人确认',
          gate: {
            environments: ['production'],
            riskLevels: ['high'],
            gatedCount: 8,
            totalCount: 20,
          },
        }),
        switchRule: null,
      }),
    );

    const line = await screen.findByText(/Needs a person in Production/);
    expect(line.textContent).toContain('High');
    expect(line.textContent).not.toMatch(/[一-龥]/);
  });

  /** 单轴与「都盖不住」两种形态各有各的整句，不是在一句话上挖槽 */
  it('只有风险这一个轴时给风险那一句；都盖不住时退回计数', async () => {
    renderMatrix(
      rows(
        {
          outcome: outcome({
            operationType: 'db_ddl',
            verdict: 'depends',
            gate: { environments: [], riskLevels: ['critical'], gatedCount: 5, totalCount: 20 },
          }),
          switchRule: null,
        },
        {
          outcome: outcome({
            operationType: 'payment',
            verdict: 'depends',
            gate: { environments: [], riskLevels: [], gatedCount: 12, totalCount: 20 },
          }),
          switchRule: null,
        },
      ),
    );

    expect(await screen.findByText('Needs a person at Critical risk')).toBeTruthy();
    expect(screen.getByText('Needs a person in 12 of 20 situations')).toBeTruthy();
  });

  /**
   * ★ 只有被开关设过的行才给「清除」。别的行点了什么都不会发生，
   *   而一个点了没反应的按钮比没有按钮更让人怀疑页面坏了。
   */
  it('★ 只有被开关设过的行才有「清除」', async () => {
    const { onClear } = renderMatrix(
      rows(
        { outcome: outcome({ operationType: 'deploy' }), switchRule: null },
        {
          outcome: outcome({ operationType: 'db_ddl', label: '数据库结构变更' }),
          switchRule: { id: 'pol-1' } as PolicyRow,
        },
      ),
    );

    const clears = await screen.findAllByRole('button', { name: 'Clear' });
    expect(clears).toHaveLength(1);

    await userEvent.click(clears[0]!);
    expect(onClear).toHaveBeenCalledWith('db_ddl');
  });

  /** 正在提交的那一行整行禁用 —— 连点会把同一行来回切 */
  it('正在提交的那一行不可再点', async () => {
    renderMatrix(rows({ outcome: outcome(), switchRule: null }), { busyOperation: 'deploy' });

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Needs human confirmation' }).getAttribute('disabled'),
      ).not.toBeNull(),
    );
  });
});
