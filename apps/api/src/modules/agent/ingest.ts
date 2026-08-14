import { eq, sql } from 'drizzle-orm';
import {
  agentRuns,
  agents,
  artifacts,
  decisionOptions,
  decisions,
  projects,
  runEvents,
  workItems,
  type Database,
} from '@apos/db';
import {
  agentActor,
  MILESTONE_RUN_EVENTS,
  type InterventionRequest,
  type RunEvent,
} from '@apos/contracts';
import { decideRecovery } from '@apos/domain';
import { emit } from '../event/emitter';
import { emitAndPublish } from '../event/bus';
import { transition } from '../flow/transition';
import type { ReleaseResult, WorkspaceService } from '../workspace';
import { mergeTypeDataNested } from '../work-item/json-merge';
import { findAlternativeAgent } from './matching';

export interface IngestDeps {
  workspaces?: WorkspaceService;
}

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
export async function ingestRunEvent(
  db: Database,
  input: IngestInput,
  deps: IngestDeps = {},
): Promise<IngestResult> {
  const { runId, event, correlationId } = input;

  const [raw] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  if (!raw) return { stored: false, promoted: false, transitioned: false };

  /**
   * ★★ 规划 Run 不走这条回调通道。
   *
   *   它由 AgentPlanningProvider 在进程内直接 await，事件也由它自己收。
   *   真要有一条规划 Run 打到这里，它没有工作项，下面每一步（流转、产物、
   *   失败恢复）都无从谈起 —— 与其让它在某个 `where id = null` 上静默失效，
   *   不如在入口就说清楚不处理。
   */
  if (raw.workItemId === null) {
    return { stored: false, promoted: false, transitioned: false };
  }
  const run: RunRow = { ...raw, workItemId: raw.workItemId };

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

  /**
   * ★ 工作区收尾必须在状态流转**之前**。
   *
   *   流转到 reviewing 意味着「这份产出可以给人看了」，而此刻代码还躺在
   *   一棵临时工作树里 —— 评审者点开只会看到一条没有实体的记录。
   *   先提交推送、把分支落成产物，再让任务前进。
   */
  if (event.type === 'run_ended') {
    await settleWorkspace(db, run, event, deps);
  }

  const promotion = await promote(db, run, event, correlationId);
  return { stored: true, ...promotion };
}

/**
 * Run 结束时收工作区：提交 → 推送 → 落成产物。
 *
 * 收尾出错不会让 Run 从成功翻成失败 —— 代码已经跑完了，
 * 推送失败是运维问题，改动还在本地分支上可以人工补推。
 */
async function settleWorkspace(
  db: Database,
  run: RunRow,
  event: Extract<RunEvent, { type: 'run_ended' }>,
  deps: IngestDeps,
): Promise<void> {
  if (!deps.workspaces || !run.workspace) return;

  const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId));

  const result = await deps.workspaces.release({
    runId: run.id,
    outcome: event.outcome === 'completed' ? 'completed' : event.outcome,
    summary: event.summary,
    agentName: agent?.name ?? 'agent',
  });

  await db.insert(runEvents).values({
    runId: run.id,
    // 收尾发生在 run_ended 之后，seq 取一个必然更大的值
    seq: event.seq + 1,
    ts: new Date(),
    type: 'note',
    level: 'detail',
    summary: `工作区收尾：${result.note}`,
    payload: { type: 'note', text: result.note, workspace: result },
  }).onConflictDoNothing();

  /**
   * ★ 把核验结果写进 qualityGate —— 这是 `qualityGatePassed` 这道门禁
   *   第一次拿到**证据**而不是自述。此前它读的是 typeData.qualityGate，
   *   而那份数据除了 CI 集成之外没有任何来源，于是默认全部为「通过」。
   */
  if (result.check.ran) {
    /**
     * ★ 合并在一条 UPDATE 里做，不再「读出来 → 展开 → 写回去」。
     *   qualityGate 的另一个写入者是 CI 回灌（integrations.ts），
     *   两边撞上时后写的那个会带着旧值覆盖整列 —— 丢掉的正是
     *   qualityGatePassed 这道门禁要读的证据。见 work-item/json-merge.ts。
     */
    await db
      .update(workItems)
      .set({
        typeData: mergeTypeDataNested('qualityGate', {
          testsPassed: result.check.passed,
          testCommand: result.check.command,
          testDurationMs: result.check.durationMs,
          testCheckedAt: new Date().toISOString(),
          testSource: 'workspace_check',
        }),
      })
      .where(eq(workItems.id, run.workItemId));

    await db
      .insert(runEvents)
      .values({
        runId: run.id,
        seq: event.seq + 2,
        ts: new Date(),
        type: 'tool_result',
        level: 'milestone',
        summary: `质量核验 ${result.check.passed ? '通过' : '未通过'}：${result.check.command}`,
        payload: {
          type: 'tool_result',
          ok: result.check.passed,
          summary: result.check.output.slice(-4000),
        },
      })
      .onConflictDoNothing();
  }

  await recordWorkspaceArtifact(db, run, result);
}

