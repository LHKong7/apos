import { useCallback, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useLocaleStore } from '../../lib/i18n';
import userEvent from '@testing-library/user-event';
import { JsonInput } from './AgentConfig';

/**
 * The JSON input inside the runtime config (Agent config page → Runtime) /
 * 运行时配置里那个 JSON 输入框。
 *
 * ★ This suite checks what happens when parsing fails.
 *
 *   The JSON input has to keep its text in local state — parsing on every
 *   keystroke fails halfway through a value (`{"A":`), and resetting the field
 *   back to the last valid object would wipe out what the user is still typing.
 *   The price is that while parsing fails, `config` stays at the last valid
 *   value, so hitting save anyway persists the version from before the user's
 *   edit while the UI reports success.
 *
 *   That is why this box must push its error up to the form to disable the save
 *   button, and why that error has to **stick**.
 *
 *   解析失败时值停在上一个合法对象，所以错误必须顶到表单上禁用保存，
 *   而且要留得住 —— 否则存下的是用户改之前的那份，界面还说保存成功。
 */

/**
 * Collects the errors, standing in for the form's own jsonErrors / 把错误收集
 * 起来，模拟表单那一侧的 jsonErrors。
 *
 * @param stableCallback When false, a fresh onError is created on every render
 *   — the most natural thing a caller writes, and the component has to survive
 *   it (see the "even when onError changes every render" case below).
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

/**
 * ★ Pinned to Chinese: these assertions match exact validation wording, while
 *   the app default is English.
 *   钉住中文：下面断言的是具体那句校验提示，而默认语言是英文。
 */
beforeEach(() => useLocaleStore.setState({ locale: 'zh' }));

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
    // A half-typed JSON must not be raised as a valid change
    expect(onValue).not.toHaveBeenCalled();
    // What the user is typing stays verbatim; nothing was reset
    expect(box).toHaveValue('{"ANTHROPIC_BASE_URL"');
  });

  /**
   * ★★ This one guards against a bug we actually shipped.
   *
   *   With onError in the effect's dependency array and a caller passing a
   *   freshly created arrow function on every render, the cleanup runs again on
   *   every render — the error just recorded is immediately cleared by itself,
   *   and the save button is never disabled. The user clicks save while staring
   *   at red error text, what gets persisted is the version from before their
   *   edit, and the UI still reports success.
   *
   *   Rather than requiring every caller to remember useCallback, the component
   *   absorbs it.
   */
  it('即使 onError 每次渲染都换一个，错误也留得住', async () => {
    render(<Host stableCallback={false} />);

    await userEvent.type(screen.getByRole('textbox'), '{{"A"');
    expect(screen.getByTestId('errors')).toHaveTextContent('env');

    // A few more keystrokes to force more renders; cleanup must not erase the error
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

    // userEvent reads `[` / `{` as key descriptors, so a literal one is typed twice
    await userEvent.type(screen.getByRole('textbox'), '[["A=1"]');
    expect(screen.getByText(/必须是 JSON 对象/)).toBeInTheDocument();
    expect(screen.getByTestId('errors')).toHaveTextContent('env');
  });

  /**
   * ★ This box disappears when the advanced options collapse or the editor
   *   switches modes. An error it leaves behind would disable the save button
   *   forever, with nothing on the page to show where the complaint came from.
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
