import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

/**
 * ★ globals: false 时 Testing Library 不会自动注册 cleanup，
 *   DOM 会在测试之间累积 —— 表现为「找到多个同名元素」，
 *   而且是从上一个用例漏过来的，非常误导。必须显式清理。
 */
afterEach(cleanup);

/**
 * ★★ Radix 自绘控件在 jsdom 里缺三样浏览器 API：指针捕获、scrollIntoView、
 *   ResizeObserver。jsdom 没实现，而 Radix 在「打开下拉」这条路径上直接调用
 *   它们 —— 表现是 `user.click(trigger)` 抛
 *   `target.hasPointerCapture is not a function`，而不是「找不到选项」。
 *   报错指向 user-event 内部，完全不指向缺 API。
 *
 *   全站原生 select 换成 Radix Select（2026-08-18）之后，这几个桩是所有
 *   下拉测试的前提，所以放在全局 setup 里而不是各测试文件自己补。
 *
 *   jsdom implements none of pointer capture, scrollIntoView, or
 *   ResizeObserver, and Radix calls all three while opening a dropdown. The
 *   resulting stack points into user-event internals rather than at the missing
 *   API, so these stubs live in the global setup.
 */
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
