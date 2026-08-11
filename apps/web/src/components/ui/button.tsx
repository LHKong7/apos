import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * shadcn/ui Button（new-york）。
 *
 * ★ 与上游的差异都在这里说明，免得下次对照上游时以为是被谁改坏了：
 *
 *   1. 多了 `xs` 尺寸。这个界面密度很高 —— 看板卡片上的「催办 / 接管 / 重试」
 *      是 11px 字的小按钮，上游最小的 `sm`（h-8 / 14px 字）放进卡片会把
 *      卡片高度顶出一截，而卡片高度一乱，整列的扫视节奏就没了。
 *   2. `gate` 变体。Human Gate 是这个产品的核心概念，全站「处理 →」按钮
 *      用的是琥珀色语义槽位而不是品牌色 —— 它表达的是「在等你」，
 *      和「主行动」不是一回事。
 *   3. 焦点环用 `ring-ring`，而 index.css 里还有一条全局 :focus-visible
 *      outline。两者叠加是刻意的：outline 在高对比模式下仍然可见。
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-sm hover:brightness-110',
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:brightness-110',
        outline:
          'border border-input bg-transparent shadow-sm hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:brightness-95',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
        /** Human Gate：在等你处理。全站唯一用琥珀底的按钮 */
        gate: 'bg-gate text-white shadow-sm hover:brightness-110',
        /**
         * ★★ 反色按钮 —— 这个产品实际的「主行动」，全站 30+ 处。
         *
         *   它不是 shadcn 的 `default`（品牌蓝）。`bg-slate-900 text-white`
         *   在这套色板里是**反色**：浅色主题下是深底白字，深色主题下
         *   slate-900 反转成近白、--c-white 是深蓝灰，于是变成白底深字。
         *   两边都成立，而且都比品牌蓝更克制 —— 品牌色在这里是留给
         *   导航、焦点环与「正在发生」的（见 tailwind.config 的注释）。
         *
         *   单列一个变体而不是映射到 default：映射过去会把全站主按钮
         *   一次性刷成蓝色，那是改设计，不是换组件库。
         */
        neutral: 'bg-slate-900 text-white shadow-sm hover:bg-slate-700',
      },
      size: {
        default: 'h-9 px-4 py-2 text-sm',
        sm: 'h-8 rounded-md px-3 text-[13px]',
        /** 卡片内联操作。与 BoardCard 上的 11px 文字对齐 */
        xs: 'h-6 rounded-md px-2 text-[11px]',
        lg: 'h-10 rounded-md px-6 text-sm',
        icon: 'h-9 w-9',
        'icon-sm': 'h-7 w-7 rounded-md',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** 渲染成子元素（配合 react-router 的 Link 用）而不是套一层 button */
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        /**
         * ★ 默认 `type="button"`。原生默认是 submit —— 表单里放一个没写 type
         *   的按钮，点它会把表单提交掉并刷新页面。这个坑在 SPA 里表现为
         *   「点了个无关按钮，整个应用重载了」，而且只在被 <form> 包住时才犯。
         */
        type={asChild ? undefined : (type ?? 'button')}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
