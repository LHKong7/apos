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
 * Workspace sources — the page that merges repositories and storage targets /
 * 工作区来源。
 *
 * ★★ This group watches three things:
 *
 *   1. All three source kinds live in **one list**. Repositories used to be the third
 *      tab of Agent config and storage targets a separate nav slot, so users answered
 *      one question in two places. Rendering them grouped is just two blocks again,
 *      so the assertion is that they are interleaved.
 *   2. None of the "★" disciplines were lost in the merge: the mount allowlist must be
 *      shown, and only writable delivery targets may be listed. Behaviors nobody
 *      notices the absence of are exactly the ones that get dropped when code moves.
 *   3. The default read access on a project-level repository must be stated on the
 *      page — left unsaid, "I configured nothing, how did it read that" is
 *      unanswerable.
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
    credentialProblemCode: null,
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
    credentialProblemCode: null,
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

/** Both queries need mocking — the page shows a skeleton until both have arrived */
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

/** ★ Pin the locale to Chinese: the assertions below match exact copy, and the default is English */
beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh' });
  useAuthStore.setState({ token: 't', userId: 'u-1', user: null, resolving: false });
});

describe('工作区来源是一页一张列表', () => {
  /**
   * ★★ The core assertion of the whole merge: repositories and storage targets share
   *   one list. It would still pass if they were rendered as two separate blocks —
   *   which is why the next test watches the ordering.
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
   * ★★ Interleaved by ref, not grouped by kind — grouping just re-stages "two blocks"
   *   somewhere else. With a-bucket / m-repo / z-bucket alternating, only a genuine
   *   interleave can produce that order.
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
   * ★ After the merge, "where do I grant access" lost its obvious answer — so this
   *   page has to point back at Agent config.
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
   * ★★ A project-level repository is read-only by default for agents in that project
   *   (domain's effectiveResourceScopes). If that default is not written on the page,
   *   "I configured nothing, how did it read that" cannot be traced.
   */
  it('说明项目级仓库默认只读，而写权限仍要显式授', async () => {
    mockBoth();

    render(wrapper(<WorkspaceSourcesPage />));

    expect(await screen.findByText(/不必逐个授权就能读/)).toBeInTheDocument();
    expect(screen.getByText(/「写」仍然要显式授/)).toBeInTheDocument();
  });

  /**
   * ★★ The mount allowlist is a **deployment environment** variable
   *   (APOS_LOCAL_MOUNT_ROOTS) that an admin can neither see nor change from the UI,
   *   yet it alone decides whether a local registration passes the gate. Lose this
   *   block while moving code and a gated registration looks exactly like a good one.
   */
  it('显示部署方允许挂载的目录白名单', async () => {
    mockBoth({ localMountRoots: ['/srv/data', '/mnt/shared'] });

    render(wrapper(<WorkspaceSourcesPage />));

    expect(await screen.findByText('/srv/data')).toBeInTheDocument();
    expect(screen.getByText('/mnt/shared')).toBeInTheDocument();
  });

  /** ★ An unset allowlist is the case that needs saying **more**, not the case with nothing to say */
  it('没设白名单时给出警告而不是沉默', async () => {
    mockBoth({ localMountRoots: [], localMountRestricted: false });

    render(wrapper(<WorkspaceSourcesPage />));

    expect(await screen.findByText(/没有配置 APOS_LOCAL_MOUNT_ROOTS/)).toBeInTheDocument();
  });

  /** ★ git environment problems are stated on this page, not blown up on first dispatch */
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
   * ★★ If one query fails the whole page errors out instead of rendering half a list —
   *   half a list reads as "nothing of the other kind is registered", which is exactly
   *   what sends the user off to register a duplicate.
   */
  it('仓库查询失败时整页报错，不显示半张列表', async () => {
    vi.spyOn(api, 'storageTargets').mockResolvedValue(storeResponse());
    vi.spyOn(api, 'repositories').mockRejectedValue(new Error('boom'));

    render(wrapper(<WorkspaceSourcesPage />));

    expect(await screen.findByText('加载失败')).toBeInTheDocument();
    // ★ This is the crux: the other query succeeded, yet not one of its rows may show
    expect(screen.queryByText('训练集')).toBeNull();
  });
});

/**
 * The delivery-target picker — shared by the repository form and the storage-target
 * form / 交货目标选择器。
 *
 * ★★ Only **writable** targets are listed. A read-only target is silently skipped at
 *   delivery time, so offering it here invites the user to configure a value that will
 *   never take effect — and that failure mode (task succeeded, the artifacts page has
 *   a record, the target holds nothing) is extremely hard to reason your way to.
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
   * ★ All three tests must open the dropdown first: Radix keeps its options out of the
   *   DOM until it opens, and what these assert is precisely which candidates are and
   *   are not offered. Without opening it, queryByRole('option') is always null — so
   *   the last two would pass **falsely**.
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

  /** ★ Same for a disabled target: picking it would not take effect either */
  it('非 active 的目标不出现在候选里', async () => {
    const user = userEvent.setup();
    pick([target({ id: 'p', ref: 'paused-one', status: 'paused' })]);

    await user.click(screen.getByRole('combobox'));

    // The default item is always present, proving the dropdown really opened —
    // otherwise the next assertion would pass falsely
    expect(await screen.findByRole('option', { name: /写回自己/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /paused-one/ })).toBeNull();
  });

  /** ★ While editing a storage target, it cannot be its own delivery target */
  it('编辑自身时把自己从候选里去掉', async () => {
    const user = userEvent.setup();
    pick([target({ id: 'self', ref: 'me' }), target({ id: 'other', ref: 'other-one' })], 'self');

    await user.click(screen.getByRole('combobox'));

    expect(await screen.findByRole('option', { name: /other-one/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /^me/ })).toBeNull();
  });

  /** ★ Say so when there is no writable target at all, instead of a dropdown holding only the default */
  it('没有可写目标时给出提示', () => {
    pick([target({ writable: false })]);

    expect(screen.getByText(/没有可写/)).toBeInTheDocument();
  });
});
