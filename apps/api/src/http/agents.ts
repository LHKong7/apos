import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  agentPermissionChanges,
  agentRuns,
  agents,
  projects,
  users,
  workItems,
  type Database,
} from '@apos/db';
import { ACTIVE_RUN_STATUSES, DEGRADATION_MATRIX, type FeatureKey } from '@apos/contracts';
import { computeAgents, isTerminal, windowFor, type AgentPerf } from '@apos/domain';
import { checkCompatibility, type RuntimeRegistry } from '@apos/agent-runtimes';
import { runtimeKindSpec } from '@apos/contracts';
import { notFound } from './errors';
import { loadAnalyticsInput } from './analytics';

/**
 * Agent Workspace（页面文档 08）。
 *
 * ★ 设计基调是「员工档案 + 工作台」，不是「服务配置页」。
 *   所以这里返回的东西按人事口径组织：它在干什么、干得怎么样、
 *   被允许做什么、花了多少钱、出问题怎么干预 ——
 *   而不是一堆 runtime 配置字段。
 */

export async function listAgents(db: Database, projectId: string | null, orgId: string) {
  // ★ 没有 projectId 时也必须按组织收窄 —— 否则花名册会列出别的组织的 Agent
  const rows = projectId
    ? await agentsOfProject(db, projectId)
    : await db.select().from(agents).where(eq(agents.orgId, orgId));

  if (rows.length === 0) return { agents: [], totals: EMPTY_TOTALS };

  const perf = await performanceByAgent(db, projectId);
  const active = await db
    .select()
    .from(agentRuns)
    .where(inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]));

  const userRows = await db.select({ id: users.id, name: users.name }).from(users);
  const userName = new Map(userRows.map((u) => [u.id, u.name]));

  const list = rows.map((a) => {
    const p = perf.get(a.id);
    const running = active.filter((r) => r.agentId === a.id).length;
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      model: a.model,
      status: a.status,
      pausedReason: a.pausedReason,
      /** 负载：进行中的 Run / 并发上限 */
      load: { running, max: a.maxConcurrency },
      runs: p?.runs ?? 0,
      successRate: p?.successRate ?? null,
      firstTrySuccessRate: p?.firstTrySuccessRate ?? null,
      overrideRate: p?.overrideRate ?? null,
      tokens: p?.totalTokens ?? 0,
      ownerName: userName.get(a.ownerId) ?? '未知',
    };
  });

  const totalRuns = list.reduce((s, a) => s + a.runs, 0);
  return {
    agents: list,
    totals: {
      tokens: Math.round(list.reduce((s, a) => s + a.tokens, 0)),
      runs: totalRuns,
      successRate:
        totalRuns === 0
          ? null
          : round4(
              list.reduce((s, a) => s + (a.successRate ?? 0) * a.runs, 0) / totalRuns,
            ),
    },
  };
}

