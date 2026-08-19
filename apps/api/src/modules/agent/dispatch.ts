import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import {
  agents,
  artifacts,
  projectConventions,
  projects,
  repositories,
  requirements,
  workItems,
  agentRuns,
  type Database,
} from '@apos/db';
import { selectPolicyGates } from '@apos/domain';
import {
  ACTIVE_RUN_STATUSES,
  agentActor,
  SYSTEM_ACTOR,
  type AgentPermissions,
  type AgentPermissionSnapshot,
  type TaskDispatch,
} from '@apos/contracts';
import { usdCeilingForTokens, type RuntimeRegistry } from '@apos/agent-runtimes';
import { emitAndPublish } from '../event/bus';
import { loadPolicies, transition } from '../flow/transition';
import { resolveAgentAccess } from './access';
import type { WorkspaceService } from '../workspace';
import { ingestRunEvent } from './ingest';

export interface DispatchInput {
  workItemId: string;
  agentId: string;
  correlationId: string;
  /** 重试时补充的上下文 */
  additionalContext?: { title: string; content: string }[];
  /** 调用方自带的幂等键；不传时按 (workItemId, attempt) 生成 */
  idempotencyKey?: string;
}

export interface DispatchDeps {
  /** 不传则退化为「不供给工作区」，仅用于不涉及代码仓库的测试 */
  workspaces?: WorkspaceService;
}

export type DispatchResult =
  | { ok: true; runId: string; attempt: number; reused: boolean }
  | {
      ok: false;
      code: 'AGENT_UNAVAILABLE' | 'TRANSITION_REJECTED' | 'WORKSPACE_UNAVAILABLE';
      detail: unknown;
    };

/**
 * 派发一次 Agent 执行。
 *
 * 三个关键点：
 * 1. idempotencyKey 防重复派发 —— 网络重试导致 Agent 重复改代码是真实风险
 * 2. dispatching 中间态 —— 区分「还没派发」与「派发了但不知道结果」
 * 3. 权限与工具集在派发时快照，Run 期间的配置变更不影响正在跑的执行
 */
