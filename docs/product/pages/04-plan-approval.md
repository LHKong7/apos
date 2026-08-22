# 04 Plan Approval

*[中文版本 / Chinese version](04-plan-approval.zh.md)*

## 1. Page Facts

| Item | Value |
| --- | --- |
| Route | `/projects/:projectId/plans/:planId` |
| Level | Third-level page |
| Primary roles | `tech_lead` / `pm` (approve); `sponsor` (confirm the delivery commitment) |
| Priority | P0 |
| Related product docs | 8.3.1 Project planning, 8.3.2 Dynamic task decomposition, 8.8.2 HITL in the planning phase, 6.6 Plan |

---

## 2. Goal

Let a human judge **within two minutes** whether an AI-generated execution plan can be turned loose, and know exactly what they are approving.

The page has to answer:

1. How does the Agent intend to do this? How many steps, and who does them?
2. How long will it take, and what will it cost?
3. Where is it most likely to go wrong?
4. Once I approve, what happens automatically without me?

**That last one is the soul of this page.** Approving a plan means approving a batch of automated behavior, and the user has to see plainly what they are signing away.

---

## 3. Entrances and Exits

**Entrances**: automatically, once the requirement is confirmed; the "plan awaiting approval" banner on the project overview; plan-approval decisions in the Decision Center; the "Plan" tab inside a project.

**Exits**:

| Action | Destination |
| --- | --- |
| Approve the plan | `05 Autonomous Board` (tasks start moving) |
| Request changes | Stay here; the Agent re-plans |
| Approve after manual adjustments | `05 Autonomous Board` |
| Open a task's detail | `06 Work Item Detail` (side-panel preview) |
| See the full dependency picture | `07 Execution Graph` |
| Reject | Back to `03 Requirement Intake` |

---

## 4. Page Structure

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ ← Order Query Performance / Execution Plan v1   Pending approval · by Project Agent     │
│   Generated 14:22 · took 3m12s · $0.34 · claude-opus-5                   [Re-plan]      │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐    │
│ │Tasks         │ │Duration      │ │Cost est.     │ │Human input   │ │Risk          │    │
│ │18            │ │4.5 days      │ │~$42          │ │5 nodes       │ │Med · 3 items │    │
│ │🤖14 👤4      │ │8/8 done      │ │Budget $500   │ │3 are yours   │ │1 high risk   │    │
│ └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘    │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ ⚠ Happens automatically once you approve (no second confirmation)   [Rule by rule]      │
│ ┌─────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ · 14 tasks will be run by Agents, including edits to order-service code             │ │
│ │ · PRs created and reviewed by the Review Agent; merged to develop when tests pass   │ │
│ │ · Automatic deploy to the test environment                                          │ │
│ │ · ~$42 of expected spend (8.4% of the budget)                                       │ │
│ │                                                                                     │ │
│ │ Still needs you: prod release · schema change · task cost > $10 · 3 fails in a row  │ │
│ │                                        [Adjust these rules → Policy settings]       │ │
│ └─────────────────────────────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ [Task breakdown] [Timeline] [Dependency graph] [Risks] [Milestones]                     │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ Task breakdown                                        [Expand all] [Compact ⇄]          │
│                                                                                         │
│ ▾ 📋 Order query performance optimization             18 tasks · 4.5 days               │
│   ▾ 🔍 Research  Current state and options             1 task · 4h                      │
│     · Analyze slow-query logs and indexes    [🤖 research-agent]  4h    ~$1.2           │
│   ▾ 🎨 Design    API and index design                  2 tasks · 6h                     │
│     · Design the search API                  [🤖 code-agent-1]    3h    ~$0.8           │
│     · Design the index scheme                [🤖 code-agent-1]    3h    ~$0.9           │
│       └ ⚠ Needs human sign-off: production DDL       👤 Wang Qiang (DBA)                │
│   ▾ ⚙ Backend   Server-side implementation             7 tasks · 2.5 days  ⚠ high       │
│     · Build the multi-filter query API       [🤖 code-agent-1]    8h    ~$6.4           │
│     · Database index change                  [👤 Wang Qiang]      4h                    │
│       └ 🔴 High risk · production DDL · irreversible · DBA sign-off + rollback plan     │
│     · Cache query results                    [🤖 code-agent-1]    6h    ~$4.1           │
│     · Unit tests                             [🤖 test-agent-1]    4h    ~$2.2           │
│     ⋯ show the other 3                                                                  │
│   ▸ 💻 Frontend  Search UI                              4 tasks · 1.5 days              │
│   ▸ 🧪 Test      Integration and performance tests      2 tasks · 8h                    │
│   ▸ 👁 Review    Cross-review by several Agents         1 task · 2h                     │
│   ▸ 🚀 Release   Canary release                         1 task · 4h    👤               │
│                                                                                         │
│ Per-row actions: [Reassign ▾] [Adjust duration] [Split] [Delete] [Add human review]     │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ 📌 This plan rests on these assumptions (from clarification, never re-confirmed)        │
│ · No historical data migration   · Search covers the last 2 years only                  │
│                                                       [Wrong? Back to requirements]     │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ 💬 Revision notes                                                                       │
│ ┌─────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ e.g. the frontend can start in parallel, it doesn't have to wait for the backend    │ │
│ └─────────────────────────────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ [Reject] [Delegate approval]      [Request changes ~$0.28]   [Approve and start →]      │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Region by Region

