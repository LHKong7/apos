/**
 * 注入口 —— 这个包对宿主应用的**全部**要求。
 *
 * ★★ 为什么要有这一层，而不是直接 import `@apos/db`。
 *
 *   搬出 apps/api 之前，凭证解析这条路是
 *   `withRepoAuth(db, repoRow, fn)` —— 直接吃一个 drizzle 的
 *   `Database` 和一行 `repositories`。这意味着这个包要跑起来，
 *   就得先有一个 Postgres、一套业务表、以及那套表里恰好有这一行。
 *
 *   而这个包真正需要的只有三件事：把一个 `secret://…` 引用换成明文、
 *   拿到几个描述远端的字段、以及在 TOFU 学到主机公钥后能把它存回去。
 *   把这三件事写成接口之后，包就能被单独测（喂一个内存实现即可），
 *   也不再假设宿主一定用 Postgres。
 *
 * ★ 这是「等真出现第二个消费方再抽」那笔债的偿还。第二个消费方
 *   就是这些新后端：对象存储与本地目录同样要解凭证，而它们和
 *   `repositories` 表毫无关系 —— 继续走老路的话，
 *   一个 S3 bucket 得先伪装成一个 git 仓库才能拿到自己的 access key。
 */

/** `secret://env/X` 或 `secret://enc/…` → 明文。取不到返回 null */
export interface SecretResolver {
  resolve(ref: string | null): string | null;
}

/** git 远端的描述。刻意是纯数据，不是 ORM 行 */
export interface GitRemoteDescriptor {
  /** 稳定寻址键：镜像目录按它命名，改名不该让本地对象库作废 */
  id: string;
  /** 给人看的名字 */
  ref: string;
  remoteUrl: string;
  defaultBranch: string;
  credentialRef: string | null;
  /** HTTPS Basic 的用户名占位；为空按域名推断 */
  authUsername: string | null;
  /** 已固定的主机公钥（known_hosts 格式）；为空表示还没 TOFU 过 */
  sshKnownHosts: string | null;
}

/**
 * 按寻址键回查远端描述。
 *
 * ★ 交货阶段需要它：挂载点上只留了 identifier（见 Mount.source），
 *   而推送要用 remoteUrl 与凭证。让宿主回查，而不是把整行描述
 *   连同凭证引用一起塞进落库的工作区状态里 —— 那等于把凭证引用
 *   复制一份到 agent_runs 表。
 */
export interface RemoteResolver {
  byId(id: string): Promise<GitRemoteDescriptor | null>;
}

/**
 * 首次 SSH 连接学到的主机公钥往哪存。
 *
 * ★ 不存的话 TOFU 不成立：每次都是全新的临时 known_hosts，
 *   「未知主机」这个条件永远成立，`accept-new` 于是每次都放行 ——
 *   中间人换掉主机公钥也照连不误。
 */
export interface HostKeyStore {
  pin(remoteId: string, knownHosts: string): Promise<void>;
}

/** 对象存储端点的描述 */
export interface ObjectStoreDescriptor {
  id: string;
  ref: string;
  endpoint: string;
  region: string;
  bucket: string;
  /** 所有对象都在这个前缀下；空串表示整个 bucket */
  prefix: string;
  /**
   * 走 path-style（`https://host/bucket/key`）还是 virtual-host-style
   * （`https://bucket.host/key`）。
   *
   * ★ 默认 path-style：MinIO、Ceph、自建网关基本只支持它，而 AWS 两种都支持。
   *   反过来默认的话，自建端点会以为域名不存在 —— 表现是 DNS 解析失败，
   *   完全不指向「寻址风格」这件事。
   */
  forcePathStyle: boolean;
  /** `accessKeyId:secretAccessKey`，走 SecretResolver */
  credentialRef: string | null;
}

/** 本地目录端点的描述 */
export interface LocalDirDescriptor {
  id: string;
  ref: string;
  /** 宿主机上的绝对路径 */
  rootPath: string;
}

/** 诊断输出。包里不 console.log —— 宿主决定日志去哪 */
export type Diagnose = (message: string, detail?: unknown) => void;

export interface ProviderContext {
  /** 所有工作区的根目录 */
  root: string;
  secrets: SecretResolver;
  onDiagnostic?: Diagnose;
}
