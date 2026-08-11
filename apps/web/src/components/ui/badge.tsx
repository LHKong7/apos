import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * shadcn/ui Badge（new-york）+ 本产品的状态语义变体。
 *
 * ★ 上游只有 default/secondary/destructive/outline 四种，那是通用库的取舍。
 *   这个界面靠颜色传递状态信息（页面文档 05 §5.3），所以把 gate / blocked /
 *   agent / overdue 这几个语义槽位也做成变体 —— 让「用哪个颜色」这件事
 *   由变体名决定，而不是每处自己拼 `bg-amber-50 text-amber-800`。
 *   散落的拼法是主题走样的主要来源：换主题时总有几处漏改。
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary/15 text-primary',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive/15 text-destructive',
        outline: 'border-border text-foreground',
        muted: 'border-transparent bg-muted text-muted-foreground',
        /** 在等人拍板 */
        gate: 'border-transparent bg-gate/15 text-gate',
        /** 超时 —— 比 destructive 更强，会配合卡片的发光一起用 */
        overdue: 'border-transparent bg-overdue/15 text-overdue',
        /** 被前置条件卡住 */
        blocked: 'border-transparent bg-blocked/15 text-blocked',
        /** 机器在做 —— 全站唯一的「Agent 色」 */
        agent: 'border-transparent bg-agent/15 text-agent',
        success: 'border-transparent bg-emerald-100 text-emerald-700',
        warning: 'border-transparent bg-amber-100 text-amber-800',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
