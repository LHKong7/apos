import type { ChangeSet, PublishResult, Workspace } from '@apos/contracts';
import type { Publisher, ReleaseContext } from '../publisher-types';

/**
 * 不交货 —— 产出留在本地目录，由上层按变更集自行收集。
 *
 * ★★ 它**不会**报 `persisted: true`。
 *
 *   「本地即已发布」是一句自欺：工作区收尾后目录通常就被回收了，
 *   即使保留（规划任务那样），容器一回收也什么都不剩。把它标成已发布
 *   的代价是用户点开产物看到一个不存在的路径 —— 而「有产物但打不开」
 *   会被当成 bug 报上来，比一开始就说清楚贵得多。
 *
 *   如实的说法是：改动在这里，但这个位置不是持久存储。
 */
export class NonePublisher implements Publisher {
  readonly kind = 'none' as const;

  /**
   * @param reason 为什么落到「不交货」。
   *
   * ★ 配了交货目标却没生效（目标只读、路径被白名单挡住、登记已停用）时，
   *   必须说出原因。不说的话，用户看到的是一句「产出留在 …」——
   *   与「本来就没配交货目标」一模一样，而这两种情况一个是配置没生效、
   *   一个是符合预期。
   */
  constructor(private readonly reason?: string) {}

  async publish(ws: Workspace, changes: ChangeSet, _ctx: ReleaseContext): Promise<PublishResult> {
    const where = ws.mounts.find((m) => m.role === 'primary')?.path ?? ws.root;
    const suffix = this.reason ? `；${this.reason}` : '';

    if (changes.truncated) {
      return {
        kind: 'none',
        persisted: false,
        note: `产出留在 ${where}，但变更集不完整（目录过大或基线丢失），无法确定改了什么${suffix}`,
      };
    }

    return {
      kind: 'none',
      persisted: false,
      note:
        (changes.total > 0
          ? `${changes.total} 处改动留在 ${where}；该目录不在版本控制下，也未上传到持久存储`
          : `${where} 里没有任何改动`) + suffix,
    };
  }
}
