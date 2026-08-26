import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RuntimeKindSpec } from '@apos/contracts';
import { useLocaleStore } from '../../lib/i18n';
import { selectOption } from '../../test/select';
import { useAuthStore } from '../../stores/auth';
import { api } from '../../lib/api/client';
import type { AgentAdminRow } from '../../lib/api/types';
import { AgentForm } from './AgentConfig';

/**
 * 建 Agent 这张表 —— 零配置接入。
 *
 * ★★ 这一组守的是一条产品承诺：**建一个 Agent 只需要接通运行时**。
 *
 *   在它之前，这张表还问四件用户在那个时刻答不上来的事：它接什么类型的活、
 *   它有哪些 Skill Tag、它的能力上限、它的硬拒绝清单。四件的共同点是
 *   「要先跑过一次才知道答案」，而答不上来的人会跳过 —— 跳过的默认值恰好是
 *   最坏的那一种（空数组 = 什么都不接），于是新建出来的 Agent 一动不动，
 *   而页面上全绿。
 *
 *   这些断言全是**否定式**的（「这一栏不该出现」），因为回归的方向就是
 *   「有人顺手把它加回来」—— 而加回来之后界面看起来只是「配置更全了」。
 *
 * Creating an agent asks for a runtime connection and nothing else. The
 * assertions are deliberately negative: the regression to guard against is
 * somebody putting a field back, which looks like nothing worse than a more
 * thorough form.
 */

const KINDS: RuntimeKindSpec[] = [
  {
    kind: 'mock',
    label: 'Mock',
    description: '测试用',
    credential: null,
    endpoint: null,
    prerequisite: null,
    fields: [],
  },
  {
    kind: 'claude_code',
    label: 'Claude Code',
    description: '需要凭证的那种',
    credential: { label: 'API Key', help: '填 env:变量名' },
    endpoint: { label: '接入地址', help: '中转站' },
    prerequisite: null,
    fields: [],
  },
];

const existing = (over: Partial<AgentAdminRow> = {}): AgentAdminRow =>
  ({
    id: 'a1',
    name: 'code-agent-1',
    type: 'code',
    description: null,
    status: 'active',
    pausedReason: null,
    ownerId: 'u-1',
    runtimeKind: 'mock',
    runtimeKindLabel: 'Mock',
    runtimeConfig: {},
    runtimeConfigProblems: [],
    problemCode: null,
    endpoint: null,
    credentialHint: null,
    credentialUsable: true,
    credentialKind: 'none',
    credentialProblem: null,
    credentialProblemCode: null,
    registered: true,
    reachable: true,
    problem: null,
    lastCheckAt: null,
    model: null,
    ceiling: { capabilityCeiling: null, deniedCapabilities: [] },
    maxConcurrency: 3,
    timeoutSeconds: 1800,
    tokenLimitPerRun: null,
    tokenLimitDaily: null,
    capability: null,
    ...over,
  }) as AgentAdminRow;

function renderForm(agent: AgentAdminRow | null = null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AgentForm
        kinds={KINDS}
        encryptsInline
        agent={agent}
        projectId="p1"
        onClose={() => {}}
        onSaved={() => {}}
      />
    </QueryClientProvider>,
  );
}

/** ★ 钉住中文：下面按具体文案定位，而默认语言是英文 */
beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh' });
  useAuthStore.setState({ token: 't', userId: 'u-1', user: null, resolving: false });
  vi.spyOn(api, 'users').mockResolvedValue({ users: [{ id: 'u-1', name: '张伟' }] } as never);
  vi.spyOn(api, 'capabilityCatalog').mockResolvedValue({ capabilities: [] } as never);
});

