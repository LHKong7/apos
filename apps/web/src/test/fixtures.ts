import type { BoardCard, BoardResponse, StreamEvent } from '../lib/api/types';

export function card(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    id: 'wi-1',
    ref: 'ORD-1',
    title: '实现多条件查询 API',
    type: 'task',
    status: 'ready',
    stage: 'execution',
    priority: 2,
    riskLevel: 'low',
    executor: null,
    owner: null,
    humanGate: null,
    humanGateRef: null,
    decisionDueInMinutes: null,
    blockedSince: null,
    blockedReason: null,
    blockedMinutes: null,
    progress: null,
    cost: '0.0000',
    estimatedCost: null,
    runId: null,
    runStatus: null,
    consecutiveFailures: 0,
    latestNote: null,
    artifactCount: 0,
    unmetDependencies: 0,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function board(cards: BoardCard[]): BoardResponse {
  const stages = ['intake', 'planning', 'execution', 'review', 'release', 'done'] as const;
  return {
    columns: stages.map((key) => {
      const items = cards.filter((c) => c.stage === key);
      return {
        key,
        name: key,
        wipLimit: null,
        count: items.length,
        items,
        hasMore: false,
      };
    }),
    summary: {
      pendingDecisions: 0,
      overdueDecisions: 0,
      blocked: 0,
      executing: 0,
      failed: 0,
    },
  };
}

export function event(overrides: Partial<StreamEvent> = {}): StreamEvent {
  return {
    id: '1',
    type: 'work_item.status_changed',
    channels: ['project:p-1:board'],
    projectId: 'p-1',
    subjectType: 'work_item',
    subjectId: 'wi-1',
    actorType: 'agent',
    actorId: 'agent-1',
    payload: {},
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}
