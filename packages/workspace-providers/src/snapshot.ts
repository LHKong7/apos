import { createHash } from 'node:crypto';
import { mkdir, opendir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { ChangeSet } from '@apos/contracts';
import { stateFile } from './paths';

/**
 * 目录清单快照 —— 没有版本控制时的「baseCommit」。
 *
 * ★★ 这是 SourceRef.baseVersion 在文件系统类后端上的形态，也是
 *   「基线 + 变更集」这个概念能覆盖全部后端的原因。
 *
 *   没有它就只剩「扫描目录里有什么」这一条路 —— 而那对一个仓库检出
 *   意味着几万条产物记录，对一个 npm install 过的目录意味着几十万条，
 *   还会把平台自己写进去的输入文件当成 Agent 的产出。
 *
 * ★ 只记 size + mtimeMs，**不算内容 hash**：一个几百 MB 的产出目录逐文件
 *   sha256 会给每次收尾加上几十秒，而它买到的只是「size 和 mtime 都没变
 *   但内容变了」这种情况下的准确性 —— 而 Agent 改文件必然改 mtime。
 */
export interface Snapshot {
  hash: string;
  /** 相对路径 → 指纹 */
  files: Record<string, string>;
  /** 文件数超过上限时为 true —— 基线本身是不完整的，diff 也就不完整 */
  truncated: boolean;
}

/**
 * 一次快照最多记多少个文件。
 *
 * ★ 超过就停，并把 truncated 一路带到 ChangeSet 上。静默截断是最糟的处置：
 *   一个装了 node_modules 的目录会让快照停在某个随机位置，而收尾时报出的
 *   「没有改动」会被当成「Agent 什么都没做」。
 */
export const MAX_SNAPSHOT_FILES = 20_000;

export interface SnapshotOptions {
  /** 忽略的目录名（node_modules 之类）。默认不忽略任何东西 */
  ignoredDirs?: Iterable<string>;
  maxFiles?: number;
}

/** 扫一个目录，产出清单快照 */
export async function snapshotDir(dir: string, opts: SnapshotOptions = {}): Promise<Snapshot> {
  const files: Record<string, string> = {};
  const ignored = new Set(opts.ignoredDirs ?? []);
  const maxFiles = opts.maxFiles ?? MAX_SNAPSHOT_FILES;
  let count = 0;
  let truncated = false;

  const walk = async (current: string): Promise<void> => {
    if (truncated) return;
    let handle;
    try {
      handle = await opendir(current);
    } catch {
      return;
    }
    for await (const entry of handle) {
      if (truncated) return;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (ignored.has(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        if (++count > maxFiles) {
          truncated = true;
          return;
        }
        try {
          const st = await stat(full);
          files[relative(dir, full)] = `${st.size}:${Math.trunc(st.mtimeMs)}`;
        } catch {
          // 遍历过程中被删掉了 —— 当作不存在
        }
      }
      // 符号链接不跟进：跟进会在指向父目录时无限递归
    }
  };

  await walk(dir);
  return { hash: hashFiles(files), files, truncated };
}

/** 由一份「路径 → 指纹」表直接构造快照。对象存储用 ETag 走这条 */
export function snapshotFromEntries(
  files: Record<string, string>,
  truncated = false,
): Snapshot {
  return { hash: hashFiles(files), files, truncated };
}

/** 两份快照 → 变更集 */
export function compareSnapshots(before: Snapshot, after: Snapshot): ChangeSet {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const [file, stamp] of Object.entries(after.files)) {
    const prev = before.files[file];
    if (prev === undefined) added.push(file);
    else if (prev !== stamp) modified.push(file);
  }
  for (const file of Object.keys(before.files)) {
    if (after.files[file] === undefined) deleted.push(file);
  }

  return {
    added,
    modified,
    deleted,
    total: added.length + modified.length + deleted.length,
    truncated: before.truncated || after.truncated,
  };
}

/**
 * 基线丢了时的回答。
 *
 * ★★ **不能**把目录里所有文件都报成新增 —— 那正是「扫描目录」那条错路，
 *   会把平台自己写进去的输入文件也算成产物。如实报告不完整，
 *   让人知道这次的变更集不可信。
 */
export const UNKNOWN_CHANGES: ChangeSet = {
  added: [],
  modified: [],
  deleted: [],
  total: 0,
  truncated: true,
};

export async function saveSnapshot(root: string, key: string, snapshot: Snapshot): Promise<void> {
  const file = stateFile(root, key);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(snapshot), 'utf8');
}

export async function loadSnapshot(root: string, key: string): Promise<Snapshot | null> {
  try {
    return JSON.parse(await readFile(stateFile(root, key), 'utf8')) as Snapshot;
  } catch {
    return null;
  }
}

export async function dropSnapshot(root: string, key: string): Promise<void> {
  await rm(stateFile(root, key), { force: true }).catch(() => undefined);
}

/**
 * 快照的存放键。一个工作区可能有多个挂载，所以要把路径也拌进去。
 *
 * ★ workspaceId 过一道字符白名单：它会直接进文件名，而带斜杠的 id 会让
 *   写快照时去写一个不存在的子目录 —— 表现是「基线静默丢失」，
 *   而基线丢失的下游表现是「Agent 什么都没产出」。
 */
export function stateKey(workspaceId: string, path: string): string {
  const safe = workspaceId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'ws';
  const suffix = createHash('sha256').update(path).digest('hex').slice(0, 12);
  return `${safe}-${suffix}`;
}

function hashFiles(files: Record<string, string>): string {
  return createHash('sha256')
    .update(
      Object.keys(files)
        .sort()
        .map((k) => `${k}\t${files[k]}`)
        .join('\n'),
    )
    .digest('hex')
    .slice(0, 32);
}
