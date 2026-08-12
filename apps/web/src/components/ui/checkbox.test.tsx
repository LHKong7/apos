import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Checkbox } from './checkbox';

/**
 * Checkbox 换成 Radix 自绘控件之后，原生勾选框「白送」的那几件事全部
 * 变成了需要有人验的事。这一组盯的就是它们：
 *
 * ★★ 最要紧的是**包在 `<label>` 里点标签文字**。全站 17 处勾选框里有 12 处
 *   写成 `<label><Checkbox/> 文字</label>`，靠的是 label 把点击转发给控件。
 *   原生 input 一定成立；换成 `<button role="checkbox">` 之后就取决于
 *   「button 算不算 labelable element」—— 算，但另一半风险是**转发转两次**
 *   （点在控件上，冒泡到 label，label 再转发回来），那表现是「点一下没反应」，
 *   因为切过去又切回来了。所以下面两条一条测「点得动」，一条测「只动一次」。
 */

/** 受控用法，与调用点写法一致 */
function Harness({
  onChange,
  disabled,
  label = '同时终止正在运行的 Agent Run',
}: {
  onChange?: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [checked, setChecked] = useState(false);
  return (
    <label>
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => {
          setChecked(v);
          onChange?.(v);
        }}
      />
      {label}
    </label>
  );
}

describe('Checkbox', () => {
  it('渲染成 role=checkbox，未选中时 aria-checked 为 false', () => {
    render(<Checkbox checked={false} aria-label="全选" />);
    expect(screen.getByRole('checkbox', { name: '全选' })).toHaveAttribute('aria-checked', 'false');
  });

  it('默认 type=button —— 表单里的勾选框不能顺手把表单提交了', () => {
    render(<Checkbox aria-label="组织共享" />);
    expect(screen.getByRole('checkbox')).toHaveAttribute('type', 'button');
  });

  it('点勾选框本身会切换', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
  });

  // ★★ 12 处调用点靠这条成立
  it('包在 <label> 里时，点标签文字也能切换', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} label="高风险决策不受免打扰限制" />);
    await userEvent.click(screen.getByText('高风险决策不受免打扰限制'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
  });

  // ★★ 反向：label 的转发不能让点在控件上的那一次算两遍
  it('点 <label> 内的勾选框本身不会切换两次', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
  });

  it('空格键可切换 —— 自绘控件的键盘操作要自己保证', async () => {
    render(<Harness />);
    const box = screen.getByRole('checkbox');
    box.focus();
    await userEvent.keyboard(' ');
    expect(box).toHaveAttribute('aria-checked', 'true');
  });

  // ★ Roles / NotificationPanel 是 disabled + 包在 label 里，两条路都得堵住 ——
  //   只堵控件本身的话，没权限的人点一下标签文字照样能改
  it('disabled 时点控件和点标签文字都不动', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} disabled label="允许 Agent 担任" />);

    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByText('允许 Agent 担任'));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'false');
  });

  it('半选态的可达性状态是 mixed，且点一下回调收到的是 true 而不是 indeterminate', async () => {
    const onChange = vi.fn();
    render(<Checkbox checked="indeterminate" onCheckedChange={onChange} aria-label="全选" />);
    const box = screen.getByRole('checkbox');
    expect(box).toHaveAttribute('aria-checked', 'mixed');

    await userEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
