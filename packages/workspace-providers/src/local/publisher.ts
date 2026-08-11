import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import type { ChangeSet, PublishResult, Workspace } from '@apos/contracts';
import type { Diagnose } from '../ports';
import type { Publisher, ReleaseContext } from '../publisher-types';

export interface LocalPublisherOptions {
  /**
   * 归档根目录。产出按 `{archiveRoot}/{runId}/` 落进去。
   *
   * ★★ 必须与工作区根目录**不同**，而且应该在一个真正持久的卷上。
   *   落在工作区根下面的话，pruneOrphans 会连同工作树一起把它删掉 ——
   *   而那时用户已经在产物页上看到「已归档」了。
   */
  archiveRoot: string;
  onDiagnostic?: Diagnose;
}

/**
 * 本地文件系统交货后端 —— 把变更集复制到一个持久目录。
 *
 * ★ 与 NonePublisher 的区别就是这一条：它**真的**把东西搬到了工作区之外，
 *   所以它可以诚实地报 persisted: true。NonePublisher 不行 ——
 *   工作区目录收尾就回收，标成已发布只会让用户点开产物看到不存在的路径。
 *
 * ★ 只复制变更集里的文件，不整个目录一起搬。一个仓库检出有几万个文件，
 *   Agent 改了 3 个 —— 归档那 3 个就够了，其余的在源头有。
 *   这是保留 ChangeSet 概念的直接回报。
 */
export class LocalPublisher implements Publisher {
  readonly kind = 'local' as const;

  constructor(private readonly options: LocalPublisherOptions) {}

  async publish(ws: Workspace, changes: ChangeSet, ctx: ReleaseContext): Promise<PublishResult> {
    const primary = ws.mounts.find((m) => m.role === 'primary');
    if (!primary) {
      return { kind: 'local', archivePath: '', files: 0, persisted: false, note: '没有主挂载' };
    }

    const dest = resolve(join(this.options.archiveRoot, ctx.runId));

    if (changes.truncated) {
      /**
       * ★ 变更集不完整时**不归档**。照着一份不完整的清单复制，产出的是一个
       *   看起来成功、实际缺文件的归档 —— 而缺了什么没有任何地方说得出来。
       *   宁可什么都不做并说清楚。
       */
      return {
        kind: 'local',
        archivePath: dest,
        files: 0,
        persisted: false,
        note: `变更集不完整（目录过大或基线丢失），未归档；产出仍在 ${primary.path}`,
      };
    }

    if (changes.total === 0) {
      return {
        kind: 'local',
        archivePath: dest,
        files: 0,
        persisted: true,
        note: `${primary.path} 里没有任何改动，无需归档`,
      };
    }

    const files = [...changes.added, ...changes.modified];
    let copied = 0;
    const failures: string[] = [];

    for (const rel of files) {
      // ★ 变更集里的路径来自文件系统扫描，理论上不会越界；但归档目标是
      //   一个持久目录，越界写入的代价是覆盖别的 Run 的产物 —— 值得再挡一道
      if (!isSafeRelative(rel)) {
        failures.push(rel);
        continue;
      }
      const from = join(primary.path, rel);
      const to = join(dest, rel);
      try {
        await mkdir(dirname(to), { recursive: true });
        await copyFile(from, to);
        copied++;
      } catch (err) {
        failures.push(rel);
        this.options.onDiagnostic?.(`归档 ${rel} 失败`, err);
      }
    }

    // 删除的文件在归档里也删掉，这样归档反映的是「收尾时的状态」而不是历次叠加
    for (const rel of changes.deleted) {
      if (!isSafeRelative(rel)) continue;
      await rm(join(dest, rel), { force: true }).catch(() => undefined);
    }

    const persisted = copied > 0 && failures.length === 0;
    const note = failures.length
      ? `归档 ${copied}/${files.length} 个文件到 ${dest}；${failures.length} 个失败：${failures.slice(0, 5).join('、')}`
      : `已归档 ${copied} 个文件到 ${dest}`;

    return { kind: 'local', archivePath: dest, files: copied, persisted, note };
  }

  /** 归档目录可写性在启动时探一次，配错了要立刻说，而不是等第一次收尾 */
  async probe(): Promise<{ ok: boolean; problem: string | null }> {
    const dir = resolve(this.options.archiveRoot);
    try {
      await mkdir(dir, { recursive: true });
      const st = await stat(dir);
      if (!st.isDirectory()) return { ok: false, problem: `${dir} 不是目录` };
      return { ok: true, problem: null };
    } catch (err) {
      return {
        ok: false,
        problem: `归档目录 ${dir} 不可写：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

/** 相对且不越界 */
function isSafeRelative(p: string): boolean {
  if (p === '' || isAbsolute(p)) return false;
  const normalized = normalize(p);
  return !normalized.startsWith('..') && !relative('.', normalized).startsWith('..');
}
