import type { IntegrationProvider, IntegrationScopes, SyncField } from '@apos/contracts';
import { NEVER_GRANTED_SCOPES } from '@apos/contracts';
import type {
  ConnectionConfig,
  ExternalObject,
  IntegrationAdapter,
  TestResult,
} from './adapter';

/**
 * 进程内适配器。
 *
 * ★ 它不是「占位实现」，是同步引擎的可测执行体：
 *   拉取、回写、来源标记、外部删除、限流报错都真的发生，
 *   只是对面不是 github.com 而是一个 Map。SoT 判定、冲突生成、
 *   循环抑制这几件真正难的事，因此可以被端到端跑通并写进冒烟。
 *
 * ★ 真实 provider 的 HTTP 传输层没有实现 —— 那需要 OAuth 凭证与
 *   一个能连出去的网络，两样都拿不到。与其写一个从未跑通过、
 *   在第一次真实调用时才发现签名写错的 GitHub 客户端，
 *   不如把接口定清楚、把它下游的一切验证到位，
 *   并在页面上如实标明「这个 provider 还没有传输层」。
 */
/**
 * 「外部系统」的存放处。
 *
 * ★ 默认是进程内的 Map（测试用）。开发环境注入一个持久化实现，
 *   是因为种子脚本和 API 是两个进程 —— 假外部系统只活在种子进程里的话，
 *   页面上点「立即同步」什么也不会发生，而那正是最该被看见能工作的一步。
 *   一个演示不了自己主流程的演示环境，等于没有。
 */
export interface ExternalStore {
  get(provider: string, key: string): Promise<ExternalObject | undefined>;
  list(provider: string, limit: number): Promise<ExternalObject[]>;
  put(provider: string, obj: ExternalObject): Promise<void>;
}

class MapStore implements ExternalStore {
  private m = new Map<string, ExternalObject>();
  async get(provider: string, key: string) {
    return this.m.get(`${provider}:${key}`);
  }
  async list(provider: string, limit: number) {
    return [...this.m.entries()]
      .filter(([k]) => k.startsWith(`${provider}:`))
      .slice(0, limit)
      .map(([, v]) => v);
  }
  async put(provider: string, obj: ExternalObject) {
    this.m.set(`${provider}:${obj.externalKey}`, obj);
  }
}

export class MemoryIntegrationAdapter implements IntegrationAdapter {
  private store: ExternalStore;
  /** 模拟外部限流 / 不可达 */
  private failure: string | null = null;

  constructor(
    readonly provider: IntegrationProvider,
    store: ExternalStore = new MapStore(),
  ) {
    this.store = store;
  }

  // ── 测试与演示用的操纵接口 ────────────────────────────────────────

  /** 播种一个外部对象 */
  async seed(obj: ExternalObject) {
    await this.store.put(this.provider, obj);
  }

  /**
   * 模拟「外部系统里有人手改了一个字段」——
   * 冲突这条路径只有靠它才能在测试和演示里真的走一遍。
   */
  async externalEdit(
    externalKey: string,
    field: SyncField,
    value: unknown,
    by: string,
    at: string,
  ) {
    const obj = await this.store.get(this.provider, externalKey);
    if (!obj) throw new Error(`外部对象不存在: ${externalKey}`);
    await this.store.put(this.provider, {
      ...obj,
      fields: { ...obj.fields, [field]: value },
      // 人手改的没有我们的来源标记，因此不会被当成回声
      lastChange: { originTag: null, by, at },
    });
  }

  /** 模拟外部对象被删除（§11：本地不跟着删，只打标） */
  async externalDelete(externalKey: string) {
    const obj = await this.store.get(this.provider, externalKey);
    if (obj) await this.store.put(this.provider, { ...obj, deleted: true });
  }

  failWith(message: string | null) {
    this.failure = message;
  }

  snapshot(externalKey: string): Promise<ExternalObject | undefined> {
    return this.store.get(this.provider, externalKey);
  }

  // ── IntegrationAdapter ────────────────────────────────────────────

  async testConnection(_config: ConnectionConfig): Promise<TestResult> {
    if (this.failure) return { ok: false, message: this.failure };
    return {
      ok: true,
      message: '连接正常',
      displayName: `${this.provider} (进程内)`,
      latencyMs: 1,
    };
  }

  async grantedScopes(_config: ConnectionConfig): Promise<IntegrationScopes> {
    /**
     * ★ denied 不是「这次没勾」，是「这个集成层根本不提供」。
     *   合并代码应当经过 Policy 判定 —— 一条能被打开的路径迟早会被打开，
     *   所以从授权阶段就不给。
     */
    return {
      allowed: ALLOWED_BY_PROVIDER[this.provider],
      denied: [...NEVER_GRANTED_SCOPES[this.provider]],
      probed: true,
    };
  }

  async fetchObject(_config: ConnectionConfig, externalKey: string): Promise<ExternalObject | null> {
    this.assertUp();
    return (await this.store.get(this.provider, externalKey)) ?? null;
  }

  async listObjects(_config: ConnectionConfig, limit: number): Promise<ExternalObject[]> {
    this.assertUp();
    return this.store.list(this.provider, limit);
  }

  async writeField(
    _config: ConnectionConfig,
    externalKey: string,
    field: SyncField,
    value: unknown,
    originTag: string,
  ): Promise<void> {
    this.assertUp();
    const obj = await this.store.get(this.provider, externalKey);
    if (!obj) throw new Error(`外部对象不存在: ${externalKey}`);

    await this.store.put(this.provider, {
      ...obj,
      fields: { ...obj.fields, [field]: value },
      /**
       * ★ 把 originTag 写进去，下次拉取时才认得出这是自己写的。
       *   真实适配器要把它落到外部系统真正持久化的地方
       *   （评论签名、PR body 标记、Jira 自定义字段），
       *   写进一个下次读不回来的位置等于没写。
       */
      lastChange: { originTag, by: 'APOS', at: new Date(0).toISOString() },
    });
  }

  private assertUp() {
    if (this.failure) throw new Error(this.failure);
  }
}

/** 默认授予的最小权限集（页面文档 14 §5.2「权限最小化」） */
const ALLOWED_BY_PROVIDER: Record<IntegrationProvider, string[]> = {
  github: ['read_code', 'create_branch', 'create_pr', 'read_ci', 'comment_pr'],
  jira: ['read_issue', 'write_issue', 'comment_issue', 'read_board'],
  plane: ['read_issue', 'write_issue', 'comment_issue'],
  slack: ['post_message', 'read_channel'],
  feishu: ['post_message', 'read_chat'],
};
