# 05 Policy Engine

*[中文版本 / Chinese version](05-policy-engine.zh.md)*

One of the central claims of product doc 3.2: "Policy-driven, not approve-every-step." The Policy Engine decides what an Agent gets to do on its own and what has to go to a human.

It is where the entire governance story lands — **if the Policy Engine can't be trusted, users won't loosen automation; and without loosened automation the product is worth nothing.**

---

## 1. Three design constraints

| Constraint | Where it comes from | Consequence |
| --- | --- | --- |
| **Fast** | It sits on the critical path of every state transition | Rules compile into memory, evaluation touches no database, P99 < 10ms |
| **Simulatable** | Page doc 13 requires validating a rule against historical data | Rules must be pure functions; events must carry a context snapshot |
| **Explainable** | Page doc 13 requires a natural-language explanation; 11 requires showing which rule fired | Rules are a structured AST, not a code string; evaluation returns a full trace |

The third constraint rules out JS expressions and embedded scripts: you can't generate a trustworthy natural-language explanation from them, and you can't edit them visually in the UI.

---

## 2. Rule representation

### 2.1 Shape

```typescript
// packages/contracts/src/policy/rule.ts

interface Policy {
  id: string;
  orgId: string;
  projectId: string | null;      // null = organization-level
  name: string;
  description: string;
  priority: number;              // lower numbers evaluate first
  enabled: boolean;
  condition: Condition;
  action: Action;
}

type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { fact: FactKey; op: Operator; value: FactValue };

type Operator =
  | 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'
  | 'in' | 'not_in' | 'contains' | 'matches';

type Action =
  | { type: 'allow' }
  | { type: 'allow_and_notify'; notify: Recipient[] }
  | { type: 'require_agent_review'; agents: string[] }
  | { type: 'require_human_review'; assignee: Recipient; dueInHours: number }
  | { type: 'require_multiple_approvals'; approvers: Recipient[]; mode: 'all' | 'majority' }
  | { type: 'ask'; assignee: Recipient }          // advisory, does not block
  | { type: 'pause'; resumeCondition?: string }
  | { type: 'deny'; message: string }
  | { type: 'escalate'; to: Recipient }
  | { type: 'transfer_to_human'; assignee: Recipient };

type Recipient =
  | { kind: 'role'; role: string }               // 'dba' | 'tech_lead' | 'sponsor'
  | { kind: 'user'; userId: string }
  | { kind: 'project_role'; role: 'pm' | 'tech_lead' | 'sponsor' }
  | { kind: 'owner_of'; subject: 'work_item' | 'agent' };
```

**Roles, not named individuals**: the responsibility map in product doc 8.7.5 is defined by role (database change → DBA). When people move around, the rules don't have to be rewritten.

### 2.2 Example: the three rules from product doc 8.9.3

The rule names below are sample user-authored data and stay in Chinese: "auto-approve low-risk tasks", "production database changes must be approved by a DBA", and "hand off to a human after three consecutive Agent failures".

```json
[
  {
    "name": "低风险任务自动批准",
    "priority": 100,
    "condition": {
      "all": [
        { "fact": "riskLevel",     "op": "eq", "value": "low" },
        { "fact": "testsResult",   "op": "eq", "value": "passed" },
        { "fact": "agentReview",   "op": "eq", "value": "passed" },
        { "fact": "runCost",       "op": "lt", "value": 10 }
      ]
    },
    "action": {
      "type": "allow_and_notify",
      "notify": [{ "kind": "project_role", "role": "pm" }]
    }
  },
  {
    "name": "生产数据库变更必须由 DBA 审批",
    "priority": 1,
    "condition": {
      "all": [
        { "fact": "environment",   "op": "eq", "value": "production" },
        { "fact": "operationType", "op": "in", "value": ["db_ddl", "db_dml"] }
      ]
    },
    "action": {
      "type": "require_human_review",
      "assignee": { "kind": "role", "role": "dba" },
      "dueInHours": 4
    }
  },
  {
    "name": "Agent 连续失败 3 次转人工",
    "priority": 20,
    "condition": { "fact": "consecutiveFailures", "op": "gte", "value": 3 },
    "action": {
      "type": "pause",
      "resumeCondition": "human_decision"
    }
  }
]
```