export async function dispatchRun(
  db: Database,
  registry: RuntimeRegistry,
  input: DispatchInput,
  deps: DispatchDeps = {},
): Promise<DispatchResult> {
  const [item] = await db.select().from(workItems).where(eq(workItems.id, input.workItemId));
  if (!item) return { ok: false, code: 'AGENT_UNAVAILABLE', detail: 'work item not found' };

  const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId));
  if (!agent || agent.status !== 'active') {
    return { ok: false, code: 'AGENT_UNAVAILABLE', detail: { agentId: input.agentId } };
  }

  /**
   * ★ 注册表按 agentId 键控：每个 Agent 有自己的运行时实例，
   *   因为它们各带一套 CLI 参数（effort / maxTurns / 沙箱档位…）。
   */
  if (!registry.has(agent.id)) {
    return {
      ok: false,
      code: 'AGENT_UNAVAILABLE',
      detail: { agentId: agent.id, runtimeKind: agent.runtimeKind },
    };
  }

  const priorRuns = await db
    .select({ id: agentRuns.id, attempt: agentRuns.attempt, status: agentRuns.status })
    .from(agentRuns)
    .where(eq(agentRuns.workItemId, item.id));

  /**
   * ★ 核心不变式：一个 Work Item 同时只能有一个活跃 Run。
   *
   * 没有这条保护，调度器重入或回调重复投递会让两个 Agent 同时改同一份代码。
   * 这比基于 idempotencyKey 的去重更可靠 —— 后者依赖调用方生成正确的 key。
   */
  const active = priorRuns.find((r) =>
    (ACTIVE_RUN_STATUSES as readonly string[]).includes(r.status),
  );
  if (active) {
    return { ok: true, runId: active.id, attempt: active.attempt, reused: true };
  }

  const attempt = priorRuns.length + 1;
  const idempotencyKey = input.idempotencyKey ?? `${item.id}:${attempt}`;

  /**
   * 本项目**项目级**登记且启用的仓库 —— 它们对项目内的 Agent 默认只读。
   *
   * ★ 只取 projectId 命中的，org 级（projectId 为空）的不在内：
   *   org 级仓库对全组织可见，默认给出去就成了「A 项目的 Agent 自动能读
   *   B 项目的代码」。跨项目的授权必须是个决定。
   */
  const projectRepos = await db
    .select({ ref: repositories.ref })
    .from(repositories)
    .where(
      and(
        eq(repositories.orgId, item.orgId),
        eq(repositories.projectId, item.projectId),
        eq(repositories.status, 'active'),
      ),
    );

  /**
   * ★★ 权限在**这一处**求值，而不是在 acquire() 或适配器里。
   *
   *   求值结果既落库当审计凭证，又原样传给工作区供给与运行时 ——
   *   在这里算一次，三边必然一致。分头算的话，「Agent 当时实际能做什么」
   *   与「审计记录里写着它能做什么」会分叉，而这正是快照存在的意义。
   *
   * ★★ 走的是与调度器匹配**同一个**函数（resolveAgentAccess）。
   *   两条路径各算一套的后果见 modules/agent/matching.ts 里那段。
   */
  const access = await resolveAgentAccess(db, agent, {
    orgId: item.orgId,
    projectId: item.projectId,
    repoRefs: projectRepos.map((r) => r.ref),
  });

  /** 下发给运行时与工作区的那一份 —— 协议这一层仍然是工具名 */
  const permissionSnapshot: AgentPermissions = {
    allowedTools: access.runtimePermissions.allowedTools,
    deniedTools: access.runtimePermissions.deniedTools,
    resourceScopes: access.runtimePermissions.resourceScopes,
  };

  /**
   * 落库的那一份（v2）。
   *
   * ★★ 比下发的那份多了语义能力、档案与出处。半年后翻审计的人问的是
   *   「它当时被授权做什么」，而工具名回答不了 —— 同一串 `['Read','Edit']`
   *   在适配器改版前后不是一回事。
   *
   * ★ 历史快照（v1，没有 version 字段）**原样保留**，不迁移、不补写：
   *   它们是当时那次执行的凭证，改写等于伪造证据。读取侧靠 version 分辨。
   */
  const storedSnapshot: AgentPermissionSnapshot = {
    version: 2,
    profileKey: access.profileKey,
    profileVersion: access.profileVersion,
    capabilities: access.capabilities,
    deniedCapabilities: access.deniedCapabilities,
    allowedTools: permissionSnapshot.allowedTools,
    deniedTools: permissionSnapshot.deniedTools,
    resourceScopes: permissionSnapshot.resourceScopes,
    sources: access.sources,
    degradations: access.degradations,
  };

  const context = await buildRunContext(db, item, input.additionalContext);

  // 派发给某个 Agent 就意味着它是执行主体 —— 让 dispatchRun 自洽，
  // 无论是调度器调用还是手动「用这个 Agent 重试」都行为一致
  if (item.executorType !== 'agent' || item.executorId !== agent.id) {
    await db
      .update(workItems)
      .set({ executorType: 'agent', executorId: agent.id })
      .where(eq(workItems.id, item.id));
    item.executorType = 'agent';
    item.executorId = agent.id;
  }

  const runId = randomUUID();
  await db.insert(agentRuns).values({
    id: runId,
    orgId: item.orgId,
    projectId: item.projectId,
    workItemId: item.id,
    agentId: agent.id,
    attempt,
    previousRunId: priorRuns.at(-1)?.id ?? null,
    status: 'dispatching',
    idempotencyKey,
    goal: item.title,
    inputContext: context,
    model: agent.model,
    toolsSnapshot: permissionSnapshot.allowedTools,
    permissionSnapshot: storedSnapshot,
    timeoutAt: new Date(Date.now() + agent.timeoutSeconds * 1000),
  });

  await emitAndPublish(db, {
    type: 'agent_run.dispatched',
    orgId: item.orgId,
    projectId: item.projectId,
    actor: SYSTEM_ACTOR,
    subjectType: 'agent_run',
    subjectId: runId,
    payload: {
      workItemId: item.id,
      agentId: agent.id,
      attempt,
      idempotencyKey,
      contextSize: context.length,
    },
    correlationId: input.correlationId,
  });

  // 状态流转：ready → executing。被 Guard 或 Policy 拦下时不真正派发。
  const moved = await transition(db, {
    workItemId: item.id,
    trigger: 'run_dispatched',
    actor: agentActor(agent.id),
    correlationId: input.correlationId,
  });

  if (!moved.ok) {
    await db
      .update(agentRuns)
      .set({ status: 'terminated', errorClass: 'invalid_task', errorMessage: '状态流转被拒绝' })
      .where(eq(agentRuns.id, runId));
    return { ok: false, code: 'TRANSITION_REJECTED', detail: moved };
  }

  // Policy 可能把任务改道到 awaiting_decision —— 那就不该真的启动 Agent
  if (moved.to !== 'executing') {
    await db
      .update(agentRuns)
      .set({ status: 'queued', errorMessage: null })
      .where(eq(agentRuns.id, runId));
    return { ok: true, runId, attempt, reused: false };
  }

  /**
   * ★ 工作区在派发**之前**准备好，由平台统一供给。
   *
   *   放在这里而不是适配器里，是因为「clone 到哪、开哪个分支、跑完推不推」
   *   对所有运行时都一样；更重要的是失败要在这一步就被拦住 ——
   *   让 Agent 在一个空目录里开工，它会信心十足地报告
   *   「未找到相关代码，已创建新实现」，这种失败比报错难查十倍。
   */
  const acquired = deps.workspaces
    ? await deps.workspaces.acquire({
        runId,
        orgId: item.orgId,
        projectId: item.projectId,
        workItemId: item.id,
        workItemTitle: item.title,
        permissions: permissionSnapshot,
      })
    : ({ ok: true, workspace: null, note: '未启用工作区供给' } as const);

  if (!acquired.ok) {
    /**
     * ★★ 只写错误分类，**不要**在这里把 status 改成 failed。
     *
     *   ingestRunEvent 开头有一道「终态之后到达的事件一律忽略」的闸门。
     *   先把 Run 标成 failed，下面那条 run_ended 就会被这道闸门吞掉 ——
     *   于是 endedAt 不写、run_events 没有、agent_run.failed 不发、
     *   工作项也不流转，看上去调用了收尾其实什么都没发生。
     *   状态与 endedAt 由 run_ended 自己落（applyRunPatch），
     *   这里只留 decideRecovery 需要的 errorClass。
     *
     * Setting `failed` here would trip ingest's terminal-state guard and
     * silently discard the run_ended below; let the event settle the run.
     */
    await db
      .update(agentRuns)
      .set({ errorClass: 'context_insufficient', errorMessage: acquired.reason })
      .where(eq(agentRuns.id, runId));

    await ingestRunEvent(db, {
      runId,
      event: {
        runId,
        seq: 0,
        ts: new Date().toISOString(),
        type: 'run_ended',
        outcome: 'failed',
        summary: acquired.reason,
        selfReport: '平台没能为这次执行准备好代码工作区，任务未开始。',
      },
      correlationId: input.correlationId,
    });

    return { ok: false, code: 'WORKSPACE_UNAVAILABLE', detail: { reason: acquired.reason } };
  }

  /**
   * 派发前告诉 Agent 哪些情形会把这次工作拦下转人工。
   *
   * ★ 复用刚才那次流转算出来的 contextSnapshot，不重新构建 ——
   *   它就是 buildPolicyContext() 的产物，而且与写进 policy.evaluated
   *   事件的那一份是同一个对象。另起一份的话，两边会在
   *   fact 增删时悄悄漂移，而漂移的表现是「警告说会拦，实际没拦」。
   *
   * Reuses the context snapshot the transition just computed rather than
   * rebuilding it: it is the same object written into the policy.evaluated
   * event, so the warning and the actual gate can never drift apart.
   */
  const policyGates = selectPolicyGates(
    await db.transaction((tx) => loadPolicies(tx, item.orgId, item.projectId)),
    moved.verdict.contextSnapshot,
  );

  const adapter = registry.get(agent.id);
  const task: TaskDispatch = {
    runId,
    idempotencyKey,
    policyGates,
    agent: {
      name: agent.name,
      type: agent.type,
      description: agent.description,
      skills: agent.skills,
    },
    workspace: acquired.workspace,
    goal: {
      title: item.title,
      description: item.description ?? '',
      acceptanceCriteria: item.acceptanceCriteria.map((c) => ({ id: c.id, text: c.text })),
      constraints: item.constraints.map((c) => ({
        type: c.type,
        value: c.value,
        description: c.description,
      })),
    },
    context,
    permissions: permissionSnapshot,
    limits: {
      maxTokens: agent.tokenLimitPerRun,
      maxCostUsd: usdCeilingForTokens(agent.model, agent.tokenLimitPerRun),
      maxDurationSeconds: agent.timeoutSeconds,
    },
    model: agent.model,
    callback: { eventsUrl: `/api/v1/agent-callback/runs/${runId}/events`, token: runId },
  };

  const ack = await adapter.dispatch(task);
  if (!ack.accepted) {
    // ★ 同上：status 交给 run_ended 落，先写 status 会被 ingest 的终态闸门吞掉
    await db
      .update(agentRuns)
      .set({
        errorClass: 'runtime_error',
        errorMessage: ack.rejectReason ?? '运行时拒绝任务',
      })
      .where(eq(agentRuns.id, runId));

    /**
     * ★★ 运行时拒收也必须走 run_ended，和上面「工作区没准备好」那条一样。
     *
     *   此前这里只把 Run 标成 failed 就 return 了。代价是工作项停在
     *   `executing` 上永远出不来：上面那次 ready → executing 的流转没人回滚，
     *   run_events 一条没有，`agent_run.failed` 领域事件也不存在。
     *   而 run-supervisor 只认 dispatching / running 两个状态，
     *   failed 的 Run 不在它的视野里 —— 于是没有任何循环能再碰到这个工作项，
     *   看板却还按 `status = 'executing'` 数出「1 个 Agent 在跑」。
     *
     *   ingestRunEvent 一步把该做的全做了：写 run_events、置 endedAt、
     *   发 agent_run.failed、按 agent_run_failed 流转出 executing、
     *   并让 decideRecovery 决定重试还是转人工。
     *
     *   ★ 这里要把 deps 传下去（上面那条不用）：工作区**已经**取到了，
     *     不释放就会把工作树留在盘上，而 Run 已经结束、没人再来收。
     *
     *   Mirrors the workspace-unavailable branch above. Without this the item
     *   stays pinned at `executing` with no event and no loop able to reach it.
     */
    await ingestRunEvent(
      db,
      {
        runId,
        event: {
          runId,
          seq: 0,
          ts: new Date().toISOString(),
          type: 'run_ended',
          outcome: 'failed',
          summary: ack.rejectReason ?? '运行时拒绝任务',
          selfReport: '运行时拒绝接收这次派发，任务未开始。',
        },
        correlationId: input.correlationId,
      },
      deps,
    );

    return { ok: false, code: 'AGENT_UNAVAILABLE', detail: ack };
  }

  await db
    .update(agentRuns)
    .set({ status: 'running', startedAt: new Date(), lastHeartbeatAt: new Date() })
    .where(eq(agentRuns.id, runId));

  await adapter.subscribe(runId, async (event) => {
    await ingestRunEvent(db, { runId, event, correlationId: input.correlationId }, deps);
  });

  return { ok: true, runId, attempt, reused: false };
}

