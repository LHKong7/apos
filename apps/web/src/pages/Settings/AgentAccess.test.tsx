import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLocaleStore } from '../../lib/i18n';
import { selectOption } from '../../test/select';
import type { AgentAccessPreview, AgentAccessView } from '../../lib/api/types';
import { AgentAccessPanel } from './AgentAccess';

/**
 * 生效权限面板。
 *
 * ★★ 这一组守的是三条产品承诺，每一条都不是「好看」的问题：
 *   1. 默认流程里**不出现运行时工具名** —— 用户不该为了授权先学某个 CLI；
 *   2. 「用的是默认档案」要说出来，不能显示成一份用户自己配过的配置；
 *   3. 运行时兜不住的限制必须显示 —— 授权界面骗人比授权界面难用糟得多。
 */

const view = (over: Partial<AgentAccessView> = {}): AgentAccessView => ({
  agentId: 'a1',
  agentName: 'code-agent-1',
  runtimeKind: 'claude_code',
  profileKey: 'standard_executor',
  profileVersion: 1,
  usingDefault: true,
  profileOutdated: false,
  capabilities: ['workspace.read', 'workspace.write', 'command.test'],
  deniedCapabilities: ['repository.push', 'pull_request.merge'],
  resourceScopes: [{ kind: 'repo', ref: 'order-service', access: 'read', origin: 'project_default' }],
  sources: [],
  warnings: [],
  explained: [
    { capability: 'workspace.read', label: '读取工作区文件', labelEn: 'Read workspace files', risk: 'low' },
    { capability: 'workspace.write', label: '修改工作区文件', labelEn: 'Edit workspace files', risk: 'medium' },
    { capability: 'command.test', label: '运行测试', labelEn: 'Run tests', risk: 'medium' },
  ],
  profiles: [
    {
      key: 'standard_executor',
      name: '标准执行者',
      nameEn: 'Standard executor',
      description: '在隔离工作区里改代码、跑测试、交产物。',
      descriptionEn: 'Edits code in an isolated workspace.',
    },
    {
      key: 'code_developer',
      name: '代码开发者',
      nameEn: 'Code developer',
      description: '还能推分支并开 PR。',
      descriptionEn: 'May also push and open PRs.',
    },
  ],
  ...over,
});

const preview: AgentAccessPreview = {
  direction: 'loosen',
  addedCapabilities: ['repository.push'],
  removedCapabilities: [],
  affectedResources: ['order-service'],
  requiresReason: true,
  warnings: ['能把分支推到远端。改动从此离开平台的控制范围。'],
};

const agentAccess = vi.fn(async () => view());
const previewAgentAccess = vi.fn(async () => preview);
const setAgentAccess = vi.fn(async () => ({
  ok: true as const,
  direction: 'loosen',
  profileKey: 'code_developer',
  addedCapabilities: ['repository.push'],
  removedCapabilities: [],
  warnings: [],
}));

vi.mock('../../lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api/client')>(
    '../../lib/api/client',
  );
  return {
    ...actual,
    api: {
      agentAccess: (...args: unknown[]) => agentAccess(...(args as [])),
      previewAgentAccess: (...args: unknown[]) => previewAgentAccess(...(args as [])),
      setAgentAccess: (...args: unknown[]) => setAgentAccess(...(args as [])),
      repositories: async () => ({ repositories: [] }),
      storageTargets: async () => ({ storageTargets: [] }),
    },
  };
});

function renderPanel() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AgentAccessPanel projectId="p1" agentId="a1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh' });
  agentAccess.mockClear();
  agentAccess.mockResolvedValue(view());
  previewAgentAccess.mockClear();
  setAgentAccess.mockClear();
});