### 2.3 Fact list

**This list is what the event snapshot is designed against** ([03 Event model](03-event-model.md) §4). Adding a fact later means no history from before that point can be simulated against it, so the first version should cover as much ground as it can.

These correspond to the sixteen categories of condition listed in product doc 8.9.1:

| Fact | Type | Source |
| --- | --- | --- |
| `projectType` | string | project.type |
| `workItemType` | enum | work_item.type |
| `riskLevel` | enum | work_item.risk_level |
| `reversible` | boolean | Operation metadata |
| `externalFacing` | boolean | Whether external customers are affected |
| `environment` | enum | Target environment of the operation |
| `dataSensitivity` | enum | Classification of the data involved |
| `impactScope.tasks` | number | Number of downstream tasks affected |
| `impactScope.services` | string[] | Services involved |
| `operationType` | string | db_ddl / deploy / delete_resource / send_external / payment / … |
| `agentType` | string | agent.type |
| `agentConfidence` | number | Confidence reported by the Agent |
| `agentSuccessRate` | number | agent.stats |
| `consecutiveFailures` | number | Consecutive failures on this work item |
| `runCost` | number | Cost of this run |
| `projectCostSpent` | number | Cumulative project cost |
| `projectBudget` | number\|null | Project budget |
| `budgetUsedPct` | number | Derived: spent / budget |
| `testsResult` | enum | passed / failed / not_run |
| `testCoverage` | number\|null | Reported by CI |
| `securityScan` | enum | passed / failed / not_run |
| `agentReview` | enum | passed / concerns / failed / not_run |
| `autonomyLevel` | enum | project.autonomy_level |

**Derived facts** (such as `budgetUsedPct`) are computed while the context is built rather than left for the rule author to work out — fewer chances to get it wrong.

---

## 3. Evaluation

### 3.1 Algorithm

```typescript
function evaluate(ctx: PolicyContext, rules: CompiledRule[]): PolicyVerdict {
  const trace: TraceEntry[] = [];

  for (const rule of rules) {          // already sorted by ascending priority
    const matched = matchCondition(rule.condition, ctx);
    trace.push({
      policyId: rule.id,
      name: rule.name,
      matched,
      // on a miss, record which sub-condition failed so the UI can show "why this one didn't fire"
      failedAt: matched ? null : firstFailingLeaf(rule.condition, ctx),
    });

    if (matched) {
      return {
        action: rule.action,
        matchedPolicyId: rule.id,
        trace,                          // includes every rule evaluated so far
        contextSnapshot: ctx,           // ★ written into the event, for later simulation
      };
    }
  }

  return { action: defaultAction(ctx), matchedPolicyId: null, trace, contextSnapshot: ctx };
}
```

**First match wins, and evaluation stops there.** This is the semantic users most often misread, which is why page doc 13 §5.7 requires the simulation view to show the whole matching sequence — so the user can see "a higher-priority rule caught it first."

**At equal priority, the stricter rule goes first.** First-match-wins means that when two rules share a priority and both match the same context, whichever comes first decides. Leave the order undefined and that "whichever" is whatever order the database happened to return the rows in — the same configuration can produce opposite verdicts on two machines, and that is a problem you will almost never reproduce. Ties break toward the stricter rule: a tie means the user never said which one matters more, and in governance configuration, taking the safe side when nobody has said is the only defensible default.

### 3.2 Default action

When no rule matches, the project's autonomy level decides (product doc 8.9.4):

