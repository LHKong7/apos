import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BoardCard, type CardActions } from './BoardCard';
import { useBoardStore } from '../../stores/board';
import { card } from '../../test/fixtures';
import { useLocaleStore } from '../../lib/i18n';

function actions(): CardActions {
  return {
    onOpen: vi.fn(),
    onHandleGate: vi.fn(),
    onRetry: vi.fn(),
    onRemind: vi.fn(),
    onTakeover: vi.fn(),
    onViewRun: vi.fn(),
  };
}

beforeEach(() => {
  useBoardStore.setState({ moves: new Map(), unseenMoves: [], openedCardId: null, quiet: false });
  /**
   * ★ 钉住中文：下面的断言查的是具体那几个词（「高风险」「待决策」）。
   *   默认语言是英文，不钉的话这些用例会随默认值一起红。
   *   Pinned to Chinese because these assertions match specific wording;
   *   the app default is English.
   */
  useLocaleStore.setState({ locale: 'zh' });
});

/**
 * 页面文档 05 §5.3 的表格逐行验证。
 *
 * 这些断言看着琐碎，但「按状态决定显示什么」是这个页面唯一的信息密度武器 ——
 * 一旦有人为了省事把所有字段都渲染出来，卡片就退化成不可扫视的字段堆。
 */
describe('卡片按状态裁剪内容', () => {
  it('待决策：突出 Gate、时限与处理入口，隐藏进度与成本', async () => {
    const a = actions();
    render(
      <BoardCard
        card={card({
          humanGate: 'waiting_for_decision',
          humanGateRef: 'd-1',
          decisionDueInMinutes: 240,
          riskLevel: 'high',
          cost: '8.2000',
          progress: { step: 3, total: 5, description: '实现逻辑' },
        })}
        actions={a}
      />,
    );

    expect(screen.getByText('待决策')).toBeInTheDocument();
    expect(screen.getByText('4h 内')).toBeInTheDocument();
    expect(screen.getByText(/高风险/)).toBeInTheDocument();
    // 进度与成本在待决策卡片上不该出现
    expect(screen.queryByText('60%')).not.toBeInTheDocument();
    expect(screen.queryByText(/8\.20/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /处理/ }));
    expect(a.onHandleGate).toHaveBeenCalled();
    // 点按钮不应连带打开详情
    expect(a.onOpen).not.toHaveBeenCalled();
  });

  it('超时的决策显示为 decision_overdue，压过原本的 Gate 状态', () => {
    render(
      <BoardCard
        card={card({
          humanGate: 'waiting_for_decision',
          humanGateRef: 'd-1',
          decisionDueInMinutes: -125,
        })}
        actions={actions()}
      />,
    );

    expect(screen.getByText('决策超时')).toBeInTheDocument();
    expect(screen.getByText('超时 2h5m')).toBeInTheDocument();
  });

  it('阻塞：突出时长与原因，并给出催办/接管', async () => {
    const a = actions();
    render(
      <BoardCard
        card={card({
          blockedSince: new Date().toISOString(),
          blockedMinutes: 492,
          blockedReason: '等待 DBA 审批生产库索引变更',
          humanGateRef: 'd-1',
        })}
        actions={a}
      />,
    );

    expect(screen.getByText('⛔ 阻塞 8h12m')).toBeInTheDocument();
    expect(screen.getByText('等待 DBA 审批生产库索引变更')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '催办' }));
    expect(a.onRemind).toHaveBeenCalled();
  });

  it('失败：讲清下一步会发生什么，而不是只报次数', () => {
    render(<BoardCard card={card({ status: 'failed', consecutiveFailures: 2 })} actions={actions()} />);

    expect(screen.getByText('❌ 失败 2/3')).toBeInTheDocument();
    expect(screen.getByText('再失败 1 次将请求人工介入')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('执行中：Agent、进度、成本与最新事件', () => {
    render(
      <BoardCard
        card={card({
          status: 'executing',
          executor: { type: 'agent', id: 'a-1', name: 'code-agent-1' },
          progress: { step: 3, total: 5, description: '实现逻辑' },
          cost: '8.2000',
          estimatedCost: '12.0000',
          latestNote: '已通过 48/48 测试',
        })}
        actions={actions()}
      />,
    );

    expect(screen.getByText('code-agent-1')).toBeInTheDocument();
    expect(screen.getByText('60%')).toBeInTheDocument();
    expect(screen.getByText('$8.20 / $12.00')).toBeInTheDocument();
    expect(screen.getByText('最新：已通过 48/48 测试')).toBeInTheDocument();
  });

  it('已完成：只留执行者、成本与验收人', () => {
    render(
      <BoardCard
        card={card({
          status: 'done',
          stage: 'done',
          executor: { type: 'agent', id: 'a-1', name: 'code-agent-1' },
          owner: { id: 'u-1', name: '李娜' },
          cost: '1.2000',
          progress: { step: 5, total: 5, description: '完成' },
        })}
        actions={actions()}
      />,
    );

    expect(screen.getByText('✓ $1.20')).toBeInTheDocument();
    expect(screen.getByText('验收：李娜')).toBeInTheDocument();
    expect(screen.queryByText('100%')).not.toBeInTheDocument();
  });

  it('已了结的 Gate 只留徽标，不再给「处理」按钮', () => {
    render(
      <BoardCard
        card={card({ status: 'reviewing', stage: 'review', humanGate: 'approved', humanGateRef: null })}
        actions={actions()}
      />,
    );

    expect(screen.getByText('已批准')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /处理/ })).not.toBeInTheDocument();
  });
});

describe('人机视觉区分', () => {
  it('Agent 用虚线边框 + 等宽字体，人类用圆形头像', () => {
    const { rerender } = render(
      <BoardCard
        card={card({ executor: { type: 'agent', id: 'a-1', name: 'code-agent-1' } })}
        actions={actions()}
      />,
    );
    const agentChip = screen.getByTitle('Agent：code-agent-1');
    expect(agentChip.className).toContain('border-dashed');
    expect(agentChip.className).toContain('font-mono');

    rerender(
      <BoardCard
        card={card({ executor: { type: 'human', id: 'u-1', name: '张伟' } })}
        actions={actions()}
      />,
    );
    const humanChip = screen.getByTitle('人类：张伟');
    expect(humanChip.className).not.toContain('border-dashed');
    expect(humanChip.className).toContain('rounded-full');
  });
});

describe('自动移动动画', () => {
  it('打开详情的卡片不做落位动画（页面文档 05 §5.5）', () => {
    useBoardStore.setState({
      openedCardId: 'wi-1',
      moves: new Map([
        ['wi-1', { workItemId: 'wi-1', from: 'execution', to: 'review', source: 'agent', at: Date.now() }],
      ]),
    });

    const { container } = render(<BoardCard card={card()} actions={actions()} />);
    expect(container.querySelector('.animate-card-land')).toBeNull();
  });

  it('安静模式下不做动画也不显示来源角标', () => {
    useBoardStore.setState({
      quiet: true,
      moves: new Map([
        ['wi-1', { workItemId: 'wi-1', from: 'execution', to: 'review', source: 'human', at: Date.now() }],
      ]),
    });

    const { container } = render(<BoardCard card={card()} actions={actions()} />);
    expect(container.querySelector('.animate-card-land')).toBeNull();
    expect(screen.queryByTitle('人工调整')).toBeNull();
  });
});
