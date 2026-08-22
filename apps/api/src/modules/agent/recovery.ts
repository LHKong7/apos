import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { agentRuns, agents, decisions, workItems, type Database } from '@apos/db';
import { agentActor, SYSTEM_ACTOR } from '@apos/contracts';
import type { RuntimeRegistry } from '@apos/agent-runtimes';
import { emitAndPublish } from '../event/bus';
import { transition } from '../flow/transition';
import type { WorkspaceService } from '../workspace';
import { dispatchRun } from './dispatch';

export interface RecoveryOptions {
  correlationId: string;
  workspaces?: WorkspaceService;
  limit?: number;
}

export interface RecoveryOutcome {
  runId: string;
  workItemId: string;
  action: string;
  applied: boolean;
  detail: string;
}

/**
 * recovery-worker — carries out the action that `decideRecovery` settled on.
 *
 * Splitting the decision from the execution is deliberate: the decision is a pure function (easy
 * to test, replayable), while the execution has side effects (it spends money again, it changes
 * code). The four `agent_runs.recovery*` columns sit between them, so the state "decided but not
 * yet done" survives a process restart.
 *
 * ★ Each action runs exactly once. `recoveryAppliedAt` is written **before** the action starts,
 *   not after it completes — a retry can itself fail, and a failed retry must not be retried a
 *   second time. Better to miss one automatic recovery (a person can still trigger it by hand)
 *   than to dispatch twice and end up with two Agents editing the same code.
 *
 * 判定与执行分开：判定是纯函数、执行有副作用，中间隔着 `agent_runs.recovery*` 四个字段，
 * 于是「决定了但还没做」扛得住进程重启。★ appliedAt 在动作开始前就写 —— 宁可漏一次
 * 自动恢复，也不能重复派发。
 */
export async function runRecoveryRound(
  db: Database,
  registry: RuntimeRegistry,
  opts: RecoveryOptions,
): Promise<RecoveryOutcome[]> {
  const now = new Date();

  const pending = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        inArray(agentRuns.status, ['failed', 'timeout']),
        /**
         * ★ Every recovery action revolves around a work item (reassign, hand to a human,
         *   escalate into a decision). A planning Run has no work item, so not one of them
         *   applies. This used to be blocked by accident, through the `if (!item) continue`
         *   further down — now it is stated outright.
         *
         *   规划 Run 没有工作项，恢复动作一条都不适用；此前靠下面那句意外挡住。
         */
        eq(agentRuns.kind, 'execution'),
        isNull(agentRuns.recoveryAppliedAt),
        // Leave the ones whose backoff has not elapsed yet
        or(isNull(agentRuns.recoveryNotBefore), lte(agentRuns.recoveryNotBefore, now)),
      ),
    )
    .limit(opts.limit ?? 20);

  const outcomes: RecoveryOutcome[] = [];

  for (const run of pending) {
    if (!run.recoveryAction) continue;

    // ★ Claim it: write appliedAt first — the isNull in the WHERE guarantees that exactly one
    //   worker wins the row under concurrency
    //   抢占：先写 appliedAt，isNull 条件保证并发下只有一个 worker 拿到
    const claimed = await db
      .update(agentRuns)
      .set({ recoveryAppliedAt: now })
      .where(and(eq(agentRuns.id, run.id), isNull(agentRuns.recoveryAppliedAt)))
      .returning({ id: agentRuns.id });
    if (claimed.length === 0) continue;

    // ★ Filtered by kind='execution' above, so workItemId is necessarily non-null
    //   上面已按 kind='execution' 过滤，workItemId 必然非空
    if (!run.workItemId) continue;
    const [item] = await db.select().from(workItems).where(eq(workItems.id, run.workItemId));
    if (!item) continue;

    /**
     * ★ If the work item has already left `failed`, leave it alone — someone may have taken it
     *   over by hand, retried it, or simply closed it. Automatic recovery barging in at that
     *   point only cuts across what that person is doing.
     *
     *   任务已经离开 failed 就别再动它：自动恢复插进去只会打断人的处置。
     */
    if (item.status !== 'failed') {
      outcomes.push({
        runId: run.id,
        workItemId: item.id,
        action: run.recoveryAction,
        applied: false,
        detail: `任务当前状态是 ${item.status}，已被人工处置，跳过自动恢复`,
      });
      continue;
    }

    outcomes.push(await applyOne(db, registry, run, item, opts));
  }

  return outcomes;
}

