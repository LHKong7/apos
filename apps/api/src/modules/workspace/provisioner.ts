/**
 * 兼容层。
 *
 * ★ 保留这个文件名，是为了让「拆分 provisioner」这次重构的 diff 里
 *   只有拆分本身 —— 四处 import（dispatch / ingest / recovery / main）
 *   连同它们的 review 一起挪到下一步，那时 diff 才有意义。
 *
 * ★ 消费方全部改完之后删掉本文件，直接从 './index' 引。
 *
 * @deprecated 用 `./index` 的 WorkspaceService
 */
export {
  WorkspaceService as WorkspaceProvisioner,
  buildBranchName,
  normalizeMounts,
  type AcquireInput,
  type AcquireResult,
  type ReleaseInput,
  type ReleaseResult,
  type WorkspaceMount,
} from './index';
