# 06 Work Item Detail

*[中文版本 / Chinese version](06-work-item-detail.zh.md)*

## 1. Page Information

| Field | Value |
| --- | --- |
| Route | `/projects/:projectId/items/:itemId` (standalone page)<br>Opens as a side drawer from the board, with the URL kept in sync |
| Level | Level-4 page |
| Primary roles | All project members |
| Priority | P0 |
| Related product docs | 6.3 Work Item, 8.5.5 Human takeover, 8.8.4 HITL during execution, 8.10 Review |

---

## 2. Page Goals

The **complete record and control panel for one work item**. It has to answer:

1. What does "done" look like here? (description + acceptance criteria)
2. Who is working on it right now, and how far have they gotten?
3. What came out of it, and is it any good?
4. Why is it blocked / why did it fail?
5. What can I do about it?

This page is the board card expanded, and it is also the container one level above Agent Runs — a single work item may span several runs (retries, a switch to a different agent).

---

## 3. Entry Points and Exits

**Entry points**: clicking a board card; clicking a node in the execution graph; the task queue in the Agent Workspace; the linked work item on a decision detail page; a deep link from a notification; search.

**Exits**:

| Action | Destination |
| --- | --- |
| A run record | `09 Agent Run Detail` |
| Linked decision | `11 Decision Detail` |
| Parent / subtask / dependency | This page (switches to that item) |
| Executor chip | `08 Agent Workspace` |
| Artifact link | External (PR / report / deployment) |
| "View in execution graph" | `07 Execution Graph` (anchored on the node) |

---

## 4. Page Structure

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ ← Board   Multi-condition query API                      [⋯] [View in execution graph]  │
│ ⚙ Task · P0 · 🔴 High risk · Execution / Executing                                      │
│ [🤖 code-agent-1] Executing 12m ·  ▓▓▓▓▓▓░░ 65% · $8.20 · ~6m left                      │
│                                       [⏸ Pause] [🙋 Take over] [🔄 Reassign] [⏹ Abort]  │
├────────────────────────────────────────────────────────┬────────────────────────────────┤
│ [Overview] [Runs] [Artifacts] [Review] [Deps] [Events] │ Properties                     │
│                                                        │ ────────────────────────────── │
│ Description                                     [Edit] │ Type       Task                │
│ Build one API for combined lookup by phone number,     │ Status     Executing 🤖        │
│ order ID, and time range; P95 latency < 500ms.         │ Stage      Execution           │
│                                                        │ Priority   P0                  │
│ ⚠ Extra constraints added by a human                   │ Risk       🔴 High             │
│ · Canary traffic only, 10%                             │ Owner      👤 Zhang Wei        │
│ · Do not change existing API signatures                │ Executor   [🤖 code-agent-1]   │
│                                                        │ Planned    8h                  │
│ Acceptance criteria                            4/6 ✓   │ Elapsed    12m                 │
│ ☑ Phone number exact match     🔧 auto-check passed    │ Start      08-05 09:00         │
│ ☑ Order ID exact match         🔧 auto-check passed    │ Due        08-05 17:00         │
│ ☑ Time range query             🔧 auto-check passed    │ Cost       $8.20 / ~$6.40      │
│ ☑ Unit test coverage ≥ 80%     🔧 84%                  │            ⚠ 28% over est.     │
│ ☐ P95 < 500ms                  ⏳ perf test pending    │ ────────────────────────────── │
│ ☐ Security scan passes         ⏳ not run yet          │ Parent                         │
│                                                        │ 📋 Server-side build-out       │
│ Current progress                                       │ Subtasks (0)                   │
│ ┌───────────────────────────────────────────────────┐  │ ────────────────────────────── │
│ │ 🤖 code-agent-1 · 12:34                           │  │ Dependencies (2)               │
│ │ Query DSL parsing and parameter validation are    │  │ ⬅ Upstream                     │
│ │ done; implementing the index lookup now.          │  │  ✓ Design the search API       │
│ │ Next up: unit tests.                              │  │  ⛔ DB index migration (8h)    │
│ │                             [View full run →]     │  │ ➡ Downstream                   │
│ └───────────────────────────────────────────────────┘  │  ⏸ Query result cache          │
│                                                        │  ⏸ Integration tests           │
│ Recent artifacts                                       │ ────────────────────────────── │
│ 📎 PR #42  order-service  +284 −37                     │ Run history (2)                │
│    Review Agent ✓ passed · tests 48/48 ✓               │ #2 Running  code-agent-1       │
│    [Open PR ↗]                                         │ #1 Failed   code-agent-1       │
│                                                        │    Context missing   [view]    │
└────────────────────────────────────────────────────────┴────────────────────────────────┘
```

---

## 5. Regions in Detail

### 5.1 Header and Execution Bar

**The execution bar is the biggest single difference between this page and a conventional task detail page** — it is a live process status bar that updates in real time:

| Status | What the execution bar shows |
| --- | --- |
| Executing | Agent chip, elapsed time, progress bar, cost so far, estimated time remaining + [Pause][Take over][Reassign][Abort] |
| Blocked | How long it has been blocked, why, who owns the blocker + [Nudge][Reassign][Force through] |
| Failed | Failure count, a summary of the reason, what Policy says happens next + [Retry][Retry with more context][Reassign][Hand to a human] |
| Awaiting decision | Decision title, who owns it, time left + [Go handle it][Nudge] |
| Under review | The reviewer list with each one's verdict + [Add a human reviewer] |
| Human executing | Who is doing it, when they started + [Mark done][Hand back to the agent] |
| Done | Total time, lead time, total cost, who accepted it |

**Where the progress number comes from**: an agent's progress percentage is an estimate. Hovering shows 「基于子步骤完成度估算，仅供参考」(estimated from sub-step completion; indicative only) — don't let users read it as a precise measurement.

### 5.2 Human Takeover (product doc 8.5.5)

This is the product's key safety valve, so the interaction has to be unambiguous. Clicking [🙋 Take over] opens:

```
Take over "Multi-condition query API"