### 5.1 Plan metadata

Generation time, elapsed time, cost, model used, version number. Plans are versioned (v1 / v2 / v3) and support **version diffing** — after the Agent re-plans, the user needs to see *what changed*, not read the whole thing from the top again.

The diff view: added tasks in green, deleted tasks struck through in red, changed fields highlighted in yellow.

### 5.2 The five overview metrics

| Metric | Contents | What it is for |
| --- | --- | --- |
| Tasks | Total, plus the human/Agent split | The automation ratio at a glance |
| Duration | Total days, and whether it meets the target deadline | Red, with the delta, when it overruns |
| Cost estimate | Total, plus share of the budget | Over budget blocks approval; the budget has to be raised first |
| Human involvement | Number of nodes, and how many are mine | Tells the user how much of their own time this costs |
| Risk | Level and count | The number of high-risk items is called out |

### 5.3 "What happens automatically after approval" (the core of this page)

This is where the Policy Engine's abstract rules get **translated into plain language**. From the project's current Policy set and autonomy level, the system computes which behaviors will happen automatically once the plan is approved, and lists them as ordinary sentences.

It must include:

- how many tasks will run automatically, and which systems they touch (code repository, database, deployment environments)
- which irreversible or externally visible effects will be produced (merging code, deploying, sending notifications)
- the expected spend
- **the inverse list**: what will still come back to you — just as important, because the user needs to know where the safety net is

"Rule by rule" expands into the rule detail, each line tagged with the Policy ID it matched, with a jump straight into `13 Policy Settings`.

If the project is `Agent-autonomous`, this region gets an orange border, because more authority is being handed over.

### 5.4 Task breakdown (product doc 8.3.2)

A multi-level tree, expanded to the second level by default. Every task row shows:

| Element | Notes |
| --- | --- |
| Phase icon + task name | Grouped by Research / Design / Backend / Frontend / Test / Review / Release |
| Executor | Assignee Chip (§5.2), with Agents and humans visually distinct |
| Duration | Estimated hours or days |
| Cost | Agent tasks show an estimated cost; human tasks show none |
| Risk marker | Shown at high and above, with the risk note and the controls it requires |
| Human node marker | 👤 icon, saying who has to step in and when |

**Inline actions** (adjustable without opening the detail page): reassign the executor, adjust the duration, split the task, delete it, append a human review node.

Any manual adjustment will:

1. mark that task `👤 manually adjusted`
2. recompute downstream durations and the critical path
3. if the adjustment creates a dependency conflict, flag it in red directly under the row

**The reassign dropdown** has to show why each Agent candidate matched (product doc 8.3.4):

