import {
  ACTION_STRICTNESS,
  AUTO_APPROVE_ACTIONS,
  NEVER_AUTO_APPROVE,
  RISK_ORDER,
  type Action,
  type Condition,
  type FactKey,
  type Operator,
  type Policy,
  type PolicyContext,
  type PolicyVerdict,
  type TraceEntry,
} from '@apos/contracts';

/**
 * 编译后的规则：condition 变成闭包，避免每次评估遍历 JSON。
 * A compiled rule: the condition becomes a closure so evaluation does not walk
 * the JSON every time.
 */
export interface CompiledRule {
  id: string;
  name: string;
  priority: number;
  action: Action;
  match: (ctx: PolicyContext) => ConditionMatchResult;
}

export type ConditionMatchResult =
  | { matched: true }
  | { matched: false; failedAt: TraceEntry['failedAt'] };

const RISK_LEVELS = new Set(Object.keys(RISK_ORDER));

/**
 * 把可比较的枚举换成序号，让 `riskLevel >= 'high'` 这类比较成立
 * —— 风险等级要按序比较而不是字典序。
 *
 * ★ 数组也要逐项换。
 *   漏掉这一步的后果非常隐蔽：`riskLevel in ['medium','high']` 里
 *   actual 被换成了数字、expected 还是字符串数组，`includes` 恒为 false ——
 *   规则在界面上看着完全正确、保存也不报错，却**永远不会命中**。
 *   一条以为在保护自己的治理规则实际是死的，比没有这条规则更危险。
 *
 * Turn comparable enums into ordinals so `riskLevel >= 'high'` means what it
 * looks like — risk levels compare by rank, not alphabetically.
 *
 * ★ Arrays must be converted element by element.
 *   Missing that fails very quietly: in `riskLevel in ['medium','high']` the
 *   actual becomes a number while the expected stays an array of strings, so
 *   `includes` is permanently false. The rule looks entirely correct in the
 *   UI, saves without complaint, and **never matches**. A governance rule
 *   someone believes is protecting them, but which is dead, is more dangerous
 *   than not having the rule at all.
 */
function comparable(fact: FactKey, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => comparable(fact, v));
  if (fact === 'riskLevel' && typeof value === 'string' && RISK_LEVELS.has(value)) {
    return RISK_ORDER[value as keyof typeof RISK_ORDER];
  }
  return value;
}

export function applyOperator(op: Operator, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case 'eq':
      return actual === expected;
    case 'ne':
      return actual !== expected;
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'in':
      return Array.isArray(expected) && expected.includes(actual as never);
    case 'not_in':
      return Array.isArray(expected) && !expected.includes(actual as never);
    case 'contains':
      return Array.isArray(actual) && actual.includes(expected as never);
  }
}

export function matchCondition(cond: Condition, ctx: PolicyContext): ConditionMatchResult {
  if ('all' in cond) {
    for (const sub of cond.all) {
      const r = matchCondition(sub, ctx);
      if (!r.matched) return r;
    }
    return { matched: true };
  }

  if ('any' in cond) {
    let firstFailure: TraceEntry['failedAt'] = null;
    for (const sub of cond.any) {
      const r = matchCondition(sub, ctx);
      if (r.matched) return { matched: true };
      if (!firstFailure) firstFailure = r.failedAt;
    }
    return { matched: false, failedAt: firstFailure };
  }

  if ('not' in cond) {
    const r = matchCondition(cond.not, ctx);
    return r.matched ? { matched: false, failedAt: null } : { matched: true };
  }

  const actual = ctx[cond.fact];
  const ok = applyOperator(cond.op, comparable(cond.fact, actual), comparable(cond.fact, cond.value));
  return ok
    ? { matched: true }
    : {
        matched: false,
        failedAt: { fact: cond.fact, op: cond.op, expected: cond.value, actual },
      };
}

/**
 * ★★ 同优先级时更严的先评估。
 *
 *   `evaluate` 命中即停，所以两条优先级相同、又都能匹配同一个上下文的规则，
 *   谁排前面谁说了算。不定序的话这个「谁」由数据库返回行的顺序决定 ——
 *   同一份配置在两台机器上可能给出相反的判定，而这种问题几乎不可能复现。
 *
 *   平局倒向**更严**的那一条：并列意味着用户没有表态哪条更重要，
 *   而在治理配置上，没表态时选安全的那一侧是唯一说得过去的默认。
 *
 * Ties in priority resolve toward the stricter action. Since evaluation stops
 * at the first match, an unbroken tie lets row order decide the verdict — the
 * same configuration could rule differently on two machines, and that class of
 * bug is close to unreproducible. A tie means the user never said which rule
 * matters more, and on governance config the safe side is the only defensible
 * default.
 */