describe('建 Agent 的表单', () => {
  /** 验收标准 1：创建 Agent 不再显示 Work it takes on */
  it('★ 不再问「承接范围」—— 建出来的 Agent 什么类型的活都接得了', () => {
    renderForm();
    expect(screen.queryByText('承接范围')).toBeNull();
    /** ★ 顺带把那 13 个类型按钮也查一遍：它们是那一栏唯一的痕迹 */
    for (const label of ['需求', '缺陷', '发布']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
  });

  /** 验收标准 2：创建 Agent 不再显示 Permission Boundary */
  it('★ 不再问权限边界 —— 默认全项目访问，要收窄是建完之后的事', () => {
    renderForm();
    expect(screen.queryByText(/限制这个 Agent 最多能被授权到什么程度/)).toBeNull();
    expect(screen.queryByText('永远不允许')).toBeNull();
    expect(screen.queryByText('限制访问范围')).toBeNull();
  });

  /** 验收标准 3：Skill Tags 从创建里删除 */
  it('★ 不再问 Skill 标签', () => {
    renderForm();
    expect(screen.queryByText('技能标签')).toBeNull();
  });

  /**
   * ★★ 剩下的三栏就是全部：名字、运行时、凭证。
   *   职责说明可填可不填，但它是唯一会进 prompt 的东西，所以留在主表单上。
   */
  it('★ 主表单只剩「名字 + 运行时 + 凭证 + 职责说明」', async () => {
    const user = userEvent.setup();
    renderForm();

    expect(screen.getByText('名称')).toBeTruthy();
    expect(screen.getByText('Headless CLI')).toBeTruthy();
    expect(screen.getByText('职责描述')).toBeTruthy();

    /** ★ 凭证栏跟着运行时走：mock 不需要凭证就不显示，换成需要的那种才出现 */
    expect(screen.queryByText('API Key')).toBeNull();
    await selectOption(user, screen.getAllByRole('combobox')[0]!, 'Claude Code');
    expect(await screen.findByText('API Key')).toBeTruthy();
  });

  /**
   * ★★ 运行时执行参数收在 Advanced settings 里，**默认收起**。
   *
   *   每一项都有能直接用的默认值。摊在主表单上，会让「建一个 Agent」
   *   看起来像是要先做六个决定 —— 而那六个决定用户在建的那一刻一个也答不上来。
   */
  it('★ 高级设置默认收起，展开后才是那几项执行参数', async () => {
    const user = userEvent.setup();
    renderForm();

    expect(screen.queryByText('最大并发')).toBeNull();
    await user.click(screen.getByRole('button', { name: /高级设置/ }));

    expect(screen.getByText('最大并发')).toBeTruthy();
    expect(screen.getByText('超时（秒）')).toBeTruthy();
    expect(screen.getByText('单次 token 上限')).toBeTruthy();
    expect(screen.getByText('每日 token 上限')).toBeTruthy();
    /** ★ 负责人也在这儿 —— 它有默认值（当前登录的人），不该占主表单一格 */
    expect(screen.getByText('负责人')).toBeTruthy();
  });

  /**
   * ★★ 建的时候一栏权限都不送，而 projectId 要送。
   *
   *   送 projectId 是为了让这个 Agent 当场进项目：少了它，用户在项目配置页
   *   建完 Agent 还得再去「成员与角色」加一遍，而漏掉那一步的表现是
   *   「建好了、看着正常、就是永远派不到活」。
   */
  it('★ 提交时带上 projectId，且不带任何权限字段', async () => {
    const create = vi
      .spyOn(api, 'createAgent')
      .mockResolvedValue({ agent: { id: 'a9' }, unknownConfigKeys: [] } as never);

    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByPlaceholderText('如 refactor-agent'), 'new-agent');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(create).toHaveBeenCalledTimes(1);
    const body = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body['projectId']).toBe('p1');
    expect(body['ownerId']).toBe('u-1');
    expect(body).not.toHaveProperty('capabilityCeiling');
    expect(body).not.toHaveProperty('deniedCapabilities');
    expect(body).not.toHaveProperty('skills');
    expect(body).not.toHaveProperty('applicableTypes');
  });
});

describe('改 Agent 的表单', () => {
  /**
   * ★★ 收窄的入口只在**编辑**态，默认收起，标题旁边写着当前状态。
   *
   *   它是低频操作：绝大多数 Agent 一辈子都是全项目访问。默认展开的话，
   *   每一个来改超时的人都要先跳过一屏他不打算动的权限勾选。
   */
  it('★ 编辑时才有「限制访问范围」，默认收起并写明当前是全项目访问', async () => {
    const user = userEvent.setup();
    renderForm(existing());

    expect(screen.getByText('本项目全部访问')).toBeTruthy();
    expect(screen.queryByText('永远不允许')).toBeNull();

    await user.click(screen.getByRole('button', { name: /限制访问范围/ }));
    expect(await screen.findByText('永远不允许')).toBeTruthy();
  });

  /**
   * ★★ 没展开 Restrict access 时，权限那两栏**原样送回**，不是送空。
   *
   *   送空会把一个正在生效的限制悄悄解除掉 —— 而用户这次只是来改个超时，
   *   界面上没有任何地方提示他刚刚放宽了一个 Agent。
   */
  it('★ 没动权限时，已生效的限制原样送回，不被悄悄解除', async () => {
    const update = vi
      .spyOn(api, 'updateAgent')
      .mockResolvedValue({ agent: { id: 'a1' }, unknownConfigKeys: [] } as never);

    const user = userEvent.setup();
    renderForm(
      existing({
        ceiling: { capabilityCeiling: ['workspace.read'], deniedCapabilities: ['repository.push'] },
      }),
    );

    await user.type(screen.getByDisplayValue('code-agent-1'), '-v2');
    await user.click(screen.getByRole('button', { name: '保存' }));

    const body = update.mock.calls[0]![1] as Record<string, unknown>;
    expect(body['capabilityCeiling']).toEqual(['workspace.read']);
    expect(body['deniedCapabilities']).toEqual(['repository.push']);
  });
});
