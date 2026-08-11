import { randomUUID } from 'node:crypto';
import { agentRuns, type Database } from '@apos/db';
import { inArray } from 'drizzle-orm';
import type { RuntimeRegistry } from '@apos/agent-runtimes';
import { reclaimOnBoot, superviseRuns } from '../modules/agent/supervisor';
import { runRecoveryRound } from '../modules/agent/recovery';
import { refreshAgentStats } from '../modules/agent/stats';
import { reviewRound } from '../modules/flow/review';
import type { WorkspaceService } from '../modules/workspace';

export interface LoopHandle {
  stop: () => void;
  trigger: () => Promise<void>;
}

/**
 * 定时循环的公共骨架。
 *
 * ★ 单轮之间不重叠：上一轮没跑完就跳过本次 tick。
 *   没有这条保护，一次慢查询会让 tick 堆积成雪崩，
 *   而症状是「系统突然开始重复派发」——极难归因到定时器上。
 */
function loop(name: string, intervalMs: number, body: () => Promise<void>, onError?: (e: unknown) => void): LoopHandle {
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await body();
    } catch (err) {
      onError?.(err instanceof Error ? new Error(`[${name}] ${err.message}`) : err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    trigger: tick,
  };
}

export interface FlowLoopsOptions {
  registry: RuntimeRegistry;
  workspaces?: WorkspaceService;
  superviseIntervalMs?: number;
  recoveryIntervalMs?: number;
  reviewIntervalMs?: number;
  statsIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  onError?: (err: unknown) => void;
  onReport?: (name: string, detail: unknown) => void;
}

/**
 * 让一条任务链能自己跑完所需要的四个循环。
 *
 * | 循环 | 周期 | 管什么 |
 * | --- | --- | --- |
 * | run-supervisor | 10s | 超时、心跳丢失、孤儿 Run |
 * | recovery | 15s | 执行 decideRecovery 判定的动作 |
 * | review | 20s | reviewing → done 的自动推进 |
 * | stats | 5min | 实测效能回写，喂给调度匹配 |
 */
export function startFlowLoops(db: Database, opts: FlowLoopsOptions): LoopHandle[] {
  const { registry, workspaces, onError, onReport } = opts;

  /**
   * ★ 启动时先认领一次孤儿。
   *
   *   本进程重启前留下的 running Run 一定已经不在跑了（会话是子进程），
   *   不认领的话它们会永远占着「一个 Work Item 只能有一个活跃 Run」的名额，
   *   把那些卡片钉死 —— 而看板上它们显示为「执行中」。
   */
  void reclaimOnBoot(db, registry, { correlationId: randomUUID(), workspaces })
    .then((n) => n > 0 && onReport?.('reclaim', { reclaimed: n }))
    .catch((e) => onError?.(e));

  // 顺带清掉没人认领的工作树目录，否则磁盘会被上一次崩溃的残留慢慢吃光
  if (workspaces) {
    void db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(inArray(agentRuns.status, ['queued', 'dispatching', 'running', 'paused']))
      .then((rows) => workspaces.pruneOrphans(rows.map((r) => r.id)))
      .then((n) => n > 0 && onReport?.('workspace-prune', { removed: n }))
      .catch((e) => onError?.(e));
  }

  const handles: LoopHandle[] = [
    loop(
      'run-supervisor',
      opts.superviseIntervalMs ?? 10_000,
      async () => {
        const report = await superviseRuns(db, registry, {
          correlationId: randomUUID(),
          workspaces,
          heartbeatTimeoutMs: opts.heartbeatTimeoutMs,
        });
        if (report.timedOut.length || report.orphanedResolved.length) {
          onReport?.('run-supervisor', report);
        }
      },
      onError,
    ),

    loop(
      'recovery',
      opts.recoveryIntervalMs ?? 15_000,
      async () => {
        const outcomes = await runRecoveryRound(db, registry, {
          correlationId: randomUUID(),
          workspaces,
        });
        if (outcomes.length > 0) onReport?.('recovery', outcomes);
      },
      onError,
    ),

    loop(
      'review',
      opts.reviewIntervalMs ?? 20_000,
      async () => {
        const outcomes = await reviewRound(db, { correlationId: randomUUID() });
        const acted = outcomes.filter((o) => o.action !== 'skipped');
        if (acted.length > 0) onReport?.('review', acted);
      },
      onError,
    ),

    loop(
      'agent-stats',
      opts.statsIntervalMs ?? 300_000,
      async () => {
        const report = await refreshAgentStats(db);
        if (report.agentsUpdated > 0) onReport?.('agent-stats', report);
      },
      onError,
    ),
  ];

  return handles;
}
