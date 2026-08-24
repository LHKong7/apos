import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { BlockedDetail } from '@apos/contracts';
import { BlockedReasons } from './BlockedReasons';
import { useLocaleStore } from '../../lib/i18n';

/**
 * 结构化阻塞原因。
 *
 * ★★ 这些断言钉住的是那一行长句被拆开之后必须成立的三件事：
 *   每条原因单独一行、每条标出它配在哪一层、同类原因归并成一个修复入口。
 *   少任何一件，这一区就退回成「读一段分号串起来的话」（问题记录 #2 / #12）。
 */

beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh' });
});

const detail = (over: Partial<BlockedDetail> = {}): BlockedDetail => ({
  kind: 'no_matching_agent',
  detail: null,
  candidates: [
    { agentId: 'a1', agentName: 'refactor-agent', code: 'not_project_member', scope: 'project' },
    { agentId: 'a2', agentName: 'review-agent-1', code: 'not_project_member', scope: 'project' },
    {
      agentId: 'a3',
      agentName: 'main-agent',
      code: 'missing_tools',
      scope: 'project',
      params: { items: 'write_file' },
    },
    { agentId: 'a4', agentName: 'code-agent-1', code: 'agent_inactive', scope: 'org', params: { status: 'retired' } },
  ],
  ...over,
});

const view = (node: React.ReactNode) => render(
  <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{node}</MemoryRouter>,
);

describe('阻塞原因分项展示', () => {
  it('每个候选单独一行，带自己的原因', () => {
    view(<BlockedReasons projectId="p1" detail={detail()} />);

    expect(screen.getByText('refactor-agent')).toBeInTheDocument();
    expect(screen.getByText('main-agent')).toBeInTheDocument();
    expect(screen.getByText(/没被授予它需要的工具：write_file/)).toBeInTheDocument();
    expect(screen.getByText(/Agent 状态是 retired/)).toBeInTheDocument();
  });

  /**
   * ★★ 层级是这一版的核心。Agent 档案页写着「允许 write_file」而看板说
   *   「缺少 write_file」，两句都对 —— 一个是组织级上限，一个是项目级授权。
   *   不标层级，用户看到的就是系统在自打嘴巴，然后跑去改错地方（#6）。
   */
  it('★ 项目级与组织级分别标出来', () => {
    view(<BlockedReasons projectId="p1" detail={detail()} />);

    expect(screen.getAllByText('本项目里').length).toBeGreaterThan(0);
    expect(screen.getByText('Agent 档案')).toBeInTheDocument();
  });

  /**
   * ★★ 同类归并。两个 Agent 都因为「不是本项目成员」被拒时，要修的是一处
   *   不是两处 —— 给两个一模一样的按钮等于让用户点两次去同一个地方（#12）。
   */
  it('★ 同一种修复只给一个按钮，并写清一次管几个', () => {
    view(<BlockedReasons projectId="p1" detail={detail()} />);

    expect(screen.getByRole('link', { name: '把 2 个 Agent 加进项目' })).toBeInTheDocument();
    // main-agent 缺工具权限 → 去项目级授权；单个时带上名字
    expect(screen.getByRole('link', { name: '给 main-agent 授权' })).toBeInTheDocument();
  });

  /** ★ 修不了的（运行时没注册、满载）不给按钮：点了没用的按钮比不给更糟 */
  it('★ 平台层的限制不给修复按钮', () => {
    view(
      <BlockedReasons
        projectId="p1"
        detail={detail({
          candidates: [
            { agentId: 'a1', agentName: 'x', code: 'runtime_not_registered', scope: 'platform' },
          ],
        })}
      />,
    );
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  /**
   * ★ 存量数据里只有那句中文。丢掉它等于把迁移前的阻塞原因一起抹了 ——
   *   这一区在老数据上必须还能读。
   */
  it('★ 没有结构化细节时原样显示服务端那句话', () => {
    view(<BlockedReasons projectId="p1" detail={null} fallback="无匹配 Agent：旧数据" />);
    expect(screen.getByText('无匹配 Agent：旧数据')).toBeInTheDocument();
  });

  it('★ 超过四条时折起来，展开后全在', async () => {
    const many = detail({
      candidates: Array.from({ length: 6 }, (_, i) => ({
        agentId: `a${i}`,
        agentName: `agent-${i}`,
        code: 'not_project_member' as const,
        scope: 'project' as const,
      })),
    });
    view(<BlockedReasons projectId="p1" detail={many} />);

    expect(screen.queryByText('agent-5')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /展开其余 2 条/ }));
    expect(screen.getByText('agent-5')).toBeInTheDocument();
  });

  it('工作区起不来时显示服务端给的那句细节', () => {
    view(
      <BlockedReasons
        projectId="p1"
        detail={detail({ kind: 'workspace_unavailable', candidates: [], detail: '仓库凭证过期' })}
      />,
    );
    expect(screen.getByText('工作区准备不出来')).toBeInTheDocument();
    expect(screen.getByText('仓库凭证过期')).toBeInTheDocument();
  });
});