type RunRow = typeof agentRuns.$inferSelect;
type ItemRow = typeof workItems.$inferSelect;

async function applyOne(
  db: Database,
  registry: RuntimeRegistry,
  run: RunRow,
  item: ItemRow,
  opts: RecoveryOptions,
): Promise<RecoveryOutcome> {
  const action = run.recoveryAction!;
  const base = { runId: run.id, workItemId: item.id, action };

  const record = async (applied: boolean, detail: string) => {
    await emitAndPublish(db, {
      orgId: run.orgId,
      projectId: run.projectId,
      actor: SYSTEM_ACTOR,
      type: 'work_item.recovery_applied',
      subjectType: 'work_item',
      subjectId: item.id,
      payload: { runId: run.id, action, applied, detail, reason: run.recoveryReason },
      correlationId: opts.correlationId,
    });
    return { ...base, applied, detail };
  };

  switch (action) {
    case 'retry':
    case 'retry_with_context': {
      const moved = await transition(db, {
        workItemId: item.id,
        trigger: 'retry_requested',
        actor: SYSTEM_ACTOR,
        reason: run.recoveryReason ?? '自动恢复',
        correlationId: opts.correlationId,
      });
      if (!moved.ok) return record(false, `无法回到 ready：${JSON.stringify(moved)}`);

      /**
       * ★ retry_with_context does not need context stitched together by hand here —
       *   buildRunContext already carries every past failure's errorMessage + selfReport as
       *   must_read. What is added below is the one thing it lacks: why this retry is happening.
       *
       *   历次失败的详情 buildRunContext 已经带上了，这里补的是「为什么重试」这条元信息。
       */
      const result = await dispatchRun(
        db,
        registry,
        {
          workItemId: item.id,
          agentId: run.agentId,
          correlationId: opts.correlationId,
          additionalContext:
            action === 'retry_with_context'
              ? [
                  {
                    title: '本次重试的原因',
                    content:
                      `${run.recoveryReason ?? '上次执行失败'}\n\n` +
                      '上一次失败的详情已在「必读上下文」里。请先说明你打算换什么做法，再动手。',
                  },
                ]
              : undefined,
        },
        { workspaces: opts.workspaces },
      );

      return result.ok
        ? record(true, `已自动重试（第 ${result.attempt} 次）`)
        : record(false, `重试派发失败：${result.code}`);
    }

    case 'switch_agent': {
      if (!run.recoveryAgentId) return record(false, '判定时没有找到可替换的 Agent');

      const [alt] = await db.select().from(agents).where(eq(agents.id, run.recoveryAgentId));
      if (!alt || alt.status !== 'active') {
        return record(false, '替补 Agent 已不可用');
      }

      const moved = await transition(db, {
        workItemId: item.id,
        trigger: 'reassigned',
        actor: SYSTEM_ACTOR,
        reason: `${run.recoveryReason ?? '能力不匹配'}，改派 ${alt.name}`,
        correlationId: opts.correlationId,
      });
      if (!moved.ok) return record(false, `无法改派：${JSON.stringify(moved)}`);

      const result = await dispatchRun(
        db,
        registry,
        {
          workItemId: item.id,
          agentId: alt.id,
          correlationId: opts.correlationId,
          additionalContext: [
            {
              title: '你是接手方',
              content:
                `上一个 Agent 因「${run.errorClass}」未能完成这个任务：${run.errorMessage ?? ''}\n` +
                '它的自述在必读上下文里。请先判断那条路是否走得通，再决定沿用还是换方案。',
            },
          ],
        },
        { workspaces: opts.workspaces },
      );

      return result.ok
        ? record(true, `已改派给 ${alt.name}`)
        : record(false, `改派派发失败：${result.code}`);
    }

    case 'transfer_to_human': {
      const moved = await transition(db, {
        workItemId: item.id,
        trigger: 'escalated_to_human',
        actor: SYSTEM_ACTOR,
        reason: run.recoveryReason ?? '超出 Agent 能力，转人工',
        correlationId: opts.correlationId,
      });
      return moved.ok
        ? record(true, '已转为人工执行')
        : record(false, `转人工失败：${JSON.stringify(moved)}`);
    }

    case 'request_decision':
    case 'pause_and_escalate':
    case 'split_task':
    case 'downgrade_model':
    case 'terminate':
      return record(true, await escalate(db, run, item, action, opts));

    default:
      return record(false, `未知的恢复动作 ${action}`);
  }
}

