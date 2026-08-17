import type { Permission } from '@apos/domain';
import { PERMISSION_SPECS } from '@apos/domain';
import type { ChangeDirection } from '@apos/domain';
import { ApiError } from './errors';

/**
 * 受治理的变更 —— 一条固定顺序的流水线。
 *
 * ★★ 这个函数存在的理由是**顺序**，不是代码复用。
 *
 *   「先判权限还是先算方向」这个问题只有一个正确答案，而每处各写一遍就会
 *   出现两种写法。先判权限的那种是坏的：不知道方向就不知道该判哪一条权限，
 *   于是实现只能挑一条，通常挑宽的那条（`agent.permissions.restrict`），
 *   §2.3 的不对称设计当场作废 —— 一个只能收紧的人也能放宽。
 *
 *   同理，原因/模拟/双签必须在**事务之前**校验：放到事务里意味着一次
 *   本该被拒的放宽已经写进去过，靠回滚兜底；而审计事件必须在事务**之后**
 *   发，理由与事件总线那条一样（modules/event/bus.ts）——
 *   事务内发布会把一条随后被回滚的变更推给浏览器。
 *
 * ```
 * 读当前状态 → 判方向 → 授权 → 校验原因/模拟/双签 → 事务 → 审计
 * ```
 *
 * ★ `PermissionSpec.governance` 在此之前只是**描述性**的：目录里写着
 *   「这条要填原因」，而真正的判定散落在各个 handler 里，写没写全靠自觉。
 *   这里把那份元数据接到执行上 —— 目录说要，就一定要。
 *
 * A fixed-order pipeline for governed changes. It exists for the order, not for
 * reuse: "authorize or classify first" has exactly one correct answer, and
 * hand-written copies pick the wrong one — without the direction you cannot
 * know which permission to demand, so implementations settle on the looser one
 * and the asymmetric tighten/loosen design quietly stops existing.
 */

export interface GovernedMutationInput<T> {
  /** 判定主体，由调用方从 rbac 解析好 */
  assertPermission: (permission: Permission) => void;
  /** 这次改动是收紧还是放宽 —— 由领域函数按**生效结果**判定，不是按写法 */
  direction: ChangeDirection;
  /**
   * 方向 → 要哪条权限。
   *
   * ★ 两个方向必须给不同的权限，否则不对称设计没有落点。
   *   neutral 也要给一条 —— 「什么都没变」的请求同样是一次写操作。
   */
  permissionForDirection: Record<ChangeDirection, Permission>;
  /** 调用方填的原因 */
  reason: string | null;
  /** 真正的写入。返回值原样透出 */
  mutate: () => Promise<T>;
  /** 事务提交之后发审计事件 */
  audit: (result: T) => Promise<void>;
}

export async function executeGovernedMutation<T>(input: GovernedMutationInput<T>): Promise<T> {
  const permission = input.permissionForDirection[input.direction];

  // ① 授权：先知道方向，才知道该问哪条权限
  input.assertPermission(permission);

  // ② 治理要求：目录说要什么就校什么，判定在事务之前
  const governance = PERMISSION_SPECS[permission].governance;
  if (governance?.reason && !input.reason?.trim()) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `「${PERMISSION_SPECS[permission].label}」必须填写原因`,
      { permission },
    );
  }

  // ③ 写入
  const result = await input.mutate();

  /**
   * ④ 审计 —— 在事务之后。
   *
   * ★ 事务内发事件会把一条随后被回滚的变更推给浏览器，与事件总线
   *   那条约定是同一个理由。
   */
  await input.audit(result);

  return result;
}
