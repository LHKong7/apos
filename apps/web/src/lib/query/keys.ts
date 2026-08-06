import type { BoardFilters } from '../api/client';

/**
 * Query key 工厂。
 *
 * 全部经由这里，是因为 SSE 补丁要精确命中缓存 ——
 * 手写字符串数组迟早会和读取处对不上，那种 bug 表现为
 * 「数据变了但界面不动」，非常难查。
 */
export const qk = {
  users: () => ['users'] as const,
  projects: () => ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  board: (projectId: string, filters: BoardFilters) =>
    ['board', projectId, normalizeFilters(filters)] as const,
  /** 匹配某项目下所有筛选组合的看板缓存 */
  boardAll: (projectId: string) => ['board', projectId] as const,
  agents: (projectId: string) => ['agents', projectId] as const,
  workItem: (id: string) => ['workItem', id] as const,
  decisions: (scope: string) => ['decisions', scope] as const,
  decisionsAll: () => ['decisions'] as const,
  decision: (id: string) => ['decision', id] as const,
  run: (id: string) => ['run', id] as const,
  runEvents: (id: string, level: string) => ['run', id, 'events', level] as const,
  runCost: (id: string) => ['run', id, 'cost'] as const,
};

/** 筛选对象参与 key，必须稳定序列化，否则等价筛选会各自缓存 */
function normalizeFilters(f: BoardFilters) {
  return {
    onlyMine: f.onlyMine ?? false,
    risk: [...(f.risk ?? [])].sort().join(','),
    executorType: f.executorType ?? '',
    humanGate: f.humanGate ?? false,
    blocked: f.blocked ?? false,
  };
}
