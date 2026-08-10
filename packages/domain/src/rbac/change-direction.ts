import type { AutonomyLevel, Policy, ResourceScope } from '@apos/contracts';
import { compile, evaluate, isAutoApprove } from '../policy/evaluate';
import { buildScenarios } from '../policy/scenarios';

/**
 * 「这次改动是收紧还是放宽？」
 *
 * ★★ 整套权限矩阵里最容易被绕开的一条。
 *
 *   §2.3 的不对称设计（收紧门槛低、放宽门槛高）只有在能**可靠区分**
 *   两者时才成立。区分错了，两个方向都会坏：
 *   - 把放宽误判成收紧 → 不对称设计形同虚设，权限累积（§7）畅通无阻；
 *   - 把收紧误判成放宽 → 想把系统调安全的人被自己的权限挡住，
 *     于是没人再去收紧，最后大家都停在最宽的配置上。
 *
 * ★ 判据是**结果**不是**写法**。比较两条规则的动作严不严格会漏掉
 *   「用一条更高优先级的宽松规则把严格规则挡在后面」这种绕法 ——
 *   规则本身没被改动，生效的却已经是新的那条。这里逐场景跑一遍看结论。
 */

export type ChangeDirection = 'tighten' | 'loosen' | 'neutral';

/**
 * Policy 改动的方向。
 *
 * 只要**存在一个**场景从「要人确认」变成「自动放行」，整次改动就算放宽 ——
 * 哪怕它同时在别的场景上收紧了。混合改动按其中最宽的那一面判，
 * 因为放宽的那一面才是需要额外证据的部分。
 */
export function policyChangeDirection(
  before: Policy[],
  after: Policy[],
  autonomyLevel: AutonomyLevel,
): ChangeDirection {
  const prev = compile(before);
  const next = compile(after);

  let loosened = false;
  let tightened = false;

  for (const scenario of buildScenarios(autonomyLevel)) {
    const a = isAutoApprove(evaluate(scenario.context, prev).action);
    const b = isAutoApprove(evaluate(scenario.context, next).action);
    if (!a && b) loosened = true;
    if (a && !b) tightened = true;
  }

  if (loosened) return 'loosen';
  if (tightened) return 'tighten';
  return 'neutral';
}

/** §3.1 的三个维度 —— 只取判定需要的部分 */
export interface AgentPermissionSet {
  allowedTools: readonly string[];
  deniedTools: readonly string[];
  resourceScopes: readonly ResourceScope[];
}

const ACCESS_RANK: Record<string, number> = { none: 0, read: 1, write: 2 };

/**
 * Agent 权限改动的方向。
 *
 * ★ 三个维度上「更宽」的定义各不相同，必须逐个判：
 *   - `allowedTools`：多了工具 = 放宽
 *   - `deniedTools`：**少了**黑名单项 = 放宽（黑名单优先级高于白名单，
 *     从黑名单里拿掉一项，等于把一条硬约束撤了）
 *   - `resourceScopes`：出现新资源、或某个资源的 access 升级 = 放宽。
 *     未列出的资源默认 `none`（§3.1 默认拒绝），所以「新增一条 read」
 *     是从 none 升到 read，是放宽而不是中性。
 */
export function agentPermissionChangeDirection(
  before: AgentPermissionSet,
  after: AgentPermissionSet,
): ChangeDirection {
  const added = (a: readonly string[], b: readonly string[]) => b.some((x) => !a.includes(x));

  const expanded =
    added(before.allowedTools, after.allowedTools) ||
    // 黑名单变短 = 放宽
    added(after.deniedTools, before.deniedTools) ||
    scopesExpanded(before.resourceScopes, after.resourceScopes);

  const restricted =
    added(after.allowedTools, before.allowedTools) ||
    added(before.deniedTools, after.deniedTools) ||
    scopesExpanded(after.resourceScopes, before.resourceScopes);

  if (expanded) return 'loosen';
  if (restricted) return 'tighten';
  return 'neutral';
}

function scopesExpanded(
  before: readonly ResourceScope[],
  after: readonly ResourceScope[],
): boolean {
  const key = (s: ResourceScope) => `${s.kind}:${s.ref}`;
  const prev = new Map(before.map((s) => [key(s), ACCESS_RANK[s.access] ?? 0]));
  return after.some((s) => (ACCESS_RANK[s.access] ?? 0) > (prev.get(key(s)) ?? 0));
}
