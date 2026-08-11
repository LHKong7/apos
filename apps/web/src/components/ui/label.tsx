import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * shadcn/ui Label（new-york）。
 *
 * ★ 用 Radix 的 Label 而不是原生 <label>：它会把点击转发到关联控件上，
 *   包括那些「看起来是控件、其实是 div」的自定义组件（Radix 的 Select、
 *   Checkbox 都是这类）。原生 label 的 htmlFor 对它们不生效 ——
 *   表现是「点标签没反应」，而 a11y 检查也过不了。
 */
const labelVariants = cva(
  'text-xs font-medium leading-none text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
);

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & VariantProps<typeof labelVariants>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root ref={ref} className={cn(labelVariants(), className)} {...props} />
));
Label.displayName = LabelPrimitive.Root.displayName;

export { Label };
