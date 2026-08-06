import { eq, sql } from 'drizzle-orm';
import { agentRuns, artifacts, projects, runEvents, workItems, type Database } from '@apos/db';
import {
  agentActor,
  MILESTONE_RUN_EVENTS,
  SYSTEM_ACTOR,
  type RunEvent,
} from '@apos/contracts';
import { decideRecovery } from '@apos/domain';
import { emit } from '../event/emitter';
import { emitAndPublish } from '../event/bus';
import { transition } from '../flow/transition';

export interface IngestInput {
  runId: string;
  event: RunEvent;
  correlationId: string;
}

export interface IngestResult {
  stored: boolean;
  /** 该事件是否被提升为领域事件 */
  promoted: boolean;
  /** 是否触发了 Work Item 状态流转 */
  transitioned: boolean;
  recovery?: ReturnType<typeof decideRecovery>;
}

/**
 * 接收 Agent 运行事件。
 *
 * 分层原则（docs/tech/03-event-model.md §2）：绝大多数事件只落 run_events，
 * 只有少数关键事件提升为领域事件并驱动 Flow。这让 Analytics 与审计
 * 只需扫描量级小两个数量级的 events 表。
 */
export async function ingestRunEvent(db: Database, input: IngestInput): Promise<IngestResult> {
  const { runId, event, correlationId } = input;

  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  if (!run) return { stored: false, promoted: false, transitioned: false };

  // 终态之后到达的事件忽略（除非是补发的更早 seq）
  const isTerminal = ['completed', 'failed', 'timeout', 'terminated'].includes(run.status);
  if (isTerminal && event.type !== 'heartbeat') {
    return { stored: false, promoted: false, transitioned: false };
  }

  // (runId, seq) 主键天然去重，重复投递直接跳过
  const inserted = await db
    .insert(runEvents)
    .values({
      runId,
      seq: event.seq,
      ts: new Date(event.ts),
      type: event.type,
      level: MILESTONE_RUN_EVENTS.includes(event.type) ? 'milestone' : 'detail',
      summary: summarize(event),
      payload: event as unknown as Record<string, unknown>,
      costDelta: event.type === 'cost' ? String(event.deltaUsd) : null,
    })
    .onConflictDoNothing()
    .returning({ seq: runEvents.seq });

  if (inserted.length === 0) {
    return { stored: false, promoted: false, transitioned: false };
  }

  await applyRunPatch(db, run.id, event);

  const promotion = await promote(db, run, event, correlationId);
  return { stored: true, ...promotion };
}

/** 事件对 agent_runs 行的增量更新 */
async function applyRunPatch(db: Database, runId: string, event: RunEvent) {
  switch (event.type) {
    case 'heartbeat':
      await db
        .update(agentRuns)
        .set({ lastHeartbeatAt: new Date() })
        .where(eq(agentRuns.id, runId));
      return;

    case 'progress':
      await db
        .update(agentRuns)
        .set({
          stepCurrent: event.step,
          stepTotal: event.totalSteps,
          stepDescription: event.description,
          lastHeartbeatAt: new Date(),
        })
        .where(eq(agentRuns.id, runId));
      return;

    case 'note':
      await db
        .update(agentRuns)
        .set({ progressNote: event.text, lastHeartbeatAt: new Date() })
        .where(eq(agentRuns.id, runId));
      return;

    case 'tool_call':
      await db
        .update(agentRuns)
        .set({
          toolCallCount: sql`${agentRuns.toolCallCount} + 1`,
          lastHeartbeatAt: new Date(),
        })
        .where(eq(agentRuns.id, runId));
      return;

    case 'cost':
      await db
        .update(agentRuns)
        .set({
          cost: String(event.totalUsd),
          tokensInput: sql`${agentRuns.tokensInput} + ${event.tokens.input}`,
          tokensOutput: sql`${agentRuns.tokensOutput} + ${event.tokens.output}`,
          tokensCacheRead: sql`${agentRuns.tokensCacheRead} + ${event.tokens.cacheRead}`,
          lastHeartbeatAt: new Date(),
        })
        .where(eq(agentRuns.id, runId));
      return;

    case 'error':
      await db
        .update(agentRuns)
        .set({
          errorClass: event.error.class,
          errorMessage: event.error.message,
          errorDetail: { classificationSource: event.error.classificationSource },
          agentSelfReport: event.error.selfReport ?? null,
        })
        .where(eq(agentRuns.id, runId));
      return;

    case 'run_ended':
      await db
        .update(agentRuns)
        .set({
          status: event.outcome === 'completed' ? 'completed' : event.outcome === 'failed' ? 'failed' : 'terminated',
          endedAt: new Date(),
          progressNote: event.summary,
          agentSelfReport: event.selfReport ?? sql`${agentRuns.agentSelfReport}`,
        })
        .where(eq(agentRuns.id, runId));
      return;

    default:
      await db
        .update(agentRuns)
        .set({ lastHeartbeatAt: new Date() })
        .where(eq(agentRuns.id, runId));
  }
}