/** 构建 Agent 上下文。外部来源的内容标记 trusted=false，防提示注入。 */
async function buildRunContext(
  db: Database,
  item: typeof workItems.$inferSelect,
  additional: DispatchInput['additionalContext'],
): Promise<TaskDispatch['context']> {
  const ctx: TaskDispatch['context'] = [];

  /**
   * 项目工程约定 —— prompt 三层里的第三层。
   *
   * ★ 走 context 而不是 Agent 的 system prompt：编码规范是**项目**属性，
   *   对该项目里所有 Agent 一视同仁。挂在 Agent 上意味着换个 Agent
   *   就得重填一遍，还会诱导用户往里写治理规则、把 Policy 架空。
   */
  const conventions = await db
    .select()
    .from(projectConventions)
    .where(
      and(
        eq(projectConventions.projectId, item.projectId),
        eq(projectConventions.enabled, true),
        // 空 appliesTo = 全部任务类型适用
        or(
          sql`cardinality(${projectConventions.appliesTo}) = 0`,
          sql`${item.type} = ANY(${projectConventions.appliesTo})`,
        ),
      ),
    )
    .orderBy(asc(projectConventions.position), asc(projectConventions.createdAt));

  for (const c of conventions) {
    ctx.push({
      kind: 'knowledge',
      ref: c.id,
      title: `工程约定：${c.title}`,
      content: c.content,
      priority: c.priority === 'reference' ? 'reference' : 'must_read',
      trusted: true,
    });
  }

  if (item.requirementId) {
    const [req] = await db
      .select()
      .from(requirements)
      .where(eq(requirements.id, item.requirementId));
    if (req) {
      ctx.push({
        kind: 'requirement',
        ref: req.id,
        title: req.title ?? '需求说明',
        content: [req.businessContext, req.businessGoal].filter(Boolean).join('\n\n'),
        priority: 'must_read',
        trusted: true,
      });
      // 原始输入可能来自外部系统，按不可信处理
      ctx.push({
        kind: 'requirement',
        ref: `${req.id}:raw`,
        title: '原始需求描述',
        content: req.rawInput,
        priority: 'reference',
        trusted: req.inputMethod === 'manual' || req.inputMethod === 'conversation',
      });
    }
  }

  // 上一次失败的 Run：把失败原因带上，这是「补充上下文重试」的核心
  const failed = await db
    .select({
      id: agentRuns.id,
      errorClass: agentRuns.errorClass,
      errorMessage: agentRuns.errorMessage,
      selfReport: agentRuns.agentSelfReport,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.workItemId, item.id), inArray(agentRuns.status, ['failed', 'timeout'])));

  for (const run of failed) {
    ctx.push({
      kind: 'previous_run',
      ref: run.id,
      title: `上次失败（${run.errorClass}）`,
      content: [run.errorMessage, run.selfReport].filter(Boolean).join('\n'),
      priority: 'must_read',
      trusted: true,
    });
  }

  for (const extra of additional ?? []) {
    ctx.push({
      kind: 'knowledge',
      ref: randomUUID(),
      title: extra.title,
      content: extra.content,
      priority: 'must_read',
      trusted: true,
    });
  }

  return ctx;
}

export { artifacts, projects };
