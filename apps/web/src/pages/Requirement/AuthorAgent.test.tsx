import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useLocaleStore } from '../../lib/i18n';
import { selectOption } from '../../test/select';
import { api } from '../../lib/api/client';
import { useAuthStore } from '../../stores/auth';
import type {
  Permission,
  ProjectAgentBindings,
  ProjectPermissions,
  RequirementDetail,
} from '../../lib/api/types';
import { AuthorAgent } from './AuthorAgent';

/**
 * 需求页上的「PRD 编写」下拉框。
 *
 * ★★ 这一组盯的是**选择不能被静默抹掉**。
 *
 *   候选只列当前的项目 Agent 成员，所以一个已经选中、但后来被移出项目的
 *   Agent 在这个列表里找不到 —— 如果就此让 select 落回「未指定」，
 *   界面会说没选过，而库里还指着它，下一次分析也会照着它失败。
 *   这正是这个功能最该避免的那种表现。
 */

function requirement(over: Partial<RequirementDetail['requirement']> = {}) {
  return {
    id: 'r1',
    projectId: 'p1',
    status: 'draft',
    rawInput: '订单查询太慢',
    title: null,
    businessContext: null,
    userProblem: null,
    businessGoal: null,
    userStories: [],
    scope: {},
    nonFunctional: [],
    risks: [],
    acceptanceCriteria: [],
    completeness: {},
    fieldProvenance: {},
    analysisModel: null,
    authorAgentId: null,
    priority: 'medium',
    rejectReason: null,
    approvedAt: null,
    ...over,
  } as RequirementDetail['requirement'];
}

function agentList(
  available: Partial<ProjectAgentBindings['available'][number]>[],
): ProjectAgentBindings {
  return {
    bindings: [],
    available: available.map((a) => ({
      agentId: a.agentId ?? 'a1',
      name: a.name ?? 'prd-writer',
      runtimeKind: a.runtimeKind ?? 'claude-code',
      status: a.status ?? 'active',
    })),
  };
}

function wrapper(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const PERMS = (canEdit = true): ProjectPermissions => ({
  projectId: 'p1',
  userId: 'u-1',
  orgRole: 'member',
  projectRole: 'pm',
  permissions: { 'requirement.edit': canEdit } as Record<Permission, boolean>,
  denyReasons: canEdit ? {} : { 'requirement.edit': '编辑需求需要项目成员权限' },
});

/** ★ 钉住中文：下面按具体文案定位与断言，而默认语言是英文 */
beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh' });
  useAuthStore.setState({ token: 't', userId: 'u-1', user: null, resolving: false });
  vi.spyOn(api, 'permissions').mockResolvedValue(PERMS());
});

function renderPicker(over: {
  requirement?: Partial<RequirementDetail['requirement']>;
  authorAgent?: RequirementDetail['authorAgent'];
  readOnly?: boolean;
} = {}) {
  return render(
    wrapper(
      <AuthorAgent
        projectId="p1"
        requirementId="r1"
        requirement={requirement(over.requirement)}
        authorAgent={over.authorAgent ?? null}
        readOnly={over.readOnly ?? false}
      />,
    ),
  );
}

