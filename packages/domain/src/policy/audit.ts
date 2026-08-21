import {
  HIGH_RISK_OPERATIONS,
  NEVER_AUTO_APPROVE,
  type Action,
  type ActionType,
  type AutonomyLevel,
  type FactKey,
  type Policy,
} from '@apos/contracts';
import { compile, evaluate, isAutoApprove, isStricterOrEqual } from './evaluate';
import { explainAction } from './explain';
import { requiredFacts } from './simulate';
import { OPERATION_LABELS, buildScenarios, type Scenario } from './scenarios';

/**
 * 规则集体检 —— 页面文档 13 §5.1 / §5.8 / §11。
 *
 * 摘要与四类问题共用同一次场景枚举：它们问的其实是同一件事 ——
 * 「在各种真实场景下，这套规则到底会怎么判」。分开算不但浪费，
 * 还会出现「摘要说自动执行、诊断说需要审批」这种自相矛盾。
 */

export const POLICY_ISSUE_TYPES = [
  'conflict',
  'unreachable',
  'coverage_gap',
  'too_permissive',
  'everything_gated',
  'zero_hit',
  'missing_data_source',
] as const;
export type PolicyIssueType = (typeof POLICY_ISSUE_TYPES)[number];

/** 一个反例场景的**结构**。界面据此按自己的语言拼那句 `操作 · 风险高 · 生产环境` */
export interface ScenarioShape {
  operationType: string;
  riskLevel: string;
  environment: string | null;
}

export interface PolicyIssue {
  /**
   * ★★ 界面按它取词（`policy.issue.<type>`）。每个 type 恰好对应一句话 ——
   *   这是它能当词条键用的前提，新增 type 时要保持。
   */
  type: PolicyIssueType;
  severity: 'critical' | 'warning' | 'info';
  /** 中文兜底。界面读码，日志读句子 */
  message: string;
  /** 词条里 `{name}` 的实参。规则名是用户起的，原样带 */
  params?: Record<string, string | number>;
  /** 一个具体的反例场景，比任何描述都好懂 */
  example: string | null;
  /** 同上，但给的是结构 —— 界面照自己的语言拼，不用服务端那句中文 */
  exampleContext?: ScenarioShape | null;
  /** `missing_data_source` 专用：缺的是哪几项 fact。界面自己拼列表 */
  facts?: string[];
  policyIds: string[];
}

/**
 * 「什么情况下才需要人」的**结构**（verdict = depends 时）。
 *
 * ★★ 与 `when` 那句中文一一对应，但给的是枚举键。
 *   「在生产环境，或风险等级为高时需要人确认」这句话里，
 *   连接词、语序、量词三样在两种语言里都不同 —— 服务端拼好一句，
 *   英文界面上就只能整句照抄中文。而这一行是这一页的第一屏。
 *
 * The structured form of `when`: enum keys rather than a sentence, because the
 * conjunctions and clause order differ between languages and this line sits on
 * the page's first screen.
 */
export interface GateShape {
  /** 只要落在这些环境就一定需要人 */
  environments: string[];
  /** 只要是这些风险等级就一定需要人 */
  riskLevels: string[];
  /** 上面两项都空时的退路：多少种情况里有多少种需要人 */
  gatedCount: number;
  totalCount: number;
}

export interface OperationOutcome {
  operationType: string;
  label: string;
  verdict: 'auto' | 'human' | 'depends';
  /** verdict = human 时，谁来决定。中文兜底，界面读 `byAction` */
  by: string | null;
  /** ★ 拦下它的是哪一类动作 —— 界面有 `policy.action.*` 那组词条 */
  byAction: ActionType | null;
  /** verdict = depends 时，什么情况下需要人。中文兜底，界面读 `gate` */
  when: string | null;
  /** 同上，但给的是结构 —— 界面照自己的语言拼 */
  gate: GateShape | null;
  matchedPolicyIds: string[];
}

export interface PolicySummary {
  auto: OperationOutcome[];
  human: OperationOutcome[];
  depends: OperationOutcome[];
}

export interface PolicyAudit {
  summary: PolicySummary;
  issues: PolicyIssue[];
}

