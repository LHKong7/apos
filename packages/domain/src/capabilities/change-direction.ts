import type { AgentCapability, ResourceScope } from '@apos/contracts';
import type { ChangeDirection } from '../rbac/change-direction';
import { CAPABILITY_SPECS, RISK_RANK, sortCapabilities } from './catalog';

/**
 * 能力改动的方向与影响。
 *
 * ★★ 与 Policy 那边同一条纪律（见 rbac/change-direction.ts 开头）：
 *   §2.3 的不对称设计（收紧门槛低、放宽门槛高）只有在能**可靠区分**
 *   两者时才成立。区分错了两个方向都会坏 —— 把放宽误判成收紧，
 *   权限累积畅通无阻；把收紧误判成放宽，想把系统调安全的人被自己的
 *   权限挡住，于是没人再去收紧。
 *
 * ★ 判据是**生效结果**，不是配置写法。比较两个档案的名字或版本号会漏掉
 *   「换了个档案但能力集合其实一样」和「档案没换但覆盖项变了」两种情况。
 *   这里比的是求值之后的能力集合与资源范围。
 *
 * Direction and impact of a capability change, judged on the evaluated result
 * rather than on how the configuration was written — comparing profile keys
 * would miss both a rename that changes nothing and an override that changes
 * everything.
 */

export interface CapabilityAccessSet {
  capabilities: readonly AgentCapability[];
  deniedCapabilities: readonly AgentCapability[];
  resourceScopes: readonly ResourceScope[];
}

export interface CapabilityChangeImpact {
  direction: ChangeDirection;
  addedCapabilities: AgentCapability[];
  removedCapabilities: AgentCapability[];
  /** 受影响的资源 ref —— 「这次改动会碰到哪些仓库/数据集」 */
  affectedResources: string[];
  /**
   * 要不要填原因。
   *
   * ★ 只有放宽才要求。收紧也要写理由的话，收紧就和放宽一样麻烦了，
   *   而我们恰恰希望收紧是随手能做的那件事。
   */
  requiresReason: boolean;
  /** 已渲染成人话的后果，按风险从高到低 —— 最重的那条要第一个被看见 */
  warnings: string[];
}

const ACCESS_RANK: Record<string, number> = { none: 0, read: 1, write: 2 };

export function capabilityChangeImpact(
  before: CapabilityAccessSet,
  after: CapabilityAccessSet,
): CapabilityChangeImpact {
  const beforeCaps = new Set(before.capabilities);
  const afterCaps = new Set(after.capabilities);

  const added = sortCapabilities(after.capabilities.filter((c) => !beforeCaps.has(c)));
  const removed = sortCapabilities(before.capabilities.filter((c) => !afterCaps.has(c)));

  /**
   * ★ 黑名单变短也是放宽。
   *   拒绝的优先级高于允许，从拒绝清单里拿掉一条，等于把一条硬约束撤了 ——
   *   哪怕这次生效能力一条没多，下一次换档案时它就会冒出来。
   */
  const beforeDenied = new Set(before.deniedCapabilities);
  const deniesLifted = after.deniedCapabilities.length
    ? before.deniedCapabilities.filter((c) => !new Set(after.deniedCapabilities).has(c))
    : [...beforeDenied];

  const scopesWidened = scopeExpanded(before.resourceScopes, after.resourceScopes);
  const scopesNarrowed = scopeExpanded(after.resourceScopes, before.resourceScopes);

  const loosened = added.length > 0 || deniesLifted.length > 0 || scopesWidened;
  const tightened = removed.length > 0 || scopesNarrowed;

  /**
   * ★ 混合改动按**放宽**那一面判，与 Policy 那边同一条规则：
   *   放宽的那一面才是需要额外证据的部分，而一次改动只走一条治理路径。
   */
  const direction: ChangeDirection = loosened ? 'loosen' : tightened ? 'tighten' : 'neutral';

  const warnings = [...added, ...(deniesLifted as AgentCapability[])]
    .filter((c, i, all) => all.indexOf(c) === i)
    .sort((a, b) => RISK_RANK[CAPABILITY_SPECS[b].risk] - RISK_RANK[CAPABILITY_SPECS[a].risk])
    .map((c) => CAPABILITY_SPECS[c].consequence);

  return {
    direction,
    addedCapabilities: added,
    removedCapabilities: removed,
    affectedResources: affectedRefs(before.resourceScopes, after.resourceScopes),
    requiresReason: direction === 'loosen',
    warnings,
  };
}

/** 有没有资源的访问级别升了（未列出视为 none —— §3.1 默认拒绝） */
function scopeExpanded(
  before: readonly ResourceScope[],
  after: readonly ResourceScope[],
): boolean {
  const key = (s: ResourceScope) => `${s.kind}:${s.ref}`;
  const prev = new Map(before.map((s) => [key(s), ACCESS_RANK[s.access] ?? 0]));
  return after.some((s) => (ACCESS_RANK[s.access] ?? 0) > (prev.get(key(s)) ?? 0));
}

/** 两侧访问级别不同的资源 —— 「这次改动会碰到哪些资源」 */
function affectedRefs(
  before: readonly ResourceScope[],
  after: readonly ResourceScope[],
): string[] {
  const key = (s: ResourceScope) => `${s.kind}:${s.ref}`;
  const prev = new Map(before.map((s) => [key(s), s.access]));
  const next = new Map(after.map((s) => [key(s), s.access]));

  const refs = new Set<string>();
  for (const [k, access] of next) if (prev.get(k) !== access) refs.add(k.split(':').slice(1).join(':'));
  for (const [k, access] of prev) if (next.get(k) !== access) refs.add(k.split(':').slice(1).join(':'));
  return [...refs].sort();
}
