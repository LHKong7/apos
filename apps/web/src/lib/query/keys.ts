import type { BoardFilters } from '../api/client';

/**
 * Query key 工厂。
 *
 * 全部经由这里，是因为 SSE 补丁要精确命中缓存 ——
 * 手写字符串数组迟早会和读取处对不上，那种 bug 表现为
 * 「数据变了但界面不动」，非常难查。
 */
export const qk = {
  /** 当前登录者。与 users（组织通讯录）分开 —— 前者随登录变，后者随组织变 */
  me: () => ['me'] as const,
  users: () => ['users'] as const,
  /**
   * ★ key 里不带 orgId，靠切换组织时整体作废缓存（stores/org 的 apply）——
   *   与身份切换同一套机制。组织是多租户边界，跨过它的脏缓存
   *   会把 A 公司的数据摆在 B 公司的界面上。
   */
  organizations: () => ['organizations'] as const,
  organizationMembers: (orgId: string) => ['organizationMembers', orgId] as const,
  projects: () => ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  /**
   * 当前身份在这个项目里的权限。
   *
   * ★ key 里不带 userId，靠切换身份时整体作废缓存（stores/auth 的 applyIdentity）——
   *   与决策收件箱、总览「需要你处理」同一套机制。
   */
  /**
   * ★★ 角色是**组织级**的，key 也必须按组织算。
   *
   *   此前这里是手写的 `['roles']`（不带任何作用域）—— 于是它在界面上
   *   看起来像是属于某个项目的东西，而切换组织时那份缓存会原样留下来：
   *   新组织的角色页先显示上一个组织的角色，且每一行都完全正常。
   *   手写字符串数组迟早和读取处对不上，这就是那种情况。
   */
  roles: (orgId: string | null) => ['roles', orgId ?? 'none'] as const,
  permissions: (projectId: string) => ['permissions', projectId] as const,
  members: (projectId: string) => ['members', projectId] as const,
  board: (projectId: string, filters: BoardFilters) =>
    ['board', projectId, normalizeFilters(filters)] as const,
  /** 匹配某项目下所有筛选组合的看板缓存 */
  boardAll: (projectId: string) => ['board', projectId] as const,
  agents: (projectId: string) => ['agents', projectId] as const,
  graph: (projectId: string, layout: string) => ['graph', projectId, layout] as const,
  /** 匹配某项目下所有布局的图缓存 */
  graphAll: (projectId: string) => ['graph', projectId] as const,
  analytics: (projectId: string, range: string, compare: boolean) =>
    ['analytics', projectId, range, compare] as const,
  overview: (projectId: string) => ['overview', projectId] as const,
  agentList: (projectId?: string) => ['agentList', projectId ?? 'all'] as const,
  agentDetail: (agentId: string) => ['agentDetail', agentId] as const,
  runtimes: () => ['runtimes'] as const,
  adminAgents: () => ['adminAgents'] as const,
  repositories: (projectId?: string) => ['repositories', projectId ?? 'all'] as const,
  storageTargets: (projectId?: string) => ['storageTargets', projectId ?? 'all'] as const,
  conventions: (projectId: string) => ['conventions', projectId] as const,
  integrations: (projectId: string) => ['integrations', projectId] as const,
  syncConflicts: (projectId: string) => ['syncConflicts', projectId] as const,
  decisionInbox: (scope: string, projectId?: string) =>
    ['decisionInbox', scope, projectId ?? 'all'] as const,
  /** 匹配所有范围组合 —— 一条决策事件会同时影响「我的」和「全部」两份缓存 */
  decisionInboxAll: () => ['decisionInbox'] as const,
  requirements: (projectId: string) => ['requirements', projectId] as const,
  requirement: (id: string) => ['requirement', id] as const,
  plan: (id: string) => ['plan', id] as const,
  planDiff: (id: string, against?: number) => ['planDiff', id, against ?? 'prev'] as const,
  policies: (projectId: string) => ['policies', projectId] as const,
  policyTemplates: () => ['policyTemplates'] as const,
  policyHistory: (policyId: string) => ['policyHistory', policyId] as const,
  policyHits: (projectId: string, policyId: string) =>
    ['policyHits', projectId, policyId] as const,
  analyticsItems: (projectId: string, kind: string, range: string) =>
    ['analyticsItems', projectId, kind, range] as const,
  workItem: (id: string) => ['workItem', id] as const,
  workItemCandidates: (id: string) => ['workItem', id, 'candidates'] as const,
  projectAgents: (projectId: string) => ['project', projectId, 'agents'] as const,
  /**
   * ★ 按 (项目, Agent) 键控，不是按 Agent。
   *   同一个 Agent 在两个项目里是两套权限，共用一个 key 的话，
   *   切项目时会先显示上一个项目的授权 —— 而那是一份看起来完全正常的错答案。
   */
  agentAccess: (projectId: string, agentId: string) =>
    ['project', projectId, 'agent', agentId, 'access'] as const,
  requirementRuns: (id: string) => ['requirement', id, 'runs'] as const,
  artifactFiles: (artifactId: string) => ['artifact', artifactId, 'files'] as const,
  artifactFile: (artifactId: string, path: string) =>
    ['artifact', artifactId, 'file', path] as const,
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
    // ★ 漏一项的表现是「两组不同筛选共用一份缓存」—— 切换筛选界面不动
    unclaimed: f.unclaimed ?? false,
  };
}