/**
 * 每条规则的运行统计。由调用方从库里带进来。
 *
 * ★ `ageDays` 不是可选项：对一条五分钟前刚建的规则说「近 30 天一次都没命中」，
 *   字面上没错，作为提示是纯噪声 —— 而体检区一旦有噪声，
 *   用户连带会略过真正重要的那几条。
 */
export interface HitStats {
  policyId: string;
  hits30d: number;
  ageDays: number;
  avgWaitSeconds: number | null;
}

/**
 * fact 与它的数据来源。条件引用了没接入的来源时，规则永远不会命中 ——
 * 这是页面文档 §11 里最阴险的一种失效：规则看起来配好了，实际是死的。
 */
const FACT_SOURCES: Partial<Record<FactKey, string>> = {
  testsResult: 'CI 测试结果',
  testCoverage: '测试覆盖率',
  securityScan: '安全扫描',
  agentReview: 'Review Agent 结论',
};

export function auditPolicies(
  policies: Policy[],
  autonomyLevel: AutonomyLevel,
  hits: HitStats[] = [],
  wiredFacts: FactKey[] = [],
): PolicyAudit {
  const scenarios = buildScenarios(autonomyLevel);
  const rules = compile(policies);
  const byId = new Map(policies.map((p) => [p.id, p]));

  /** 每个场景的判定 + 是哪条规则做的 */
  const verdicts = scenarios.map((s) => ({
    scenario: s,
    verdict: evaluate(s.context, rules),
  }));

  return {
    summary: summarize(verdicts),
    issues: [
      ...findConflicts(verdicts, policies, byId),
      ...findUnreachable(verdicts, policies),
      ...findAutoPassedRisks(verdicts, policies.length > 0),
      ...findEverythingGated(verdicts),
      ...findMissingDataSources(policies, wiredFacts),
      ...findZeroHit(policies, hits, wiredFacts),
    ].sort(bySeverity),
  };
}

type Verdicts = { scenario: Scenario; verdict: ReturnType<typeof evaluate> }[];

/**
 * 「N 类操作自动执行，M 类需要人类确认」（§5.1）。
 *
 * ★ 这句话是整页最重要的一行。用户不会去读 12 条规则再自己推导边界；
 *   他要的就是这一句。所以「视情况而定」必须说清楚是什么情况 ——
 *   一个只说「看情况」的摘要还不如不给。
 */
function summarize(verdicts: Verdicts): PolicySummary {
  const byOperation = new Map<string, Verdicts>();
  for (const v of verdicts) {
    const op = v.scenario.context.operationType;
    const list = byOperation.get(op);
    if (list) list.push(v);
    else byOperation.set(op, [v]);
  }

  const out: OperationOutcome[] = [];
  for (const [operationType, list] of byOperation) {
    const autoCount = list.filter((v) => isAutoApprove(v.verdict.action)).length;
    const matchedPolicyIds = [
      ...new Set(list.map((v) => v.verdict.matchedPolicyId).filter((id): id is string => !!id)),
    ];

    const label = OPERATION_LABELS[operationType] ?? operationType;
    if (autoCount === list.length) {
      out.push({
        operationType,
        label,
        verdict: 'auto',
        by: null,
        byAction: null,
        when: null,
        gate: null,
        matchedPolicyIds,
      });
    } else if (autoCount === 0) {
      const sample = list.find((v) => !isAutoApprove(v.verdict.action))!;
      out.push({
        operationType,
        label,
        verdict: 'human',
        by: assigneeOf(sample.verdict.action),
        byAction: sample.verdict.action.type,
        when: null,
        gate: null,
        matchedPolicyIds,
      });
    } else {
      const gate = describeGate(list);
      out.push({
        operationType,
        label,
        verdict: 'depends',
        by: null,
        byAction: null,
        when: gate.text,
        gate: gate.shape,
        matchedPolicyIds,
      });
    }
  }

  out.sort((a, b) => a.label.localeCompare(b.label, 'zh'));
  return {
    auto: out.filter((o) => o.verdict === 'auto'),
    human: out.filter((o) => o.verdict === 'human'),
    depends: out.filter((o) => o.verdict === 'depends'),
  };
}