type RunRow = typeof agentRuns.$inferSelect;

/** 事件提升规则 —— docs/tech/06-agent-protocol.md §5.1 */
async function promote(
  db: Database,
  run: RunRow,
  event: RunEvent,
  correlationId: string,
): Promise<Omit<IngestResult, 'stored'>> {
  const actor = agentActor(run.agentId);
  const base = {
    orgId: run.orgId,
    projectId: run.projectId,
    actor,
    correlationId,
  } as const;

  switch (event.type) {
    case 'run_started':
      await emitAndPublish(db, {
        ...base,
        type: 'agent_run.started',
        subjectType: 'agent_run',
        subjectId: run.id,
        payload: { model: event.model, tools: event.toolsAvailable },
      });
      return { promoted: true, transitioned: false };

    case 'artifact': {
      const artifactId = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(artifacts)
          .values({
            orgId: run.orgId,
            projectId: run.projectId,
            workItemId: run.workItemId,
            runId: run.id,
            kind: event.artifact.kind,
            title: event.artifact.title,
            storage: event.artifact.externalUrl ? 'external' : 'inline',
            externalUrl: event.artifact.externalUrl,
            content: event.artifact.content,
            metadata: event.artifact.metadata,
            producedByType: 'agent',
            producedById: run.agentId,
          })
          .returning({ id: artifacts.id });

        await emit(tx, {
          ...base,
          type: 'artifact.produced',
          subjectType: 'artifact',
          subjectId: row!.id,
          payload: { workItemId: run.workItemId, kind: event.artifact.kind, title: event.artifact.title },
        });
        return row!.id;
      });
      return { promoted: Boolean(artifactId), transitioned: false };
    }

    case 'cost': {
      // 成本累加到项目，并在触及阈值时发事件（页面上的成本预警靠它）
      const [project] = await db
        .update(projects)
        .set({ costSpent: sql`${projects.costSpent} + ${event.deltaUsd}` })
        .where(eq(projects.id, run.projectId))
        .returning({ spent: projects.costSpent, budget: projects.budgetAmount });

      await db
        .update(workItems)
        .set({ actualCost: sql`${workItems.actualCost} + ${event.deltaUsd}` })
        .where(eq(workItems.id, run.workItemId));

      if (project?.budget) {
        const pct = (Number(project.spent) / Number(project.budget)) * 100;
        const before = ((Number(project.spent) - event.deltaUsd) / Number(project.budget)) * 100;
        for (const threshold of [80, 100]) {
          if (before < threshold && pct >= threshold) {
            await emitAndPublish(db, {
              ...base,
              type: 'project.budget_threshold_reached',
              subjectType: 'project',
              subjectId: run.projectId,
              payload: { thresholdPct: threshold, spent: project.spent, budget: project.budget },
            });
            return { promoted: true, transitioned: false };
          }
        }
      }
      return { promoted: false, transitioned: false };
    }

    case 'run_ended': {
      if (event.outcome === 'completed') {
        await emitAndPublish(db, {
          ...base,
          type: 'agent_run.completed',
          subjectType: 'agent_run',
          subjectId: run.id,
          payload: { summary: event.summary, cost: run.cost, attempt: run.attempt },
        });

        const moved = await transition(db, {
          workItemId: run.workItemId,
          trigger: 'agent_run_completed',
          actor,
          correlationId,
        });
        return { promoted: true, transitioned: moved.ok };
      }

      if (event.outcome === 'failed') {
        return handleFailure(db, run, correlationId, event.summary);
      }

      await emitAndPublish(db, {
        ...base,
        type: 'agent_run.terminated',
        subjectType: 'agent_run',
        subjectId: run.id,
        payload: { reason: event.summary },
      });
      return { promoted: true, transitioned: false };
    }

    default:
      return { promoted: false, transitioned: false };
  }
}

