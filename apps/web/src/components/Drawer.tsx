import { Sheet, SheetCloseButton, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';

/**
 * 侧栏抽屉。
 *
 * 详情用抽屉而不是跳页，是因为看板是「巡检」场景：
 * 处理一张卡片之后要立刻回到全局视野。跳走再跳回会丢掉滚动位置与筛选，
 * 一次巡检就变成了反复找回上下文。
 *
 * ★★ 底层换成了 shadcn Sheet（Radix Dialog），但**签名一个字没动** ——
 *   四个调用点（任务详情 / 决策处理，出现在看板、执行图、总览、Analytics）
 *   全部不用改。
 *
 *   换掉手写版本换来的不是样式，是这些原来没有的东西：
 *   - 焦点在打开时移进抽屉，Tab 被困在里面（原来能 Tab 到背后的看板上）
 *   - 关闭后焦点回到触发它的那张卡（原来掉回 <body>，键盘用户要从头 Tab）
 *   - 背景内容对读屏器 aria-hidden（原来读屏器会把整个看板念一遍）
 *   - body 滚动锁定
 *
 *   ★ 这些缺失全都不报错，只是键盘与读屏用户用不了 —— 手写弹层最典型的坑。
 */
export function Drawer({
  title,
  onClose,
  children,
  width = 'w-[min(28rem,100vw)]',
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Tailwind 宽度类名。保留字符串形态是为了兼容既有调用点 */
  width?: string;
}) {
  return (
    /**
     * ★ 受控且恒为 open：调用方的模式是「要显示时才渲染 <Drawer>」，
     *   不是「一直挂着、用 open 控制」。所以关闭只能来自 Radix 的
     *   onOpenChange（Esc / 点遮罩 / 点关闭按钮），统一转成 onClose。
     */
    <Sheet open onOpenChange={(next) => !next && onClose()}>
      <SheetContent side="right" className={width} aria-describedby={undefined}>
        <SheetHeader className="relative px-4 py-2.5">
          {/* 顶边那道品牌微光 —— 让抽屉看起来是「浮起来的一层」而不是贴上去的 */}
          <div aria-hidden className="hairline-brand absolute inset-x-0 top-0 h-px opacity-70" />
          <SheetTitle className="tracking-tight">{title}</SheetTitle>
          <SheetCloseButton />
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