/**
 * 找出「什么情况下才需要人」。
 *
 * ★ 真实的分界往往是**析取**的：「生产环境，或者风险高」。
 *   只在单个轴上找分界会一个都找不到，于是退化成
 *   「12 / 20 种情况需要人确认」—— 一句正确但毫无用处的话，
 *   用户看完还是得自己去读规则，摘要就白写了。
 *
 *   做法：先找出「只要满足它就一定需要人」的单值条件，
 *   再看这些条件的并集能不能盖住全部需要人的场景。能盖住就直接说出来。
 */
function describeGate(list: Verdicts): { text: string; shape: GateShape } {
  const gated = list.filter((v) => !isAutoApprove(v.verdict.action));
  const counts = { gatedCount: gated.length, totalCount: list.length };
  const empty: GateShape = { environments: [], riskLevels: [], ...counts };
  if (gated.length === 0) return { text: '', shape: empty };

  const gatedKeys = new Set(gated.map((v) => v.scenario.key));
  const sufficient: { axis: 'env' | 'risk'; value: string; covers: Set<string> }[] = [];

  const axes = [
    { axis: 'env' as const, of: (v: Verdicts[number]) => v.scenario.context.environment ?? 'none' },
    { axis: 'risk' as const, of: (v: Verdicts[number]) => v.scenario.context.riskLevel as string },
  ];

  for (const { axis, of } of axes) {
    for (const value of new Set(list.map(of))) {
      const matching = list.filter((v) => of(v) === value);
      // 「只要满足它就一定需要人」才算充分条件
      if (matching.every((v) => gatedKeys.has(v.scenario.key))) {
        sufficient.push({ axis, value, covers: new Set(matching.map((v) => v.scenario.key)) });
      }
    }
  }

  const covered = new Set(sufficient.flatMap((s) => [...s.covers]));
  if (sufficient.length > 0 && gated.every((v) => covered.has(v.scenario.key))) {
    const envKeys = sufficient.filter((s) => s.axis === 'env').map((s) => s.value);
    const riskKeys = sufficient.filter((s) => s.axis === 'risk').map((s) => s.value);
    const envs = envKeys.map((v) => ENV_TEXT[v] ?? v);
    const risks = riskKeys.map((v) => RISK_TEXT[v] ?? v);

    const parts: string[] = [];
    if (envs.length > 0) parts.push(`在${envs.join('、')}`);
    if (risks.length > 0) parts.push(`风险等级为${risks.join('、')}`);
    return {
      text: `${parts.join('，或')}时需要人确认`,
      shape: { environments: envKeys, riskLevels: riskKeys, ...counts },
    };
  }

  return { text: `${gated.length} / ${list.length} 种情况需要人确认`, shape: empty };
}

const ENV_TEXT: Record<string, string> = {
  dev: '开发环境',
  test: '测试环境',
  staging: '预生产',
  production: '生产环境',
  none: '不涉及环境',
};
const RISK_TEXT: Record<string, string> = { low: '低', medium: '中', high: '高', critical: '极高' };

/**
 * 规则冲突：低优先级规则想收紧，却被高优先级规则先放行了。
 *
 * ★ 在「优先级先匹配、命中即停」的语义下，这才是真正会伤人的那种冲突 ——
 *   规则作者以为自己加了一道闸，实际那道闸永远轮不到。
 *   两条规则判定「不一致」但严格程度递增，不是问题，是正常的分层。
 */
