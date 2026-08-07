import type {
  IntegrationProvider,
  IntegrationScopes,
  SyncField,
} from '@apos/contracts';

/**
 * 外部系统适配器（页面文档 14）。
 *
 * ★ 接口按「同步引擎需要什么」定义，不按各家 API 长什么样定义。
 *   GitHub 的 PR、Jira 的 Issue、Plane 的 Work Item 在字段层面
 *   差得很远，但同步引擎只关心六个字段（见 SyncField）——
 *   把差异吃在适配器里，SoT 判定才可能只有一份实现。
 *
 * ★ 刻意不提供 `delete`。外部对象的删除由对方系统负责，
 *   我们只在拉取时发现「它不见了」并打标（页面文档 14 §11：
 *   「本地 Work Item 标注外部对象已删除，不自动删除本地数据」）。
 *   一个能删外部对象的集成，出错时的代价是不可逆的。
 */
export interface IntegrationAdapter {
  readonly provider: IntegrationProvider;

  /** 连接测试。返回可读原因，页面直接展示 */
  testConnection(config: ConnectionConfig): Promise<TestResult>;

  /** 这次连接实际拿到的权限。allowed 与 denied 都要给 */
  grantedScopes(config: ConnectionConfig): Promise<IntegrationScopes>;

  /** 拉取外部对象的当前值 */
  fetchObject(config: ConnectionConfig, externalKey: string): Promise<ExternalObject | null>;

  /** 列出可同步的外部对象（导入前预览用） */
  listObjects(config: ConnectionConfig, limit: number): Promise<ExternalObject[]>;

  /**
   * 回写一个字段。
   *
   * ★ originTag 必须原样带到外部系统（评论签名、PR body 标记、自定义字段），
   *   否则下次拉取时我们分不出这条变更是不是自己写的 ——
   *   分不出就会当成外部修改再处理一遍，循环从这里开始。
   */
  writeField(
    config: ConnectionConfig,
    externalKey: string,
    field: SyncField,
    value: unknown,
    originTag: string,
  ): Promise<void>;
}

export interface ConnectionConfig {
  /** 外部侧定位信息（repo、projectKey、群 id 等），不含凭证 */
  config: Record<string, unknown>;
  /** 指向密钥管理的引用，适配器自己去取。明文不经过这一层 */
  credentialRef: string | null;
}

export interface TestResult {
  ok: boolean;
  /** 失败时给人能看懂的原因：token 过期 / 权限不足 / 服务不可达 */
  message: string;
  /** 探测到的连接对象名，用于页面展示 */
  displayName?: string;
  latencyMs?: number;
}

export interface ExternalObject {
  externalKey: string;
  url: string | null;
  /** 六个同步字段的当前值，缺的给 undefined */
  fields: Partial<Record<SyncField, unknown>>;
  /** 最近一次变更的来源标记与作者 */
  lastChange: { originTag: string | null; by: string; at: string } | null;
  /** 外部已删除 */
  deleted?: boolean;
}

export class IntegrationRegistry {
  private adapters = new Map<IntegrationProvider, IntegrationAdapter>();

  register(adapter: IntegrationAdapter) {
    this.adapters.set(adapter.provider, adapter);
  }

  get(provider: IntegrationProvider): IntegrationAdapter {
    const a = this.adapters.get(provider);
    if (!a) throw new Error(`未注册的集成适配器: ${provider}`);
    return a;
  }

  has(provider: IntegrationProvider): boolean {
    return this.adapters.has(provider);
  }

  list(): IntegrationProvider[] {
    return [...this.adapters.keys()];
  }
}

/**
 * 我们自己的写入标记。
 *
 * ★ 带上 projectId 而不是只写一个常量：同一个 Jira 项目可能被
 *   两个 APOS 项目分别连着，只写「apos」的话，A 项目会把 B 项目
 *   写下的变更当成自己的回声丢掉 —— 那是数据静默丢失，最难查的一类。
 */
export function originTagFor(projectId: string): string {
  return `apos:${projectId}`;
}