```typescript
function defaultAction(ctx: PolicyContext): Action {
  switch (ctx.autonomyLevel) {
    case 'human_led':
      return { type: 'require_human_review',
               assignee: { kind: 'project_role', role: 'pm' }, dueInHours: 8 };
    case 'agent_led_approval':
      return ctx.riskLevel === 'low' || ctx.riskLevel === 'medium'
        ? { type: 'allow' }
        : { type: 'require_human_review',
            assignee: { kind: 'project_role', role: 'tech_lead' }, dueInHours: 4 };
    case 'agent_autonomous':
      return { type: 'allow' };
  }
}
```

**The safety floor**: whatever the autonomy level, and whatever the project's rules say, these three classes of operation never come back `allow`:

Deleting resources · Changing permissions · Executing payments

They are **hard-coded in the evaluator** (`NEVER_AUTO_APPROVE`, `enforceSafetyFloor`), not a rule that can be deleted or rewritten — a floor that configuration can get around is not a floor. The other six high-risk operation classes in product doc 10.4 are left to rules the user writes; when none have been written, the health check says so plainly — this class of operation is currently running on the autonomy-level default (`coverage_gap`).

> **They used to be ten hard-coded organization-level baseline rules** (`BASELINE_POLICIES`) that took part in evaluation whether or not the database held any rules at all. They weren't removed because they governed the wrong things; they were removed because they made "so which rules is this project actually running under?" unanswerable in the UI: the rule list the user could see was not the set that actually ran. Now **the effective rule set is exactly what the user entered into the database — none entered means zero rules**; the three that genuinely aren't negotiable are caught by the evaluator itself.

**A fact value that can't be read is rejected outright.** `operationType` / `environment` / `dataSensitivity` are parsed one by one against their enums as they come out of the work item's `typeData`; anything unrecognized throws instead of falling back to an approximation. Here is what guessing toward the permissive side costs: `"delete_resrouce"` (one letter off) travels into the context intact, `NEVER_AUTO_APPROVE` doesn't recognize it, and one typo has bypassed the entire safety floor — with no sign of it at the scene, the task finishing normally, and not a single rule having matched. The planning output side uses the same strict enums, and rejects at the parse step — which is exactly where a retry or a clarification is still possible.

### 3.3 Compilation and caching

```typescript
class PolicyCache {
  private compiled = new Map<string, CompiledRule[]>();   // key: `${orgId}:${projectId}`

  get(orgId: string, projectId: string): CompiledRule[] {
    const key = `${orgId}:${projectId}`;
    let rules = this.compiled.get(key);
    if (!rules) {
      rules = this.compile(orgId, projectId);
      this.compiled.set(key, rules);
    }
    return rules;
  }

  private compile(orgId: string, projectId: string): CompiledRule[] {
    const org = loadOrgPolicies(orgId);        // organization-level
    const proj = loadProjectPolicies(projectId);
    return [...org, ...proj]
      .filter(p => p.enabled)
      .sort((a, b) => a.priority - b.priority)
      .map(p => ({ ...p, condition: compileCondition(p.condition) }));
      // compileCondition turns the AST into closures, so evaluation never walks JSON
  }

  // On a rule change, broadcast invalidation over Redis Pub/Sub so every instance stays in sync
  invalidate(orgId: string, projectId?: string) { /* ... */ }
}
```

**Consistency of cache invalidation**: a rule change takes a few hundred milliseconds to reach every instance. Page doc 13 §7 requires that the time it takes effect be stated explicitly, and that **an in-flight Run keep the rule snapshot it started with** — so a rule that changes mid-task can't make one task behave two different ways.

---

## 4. Organization-level and project-level inheritance

An implicit requirement of the product doc (chapter 10, permissions and security): no single project may get around the enterprise's governance floor.

### 4.1 Rules

| Rule | Implementation |
| --- | --- |
| Organization rules evaluate first | Priority bands: organization 1–99, project 100+ |
| A project can't delete an organization rule | Enforced in both the UI and the API |
| A project **can only tighten, never loosen** | See §4.2 |