function findConflicts(
  verdicts: Verdicts,
  policies: Policy[],
  byId: Map<string, Policy>,
): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  const seen = new Set<string>();

  for (const { scenario, verdict } of verdicts) {
    if (!verdict.matchedPolicyId) continue;
    const winner = byId.get(verdict.matchedPolicyId);
    if (!winner || !isAutoApprove(winner.action)) continue;

    // 有没有更低优先级的规则，本来会对这个场景要求更严
    const shadowed = policies.find(
      (p) =>
        p.enabled &&
        p.id !== winner.id &&
        p.priority > winner.priority &&
        !isStricterOrEqual(winner.action, p.action) &&
        matchesScenario(p, scenario),
    );
    if (!shadowed) continue;

    const key = `${winner.id}|${shadowed.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    issues.push({
      type: 'conflict',
      severity: 'critical',
      message: `「${winner.name}」会先放行，「${shadowed.name}」的更严要求永远轮不到`,
      params: { winner: winner.name, shadowed: shadowed.name },
      example: describeScenario(scenario),
      exampleContext: scenarioShape(scenario),
      policyIds: [winner.id, shadowed.id],
    });
  }

  return issues.slice(0, 5);
}

/** 不可达：在任何场景下都没被命中过的启用规则 */
function findUnreachable(verdicts: Verdicts, policies: Policy[]): PolicyIssue[] {
  const hit = new Set(verdicts.map((v) => v.verdict.matchedPolicyId).filter(Boolean));
  // 条件里用到网格之外的 fact（成本、失败次数…）的规则，本来就测不到，不报
  const gridFacts: FactKey[] = ['operationType', 'riskLevel', 'environment', 'dataSensitivity',
    'externalFacing', 'reversible', 'workItemType', 'projectType', 'autonomyLevel'];

  return policies
    .filter((p) => p.enabled && !hit.has(p.id))
    .filter((p) => requiredFacts(p.condition).every((f) => gridFacts.includes(f)))
    .slice(0, 3)
    .map((p) => ({
      type: 'unreachable' as const,
      severity: 'warning' as const,
      message: `「${p.name}」在任何常见场景下都不会命中，可能被更高优先级的规则完全覆盖`,
      params: { name: p.name },
      example: null,
      policyIds: [p.id],
    }));
}

/**
 * 覆盖缺口：高风险操作没有任何规则管，走的是默认策略。
 *
 * ★ 页面文档 §5.8 特别点名这一类。用户配了几条规则就以为安全了，
 *   而漏配的场景悄悄走默认 —— 出事时没人知道「原来这里根本没规则」。
 *
 * ★★ 两处刻意的克制，都是硬编码基线删掉之后才谈得上的：
 *
 *   1. 一条规则都没有时**不报**（`hasRules`）。零规则不是「配漏了」，
 *      是还没开始配 —— 对着一个空项目喊出九条「高风险操作没人管」，
 *      说的每一条都对，合起来却只是把「你还没配规则」说了九遍。
 *      空列表该由引导向导接手，不是由体检来吓人。
 *   2. `coverage_gap` 一律降到 info。它说的是「这里走的是默认策略」，
 *      而默认策略是自治等级的一部分、是用户自己选的，不是事故。
 *      真正的事故是 `too_permissive`：**有一条规则**明确把高风险操作
 *      放行了 —— 那条仍然是 critical。
 *
 *   Nothing is reported when the project has no rules at all: zero rules means
 *   "not configured yet", not "misconfigured", and nine criticals on an empty
 *   project is the same sentence nine times. `coverage_gap` drops to info
 *   because falling through to the autonomy default is a choice the user made;
 *   `too_permissive` — a rule that actively waves a high-risk operation
 *   through — stays critical.
 */
function findAutoPassedRisks(verdicts: Verdicts, hasRules: boolean): PolicyIssue[] {
  interface Hole {
    /** 被某条规则明确放行 */
    byPolicy: { name: string; id: string; example: string } | null;
    /** 没有规则命中，走默认策略且默认是放行 */
    byDefault: { example: string } | null;
    /** 没有规则命中，但默认拦住了 —— 只是治理不完整，不是事故 */
    uncoveredButGated: { example: string } | null;
  }

  const holes = new Map<string, Hole>();
  const get = (op: string) => {
    let h = holes.get(op);
    if (!h) holes.set(op, (h = { byPolicy: null, byDefault: null, uncoveredButGated: null }));
    return h;
  };

  for (const { scenario, verdict } of verdicts) {
    const op = scenario.context.operationType;
    if (!(HIGH_RISK_OPERATIONS as readonly string[]).includes(op)) continue;

    const auto = isAutoApprove(verdict.action);
    const matched = verdict.matchedPolicyId !== null;
    const example = describeScenario(scenario);

    // 安全底线硬编码挡住的三类，任何配置都放行不了，不必报
    if (auto && (NEVER_AUTO_APPROVE as readonly string[]).includes(op)) continue;

    if (auto && matched) {
      const h = get(op);
      h.byPolicy ??= { name: verdict.matchedPolicyName!, id: verdict.matchedPolicyId!, example };
    } else if (auto && !matched) {
      get(op).byDefault ??= { example };
    } else if (!matched) {
      get(op).uncoveredButGated ??= { example };
    }
  }

  const issues: PolicyIssue[] = [];
  for (const [op, hole] of holes) {
    const label = OPERATION_LABELS[op] ?? op;

    if (hole.byPolicy || hole.byDefault) {
      /**
       * ★ 一个操作只出一条。
       *   同一个「数据库结构变更」同时报「被某规则放行」和「没规则覆盖」，
       *   读起来像同一件事说了两遍 —— 用户会开始怀疑这个体检在凑数，
       *   而怀疑一旦开始，真正重要的那条也会被一起略过。
       *   两种成因写在一句里，各自的修法都还在。
       */
      const causes: string[] = [];
      if (hole.byPolicy) causes.push(`「${hole.byPolicy.name}」会放行它（${hole.byPolicy.example}）`);
      if (hole.byDefault) causes.push(`没有规则覆盖时默认放行（${hole.byDefault.example}）`);

      if (!hole.byPolicy && !hasRules) continue;

      issues.push({
        type: hole.byPolicy ? 'too_permissive' : 'coverage_gap',
        severity: hole.byPolicy ? 'critical' : 'info',
        message: `高风险操作「${label}」会被自动放行：${causes.join('；')}`,
        /**
         * ★ 操作类型送**枚举键**而不是那个中文 `label` —— 界面自己有
         *   `policy.operation.*` 那组词条。规则名是用户起的，原样带。
         */
        params: { operation: op, ...(hole.byPolicy ? { policy: hole.byPolicy.name } : {}) },
        example: null,
        policyIds: hole.byPolicy ? [hole.byPolicy.id] : [],
      });
      continue;
    }

    if (hole.uncoveredButGated && hasRules) {
      issues.push({
        type: 'coverage_gap',
        severity: 'info',
        message: `高风险操作「${label}」没有任何规则覆盖，走的是自治等级的默认策略`,
        params: { operation: op },
        example: hole.uncoveredButGated.example,
        policyIds: [],
      });
    }
  }

  return issues.slice(0, 5);
}

/** 全都要审批 —— 配到这一步，Agent 基本无法自主执行（§11） */
function findEverythingGated(verdicts: Verdicts): PolicyIssue[] {
  const auto = verdicts.filter((v) => isAutoApprove(v.verdict.action)).length;
  const share = verdicts.length === 0 ? 1 : auto / verdicts.length;
  if (share >= 0.15) return [];

  return [
    {
      type: 'everything_gated',
      severity: 'warning',
      message: `当前配置下只有 ${Math.round(share * 100)}% 的场景能自动执行，Agent 几乎无法自主工作`,
      params: { pct: Math.round(share * 100) },
      example: '检查是否有优先级很高、条件过宽的规则把所有场景都拦下了',
      policyIds: [],
    },
  ];
}

/**
 * 零命中：规则可能写错了，或者它针对的场景根本不存在。
 *
 * 两种情况不报：规则太新（还没机会命中），以及已经因为
 * 「数据源没接入」被报过 —— 那才是零命中的原因，说两遍等于凑数。
 */
function findZeroHit(policies: Policy[], hits: HitStats[], wiredFacts: FactKey[]): PolicyIssue[] {
  const MIN_AGE_DAYS = 7;
  const stats = new Map(hits.map((h) => [h.policyId, h]));
  const wired = new Set(wiredFacts);
  const explained = new Set(
    policies
      .filter((p) =>
        requiredFacts(p.condition).some((f) => FACT_SOURCES[f] !== undefined && !wired.has(f)),
      )
      .map((p) => p.id),
  );

  return policies
    .filter((p) => p.enabled && p.projectId !== null && !explained.has(p.id))
    .filter((p) => (stats.get(p.id)?.hits30d ?? 0) === 0)
    .filter((p) => (stats.get(p.id)?.ageDays ?? 0) >= MIN_AGE_DAYS)
    .slice(0, 3)
    .map((p) => ({
      type: 'zero_hit' as const,
      severity: 'info' as const,
      message: `「${p.name}」近 30 天一次都没命中 —— 可能条件写错了，也可能这个场景确实没发生`,
      params: { name: p.name },
      example: null,
      policyIds: [p.id],
    }));
}

/**
 * 条件引用了没接入的数据源。
 *
 * ★ 这类规则最危险的地方在于它「看起来是配好的」：列表里赫然写着
 *   「测试通过才自动批准」，而测试结果压根没接进来，条件永远匹配不上，
 *   于是这条规则从来没生效过 —— 但用户以为它在保护自己。
 */
function findMissingDataSources(policies: Policy[], wiredFacts: FactKey[]): PolicyIssue[] {
  const wired = new Set(wiredFacts);
  const issues: PolicyIssue[] = [];

  for (const p of policies) {
    if (!p.enabled) continue;
    const missing = [...new Set(requiredFacts(p.condition))].filter(
      (f) => FACT_SOURCES[f] !== undefined && !wired.has(f),
    );
    if (missing.length === 0) continue;

    issues.push({
      type: 'missing_data_source',
      severity: 'warning',
      message: `「${p.name}」依赖${missing.map((f) => FACT_SOURCES[f]).join('、')}，但这些数据源还没接入，该规则不会命中`,
      /**
       * ★ 缺的数据源送 **fact 键**，由界面拿自己的词条拼那个列表 ——
       *   中文用「、」连接，英文用「, 」并且最后一项前要有 "and"。
       *   在服务端拼好这个列表，等于把连接词也一并硬编成中文。
       */
      params: { name: p.name },
      facts: missing,
      example: null,
      policyIds: [p.id],
    });
  }

  return issues.slice(0, 3);
}

/** 某条规则在这个场景下会不会匹配 —— 单独判定，不走优先级 */
function matchesScenario(policy: Policy, scenario: Scenario): boolean {
  const [only] = compile([policy]);
  return only ? only.match(scenario.context).matched : false;
}

/**
 * 反例场景的结构形态 / The structured form of an example scenario.
 *
 * ★ 与 describeScenario() 一一对应，但给的是三个枚举键而不是拼好的中文。
 *   `操作 · 风险高 · 生产环境` 在英文里是 `Deploy · High risk · Production` ——
 *   词序一样，但每一段都要各自翻译，所以只能由界面来拼。
 */
export function scenarioShape(scenario: Scenario): ScenarioShape {
  const { operationType, riskLevel, environment } = scenario.context;
  return { operationType, riskLevel, environment: environment ?? null };
}

export function describeScenario(scenario: Scenario): string {
  const { operationType, riskLevel, environment } = scenario.context;
  const parts = [
    OPERATION_LABELS[operationType] ?? operationType,
    `风险${RISK_TEXT[riskLevel] ?? riskLevel}`,
  ];
  if (environment) parts.push(ENV_TEXT[environment] ?? environment);
  return parts.join(' · ');
}

function assigneeOf(action: Action): string | null {
  const text = explainAction(action);
  return text || null;
}

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 } as const;
function bySeverity(a: PolicyIssue, b: PolicyIssue): number {
  return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
}

/**
 * 切换自治等级的影响预览（§5.9）。
 *
 * 同一套规则、同一批场景，只换 autonomyLevel 再跑一遍。
 * 「切过去之后有哪几类操作不再找你」是个具体的清单，
 * 比「更自动化一些」这种描述有用得多。
 */
export function previewAutonomy(
  policies: Policy[],
  from: AutonomyLevel,
  to: AutonomyLevel,
): { becomesAuto: string[]; becomesGated: string[]; autoBefore: number; autoAfter: number } {
  const before = auditPolicies(policies, from).summary;
  const after = auditPolicies(policies, to).summary;

  const autoBeforeSet = new Set(before.auto.map((o) => o.operationType));
  const autoAfterSet = new Set(after.auto.map((o) => o.operationType));

  return {
    becomesAuto: after.auto.filter((o) => !autoBeforeSet.has(o.operationType)).map((o) => o.label),
    becomesGated: before.auto.filter((o) => !autoAfterSet.has(o.operationType)).map((o) => o.label),
    autoBefore: before.auto.length,
    autoAfter: after.auto.length,
  };
}
