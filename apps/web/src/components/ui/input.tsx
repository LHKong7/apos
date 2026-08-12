import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * shadcn/ui Input（new-york）。
 *
 * ★ 高度取 h-8 而不是上游的 h-9：这个界面的表单大量出现在抽屉与弹层里，
 *   一屏要放下六七个字段。上游那一档是为落地页尺度调的。
 *
 * ★★ radio 不套那串基础类，原样透传 className。上游这个组件只考虑文本框：
 *   `w-full` 会把单选框撑成占满整行的方块，`shadow-sm` 会给它描一圈阴影
 *   （box-shadow 是少数几个原生单选框仍然认的属性），`border` `rounded-md`
 *   `px-2.5` 则各浏览器认不认都不一样。单选框的绘制归浏览器管，
 *   颜色靠 `accent-*`（全局默认在 index.css 里设成了品牌色）。
 *
 * ★ 勾选框已经搬去 `ui/checkbox.tsx`（Radix 自绘），这里只剩 radio。
 *   没跟着搬是因为 radio 的键盘约定要整组一起换成 RadioGroup 才对
 *   —— 理由写在 checkbox.tsx 的注释里。
 */
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => {
    const checkable = type === 'checkbox' || type === 'radio';
    return (
      <input
        ref={ref}
        type={type}
        className={cn(
          !checkable && [
            'flex h-8 w-full rounded-md border border-input bg-transparent px-2.5 py-1 text-xs shadow-sm transition-colors',
            'placeholder:text-muted-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'file:border-0 file:bg-transparent file:text-xs file:font-medium file:text-foreground',
          ],
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';

export { Input };