describe('★ 默认流程不出现工具名', () => {
  /**
   * ★★ `Read` / `Edit` / `Bash(npm test:*)` 是运行时的词汇。
   *   把它们摆在授权界面上，用户得先懂某个 CLI 才能授权 ——
   *   而更要命的是 `repo:write` 一个词同时表示三件风险差两个数量级的事。
   */
  it('显示的是能力人话，不是运行时工具名', async () => {
    renderPanel();

    expect(await screen.findByText('修改工作区文件')).toBeTruthy();
    expect(screen.getByText('运行测试')).toBeTruthy();

    const body = document.body.textContent ?? '';
    for (const toolName of ['Read', 'Edit', 'Bash', 'Grep', 'WebFetch']) {
      expect(body).not.toContain(toolName);
    }
  });

  /** ★ 「没配过」与「配成这样」在界面上必须分得开 */
  it('没配过时明说用的是默认档案', async () => {
    renderPanel();
    expect(await screen.findByText(/默认档案/)).toBeTruthy();
  });

  it('配过之后不再显示默认提示', async () => {
    agentAccess.mockResolvedValue(view({ usingDefault: false, profileKey: 'code_developer' }));
    renderPanel();

    expect(await screen.findByText('代码开发者')).toBeTruthy();
    expect(screen.queryByText(/默认档案/)).toBeNull();
  });
});

describe('★ 运行时降级必须可见', () => {
  /**
   * ★★ 「这条限制在这个运行时上不生效」是保存后最该知道的一件事。
   *   吞掉它，界面上这条授权和别处长得一模一样，而用户以为限制住了。
   */
  it('运行时兜不住的限制显示在卡片上', async () => {
    agentAccess.mockResolvedValue(
      view({ warnings: ['运行时 codex 的权限粒度是沙箱级，无法按命令拦截'] }),
    );
    renderPanel();

    expect(await screen.findByText(/沙箱级/)).toBeTruthy();
  });
});

describe('★ 档案升级不自动生效', () => {
  /**
   * ★★ 自动升级等于「平台改一次档案，所有 Agent 跟着变宽」——
   *   权限累积最典型的发生方式。所以只提示。
   */
  it('档案有新版时提示，但不改变当前显示的权限', async () => {
    agentAccess.mockResolvedValue(view({ profileOutdated: true }));
    renderPanel();

    expect(await screen.findByText(/没有自动升级/)).toBeTruthy();
  });
});

describe('★ 改动前先看影响', () => {
  it('换档案时显示影响与后果，并要求填原因', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: '修改' }));
    // ★ 按可见文案选，不再按 option 的 value（'code_developer'）—— Radix 没有 value 可点
    await selectOption(user, await screen.findByRole('combobox'), '代码开发者');

    // ★ 说的是后果（「离开平台的控制范围」），不是配置差异（「+repository.push」）
    expect(await screen.findByText(/离开平台的控制范围/)).toBeTruthy();
    expect(await screen.findByLabelText(/为什么需要这些权限/)).toBeTruthy();
  });

  /** ★★ 放宽没填原因时按钮必须是禁用的 —— 让人点了再被 400 驳回是最差的一种 */
  it('放宽未填原因时保存按钮禁用', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: '修改' }));
    await screen.findByLabelText(/为什么需要这些权限/);

    const save = screen.getByRole('button', { name: '保存' });
    expect(save.hasAttribute('disabled')).toBe(true);

    await user.type(screen.getByLabelText(/为什么需要这些权限/), '这个项目要它自己开 PR');
    expect(screen.getByRole('button', { name: '保存' }).hasAttribute('disabled')).toBe(false);
  });

  /**
   * ★ 预览必须是**问服务端**要的，不是前端自己比出来的。
   *   前端比一遍就是第二份求值器，而它和服务端的分歧会正好出现在
   *   最需要预览的那些复杂输入上（上限收窄、运行时不支持、资源升级）。
   */
  it('影响摘要来自服务端预览接口', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: '修改' }));
    await screen.findByLabelText('能力档案');

    expect(previewAgentAccess).toHaveBeenCalled();
  });
});