The project band (100+) is split again into two slots:

| Band | Who occupies it | How it's assigned |
| --- | --- | --- |
| 100 | The operation toggle matrix (at most one per operation type) | Fixed |
| 101+ | Hand-written rules | Appended by the server (`nextAuthoredPriority`) |

Toggles sit **ahead of** hand-written rules: a toggle is what the user just said out loud, and having it silently overridden by a rule someone wrote six months ago is the hardest class of problem to track down. Nothing conflicts inside the slot — each toggle locks exactly one `operationType`, so two of them can never match at once.

Priority no longer appears in the editing UI. Filling it in correctly requires holding three things in your head at once — "lower goes first", "first match wins", "organization rules already own the front of the range" — and getting it wrong shows up as a rule quietly not taking effect. An input box that doesn't complain when you get it wrong, and doesn't show you that you did, buys you one bout of confusion, not one act of configuration. Anyone who really does want to order rules by hand can still do it under "Advanced" in the editor.

### 4.2 How "tighten only" is enforced

Strict formal verification — proving that for any context a project rule is never more permissive than an organization rule — is computationally infeasible. In practice there are two layers of protection:

**Layer one (runtime, a hard guarantee)**: organization rules evaluate first and stop on match. So if an organization rule says "production DDL needs DBA approval", no project rule, however it is written, can let that scenario through automatically — evaluation never reaches the project rules.

**Layer two (save time, a static check)**: when a project rule is saved, run a limited static analysis:

```typescript
function checkPermissiveness(draft: Policy, orgRules: Policy[]): Warning[] {
  // find organization rules whose condition overlaps this draft's and whose action is stricter
  const overlapping = orgRules.filter(o =>
    conditionsMayOverlap(o.condition, draft.condition) &&
    strictness(o.action) > strictness(draft.action)
  );

  return overlapping.map(o => ({
    level: 'info',
    // "Organization rule «name» is stricter in some scenarios; those will be handled by it,
    //  and this rule will not fire"
    message: `组织规则「${o.name}」在部分场景下更严格，那些场景将由它处理，此规则不会生效`,
    orgPolicyId: o.id,
  }));
}
```