export async function getAgent(
  db: Database,
  registry: RuntimeRegistry,
  agentId: string,
) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) throw notFound('Agent');

  const runs = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.agentId, agentId))
    .orderBy(desc(agentRuns.createdAt))
    .limit(20);

  const itemIds = [...new Set(runs.map((r) => r.workItemId).filter((id) => id !== null))];
  const items =
    itemIds.length > 0
      ? await db.select().from(workItems).where(inArray(workItems.id, itemIds))
      : [];
  const itemById = new Map(items.map((i) => [i.id, i]));

  /**
   * ★ 「队列」只放没做完的。
   *
   *   executorId 是永久归属，不是队列 —— 直接列出来会把这个 Agent
   *   历史上干过的每一件事都算进「队列 16」，用户看到的是
   *   「它手上压了 16 个活」，而真相是 1 个在跑、15 个早就交付了。
   *   做完了多少放到 doneCount，想看历史去下面的执行记录。
   */
  const assigned = await db
    .select()
    .from(workItems)
    .where(and(eq(workItems.executorType, 'agent'), eq(workItems.executorId, agentId)));
  const queue = assigned.filter((i) => !isTerminal(i.status));
  const doneCount = assigned.length - queue.length;

  const changes = await db
    .select()
    .from(agentPermissionChanges)
    .where(eq(agentPermissionChanges.agentId, agentId))
    .orderBy(desc(agentPermissionChanges.createdAt))
    .limit(10);

  const userRows = await db.select({ id: users.id, name: users.name }).from(users);
  const userName = new Map(userRows.map((u) => [u.id, u.name]));

  const perf = await performanceByAgent(db, null);
  const p = perf.get(agentId);

  /**
   * ★ 运行时能力报告（页面文档 08 §5 / 14 §5.4）。
   *
   *   不静默降级：这个运行时做不到什么、做不到会怎样、对用户什么影响，
   *   全都摊开。用户在派高风险任务之前有权知道
   *   「这个 Agent 的暂停其实是终止」。
   */
  let capability: CapabilityReport | null = null;
  if (registry.has(agent.id)) {
    try {
      const manifest = await registry.get(agent.id).getCapabilities();
      capability = buildCapability(manifest);
    } catch {
      capability = null;
    }
  }

  return {
    agent: {
      id: agent.id,
      name: agent.name,
      type: agent.type,
      description: agent.description,
      model: agent.model,
      status: agent.status,
      pausedReason: agent.pausedReason,
      skills: agent.skills,
      applicableTypes: agent.applicableTypes,
      maxConcurrency: agent.maxConcurrency,
      timeoutSeconds: agent.timeoutSeconds,
      tokenLimitPerRun: agent.tokenLimitPerRun,
      tokenLimitDaily: agent.tokenLimitDaily,
      ownerName: userName.get(agent.ownerId) ?? '未知',
      /** 运行时是 Agent 自己的属性，不再指向一个共享的「接入」对象 */
      runtime: {
        kind: agent.runtimeKind,
        config: agent.runtimeConfig,
        endpoint: agent.endpoint,
        credentialHint: agent.credentialHint,
      },
    },

    /**
     * ★ 权限独立配置，绝不继承人类用户（产品文档 十）。
     *   页面把黑名单单独列出来并标注「不可被模板或继承覆盖」——
     *   一个看不出边界的 Agent 档案，等于没有边界。
     */
    permissions: {
      allowedTools: agent.allowedTools,
      deniedTools: agent.deniedTools,
      resourceScopes: agent.resourceScopes,
    },

    performance: p
      ? {
          runs: p.runs,
          successRate: p.successRate,
          firstTrySuccessRate: p.firstTrySuccessRate,
          overrideRate: p.overrideRate,
          avgTokens: p.avgTokens,
          totalTokens: p.totalTokens,
          avgMinutes: p.avgMinutes,
        }
      : null,

    /** 执行中的排在最前 —— 「它现在在做什么」是这一段要回答的第一个问题 */
    queue: queue
      .sort((a, b) => queueRank(a.status) - queueRank(b.status))
      .map((i) => ({
        id: i.id,
        title: i.title,
        status: i.status,
        riskLevel: i.riskLevel,
      })),
    queueDoneCount: doneCount,

    recentRuns: runs.map((r) => ({
      id: r.id,
      kind: r.kind,
      workItemId: r.workItemId,
      // ★ 规划 Run 本来就没有工作项 —— 与「工作项被删了」是两回事，别混成一句话
      workItemTitle: r.workItemId
        ? (itemById.get(r.workItemId)?.title ?? '（已删除）')
        : '（需求分析 / 计划生成）',
      status: r.status,
      attempt: r.attempt,
      cost: Number(r.cost),
      errorClass: r.errorClass,
      startedAt: r.startedAt?.toISOString() ?? null,
      endedAt: r.endedAt?.toISOString() ?? null,
    })),

    capability,

    /** 权限变更历史 —— 谁在什么时候放宽了这个 Agent 的边界 */
    permissionChanges: changes.map((c) => ({
      direction: c.direction,
      changedBy: userName.get(c.changedBy) ?? c.changedBy,
      reason: c.reason,
      createdAt: c.createdAt.toISOString(),
    })),
  };
}

/**
 * 运行时能力清单（页面文档 14 §5.4 的真实部分）。
 *
 * 这是「集成设置」里唯一有真实后端支撑的一块：能力协商与降级矩阵
 * 已经在 Agent 协议里实现了，外部系统对接（Jira / GitHub / Slack）
 * 则完全没有后端，那部分不做。
 *
 * ★ 取消「运行时接入」层之后，这里按 **CLI 类型**聚合而不是按接入行 ——
 *   要回答的问题是「本组织在用哪几种 Code Agent、各自能力如何」，
 *   而不是「有几条接入记录」。同一类型下的多个 Agent 能力清单一致，
 *   取其中任意一个已注册的探测即可。
 */
export async function listRuntimes(db: Database, registry: RuntimeRegistry) {
  const agentRows = await db.select().from(agents);

  const byKind = new Map<string, typeof agentRows>();
  for (const a of agentRows) {
    const list = byKind.get(a.runtimeKind);
    if (list) list.push(a);
    else byKind.set(a.runtimeKind, [a]);
  }

  const out = [];
  for (const [kind, used] of byKind) {
    const spec = runtimeKindSpec(kind);
    // 取第一个已注册的 Agent 探测能力 —— 同类型的清单一致
    const probeTarget = used.find((a) => registry.has(a.id));

    let capability: CapabilityReport | null = null;
    let reachable = false;
    if (probeTarget) {
      try {
        capability = buildCapability(await registry.get(probeTarget.id).getCapabilities());
        reachable = true;
      } catch {
        reachable = false;
      }
    }

    out.push({
      id: kind,
      name: spec?.label ?? kind,
      kind,
      status: used.some((a) => a.status === 'active') ? 'active' : 'inactive',
      protocolVersion: capability?.protocolVersion ?? null,
      /** 进程里一个适配器都没注册 = 这一类运行时现在根本派不出任务 */
      registered: Boolean(probeTarget),
      reachable,
      agentCount: used.length,
      agentNames: used.map((a) => a.name),
      capability,
    });
  }

  return { runtimes: out };
}