/** 变更集里最多记多少个文件名进 metadata */
const CHANGE_LIST_CAP = 200;

/**
 * 把收尾结果记成产物。
 *
 * ★ 代码产物是「分支 + commit」，不是从回复文本里正则抓来的 PR 链接。
 *   前者是执行的事实，后者是模型的自述 —— 模型说它开了 PR 而实际没开，
 *   这种事会发生，而评审者看到的是一个 404。
 *
 * ★ 按 published.kind 分派，而不是假设一定是 Git。分支 URL 的拼法已经
 *   搬进 GitPublisher —— 那是 Git 专属知识，不该待在这个后端无关的步骤里。
 */
async function recordWorkspaceArtifact(
  db: Database,
  run: RunRow,
  result: ReleaseResult,
): Promise<void> {
  const { published, changes } = result;

  // 什么都没产出就不记 —— 一条「0 个文件」的产物只会污染评审视图
  if (changes.total === 0 && published.kind !== 'git') return;
  if (published.kind === 'git' && !published.headCommit) return;

  const base = {
    orgId: run.orgId,
    projectId: run.projectId,
    workItemId: run.workItemId,
    runId: run.id,
    kind: 'code' as const,
    content: null,
    producedByType: 'agent' as const,
    producedById: run.agentId,
  };

  /**
   * ★ 记的是变更集而不是只记一个计数。评审时「改了哪些文件」比「改了 3 个
   *   文件」有用得多，而这个信息在算 diff 的那一刻本来就在手上。
   *   截断了必须说出来 —— 否则前端会把这 200 个当成全部。
   */
  const changeSet = {
    total: changes.total,
    added: changes.added.slice(0, CHANGE_LIST_CAP),
    modified: changes.modified.slice(0, CHANGE_LIST_CAP),
    deleted: changes.deleted.slice(0, CHANGE_LIST_CAP),
    listTruncated:
      changes.added.length > CHANGE_LIST_CAP ||
      changes.modified.length > CHANGE_LIST_CAP ||
      changes.deleted.length > CHANGE_LIST_CAP,
    /** 变更集本身就不完整（目录过大或基线丢失），比列表截断严重 */
    incomplete: changes.truncated,
  };

  if (published.kind === 'git') {
    await db.insert(artifacts).values({
      ...base,
      title: `${published.branch}（${changes.total} 个文件）`,
      storage: 'external',
      externalUrl: published.url,
      metadata: {
        source: { kind: 'git', repoRef: run.workspace?.repoRef ?? null },
        branch: published.branch,
        baseBranch: run.workspace?.baseBranch ?? null,
        baseCommit: run.workspace?.baseCommit ?? null,
        headCommit: published.headCommit,
        pushed: published.pushed,
        changedFiles: changes.total,
        changes: changeSet,
        // 没推送时明确说明改动在哪 —— 否则「有产物但打不开」会被当成 bug
        note: published.pushed ? null : '改动已提交到本地分支但未推送，可由运维补推',
      },
    });
    return;
  }

  if (published.kind === 'object_storage') {
    await db.insert(artifacts).values({
      ...base,
      title: `${published.bucket}/${published.prefix}（${published.uploaded} 个对象）`,
      // ★ 认得出控制台地址才算 external；认不出就没有可点开的东西
      storage: published.url ? 'external' : 'inline',
      externalUrl: published.url,
      storageKey: `${published.bucket}/${published.prefix}`,
      metadata: {
        source: { kind: 'object_storage', bucket: published.bucket, prefix: published.prefix },
        uploaded: published.uploaded,
        removed: published.removed,
        changedFiles: changes.total,
        changes: changeSet,
        persisted: published.persisted,
        note: published.note,
      },
    });
    return;
  }

  if (published.kind === 'local') {
    await db.insert(artifacts).values({
      ...base,
      title: `工作区产出（${published.files} 个文件）`,
      storage: 'inline',
      externalUrl: null,
      storageKey: published.archivePath,
      metadata: {
        source: { kind: 'local', archivePath: published.archivePath },
        changedFiles: changes.total,
        changes: changeSet,
        persisted: published.persisted,
        note: published.note,
      },
    });
    return;
  }

  /**
   * ★ 没有交货后端：产出只在一个临时工作目录里，没有可点开的链接，
   *   而且工作区收尾就会被回收。如实写明「未持久化」，
   *   而不是给一个假的 externalUrl —— 点开 404 比没有链接更糟。
   */
  await db.insert(artifacts).values({
    ...base,
    title: `工作区产出（${changes.total} 个文件）`,
    storage: 'inline',
    externalUrl: null,
    metadata: {
      source: { kind: published.kind },
      changedFiles: changes.total,
      changes: changeSet,
      persisted: published.persisted,
      note: published.note,
    },
  });
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

/**
 * 执行 Run —— workItemId 一定有值。
 *
 * ★★ agent_runs.work_item_id 放开成可空之后（规划 Run 发生在工作项存在之前），
 *   这个文件里的每个帮手都只处理执行 Run：它们做的事情全是围绕工作项的
 *   （流转状态、写产物、判失败恢复），对一条没有工作项的记录一条都不成立。
 *   把这个前提写进类型，而不是在每处 `run.workItemId!` 断言一遍 ——
 *   断言会在将来某次改动里静默地变成一个真的 null。
 *
 *   入口的守卫在 ingestRunEvent 里，只有一处。
 */
type RunRow = typeof agentRuns.$inferSelect & { workItemId: string };

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

    /**
     * Agent 主动求助 —— PROMOTED_RUN_EVENTS 规定它提升为 decision.created。
     *
     * 这是 Agent 唯一能把「我卡住了」变成人类待办的通道：
     * 不落成 Decision，Agent 的求助就只是一条淹没在执行流里的日志。
     */
    case 'intervention_request': {
      const moved = await transition(db, {
        workItemId: run.workItemId,
        trigger: 'decision_required',
        actor,
        correlationId,
      });

      const [item] = await db.select().from(workItems).where(eq(workItems.id, run.workItemId));

      // transition 里 Policy 也可能建了一条决策。同一时刻只该有一个待办，
      // 那就把 Agent 的问题补进那一条，而不是再开一条。
      const request = event.request;
      const background = renderInterventionBackground(request);
      const existingId = moved.ok ? moved.createdDecisionId : null;

      const decisionId =
        existingId ??
        (
          await db
            .insert(decisions)
            .values({
              orgId: run.orgId,
              projectId: run.projectId,
              workItemId: run.workItemId,
              runId: run.id,
              type: 'agent_intervention',
              status: 'pending',
              riskLevel: item?.riskLevel ?? 'medium',
              reversible: true,
              title: request.question,
              background,
              whyHuman: `Agent 主动请求人工介入（${request.reason}）`,
              consequence:
                request.urgency === 'blocking'
                  ? '不处理则该任务无法继续'
                  : '不处理则该任务只能降级完成',
              impact: { runId: run.id, reason: request.reason, urgency: request.urgency },
              dueAt: new Date(Date.now() + (request.urgency === 'blocking' ? 2 : 8) * 3600_000),
            })
            .returning({ id: decisions.id })
        )[0]!.id;

      if (existingId) {
        // Policy 已经建了一条：补上 Agent 的问题，而不是再开一条待办
        await db
          .update(decisions)
          .set({ background, runId: run.id })
          .where(eq(decisions.id, existingId));
      }

      if (request.options?.length) {
        await db.insert(decisionOptions).values(
          request.options.map((o, i) => ({
            decisionId,
            name: o.label,
            description: o.description,
            isRecommended: request.recommendation?.optionId === o.id,
            confidence:
              request.recommendation?.optionId === o.id
                ? String(request.recommendation.confidence)
                : null,
            rationale:
              request.recommendation?.optionId === o.id ? request.recommendation.rationale : null,
            attributes: { optionId: o.id, consequence: o.consequence },
            position: i,
          })),
        );
      }

      await emitAndPublish(db, {
        ...base,
        type: 'decision.created',
        subjectType: 'decision',
        subjectId: decisionId,
        payload: {
          workItemId: run.workItemId,
          runId: run.id,
          reason: request.reason,
          urgency: request.urgency,
          source: 'agent_intervention',
        },
      });

      return { promoted: true, transitioned: moved.ok };
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

  /**
   * ★ 这里以前硬编码 false，后果是 `switch_agent` 这条分支永远不可达 ——
   *   capability_mismatch 一律退化成 transfer_to_human，
   *   而「换个更合适的 Agent 再试」本来是最该先试的一步。
   */
  const alternative = item ? await findAlternativeAgent(db, item, run.agentId) : null;

  const recovery = decideRecovery({
    errorClass: (run.errorClass as never) ?? 'unknown',
    attempt: run.attempt,
    maxAttempts: 3,
    hasAlternativeAgent: alternative !== null,
    costRatio: estimated > 0 ? spent / estimated : 0,
    consecutiveFailures: consecutive,
  });

  /**
   * ★ 把恢复决策落到 Run 行上，交给 recovery-worker 执行。
   *
   *   此前这里只把 recovery 塞进事件 payload 就结束了 —— 那份精心分类的
   *   策略（permission_denied 不重试、context_insufficient 补上下文再试、
   *   capability_mismatch 换 Agent）从来没有任何代码去执行它。
   */
  const backoff = backoffFor(db, run, recovery.action);
  await db
    .update(agentRuns)
    .set({
      recoveryAction: recovery.action,
      recoveryReason: recovery.reason,
      recoveryAgentId: recovery.action === 'switch_agent' ? alternative : null,
      recoveryNotBefore: await backoff,
      recoveryAppliedAt: null,
    })
    .where(eq(agentRuns.id, run.id));

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
      // recovery worker 要换 Agent 时不必再算一遍
      alternativeAgentId: alternative,
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

/**
 * 退避到点时间。
 *
 * ★ 只对「立刻重来」这类动作退避。转人工、请决策本来就要等人，
 *   再压 60 秒退避只会让待办晚一分钟出现在收件箱里。
 */
async function backoffFor(
  db: Database,
  run: RunRow,
  action: string,
): Promise<Date | null> {
  const IMMEDIATE_RETRY = ['retry', 'retry_with_context', 'switch_agent'];
  if (!IMMEDIATE_RETRY.includes(action)) return null;

  const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId));
  const policy = (agent?.retryPolicy ?? {}) as { backoff_seconds?: unknown };
  const list = Array.isArray(policy.backoff_seconds)
    ? policy.backoff_seconds.filter((n): n is number => typeof n === 'number')
    : [60, 300];

  // attempt 从 1 开始；第 1 次失败用第 1 档退避
  const seconds = list[Math.min(run.attempt - 1, list.length - 1)] ?? 60;
  return new Date(Date.now() + seconds * 1000);
}

/** 决策页要能不看执行流就明白 Agent 在问什么 —— 把请求展开成可读文本 */
function renderInterventionBackground(request: InterventionRequest): string {
  const lines = [request.question];

  if (request.options?.length) {
    lines.push('', 'Agent 给出的选项：');
    for (const o of request.options) {
      lines.push(`- ${o.label}：${o.description}（后果：${o.consequence}）`);
    }
  }

  if (request.recommendation) {
    const r = request.recommendation;
    lines.push('', `Agent 倾向：${r.optionId}（置信度 ${r.confidence}）—— ${r.rationale}`);
  }

  return lines.join('\n');
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