/**
 * 失败处理：写事件 → 流转到 failed → 按错误分类决定恢复动作。
 *
 * 恢复决策本身不在这里执行（那是 scheduler / recovery worker 的事），
 * 这里只负责判定并记录，保证责任单一。
 */
async function handleFailure(
  db: Database,
  run: RunRow,
  correlationId: string,
  summary: string,
): Promise<Omit<IngestResult, 'stored'>> {
  const actor = agentActor(run.agentId);

  const [item] = await db.select().from(workItems).where(eq(workItems.id, run.workItemId));
  const consecutive = (item?.consecutiveFailures ?? 0) + 1;

  await db
    .update(workItems)
    .set({ consecutiveFailures: consecutive })
    .where(eq(workItems.id, run.workItemId));

  const estimated = Number(item?.estimatedCost ?? 0);
  const spent = Number(item?.actualCost ?? 0);

  const recovery = decideRecovery({
    errorClass: (run.errorClass as never) ?? 'unknown',
    attempt: run.attempt,
    maxAttempts: 3,
    hasAlternativeAgent: false,
    costRatio: estimated > 0 ? spent / estimated : 0,
    consecutiveFailures: consecutive,
  });

  await emitAndPublish(db, {
    orgId: run.orgId,
    projectId: run.projectId,
    actor,
    correlationId,
    type: 'agent_run.failed',
    subjectType: 'agent_run',
    subjectId: run.id,
    payload: {
      errorClass: run.errorClass,
      errorMessage: run.errorMessage,
      selfReport: run.agentSelfReport,
      attempt: run.attempt,
      consecutiveFailures: consecutive,
      summary,
      recovery,
    },
  });

  const moved = await transition(db, {
    workItemId: run.workItemId,
    trigger: 'agent_run_failed',
    actor,
    correlationId,
  });

  return { promoted: true, transitioned: moved.ok, recovery };
}

function summarize(event: RunEvent): string {
  switch (event.type) {
    case 'run_started':
      return `Run 启动（${event.model}）`;
    case 'context_loaded':
      return `加载上下文 ${event.items.length} 项`;
    case 'progress':
      return event.description;
    case 'reasoning':
      return event.summary;
    case 'tool_call':
      return `调用 ${event.tool}`;
    case 'tool_result':
      return `${event.ok ? '✓' : '✗'} ${event.summary}`;
    case 'artifact':
      return `产出 ${event.artifact.title}`;
    case 'delegation':
      return `委派子 Agent ${event.agentRef}`;
    case 'cost':
      return `成本 +$${event.deltaUsd.toFixed(4)}`;
    case 'intervention_request':
      return `请求人工介入：${event.request.question}`;
    case 'note':
      return event.text;
    case 'heartbeat':
      return '心跳';
    case 'error':
      return `错误（${event.error.class}）：${event.error.message}`;
    case 'run_ended':
      return `Run 结束：${event.outcome}`;
  }
}