/**
 * For the actions that need a human verdict: create a Decision / 需要人拍板的那几类建一条决策。
 *
 * ★ Without a Decision these actions amount to nothing having happened — the work item sits in
 *   `failed`, and the answer to "why is it not retrying?" exists only inside an event payload
 *   that nobody is ever going to read.
 *
 *   不建 Decision 等于什么都没发生：任务停在 failed，理由埋在没人会看的事件 payload 里。
 */
async function escalate(
  db: Database,
  run: RunRow,
  item: ItemRow,
  action: string,
  opts: RecoveryOptions,
): Promise<string> {
  const existing = await db
    .select({ id: decisions.id })
    .from(decisions)
    .where(and(eq(decisions.workItemId, item.id), eq(decisions.status, 'pending')));
  if (existing.length > 0) return '已有待处理决策，不重复创建';

  const spec = ESCALATION[action] ?? ESCALATION['request_decision']!;

  const [decision] = await db
    .insert(decisions)
    .values({
      orgId: run.orgId,
      projectId: run.projectId,
      workItemId: item.id,
      runId: run.id,
      type: 'agent_failure',
      status: 'pending',
      riskLevel: item.riskLevel,
      reversible: true,
      title: `${item.title}：${spec.title}`,
      background: [
        `Agent 第 ${run.attempt} 次执行失败（${run.errorClass}）。`,
        run.errorMessage ?? '',
        '',
        run.agentSelfReport ? `Agent 自述：\n${run.agentSelfReport}` : '',
        '',
        `系统判定：${run.recoveryReason ?? ''}`,
      ]
        .filter(Boolean)
        .join('\n'),
      whyHuman: spec.whyHuman,
      consequence: '不处理则该任务停留在失败状态，其下游任务无法开始',
      /**
       * ★ Structured copy. It carries the **recovery action** (`action`) rather than the Chinese
       *   sentence — the UI picks a localized wording from that code and only falls back to
       *   `whyHuman` when it doesn't recognize the code. Passing the Chinese sentence along
       *   would just relocate the same problem.
       *
       *   带的是恢复动作码而不是那句中文：界面据此挑本地化说法，认不出来才回落 whyHuman。
       */
      reasonDetail: {
        whyHuman: {
          code: 'recovery_escalated' as const,
          params: { action, fallback: spec.whyHuman },
        },
        consequence: { code: 'stuck_failed' as const },
      },
      impact: { runId: run.id, errorClass: run.errorClass, recoveryAction: action },
      dueAt: new Date(Date.now() + spec.dueHours * 3600_000),
    })
    .returning({ id: decisions.id });

  await transition(db, {
    workItemId: item.id,
    trigger: 'decision_required',
    actor: agentActor(run.agentId),
    correlationId: opts.correlationId,
  });

  await emitAndPublish(db, {
    orgId: run.orgId,
    projectId: run.projectId,
    actor: SYSTEM_ACTOR,
    type: 'decision.created',
    subjectType: 'decision',
    subjectId: decision!.id,
    payload: { workItemId: item.id, runId: run.id, source: 'recovery', action },
    correlationId: opts.correlationId,
  });

  return `已创建决策：${spec.title}`;
}

const ESCALATION: Record<string, { title: string; whyHuman: string; dueHours: number }> = {
  request_decision: {
    title: '需要人工判断如何继续',
    whyHuman: '自动重试对这类错误无效，需要人提供缺失信息或改变做法',
    dueHours: 4,
  },
  pause_and_escalate: {
    title: '连续失败，已暂停自动恢复',
    whyHuman: '连续三次失败通常不是偶然，继续自动重试只会持续烧钱',
    dueHours: 2,
  },
  split_task: {
    title: '任务粒度过大，建议拆分',
    whyHuman: '拆分要重新界定验收标准与依赖，属于计划变更，不能由系统代劳',
    dueHours: 8,
  },
  downgrade_model: {
    title: '建议改用成本更低的模型重试',
    whyHuman: '换模型会影响产出质量，需要人确认这个折中是否可接受',
    dueHours: 8,
  },
  terminate: {
    title: '建议终止该任务',
    whyHuman: '终止意味着这项工作不再推进，必须由人决定',
    dueHours: 8,
  },
};
