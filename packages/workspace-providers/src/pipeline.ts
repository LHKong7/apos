import {
  EMPTY_CHANGE_SET,
  isPersisted,
  NO_CHECK,
  type ChangeSet,
  type PublishResult,
  type SourceKind,
  type Workspace,
  type WorkspaceCheckResult,
} from '@apos/contracts';
import { runCheck } from './check';
import type { SourceMaterializer } from './types';
import type { Publisher, ReleaseContext } from './publisher-types';

export interface PipelineDeps {
  sources: Map<SourceKind, SourceMaterializer>;
  publishers: Map<string, Publisher>;
  onDiagnostic?: (message: string, detail?: unknown) => void;
}

export interface ReleaseOptions {
  publisher: string;
  /** 来自仓库登记；null 表示这个资源没有配核验命令 */
  checkCommand: string | null;
  checkTimeoutSeconds: number;
  /** 保留目录内容（规划任务留着供人事后复查） */
  keepMounts?: boolean;
}

export interface ReleaseOutcome {
  changes: ChangeSet;
  check: WorkspaceCheckResult;
  published: PublishResult;
  notes: string[];
}

/**
 * 收尾流水线 —— **后端无关**。
 *
 * ★★ 这个函数是整套抽象的收益兑现处。
 *
 *   顺序对所有后端都一样：算变更集 → 跑核验 → 交货 → 回收 → 收尾。
 *   把它实现一次而不是让每个 Provider 各写一遍，换来的是：
 *
 *   - 质量核验只有一份实现。核验失败与核验没跑在结果里长得很像，
 *     抄第二遍抄错了不会有人发现，而它撑的是 reviewing 阶段唯一一处
 *     **非自述**的测试证据（见 agent/ingest.ts 的 qualityGate 那段）。
 *   - 「核验跑在提交之前」这条时序约束只需要保证一次。
 *   - 加一个后端 = 实现 materialize/diff/dispose 三个方法，
 *     而不是把这段顺序连同它的每一个坑重新想一遍。
 */
export async function runReleasePipeline(
  deps: PipelineDeps,
  ws: Workspace,
  ctx: ReleaseContext,
  opts: ReleaseOptions,
): Promise<ReleaseOutcome> {
  const notes: string[] = [];
  const primary = ws.mounts.find((m) => m.role === 'primary');
  const source = primary ? deps.sources.get(primary.source.kind) : undefined;
  const publisher = deps.publishers.get(opts.publisher);

  let changes: ChangeSet = EMPTY_CHANGE_SET;
  let check: WorkspaceCheckResult = NO_CHECK;
  let published: PublishResult = {
    kind: 'none',
    persisted: false,
    note: '没有可用的交货后端',
  };

  try {
    if (primary && source) changes = await source.diff(primary);

    /**
     * ★ 核验在交货**之前**跑，而且不管成败都交货。
     *
     *   跑在交货前，是因为要测的是 Agent 留下的目录状态；
     *   失败也交货，是因为失败的改动同样需要被人看到 ——
     *   「测试没过所以我把代码扔了」是最糟的处置。
     */
    if (primary && opts.checkCommand && changes.total > 0) {
      check = await runCheck(primary.path, opts.checkCommand, opts.checkTimeoutSeconds);
      notes.push(
        check.passed ? `质量核验通过（${opts.checkCommand}）` : `质量核验未通过（${opts.checkCommand}）`,
      );
    }

    if (publisher) {
      published = await publisher.publish(ws, changes, ctx);
      if (published.note) notes.push(published.note);
    }
  } catch (err) {
    notes.push(`收尾出错：${errText(err)}`);
    deps.onDiagnostic?.('工作区收尾出错', err);
  }

  /**
   * 回收挂载，否则磁盘会被慢慢吃光。
   *
   * ★ 逐个回收，不只回收主挂载 —— 参考仓库的工作树挂在**它自己的**镜像上，
   *   用主仓库的镜像目录去 remove 是找不到的。
   *
   * ★★ 但「有改动却没能交货」时**保留**目录。
   *
   *   publish 已经在 dispose 之前跑过了，所以顺序本身是对的。真正会丢东西的
   *   是另一种情况：publish 报了 persisted:false（变更集不完整、部分上传失败、
   *   或者上面那个 catch 吞掉了一个异常），而这里照样把目录删了 ——
   *   于是 Agent 干的活既没上传、本地也没了，只在 note 里留下一句话。
   *
   *   这种时候磁盘该让位于数据：留着目录，让人能去捞。调用方可以用
   *   keepMounts 显式覆盖这个判断。
   */
  const lostIfDisposed = !isPersisted(published) && changes.total > 0;
  if (lostIfDisposed && opts.keepMounts === undefined) {
    notes.push('产出未能交货，工作区目录已保留以便人工取回');
    deps.onDiagnostic?.('产出未能交货，保留工作区目录', { runId: ctx.runId, note: published.note });
  }
  const keep = opts.keepMounts ?? lostIfDisposed;

  for (const mount of ws.mounts) {
    const m = deps.sources.get(mount.source.kind);
    if (!m) continue;
    await m.dispose(mount, { keep }).catch((err) => {
      deps.onDiagnostic?.(`挂载 ${mount.path} 回收失败`, err);
    });
  }

  // ★ 必须在 dispose 之后：Git 那边要删的分支在工作树还在时删不掉
  if (publisher?.finalize) {
    await publisher.finalize(ws, published).catch((err) => {
      deps.onDiagnostic?.('交货收尾失败', err);
    });
  }

  return { changes, check, published, notes };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
