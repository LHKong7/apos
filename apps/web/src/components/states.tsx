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
  action: { label: string; onClick: () => void };
}

export function EmptyState({ icon, message, hint, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center">
      <div className="text-2xl" aria-hidden>
        {icon}
      </div>
      <p className="text-sm text-slate-600">{message}</p>
      {hint && <p className="text-xs text-slate-400">{hint}</p>}
      <button
        type="button"
        onClick={action.onClick}
        className="mt-1 rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
      >
        {action.label}
      </button>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const isApi = error instanceof ApiError;
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-6 text-center">
      <p className="text-sm font-medium text-red-800">
        {isApi ? error.message : '加载失败'}
      </p>
      {isApi && <p className="mt-1 text-xs text-red-600">错误码 {error.code}</p>}
      {isApi && Boolean(error.details) && (
        <pre className="mx-auto mt-2 max-w-lg overflow-x-auto rounded bg-white/70 p-2 text-left text-[11px] text-red-700">
          {JSON.stringify(error.details, null, 2)}
        </pre>
      )}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded border border-red-300 px-3 py-1 text-xs text-red-700 hover:bg-red-100"
        >
          重试
        </button>
      )}
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div className="animate-pulse space-y-2 rounded-lg border border-slate-200 bg-white p-3">
      <div className="h-3 w-3/4 rounded bg-slate-200" />
      <div className="h-2 w-1/2 rounded bg-slate-100" />
      <div className="h-2 w-2/3 rounded bg-slate-100" />
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
