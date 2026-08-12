import { useCallback, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JsonInput } from './AgentConfig';

/**
 * 运行时配置里那个 JSON 输入框（Agent 配置页 → 运行时）。
 *
 * ★ 这一组验的是「解析不通过时会发生什么」。
 *
 *   JSON 输入必须把文本留在本地 state —— 边打字边解析会在敲到一半
 *   （`{"A":`）时判定失败，把值重置回上一个合法对象会当场清掉用户
 *   正在敲的内容。代价是解析失败时 config 停在上一个合法值，
 *   于是「继续保存」会存下用户改之前的那份，而界面显示保存成功。
 *
 *   所以这个框必须把错误顶到表单上去禁用保存按钮，
 *   而且那条错误要**留得住**。
 */

/**
 * 把错误收集起来，模拟表单那一侧的 jsonErrors。
 *
 * @param stableCallback 传 false 时每次渲染新建一个 onError —— 这是调用方
 *   最自然的写法，组件必须扛得住（见「即使 onError 每次渲染都换」那一条）。
 */
function Host({
  onValue,
  stableCallback = true,
}: {
  onValue?: (v: Record<string, unknown>) => void;
  stableCallback?: boolean;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const record = useCallback((key: string, message: string | null) => {
    setErrors((prev) => {
      if (message === null) {
        if (!(key in prev)) return prev;
        const { [key]: _dropped, ...rest } = prev;
        return rest;
      }
      return prev[key] === message ? prev : { ...prev, [key]: message };
    });
  }, []);

  const [mounted, setMounted] = useState(true);
  const onError = stableCallback ? record : (k: string, m: string | null) => record(k, m);

  return (
    <div>
      {mounted && (
        <JsonInput errorKey="env" value={{}} onChange={onValue ?? (() => {})} onError={onError} />
      )}
      <button type="button" onClick={() => setMounted(false)}>
        卸载
      </button>
      <span data-testid="errors">{Object.keys(errors).join(',') || '（无）'}</span>
    </div>
  );
}

describe('运行时配置的 JSON 输入框', () => {
  it('合法 JSON 对象往上抛解析结果', async () => {
    const onValue = vi.fn();
    render(<Host onValue={onValue} />);

    await userEvent.type(
      screen.getByRole('textbox'),
      '{{"ANTHROPIC_BASE_URL": "https://gw.example.com"}',
    );

    expect(onValue).toHaveBeenLastCalledWith({ ANTHROPIC_BASE_URL: 'https://gw.example.com' });
    expect(screen.getByTestId('errors')).toHaveTextContent('（无）');
  });

  it('解析失败时报错、不往上抛值，且错误在后续渲染里留得住', async () => {
    const onValue = vi.fn();
    render(<Host onValue={onValue} />);

    const box = screen.getByRole('textbox');
    await userEvent.type(box, '{{"ANTHROPIC_BASE_URL"');

    expect(screen.getByTestId('errors')).toHaveTextContent('env');
    // 半截 JSON 不能被当成一次有效修改抛上去
    expect(onValue).not.toHaveBeenCalled();
    // 用户正在敲的内容原样留着，没有被重置
    expect(box).toHaveValue('{"ANTHROPIC_BASE_URL"');
  });

  /**
   * ★★ 这条盯的是一个真实踩过的坑。
   *
   *   把 onError 放进 effect 的依赖数组、而调用方传的是每次渲染新建的
   *   箭头函数时，清理副作用会在每次渲染时重跑一遍 —— 刚记下的错误
   *   当场被自己清掉，保存按钮永远不会被禁。用户对着一段红字报错点保存，
   *   存进去的是他改之前的那份，界面还显示保存成功。
   *
   *   与其要求每个调用方记得 useCallback，不如让组件自己扛住。
   */
  it('即使 onError 每次渲染都换一个，错误也留得住', async () => {
    render(<Host stableCallback={false} />);

    await userEvent.type(screen.getByRole('textbox'), '{{"A"');
    expect(screen.getByTestId('errors')).toHaveTextContent('env');

    // 再敲几下逼出更多次渲染，错误不该被 cleanup 抹掉
    await userEvent.type(screen.getByRole('textbox'), ': ');
    expect(screen.getByTestId('errors')).toHaveTextContent('env');
  });

  it('改对之后错误消失', async () => {
    render(<Host />);

    const box = screen.getByRole('textbox');
    await userEvent.type(box, '{{"A"');
    expect(screen.getByTestId('errors')).toHaveTextContent('env');

    await userEvent.type(box, ': "b"}');
    expect(screen.getByTestId('errors')).toHaveTextContent('（无）');
  });

  it('数组与标量不是合法的配置对象', async () => {
    render(<Host />);

    // userEvent 把 `[` / `{` 当按键描述符，输入字面量要写两遍
    await userEvent.type(screen.getByRole('textbox'), '[["A=1"]');
    expect(screen.getByText(/必须是 JSON 对象/)).toBeInTheDocument();
    expect(screen.getByTestId('errors')).toHaveTextContent('env');
  });

  /**
   * ★ 高级选项收起来、或者切到别的编辑模式时这个框会消失。
   *   它留下的那条错误会永远禁着保存按钮 —— 而页面上找不到是谁在报错。
   */
  it('卸载时清掉自己的错误，不留下一个找不到出处的禁用状态', async () => {
    render(<Host />);

    await userEvent.type(screen.getByRole('textbox'), '{{');
    expect(screen.getByTestId('errors')).toHaveTextContent('env');

    await userEvent.click(screen.getByRole('button', { name: '卸载' }));
    expect(screen.getByTestId('errors')).toHaveTextContent('（无）');
  });

  it('清空等于空表，不算错误', async () => {
    const onValue = vi.fn();
    render(<Host onValue={onValue} />);

    const box = screen.getByRole('textbox');
    await userEvent.type(box, '{{"A": "b"}');
    await userEvent.clear(box);

    expect(onValue).toHaveBeenLastCalledWith({});
    expect(screen.getByTestId('errors')).toHaveTextContent('（无）');
  });
});
