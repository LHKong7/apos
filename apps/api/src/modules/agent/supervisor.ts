import { and, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import { agentRuns, agents, agentRuntimes, runEvents, type Database } from '@apos/db';
import { ACTIVE_RUN_STATUSES, type RunEvent } from '@apos/contracts';
import { UnsupportedFeatureError, type RuntimeRegistry } from '@apos/agent-runtimes';
import type { WorkspaceProvisioner } from '../workspace/provisioner';
import { ingestRunEvent } from './ingest';

export interface SuperviseOptions {
  /** 无心跳多久算失联。协议规定 3×心跳间隔且不少于 90s */
  heartbeatTimeoutMs?: number;
  correlationId: string;
  workspaces?: WorkspaceProvisioner;
}

export interface SuperviseReport {
  scanned: number;
  timedOut: string[];
  orphanedResolved: string[];
  stillRunning: string[];
}

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 90_000;

/**
 * run-supervisor —— 架构文档 §3.3 规定的必须组件。
 *
 * 它回答一个问题：**没有事件回来的 Run，现在到底怎么样了？**
 *
 * 在此之前 `agent_runs.timeoutAt` / `lastHeartbeatAt` 两个字段和
 * `agent_runs_heartbeat_idx` 索引都建好了，但没有任何 worker 扫描它们 ——
 * 一个 Agent 挂掉之后，那条 Run 会永远停在 `running`，占着
 * 「一个 Work Item 只能有一个活跃 Run」的名额，把整张卡片钉死。
 *
 * 三种情况分开处理，因为它们的结论完全不同：
 *
 * | 情况 | 判据 | 处理 |
 * | --- | --- | --- |
 * | 超时 | 已过 timeoutAt | 发终止指令 + 判 timeout |
 * | 失联但仍在跑 | 心跳超期，但 queryStatus 说 running | 只续心跳，不动它 |
 * | 孤儿 | 心跳超期，且运行时说它已终止/查不到 | 判失败并走恢复 |
 *
 * ★ 中间那一栏是这个组件存在的意义。只按心跳判死，会把跑长任务
 *   （比如一次大重构，二十分钟不产生事件）的 Agent 误杀，
 *   而它其实好好的 —— 杀掉的代价是那二十分钟的成本白烧。
 */
export async function superviseRuns(
  db: Database,
  registry: RuntimeRegistry,
  opts: SuperviseOptions,
): Promise<SuperviseReport> {
  const heartbeatTimeout = opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const now = new Date();
  const staleBefore = new Date(now.getTime() - heartbeatTimeout);

  const rows = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        inArray(agentRuns.status, ['dispatching', 'running']),
        or(
          and(isNotNull(agentRuns.timeoutAt), lt(agentRuns.timeoutAt, now)),
          /**
           * ★ 这里必须显式 ::timestamptz。drizzle 无法从裸 sql 表达式推出
           *   比较对象的类型，会把 Date 原样交给驱动，报一句
           *   「Received an instance of Date」—— 而堆栈里完全看不出是哪个查询。
           */
          sql`coalesce(${agentRuns.lastHeartbeatAt}, ${agentRuns.createdAt}) < ${staleBefore.toISOString()}::timestamptz`,
        ),
      ),
    );

  const report: SuperviseReport = {
    scanned: rows.length,
    timedOut: [],
    orphanedResolved: [],
    stillRunning: [],
  };

  for (const run of rows) {
    const expired = run.timeoutAt !== null && run.timeoutAt < now;

    if (expired) {
      await handleTimeout(db, registry, run, opts);
      report.timedOut.push(run.id);
      continue;
    }

    const verdict = await probeRun(db, registry, run);

    if (verdict === 'alive') {
      // ★ 运行时说它还活着，就续一次心跳，别让下一轮再判一遍
      await db
        .update(agentRuns)
        .set({ lastHeartbeatAt: new Date() })
        .where(eq(agentRuns.id, run.id));
      report.stillRunning.push(run.id);
      continue;
    }

    await finishRun(db, run, {
      outcome: 'failed',
      errorClass: 'runtime_error',
      message:
        verdict === 'gone'
          ? '运行时已不再持有这次执行（进程重启或会话丢失），判定为中断'
          : `超过 ${Math.round(heartbeatTimeout / 1000)} 秒没有任何事件，且无法探测运行时状态`,
      selfReport:
        '这次执行失去了联系。可能是运行时进程重启，也可能是外部服务中断。' +
        '如果 Agent 已经改动了代码，改动保留在它的工作分支上。',
      correlationId: opts.correlationId,
      workspaces: opts.workspaces,
    });
    report.orphanedResolved.push(run.id);
  }

  return report;
}

type RunRow = typeof agentRuns.$inferSelect;
type Verdict = 'alive' | 'gone' | 'unknown';

/**
 * 向运行时求证。
 *
 * ★ 探测不到（`statusQuery` 不支持、适配器没注册）与「确实已经没了」
 *   必须分开：前者只是我们瞎了，后者才是结论。不区分的话，
 *   任何一个不支持状态查询的运行时，它的长任务都会被当成孤儿杀掉。
 */
