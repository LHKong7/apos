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
  DecisionInbox,
  OverviewResponse,
  PlanDetail,
  Project,
  RuntimeRow,
  RequirementDetail,
  RequirementSummary,
  RunControlAction,
  ScenarioTestResponse,
  SimulationResponse,
  RunDetail,
  RunEventPage,
  User,
  WorkItemDetail,
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

/** 当前身份。MVP 用 X-User-Id 头，见 docs/tech/09-security.md */
let currentUserId: string | null = null;

export function setCurrentUserId(id: string | null) {
  currentUserId = id;
}

export function getCurrentUserId(): string | null {
  return currentUserId;
}

async function request<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (currentUserId) headers.set('X-User-Id', currentUserId);
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
      envelope?.message ?? `请求失败（${res.status}）`,
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
  users: () => request<{ users: User[] }>('/users'),

  projects: () => request<{ projects: Project[] }>('/projects'),

  project: (id: string) =>
    request<{ project: Project; metrics: Record<string, unknown> }>(`/projects/${id}`),

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
    request<{ requirementId: string; completeness: Record<string, number>; clarificationCount: number; mustConfirmCount: number; cost: number }>(
      `/requirements/${id}/analyze`,
      { method: 'POST', json: {} },
    ),

  answerClarification: (id: string, body: { answer: string; usedSuggestion?: boolean }) =>
    request<{ clarification: Clarification }>(`/clarifications/${id}/answer`, {
      method: 'POST',
      json: body,
    }),

  editRequirement: (
    id: string,
    body: Partial<{ title: string; businessContext: string; userProblem: string; businessGoal: string }>,
  ) => request<{ requirement: unknown }>(`/requirements/${id}`, { method: 'PATCH', json: body }),

  approveRequirement: (id: string, note?: string) =>
    request<{ ok: true }>(`/requirements/${id}/approve`, { method: 'POST', json: { note } }),

  rejectRequirement: (id: string, reason: string) =>
    request<{ requirement: unknown }>(`/requirements/${id}/reject`, {
      method: 'POST',
      json: { reason },
    }),

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
