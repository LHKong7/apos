import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentLifecycleBadge, ProjectMembershipBadge } from './AgentStatus';
import { useLocaleStore } from '../lib/i18n';

/**
 * Agent 的两个状态。
 *
 * ★★ 「● 正常」此前同时表示 active 与 retired：界面只分了 paused 与「其余」。
 *   于是一个已停用的 Agent 在花名册上是绿的，鼠标停上去 tooltip 写着
 *   「已停用：<原因>」，而看板上说它「状态为 retired」—— 徽标的颜色、文字
 *   和它自己的提示三者互相打架（问题记录 #10 / #11）。
 */

beforeEach(() => useLocaleStore.setState({ locale: 'zh' }));

describe('生命周期徽标', () => {
  it('★ 三种状态三种说法，retired 不再被画成「正常」', () => {
    const { rerender } = render(<AgentLifecycleBadge status="active" />);
    expect(screen.getByText('在岗')).toBeInTheDocument();

    rerender(<AgentLifecycleBadge status="paused" />);
    expect(screen.getByText('已暂停')).toBeInTheDocument();

    rerender(<AgentLifecycleBadge status="retired" />);
    expect(screen.getByText('已停用')).toBeInTheDocument();
    expect(screen.queryByText('在岗')).not.toBeInTheDocument();
  });

  /** ★ 原因是**补充**，不能和徽标本体说的话相反 */
  it('★ tooltip 与徽标本体一致，原因附在后面', () => {
    render(<AgentLifecycleBadge status="retired" reason="换成新版了" />);
    const badge = screen.getByText('已停用');
    expect(badge.getAttribute('title')).toContain('已永久停用');
    expect(badge.getAttribute('title')).toContain('换成新版了');
  });

  /** ★ 认不出来的状态原样显示，不静默归成「正常」—— 静默归一是这类 bug 的源头 */
  it('★ 未知状态原样印出来', () => {
    render(<AgentLifecycleBadge status="quarantined" />);
    expect(screen.getByText('quarantined')).toBeInTheDocument();
  });
});

describe('项目成员徽标', () => {
  it('区分「本项目成员」与「组织里有但没加进来」', () => {
    const { rerender } = render(<ProjectMembershipBadge inProject />);
    expect(screen.getByText('本项目成员')).toBeInTheDocument();

    rerender(<ProjectMembershipBadge inProject={false} />);
    expect(screen.getByText('未加入本项目')).toBeInTheDocument();
  });

  /** ★ 组织级视图里没有「本项目」这个概念 —— 空着比猜一个值好 */
  it('★ null 时整个不渲染', () => {
    const { container } = render(<ProjectMembershipBadge inProject={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
