import type { ChangeSet, Mount, SourceKind } from '@apos/contracts';
import type { GitRemoteDescriptor, LocalDirDescriptor, ObjectStoreDescriptor } from './ports';

/**
 * 一次挂载的请求。
 *
 * ★ 后端特有的参数（git 的 repo/branch）放在各自的字段上而不是塞进一个
 *   `options: Record<string, unknown>` —— 后者会让「这个后端到底需要什么」
 *   变成只能读实现才知道的事。
 */
export interface MountSpec {
  role: 'primary' | 'reference';
  writable: boolean;
  /** 目标绝对路径 */
  path: string;
  /** git 后端：从哪个远端挂 */
  remote?: GitRemoteDescriptor;
  /** object_storage 后端：从哪个 bucket/prefix 挂 */
  store?: ObjectStoreDescriptor;
  /** local 后端：从宿主机哪个目录挂 */
  dir?: LocalDirDescriptor;
  /** git 后端：可写挂载要开的分支；不给则挂 detached */
  branch?: string;
  /** empty 后端：基线快照按它命名 */
  workspaceId?: string;

  /**
   * 铺料完成、**记录基线之前**执行的回调，用来放平台自己的输入文件。
   *
   * ★★ 时序是关键：平台写进去的东西（任务书 BRIEF.md 之类）必须算进基线，
   *   否则它们会出现在变更集的 added 里 —— 平台自己写的文件被当成
   *   「Agent 的产出」记进产物，而真正的产出反倒淹没在里面。
   *   Git 那边天然没有这个问题（基线就是 baseCommit），空目录后端必须
   *   显式地把这个时序表达出来。
   */
  seed?: (path: string) => Promise<void>;
}

/**
 * 铺料后端 —— 「目录里的初始内容从哪来，以及怎么算出后来变了什么」。
 *
 * ★★ 注意 diff 属于**铺料方**而不是交货方。
 *
 *   只有铺料方知道基线是什么：git 知道 baseCommit，空目录后端知道自己
 *   存过的文件清单快照，对象存储知道 ETag 清单。交货方拿到的是算好的
 *   变更集，它只负责送出去。这个分工让「从 Git 拉代码、把产物传对象存储」
 *   这种组合成立 —— 而把 diff 放进交货方就只能是 1:1 绑定。
 */
export interface SourceMaterializer {
  readonly kind: SourceKind;

  /** 铺料，返回挂载点（含基线） */
  materialize(spec: MountSpec): Promise<Mount>;

  /** 相对基线算变更集 */
  diff(mount: Mount): Promise<ChangeSet>;

  /**
   * 回收挂载。
   * @param keep 保留目录内容（规划任务要留着供人事后复查），但仍要解除后端登记
   */
  dispose(mount: Mount, opts?: { keep?: boolean }): Promise<void>;
}
