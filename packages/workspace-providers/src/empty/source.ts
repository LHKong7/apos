import { mkdir, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ChangeSet, Mount } from '@apos/contracts';
import {
  compareSnapshots,
  dropSnapshot,
  loadSnapshot,
  saveSnapshot,
  snapshotDir,
  stateKey,
  UNKNOWN_CHANGES,
  MAX_SNAPSHOT_FILES,
} from '../snapshot';
import type { Diagnose } from '../ports';
import type { MountSpec, SourceMaterializer } from '../types';

/**
 * 空目录铺料后端。
 *
 * ★ 适用于「不需要版本控制、产出就是目录里的文件」的执行 —— 规划、
 *   调研、纯文档产出。此前这类任务只能借用 Git 工作区的形状，用
 *   repoRef:'planning' / branch:'planning' 这种占位符硬塞进去。
 *
 * ★ 它照样有基线：acquire 时记一份文件清单快照，release 时对比出增删改。
 *   这是「基线 + 变更集」这个概念在没有 VCS 的场景下的形态 —— 也是
 *   为什么抽象里必须有 baseVersion 而不能退化成「扫描目录里有什么」。
 */
export class EmptyMaterializer implements SourceMaterializer {
  readonly kind = 'empty' as const;

  constructor(
    private readonly options: {
      root: string;
      /** 额外忽略的目录名（node_modules 之类）。默认不忽略任何东西 */
      ignoredDirs?: string[];
      onDiagnostic?: Diagnose;
    },
  ) {}

  async materialize(spec: MountSpec): Promise<Mount> {
    await mkdir(spec.path, { recursive: true });

    // ★ 平台自己的输入文件要在记基线**之前**放好，否则会被算成 Agent 的产出
    await spec.seed?.(spec.path);

    const key = stateKey(spec.workspaceId ?? spec.path, spec.path);
    const snapshot = await snapshotDir(spec.path, { ignoredDirs: this.options.ignoredDirs ?? [] });
    await saveSnapshot(this.options.root, key, snapshot);

    if (snapshot.truncated) {
      this.options.onDiagnostic?.(
        `工作区 ${spec.path} 的文件数超过 ${MAX_SNAPSHOT_FILES}，基线不完整`,
      );
    }

    return {
      path: spec.path,
      role: spec.role,
      writable: spec.writable,
      source: {
        kind: 'empty',
        // ★ 寻址键 = 快照的存放键，diff 时靠它找回基线
        identifier: key,
        label: basename(spec.path),
        baseVersion: snapshot.hash,
      },
    };
  }

  async diff(mount: Mount): Promise<ChangeSet> {
    const before = await loadSnapshot(this.options.root, mount.source.identifier);
    if (!before) {
      this.options.onDiagnostic?.(`工作区 ${mount.path} 的基线快照丢失，变更集不可用`);
      return UNKNOWN_CHANGES;
    }
    const after = await snapshotDir(mount.path, { ignoredDirs: this.options.ignoredDirs ?? [] });
    return compareSnapshots(before, after);
  }

  async dispose(mount: Mount, opts: { keep?: boolean } = {}): Promise<void> {
    // 基线快照的使命到此为止，无论目录留不留都该清掉
    await dropSnapshot(this.options.root, mount.source.identifier);
    if (!opts.keep) {
      await rm(mount.path, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
