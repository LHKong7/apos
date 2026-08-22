import type { Permission } from '@apos/domain';
import { PERMISSION_SPECS } from '@apos/domain';
import type { ChangeDirection } from '@apos/domain';
import { fail } from './errors';

/**
 * Governed mutations — a pipeline with a fixed order / 受治理的变更 —— 一条固定顺序的流水线。
 *
 * ★★ This function exists for the **order**, not for code reuse.
 *
 *   "Authorize first or classify the direction first" has exactly one correct answer, and
 *   writing it out by hand in each place produces both. The authorize-first version is the
 *   broken one: without knowing the direction you cannot know which permission to demand, so
 *   the implementation has to pick one, and it picks the looser one
 *   (`agent.permissions.restrict`). At that moment the asymmetric design of §2.3 stops
 *   existing — someone who may only tighten can loosen too.
 *
 *   By the same logic, reason / simulation / dual-signature checks must run **before** the
 *   transaction: doing them inside means a loosening that should have been refused was already
 *   written once and is only undone by a rollback. And the audit event must be emitted
 *   **after** the transaction, for the same reason the event bus gives
 *   (modules/event/bus.ts): publishing inside pushes a change to the browser that then rolls
 *   back.
 *
 * ```
 * read current state → classify direction → authorize → check reason/simulation/dual-sign →
 * transaction → audit
 * ```
 *
 * ★ `PermissionSpec.governance` used to be purely **descriptive**: the catalog said "this one
 *   needs a reason", while the enforcement was scattered across handlers and depended on each
 *   author remembering. This wires that metadata into execution — if the catalog says it is
 *   required, it is required.
 *   这个函数存在的理由是**顺序**，不是代码复用。
 *   「先判权限还是先算方向」这个问题只有一个正确答案，而每处各写一遍就会
 *   出现两种写法。先判权限的那种是坏的：不知道方向就不知道该判哪一条权限，
 *   于是实现只能挑一条，通常挑宽的那条（`agent.permissions.restrict`），
 *   §2.3 的不对称设计当场作废 —— 一个只能收紧的人也能放宽。
 *   同理，原因/模拟/双签必须在**事务之前**校验：放到事务里意味着一次
 *   本该被拒的放宽已经写进去过，靠回滚兜底；而审计事件必须在事务**之后**
 *   发，理由与事件总线那条一样（modules/event/bus.ts）——
 *   事务内发布会把一条随后被回滚的变更推给浏览器。
 *   `PermissionSpec.governance` 在此之前只是**描述性**的：目录里写着
 *   「这条要填原因」，而真正的判定散落在各个 handler 里，写没写全靠自觉。
 *   这里把那份元数据接到执行上 —— 目录说要，就一定要。
 */

export interface GovernedMutationInput<T> {
  /** The permission check, already resolved from rbac by the caller */
  assertPermission: (permission: Permission) => void;
  /** Whether this change tightens or loosens — decided by a domain function from the
   *  **effective outcome**, not from how it was written /
   *  这次改动是收紧还是放宽 —— 由领域函数按**生效结果**判定，不是按写法 */
  direction: ChangeDirection;
  /**
   * Direction → which permission is demanded.
   *
   * ★ The two directions must map to different permissions, or the asymmetric design has
   *   nowhere to land. Neutral needs one too — a request that "changes nothing" is still a
   *   write.
   *   两个方向必须给不同的权限，否则不对称设计没有落点。
   *   neutral 也要给一条 —— 「什么都没变」的请求同样是一次写操作。
   */
  permissionForDirection: Record<ChangeDirection, Permission>;
  /** The reason supplied by the caller */
  reason: string | null;
  /** The actual write. Its return value is passed straight through */
  mutate: () => Promise<T>;
  /** Emits the audit event, after the transaction commits */
  audit: (result: T) => Promise<void>;
}

export async function executeGovernedMutation<T>(input: GovernedMutationInput<T>): Promise<T> {
  const permission = input.permissionForDirection[input.direction];

  // ① Authorize: you have to know the direction before you know which permission to ask for
  input.assertPermission(permission);

  // ② Governance requirements: check whatever the catalog demands, and check it before the
  // transaction
  const governance = PERMISSION_SPECS[permission].governance;
  if (governance?.reason && !input.reason?.trim()) {
    throw fail(
      'VALIDATION_FAILED',
      'agent.change_needs_reason',
      `「${PERMISSION_SPECS[permission].label}」必须填写原因`,
      { details: { permission } },
    );
  }

  // ③ Write
  const result = await input.mutate();

  /**
   * ④ Audit — after the transaction.
   *
   * ★ Emitting inside the transaction would push a change to the browser that then rolls back;
   *   same reason as the event bus convention.
   *   审计 —— 在事务之后。事务内发事件会把一条随后被回滚的变更推给浏览器，
   *   与事件总线那条约定是同一个理由。
   */
  await input.audit(result);

  return result;
}
