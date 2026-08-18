import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * shadcn/ui Select（new-york）。
 *
 * ★★ 与原生 <select> 的取舍：原生的可达性和移动端体验其实更好，但它有
 *   一条硬伤 —— **选项列表完全无法样式化**。深色主题下，原生下拉弹出的是
 *   操作系统的浅色列表，白底黑字直接糊在深色界面上。这个项目有深浅两套
 *   主题，所以这里必须换。
 *
 * ★ 代价要认：Radix 的 Select 是 div 拼出来的，移动端没有原生滚轮选择器。
 *
 * ★★ 2026-08-18：**已全站替换**，上面那条「表单里的原生 select 可以留着」
 *   的分档作废。理由是分档本身没守住 —— 深浅主题下同一个页面里两种下拉
 *   长得不一样（表单里是操作系统的浅色列表，筛选器是自绘的），
 *   而「哪个算筛选器」没有客观判据，于是新代码随手挑一种。
 *   移动端滚轮选择器的损失是明知故犯的代价，不是疏忽。
 *
 *   As of 2026-08-18 every native select in the app has been migrated; the
 *   earlier "leave plain form selects native" carve-out is withdrawn. The
 *   carve-out had no objective boundary, so the two kinds of dropdown ended up
 *   side by side on the same page, looking different in dark mode. Losing the
 *   native mobile wheel picker is an accepted cost, not an oversight.
 */
const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

/**
 * ★★ 空串哨兵。Radix 把空串**保留**给「未选中」这个内部状态，
 *   `<SelectItem value="">` 会直接抛错。而这套界面里到处是「全部执行者 /
 *   自动分配 / 不适用 / 不设兜底」这类选项，它们原本就是 `value=""`，
 *   对应后端的 undefined —— 语义上确实是「没选」，但必须能被点中。
 *
 *   所以在组件边界上转换：进 Select 前 `toSelectValue`，出来 `fromSelectValue`。
 *   哨兵值取一个不可能与真实取值（UUID / 枚举 / 角色名）相撞的形状。
 *
 *   Radix reserves the empty string for its own "nothing selected" state, so
 *   `<SelectItem value="">` throws. This app is full of options that mean
 *   exactly that ("all executors", "auto-assign", "not applicable") and which
 *   map to undefined server-side — semantically unselected, yet they still have
 *   to be clickable. Convert at the component boundary instead, using a
 *   sentinel that cannot collide with a real value (UUID, enum, role name).
 */
const SELECT_EMPTY = '__empty__';

/** 空串/null → 哨兵，供 Select 的 value 用 */
const toSelectValue = (value: string | null | undefined): string => value || SELECT_EMPTY;

/** 哨兵 → 空串，交还给原来的 onChange 语义 */
const fromSelectValue = (value: string): string => (value === SELECT_EMPTY ? '' : value);

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      'flex h-8 w-full items-center justify-between gap-1 rounded-md border border-input bg-transparent px-2.5 py-1 text-xs shadow-sm transition-colors',
      'placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 focus:ring-offset-background',
      'disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1',
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectScrollUpButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollUpButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton
    ref={ref}
    className={cn('flex cursor-default items-center justify-center py-1', className)}
    {...props}
  >
    <ChevronUp className="h-3.5 w-3.5" />
  </SelectPrimitive.ScrollUpButton>
));
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName;

const SelectScrollDownButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollDownButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton
    ref={ref}
    className={cn('flex cursor-default items-center justify-center py-1', className)}
    {...props}
  >
    <ChevronDown className="h-3.5 w-3.5" />
  </SelectPrimitive.ScrollDownButton>
));
SelectScrollDownButton.displayName = SelectPrimitive.ScrollDownButton.displayName;

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = 'popper', ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      className={cn(
        'relative z-50 max-h-96 min-w-32 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg',
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        position === 'popper' &&
          'data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1',
        className,
      )}
      position={position}
      {...props}
    >
      <SelectScrollUpButton />
      <SelectPrimitive.Viewport
        className={cn(
          'p-1',
          position === 'popper' &&
            'h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]',
        )}
      >
        {children}
      </SelectPrimitive.Viewport>
      <SelectScrollDownButton />
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectLabel = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn('px-2 py-1 text-[11px] font-medium text-muted-foreground', className)}
    {...props}
  />
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex w-full cursor-default select-none items-center rounded-sm py-1 pl-6 pr-2 text-xs outline-none',
      'focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      className,
    )}
    {...props}
  >
    <span className="absolute left-1.5 flex h-3.5 w-3.5 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="h-3.5 w-3.5" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

const SelectSeparator = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator ref={ref} className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />
));
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

export {
  Select, SelectGroup, SelectValue, SelectTrigger, SelectContent,
  SelectLabel, SelectItem, SelectSeparator, SelectScrollUpButton, SelectScrollDownButton,
  SELECT_EMPTY, toSelectValue, fromSelectValue,
};
