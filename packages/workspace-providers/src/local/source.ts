import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
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

export class LocalMountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalMountError';
  }
}

/**
 * 本地文件系统铺料后端 —— 从宿主机上一个**已登记**的目录取内容。
 *
 * ★ 与 empty 后端的区别只有一条：empty 建一个空目录，local 从一份已有的
 *   内容开始。数据集、素材库、外部工具产出的目录都是这一类 ——
 *   它们不在 git 里，但 Agent 需要读，有时还需要在它们的基础上改。
 *
 * ★★ **复制而不是直接把 Agent 放进源目录里干活。**
 *
 *   直接用源目录的话，两个并发 Run 会在同一份内容上互相覆盖 ——
 *   这正是整个工作区模块存在的理由（见 workspace.test.ts 里那条
 *   「并发的两个 Run 拿到互不相干的目录」）。而且失败的 Run 会把
 *   源目录改坏，没有任何东西能把它还原。
 *
 *   代价是大目录复制要时间。可以配 `link: true` 走硬链接（同一文件系统上
 *   接近零成本），但那样 Agent 改文件就会改到源文件 —— 所以硬链接只允许
 *   用在只读挂载上，可写挂载强制真复制。
 */
export class LocalMaterializer implements SourceMaterializer {
  readonly kind = 'local' as const;

  constructor(
    private readonly options: {
      root: string;
      /**
       * 允许挂载的宿主目录白名单（绝对路径）。
       *
       * ★★ 不配的话任何被登记的路径都能挂 —— 而「登记」是管理员在界面上
       *   做的事，一个填成 `/` 的登记等于把整台机器交给 Agent。
       *   白名单是部署方的最后一道闸，它在环境里而不在库里。
       */
      allowedRoots?: string[];
      ignoredDirs?: string[];
      onDiagnostic?: Diagnose;
    },
  ) {}

  async materialize(spec: MountSpec): Promise<Mount> {
    const dir = spec.dir;
    if (!dir) throw new LocalMountError('local 挂载缺少目录信息');

    const source = resolve(dir.rootPath);
    this.assertAllowed(source);

    const st = await stat(source).catch(() => null);
    if (!st?.isDirectory()) {
      throw new LocalMountError(`登记的本地目录不存在或不是目录：${source}`);
    }

    await mkdir(spec.path, { recursive: true });
    /**
     * ★ dereference: false —— 不跟进符号链接。跟进的话一条指向 /etc 的
     *   链接就会把宿主机的配置复制进 Agent 的工作区，而白名单挡不住它
     *   （挡的是挂载点，不是挂载点里面的链接目标）。
     */
    await cp(source, spec.path, {
      recursive: true,
      dereference: false,
      force: true,
      errorOnExist: false,
    });

    const key = stateKey(spec.workspaceId ?? spec.path, spec.path);
    const snapshot = await snapshotDir(spec.path, { ignoredDirs: this.options.ignoredDirs ?? [] });
    await saveSnapshot(this.options.root, key, snapshot);

    if (snapshot.truncated) {
      this.options.onDiagnostic?.(
        `本地目录 ${source} 的文件数超过 ${MAX_SNAPSHOT_FILES}，基线不完整`,
      );
    }

    return {
      path: spec.path,
      role: spec.role,
      writable: spec.writable,
      source: {
        kind: 'local',
        // 寻址键 = 快照存放键；源目录记在 label 里供人辨认
        identifier: key,
        label: dir.ref,
        baseVersion: snapshot.hash,
      },
    };
  }

  async diff(mount: Mount): Promise<ChangeSet> {
    const before = await loadSnapshot(this.options.root, mount.source.identifier);
    if (!before) {
      this.options.onDiagnostic?.(`挂载 ${mount.path} 的基线快照丢失，变更集不可用`);
      return UNKNOWN_CHANGES;
    }
    const after = await snapshotDir(mount.path, { ignoredDirs: this.options.ignoredDirs ?? [] });
    return compareSnapshots(before, after);
  }

  async dispose(mount: Mount, opts: { keep?: boolean } = {}): Promise<void> {
    await dropSnapshot(this.options.root, mount.source.identifier);
    if (!opts.keep) {
      await rm(mount.path, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private assertAllowed(source: string): void {
    const roots = this.options.allowedRoots;
    if (isMountRootAllowed(source, roots)) return;
    throw new LocalMountError(
      `本地目录 ${source} 不在允许挂载的范围内（APOS_LOCAL_MOUNT_ROOTS=${(roots ?? []).join(sep === '/' ? ':' : ';')}）`,
    );
  }
}

/**
 * 白名单校验。
 *
 * ★ 比的是**解析后**的绝对路径，且要求边界对齐 —— 否则
 *   `/data/public` 这条白名单会连 `/data/public-secrets` 一起放行。
 *
 * ★ 空 / 不传 = 没配 = 不限制。与宿主注入侧保持一致，
 *   免得「配了个空值」变成「全部拒绝挂载」。
 *
 * ★★ 导出它是为了让配置页的探测复用**同一套判据**。抄第二遍的代价是
 *   界面上说「可以挂」而派发时报「不在允许范围内」—— 而管理员看着那条
 *   绿色的探测结果，根本不会想到去查环境变量。
 */
export function isMountRootAllowed(source: string, roots: readonly string[] | undefined): boolean {
  if (!roots || roots.length === 0) return true;
  const target = resolve(source);
  return roots.some((raw) => {
    const allowed = resolve(raw);
    if (target === allowed) return true;
    const rel = relative(allowed, target);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  });
}