function byPriorityThenStrictness(a: Policy, b: Policy): number {
  return a.priority - b.priority || ACTION_STRICTNESS[b.action.type] - ACTION_STRICTNESS[a.action.type];
}

export function compile(policies: Policy[]): CompiledRule[] {
  return policies
    .filter((p) => p.enabled)
    .sort(byPriorityThenStrictness)
    .map((p) => ({
      id: p.id,
      name: p.name,
      priority: p.priority,
      action: p.action,
      match: (ctx: PolicyContext) => matchCondition(p.condition, ctx),
    }));
}

export function isAutoApprove(action: Action): boolean {
  return (AUTO_APPROVE_ACTIONS as readonly string[]).includes(action.type);
}

export function requiresHuman(action: Action): boolean {
  switch (action.type) {
    case 'allow':
    case 'allow_and_notify':
    case 'require_agent_review':
      return false;
    default:
      return true;
  }
}

/**
 * 无规则命中时的默认动作，按项目自治等级决定（产品文档 8.9.4）。
 * The action taken when no rule matches, decided by the project's autonomy
 * level (product doc 8.9.4).
 */
export function defaultAction(ctx: PolicyContext): Action {
  switch (ctx.autonomyLevel) {
    case 'human_led':
      return {
        type: 'require_human_review',
        assignee: { kind: 'project_role', role: 'pm' },
        dueInHours: 8,
      };
    case 'agent_led_approval':
      return RISK_ORDER[ctx.riskLevel] <= RISK_ORDER.medium
        ? { type: 'allow' }
        : {
            type: 'require_human_review',
            assignee: { kind: 'project_role', role: 'tech_lead' },
            dueInHours: 4,
          };
    case 'agent_autonomous':
      return { type: 'allow' };
  }
}

/**
 * ★ 安全底线：无论自治等级与项目规则如何，这三类操作永远不自动放行。
 * docs/tech/09-security.md §9 —— 硬编码而非依赖 Policy 配置正确。
 *
 * ★ The safety floor: whatever the autonomy level or the project's own rules
 * say, these three operation classes are never auto-approved.
 * docs/tech/09-security.md §9 — hard-coded rather than trusting the policy
 * configuration to be right. `evaluate.test.ts` asserts this exhaustively and
 * blocks CI: if it goes red, governance has been bypassed.
 */
function enforceSafetyFloor(action: Action, ctx: PolicyContext): Action {
  if (!isAutoApprove(action)) return action;
  if (!(NEVER_AUTO_APPROVE as readonly string[]).includes(ctx.operationType)) return action;

  return {
    type: 'require_human_review',
    assignee: { kind: 'project_role', role: 'tech_lead' },
    dueInHours: 4,
  };
}

export function evaluate(ctx: PolicyContext, rules: CompiledRule[]): PolicyVerdict {
  const trace: TraceEntry[] = [];

  for (const rule of rules) {
    const result = rule.match(ctx);
    trace.push({
      policyId: rule.id,
      name: rule.name,
      matched: result.matched,
      failedAt: result.matched ? null : result.failedAt,
    });

    if (result.matched) {
      const action = enforceSafetyFloor(rule.action, ctx);
      return {
        action,
        matchedPolicyId: rule.id,
        matchedPolicyName: rule.name,
        trace,
        requiresHuman: requiresHuman(action),
        contextSnapshot: ctx,
      };
    }
  }

  const action = enforceSafetyFloor(defaultAction(ctx), ctx);
  return {
    action,
    matchedPolicyId: null,
    matchedPolicyName: null,
    trace,
    requiresHuman: requiresHuman(action),
    contextSnapshot: ctx,
  };
}

/**
 * 动作严格程度比较，用于「项目规则只能收紧」的静态检查。
 * Compares how strict two actions are, for the static check that a project
 * rule may only tighten an organization rule.
 */
export function isStricterOrEqual(a: Action, b: Action): boolean {
  return ACTION_STRICTNESS[a.type] >= ACTION_STRICTNESS[b.type];
}
