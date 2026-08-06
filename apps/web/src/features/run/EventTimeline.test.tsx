import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EventTimeline } from './EventTimeline';
import type { RunEventRow } from '../../lib/api/types';

function ev(
  seq: number,
  type: string,
  summary: string,
  payload?: Record<string, unknown>,
): RunEventRow {
  return {
    seq,
    ts: new Date(2026, 0, 1, 12, 22, seq).toISOString(),
    type,
    level: 'detail',
    summary,
    payload: payload ?? null,
    costDelta: null,
  };
}

const RUN = [
  ev(0, 'run_started', 'Run 启动（claude-opus-5）'),
  ev(1, 'progress', '分析现状'),
  ev(2, 'tool_call', '调用 read_file', { tool: 'read_file', path: 'src/order/query.ts' }),
  ev(3, 'tool_result', '✓ 读取成功'),
  ev(4, 'cost', '成本 +$0.5000'),
  ev(5, 'heartbeat', '心跳'),
  ev(6, 'reasoning', '决定采用复合索引方案而非分表'),
  ev(7, 'run_ended', 'Run 结束：completed'),
];

/**
 * 简明 / 详细是本页最重要的开关（页面文档 09 §2、§5.3）。
 *
 * 两类用户：负责人只想看懂「它做了什么、结果如何」，
 * 工程师需要原始请求与工具参数。同一个页面必须同时服务两者。
 */
describe('执行流的简明与详细', () => {
  it('简明模式滤掉心跳/工具返回/成本，保留叙事骨架', () => {
    render(<EventTimeline events={RUN} detailed={false} live={false} />);

    expect(screen.getByText('Run 启动（claude-opus-5）')).toBeInTheDocument();
    expect(screen.getByText('分析现状')).toBeInTheDocument();
    expect(screen.getByText('决定采用复合索引方案而非分表')).toBeInTheDocument();

    expect(screen.queryByText('心跳')).not.toBeInTheDocument();
    expect(screen.queryByText('✓ 读取成功')).not.toBeInTheDocument();
  });

  it('详细模式全都显示', () => {
    render(<EventTimeline events={RUN} detailed live={false} />);

    expect(screen.getByText('心跳')).toBeInTheDocument();
    expect(screen.getByText('✓ 读取成功')).toBeInTheDocument();
  });

  it('★ 简明模式没有 payload 就不给「展开」—— 那正是它要隐藏的东西', () => {
    // 后端在简明模式下不回 payload
    const withoutPayload = RUN.map((e) => ({ ...e, payload: null }));
    render(<EventTimeline events={withoutPayload} detailed={false} live={false} />);

    expect(screen.queryByRole('button', { name: '展开' })).not.toBeInTheDocument();
  });

  it('详细模式可展开出原始 payload', async () => {
    render(<EventTimeline events={RUN} detailed live={false} />);

    // 定位到工具调用那一条，而不是碰巧排第一的那条
    const toolEntry = screen.getByText('调用 read_file').closest('li')!;
    await userEvent.click(within(toolEntry).getByRole('button', { name: '展开' }));

    expect(screen.getByText(/src\/order\/query\.ts/)).toBeInTheDocument();
  });

  it('连续同类工具调用在简明模式折叠为一行', () => {
    const events = [
      ev(0, 'run_started', 'Run 启动'),
      ev(1, 'tool_call', '调用 read_file', { tool: 'read_file' }),
      ev(2, 'tool_call', '调用 read_file', { tool: 'read_file' }),
      ev(3, 'tool_call', '调用 read_file', { tool: 'read_file' }),
    ];
    render(<EventTimeline events={events} detailed={false} live={false} />);

    expect(screen.getByText('调用 read_file ×3')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('失败与执行中的呈现', () => {
  it('失败事件高亮并可锚定，便于「跳到失败点」', () => {
    const events = [...RUN.slice(0, 3), ev(9, 'error', '错误（context_insufficient）：找不到 schema')];
    const { container } = render(
      <EventTimeline events={events} detailed={false} live={false} onJumpToFailure={() => {}} />,
    );

    expect(screen.getByRole('button', { name: /跳到失败点/ })).toBeInTheDocument();
    expect(container.querySelector('#run-failure-point')).not.toBeNull();
  });

  it('没有失败时不显示「跳到失败点」', () => {
    render(<EventTimeline events={RUN} detailed={false} live={false} onJumpToFailure={() => {}} />);
    expect(screen.queryByRole('button', { name: /跳到失败点/ })).not.toBeInTheDocument();
  });

  it('执行中显示进行中指示，已结束不显示', () => {
    const { rerender } = render(<EventTimeline events={RUN} detailed={false} live />);
    expect(screen.getByText('执行中…')).toBeInTheDocument();

    rerender(<EventTimeline events={RUN} detailed={false} live={false} />);
    expect(screen.queryByText('执行中…')).not.toBeInTheDocument();
  });

  it('空事件流给出可操作的提示，而不是一片空白', () => {
    render(<EventTimeline events={[]} detailed={false} live={false} />);
    expect(screen.getByText(/切到详细模式看全部/)).toBeInTheDocument();
  });
});
