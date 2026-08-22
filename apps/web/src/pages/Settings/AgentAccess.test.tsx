import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLocaleStore } from '../../lib/i18n';
import { selectOption } from '../../test/select';
import type { AgentAccessPreview, AgentAccessView } from '../../lib/api/types';
import { AgentAccessPanel } from './AgentAccess';

/**
 * The effective-permissions panel / 生效权限面板。
 *
 * ★★ This suite guards three product promises, none of which is about looking
 *   nice:
 *   1. The default flow shows **no runtime tool names** — nobody should have to
 *      learn a particular CLI in order to grant permissions;
 *   2. "This is the default profile" must be said out loud, never rendered as a
 *      configuration the user appears to have chosen;
 *   3. Restrictions the runtime cannot enforce must be shown — an authorization
 *      screen that lies is far worse than one that is awkward to use.
 *
 *   这一组守的是三条产品承诺，每一条都不是「好看」的问题。
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
   * ★★ `Read` / `Edit` / `Bash(npm test:*)` is a runtime's vocabulary. Putting
   *   it on the authorization screen forces the user to learn some CLI before
   *   they can grant anything — and worse, the single word `repo:write` covered
   *   three operations whose risk differs by two orders of magnitude.
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

  /** ★ "Never configured" and "configured to look like this" must stay distinguishable */
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
   * ★★ "This restriction does not take effect on this runtime" is the single
   *   most important thing to learn after saving. Swallow it and the grant
   *   looks identical to every other one on screen, while the user believes
   *   they have constrained something they have not.
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
   * ★★ Auto-upgrading would mean "the platform edits one profile and every
   *   Agent widens with it" — the textbook way permission creep happens. So we
   *   only announce it.
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
    // ★ Pick by visible text, not by the option's value ('code_developer') — Radix exposes no value to click
    await selectOption(user, await screen.findByRole('combobox'), '代码开发者');

    // ★ It states the consequence ("leaves the platform's control"), not the diff ("+repository.push")
    expect(await screen.findByText(/离开平台的控制范围/)).toBeTruthy();
    expect(await screen.findByLabelText(/为什么需要这些权限/)).toBeTruthy();
  });

  /** ★★ Loosening with no reason must leave the button disabled — letting them click and then bouncing a 400 is the worst option */
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
   * ★ The preview must be **asked of the server**, not diffed on the client. A
   *   client-side diff is a second evaluator, and it would disagree with the
   *   server exactly on the complex inputs that most need a preview: a narrowed
   *   ceiling, an unsupported runtime, a widened resource scope.
   */
  it('影响摘要来自服务端预览接口', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: '修改' }));
    await screen.findByLabelText('能力档案');

    expect(previewAgentAccess).toHaveBeenCalled();
  });
});

/**
 * ★★ The English wording is **already in the API response** (nameEn / labelEn /
 *   descriptionEn).
 *
 *   The UI used to render only the Chinese half, so an English-speaking user
 *   managing permissions was shown 「标准执行者」 and 「读取工作区文件」. That
 *   was not a missing translation — it was discarding English text that had
 *   already shipped. These tests keep it from being discarded again.
 */
describe('英文界面用接口给的英文', () => {
  it('能力说明走 labelEn', async () => {
    useLocaleStore.setState({ locale: 'en' });
    renderPanel();

    expect(await screen.findByText('Read workspace files')).toBeInTheDocument();
    expect(screen.queryByText('读取工作区文件')).not.toBeInTheDocument();
  });

  it('档案名走 nameEn', async () => {
    useLocaleStore.setState({ locale: 'en' });
    renderPanel();

    expect(await screen.findByText('Standard executor')).toBeInTheDocument();
  });

  /** ★ The Chinese UI still takes the Chinese half — do not fix this in the wrong direction */
  it('中文界面仍是中文', async () => {
    useLocaleStore.setState({ locale: 'zh' });
    renderPanel();

    expect(await screen.findByText('读取工作区文件')).toBeInTheDocument();
  });
});
