import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * shadcn/ui Alert（new-york）+ 语义变体。
 *
 * ★ 这个产品里「说明状况」的场景很多（连接断了、计划未批准、项目已暂停、
 *   Agent 未接入…），此前每处各写一段 div + 配色。收进变体之后，
 *   「什么级别用什么颜色」由变体名决定，不再靠每处自己记。
 */
const alertVariants = cva(
  'relative w-full rounded-lg border px-3 py-2 text-xs [&>svg]:absolute [&>svg]:left-3 [&>svg]:top-2.5 [&>svg]:h-4 [&>svg]:w-4 [&>svg~*]:pl-6',
  {
    variants: {
      variant: {
        default: 'border-border bg-card text-card-foreground',
        info: 'border-brand/30 bg-brand/10 text-foreground [&>svg]:text-brand',
        warning: 'border-amber-200 bg-amber-50 text-amber-800 [&>svg]:text-amber-600',
        destructive: 'border-destructive/30 bg-destructive/10 text-destructive [&>svg]:text-destructive',
        /** 在等人拍板 */
        gate: 'border-gate/30 bg-gate/10 text-foreground [&>svg]:text-gate',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, ...props }, ref) => (
  <div ref={ref} role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
));
Alert.displayName = 'Alert';

const AlertTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h5 ref={ref} className={cn('mb-0.5 font-medium leading-none', className)} {...props} />
  ),
);
AlertTitle.displayName = 'AlertTitle';

const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('leading-5 [&_p]:leading-5', className)} {...props} />
));
AlertDescription.displayName = 'AlertDescription';

export { Alert, AlertTitle, AlertDescription };
