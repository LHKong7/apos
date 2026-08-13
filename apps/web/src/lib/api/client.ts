import { t } from '../i18n';
import type { AnalyticsRange, LayoutKind } from '@apos/domain';
import type {
  AgentDetail,
  AgentListResponse,
  AgentSummary,
  AnalyticsItemsResponse,
  AnalyticsResponse,
  BoardResponse,
  Clarification,
  CostStep,
  DecisionDetail,
  DecisionRow,
  GraphResponse,
  AutonomyPreview,
  PoliciesResponse,
  PolicyRow,
  PolicyTemplateRow,
  PolicyHitsResponse,
  DecisionInbox,
  DisconnectImpact,
  IntegrationsResponse,
  MembersResponse,
  ProjectPermissions,
  RoleRow,
  RolesResponse,
  NotificationConfigRow,
  SyncConflictRow,
  SyncSummary,
  OverviewResponse,
  PlanDetail,
  PlanDiffResponse,
  Project,
  RuntimeRow,
  AgentAdminResponse,
  RepositoriesResponse,
  RepositoryProbe,
  StorageTargetProbe,
  StorageTargetsResponse,
  ConventionsResponse,
  ExecutionModeValue,
  ExecutorCandidates,
  ProjectAgentBindings,
  RequirementDetail,
  RequirementSummary,
  RunControlAction,
  ScenarioTestResponse,
  SimulationResponse,
  RunDetail,
  RunEventPage,
  User,
  WorkItemDetail,
  OrganizationRow,
  OrganizationsResponse,
  OrganizationMembersResponse,
} from './types';

/**
 * 后端的错误信封（docs/tech/07-api-design.md §4）。
 * 前端把它原样带上，因为 details 里往往有可直接展示的东西
 * （比如「哪几个 guard 没过」「允许的目标状态有哪些」）。
 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: unknown,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * 会话令牌（docs/tech/09-security.md §1.3）。
 *
 * ★ 此前这里是 `X-User-Id` —— 一个没有凭证的头，写上谁的 id 就是谁。
 *   现在身份必须由服务端签发的 JWT 证明。
 */
let authToken: string | null = null;

export function setAuthToken(token: string | null) {
  authToken = token;
}

export function getAuthToken(): string | null {
  return authToken;
}

/**
 * 当前组织。
 *
 * ★★ 账号可以属于多个组织之后，「在哪个组织」不再能从账号推出来，
 *   必须每个请求都带上 —— 否则服务端只能回落到缺省组织，
 *   表现是切换器显示 A、数据来自 B，而两边都不报错。
 *
 * ★ 为 null 时**不发这个头**，让服务端给缺省值。前端瞎猜一个 id
 *   发过去，只会把「还没选」变成一个 404。
 */
let currentOrgId: string | null = null;

export function setCurrentOrgId(id: string | null) {
  currentOrgId = id;
}

export function getCurrentOrgId(): string | null {
  return currentOrgId;
}

async function request<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (authToken) headers.set('Authorization', `Bearer ${authToken}`);
  if (currentOrgId) headers.set('X-Org-Id', currentOrgId);
  if (init.json !== undefined) headers.set('Content-Type', 'application/json');

  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const envelope = (body as { error?: { code: string; message: string; details?: unknown } })
      ?.error;
    throw new ApiError(
      envelope?.code ?? 'UNKNOWN',
      envelope?.message ?? t('api.requestFailed', { status: res.status }),
      envelope?.details,
      res.status,
    );
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface BoardFilters {
  onlyMine?: boolean;
  risk?: string[];
  executorType?: string;
  humanGate?: boolean;
  blocked?: boolean;
}