describe('PRD 编写 Agent 选择', () => {
  /**
   * ★★ 项目 Agent 成员**全都**列出来。
   *
   *   这里以前按「适用类型含 requirement」筛过一轮，后果是项目里配了一整队
   *   Agent、下拉框却是空的 —— 而空下拉框不会解释「去勾一个你不知道有什么用
   *   的复选框」。那一栏现在整个不存在了，能不能写 PRD 由这个下拉框自己决定。
   */
  it('列出项目里全部 Agent 成员 —— 不按任何自述标签筛', async () => {
    vi.spyOn(api, 'projectAgents').mockResolvedValue(
      agentList([
        { agentId: 'a1', name: 'prd-writer' },
        { agentId: 'a2', name: 'coder' },
      ]),
    );

    const user = userEvent.setup();
    renderPicker();

    /**
     * ★ Radix 的选项在**打开之前不在 DOM 里**，所以断言「列了哪些」
     *   必须先点开触发器。原来直接 findByRole('option') 能过，
     *   是因为原生 <select> 的 <option> 一直在文档里。
     */
    await user.click(await screen.findByRole('combobox', { name: 'PRD 编写' }));

    await screen.findByRole('option', { name: /prd-writer/ });
    expect(screen.getByRole('option', { name: /coder/ })).toBeTruthy();
  });

  /** ★ 停用的也列出来 —— 它选得上，后果由下面那行黄字说清 */
  it('停用的 Agent 仍在选项里，选中它传的是它的 id', async () => {
    vi.spyOn(api, 'projectAgents').mockResolvedValue(
      agentList([
        { agentId: 'a1', name: 'prd-writer' },
        { agentId: 'a2', name: 'paused-one', status: 'paused' },
      ]),
    );
    const save = vi
      .spyOn(api, 'setRequirementAuthorAgent')
      .mockResolvedValue({ ok: true, agentId: 'a2', agentName: 'paused-one' });

    const user = userEvent.setup();
    renderPicker();

    await selectOption(user, await screen.findByRole('combobox', { name: 'PRD 编写' }), /paused-one/);

    await waitFor(() => expect(save).toHaveBeenCalledWith('r1', 'a2'));
  });

  it('选中之后立刻保存，传的是 agentId', async () => {
    vi.spyOn(api, 'projectAgents').mockResolvedValue(
      agentList([{ agentId: 'a1', name: 'prd-writer' }]),
    );
    const save = vi
      .spyOn(api, 'setRequirementAuthorAgent')
      .mockResolvedValue({ ok: true, agentId: 'a1', agentName: 'prd-writer' });

    const user = userEvent.setup();
    renderPicker();

    await selectOption(user, await screen.findByRole('combobox', { name: 'PRD 编写' }), /prd-writer/);

    await waitFor(() => expect(save).toHaveBeenCalledWith('r1', 'a1'));
  });

  /** ★ 「未指定」是显式的一档：它表示回到按项目绑定挑，不是「没保存」 */
  it('选回「未指定」传的是 null，不是空字符串', async () => {
    vi.spyOn(api, 'projectAgents').mockResolvedValue(
      agentList([{ agentId: 'a1', name: 'prd-writer' }]),
    );
    const save = vi
      .spyOn(api, 'setRequirementAuthorAgent')
      .mockResolvedValue({ ok: true, agentId: null, agentName: null });

    const user = userEvent.setup();
    renderPicker({ requirement: { authorAgentId: 'a1' } });

    /**
     * ★ 原来选的是 value=''。Radix 不许 SelectItem 用空串（那是它的
     *   「未选中」内部值），这一档改成走 SELECT_EMPTY 哨兵，
     *   而组件在回调里把哨兵还原成空串 —— 所以这里按可见文案点它，
     *   仍然断言最终传给服务端的是 null。
     */
    await selectOption(user, await screen.findByRole('combobox', { name: 'PRD 编写' }), /未指定/);

    await waitFor(() => expect(save).toHaveBeenCalledWith('r1', null));
  });

  /**
   * ★★ 已选、但如今不在候选里的那个（被移出项目）必须仍然显示出来
   *   并说清后果 —— 显示成「未指定」是最坏的处理。
   */
  it('选中的 Agent 已不在项目里时照旧显示，并说明下次分析会失败', async () => {
    vi.spyOn(api, 'projectAgents').mockResolvedValue(
      agentList([{ agentId: 'a2', name: '还在的那个' }]),
    );

    renderPicker({
      requirement: { authorAgentId: 'gone-1' },
      authorAgent: { id: 'gone-1', name: '被移走的', status: 'active' },
    });

    /**
     * ★ 原来断言 select.value === 'gone-1'。Radix 的触发器上没有 value，
     *   选中项是渲染成触发器里的**文案**的 —— 所以改成断言它显示的是
     *   那个已被移走的 Agent 的名字。守的仍是同一条：
     *   没有被悄悄落回「未指定」。
     */
    expect(await screen.findByText(/被移走的.*已不是这个项目的成员/)).toBeTruthy();
    const trigger = screen.getByRole('combobox', { name: 'PRD 编写' });
    expect(trigger).toHaveTextContent('被移走的');
    expect(trigger).not.toHaveTextContent('未指定');
  });

  it('选中的 Agent 停用时说出来 —— 下一次分析会失败', async () => {
    vi.spyOn(api, 'projectAgents').mockResolvedValue(
      agentList([{ agentId: 'a1', name: 'prd-writer', status: 'paused' }]),
    );

    renderPicker({
      requirement: { authorAgentId: 'a1' },
      authorAgent: { id: 'a1', name: 'prd-writer', status: 'paused' },
    });

    expect(await screen.findByText(/prd-writer 当前是 paused/)).toBeTruthy();
  });

  /** ★ 一个可选项都没有时说清怎么才能有，而不是给一个空下拉框 */
  it('项目里一个 Agent 成员都没有时，指向「成员与角色」', async () => {
    vi.spyOn(api, 'projectAgents').mockResolvedValue(agentList([]));

    renderPicker();

    expect(await screen.findByText(/还没有 Agent 成员/)).toBeTruthy();
  });

  /**
   * ★★ 保存失败之后不能停在那个其实没存上的选项上。
   *   乐观显示一旦跨过失败，就变成了骗人：用户以为换成了 B，
   *   而下一次分析仍然由 A 来跑。
   */
  it('保存失败时落回服务端的真值，并把报错摆出来', async () => {
    vi.spyOn(api, 'projectAgents').mockResolvedValue(
      agentList([
        { agentId: 'a1', name: 'writer-1' },
        { agentId: 'a2', name: 'writer-2' },
      ]),
    );
    vi.spyOn(api, 'setRequirementAuthorAgent').mockRejectedValue(
      new Error('writer-2 不是这个项目的成员'),
    );

    const user = userEvent.setup();
    renderPicker({ requirement: { authorAgentId: 'a1' } });

    const trigger = await screen.findByRole('combobox', { name: 'PRD 编写' });
    await selectOption(user, trigger, /writer-2/);

    await waitFor(() => expect(screen.getByText('更换编写 Agent 失败')).toBeTruthy());
    // ★ 落回服务端的真值：触发器上显示的又是 writer-1，不是那个没存上的 writer-2
    expect(trigger).toHaveTextContent('writer-1');
  });

  it('已确认的需求上是只读的', async () => {
    vi.spyOn(api, 'projectAgents').mockResolvedValue(
      agentList([{ agentId: 'a1', name: 'prd-writer' }]),
    );

    renderPicker({ readOnly: true });

    expect(await screen.findByRole('combobox', { name: 'PRD 编写' })).toBeDisabled();
  });

  /**
   * ★ 没权限的人看到的是**灰着并说明原因**的下拉框，不是一个点下去收 403 的。
   *   灰掉不是权限 —— 服务端仍然独立判一遍。
   */
  it('没有 requirement.edit 时灰掉，并把原因挂在上面', async () => {
    vi.spyOn(api, 'projectAgents').mockResolvedValue(
      agentList([{ agentId: 'a1', name: 'prd-writer' }]),
    );
    vi.spyOn(api, 'permissions').mockResolvedValue(PERMS(false));

    renderPicker();

    const trigger = await screen.findByRole('combobox', { name: 'PRD 编写' });
    await waitFor(() => expect(trigger).toBeDisabled());
    expect(trigger.title).toContain('编辑需求');
  });
});
