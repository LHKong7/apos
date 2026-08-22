# 13 Policy Configuration

*[中文版本 / Chinese version](13-policy-config.zh.md)*

## 1. Page Facts

| Item | Value |
| --- | --- |
| Route | `/projects/:projectId/settings/policies` (project level)<br>`/admin/policies` (org level) |
| Level | Third-level / second-level page |
| Primary roles | `tech_lead` / `pm` / `org_admin` |
| Priority | P0 (the MVP baseline, product doc 12.2) |
| Related product docs | 8.9 Policy & Governance Engine, 6.10 Policy, 8.9.4 Autonomy levels, ch. 10 Permissions and security |

---

## 2. Goal

Let a human **define the boundaries of Agent autonomy** and be confident those rules will actually behave the way they expect.

The page has to answer:

1. Which rules govern this project right now?
2. How will one specific action be handled — run automatically, or come to me?
3. What changes if I edit a rule?
4. Are there holes or conflicts in the rules?

**The core design problem**: a Policy engine is a rule engine underneath, which makes it very easy to end up with a configuration screen only engineers can read. But the people who actually need to set these boundaries are usually project leads and business owners. **So this page has to let someone configure it safely without knowing the rule syntax.**

The answer: templates + natural-language descriptions + simulation.

**The second-layer problem (solved this round)**: "how a given action will be handled" is visible — it's the summary at the top — but **not editable**. Editing happens further down in the rule list, in a completely different shape: conditions, actions, priorities. Every single time, the user has to perform a translation, turning "I want the Agent to handle deploys on its own" into a rule, then scroll back up after saving to check whether the translation came out right. The line you can see and the line you can change are not the same line.

The answer: **make the summary the switch**. One row per action type, a toggle on the right, and the row you click is the row that changes. Behind it the server generates the smallest rule that says so, with every save gate still in place — simulation, no loosening of org rules, an audit entry. That one layer of translation, the one that disappears conceptually, is this page's single largest cost.

---

## 3. Entrances and Exits

**Entrances**: project settings; "Create a rule" after a decision; automation suggestions in Analytics; "Adjust these rules" on the plan approval page; the failure-policy link in the Agent Workspace.

**Exits**:

| Action | Destination |
| --- | --- |
| "View hits" | Decision list / Run list (pre-filtered to that Policy) |
| "Test" | Simulation results, inline |
| A conflicting rule | This page (scrolled to the conflicting rule) |
| Autonomy level explainer | Project settings |

---

## 4. Page Structure

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ Order System Rebuild / Settings / Policy           Autonomy level [Agent-led + Approval ▾] │
│ [Custom exceptions] [Simulate]                                                             │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ ℹ Right now: 8 action types automatic, 3 need a human, 1 depends                [Collapse] │
│ ┌── Click a row to change that row. Each toggle adds one rule; yours stay untouched ─────┐ │
│ │ Read code and docs                                          [Auto] [Human]             │ │
│ │ Modify code                                                 [Auto] [Human]             │ │
│ │ Database schema change    Needs a human                     [Auto] [Human] [Clear]     │ │
│ │ Deploy / release          Human required in production    ~ [Auto] [Human]             │ │
│ │ Delete resources          Needs a human                     [Auto] [Human]             │ │
│ │ …                                                                                      │ │
│ └────────────────────────────────────────────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ ⚠ 2 problems detected                                                               [View] │ ← collapsed by default
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ [New from template: auto-approve low-risk] [Scoped envs need approval] [Cost gate] …       │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ Project rules (4)                                                                          │
│ ┌────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ Database schema change: needs a human                                        ● Enabled │ │
│ │ When action type = database schema change, then require a human → role Tech Lead       │ │
│ │ 5 hits in the last 30 days                         [Edit] [Disable] [Delete] [History] │ │
│ ├────────────────────────────────────────────────────────────────────────────────────────┤ │
│ │ Auto-approve low-risk tasks                                                  ● Enabled │ │
│ │ When risk level = low and per-run cost < 10, then allow and notify → project lead      │ │
│ │ 🟡 "Auto-approve low-risk tasks" no hits in 30 days — conditions may be wrong          │ │ ← health findings sit on the rule
│ │ 0 hits in the last 30 days                         [Edit] [Disable] [Delete] [History] │ │
│ └────────────────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