```
Reassign to:
 [🤖 code-agent-1]  match 92%  success 92%  load 2/5   ~$6.4   ← current
 [🤖 code-agent-2]  match 78%  success 96%  load 0/5   ~$9.1
 [👤 Zhang Wei]     domain match    current load 3 items
 ─────────────
 Matching uses Skill(SQL tuning, TypeScript) and the success rate on comparable past tasks
```

### 5.5 Timeline view

A Gantt-style view marking the critical path (red), milestones (diamonds), points of human involvement (👤), and buffers.

The requirement's target deadline is marked along the top of the time axis, and everything past it is drawn as a red hatched band — **so that "we won't make it" is visually impossible to ignore**.

### 5.6 Dependency graph view

An embedded, read-only, simplified version of `07 Execution Graph`, for a quick sanity check on the dependencies before approving. "Open in the execution graph" jumps to the full version.

### 5.7 Risk view (product doc 6.6, risk list)

Each risk carries: description, level, likely impact, the mitigation the Agent proposes, and whether a matching task is already in the plan.

The user can accept the risk (recorded under `accepted risks` and written into project memory), require a mitigation task, or raise the approval level on that task.

### 5.8 Milestone view

Milestone name, date, tasks it covers, how it is verified, and who owns it. Milestones become the anchors for later notifications and reports (product doc 11).

### 5.9 Assumptions strip

The assumptions carried over from `03 Requirement Intake` that were never re-confirmed. They sit directly above the approval button — **this is the last chance to catch a misread requirement, and it costs far less here than as rework after execution.**

### 5.10 Revision notes and actions

On "Request changes," the user's free-text notes go back to the Project Agent together with the current plan, which re-plans into v2. The button shows the estimated cost of re-planning.

The confirmation step before "Approve and start":

```
Approving will immediately:
· Schedule 3 tasks to start (research-agent, code-agent-1)
· Spend an expected ~$8 today

☑ Notify me when a task fails or a decision is needed

              [Not yet]  [Confirm approval]
```

---

## 6. Core Interaction Flows

**Fast approval (when trust is high)**

```
Arrive → read the 5 metrics → read "what happens automatically" → [Approve] → board
(target: under 60 seconds)
```

**Careful approval (high-risk project)**

```
Arrive → expand the task tree → check the controls on the high-risk tasks
      → switch to the timeline, confirm the critical path is sane
      → append a human review node to "database index change"
      → reassign one task to a cheaper Agent
      → [Approve]
```

**Requesting changes**

```
Write the note "the frontend doesn't have to wait for the backend, run them in parallel" → [Request changes]
→ the Agent re-plans (1–3 min) → v2 is generated
→ the diff view opens automatically with the changes highlighted → [Approve]
```

---

## 7. State Design

| State | Handling |
| --- | --- |
| Planning | Full-page progress: "Decomposing tasks (12/18)…" plus a note on the current step; cancelable |
| Planning failed | Show the reason (not enough context, timeout, …), offer [Retry] [Back to requirements to add detail] [Create a plan manually] |
| Approved (read-only) | The header shows who approved, when, and a snapshot of the assumptions at approval time; offers [Re-plan from this plan] (creates a new version) |
| Plan change during execution | When the Project Agent adjusts the plan mid-flight (product doc 8.3.2), the new version lands on this page under the title "Plan change awaiting approval," defaulting to the diff against the current version |
| Cost over budget | Approve button disabled, with "estimated cost $620 exceeds the $500 budget" + [Adjust budget] [Ask the Agent for a cheaper plan] |
| Duration past the target deadline | Not blocking, but approval requires checking "I understand this will slip by 2 days" |

---

## 8. Permissions

| Action | Requirement |
| --- | --- |
| View the plan | Project member |
| Adjust tasks (reassign / duration / split) | `pm` / `tech_lead` |
| **Approve the plan** | `tech_lead` (the technical approach) + `sponsor` (the delivery commitment) — high-risk projects need both signatures |
| Request changes / reject | `pm` and above |
| Raise the budget | `sponsor` (product doc 8.7.5, over budget → project Sponsor) |
| Lower a task's approval level | `tech_lead`, audited |

