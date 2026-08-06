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

/** 编译后的规则：condition 变成闭包，避免每次评估遍历 JSON */
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

/** 风险等级要按序比较而不是字典序 */
/**
 * 把可比较的枚举换成序号，让 `riskLevel >= 'high'` 这类比较成立。
 *
 * ★ 数组也要逐项换。
 *   漏掉这一步的后果非常隐蔽：`riskLevel in ['medium','high']` 里
 *   actual 被换成了数字、expected 还是字符串数组，`includes` 恒为 false ——
 *   规则在界面上看着完全正确、保存也不报错，却**永远不会命中**。
 *   一条以为在保护自己的治理规则实际是死的，比没有这条规则更危险。
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

export function compile(policies: Policy[]): CompiledRule[] {
  return policies
    .filter((p) => p.enabled)
    .sort((a, b) => a.priority - b.priority)
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
 * 无规则命中时的默认动作，按项目自治等级决定（产品文档 8.9.4）
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

/** 动作严格程度比较，用于「项目规则只能收紧」的静态检查 */
export function isStricterOrEqual(a: Action, b: Action): boolean {
  return ACTION_STRICTNESS[a.type] >= ACTION_STRICTNESS[b.type];
}