Three things differ from the earlier design, and all three are subtractions:

| What disappeared | Why |
| --- | --- |
| The priority column and the priority input | Filling it in correctly means holding "lower numbers go first," "matching stops at the first hit," and "org rules already occupy the front of the range" in your head at once — and filling it in wrong shows up as a rule that quietly never fires. The server appends new rules at the end; "Advanced" still exposes the number |
| The "org level / project level" split and the ⛓ badge | The platform no longer ships hard-coded baselines, and org rules have no creation entrance yet — not a single row in this list is one, so tagging every row "project" tags nothing |
| The health checklist at the top and its "jump to rule" button | A finding that points at a rule now sits on that rule, so seeing it and fixing it are the same place; the few findings with no rule to point at moved into a section collapsed by default. The first screen should answer "what can the Agent do right now," not open with a list of problems |

**When a project has no rules at all**, the entire rule list is replaced by an onboarding wizard (§5.12).

### 4.2 Rule Editor

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ Edit rule #7                                                           [Simple ⇄ Advanced] │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ Rule name    [Auto-approve low-risk tasks                              ]                   │
│ Description  [Low-risk tasks that pass tests and stay cheap need no approval]              │
│ Priority     [10]   ℹ Lower numbers match first; matching stops at the first hit           │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ When all of the following are true (all ▾)                                                 │
│ ┌────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ [Risk level ▾]        [= ▾]  [Low ▾]                                                 ✕ │ │
│ │ [Automated tests ▾]   [= ▾]  [Passed ▾]                                              ✕ │ │
│ │ [Review Agent ▾]      [= ▾]  [Passed ▾]                                              ✕ │ │
│ │ [Cost per task ▾]     [< ▾]  [$10        ]                                           ✕ │ │
│ │ [+ Add condition]                                                                      │ │
│ └────────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                            │
│ Then do                                                                                    │
│ ┌────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ Action  [Allow and Notify ▾]                                                           │ │
│ │ Notify  [Project lead ▾]  Channel [Feishu ▾]                                           │ │
│ │ ☐ Write to the audit log (forced on for high-risk actions)                             │ │
│ └────────────────────────────────────────────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ 📝 What this rule means                                                                    │
│ ┌────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ When a low-risk task passes both its automated tests and the Review Agent,             │ │
│ │ and the run costs less than $10, the system approves it automatically and              │ │
│ │ notifies the project lead on Feishu. You never approve it by hand.                     │ │
│ └────────────────────────────────────────────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ 🧪 Validate against historical data                                       [Run simulation] │
│ ┌────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ Over the last 30 days, this rule would:                                                │ │
│ │  ✓ Handle 47 automatically (90% of the 52 that need a human today)                     │ │
│ │  ⚠ 2 of those the human actually rejected:                                             │ │
│ │     · 08-02 Edit payment copy (human wanted legal sign-off)      [View]                │ │
│ │     · 07-28 Delete a deprecated endpoint (external callers)      [View]                │ │
│ │  → Suggested: add "no public-facing API" and "nothing payment-related"                 │ │
│ │                                                [Accept suggestion] [I accept the risk] │ │
│ └────────────────────────────────────────────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                      [Cancel]  [Save draft]  [Enable rule] │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Region Details

### 5.1 The Action Switch Matrix (the first screen)

**"8 action types run automatically, 3 need a human"** is a pile of rules boiled down to one sentence a user can read; expanded, it becomes an **actionable** table with one row per action type:

```
Read code and docs                                    [Auto] [Human]
Database schema change     Needs a human              [Auto] [Human] [Clear]
Deploy / release           Human required in prod   ~ [Auto] [Human]
```