async function probeRun(db: Database, registry: RuntimeRegistry, run: RunRow): Promise<Verdict> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId));
  if (!agent || !registry.has(agent.runtimeId)) {
    /**
     * 适配器不在本进程 —— 对 Claude Code / Codex 这类「会话是本进程子进程」
     * 的运行时，这等价于「已经不在跑了」，因为子进程随进程消亡。
     */
    return 'gone';
  }

  try {
    const status = await registry.get(agent.runtimeId).queryStatus(run.id);
    if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(status.status)) return 'alive';
    return 'gone';
  } catch (err) {
    // 不支持状态查询：按降级矩阵，超时后直接判失败，但要说明是推断的
    if (err instanceof UnsupportedFeatureError) return 'unknown';
    return 'unknown';
  }
}

async function handleTimeout(
  db: Database,
  registry: RuntimeRegistry,
  run: RunRow,
  opts: SuperviseOptions,
) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId));

  // 先叫停外部执行，再落状态 —— 反过来的话成本会在我们判完之后继续涨
  if (agent && registry.has(agent.runtimeId)) {
    try {
      await registry.get(agent.runtimeId).control(run.id, {
        action: 'terminate',
        reason: '超过任务时限，由 run-supervisor 终止',
      });
    } catch {
      // 终止失败不影响判定；terminate 缺失时降级矩阵已标为 critical
    }
  }

  await finishRun(db, run, {
    outcome: 'timeout',
    errorClass: 'timeout',
    message: `执行超过时限（${agent?.timeoutSeconds ?? '?'} 秒），已终止`,
    selfReport:
      '任务在允许的时限内没做完。通常意味着任务粒度过大，或者缺少关键上下文导致反复试错。',
    correlationId: opts.correlationId,
    workspaces: opts.workspaces,
  });
}

/**
 * 收尾：写错误 → 补一条 run_ended 走正常回流。
 *
 * ★ 刻意复用 ingestRunEvent 而不是直接改表：工作区收尾、领域事件提升、
 *   状态流转、恢复决策全都挂在那条链上。绕过它的话，超时的 Run
 *   会少掉这四件事中的每一件，而且是静默地少。
 */
async function finishRun(
  db: Database,
  run: RunRow,
  input: {
    outcome: 'failed' | 'timeout';
    errorClass: string;
    message: string;
    selfReport: string;
    correlationId: string;
    workspaces?: WorkspaceProvisioner;
  },
) {
  const [row] = await db
    .select({ maxSeq: sql<number>`coalesce(max(${runEvents.seq}), -1) + 1` })
    .from(runEvents)
    .where(eq(runEvents.runId, run.id));
  const maxSeq = Number(row?.maxSeq ?? 0);

  const base = { runId: run.id, ts: new Date().toISOString() };

  await ingestRunEvent(
    db,
    {
      runId: run.id,
      event: {
        ...base,
        seq: maxSeq,
        type: 'error',
        error: {
          class: input.errorClass as never,
          message: input.message,
          retriable: true,
          selfReport: input.selfReport,
          // 是我们从「没有信号」推断出来的，不是运行时上报的
          classificationSource: 'inferred',
        },
      } as RunEvent,
      correlationId: input.correlationId,
    },
    { workspaces: input.workspaces },
  );

  await ingestRunEvent(
    db,
    {
      runId: run.id,
      event: {
        ...base,
        seq: maxSeq + 1,
        type: 'run_ended',
        // timeout 在事件层用 failed 表达；agent_runs.status 由下面单独修正
        outcome: 'failed',
        summary: input.message,
        selfReport: input.selfReport,
      } as RunEvent,
      correlationId: input.correlationId,
    },
    { workspaces: input.workspaces },
  );

  if (input.outcome === 'timeout') {
    // ★ ingest 把 outcome=failed 记成 failed；超时要单独标出来，
    //   否则 Analytics 里「超时」这一类永远是 0，而它恰恰是最该被看见的
    await db
      .update(agentRuns)
      .set({ status: 'timeout' })
      .where(and(eq(agentRuns.id, run.id), eq(agentRuns.status, 'failed')));
  }
}

/** 启动时清一次：本进程重启前留下的 Run 一定不在跑了 */
export async function reclaimOnBoot(
  db: Database,
  registry: RuntimeRegistry,
  opts: SuperviseOptions,
): Promise<number> {
  const rows = await db
    .select()
    .from(agentRuns)
    .where(inArray(agentRuns.status, ['dispatching', 'running']));

  let reclaimed = 0;
  for (const run of rows) {
    if ((await probeRun(db, registry, run)) === 'alive') continue;
    await finishRun(db, run, {
      outcome: 'failed',
      errorClass: 'runtime_error',
      message: '服务重启前这次执行未收尾，已判定为中断',
      selfReport:
        '平台在这次执行进行中重启了。Agent 的进程随之结束，改动（如果有）保留在工作分支上。',
      correlationId: opts.correlationId,
      workspaces: opts.workspaces,
    });
    reclaimed++;
  }
  return reclaimed;
}

export { agentRuntimes };