The agent has finished:
· Query DSL parsing (already pushed to PR #42)
· Parameter validation
Not finished: index lookup logic, unit tests

What the agent should do
 (•) Stop immediately, keep what it has produced
 ( ) Stop once the current step finishes
 ( ) Keep running — I'll work alongside it

After the takeover
 ☑ Change the executor to "👤 me"
 ☑ Post a takeover note on PR #42
 Reason for taking over [                        ]  * required

                          [Cancel]  [Confirm takeover]
```

After a takeover the status stays `executing` but the executor becomes a human, the card shows `🙋 已人工接管` (taken over by a human), and Analytics counts it toward the takeover rate.

**Handing back to the agent**: a human can return the task at any time, and must write a handover note that becomes the agent's new context — this is context flowing in the human→agent direction, easy to forget and easy to underrate.

### 5.3 Description and Human-Added Constraints

The description comes out of plan generation and is editable. **Constraints added by a human get their own highlighted block** (for example "canary traffic only, 10%"), because they usually come from an `Approve with Constraints` decision: the agent must honor them while executing, and a human reviewing the result needs to see them at a glance.

Each constraint is traceable back to its source — click it to jump to the decision that produced it.

### 5.4 Acceptance Criteria (product docs 6.3, 8.10.1)

The structured acceptance criteria carried over from the requirement page; one of the most important blocks on this page. Each line shows:

| Element | Description |
| --- | --- |
| Check state | ☑ passed / ☐ not passed / ⏳ awaiting verification / ❌ failed |
| Verification method | `🔧 automated check` / `🤖 agent judgment` / `👤 human confirmation` |
| Result | The concrete number (e.g. 84% coverage) or a link to the evidence |

**Release is not allowed while any criterion is unmet** (product doc 8.10.3, quality gate). Forcing it through manually requires `tech_lead` and a written reason.

### 5.5 Current Progress

A progress summary the agent writes in plain language — far friendlier than the raw log. It is refreshed every time the agent finishes a sub-step.

**This block exists for people who don't want to read logs.** Anyone who does want the detail clicks [View full run] and lands on `09`.

### 5.6 Tab: Runs

Every run for this work item — retries and agent swaps each produce a new one:

```
#2  🤖 code-agent-1   Running   12m    $8.20   ▓▓▓▓▓▓░░ 65%      [Detail →]
#1  🤖 code-agent-1   Failed    4m     $2.10   context missing   [Detail →]
    └ Cause: couldn't locate the order table schema definition
    └ Remedy: added the schema doc to the context and retried
```

Costs across runs are shown as a running total, so nobody assumes they only paid for the last attempt.

### 5.7 Tab: Artifacts (product doc 6.8)

Code PRs, test reports, documents, screenshots, deployment records, and so on. Each artifact carries a type icon, name, producer, timestamp, size/scale, status, and external link.

PR-type artifacts additionally show the branch, lines changed, CI status, and review verdict.

### 5.8 Tab: Review (product doc 8.10.2)

The aggregated result of a multi-agent review:

```
Review verdict: ⚠ Passed with conditions (2 pass / 1 with comments)

🤖 code-review-agent   ✓ Pass       "Clean structure, follows the conventions"     [Detail]
🤖 security-agent      ⚠ Comments   "Phone lookup isn't masked; suggest…"          [Detail]
🤖 test-agent          ✓ Pass       "48/48 passing, 84% coverage"                  [Detail]
👤 Zhang Wei           ⏳ Pending    Notified · 2h ago                              [Nudge]

Conflict: security-agent's comment needs a human ruling            [Go rule on it →]
```

When agent verdicts conflict (product doc 8.8.4, "conflicting multi-agent verdicts") a decision is generated automatically and its entry point appears here.

### 5.9 Tab: Dependencies (product doc 8.6.2)

Upstream and downstream dependency lists, each annotated with its dependency type (finish-to-start / start-to-start / artifact / decision / permission / external system / data preparation) and current status.

Whatever is doing the blocking is marked in red and comes with a direct action. The right-hand rail already carries a condensed version; this tab is the full view plus a mini dependency graph.

### 5.10 Tab: Events

The Event Timeline component (§5.8). Milestone level by default, with a "show all detail" toggle that drops down to tool-call-level events.

Filterable by source; every event expands to its raw payload for troubleshooting.

### 5.11 Right-Hand Property Rail

The fields are in the §4 wireframe. What matters:

- **Cost comparison**: actual vs. estimate, turning red with a percentage when it overruns — the earliest signal that spend is getting away from you
- **Run history**: always visible, because "how many times has this failed" is the single best read on a task's health
- **Dependencies**: blocking upstream items in red, clickable straight through

---

## 6. Core Interaction Flows

**Dealing with a failed task**

```
Open it → execution bar reads "Failed 2/3" → read the failure reason
→ decide:
   ├ context was missing → add the information to the description → [Retry with more context]
   ├ agent isn't capable of this → [Reassign], pick from candidates (each with a fit explanation)
   ├ the task itself is wrong → [Split task] or go back to the plan page
   └ the requirement is ambiguous → [Raise a decision] → 11 Decision Detail
```

**Reviewing what an agent produced**

```
Status = Reviewing → check the acceptance criteria (4/6 ✓)
→ open artifact PR #42 → follow the external link to read the code
→ come back and read the three agent verdicts in the Review tab
→ security-agent has comments → rule on it: accept the comment
→ [Request changes] → the task returns to Execution and the agent receives the comments
```

**Human takeover**

```
Agent stuck for 12 minutes with no progress → [Take over] → reason: "agent is looping"
→ executor becomes a human → finish the work locally → [Mark done] + upload artifacts
→ or, after finishing part of it, [Hand back to the agent] + a handover note
```

---

## 7. State Design

| State | Handling |
| --- | --- |
| Loading | Header and property rail render first; tab content loads lazily |
| Work item deleted / merged away | Show 「已合并到 XXX」(merged into XXX) plus a link to follow |
| No runs yet (not started) | The Runs tab shows 「尚未开始执行」(not started yet) + the planned start time + [Start now] |
| Agent executing | Progress, cost, and current progress update live; refreshing that region pauses while the user is editing the description |
| Insufficient permission | Content stays visible; action buttons gray out and name the role required |
| Task complete | The execution bar is replaced by a delivery summary; actions collapse to [Reopen][Copy as new task] |

---

## 8. Permissions

| Action | Requirement |
| --- | --- |
| View | Project member |
| Edit description / acceptance criteria | `member` and above (editing mid-execution warns that it affects the running agent) |
| Pause / abort a run | `tech_lead` / `pm` / `agent_owner` |
| Human takeover | `member` and above |
| Reassign | `pm` / `tech_lead` |
| Force through unmet acceptance criteria | `tech_lead`, reason required, audited |
| Rule on conflicting agent verdicts | `tech_lead` |
| Reopen a completed task | `pm` and above |

---

## 9. Data Dependencies

**Domain objects**: `WorkItem` (all fields), `AgentRun`, `Artifact`, `Event`, `Decision`, `Agent`, `Review` (multi-agent verdicts)

**Endpoints**

```
GET   /api/work-items/{id}
      → { item, current_run, runs[], artifacts[], reviews[], dependencies{}, constraints[] }
GET   /api/work-items/{id}/events?level=&source=&cursor=

PATCH /api/work-items/{id}                        edit fields
POST  /api/work-items/{id}/takeover               { agent_handling, reason }  (reason required)
POST  /api/work-items/{id}/handback               { handover_note }
POST  /api/work-items/{id}/reassign               { assignee_type, assignee_id, reason }
POST  /api/work-items/{id}/retry                  { additional_context? }
POST  /api/work-items/{id}/split                  { subtasks[] }
POST  /api/work-items/{id}/acceptance/{criterion} { passed, note }   human sign-off on one criterion
POST  /api/work-items/{id}/force-pass             { reason }  (tech_lead, audited)
POST  /api/reviews/{id}/resolve-conflict          { decision, note }

SSE   /api/stream?channels=work_item:{id}
```

---

## 10. Instrumentation and Metrics

| Event | What it tells us |
| --- | --- |
| `work_item_viewed{status}` | Which statuses make people open the detail page (should cluster on failed/blocked) |
| **`takeover{reason_category}`** | **Takeover rate and the distribution of reasons — direct evidence of where agent capability falls short** |
| `retry{with_context}` | Success-rate gap between retrying with added context and retrying as-is |
| `acceptance_manual_override` | How often criteria get forced through (a governance risk signal) |
| `review_conflict_resolved{outcome}` | Which way humans lean when agents disagree |
| `progress_trust` (progress-bar hovers) | How much users doubt the progress estimate |
| `detail_to_run_navigation` | How many people actually go read the run log |

**Success criteria for this page**: takeover rate < 10%; more than 70% of failed tasks resolved in a single action on this page.

---

## 11. Edge Cases and Exceptions

| Situation | Handling |
| --- | --- |
| Editing the description while the agent is running | Warn 「Agent 正在执行，修改将在下次 Run 生效」(the agent is running; your change takes effect on the next run) + an optional [Restart the run now to apply it] |
| Several people editing at once | Field-level locking + a collaborator indicator |
| More than 10 runs (repeated failures) | Collapse the run list and put a red banner on top: 「已失败 8 次，建议人工介入或拆分任务」(failed 8 times — consider stepping in or splitting the task) |
| Cost far above estimate (> 3x) | The execution bar turns red with a 「成本异常」(cost anomaly) marker; Policy may already have paused the run |
| Circular dependency | The Dependencies tab shows a cycle warning + [View in execution graph] |
| Artifact's external link is dead | Show 「链接不可访问」(link unreachable) and keep the metadata — never delete the record |
| Acceptance criteria changed by a later requirement change | Already-passed items are marked 「基于旧标准通过」(passed against the old criteria) and need re-verification |
| Human takes over, then does nothing for a long time | A reminder after 24h; after 48h, ask whether to hand it back to the agent |

---

## 12. Open Questions

1. The method behind the agent progress percentage needs a definition. If it can't be made reliable, would "sub-steps completed / sub-steps planned" be the more honest thing to show?
2. How should a human's own work be recorded while they execute a task? Is "mark done + upload artifacts" enough for MVP, with no time tracking?
3. How do we make sure the agent genuinely understands the handover note on a hand-back? Should the agent be required to restate it for confirmation?
4. Should ruling on conflicting multi-agent review verdicts be forced through a Decision object (traceable) rather than acted on directly from this page? Leaning toward forcing the Decision.
5. Automated verification of acceptance criteria depends on CI and test-system integration. If that integration is incomplete at MVP, do we fall back to "manual check-off + flagged as not automatically verified"?
