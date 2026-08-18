import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DependencyChain } from './DependencyChain';
import { useLocaleStore } from '../../lib/i18n';

/**
 * 依赖链。
 *
 * ★★ 卡片上此前只有一个「🔗 1」。用户由此知道自己被挡着，但不知道被谁挡着 ——
 *   而「先做哪个 / 等谁 / 催谁」这三个后续问题，一个数字一个都答不了
 *   （问题记录 #21）。
 */

beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh' });
});

const dep = (over: Partial<Parameters<typeof DependencyChain>[0]['card']> = {}) => ({
  unmetDependencies: 1,
  blockedBy: [
    { id: 'u1', ref: 'TEST-7', title: '搭好页面骨架', status: 'done', type: 'finish_to_start', met: true },
    { id: 'u2', ref: 'TEST-9', title: '接上存储', status: 'executing', type: 'finish_to_start', met: false },
  ],
  blocking: [
    { id: 'd1', ref: 'TEST-12', title: '打包成桌面应用', status: 'ready', type: null, met: false },
  ],
  ...over,
});

describe('依赖链', () => {
  it('★ 两个方向都要有 —— 只给上游答不了「先做哪个」', async () => {
    render(<DependencyChain card={dep()} onOpen={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /依赖/ }));

    expect(screen.getByText('在等（2）')).toBeInTheDocument();
    expect(screen.getByText('挡着（1）')).toBeInTheDocument();
    expect(screen.getByText('TEST-9')).toBeInTheDocument();
    expect(screen.getByText('TEST-12')).toBeInTheDocument();
  });

  it('★ 依赖上的每一条都点得进去 —— 目标可能不在当前这一屏卡片里', async () => {
    const onOpen = vi.fn();
    render(<DependencyChain card={dep()} onOpen={onOpen} />);

    await userEvent.click(screen.getByRole('button', { name: /依赖/ }));
    await userEvent.click(screen.getByRole('button', { name: /TEST-12/ }));
    expect(onOpen).toHaveBeenCalledWith('d1');
  });

  /**
   * ★★ 整张卡片外层挂着「点开详情」。不挡冒泡的话，一次点击同时触发两个
   *   handler —— 抽屉开了、气泡也开了，用户体感是「点了没反应」（#30）。
   */
  it('★ 展开徽标不会连带触发外层卡片的点击', async () => {
    const outer = vi.fn();
    render(
      <div onClick={outer}>
        <DependencyChain card={dep()} onOpen={vi.fn()} />
      </div>,
    );

    await userEvent.click(screen.getByRole('button', { name: /依赖/ }));
    expect(outer).not.toHaveBeenCalled();
  });

  it('没有任何依赖时整个徽标都不渲染 —— 一个恒为 0 的标记只是噪声', () => {
    render(
      <DependencyChain
        card={{ unmetDependencies: 0, blockedBy: [], blocking: [] }}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('全部依赖都满足时仍然显示 —— 那时它挡着的下游才是重点', async () => {
    render(
      <DependencyChain
        card={dep({ unmetDependencies: 0, blockedBy: [] })}
        onOpen={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /依赖/ }));
    expect(screen.getByText('没有东西挡着它')).toBeInTheDocument();
    expect(screen.getByText('TEST-12')).toBeInTheDocument();
  });
});