**Dual sign-off rule**: when the project's risk level is "high," or the plan contains an irreversible production operation, `tech_lead` and `sponsor` each have to approve, and the page shows sign-off progress (`1/2 signed`).

---

## 9. Data Dependencies

**Domain objects**: `Plan` (all fields), `WorkItem` (draft state), `Agent` (candidates and match scores), `Requirement` (assumptions and acceptance criteria), `Policy` (computing the automation list), `Decision` (the approval record)

**Endpoints**

```
GET  /api/plans/{id}
     → { plan, work_items[], critical_path[], milestones[], risks[],
         cost_estimate, auto_actions[], required_approvals[] }

GET  /api/plans/{id}/auto-actions
     → [{ description, policy_id, policy_name, reversible, external_visible }]
        ← the Policy Engine's dry-run result, not hard-coded copy

GET  /api/plans/{id}/diff?from=v1&to=v2
PATCH /api/plans/{id}/work-items/{itemId}   { assignee | duration | split | delete }
     → returns the affected downstream tasks and the new critical path
GET  /api/work-items/{id}/assignee-candidates
     → [{ type, id, name, match_score, match_reasons[], success_rate, load, cost_estimate }]

POST /api/plans/{id}/approve   { note?, acknowledged_overrun? }
POST /api/plans/{id}/revise    { feedback }   → creates a new version
POST /api/plans/{id}/reject    { reason }
```

---

## 10. Instrumentation and Metrics

| Event | Purpose |
| --- | --- |
| `plan_approval_duration` | Time spent approving (target median under 90s) |
| `auto_actions_expanded` | **Whether users actually read the automation list — the key signal for whether governance is working** |
| `plan_item_modified{field}` | Which parts of AI planning people always fix (lots of reassignment → the scheduling algorithm needs work) |
| `plan_revised{round}` | Average revision rounds (target under 1.3) |
| `plan_approved_without_scroll` | The blind-approval rate — too high means the information is badly organized, or users trust it too much |
| `approval_to_first_failure` | How long after approval the first failure appears (a lagging indicator of plan quality) |

**Success criteria for this page**: revision rounds under 1.3; re-planning caused by problems in the plan itself, within 24h of approval, under 15%.

---

## 11. Edge Cases

| Situation | Handling |
| --- | --- |
| More than 50 tasks | Expand only the first level by default; offer "high risk only" and "only what I'm on" as quick filters |
| Decomposed more than 4 levels deep | Warn that "splitting this finely may add scheduling overhead," and allow collapsing the leaf level in one click |
| No Agent matches a task | Mark that task red with "no matching executor," default it to a human, and count it in the human workload metric |
| Every Agent is saturated | Show the estimated queue time and add the wait to the duration |
| Dependencies form a cycle | Block approval, name the cycle explicitly (`A → B → C → A`), offer [Let the Agent fix it] [Break it manually] |
| A manual adjustment lengthens the critical path | Warn live: "this change adds 1.5 days" |
| The Agent updated the plan while you were approving | Intercept the approval with "the plan has moved to v2" plus a diff; requires re-confirmation |
| No budget set | The cost metric shows the estimate only, with no over-budget block, but suggests setting a budget |
| The requirement changed after the plan was generated | The plan header shows a "the requirement behind this has changed" warning + [Re-plan] |

---

## 12. Open Questions

1. The "what happens automatically after approval" list comes out of a Policy Engine dry run, and we need to confirm how accurate that dry run is — if execution hits a rule the dry run missed, user trust takes the damage. Should automated behavior outside the dry run's scope trigger an extra notification during execution?
2. Should the dual sign-off trigger be configurable? Companies define "high risk" very differently.
3. Plan version retention: keep everything, or only the last N? This touches audit requirements.
4. Duration estimates for human tasks currently come from the Agent, and their accuracy is questionable. Should they default to blank for the human to fill in, or offer a suggested value based on historical cycle time?
5. Does the MVP need a "create a plan manually" fallback for when Agent planning fails? Leaning yes, but it can be very crude.
