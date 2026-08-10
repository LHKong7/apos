import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { ApiError } from '../lib/api/client';

/**
 * ★ action 是必填而不是可选（docs/tech/08-frontend-architecture.md §8）。
 *
 * 页面文档 README §5.9 要求空状态必须带主行动按钮。
 * 写在文档里靠自觉，写进类型里就绕不过去。
 */
export interface EmptyStateProps {
  icon: ReactNode;
  message: string;
  hint?: string;
  /** 有些空状态就是「没有符合条件的东西」，硬凑一个动作反而多余 */
  action?: { label: string; onClick: () => void };
}

export function EmptyState({ icon, message, hint, action }: EmptyStateProps) {
  return (
    /* 网格底纹向四周淡出 —— 空态最怕的是「一片什么都没有」看起来像没加载完 */
    <div className="relative flex flex-col items-center gap-2 overflow-hidden rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center">
      <div aria-hidden className="grid-fade pointer-events-none absolute inset-0 opacity-60" />
      <div
        className="relative flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 bg-slate-100/70 text-xl"
        aria-hidden
      >
        {icon}
      </div>
      <p className="relative text-sm font-medium text-slate-700">{message}</p>
      {hint && <p className="relative max-w-sm text-xs leading-relaxed text-slate-400">{hint}</p>}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="relative mt-1.5 rounded-md bg-gradient-to-r from-brand-alt via-brand to-brand-far px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:brightness-110"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const isApi = error instanceof ApiError;
  return (
    <div className="rounded-xl border border-red-200 bg-red-50/70 px-4 py-6 text-center">
      <div
        aria-hidden
        className="mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-full border border-red-200 bg-red-100/60 text-sm text-red-700"
      >
        !
      </div>
      <p className="text-sm font-medium text-red-800">{isApi ? error.message : '加载失败'}</p>
      {isApi && <p className="mt-1 font-mono text-[11px] text-red-600">错误码 {error.code}</p>}
      {isApi && Boolean(error.details) && (
        <pre className="mx-auto mt-2 max-w-lg overflow-x-auto rounded-md border border-red-200/60 bg-slate-50/70 p-2 text-left text-[11px] text-red-700">
          {JSON.stringify(error.details, null, 2)}
        </pre>
      )}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-md border border-red-300 px-3 py-1 text-xs text-red-700 hover:bg-red-100"
        >
          重试
        </button>
      )}
    </div>
  );
}

/**
 * 骨架屏。
 *
 * ★ 用扫光（.skeleton）而不是整体明暗呼吸：呼吸只说明「有东西在动」，
 *   扫光有方向感，更接近「内容正在填进来」。
 */
export function CardSkeleton() {
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
      <div className="skeleton h-3 w-3/4 rounded" />
      <div className="skeleton h-2 w-1/2 rounded" />
      <div className="skeleton h-2 w-2/3 rounded" />
    </div>
  );
}

interface BoundaryProps<T> {
  query: UseQueryResult<T>;
  empty?: EmptyStateProps;
  isEmpty?: (data: T) => boolean;
  skeleton?: ReactNode;
  children: (data: T) => ReactNode;
}

export function QueryBoundary<T>({
  query,
  empty,
  isEmpty,
  skeleton,
  children,
}: BoundaryProps<T>) {
  // 已有数据时后台刷新不闪骨架屏 —— 看板每次事件都会重拉，
  // 每次都闪一下会让人以为页面在抖
  if (query.isPending) {
    return <>{skeleton ?? <CardSkeleton />}</>;
  }
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (empty && isEmpty?.(query.data)) {
    return <EmptyState {...empty} />;
  }
  return <>{children(query.data)}</>;
}
