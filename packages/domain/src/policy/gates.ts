import type { Condition, FactKey, Policy, PolicyContext } from '@apos/contracts';
import { matchCondition, requiresHuman } from './evaluate';
import { explainPolicy } from './explain';

/**
 * 派发前告诉 Agent「做到哪一步会被拦下」。
 *
 * ★ 这一层解决的是一种很贵的失败：Agent 看不到 Policy 引擎 ——
 *   Policy 评估发生在状态流转上，是平台侧的事，它既不能遵守也不能违反。
 *   于是它可能花掉整个 token 预算做到生产发布，才在流转那一步被冻住。
 *   提前说出来，它就能在动手前把这件事挑明，或者绕开那条路径。
 *
 * ★ 这是**告知**不是**授权**：真正的拦截仍然发生在 `transition()` 里。
 *   Agent 读没读、信不信，都不改变结果。所以措辞不能写成「你不许做 X」——
 *   那会让 Agent 以为自己是执行方，而它不是。
 *
 * Tells the agent, before it starts, which situations will get its work held
 * for a human. Agents cannot see the policy engine — evaluation happens on
 * state transitions, platform-side — so without this an agent can spend its
 * whole budget building toward an action that freezes the moment it reports
 * done. This is disclosure, not authorization: `transition()` still does the
 * actual gating whether or not the agent read this.
 */

/**
 * 派发时还不知道、要看 Agent 做出什么才定的 fact。
 *
 * ★ 这张表是筛选的全部依据，宁可多列不可少列：漏列一个 fact 会让引用它的
 *   规则被当成「不可能命中」而悄悄消失 —— Agent 收不到警告，症状与这个
 *   功能压根没上线一模一样，而且不会有任何报错。
 *
 * Facts that are not yet known at dispatch because they depend on what the
 * agent actually does. Err on the side of listing too many: omitting one makes
 * every rule referencing it silently vanish from the warning, which looks
 * exactly like the feature not shipping and raises no error.
 */
export const AGENT_DETERMINED_FACTS: readonly FactKey[] = [
  // 这次工作最终算哪一类操作、碰到哪个环境和哪级数据 —— 高风险规则几乎都靠它们
  'operationType',
  'environment',
  'dataSensitivity',
  'reversible',
  'externalFacing',
  'impactServices',
  // 跑完才测得出来的结论
  'testsResult',
  'testCoverage',
  'securityScan',
  'agentReview',
  'agentConfidence',
  // 只增不减的计数器，跑的过程中会往上走
  'runTokens',
  'projectTokensSpent',
  'budgetUsedPct',
];

const AGENT_DETERMINED = new Set<FactKey>(AGENT_DETERMINED_FACTS);

export interface PolicyGate {
  name: string;
  explanation: string;
}

/**
 * 这个 fact 在本次执行中还有没有可能取到别的值。
 *
 * ★ `budgetUsedPct` 要单独判：项目没设预算时它恒为 null，任何比较都不成立。
 *   不判的话「预算超限需 Sponsor 批准」会出现在每一次派发里 —— 而那条规则
 *   在这个项目上永远不可能命中。狼来了喊多了，真正该看的那几条就没人看了。
 *
 * Whether this fact could still take a different value during this run.
 * `budgetUsedPct` needs its own check: with no project budget it stays null
 * forever, so the budget rule would otherwise be warned about on every single
 * dispatch while being incapable of ever firing.
 */
function stillOpen(fact: FactKey, ctx: PolicyContext): boolean {
  if (!AGENT_DETERMINED.has(fact)) return false;

  switch (fact) {
    case 'budgetUsedPct':
      return ctx.projectTokenBudget !== null;

    /**
     * ★ 规划阶段已经给这个任务定过性的，就按定的算，不再当成未知。
     *
     *   计划生成时会要求规划 Agent 给每个任务标上 operationType 与
     *   environment（modules/planning/agent-brief.ts）。标过的任务，
     *   「这是什么操作、打到哪个环境」在派发前就定了 —— 执行 Agent
     *   再怎么做也不会把一个 deploy 任务变成 payment 任务。
     *
     *   不作这个区分的代价是：一个明确标了 deploy/production 的任务，
     *   会连同付款、删资源、改权限一起收到九条警告。真正会命中的那条
     *   淹在里面，与没警告差不多 —— 而这正是这个功能要解决的问题。
     *
     * Facts the planning stage already pinned down are treated as fixed:
     * an explicitly classified task cannot turn into a different operation
     * class while the agent works. Without this, a task tagged
     * deploy/production would receive all nine warnings instead of the one
     * that will actually fire, burying the signal it exists to deliver.
     */
    case 'environment':
      return ctx.environment === null;
    case 'dataSensitivity':
      return ctx.dataSensitivity === null;
    /**
     * ★ operationType 没有 null —— 未分类时 buildPolicyContext 兜底成
     *   code_change，因此这个值同时意味着「没标过」和「确实是改代码」。
     *   两者分不开时按「没标过」处理：多报几条的代价是几十个 token，
     *   漏报的代价是一次跑到一半才发现要等人的 Run。
     */
    case 'operationType':
      return ctx.operationType === 'code_change';

    default:
      return true;
  }
}

/**
 * 这条规则在本次执行中还有没有可能命中。
 * 已定的 fact 照常求值，未定的 fact 一律按「可能」处理。
 */
function couldMatch(cond: Condition, ctx: PolicyContext): boolean {
  if ('all' in cond) return cond.all.every((c) => couldMatch(c, ctx));
  if ('any' in cond) return cond.any.some((c) => couldMatch(c, ctx));
  /**
   * ★ 取反一律按「可能」。`not` 里套着未定 fact 时，排除它需要证明
   *   内层在所有取值下都成立 —— 那是求解不是求值。保守多报一条，
   *   代价是几十个 token；漏报的代价是一次白跑的 Run。
   */
  if ('not' in cond) return true;
  if (stillOpen(cond.fact, ctx)) return true;
  return matchCondition(cond, ctx).matched;
}

/**
 * 挑出该告诉 Agent 的规则。
 *
 * 两道筛子：只留会**卡住人**的动作（自动放行的规则说了也没用），
 * 且在本次执行中**还有可能命中**（已经被固定 fact 排除的不提）。
 *
 * 返回顺序沿用 priority 升序 —— 与 `evaluate()` 的首次命中顺序一致，
 * 排在前面的就是先命中的那条。
 */
export function selectPolicyGates(policies: Policy[], ctx: PolicyContext): PolicyGate[] {
  return policies
    .filter((p) => p.enabled)
    .filter((p) => requiresHuman(p.action))
    .filter((p) => couldMatch(p.condition, ctx))
    .sort((a, b) => a.priority - b.priority)
    .map((p) => ({ name: p.name, explanation: explainPolicy(p.condition, p.action) }));
}
