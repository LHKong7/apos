import { eq, sql } from 'drizzle-orm';
import {
  agentRuns,
  agents,
  artifacts,
  decisionOptions,
  decisions,
  projects,
  repositories,
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
import type { WorkspaceProvisioner } from '../workspace/provisioner';
import { findAlternativeAgent } from './matching';

export interface IngestDeps {
  workspaces?: WorkspaceProvisioner;
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
    const [item] = await db.select().from(workItems).where(eq(workItems.id, run.workItemId));
    if (item) {
      await db
        .update(workItems)
        .set({
          typeData: {
            ...item.typeData,
            qualityGate: {
              ...((item.typeData['qualityGate'] as Record<string, unknown>) ?? {}),
              testsPassed: result.check.passed,
              testCommand: result.check.command,
              testDurationMs: result.check.durationMs,
              testCheckedAt: new Date().toISOString(),
              testSource: 'workspace_check',
            },
          },
        })
        .where(eq(workItems.id, run.workItemId));
    }

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

  if (!result.committed || !result.headCommit) return;

  const [repo] = await db
    .select()
    .from(repositories)
    .where(eq(repositories.id, run.workspace.repoId));

  /**
   * ★ 代码产物是「分支 + commit」，不是从回复文本里正则抓来的 PR 链接。
   *   前者是执行的事实，后者是模型的自述 —— 模型说它开了 PR 而实际没开，
   *   这种事会发生，而评审者看到的是一个 404。
   */
  await db.insert(artifacts).values({
    orgId: run.orgId,
    projectId: run.projectId,
    workItemId: run.workItemId,
    runId: run.id,
    kind: 'code',
    title: `${result.branch}（${result.changedFiles} 个文件）`,
    storage: 'external',
    externalUrl: repo ? branchUrl(repo.remoteUrl, result.branch!) : null,
    content: null,
    metadata: {
      repoRef: run.workspace.repoRef,
      branch: result.branch,
      baseBranch: run.workspace.baseBranch,
      baseCommit: run.workspace.baseCommit,
      headCommit: result.headCommit,
      changedFiles: result.changedFiles,
      pushed: result.pushed,
      // 没推送时明确说明改动在哪 —— 否则「有产物但打不开」会被当成 bug
      note: result.pushed ? null : '改动已提交到本地分支但未推送，可由运维补推',
    },
    producedByType: 'agent',
    producedById: run.agentId,
  });
}

/** git remote → 可点开的分支页面。认不出来的 host 就不给链接，不编 */
function branchUrl(remoteUrl: string, branch: string): string | null {
  const m = remoteUrl.match(/(?:https?:\/\/|git@)([^/:]+)[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (!m) return null;
  const [, host, owner, repo] = m;
  if (host?.includes('github')) return `https://${host}/${owner}/${repo}/tree/${branch}`;
  if (host?.includes('gitlab')) return `https://${host}/${owner}/${repo}/-/tree/${branch}`;
  return null;
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
