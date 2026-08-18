import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useLocaleStore } from '../../lib/i18n';
import { api } from '../../lib/api/client';
import { useAuthStore } from '../../stores/auth';
import type {
  RepositoriesResponse,
  RepositoryRow,
  StorageTargetRow,
  StorageTargetsResponse,
} from '../../lib/api/types';
import { DeliveryTargetPicker } from './StorageTargets';
import { WorkspaceSourcesPage } from './WorkspaceSources';

/**
 * 工作区来源 —— 代码仓库与存储目标合并成的一页。
 *
 * ★★ 这一组盯三件事：
 *
 *   1. 三类来源在**同一张列表**里。仓库此前是 Agent 配置的第三个标签页，
 *      存储目标是导航里另一格 —— 用户要在两个地方回答同一个问题。
 *      分组渲染出来又是两个板块，所以断言它们混排在一起。
 *   2. 合并过程中那些「★」纪律一条都没丢：挂载白名单要显示、
 *      交货目标只列可写的。搬代码时最容易丢的恰恰是这些没人一眼看出缺失的行为。
 *   3. 项目级仓库的默认只读要在页面上说出来 —— 不说的话，
 *      「我什么都没配，它怎么读到了」是个查不出来的问题。
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

function repo(over: Partial<RepositoryRow> = {}): RepositoryRow {
  return {
    id: 'r1',
    ref: 'order-service',
    name: '订单服务',
    remoteUrl: 'https://example.invalid/order-service.git',
    defaultBranch: 'main',
    branchPrefix: 'apos/',
    scope: 'project',
    projectId: 'p1',
    status: 'active',
    credentialHint: '****abcd',
    credentialUsable: true,
    credentialProblem: null,
    authKind: 'token',
    authUsername: 'x-access-token',
    authUsernameSource: 'default',
    authProvider: null,
    sshKnownHosts: null,
    sshHostKeyPinned: false,
    sshHosts: [],
    checkCommand: null,
    checkTimeoutSeconds: 600,
    deliveryTargetId: null,
    warnings: [],
    ...over,
  };
}

function storeResponse(over: Partial<StorageTargetsResponse> = {}): StorageTargetsResponse {
  return {
    storageTargets: [target()],
    localMountRoots: ['/srv/data'],
    localMountRestricted: true,
    encryptsInlineSecrets: true,
    ...over,
  };
}

function repoResponse(over: Partial<RepositoriesResponse> = {}): RepositoriesResponse {
  return {
    repositories: [repo()],
    gitAvailable: true,
    gitVersion: '2.50.1',
    gitProblem: null,
    sshAvailable: true,
    sshProblem: null,
    encryptsInlineSecrets: true,
    ...over,
  };
}

/** 两个查询都要 mock —— 页面在两个都到齐之前显示骨架屏 */
function mockBoth(
  store: Partial<StorageTargetsResponse> = {},
  repos: Partial<RepositoriesResponse> = {},
) {
  vi.spyOn(api, 'storageTargets').mockResolvedValue(storeResponse(store));
  vi.spyOn(api, 'repositories').mockResolvedValue(repoResponse(repos));
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

describe('工作区来源是一页一张列表', () => {
  /**
   * ★★ 这条是整次合并的核心断言：仓库与存储目标在同一张列表里。
   *   拆成两个板块渲染的话它照样能过 —— 所以下一条盯的是排序。
   */
  it('代码仓库与存储目标出现在同一页上', async () => {
    mockBoth();

    render(wrapper(<WorkspaceSourcesPage />));

    expect(
      await screen.findByRole('heading', { level: 1, name: '工作区来源' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('订单服务')).toBeInTheDocument();
    expect(await screen.findByText('训练集')).toBeInTheDocument();
  });

  /**
   * ★★ 按 ref 混排，不按类型分组 —— 分组就是把「两个板块」换了个地方重演。
   *   a-bucket / m-repo / z-bucket 交错排列时，只有真的混排才排得出来。
   */
  it('两类按标识混排，而不是分成两段', async () => {
    mockBoth(
      { storageTargets: [target({ id: 'a', ref: 'a-bucket' }), target({ id: 'z', ref: 'z-bucket' })] },
      { repositories: [repo({ id: 'm', ref: 'm-repo' })] },
    );

    render(wrapper(<WorkspaceSourcesPage />));

    await screen.findByText('订单服务');
    const refs = screen
      .getAllByText(/^(a-bucket|m-repo|z-bucket)$/)
      .map((el) => el.textContent);
    expect(refs).toEqual(['a-bucket', 'm-repo', 'z-bucket']);
  });

  it('登记入口先问类型，三类都列出来', async () => {
    mockBoth();

    render(wrapper(<WorkspaceSourcesPage />));

    (await screen.findByRole('button', { name: '+ 登记来源' })).click();

    expect(await screen.findByText('登记哪一类来源？')).toBeInTheDocument();
    expect(screen.getByText('代码仓库（Git）')).toBeInTheDocument();
    expect(screen.getByText('对象存储（S3 兼容）')).toBeInTheDocument();
    expect(screen.getByText('宿主机目录')).toBeInTheDocument();
  });

  /**
   * ★ 合并之后「授权在哪配」少了一个显而易见的答案 ——
   *   所以这一页必须指回 Agent 配置。
   */
  it('指出授权仍然在 Agent 配置里配，并给出链接', async () => {
    mockBoth();

    render(wrapper(<WorkspaceSourcesPage />));

    expect(await screen.findByText(/登记不等于授权/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Agent 配置' })).toHaveAttribute(
      'href',
      '/projects/p1/settings/agents',
    );
  });

  /**
   * ★★ 项目级仓库对项目内 Agent 默认只读（domain 的 effectiveResourceScopes）。
   *   这条默认不写在页面上的话，「我什么都没配，它怎么读到了」查不出来。
   */
  it('说明项目级仓库默认只读，而写权限仍要显式授', async () => {
    mockBoth();

    render(wrapper(<WorkspaceSourcesPage />));

    expect(await screen.findByText(/不必逐个授权就能读/)).toBeInTheDocument();
    expect(screen.getByText(/「写」仍然要显式授/)).toBeInTheDocument();
  });

  /**
   * ★★ 挂载白名单是**部署环境**的变量（APOS_LOCAL_MOUNT_ROOTS），管理员
   *   在界面上改不动也看不到，而一条 local 登记过不过闸完全由它决定。
   *   搬运时丢掉这一段的话，被闸掉的登记看起来和正常的一模一样。
   */
  it('显示部署方允许挂载的目录白名单', async () => {
    mockBoth({ localMountRoots: ['/srv/data', '/mnt/shared'] });

    render(wrapper(<WorkspaceSourcesPage />));

    expect(await screen.findByText('/srv/data')).toBeInTheDocument();
    expect(screen.getByText('/mnt/shared')).toBeInTheDocument();
  });

  /** ★ 没设白名单是**更**该说出来的那一档，不是「没什么可说」 */
  it('没设白名单时给出警告而不是沉默', async () => {
    mockBoth({ localMountRoots: [], localMountRestricted: false });

    render(wrapper(<WorkspaceSourcesPage />));

    expect(await screen.findByText(/没有配置 APOS_LOCAL_MOUNT_ROOTS/)).toBeInTheDocument();
  });

  /** ★ git 环境问题要在这一页说清楚，而不是等第一次派发才炸 */
  it('git 不可用时当场说出来', async () => {
    mockBoth({}, { gitAvailable: false, gitProblem: '没找到 git 可执行文件' });

    render(wrapper(<WorkspaceSourcesPage />));

    expect(await screen.findByText(/没找到 git 可执行文件/)).toBeInTheDocument();
  });

  it('两类都为空时给出登记入口，而不是一片空白', async () => {
    mockBoth({ storageTargets: [] }, { repositories: [] });

    render(wrapper(<WorkspaceSourcesPage />));

    expect(await screen.findByRole('button', { name: '登记来源' })).toBeInTheDocument();
  });

  /**
   * ★★ 一个查询塌了就整页报错，不显示半张列表 ——
   *   半张列表看起来就是「另一类一个都没登记」，而那正是用户
   *   接下来会去重复登记一遍的理由。
   */
  it('仓库查询失败时整页报错，不显示半张列表', async () => {
    vi.spyOn(api, 'storageTargets').mockResolvedValue(storeResponse());
    vi.spyOn(api, 'repositories').mockRejectedValue(new Error('boom'));

    render(wrapper(<WorkspaceSourcesPage />));

    expect(await screen.findByText('加载失败')).toBeInTheDocument();
    // ★ 关键在这一条：另一个查询成功了，但它的结果一条都不该露出来
    expect(screen.queryByText('训练集')).toBeNull();
  });
});

/**
 * 交货目标选择器 —— 仓库表单与存储目标表单共用。
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

  /**
   * ★ 这三条都要先点开下拉：Radix 的选项在打开之前不在 DOM 里，
   *   而它们断言的恰恰是「候选里有什么、没有什么」。
   *   不点开的话 queryByRole('option') 一律为 null —— 后两条会**假绿**。
   */
  it('只读的目标不出现在候选里', async () => {
    const user = userEvent.setup();
    pick([
      target({ id: 'w', ref: 'writable-one', writable: true }),
      target({ id: 'r', ref: 'readonly-one', writable: false }),
    ]);

    await user.click(screen.getByRole('combobox'));

    expect(await screen.findByRole('option', { name: /writable-one/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /readonly-one/ })).toBeNull();
  });

  /** ★ 停用的目标同理：选上去也不会生效 */
  it('非 active 的目标不出现在候选里', async () => {
    const user = userEvent.setup();
    pick([target({ id: 'p', ref: 'paused-one', status: 'paused' })]);

    await user.click(screen.getByRole('combobox'));

    // 默认项一定在，说明下拉确实开着 —— 否则下一条断言是假绿
    expect(await screen.findByRole('option', { name: /写回自己/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /paused-one/ })).toBeNull();
  });

  /** ★ 编辑一个存储目标自身时，它不能当自己的交货目标 */
  it('编辑自身时把自己从候选里去掉', async () => {
    const user = userEvent.setup();
    pick([target({ id: 'self', ref: 'me' }), target({ id: 'other', ref: 'other-one' })], 'self');

    await user.click(screen.getByRole('combobox'));

    expect(await screen.findByRole('option', { name: /other-one/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /^me/ })).toBeNull();
  });

  /** ★ 一个可写目标都没有时说出来，而不是给一个只有默认项的下拉框 */
  it('没有可写目标时给出提示', () => {
    pick([target({ writable: false })]);

    expect(screen.getByText(/没有可写/)).toBeInTheDocument();
  });
});
