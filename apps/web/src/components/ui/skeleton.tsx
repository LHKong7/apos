import { cn } from '@/lib/utils';

/**
 * shadcn/ui Skeleton（new-york）。
 *
 * ★ 用 animate-breathe 而不是上游的 animate-pulse：项目里已经定义了
 *   breathe（1.6s，透明度到 0.35），骨架屏跟着它走，
 *   全站「正在加载」的节奏才是同一个。
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-breathe rounded-md bg-muted', className)} {...props} />;
}

export { Skeleton };
