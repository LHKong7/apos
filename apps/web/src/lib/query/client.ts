import { QueryClient } from '@tanstack/react-query';

/**
 * ★ 关掉窗口聚焦重取、拉长 staleTime。
 *
 * 数据新鲜度由 SSE 保证，不靠轮询。留着默认的 refetchOnWindowFocus
 * 会在每次切回标签页时打一轮请求，而 SSE 早就把状态推过来了。
 *
 * 放在这里而不是 main.tsx，是因为身份切换也要动缓存（见 stores/auth.ts），
 * 而 store 不能反过来 import 入口文件。
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
