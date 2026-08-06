import type {
  AgentSummary,
  BoardResponse,
  DecisionDetail,
  DecisionRow,
  Project,
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

  workItem: (id: string) => request<WorkItemDetail>(`/work-items/${id}`),

  decisions: (scope: 'mine' | 'all' = 'all') =>
    request<{ stats: { pending: number; overdue: number; dueSoon: number }; decisions: DecisionRow[] }>(
      `/decisions?scope=${scope}`,
    ),

  decision: (id: string) => request<DecisionDetail>(`/decisions/${id}`),

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
