import { screen } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

/**
 * 驱动 Radix Select 的测试小件。
 *
 * ★★ 为什么不能继续用 `user.selectOptions` —— 它只认原生 `<select>`：
 *   实现里直接找 `HTMLSelectElement` 和它的 `<option>`。Radix 的下拉是
 *   `button[role=combobox]` 加一个 portal 里的 `div[role=option]` 列表，
 *   而且**选项在打开之前根本不在 DOM 里**。所以必须先点触发器。
 *
 * ★ 匹配从 option 的 `value` 改成**可见文案**。这其实是好事：
 *   原来断言的 `'write'` 是内部取值，用户永远看不到；现在断言的是
 *   界面上那三个字，测试跟着用户看到的东西走。
 *
 * A Radix dropdown is a combobox button plus a portaled option list that does
 * not exist until it is opened, so `user.selectOptions` (native-only) no longer
 * applies. Matching moves from the option's value to its visible text.
 */

/** 打开一个 Radix Select 并按可见文案选中某一项 */
export async function selectOption(
  user: UserEvent,
  trigger: HTMLElement,
  name: string | RegExp,
): Promise<void> {
  await user.click(trigger);
  await user.click(await screen.findByRole('option', { name }));
}

/** 打开一个 Radix Select，返回它此刻列出的选项 —— 断言「列了哪些」用 */
export async function openOptions(user: UserEvent, trigger: HTMLElement): Promise<HTMLElement[]> {
  await user.click(trigger);
  return screen.findAllByRole('option');
}
