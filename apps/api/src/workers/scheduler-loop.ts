import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { projects, type Database } from '@apos/db';
import type { RuntimeRegistry } from '@apos/agent-runtimes';
import { scheduleRound } from '../modules/flow/scheduler';
import type { WorkspaceProvisioner } from '../modules/workspace/provisioner';

export interface SchedulerLoopOptions {
  intervalMs?: number;
  onError?: (err: unknown) => void;
  onRound?: (report: { projectId: string; dispatched: number }) => void;
  /** 工作区供给；不传则 Run 不会拿到代码目录 */
  workspaces?: WorkspaceProvisioner;
}

export interface SchedulerLoopHandle {
  stop: () => void;
  /** 立即触发一轮，不等定时器 */
  trigger: () => Promise<void>;
}

/**
 * 调度循环 —— 让「Agent 推进」持续发生而不是等用户操作触发。
 *
 * 单轮之间不重叠：上一轮没跑完就跳过本次 tick，避免慢查询堆积成雪崩。
 */
export function startSchedulerLoop(
  db: Database,
  registry: RuntimeRegistry,
  opts: SchedulerLoopOptions = {},
): SchedulerLoopHandle {
  const interval = opts.intervalMs ?? 5000;
  let running = false;
  let stopped = false;

  const runOnce = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const active = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.status, 'active'));

      for (const project of active) {
        const report = await scheduleRound(db, registry, {
          projectId: project.id,
          correlationId: randomUUID(),
          workspaces: opts.workspaces,
        });
        const dispatched = report.outcomes.filter((o) => o.action === 'dispatched').length;
        if (dispatched > 0) opts.onRound?.({ projectId: project.id, dispatched });
      }
    } catch (err) {
      opts.onError?.(err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(runOnce, interval);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    trigger: runOnce,
  };
}
