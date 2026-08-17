import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLocaleStore } from '../lib/i18n';
import { ResourceScopeEditor, type ScopeRow } from './ResourceScopeEditor';

/**
 * 资源范围编辑器。
 *
 * ★★ 这一组守的是一条**授权**不变式，不是表单体验：
 *   **打开表单再保存，不能少掉任何一条授权。**
 *
 *   它替换掉的那个表单只有两格（一个仓库 + 一个数据集），而数据模型一直
 *   支持任意多条 —— 于是编辑一个授权了三个仓库的 Agent，保存会把另外两条
 *   静默删掉。撤销一条授权本该是一个决定，在那个表单里它是打开页面点保存
 *   的副作用，而且页面上从来没显示过那两条。
 */

vi.mock('../lib/api/client', () => ({
  api: {
    repositories: vi.fn(async () => ({
      repositories: [
        { ref: 'order-service', name: 'Order Service' },
        { ref: 'payment-service', name: 'Payment Service' },
        { ref: 'inventory', name: 'Inventory' },
      ],
    })),
    storageTargets: vi.fn(async () => ({
      storageTargets: [{ ref: 'orders-2024', name: '订单数据集' }],
    })),
  },
}));

function Host({ initial }: { initial: ScopeRow[] }) {
  const [value, setValue] = useState<ScopeRow[]>(initial);
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ResourceScopeEditor value={value} onChange={setValue} />
      <output data-testid="state">{JSON.stringify(value)}</output>
    </QueryClientProvider>
  );
}

const state = () => JSON.parse(screen.getByTestId('state').textContent ?? '[]') as ScopeRow[];

beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh' });
});

describe('★ 编辑不丢授权', () => {
  /**
   * ★★ 这一条就是那个 bug 的回归测试。
   *   三个仓库进来，三个仓库出去 —— 上一版表单在这里会剩下一个。
   */
  it('三条仓库授权全部渲染出来，一条不少', () => {
    render(
      <Host
        initial={[
          { kind: 'repo', ref: 'order-service', access: 'write' },
          { kind: 'repo', ref: 'payment-service', access: 'read' },
          { kind: 'repo', ref: 'inventory', access: 'read' },
        ]}
      />,
    );

    expect(state()).toHaveLength(3);
    expect(screen.getAllByLabelText('资源')).toHaveLength(3);
  });

  it('改其中一条不会动到其余几条', async () => {
    const user = userEvent.setup();
    render(
      <Host
        initial={[
          { kind: 'repo', ref: 'order-service', access: 'write' },
          { kind: 'repo', ref: 'payment-service', access: 'read' },
          { kind: 'dataset', ref: 'orders-2024', access: 'read' },
        ]}
      />,
    );

    await user.selectOptions(screen.getAllByLabelText('访问级别')[1]!, 'write');

    const after = state();
    expect(after).toHaveLength(3);
    expect(after[0]).toEqual({ kind: 'repo', ref: 'order-service', access: 'write' });
    expect(after[1]!.access).toBe('write');
    expect(after[2]).toEqual({ kind: 'dataset', ref: 'orders-2024', access: 'read' });
  });

  it('删掉一条只删那一条', async () => {
    const user = userEvent.setup();
    render(
      <Host
        initial={[
          { kind: 'repo', ref: 'order-service', access: 'write' },
          { kind: 'repo', ref: 'payment-service', access: 'read' },
        ]}
      />,
    );

    await user.click(screen.getAllByRole('button', { name: '移除' })[0]!);

    expect(state()).toEqual([{ kind: 'repo', ref: 'payment-service', access: 'read' }]);
  });

  it('能一直加下去，不是固定两格', async () => {
    const user = userEvent.setup();
    render(<Host initial={[]} />);

    await user.click(screen.getByRole('button', { name: /授权一个资源/ }));
    await user.click(screen.getByRole('button', { name: /授权一个资源/ }));
    await user.click(screen.getByRole('button', { name: /授权一个资源/ }));

    expect(state()).toHaveLength(3);
  });
});

describe('★ ref 从登记表里选', () => {
  /**
   * ★ 手打的 ref 敲错一个字母，表现是任务在准备工作区那一步失败，
   *   而报错说的是「挂载失败」—— 它不指向「你写的这个仓库不存在」。
   */
  it('仓库这一格列出已登记的仓库', async () => {
    render(<Host initial={[{ kind: 'repo', ref: '', access: 'read' }]} />);

    expect(await screen.findByRole('option', { name: /Order Service/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /Payment Service/ })).toBeTruthy();
  });

  /**
   * ★★ 库里已有、但登记表里查不到的 ref 必须留着。
   *   清掉的话，打开表单这个动作本身就撤销了一条授权 ——
   *   而那正是这个组件要修的那个 bug 的另一种形态。
   */
  it('登记表里查不到的 ref 保留，并标明未登记', async () => {
    render(<Host initial={[{ kind: 'repo', ref: 'legacy-repo', access: 'read' }]} />);

    expect(await screen.findByRole('option', { name: /legacy-repo（未登记）/ })).toBeTruthy();
    expect(state()[0]!.ref).toBe('legacy-repo');
  });

  /** ★ 没有登记表的类型（外部服务）仍然要能填，否则它根本配不进去 */
  it('没有登记表的类型给输入框', async () => {
    const user = userEvent.setup();
    render(<Host initial={[{ kind: 'external_service', ref: '', access: 'read' }]} />);

    await user.type(screen.getByLabelText('资源'), 'stripe');
    expect(state()[0]!.ref).toBe('stripe');
  });
});

describe('★ 撤销一条默认授权', () => {
  /**
   * ★★ `none` 必须选得到。
   *   删掉一条等于回落到「项目仓库默认只读」，而 none 是显式的「这个不给」——
   *   撤销一条**默认**授权只有这一种写法（见 domain 的 effectiveResourceScopes）。
   */
  it('访问级别里有「禁止」', async () => {
    const user = userEvent.setup();
    render(<Host initial={[{ kind: 'repo', ref: 'order-service', access: 'read' }]} />);

    await user.selectOptions(screen.getByLabelText('访问级别'), 'none');
    expect(state()[0]!.access).toBe('none');
  });
});
