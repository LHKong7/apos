import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check, Minus } from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * shadcn/ui Checkbox（new-york）。
 *
 * ★★ 为什么值得从原生 `<input type="checkbox">` 换过来 —— 原生勾选框
 *   **样式不可控**：`background` / `border` / `border-radius` 在
 *   `appearance:auto` 下多数被浏览器忽略，唯一能改的只有 `accent-color`。
 *   代价是勾选框在三个地方对不上这套设计：尺寸各浏览器不一（Chrome 13px、
 *   Safari 又是一档）、圆角是系统的、深色主题下那个白底方块压根不跟着翻转。
 *   Radix 用 `<button role="checkbox">` 重画，这三样才归我们管。
 *
 * ★★ 换来的代价要认：原生勾选框在读屏器和移动端上是**免费且正确**的，
 *   自绘的要靠 Radix 补 `role` / `aria-checked` / 空格键 / 表单回填。
 *   这也是为什么单选框没跟着换 —— radio 的键盘约定（方向键在组内移动、
 *   Tab 只进出一次）比 checkbox 复杂得多，要换得整组换成 RadioGroup，
 *   不是逐个替换能做对的。全站唯一那处 radio 仍然走 `<Input type="radio">`。
 *
 * ★ tone 只有三档，对应替换前实际用过的三种 `accent-*`：
 *   品牌蓝（默认）、反色（视图开关那类，不跟内容抢注意力）、红（删除/超预算）。
 *   不做成随便传颜色 —— 勾选框的颜色是有语义的，开成自由色板必然长歪。
 */
const checkboxVariants = cva(
  [
    'group peer inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center border shadow-sm transition-colors',
    /**
     * ★ 不用 `rounded-sm`：tailwind.config 把全站圆角整体放大了一档
     *   （sm = 6px），6px 套在 14px 的方块上会圆成一颗药丸。
     *   勾选框要的是原生那种 4px。
     */
    'rounded-[0.25rem]',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
    'disabled:cursor-not-allowed disabled:opacity-50',
    /**
     * ★ 填充色写在 base、空心态写在 `data-[state=unchecked]:` 上，
     *   而不是反过来。这样 checked 与 indeterminate 天然共用同一套填充，
     *   不必每个 tone 里把两条选择器各抄一遍。
     *   属性选择器的优先级高于纯类名，未选中态盖得住。
     */
    'data-[state=unchecked]:border-input data-[state=unchecked]:bg-white',
  ],
  {
    variants: {
      tone: {
        brand: 'border-primary bg-primary text-primary-foreground',
        /** 反色。与 Button 的 `neutral` 同一套路：浅色下深底白勾，深色下自动翻转 */
        neutral: 'border-slate-900 bg-slate-900 text-white',
        destructive: 'border-destructive bg-destructive text-destructive-foreground',
      },
    },
    defaultVariants: { tone: 'brand' },
  },
);

export interface CheckboxProps
  extends Omit<React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>, 'onCheckedChange'>,
    VariantProps<typeof checkboxVariants> {
  /**
   * ★ 收窄成 boolean，不透传 Radix 的 `CheckedState`（boolean | 'indeterminate'）。
   *   不是偷懒：Radix 点击时算出的新值是 `isIndeterminate ? true : !checked`，
   *   **永远不会回调 'indeterminate'** —— 半选只能由外部通过 `checked` 传进来。
   *   所以这里丢不掉信息，却省掉了每个调用点一句 `v === true` 的收窄。
   */
  onCheckedChange?: (checked: boolean) => void;
}

const Checkbox = React.forwardRef<React.ElementRef<typeof CheckboxPrimitive.Root>, CheckboxProps>(
  ({ className, tone, onCheckedChange, ...props }, ref) => (
    <CheckboxPrimitive.Root
      ref={ref}
      className={cn(checkboxVariants({ tone }), className)}
      onCheckedChange={onCheckedChange && ((state) => onCheckedChange(state === true))}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        {/* 半选那根横线：全选框「选了一部分」时用，勾和横线同时只显示一个 */}
        <Check className="h-2.5 w-2.5 group-data-[state=indeterminate]:hidden" strokeWidth={3.5} />
        <Minus className="hidden h-2.5 w-2.5 group-data-[state=indeterminate]:block" strokeWidth={3.5} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  ),
);
Checkbox.displayName = 'Checkbox';

export { Checkbox, checkboxVariants };