`conditionsMayOverlap` uses a coarse interval/enum-set intersection test — better a false positive (flagging a pair that doesn't actually overlap) than a miss.

This doesn't refuse the save; it's a heads-up. **The runtime guarantee is already hard**; the static check exists to help the user understand why their rule isn't firing.

---

## 5. Simulation: the most important feature in this module

Page doc 13 §5.7 calls simulation "the thing that makes users willing to configure Policy at all."

### 5.1 How it works

```
Pull every historical policy.evaluated event (with its context_snapshot) out of the events table
      ↓
Re-evaluate each snapshot against the draft rule
      ↓
Compare against what actually happened at the time
      ↓
Report: how many cases it would handle automatically / how many of those the human judged differently
```

```typescript
async function simulate(draft: Policy, projectId: string, range: string): Promise<SimResult> {
  // only evaluation events that carry a complete snapshot
  const samples = await db.query`
    SELECT e.id, e.context_snapshot, e.payload,
           d.status AS human_decision, d.resolved_at, d.resolution_note
    FROM events e
    LEFT JOIN decisions d ON d.id = (e.payload->>'decision_id')::uuid
    WHERE e.project_id = ${projectId}
      AND e.type = 'policy.evaluated'
      AND e.occurred_at > now() - ${range}::interval
      AND e.context_snapshot IS NOT NULL
  `;

  const applicable: Sample[] = [];
  const mismatches: Mismatch[] = [];

  for (const s of samples) {
    // check that every fact the draft rule references is present in the snapshot
    const missing = requiredFacts(draft.condition)
      .filter(f => !(f in s.context_snapshot));
    if (missing.length) continue;                 // skip it, and count it in the result

    if (!matchCondition(draft.condition, s.context_snapshot)) continue;
    applicable.push(s);

    // the comparison that matters: the draft would auto-approve, but the human rejected it
    const draftAutoApproves = isAutoApprove(draft.action);
    const humanRejected = s.human_decision === 'rejected'
                       || s.human_decision === 'revision_requested';

    if (draftAutoApproves && humanRejected) {
      mismatches.push({
        eventId: s.id,
        context: s.context_snapshot,
        humanDecision: s.human_decision,
        humanNote: s.resolution_note,
        workItemTitle: s.payload.work_item_title,
      });
    }
  }

  return {
    totalSamples: samples.length,
    skippedForMissingFacts: samples.length - evaluated,
    wouldAutoHandle: applicable.length,
    mismatches,
    suggestions: deriveSuggestions(mismatches),   // §5.2
    confidence: computeConfidence(samples.length, range),
  };
}
```

### 5.2 Deriving suggested extra conditions from the disagreements

The effect shown in page doc 13 §4.2:

```
⚠ In 2 of them the human chose "Reject" at the time:
   · 08-02 Reword payment copy (human: needs legal sign-off)
   · 07-28 Remove deprecated endpoint (human: external callers affected)
→ Suggested: add the conditions "does not touch external interfaces" and "is not payment-related"
```

The derivation: find the fact whose **value distribution differs most** between the disagreeing samples and the agreeing ones.

```typescript
function deriveSuggestions(mismatches: Mismatch[], matched: Sample[]): Suggestion[] {
  const suggestions: Suggestion[] = [];

  for (const fact of ALL_FACTS) {
    const mismatchValues = mismatches.map(m => m.context[fact]);
    const okValues = matched.map(s => s.context[fact]);

    // this fact clusters hard on one value among the disagreements, and is rare at it among the rest
    const dominant = mode(mismatchValues);
    const concentration = count(mismatchValues, dominant) / mismatchValues.length;
    const baseRate = count(okValues, dominant) / Math.max(okValues.length, 1);

    if (concentration >= 0.8 && baseRate < 0.2) {
      suggestions.push({
        addCondition: { fact, op: 'ne', value: dominant },
        // "the {fact label} of N disagreeing cases was «dominant» in every one"
        rationale: `${count(mismatchValues, dominant)} 个不一致案例的 ${factLabel(fact)} 都是「${dominant}」`,
        wouldEliminate: count(mismatchValues, dominant),
      });
    }
  }
  return suggestions.sort((a, b) => b.wouldEliminate - a.wouldEliminate);
}
```

This is a **statistical heuristic, not causal inference**. So a suggestion has to be labeled "a pattern across N cases — please confirm it makes sense" and must never be applied automatically.

### 5.3 Simulation has to be honest

Simulation must state its limits, or users will over-trust it:

| Situation | What it says |
| --- | --- |
| Fewer than 20 samples | "Small sample (N=12); treat the result as indicative only" |
| Some samples missing a fact | "N historical samples lack data this condition needs and were left out of the simulation" |
| References a newly added fact | "The condition 'Agent confidence' only has data from 2026-08-06 onward; earlier samples can't be simulated" |
| No disagreements, but few samples | Don't say "zero risk"; say "no disagreements found within a limited sample" |

**A loosening change is required to have been simulated**: the API layer validates that `PATCH /api/policies/{id}` carries a valid `simulation_id` when direction=loosen ([02 Domain model](02-domain-model.md), `policy_versions.simulation_id`).

---

## 6. Natural-language explanation

Page doc 13 §5.6 requires a plain-language explanation generated live while a rule is being edited.

**It has to be template assembly, not an LLM.** The reason: the explanation and the logic that actually executes must agree exactly. LLM output drifts, and that drift leads users to misconfigure rules — drift in a governance feature is not acceptable.

```typescript
function explain(policy: Policy): string {
  const cond = explainCondition(policy.condition);
  const act = explainAction(policy.action);
  return `当${cond}时，${act}。`;
}

function explainCondition(c: Condition): string {
  if ('all' in c) return c.all.map(explainCondition).join('且');
  if ('any' in c) return c.any.map(explainCondition).join('或');
  if ('not' in c) return `不满足（${explainCondition(c.not)}）`;

  const label = FACT_LABELS[c.fact];          // "风险等级" (risk level)
  const value = formatValue(c.fact, c.value); // "低" (low)
  const op = OP_PHRASES[c.op];                // { eq: '是', lt: '低于', ... }
  return `${label}${op}${value}`;
}
```

What it generates for the example rule:

> 当风险等级是低、且自动测试结果是通过、且 Review Agent 结论是通过、且本次执行成本低于 $10 时，系统会自动批准并在飞书通知项目负责人。你不需要手动审批。
>
> (In English: when the risk level is low, the automated tests passed, the Review Agent signed off, and this run costs less than $10, the system approves automatically and notifies the project owner on Feishu. You don't have to approve anything by hand.)

**Template coverage is where most of the implementation cost goes**: 23 facts × 8 operators × 10 actions. That calls for a structured phrase table, not a template written per combination.

---

## 7. Cost guardrails

The product doc raises cost control in several places (the "maximum run cost per project" under WIP in 8.6.3; model cost and cumulative budget in 8.9.1). Cost is checked in two places:

### 7.1 Before dispatch (prevention)

```typescript
// before the scheduler dispatches an Agent Run
const projected = project.costSpent + estimatedRunCost;
if (project.budgetAmount && projected > project.budgetAmount) {
  return createDecision('budget_overrun', {
    assignee: { kind: 'project_role', role: 'sponsor' },   // 8.7.5: budget overrun → Sponsor
    // "will exceed the budget by $X"
    consequence: `将超出预算 $${(projected - project.budgetAmount).toFixed(2)}`,
  });
}
```

### 7.2 During execution (interruption)

An Agent Run's cost accrues in real time; when it reaches a threshold, Policy decides what happens:

```
Cost hits 80% of the per-Run ceiling   → event + on-page warning
Cost hits 100% of the per-Run ceiling  → whatever agent.cost_limit is configured to do:
                                          pause_and_ask (default) / terminate / allow_overrun
Cumulative project cost hits 100% of budget → stop scheduling new tasks
                                              (running ones finish, so nothing is left half-built)
```

**Letting in-flight Runs finish is a deliberate choice**: killing a Run twenty minutes in, with code half-rewritten, leaves a mess that costs more to clean up than the few extra dollars.

---

## 8. Relationship to Agent permissions

The two are easy to confuse:

| | Agent permissions ([09 Security](09-security.md)) | Policy |
| --- | --- | --- |
| Answers | **Can** the Agent do it (capability boundary) | **Does** doing it need a human's approval (governance judgment) |
| What a violation does | The tool call is refused outright | A decision is created and waits for a person |
| Configured in | Agent Workspace | The Policy configuration page |
| When it applies | At tool-call time | At state-transition time |

For example:
- The Agent has no `merge_pr` tool permission → it simply cannot merge code. That is **permissions**.
- The Agent has `deploy` permission, but deploying to production needs approval → that is **Policy**.

**You need both.** Permissions without Policy leaves an Agent either wholly blocked or wholly free; Policy without permissions leaves an Agent able to reach the same effect down some unanticipated path, governance never consulted.

---

## 9. Testing strategy

| Level | What it covers |
| --- | --- |
| Unit | Condition AST evaluation: every operator, nested combinations, type mismatches |
| Unit | Priority ordering and first-match-wins semantics |
| Unit | Default action under each of the three autonomy levels |
| Unit | Natural-language explanation: snapshot tests covering every fact × operator combination |
| Integration | Organization rules can't be bypassed by project rules (construct project rules that try, assert they're still caught) |
| Integration | Cache invalidation: a rule change takes effect on every instance within N milliseconds |
| Integration | Simulation: construct known historical events, assert the simulation result |
| Performance | P99 latency for 100 rules × 10,000 evaluations |

**The safety-floor test** (the most important one):

```typescript
// For the three NEVER_AUTO_APPROVE operation classes, enumerate every autonomy level crossed with
// adversarial project rule sets, and assert allow never comes back — the floor lives in the
// evaluator and does not depend on whether the database holds any rules
for (const op of NEVER_AUTO_APPROVE) {
  for (const autonomy of ALL_AUTONOMY_LEVELS) {
    for (const projectRules of ADVERSARIAL_RULE_SETS) {
      const verdict = evaluate(contextFor(op, autonomy), compile(projectRules));
      expect(verdict.action.type).not.toBe('allow');
    }
  }
}
```

Alongside it, assert that **a misspelled value doesn't get past it either**: with `typeData.operationType` written as `"delete_resrouce"`, evaluation must stop and raise, not treat it as `code_change` and wave it through. These two tests are a pair — without the second, the first only proves "it holds when the value is spelled right."

---

## 10. Narrowing the MVP scope

Product doc 12.2 asks only four kinds of configuration of the basic Policy Engine:

- which tasks run automatically
- which tasks need approval
- how many failures before asking for a human
- which environments always require approval

**Proposed MVP:**

| Do | Don't |
| --- | --- |
| The full condition AST and evaluator (internal) | A free-form condition editor (UI) |
| **A templated configuration UI** (pick a scenario → fill in a few parameters) | An advanced expression mode |
| **Simulation replay** (highest priority) | Suggestion derivation (§5.2 can wait) |
| Natural-language explanation | — |
| Organization/project inheritance and priority | Sophisticated static conflict detection |
| Cost guardrails | — |

**Why**: simulation matters more than flexibility. An editor that lets a user freely combine 23 facts but offers no way to check the result is more dangerous than six templates that have been validated. Flexibility can be added later; trust, once lost, is hard to win back.

A template, for example:

```
Scenario: auto-approve low-risk tasks
  Risk level at most  [Low ▾]
  Must pass           [☑ Automated tests] [☑ Agent Review] [☐ Security scan]
  Cost ceiling        [$10]
  Once it passes      [☑ Notify the project owner]
                                              [Simulate] [Enable]
```

---

## 11. Open questions

1. **The fact list has to be locked down before the event snapshot is implemented.** A fact added later doesn't exist in the history that came before it, and simulation gets a gap there. Recommend a dedicated review of this list before implementation starts.
2. **Comparability of `agentConfidence`**: different Agent runtimes define confidence differently, so feeding it straight into a rule condition may be unreliable. Do we need a per-Agent calibration mapping? Or leave it out of the fact list for the MVP? Leaning toward keeping the field but not exposing it in the templates.
3. **A cap on rule count**: currently imagined at 30 or fewer. Beyond that, first-match-wins makes the relationships between rules hard to hold in your head. Do we need rule groups, or a decision-table form?
4. **Missing facts in simulation**: today the sample is skipped. If a fact a rule references is missing from 80% of samples, the simulation is close to meaningless. Should we refuse to show a result at all in that case, rather than hand over a conclusion drawn from the remaining 20%? Leaning toward refusing.
5. **Policy and Agent suggestions**: product doc 8.7.1 mentions "the Agent suggests automating a repeated decision." Who generates that suggestion — Analytics' statistical detection (deterministic) or an LLM (flexible)? Leaning toward statistical detection, for the same reason as §6: governance features don't get to introduce nondeterminism.
6. **The rule snapshot for an in-flight Run**: the granularity needs settling — the whole compiled rule set, or just the policy version numbers? The former is large but absolutely reliable; the latter requires guaranteeing that rule versions are never physically deleted. Leaning toward version numbers plus soft deletes on the rules table.
