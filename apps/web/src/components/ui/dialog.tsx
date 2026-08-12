import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * shadcn/ui Dialog（new-york）。
 *
 * ★★ 换掉手写弹层的真正收益不是样式，是这些**没人会主动去写**的东西：
 *   焦点在打开时移进弹层、Tab 被困在弹层内、Esc 关闭、关闭后焦点回到
 *   触发它的那个按钮、背景内容对读屏器 aria-hidden、body 滚动锁定。
 *   手写版本里这些通常只实现了 Esc 一条 —— 而缺失的部分不会报错，
 *   只是键盘用户和读屏用户用不了。
 *
 * ★ 遮罩用 bg-scrim/[--scrim-alpha]：深浅两套主题的黑度差得远，
 *   一个写死的 black/50 在浅色下过重、在深色下压不住东西。
 */
const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-scrim/50 backdrop-blur-sm',
      'data-[state=open]:animate-in data-[state=closed]:animate-out',
      'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideClose?: boolean }
>(({ className, children, hideClose, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-1/2 top-1/2 z-50 flex w-full max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-3',
        /**
         * ★★ 弹层永远不能比屏幕高。
         *
         *   在此之前这里既没有 max-height 也没有 overflow：内容一长，
         *   弹层就整个撑高，而它是 top-1/2 + -translate-y-1/2 居中的 ——
         *   撑出来的部分**上下各溢出一半**。表现是「一部分输入框在弹窗外」，
         *   底部的取消/保存按钮跑到视口下面，鼠标够不着、页面也滚不到
         *   （Radix 开弹层时锁了 body 滚动）。
         *
         *   截到的实例：代码仓库登记表单在 780px 高的窗口上是 950px 高，
         *   top=-85、bottom=865，「组织共享」勾选框和两个按钮全在视口外。
         *
         *   配套的是 Modal 里那个 flex-1 滚动区 —— 只封顶不给滚动出口的话，
         *   够不着会变成看不见，更糟。
         */
        'max-h-[calc(100dvh-2rem)] overflow-hidden',
        'rounded-xl border border-border bg-card p-4 shadow-xl',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        className,
      )}
      {...props}
    >
      {children}
      {!hideClose && (
        <DialogPrimitive.Close className="absolute right-3 top-3 rounded-md p-0.5 text-slate-400 opacity-70 transition hover:bg-accent hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <X className="h-4 w-4" />
          <span className="sr-only">关闭</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 pr-6', className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex flex-wrap items-center justify-end gap-2', className)} {...props} />
  );
}

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-sm font-semibold text-foreground', className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-xs leading-5 text-muted-foreground', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog, DialogPortal, DialogOverlay, DialogTrigger, DialogClose,
  DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
};