export function boardQueryString(filters: BoardFilters): string {
  const params = new URLSearchParams();
  if (filters.onlyMine) params.set('onlyMine', 'true');
  if (filters.risk?.length) params.set('risk', filters.risk.join(','));
  if (filters.executorType) params.set('executorType', filters.executorType);
  if (filters.humanGate) params.set('humanGate', 'true');
  if (filters.blocked) params.set('blocked', 'true');
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export const api = {
  // ── 登录（docs/tech/09-security.md §1.3）────────────────────────────
  login: (body: { email: string; password: string }) =>
    request<{ token: string; user: User }>('/auth/login', { method: 'POST', json: body }),

  /**
   * 登录页要知道的那点服务端配置。无需身份。
   *
   * ★ 注册开不开是**服务端**的事，必须来问，不能烤进构建里 ——
   *   同一份前端产物会被不同实例托管，一个开着注册、一个关着的两套部署
   *   会因此需要两份产物。
   */
  authConfig: () => request<{ allowSignup: boolean }>('/auth/config'),

  /**
   * 自助注册。每次注册长出一个**自己的新组织**，注册者是它的 org_admin ——
   * 不是加入某个已有组织（见 apps/api/src/modules/auth/service.ts）。
   * 回来直接带令牌，注册完不用再登录一次。
   */
  register: (body: { email: string; name: string; password: string; orgName?: string }) =>
    request<{
      token: string;
      user: User;
      organization: { id: string; name: string; slug: string };
    }>('/auth/register', { method: 'POST', json: body }),

  me: () => request<{ user: User; currentOrgId: string; orgRole: string }>('/auth/me'),

  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    request<{ ok: true; token: string }>('/auth/password', { method: 'POST', json: body }),

  /** 开账号 —— 只有组织管理员能调（§2.2 身份管理）*/
  createAccount: (body: {
    email: string;
    name: string;
    password: string;
    orgRole?: string;
  }) =>
    request<{ id: string; name: string; email: string; orgRole: string }>('/admin/users', {
      method: 'POST',
      json: body,
    }),

  users: () => request<{ users: User[] }>('/users'),

  // ── 组织（顶层容器；Plane 里叫 Workspace）────────────────────────────
  organizations: () => request<OrganizationsResponse>('/organizations'),

  createOrganization: (body: { name: string; slug?: string; description?: string | null }) =>
    request<{ organization: OrganizationRow }>('/organizations', { method: 'POST', json: body }),

  updateOrganization: (
    id: string,
    body: { name?: string; slug?: string; description?: string | null },
  ) =>
    request<{ organization: OrganizationRow }>(`/organizations/${id}`, {
      method: 'PATCH',
      json: body,
    }),

  deleteOrganization: (id: string) =>
    request<{ ok: true }>(`/organizations/${id}`, { method: 'DELETE' }),

  organizationMembers: (id: string) =>
    request<OrganizationMembersResponse>(`/organizations/${id}/members`),

  addOrganizationMember: (id: string, body: { email: string; orgRole?: string }) =>
    request<{ ok: true; userId: string }>(`/organizations/${id}/members`, {
      method: 'POST',
      json: body,
    }),

  removeOrganizationMember: (id: string, userId: string) =>
    request<{ ok: true }>(`/organizations/${id}/members/${userId}`, { method: 'DELETE' }),

  projects: () => request<{ projects: Project[] }>('/projects'),

  /**
   * 手工建任务。
   *
   * ★ 建出来的是**草稿**，不可派发 —— 放行去执行要 `plan.approve`。
   *   服务端返回的 `notice` 就是这句话，界面上要原样说出来。
   */
  createWorkItem: (
    projectId: string,
    body: {
      title: string;
      description?: string;
      type?: string;
      priority?: number;
      riskLevel?: string;
      ownerId?: string | null;
      parentId?: string | null;
    },
  ) =>
    request<{ item: { id: string; ref: string; status: string }; notice: string }>(
      `/projects/${projectId}/work-items`,
      { method: 'POST', json: body },
    ),

  createProject: (body: {
    name: string;
    goal?: string;
    autonomyLevel?: string;
    budgetAmount?: string;
  }) => request<{ project: Project }>('/projects', { method: 'POST', json: body }),

  project: (id: string) =>
    request<{ project: Project; metrics: Record<string, unknown> }>(`/projects/${id}`),

  // ── 权限与成员（docs/tech/09-security.md §2）────────────────────────
  permissions: (projectId: string) =>
    request<ProjectPermissions>(`/projects/${projectId}/permissions`),

  members: (projectId: string) => request<MembersResponse>(`/projects/${projectId}/members`),

  /** 担任者可以是人，也可以是 Agent —— 同一条 API（09-security §2.2）*/
  setMemberRole: (
    projectId: string,
    memberId: string,
    role: string,
    actorType: 'human' | 'agent' = 'human',
  ) =>
    request<{ ok: true; role: string; changed: boolean; previousRole?: string }>(
      `/projects/${projectId}/members/${memberId}`,
      { method: 'PUT', json: { role, actorType } },
    ),

  removeMember: (projectId: string, memberId: string, actorType: 'human' | 'agent' = 'human') =>
    request<{ ok: true; removed: boolean }>(
      `/projects/${projectId}/members/${memberId}?actorType=${actorType}`,
      { method: 'DELETE' },
    ),

  // ── 角色定义（超管）──────────────────────────────────────────────
  roles: () => request<RolesResponse>('/admin/roles'),

  createRole: (body: {
    key: string;
    name: string;
    description?: string;
    permissions: string[];
    appliesTo: ('human' | 'agent')[];
  }) => request<{ role: RoleRow }>('/admin/roles', { method: 'POST', json: body }),

  updateRole: (
    key: string,
    body: {
      name: string;
      description?: string;
      permissions: string[];
      appliesTo: ('human' | 'agent')[];
    },
  ) => request<{ role: RoleRow }>(`/admin/roles/${key}`, { method: 'PATCH', json: body }),

  deleteRole: (key: string) =>
    request<{ ok: true; deleted: boolean }>(`/admin/roles/${key}`, { method: 'DELETE' }),

  orgUsers: () =>
    request<{
      users: (User & { orgRoleLabel: string; status: string })[];
      /** Agent 也能被加进项目并担任角色，所以名单里要有它们 */
      agents: { id: string; name: string; type: string; status: string }[];
      assignableOrgRoles: { role: string; label: string }[];
    }>('/admin/users'),

  setOrgRole: (userId: string, orgRole: string) =>
    request<{ ok: true; orgRole: string; changed: boolean }>(`/admin/users/${userId}/org-role`, {
      method: 'PATCH',
      json: { orgRole },
    }),

  board: (projectId: string, filters: BoardFilters) =>
    request<BoardResponse>(`/projects/${projectId}/board${boardQueryString(filters)}`),

  agents: (projectId: string) => request<{ agents: AgentSummary[] }>(`/projects/${projectId}/agents`),

  graph: (projectId: string, layout: LayoutKind) =>
    request<GraphResponse>(`/projects/${projectId}/graph?layout=${layout}`),

  analytics: (projectId: string, range: AnalyticsRange, compare: boolean) =>
    request<AnalyticsResponse>(
      `/projects/${projectId}/analytics?range=${range}&compare=${compare}`,
    ),

  analyticsItems: (projectId: string, kind: string, range: AnalyticsRange) =>
    request<AnalyticsItemsResponse>(
      `/projects/${projectId}/analytics/items?kind=${kind}&range=${range}`,
    ),

  // ── 项目总览 / Agent / 决策中心 / 运行时 ────────────────────────────
  overview: (projectId: string) => request<OverviewResponse>(`/projects/${projectId}/overview`),

  agentList: (projectId?: string) =>
    request<AgentListResponse>(`/agents${projectId ? `?projectId=${projectId}` : ''}`),

  agentDetail: (agentId: string) => request<AgentDetail>(`/agents/${agentId}`),

  pauseAgent: (agentId: string, paused: boolean, reason?: string) =>
    request<{ ok: true; paused: boolean }>(`/agents/${agentId}/pause`, {
      method: 'POST',
      json: { paused, reason },
    }),

  runtimes: () => request<{ runtimes: RuntimeRow[] }>('/runtimes'),

  /**
   * ── 配置：Agent 档案（内含运行时）/ 代码仓库 / 项目工程约定 ──
   *
   * ★ 这一组必须用 `json:` 而不是 `body: JSON.stringify(...)`。
   *
   *   `request()` 只在用 `json` 时才设 Content-Type；用 `body` 的话
   *   浏览器会自作主张发 `text/plain;charset=UTF-8`，Fastify 用
   *   text/plain 解析器把整个 JSON 当字符串交给 Zod，于是这一整页的
   *   写操作全部 400「Expected object, received string」——
   *   而组件测试用 app.inject（自动带 JSON 头）永远复现不出来。
   */
  adminAgents: () => request<AgentAdminResponse>('/admin/agents'),
  createAgent: (body: Record<string, unknown>) =>
    request<{ agent: { id: string }; unknownConfigKeys: string[] }>('/admin/agents', {
      method: 'POST',
      json: body,
    }),
  updateAgent: (id: string, body: Record<string, unknown>) =>
    request<{ agent: unknown; permissionsChanged: boolean; unknownConfigKeys: string[] }>(
      `/admin/agents/${id}`,
      { method: 'PATCH', json: body },
    ),
  deleteAgent: (id: string) =>
    request<{ ok: true; retired: boolean; reason: string | null }>(`/admin/agents/${id}`, {
      method: 'DELETE',
    }),
  probeAgent: (id: string) => request<unknown>(`/admin/agents/${id}/probe`, { method: 'POST' }),

  /** 仓库连通性探测 —— 凭证配错了要在这一页知道，不是等第一次派发 */
  probeRepository: (id: string) =>
    request<RepositoryProbe>(`/admin/repositories/${id}/probe`, { method: 'POST' }),

  repositories: (projectId?: string) =>
    request<RepositoriesResponse>(
      `/admin/repositories${projectId ? `?projectId=${projectId}` : ''}`,
    ),
  createRepository: (body: Record<string, unknown>) =>
    request<{ repository: { id: string } }>('/admin/repositories', {
      method: 'POST',
      json: body,
    }),
  updateRepository: (id: string, body: Record<string, unknown>) =>
    request<unknown>(`/admin/repositories/${id}`, { method: 'PATCH', json: body }),
  deleteRepository: (id: string) =>
    request<{ ok: true }>(`/admin/repositories/${id}`, { method: 'DELETE' }),

  storageTargets: (projectId?: string) =>
    request<StorageTargetsResponse>(
      `/admin/storage-targets${projectId ? `?projectId=${projectId}` : ''}`,
    ),
  createStorageTarget: (body: Record<string, unknown>) =>
    request<{ storageTarget: { id: string } }>('/admin/storage-targets', {
      method: 'POST',
      json: body,
    }),
  updateStorageTarget: (id: string, body: Record<string, unknown>) =>
    request<unknown>(`/admin/storage-targets/${id}`, { method: 'PATCH', json: body }),
  deleteStorageTarget: (id: string) =>
    request<{ ok: true }>(`/admin/storage-targets/${id}`, { method: 'DELETE' }),
  /** 存储目标连通性探测 —— 与仓库同理：配错了要在这一页知道 */
  probeStorageTarget: (id: string) =>
    request<StorageTargetProbe>(`/admin/storage-targets/${id}/probe`, { method: 'POST' }),

  conventions: (projectId: string) =>
    request<ConventionsResponse>(`/projects/${projectId}/conventions`),
  createConvention: (projectId: string, body: Record<string, unknown>) =>
    request<{ convention: { id: string } }>(`/projects/${projectId}/conventions`, {
      method: 'POST',
      json: body,
    }),
  updateConvention: (id: string, body: Record<string, unknown>) =>
    request<unknown>(`/conventions/${id}`, { method: 'PATCH', json: body }),
  deleteConvention: (id: string) =>
    request<{ ok: true }>(`/conventions/${id}`, { method: 'DELETE' }),

  assignWorkItem: (id: string, body: { agentId?: string; userId?: string; note?: string }) =>
    request<{ ok: true; runId?: string }>(`/work-items/${id}/assign`, {
      method: 'POST',
      json: body,
    }),

  /** 候选执行者：可选的与**不可选的**（带原因）一起回 */
  workItemCandidates: (id: string) =>
    request<ExecutorCandidates>(`/work-items/${id}/candidates`),

  /**
   * 只设置执行者，不开始执行。
   *
   * ★ 与 assignWorkItem 的区别是这一条**没有副作用**：不派 Run、不动状态、
   *   不花钱。界面上的执行者下拉框走这个，「开始执行」是另一个按钮。
   */
  setWorkItemAssignee: (
    id: string,
    body: { agentId?: string | null; userId?: string | null; executionMode?: ExecutionModeValue },
  ) =>
    request<{
      ok: true;
      executorType: 'agent' | 'human' | null;
      executorId: string | null;
      executionMode: ExecutionModeValue;
    }>(`/work-items/${id}/assignee`, { method: 'PATCH', json: body }),

  startWorkItem: (id: string, body: { agentId?: string; note?: string } = {}) =>
    request<{ ok: true; runId?: string; attempt?: number }>(`/work-items/${id}/start`, {
      method: 'POST',
      json: body,
    }),

  projectAgents: (projectId: string) =>
    request<ProjectAgentBindings>(`/projects/${projectId}/agents`),

  setProjectAgent: (projectId: string, body: { role: string; agentId: string | null }) =>
    request<{ ok: true; role: string; agentId: string | null }>(`/projects/${projectId}/agents`, {
      method: 'PUT',
      json: body,
    }),

  setLaborCost: (projectId: string, laborHourlyCost: number | null) =>
    request<{ ok: true }>(`/projects/${projectId}/labor-cost`, {
      method: 'PATCH',
      json: { laborHourlyCost },
    }),

  ingestCi: (integrationId: string) =>
    request<{ updated: number; skipped: number; unsupported: boolean; notes: string[] }>(
      `/integrations/${integrationId}/ingest-ci`,
      { method: 'POST', json: {} },
    ),

  policyHits: (projectId: string, policyId: string) =>
    request<PolicyHitsResponse>(`/projects/${projectId}/policies/${policyId}/hits`),

  planDiff: (planId: string, against?: number) =>
    request<PlanDiffResponse>(
      `/plans/${planId}/diff${against === undefined ? '' : `?against=${against}`}`,
    ),

  // ── 集成设置（页面文档 14）──────────────────────────────────────────
  integrations: (projectId: string) =>
    request<IntegrationsResponse>(`/projects/${projectId}/integrations`),

  connectIntegration: (
    projectId: string,
    body: {
      provider: string;
      displayName: string;
      config?: Record<string, unknown>;
      credential?: string | null;
      grantWrite?: boolean;
    },
  ) =>
    request<{ id: string; displayName: string }>(`/projects/${projectId}/integrations`, {
      method: 'POST',
      json: body,
    }),

  updateSyncMapping: (
    integrationId: string,
    mappings: { field: string; sourceOfTruth: string; strategy: string }[],
  ) =>
    request<{ ok: true; changed: { field: string; from: string; to: string }[] }>(
      `/integrations/${integrationId}/sync-mapping`,
      { method: 'PATCH', json: { mappings } },
    ),

  runIntegrationSync: (integrationId: string) =>
    request<SyncSummary>(`/integrations/${integrationId}/sync`, { method: 'POST', json: {} }),

  syncConflicts: (projectId: string) =>
    request<{
      conflicts: SyncConflictRow[];
      hotspots: { field: string; fieldLabel: string; count: number; hint: string }[];
    }>(`/projects/${projectId}/sync-conflicts`),

  resolveConflict: (conflictId: string, winner: 'apos' | 'external', applyToSimilar: boolean) =>
    request<{ ok: true; field: string; winner: string }>(
      `/sync-conflicts/${conflictId}/resolve`,
      { method: 'POST', json: { winner, applyToSimilar } },
    ),

  disconnectImpact: (integrationId: string) =>
    request<DisconnectImpact>(`/integrations/${integrationId}/disconnect-impact`),

  disconnectIntegration: (integrationId: string) =>
    request<{ ok: true }>(`/integrations/${integrationId}`, {
      method: 'DELETE',
      json: { confirmImpact: true },
    }),

  updateNotifications: (integrationId: string, config: NotificationConfigRow) =>
    request<{ ok: true; disabled: string[] }>(`/integrations/${integrationId}/notifications`, {
      method: 'PATCH',
      json: config,
    }),

  linkExternalObject: (
    integrationId: string,
    body: { workItemId: string; externalKey: string; externalUrl?: string },
  ) =>
    request<{ id: string }>(`/integrations/${integrationId}/objects`, {
      method: 'POST',
      json: body,
    }),

  decisionInbox: (scope: 'mine' | 'all', projectId?: string) =>
    request<DecisionInbox>(
      `/decision-inbox?scope=${scope}${projectId ? `&projectId=${projectId}` : ''}`,
    ),

  batchApproveDecisions: (ids: string[], note?: string) =>
    request<{ approved: number; failed: { id: string; error?: string }[] }>(
      '/decisions/batch-approve',
      { method: 'POST', json: { ids, note } },
    ),

  // ── Policy 配置 ────────────────────────────────────────────────────
  policies: (projectId: string) => request<PoliciesResponse>(`/projects/${projectId}/policies`),

  policyTemplates: () => request<{ templates: PolicyTemplateRow[] }>('/policy-templates'),

  savePolicy: (
    projectId: string,
    body: {
      name: string;
      description?: string;
      priority: number;
      condition: unknown;
      action: unknown;
      enabled?: boolean;
      acknowledgeMismatches?: boolean;
    },
    policyId?: string,
  ) =>
    request<{ policy: PolicyRow; direction: string; loosenedScenarios: number }>(
      policyId
        ? `/projects/${projectId}/policies/${policyId}`
        : `/projects/${projectId}/policies`,
      { method: policyId ? 'PATCH' : 'POST', json: body },
    ),

  togglePolicy: (projectId: string, policyId: string, enabled: boolean, reason: string) =>
    request<{ ok: true; enabled: boolean }>(
      `/projects/${projectId}/policies/${policyId}/toggle`,
      { method: 'POST', json: { enabled, reason } },
    ),

  deletePolicy: (projectId: string, policyId: string) =>
    request<{ ok: true }>(`/projects/${projectId}/policies/${policyId}`, { method: 'DELETE' }),

  buildFromTemplate: (
    projectId: string,
    templateId: string,
    values: Record<string, string | number>,
  ) =>
    request<{ condition: unknown; action: unknown; explanation: string }>(
      `/projects/${projectId}/policies/from-template`,
      { method: 'POST', json: { templateId, values } },
    ),

  simulatePolicy: (
    projectId: string,
    body: { condition: unknown; action: unknown; range?: '7d' | '30d' | '90d' },
  ) => request<SimulationResponse>(`/projects/${projectId}/policies/simulate`, {
    method: 'POST',
    json: body,
  }),

  testScenario: (projectId: string, context: Record<string, unknown>) =>
    request<ScenarioTestResponse>(`/projects/${projectId}/policies/evaluate`, {
      method: 'POST',
      json: { context },
    }),

  autonomyPreview: (projectId: string, to: string) =>
    request<AutonomyPreview>(`/projects/${projectId}/policies/autonomy-preview`, {
      method: 'POST',
      json: { to },
    }),

  setAutonomy: (projectId: string, autonomyLevel: string) =>
    request<{ ok: true; autonomyLevel: string }>(`/projects/${projectId}/autonomy`, {
      method: 'PATCH',
      json: { autonomyLevel },
    }),

  policyHistory: (policyId: string) =>
    request<{
      history: {
        version: number;
        direction: string | null;
        changedBy: string;
        changedAt: string;
        snapshot: unknown;
      }[];
    }>(`/policies/${policyId}/history`),

  // ── 需求录入与计划确认 ────────────────────────────────────────────
  requirements: (projectId: string) =>
    request<{ requirements: RequirementSummary[] }>(`/projects/${projectId}/requirements`),

  createRequirement: (projectId: string, body: { rawInput: string; priority?: string }) =>
    request<{ requirement: { id: string } }>(`/projects/${projectId}/requirements`, {
      method: 'POST',
      json: body,
    }),

  requirement: (id: string) => request<RequirementDetail>(`/requirements/${id}`),

  analyzeRequirement: (id: string) =>
    request<{
      requirementId: string;
      completeness: Record<string, number>;
      clarificationCount: number;
      mustConfirmCount: number;
      cost: number;
      /** 人改过、因而这一轮没被覆盖的字段。要说出来，否则用户以为分析漏了它们 */
      keptHumanFields: string[];
    }>(`/requirements/${id}/analyze`, { method: 'POST', json: {} }),

  answerClarification: (id: string, body: { answer: string; usedSuggestion?: boolean }) =>
    request<{ clarification: Clarification }>(`/clarifications/${id}/answer`, {
      method: 'POST',
      json: body,
    }),

  /**
   * 人工填写 / 修改结构化字段。
   *
   * ★ 给的是**全部**结构化字段，不是 AI 结果的几个可修补项 ——
   *   人工是与 AI 并列的一条录入路径，只开放一半的话它永远填不出
   *   一份完整的需求（完整度评分那六个维度里有五个在这些字段上）。
   */
  editRequirement: (
    id: string,
    body: Partial<{
      title: string;
      businessContext: string;
      userProblem: string;
      businessGoal: string;
      userStories: string[];
      scope: { inScope: string[]; outOfScope: string[] };
      nonFunctional: string[];
      successMetrics: string[];
      constraints: string[];
      risks: string[];
      acceptanceCriteria: {
        id?: string;
        text: string;
        verification: 'auto' | 'agent' | 'human';
      }[];
    }>,
  ) => request<{ requirement: unknown }>(`/requirements/${id}`, { method: 'PATCH', json: body }),

  approveRequirement: (id: string, note?: string) =>
    request<{ ok: true }>(`/requirements/${id}/approve`, { method: 'POST', json: { note } }),

  rejectRequirement: (id: string, reason: string) =>
    request<{ requirement: unknown }>(`/requirements/${id}/reject`, {
      method: 'POST',
      json: { reason },
    }),

  /**
   * ★ 与驳回不是一回事：驳回记录结论，删除抹掉一条本不该存在的记录。
   *   已派生出计划或工作项的需求会被服务端以 GUARD_FAILED 挡下。
   */
  deleteRequirement: (id: string) =>
    request<{ ok: true }>(`/requirements/${id}`, { method: 'DELETE' }),

  generatePlan: (requirementId: string) =>
    request<{ planId: string; version: number }>(`/requirements/${requirementId}/plans`, {
      method: 'POST',
      json: {},
    }),

  plan: (id: string) => request<PlanDetail>(`/plans/${id}`),

  approvePlan: (id: string, acknowledgedOverrun?: boolean) =>
    request<{ ok: true; planId: string; activatedTasks: number }>(`/plans/${id}/approve`, {
      method: 'POST',
      json: { acknowledgedOverrun },
    }),

  revisePlan: (id: string, feedback: string) =>
    request<{ planId: string; version: number }>(`/plans/${id}/revise`, {
      method: 'POST',
      json: { feedback },
    }),

  workItem: (id: string) => request<WorkItemDetail>(`/work-items/${id}`),

  decisions: (scope: 'mine' | 'all' = 'all') =>
    request<{ stats: { pending: number; overdue: number; dueSoon: number }; decisions: DecisionRow[] }>(
      `/decisions?scope=${scope}`,
    ),

  decision: (id: string) => request<DecisionDetail>(`/decisions/${id}`),

  run: (id: string) => request<RunDetail>(`/runs/${id}`),

  runEvents: (id: string, opts: { level: 'brief' | 'detailed'; after?: number }) => {
    const params = new URLSearchParams({ level: opts.level });
    if (opts.after !== undefined) params.set('after', String(opts.after));
    return request<RunEventPage>(`/runs/${id}/events?${params.toString()}`);
  },

  runCostBreakdown: (id: string) => request<{ steps: CostStep[] }>(`/runs/${id}/cost-breakdown`),

  controlRun: (
    id: string,
    body: { action: RunControlAction; reason?: string; constraint?: { type?: string; description: string } },
  ) => request<{ ok: true; action: RunControlAction }>(`/runs/${id}/control`, {
    method: 'POST',
    json: body,
  }),

  // ── 变更 ──────────────────────────────────────────────────────────
  changeStatus: (
    id: string,
    body: { toStatus: string; reason: string; reasonCategory?: string; overrideGuards?: string[] },
  ) => request<{ ok: true; from: string; to: string; stage: string }>(`/work-items/${id}/status`, {
    method: 'PATCH',
    json: body,
  }),

  retry: (id: string, body: { agentId?: string; additionalContext?: { title: string; content: string }[] } = {}) =>
    request<{ ok: true; runId: string; attempt: number }>(`/work-items/${id}/retry`, {
      method: 'POST',
      json: body,
    }),

  takeover: (id: string, reason: string) =>
    request<{ ok: true; to: string }>(`/work-items/${id}/takeover`, {
      method: 'POST',
      json: { reason },
    }),

  approveDecision: (
    id: string,
    body: {
      note?: string;
      constraints?: { type: string; value: unknown; description: string; enforcement: string }[];
    } = {},
  ) => request<{ ok: true; decisionId: string }>(`/decisions/${id}/approve`, {
    method: 'POST',
    json: body,
  }),

  rejectDecision: (id: string, reason: string) =>
    request<{ ok: true; decisionId: string }>(`/decisions/${id}/reject`, {
      method: 'POST',
      json: { reason },
    }),

  remindDecision: (id: string) =>
    request<{ ok: true }>(`/decisions/${id}/remind`, { method: 'POST', json: {} }),

  schedule: (projectId: string) =>
    request<{ scanned: number }>(`/projects/${projectId}/schedule`, {
      method: 'POST',
      json: {},
    }),
};
