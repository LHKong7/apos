import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useLocaleStore } from '../../lib/i18n';
import { api } from '../../lib/api/client';
import { useAuthStore } from '../../stores/auth';
import type { StorageTargetRow, StorageTargetsResponse } from '../../lib/api/types';
import { DeliveryTargetPicker, StorageTargetsPage } from './StorageTargets';

/**
 * 存储目标 —— 从 Agent 配置里拆出来的独立一页。
 *
 * ★★ 这一组盯两件事：
 *
 *   1. 它**自己就是一页**。有自己的路由与标题，不需要先进 Agent 配置
 *      再点第四个标签。这是这次拆分唯一的用户可见变化，所以要钉住。
 *   2. 拆的过程中那些「★」纪律一条都没丢：挂载白名单要显示、交货目标
 *      只列可写的。搬运代码时最容易丢的恰恰是这些没人一眼看出缺失的行为。
 */

function target(over: Partial<StorageTargetRow> = {}): StorageTargetRow {
  return {
    id: 's1',
    ref: 'training-set',
    name: '训练集',
    kind: 'object_storage',
    endpoint: 'https://s3.us-east-1.amazonaws.com',
    region: 'us-east-1',
    bucket: 'apos-data',
    prefix: 'datasets/train/',
    forcePathStyle: true,
    rootPath: null,
    writable: true,
    deliveryTargetId: null,
    scope: 'project',
    projectId: 'p1',
    status: 'active',
    credentialHint: '****1234',
    credentialUsable: true,
    credentialProblem: null,
    warnings: [],
    ...over,
  };
}

function response(over: Partial<StorageTargetsResponse> = {}): StorageTargetsResponse {
  return {
    storageTargets: [target()],
    localMountRoots: ['/srv/data'],
    localMountRestricted: true,
    encryptsInlineSecrets: true,
    ...over,
  };
}

function wrapper(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/projects/p1/settings/storage']}>
        <Routes>
          <Route path="/projects/:projectId/settings/storage" element={children} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** ★ 钉住中文：下面按具体文案定位，而默认语言是英文 */
beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh' });
  useAuthStore.setState({ token: 't', userId: 'u-1', user: null, resolving: false });
});

describe('存储目标是独立一页', () => {
  it('自己的路由下直接渲染出标题与列表 —— 不经过 Agent 配置', async () => {
    vi.spyOn(api, 'storageTargets').mockResolvedValue(response());

    render(wrapper(<StorageTargetsPage />));

    // 页面自己的标题（此前它只是 Agent 配置里的一个标签）
    expect(
      await screen.findByRole('heading', { level: 1, name: '存储目标' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('训练集')).toBeInTheDocument();
  });

  /**
   * ★ 拆成独立一页之后，「授权在哪配」少了一个显而易见的答案 ——
   *   所以这一页必须指回 Agent 配置。
   */
  it('指出授权仍然在 Agent 配置里配，并给出链接', async () => {
    vi.spyOn(api, 'storageTargets').mockResolvedValue(response());

    render(wrapper(<StorageTargetsPage />));

    expect(await screen.findByText(/登记不等于授权/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Agent 配置' })).toHaveAttribute(
      'href',
      '/projects/p1/settings/agents',
    );
  });

  /**
   * ★★ 挂载白名单是**部署环境**的变量（APOS_LOCAL_MOUNT_ROOTS），管理员
   *   在界面上改不动也看不到，而一条 local 登记过不过闸完全由它决定。
   *   搬运时丢掉这一段的话，被闸掉的登记看起来和正常的一模一样。
   */
  it('显示部署方允许挂载的目录白名单', async () => {
    vi.spyOn(api, 'storageTargets').mockResolvedValue(
      response({ localMountRoots: ['/srv/data', '/mnt/shared'] }),
    );

    render(wrapper(<StorageTargetsPage />));

    expect(await screen.findByText('/srv/data')).toBeInTheDocument();
    expect(screen.getByText('/mnt/shared')).toBeInTheDocument();
  });

  /** ★ 没设白名单是**更**该说出来的那一档，不是「没什么可说」 */
  it('没设白名单时给出警告而不是沉默', async () => {
    vi.spyOn(api, 'storageTargets').mockResolvedValue(
      response({ localMountRoots: [], localMountRestricted: false }),
    );

    render(wrapper(<StorageTargetsPage />));

    expect(await screen.findByText(/没有配置 APOS_LOCAL_MOUNT_ROOTS/)).toBeInTheDocument();
  });

  it('一个目标都没有时给出登记入口，而不是一片空白', async () => {
    vi.spyOn(api, 'storageTargets').mockResolvedValue(response({ storageTargets: [] }));

    render(wrapper(<StorageTargetsPage />));

    expect(await screen.findByRole('button', { name: '登记存储目标' })).toBeInTheDocument();
  });
});

/**
 * 交货目标选择器 —— 跟着存储目标一起搬过来，仓库表单从这里 import。
 *
 * ★★ 只列**可写**的。只读的目标在收尾时会被原样跳过，摆在这里可选
 *   就是在邀请用户配一个不会生效的值 —— 而那种失败（任务成功、
 *   产物页有记录、目标里什么都没有）极难自己想到。
 */
describe('交货目标选择器', () => {
  const pick = (targets: StorageTargetRow[], selfId?: string) =>
    render(
      wrapper(
        <DeliveryTargetPicker
          value={null}
          onChange={() => {}}
          targets={targets}
          {...(selfId ? { selfId } : {})}
          defaultLabel="写回自己"
        />,
      ),
    );

  it('只读的目标不出现在候选里', () => {
    pick([
      target({ id: 'w', ref: 'writable-one', writable: true }),
      target({ id: 'r', ref: 'readonly-one', writable: false }),
    ]);

    expect(screen.getByRole('option', { name: /writable-one/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /readonly-one/ })).toBeNull();
  });

  /** ★ 停用的目标同理：选上去也不会生效 */
  it('非 active 的目标不出现在候选里', () => {
    pick([target({ id: 'p', ref: 'paused-one', status: 'paused' })]);

    expect(screen.queryByRole('option', { name: /paused-one/ })).toBeNull();
  });

  /** ★ 编辑一个存储目标自身时，它不能当自己的交货目标 */
  it('编辑自身时把自己从候选里去掉', () => {
    pick([target({ id: 'self', ref: 'me' }), target({ id: 'other', ref: 'other-one' })], 'self');

    expect(screen.getByRole('option', { name: /other-one/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /me/ })).toBeNull();
  });

  /** ★ 一个可写目标都没有时说出来，而不是给一个只有默认项的下拉框 */
  it('没有可写目标时给出提示', () => {
    pick([target({ writable: false })]);

    expect(screen.getByText(/没有可写/)).toBeInTheDocument();
  });
});
