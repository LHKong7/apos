/**
 * 工作区后端。
 *
 * ★★ 「工作区」= 一个本地目录 + 可换的两头，而不是「可替换的存储后端」。
 *   平台派出去的是 headless CLI Agent，它们无一例外要 `cd` 进一个目录再
 *   `open()` 文件 —— 本地 POSIX 目录这一点没有可替换性。可换的是：
 *
 *     铺料 SourceMaterializer：目录里的初始内容从哪来
 *     交货 Publisher：        目录里的变化送到哪去
 *
 *   两者独立可选，所以「从 Git 拉代码、把报告传对象存储」这种组合成立。
 *
 * ★ 这个包对宿主应用的全部要求写在 ports.ts 里：解一条凭证引用、
 *   回查远端描述、存一次 SSH 主机公钥。不认识数据库，也不认识 drizzle。
 */

export * from './ports';
export * from './types';
export * from './publisher-types';
export * from './paths';
export * from './snapshot';
export { runCheck } from './check';
export { runReleasePipeline } from './pipeline';
export type { PipelineDeps, ReleaseOptions, ReleaseOutcome } from './pipeline';

// git
export { git, GitError, probeGit, resolveAuthUsername, hostOf, isHttpRemote, DEFAULT_AUTH_USERNAME } from './git/cli';
export type { GitAuth, ResolvedAuthUsername } from './git/cli';
export { withRemoteAuth, authKindOf, SshError } from './git/auth';
export { inspectKnownHosts, inspectPrivateKey, probeSsh, sshCommand, withSshAgent } from './git/ssh';
export { GitMaterializer } from './git/source';
export type { GitMaterializerDeps } from './git/source';
export { GitPublisher, branchUrl } from './git/publisher';

// 空目录
export { EmptyMaterializer } from './empty/source';
export { NonePublisher } from './empty/none-publisher';

// 本地文件系统
export { LocalMaterializer, LocalMountError, isMountRootAllowed } from './local/source';
export { LocalPublisher } from './local/publisher';
export type { LocalPublisherOptions } from './local/publisher';

// 对象存储（S3 兼容）
export { S3Client, S3Error } from './object-storage/s3';
export type { S3ClientOptions, S3Object } from './object-storage/s3';
export {
  ObjectStorageMaterializer,
  ObjectStoreConfigError,
  normalizePrefix,
  relativeKey,
} from './object-storage/source';
export type { ObjectStorageDeps } from './object-storage/source';
export { ObjectStoragePublisher } from './object-storage/publisher';
export type { PublishMode } from './object-storage/publisher';
export { signRequest, encodeKey, uriEncode } from './object-storage/sigv4';
export type { SigV4Credentials } from './object-storage/sigv4';