/** 队列排序：在跑的 → 卡住的 → 排队的。等人的排在「卡住」一档，因为它确实动不了 */
function queueRank(status: string): number {
  if (status === 'executing' || status === 'releasing') return 0;
  if (status === 'blocked' || status === 'failed' || status === 'awaiting_decision') return 1;
  return 2;
}

type CapabilityReport = ReturnType<typeof buildCapability>;

function buildCapability(manifest: Awaited<ReturnType<import('@apos/agent-runtimes').AgentRuntimeAdapter['getCapabilities']>>) {
  const report = checkCompatibility(manifest);
  return {
    runtime: manifest.runtime,
    protocolVersion: manifest.protocolVersion,
    transport: manifest.transport,
    models: manifest.models,
    limits: manifest.limits,
    tools: manifest.tools,
    supported: report.supported.map((f) => ({ feature: f, label: FEATURE_LABELS[f] ?? f })),
    missing: report.missing.map((m) => ({
      ...m,
      label: FEATURE_LABELS[m.feature] ?? m.feature,
    })),
    /** critical 缺失 = 不该用它跑高风险任务 */
    restricted: report.restricted,
  };
}

/** 能力项的中文名。这份清单是给项目负责人读的，不是给协议实现者读的。 */
const FEATURE_LABELS: Record<FeatureKey, string> = {
  streamingEvents: '实时事件流',
  toolCallVisibility: '工具调用可见',
  reasoningVisibility: '推理过程可见',
  costReporting: '成本上报',
  tokenReporting: 'Token 用量上报',
  progressReporting: '进度上报',
  runtimeConstraints: '执行中注入约束',
  interventionRequest: 'Agent 主动求助',
  selfReportOnFailure: '失败时自述原因',
  pause: '暂停（可恢复）',
  terminate: '终止',
  statusQuery: '主动查询状态',
  subAgentDelegation: '子 Agent 委派',
  artifactUpload: '产物上传',
};

void DEGRADATION_MATRIX;

async function agentsOfProject(db: Database, projectId: string) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw notFound('项目');
  return db.select().from(agents).where(eq(agents.orgId, project.orgId));
}

/** 效能口径与 Analytics 完全一致 —— 两处各算一套迟早对不上 */
async function performanceByAgent(
  db: Database,
  projectId: string | null,
): Promise<Map<string, AgentPerf>> {
  const projectRows = projectId
    ? await db.select().from(projects).where(eq(projects.id, projectId))
    : await db.select().from(projects);

  const now = Date.now();
  const window = windowFor('30d', now);
  const merged = new Map<string, AgentPerf>();

  for (const project of projectRows) {
    const input = await loadAnalyticsInput(db, project, window, now);
    for (const a of computeAgents(input).agents) {
      const seen = merged.get(a.agentId);
      if (!seen) {
        merged.set(a.agentId, a);
        continue;
      }
      // 跨项目合并按 Run 数加权，不是简单平均
      const runs = seen.runs + a.runs;
      merged.set(a.agentId, {
        ...seen,
        runs,
        successRate: weighted(seen, a, (x) => x.successRate, runs),
        firstTrySuccessRate: weighted(seen, a, (x) => x.firstTrySuccessRate, runs),
        overrideRate: weighted(seen, a, (x) => x.overrideRate, runs),
        totalTokens: Math.round(seen.totalTokens + a.totalTokens),
        avgTokens: Math.round((seen.totalTokens + a.totalTokens) / runs),
        avgMinutes:
          seen.avgMinutes === null
            ? a.avgMinutes
            : a.avgMinutes === null
              ? seen.avgMinutes
              : Math.round(((seen.avgMinutes * seen.runs + a.avgMinutes * a.runs) / runs) * 10) / 10,
      });
    }
  }

  return merged;
}

function weighted(a: AgentPerf, b: AgentPerf, pick: (x: AgentPerf) => number, runs: number): number {
  return Math.round(((pick(a) * a.runs + pick(b) * b.runs) / runs) * 1000) / 1000;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

const EMPTY_TOTALS = { cost: 0, runs: 0, successRate: null as number | null };