It shares its computation with the "happens automatically once you approve" block on `04 Plan Approval` (domain's `auditPolicies`), which is what guarantees the two pages are describing the same thing.

**Of the three states, only two are clickable.** "Depends" is a state the system **reports** — say, "a human is required in production" — not an option the user picks. Behind it is a rule with narrower conditions: something you can describe but not select. Making it a third clickable button would let the user choose a promise the system cannot keep.

**One toggle = one rule, not a merge.** The tempting move is to rewrite the existing rules along with it, so the row lands "cleanly" in the state the user asked for. We don't. A rule the user wrote by hand is an intent they expressed, and one click should not silently rewrite it. The switch only prepends a rule — or edits the one it prepended last time — and leaves existing rules untouched. That way "delete this rule and you're back where you started" always holds, and that is the precondition for trusting a one-click control at all.

Toggling the same row again **edits that one rule** rather than stacking another on top. Stacking would leave "deploy → auto → human → auto" as three rules, with the user unable to tell which one to delete or which one is still in force.

**Which also means a toggle may not take effect.** An existing rule or a safety floor can still stand in front of it. So after saving, the health check has to run again and report honestly what state the row is actually in, naming the cause:

| Cause | What we say | What the user can do |
| --- | --- | --- |
| Shadowed by another rule | "These rules still come first: …" | Go edit or delete them |
| The safety floor forbids it | "Deleting resources, changing permissions, and executing payments always need a human" | Nothing at all; stop trying |
| Set by the autonomy level | "Change the autonomy level at the top, or narrow the conditions" | Use a different entrance |

Answering "Saved" and stopping there leaves the user believing they opened something up when they didn't — and that particular misunderstanding only surfaces once something has already gone wrong.

### 5.2 Org level vs project level (inheritance)

| Level | Source | Editable? |
| --- | --- | --- |
| Org level | No creation entrance yet (evaluation still honors them) | Cannot be deleted or loosened inside a project — **only tightened** |
| Project level | This page | Fully editable |

**Tighten-only, never loosen** is a hard constraint — it is what keeps a single project from routing around the enterprise governance floor (product doc ch. 10, Permissions and security). The test is the **outcome**, not which of two rules reads stricter: replay the scenarios one by one and see whether any scenario the org rule used to block now sails straight through. There is no way around it, because the outcome is exactly what ends up in force.

When someone tries to loosen, say so plainly: "The org rule 'Production database changes must be approved by a DBA' requires a human on this class of action, and a project rule cannot loosen it. Conflicting scenarios: …"

> **The platform no longer ships hard-coded org baseline rules** ([09 Security](../../tech/09-security.md) §4.1). The rules in force are the ones users entered into the database; none entered means zero in force. The three that genuinely are non-negotiable — delete resources, change permissions, execute payments — are hard-coded into the evaluator. So this page now draws project rules only: no row in the list is an org rule, and with that the "org level / project level" split and the ⛓ badge went away too.

### 5.3 Rule list

Every rule shows its enabled state, its name, **its conditions and action in plain language**, hit statistics, and **whichever health findings point at it**.

**Priority is not on this line.** Reading it requires understanding "lower numbers go first," "matching stops at the first hit," and "org rules occupy the front of the range" all at once, and this line is not the place to teach those three things. New rules are appended at the end by the server; anyone who genuinely needs to reorder them by hand can do it in the editor's "Advanced" pane.

**Hit statistics are the underrated feature on this page**:
- 0 hits → the rule may be wrong, or the scenario never occurs; prompt to check
- Frequent hits that always end the same way → suggest automating one step further
- A long average wait → this rule is a Flow bottleneck (echoes `12 Analytics`)

Disabled rules are kept, along with who disabled them and why — the change history of a rule is organizational knowledge in its own right.

### 5.4 Conditions (product doc 8.9.1)

All sixteen condition types listed in the product doc are supported:

| Category | Conditions |
| --- | --- |
| Object attributes | Project type, Work Item type, risk level, reversibility, whether external customers are involved |
| Data and environment | Data sensitivity, operating environment, blast radius |
| Agent | Agent type, Agent confidence, historical success rate, failure count |
| Cost | Model cost, cumulative budget |
| Quality | Test results, security scan |

**Condition composition**: the MVP supports two levels of nesting ("all of" / "any of") and no more — deeper nesting costs more complexity than it returns.

**Advanced mode** offers expression editing (e.g. `risk == 'low' && test.passed && cost < 10`) for engineers who want precise control, but it is not the default.

### 5.5 Actions (product doc 8.9.2)

| Action | Description | Extra configuration |
| --- | --- | --- |
| Allow | Let it through | — |
| Allow and Notify | Let it through and notify | Recipients and channel |
| Require Agent Review | Needs an Agent's review | Which Review Agent |
| Require Human Review | Needs a human's review | Owner/role, deadline |
| Require Multiple Approvals | Needs several sign-offs | Signers, passing condition |
| Ask | Ask (advisory, non-blocking) | Who to ask |
| Pause | Pause the task | Resume condition |
| Deny | Refuse | Refusal explanation |
| Escalate | Escalate | Escalation path |
| Transfer to Human | Hand execution to a human | Who picks it up |

**Owners can be named by role** (DBA, tech lead) rather than by person — when staff change, the rules don't (product doc 8.7.5).

### 5.6 Plain-language explanation (a key design)

While a rule is being edited, a plain-language explanation is regenerated live. This is what solves "only engineers can read the configuration screen."

How it is generated: conditions and actions are composed into fixed sentence templates, not written by an LLM — **the explanation has to match the execution logic exactly**, and a model introduces drift.

### 5.7 Simulation (the most important feature on this page)

Validate a rule by replaying it against historical data. This is what makes users willing to configure Policy at all — **without simulation, users don't dare open up automation; without open automation, the product's value is cut in half**.

Simulation output:

1. How many times it would have handled things automatically
2. **How many of those disagreed with what the human decided at the time** (the important one)
3. Clickable disagreement cases
4. Suggested extra conditions derived from those disagreements

**"2 of them the human actually rejected"** does more to expose a hole in a rule than any amount of documentation.

The separate "Simulate" tab also supports hand-built scenarios:

```
Build a scenario
  Work Item type  [Task ▾]        Risk level   [Low ▾]
  Environment     [Production ▾]  Cost         [$8]
  Automated tests [Passed ▾]      Agent confidence [85%]
                                                        [Run test]

Result: ⚠ Human approval required
  Matched rule #1 "Production database changes must be approved by a DBA" (priority 1)
  Never reached rule #7 (priority 10) — intercepted by #1

  Match trace:
   #1 Production DB change    ✓ matched → Require Human Review → stop
   #7 Low-risk auto-approve   ⊘ not evaluated
```

Visualizing the match trace is what teaches the priority mechanism, and it heads off "I clearly configured auto-approve, so why is it still asking me?"

### 5.8 Conflict detection (the health check)

Detected automatically:

| Problem | Severity | Description |
| --- | --- | --- |
| Rule conflict | 🔴 | A lower-priority rule tries to tighten, but a higher-priority rule already let it through — that gate never gets its turn |
| Unreachable rule | 🟡 | Will never match under any common scenario |
| Too permissive | 🔴 | **Some rule** explicitly lets a high-risk action through |
| Coverage gap | ⚪ | Some class of high-risk action has no rule covering it and falls back to the autonomy-level default |
| Zero hits | ⚪ | Created more than seven days ago, not matched once in the last 30 days |
| Data source not connected | 🟡 | A condition references a data source that isn't wired up yet, so the rule can never match |

**A finding sits on the rule it is about**, instead of living in a separate checklist at the top of the page behind a "jump to rule" button — where you see a problem and where you can fix it should not be a full screen apart. The remaining findings with no rule to point at (coverage gaps, "everything needs approval") go into a section collapsed by default.

**Coverage gap drops to ⚪, and is not reported at all when there are no rules.** What it says is "this falls back to the default policy," and the default policy is part of the autonomy level — something the user chose, not an incident. Zero rules is even less of a "you missed some": it means configuration hasn't started. Shouting nine "high-risk actions are unguarded" findings at an empty project produces nine individually correct statements that together say "you haven't written any rules yet" nine times over. An empty list is handed to the onboarding wizard (§5.12), not to the health check to frighten people with.

The real incident is **too permissive**: some rule explicitly lets a high-risk action through. That one stays 🔴.

### 5.9 Autonomy level (product doc 8.9.4)

The autonomy-level selector at the top of the page is Policy's master switch. The three settings correspond to different **default actions**, used whenever no rule matches:

| Level | Default policy |
| --- | --- |
| Human-led | Most actions default to `Require Human Review` |
| Agent-led + Approval | Low and medium risk automatic, approval at the key nodes (default) |
| Agent-autonomous | Automatic by default, `Ask` only on anomalies |

Switching shows an impact preview: "After switching to Agent-autonomous, the 6 action types that currently need human confirmation drop to 2. Specifically: …"

**Safety floors are unaffected by the autonomy level**: deleting resources, changing permissions, and executing payments always need a human, and those three are hard-coded into the evaluator ([09 Security](../../tech/09-security.md) §4.1). The switching dialog has to say this out loud — otherwise "Agent-autonomous" reads as "it will never ask again."

### 5.10 Tab: hit statistics

Hit count per rule, outcome distribution, average wait, trend. Used to spot:
- Repeated decisions that ought to become rules (many hits + consistent outcome)
- Rules that have turned into bottlenecks (long waits)
- Rules that exist in name only (zero hits)

### 5.11 Tab: change history

Who changed which rule when, with a before/after diff. Policy changes are highly sensitive and must be audited completely (product doc 10.5) — **a deletion gets its own entry too** (`after: null`). Without that, the only trace left for someone later asking "wasn't there a rule blocking this?" would be that rule's last **edit** — and that record looks perfectly ordinary. In the history, a deletion that isn't recorded looks exactly like nothing having happened.

The column in that history describes the **outcome**, not the jargon: "approves less / approves more" rather than "loosened / tightened." The latter is internal vocabulary from the governance model; to read it, a user first has to know the model splits permissions into two tiers — and nothing is lost by dropping it.

### 5.12 First-run wizard (when a project has zero rules)

The platform no longer ships baseline rules, so on a new project this page's rule area would otherwise be an **empty list** plus a row of template buttons. Together those two things say "something belongs here, go configure it" — and at that moment the user knows neither what to configure nor how much counts as enough. The usual ending is that they close the page, the project runs on with zero rules, and nobody discovers that no boundary was ever set until something goes wrong.

So the empty list is replaced wholesale by four questions:

| Question | What it generates |
| --- | --- |
| What kind of project is this? | Nothing — it only seeds a suggested set of answers for the three questions below |
| Should production releases need human approval? | Deploy (production only) → needs a human |
| Should database changes need human approval? | Database schema change + data change → needs a human |
| Above what per-run cost should we check with you first? | A cost-gate rule; 0 means no gate |

Three design constraints:

- **One screen, not a stepper.** The four questions are independent and each answerable at a glance. Stepping them just turns one screen into four, at the price of the user not learning what the whole thing bought them until the last step.
- **The rules it will create are listed right there**, updating live as the answers change. One-click governance setup slides very easily into "I don't know what it configured for me," and in governance, not knowing what you have is as dangerous as having nothing — with an extra layer of false confidence on top.
- **The suggestions always err conservative.** The wizard hands over a starting point, and a starting point with boundaries set too loose is one the user will never notice; set too tight, they come back and change it the next day.

There has to be a "Skip, I'll configure it myself" path, and what it yields is the space, not the whole block — someone who already knows what they want should not be stopped at the door by advice they never asked for. The skip lives in memory only, never in localStorage: onboarding that vanishes forever after one skip permanently hides the fact that this project has no boundaries set.

---

## 6. Core Interaction Flows

**Creating a rule from a decision (the highest-frequency path)**

```
Decision Center, after approving → [Create rule] → a new rule here (conditions pre-filled)
→ check that the plain-language explanation says what you meant
→ [Run simulation] → 2 disagreements found → [Accept suggestion] adds an exclusion
→ simulate again → 0 disagreements → [Enable rule]
```

**Tightening governance (after a security audit)**

```
New rule → condition "action type = delete resource" → action Require Multiple Approvals
→ Simulation: would have blocked 3 times in the last 30 days (1 of them a mistaken delete)
→ Enable
```

**Diagnosing "why is it asking me?"**

```
The user is puzzled that a low-risk action needs approval
→ Simulate tab → build that scenario → run
→ The match trace shows #1 intercepted it → cause understood
→ If the rule really is too strict → adjust #1's conditions (or request an exception, if it's an org rule)
```

---

## 7. States

| State | Handling |
| --- | --- |
| No project-level rules | The rule area is replaced wholesale by the four-question wizard (§5.12), not an empty list plus a row of template buttons |
| Draft rule | Marked "Draft, not in force"; editing can continue |
| Simulating | Progress indicator; for large data sets, run it asynchronously and notify on completion |
| Not enough data to simulate | "Less than 30 days of history — treat the simulation as indicative only" |
| Save conflict (someone else edited concurrently) | Show the diff and require re-confirmation |
| An org rule change affects this project | Banner at the top: "Org rule #1 was updated today and may affect 2 rules in this project" + [See the impact] |

---

## 8. Permissions

| Action | Requirement |
| --- | --- |
| View rules | Project member (governance is transparent; everyone should know the rules) |
| Create / edit project-level rules | `tech_lead` / `pm` |
| **Loosening a rule** (less human involvement) | `tech_lead`, plus a simulation and an audit entry |
| Tightening a rule | `pm` and above |
| Switching an action type to "Auto" | Same as loosening (the switch takes exactly the same save path as a hand-written rule) |
| Switching an action type to "Human" | Same as tightening |
| Disabling a rule | `tech_lead`, reason required |
| Editing org-level rules | `org_admin` |
| Requesting an exception to an org rule | `tech_lead` initiates → `org_admin` approves |
| Changing the autonomy level | `tech_lead` / `pm` |

**Agents cannot modify Policy** (product doc ch. 13 — "Agents modifying Policy automatically" is out of MVP scope). An Agent may only **suggest** a rule, which takes effect once a human confirms it. This is the foundational constraint of the whole governance system: if an Agent could change its own constraints, governance would be void.

**The words "tighten" and "loosen" never appear in the UI.** They are this table's vocabulary, not the user's. To work out what an ↑ or a ↓ means for them, they would first have to know that the model splits permissions into two tiers — and that is something they never need to know. The only situation they will actually run into is a grayed-out button, and at that point the permission difference shows up in the shape of "why can't I click this, and who do I ask" — a sentence the server has already computed. A gray button plus a clear reason covers it without teaching a vocabulary first.

---

## 9. Data Dependencies

**Domain objects**: `Policy` (all fields), `Decision` (hit records), `Event` (the simulation data source), `Agent`, `Project`

**Endpoints**

```
GET  /api/projects/{id}/policies
     → { org_policies[], project_policies[], summary: { auto_actions[], human_required[] },
         conflicts[] }

POST /api/policies                    Create (priority optional; the server appends at the end)
PATCH /api/policies/{id}              Edit (priority omitted = leave it as is)
POST /api/policies/{id}/toggle        { enabled, reason }

PUT    /api/projects/{id}/policies/operation-switch          Switch an action type to auto / human
       ← { operation_type, verdict: 'auto'|'human', environment?, name? }
       → { policy, direction, simulation,
           applied,            ★ whether this row **actually** changed
           blocked_by,         'other_rules' | 'safety_floor' | 'autonomy_default' | null
           shadowed_by[] }     the rules standing in front of it
DELETE /api/projects/{id}/policies/operation-switch/{op}     Turn the switch off (delete the rule it created)

POST /api/policies/simulate           Historical replay
     ← { policy_draft, range: '30d' }
     → { would_auto_handle, total_applicable, mismatches: [{ event_id, human_decision,
         policy_decision, context }], suggestions[] }

POST /api/policies/evaluate           Hand-built scenario test
     ← { context: { work_item_type, risk, env, cost, ... } }
     → { result, matched_policy, evaluation_trace[] }

GET  /api/projects/{id}/policies/hits?range=30d
GET  /api/policies/{id}/history
GET  /api/policy-templates?scenario=
```

`applied` and `policy` are two different things, and the UI has to read them separately: the rule being stored does not mean the row landed in the state the user wanted. §9 of the product doc originally required loosening changes to carry a `simulation_id`; the implementation instead has **the server run the simulation itself at save time** — a client-supplied id can be forged with any string at all, and this gate happens to be the most important safety valve on the page.

**Evaluation performance**: Policy evaluation sits on the Flow Engine's critical path and has to be fast (target < 10ms). Rules are compiled into a cached decision tree, invalidated and rebuilt whenever they change.

---

## 10. Instrumentation and Metrics

| Event | Purpose |
| --- | --- |
| **`policy_created{source}`** | The split between rules created from decisions, from Analytics, and by hand — measures whether the rule-making flywheel has started turning |
| **`simulation_run{mismatches}`** | **How much simulation is used and how many problems it finds — the single most important safety valve on this page** |
| `simulation_suggestion_accepted` | Suggestion acceptance rate |
| `policy_direction{tighten, loosen}` | Tightening vs. loosening ratio (tracks how the organization's trust in Agents evolves) |
| `policy_zero_hit_count` | How many rules are dead weight |
| `evaluate_scenario_used` | Scenario-test usage (the diagnostic need) |
| `conflict_resolved` | The value conflict detection is delivering |

**Success criteria for this page**: 100% of loosening rule changes go through simulation; at least 2 new effective rules per month with the automated-handling share rising steadily; zero-hit rules under 10%.

---

## 11. Edge Cases

| Situation | Handling |
| --- | --- |
| More than 30 rules | Warn that complexity is getting high and suggest consolidating; offer a grouped-by-scenario view |
| Duplicate priorities | Not validated, and the user is not asked to fix it — at equal priority the stricter rule is evaluated first ([05](../../tech/05-policy-engine.md) §3.1). Asking the user to adjust a number they cannot see is the real edge case |
| A condition references a field that doesn't exist (e.g. a system not yet connected) | Mark it "this condition depends on a data source that isn't connected; the rule will never match" + a link to configure it |
| The simulation disagrees with reality | The simulation replays historical Events and can drift where context is missing; the page states plainly that "simulation is indicative only" |
| The rules make everything need approval | Conflict detection warns: "under this configuration the Agent can barely act on its own — please check" |
| A high-risk action has no rule covering it | Coverage-gap detection, ⚪ severity; **not reported at all when there are no rules**, because that isn't "you missed some," it's "you haven't started" — handed to the onboarding wizard (§5.12) |
| A toggled action type didn't take effect | Report the cause honestly (shadowed by another rule / safety floor / autonomy level) and say what can be done about each (§5.1) |
| An unrecognized action type or environment value | Reject it: evaluation stops with an error rather than falling back to "modify code" — a fallback guesses toward the permissive side, and then a single typo is enough to slip past the safety floor |
| An org rule and a project rule conflict semantically | The org rule wins; the project rule is marked "overridden by an org rule, will not take effect" |
| Deleting a rule that is currently referenced | Show what references it (in-flight decisions) and require handling those first |
| Delay before a rule takes effect | State the effective time explicitly after saving (cache refresh); in-flight Runs keep using their snapshot of the old rules |

---

## 12. Open Questions

1. The MVP scope (product doc 12.2) asks for only four basic settings: which tasks run automatically, which need approval, how many failures before handing off to a human, and which environments must be approved. This document describes the complete form. **Suggestion: have the MVP ship only templated configuration (pick a scenario → fill in a few parameters), skip the free-form condition editor**, and put the saved effort into simulation — simulation matters more than flexibility.
2. Historical replay requires Events to carry enough context snapshot. That places a requirement on the event model design and needs confirming up front.
3. Is the exception-request flow for org-level rules in MVP scope? Leaning toward leaving it out and using a "contact your administrator" placeholder.
4. Policy versioning: after a rule changes, do in-flight tasks use the new rules or the old ones? Leaning toward the snapshot taken when the task started, to avoid mid-flight changes producing inconsistent behavior.
5. The plain-language explanation templates have to cover every combination of condition and action, which is a fair amount of work. Should we cap condition-combination complexity to keep explanation quality up?
6. The relationship between "Agents suggest rules" (product doc 8.7.1, "Agents suggest automating repeated decisions") and this page needs sorting out — should suggestions land in the Decision Center or here? Leaning toward entrances in both places, with the creation flow unified on this page.
7. The switch matrix currently has only two clickable states, Auto and Human; "Depends" is reported and not selectable. Letting a user configure "production needs a human, everything else automatic" directly from that row would need an intermediate form — more capable than a switch, simpler than the rule editor. Let's first see how many people actually hit this need.
8. Org-level rules still have no creation entrance (evaluation continues to honor them). When that entrance arrives, this page's rule list has to grow back its **read-only tier**: the scope badge, the read-only notice, and a jump target for health findings that point at an org rule.
