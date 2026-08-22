# 11 Decision Detail

*[中文版本 / Chinese version](11-decision-detail.zh.md)*

## 1. Page Information

| Item | Value |
| --- | --- |
| Route | `/decisions/:decisionId` |
| Level | Second / fourth level (reachable from several places) |
| Primary roles | Decision owner, co-signers |
| Priority | P0 |
| Related product docs | 6.7 Decision, 8.7.2 Decision Cards, 8.7.3 Decision Actions, 8.7.4 Decision Deadlines, 8.7.5 Decision Accountability |

---

## 2. Page Goals

Give high-risk, high-impact decisions **enough evidence to judge on, without drowning the reader**, and feed the outcome back into the execution chain in structured form.

The cards in `10 Decision Center` handle 80% of day-to-day decisions; this page serves the remaining 20% that deserve real evaluation — production changes, architecture choices, budget overruns, security exceptions.

Questions it has to answer (one level deeper than the card):

1. What is the full background here? What led up to this?
2. How exactly do the options differ, what do they cost, and how irreversible are they?
3. Has a similar decision been made before? What was chosen, and how did it turn out?
4. Once I approve, what actually happens?
5. How will the constraints I attach be enforced?

---

## 3. Entrances and Exits

**Entrances**: "Full detail" from the Decision Center; the Human Gate badge on a board card; the linked decision on a Work Item detail page; a decision raised by an Agent Run; a notification deep link; audit-log review.

**Exits**:

| Action | Destination |
| --- | --- |
| Linked task | `06 Work Item Detail` |
| Triggering Run | `09 Agent Run Detail` |
| Triggering Policy | `13 Policy Configuration` |
| Similar past decision | This page (switches decision) |
| After deciding | Back to the Decision Center, advanced to the next item |

---

## 4. Page Structure

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│ ← Decision Center    Approve the production database index change                           │
│ ⏰ Overdue by 2h10m · 🔴 High risk · irreversible · Order System Refactor                   │
│ Owner 👤 Wang Qiang (DBA) · created 12:36 · due 14:36 · escalated to 👤 Zhang Wei           │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│ ⚠ Impact: blocks 5 downstream tasks · critical path 8h12m behind · project +1 day           │
├──────────────────────────────────────────────────────────┬──────────────────────────────────┤
│ Why this needs you                                       │ Decision info                    │
│ ┌──────────────────────────────────────────────────────┐ │ ──────────────────────────────── │
│ │ ⚖ Policy #7 "Production database change"             │ │ Type       High-risk approval    │
│ │   Condition: environment = production                │ │ Risk       🔴 High               │
│ │              and the change involves DDL             │ │ Reversible ❌ Partly             │
│ │   Action: Require Human Review (DBA)                 │ │ Impact     5 tasks · 1 env       │
│ │                                        [View rule →] │ │ Cost       $0 (run by hand)      │
│ │ Triggered by Run #1284 at 12:36                      │ │ Due        14:36 (overdue)       │
│ │ The Agent was creating the order index               │ │ Escalated  Zhang Wei @ 14:36     │
│ │                                         [View Run →] │ │ ──────────────────────────────── │
│ └──────────────────────────────────────────────────────┘ │ Co-sign (1/1)                    │
│                                                          │ 👤 Wang Qiang (DBA)  ⏳ Pending  │
│ Background                                               │ ──────────────────────────────── │
│ Order query tuning needs a composite                     │ Stakeholders                     │
│ index (phone, created_at) on the orders                  │ Raised    🤖 code-agent-1        │
│ table. It holds 42M rows and takes 120k                  │ Watching  👤 Zhang Wei (lead)    │
│ writes a day. The Agent has finished the                 │ Notify    #order-refactor        │
│ index design and impact analysis and is                  │                                  │
│ waiting for the DBA to confirm the plan.                 │                                  │
├──────────────────────────────────────────────────────────┴──────────────────────────────────┤
│ Option comparison                                                   [Side-by-side ⇄ Detail] │
│ ┌─────────────────────────────────┬────────────────────────────┬──────────────────────────┐ │
│ │ 🤖 A · create index online      │ B · maintenance window     │ C · repartition table    │ │
│ │    Recommended · 82% confidence │                            │                          │ │
│ ├─────────────────────────────────┼────────────────────────────┼──────────────────────────┤ │
│ │ Duration   ~12 min              │ ~4 min                     │ ~6 h                     │ │
│ │ Downtime   none                 │ 15 min window              │ two windows              │ │
│ │ Locking    low (online DDL)     │ locked throughout          │ staged                   │ │
│ │ Rollback   ✓ yes                │ ✓ yes                      │ ⚠ complex                │ │
│ │ Disk       +2.1 GB              │ +2.1 GB                    │ +8 GB                    │ │
│ │ Long term  medium               │ medium                     │ high (fixes root cause)  │ │
│ │ Risk       write latency ↑      │ service outage             │ long; delays delivery    │ │
│ │            est. +8ms            │                            │                          │ │
│ ├─────────────────────────────────┼────────────────────────────┼──────────────────────────┤ │
│ │ [Choose A]                      │ [Choose B]                 │ [Choose C]               │ │
│ └─────────────────────────────────┴────────────────────────────┴──────────────────────────┘ │
│                                                                                             │
│ 🤖 Why the Agent recommends A                                                               │
│ Option A meets the performance goal without interrupting the business. MySQL 8.0            │
│ supports ONLINE DDL, so 42M rows should take about 12 minutes. The added write              │
│ latency stays inside budget (SLA 50ms, currently 12ms). Option C is better long             │
│ term, but its 6h duration would slip this delivery — file it as tech debt.                  │
│ Confidence 82%: the open question is real production IO load — run it off-peak.             │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│ Evidence (4)                                                                                │
│ 📊 Slow-query analysis report   research-agent · 08-05     [View]                           │
│ 📄 Index impact analysis        code-agent-1 · 08-05       [View]                           │
│ 📄 Rollback script              code-agent-1 · 08-05       [View]                           │
│ 🔗 Production load monitoring   Grafana, live              [Open ↗]                         │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│ 📚 Similar past decisions (2)                                                               │
│ · 2026-05-12  User table index change  → created online   ✓ fine, took 8min                 │
│ · 2026-03-04  Order table repartition  → rejected, tuned the index instead                  │
│                                                           ✓ never came back                 │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│ 💬 Discussion (2)                                                                           │
│ 👤 Zhang Wei 13:02  When is off-peak? Please steer clear of the evening rush                │
│ 🤖 code-agent-1 13:03  Monitoring shows 02:00–05:00 has the fewest writes (~8%)             │
│ [                                                              ]        [Send]              │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│ [Reject] [Request revision] [Delegate ▾] [Pause task] [I will run it myself]                │
│                                    [Approve with constraints]  [✓ Approve Option A and run] │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Regions in Detail

### 5.1 Header and Impact Banner

Title, deadline status, risk, reversibility, owning project, owner, escalation status.

The **impact banner** quantifies the consequence in one sentence; it is the strongest driver of action on the page. Its content changes over time (the numbers update as the blockage grows).

### 5.2 Why This Needs You (doc 8.7.2)

**The triggering Policy and its conditions must be shown explicitly**, not a vague "approval required." Three reasons:

1. Only a user who understands the rule can judge whether the rule is reasonable — and then improve it
2. It provides a [View rule] entry point — if the user thinks this class of decision should not be reaching them, they can go change the rule directly
3. Governance transparency: an audit can trace back to exactly which rule demanded human involvement

It also shows what the Agent was doing at the moment of the trigger, with a link to the Run.

### 5.3 Background

A decision-context summary written by the Project Agent: the technical situation, the analysis already done, and how things got to this point.

**Write it for someone who has not been following the details of this project.** The decision owner (a DBA, say) is often not part of the project's day-to-day.

### 5.4 Option Comparison (the core region)

A side-by-side table; the comparison dimensions are chosen dynamically by decision type:

| Decision type | Comparison dimensions |
| --- | --- |
| Technical approach | Duration, risk, reversibility, cost, long-term benefit, complexity |
| Release approval | Blast radius, rollback plan, monitoring signals, rollout strategy, notification plan |
| Resource / budget | Cost, timeline, quality impact, alternatives |
| Scope change | Schedule impact, cost impact, value, dependency changes |

**Key design points**:
- The recommended option sits leftmost and carries a confidence score
- Differing values are highlighted (identical values are de-emphasized)
- **Irreversible items are marked in red** — this is the attribute humans most need to notice
- A "detail" mode expands the full write-up for each option

### 5.5 Agent Rationale

**It must state its uncertainty.** In the example above, "Confidence 82%: the open question is real production IO load" is far more useful than a bare 82% — it tells the human what to go verify.

This is what turns the Agent from a black-box recommender into a colleague who can say where they are unsure.

### 5.6 Evidence (doc 6.7, related evidence)

For each piece: type, name, producer, timestamp, and a view/open link.

Live evidence (monitoring dashboards) is labeled as live and gets a direct link — at the moment of decision, real-time data usually matters more than a report generated hours ago.

### 5.7 Similar Past Decisions

The system searches the decision history and shows: what was decided, what was chosen, and **how it turned out**.

"How it turned out" is the most valuable part (it comes from the project memory in doc 8.12, Knowledge Center). What a human most wants to know before deciding is how it went the last time someone did this.

### 5.8 Discussion

A mixed human–Agent thread. **The Agent can be @-mentioned and will answer** — in the example, Zhang Wei asks when off-peak is and the Agent answers immediately from monitoring data.

This is a real efficiency gain: nobody has to leave the page, look up a metric, and come back.

### 5.9 Decision Actions (doc 8.7.3)

The action bar at the bottom. **Approve with constraints** works like this:

```
Approve Option A with constraints

Constraints
 ☑ Execute only in the 02:00–05:00 off-peak window
 ☑ Take a full backup before executing
 ☑ Abort and roll back automatically if write latency exceeds 30ms
 ☐ Require human confirmation before downstream tasks continue
 + Custom constraint [                                        ]

These constraints will:
 · Be written to the execution constraints of Work Item "Database index change"
 · Be passed to the executor (👤 Wang Qiang)
 · Become acceptance checks

                                      [Cancel]  [Confirm approval]
```

**Constraints must be structured** (not a free-text note) if the system is to actually enforce and verify them. The candidate constraints are pre-generated by the Agent from the chosen option, so the user only ticks boxes — filling in a form is a cost that gets paid in skipped constraints.

### 5.10 Co-signing (multi-party approval)

When several people must approve, the page shows signing progress, each person's status, and their comments.

- Comments from people who have already signed are visible to later signers (independent judgment vs. speed — here we choose speed)
- When someone dissents, later signers see a prominent warning
- The decision only takes effect once everyone has signed

---

## 6. Core Interaction Flows

**Seriously evaluating a high-risk decision**

```
Arrive from the Decision Center → read the impact banner (5 tasks blocked)
→ read "why this needs you" (Policy #7)
→ compare options: A has no downtime but +8ms write latency; C is better
  long-term but slips the date
→ read the uncertainty in the Agent's rationale: production IO load
→ open the live monitoring evidence to check current load
→ @Agent in the discussion to ask when off-peak is
→ [Approve with constraints], tick "off-peak window" + "auto-rollback threshold"
→ constraints are written to the task; the executor is notified
```

**Rejecting and asking for a different approach**

```
None of the three options looks right → [Request revision]
→ write "evaluate leaving the index alone and moving to ES instead"
→ the Agent re-analyzes and updates the decision (produces v2)
→ the user is notified and comes back to decide again
```

**Delegating to someone better placed**

```
[Delegate ▾] → pick Li (senior DBA) → note "this touches partitioning, your call"
→ the original owner tracks it under "Delegated"
→ once the delegate acts, the original owner is notified of the outcome
```

---

## 7. State Design

| State | Handling |
| --- | --- |
| Pending | All actions available |
| Overdue | Red header + who it was escalated to; actions still available (the original owner retains authority) |
| Already handled by someone else | Whole page read-only + banner "Li Na approved Option A at 14:20" + the details of how it was handled |
| Handled (viewing after the fact) | Read-only: shows the outcome, the constraints, how execution went, and **the result feedback** (how the decision turned out later) |
| Co-signing in progress | Shows progress; if I have signed, my action area becomes "Approved, waiting on 2 others" |
| Linked task canceled | Banner at the top + the decision closes automatically |
| Options being revised (after a revision request) | Shows "Agent is re-analyzing…" + an ETA |
| Evidence failed to load | That one item shows as failed; the rest of the page is unaffected |

---

## 8. Permissions

| Action | Requirement |
| --- | --- |
| View | Project member + a party to the decision |
| Act (approve / reject / …) | The owner of this decision, or a co-signer |
| Delegate | The owner themselves / `pm` |
| Join the discussion | Project member |
| View sensitive evidence (production data) | Per data permissions; those without access see "No access" but the entry stays visible |
| Change the decision deadline | `pm` / `tech_lead` |
| Force-close the decision | `pm`, must give a reason, audited |

**Accountability cannot be exercised by proxy**: someone who is not the owner cannot approve directly, not even an `org_admin` — they can only reassign the owner (and the reassignment is itself audited). This is what keeps "who approved this critical decision" traceable, as doc 10.5 requires.

---

## 9. Data Dependencies

**Domain objects**: `Decision` (all fields), `Policy` (the triggering rule), `AgentRun` (the trigger source), `WorkItem`, `Artifact` (evidence), `Event`, historical `Decision` records (similarity search)

**Endpoints**

```
GET  /api/decisions/{id}
     → { decision, trigger: { policy, run_id, agent, context },
         background, options: [{ id, name, is_recommended, confidence,
                                 attributes{}, reversible, description }],
         recommendation_rationale, uncertainties[],
         evidence[], similar_decisions[], discussion[], co_signers[],
         impact: { blocked_tasks, critical_path_delay, projected_delay } }

POST /api/decisions/{id}/approve
     ← { option_id, constraints: [{ type, value, enforcement }], note? }
POST /api/decisions/{id}/reject             { reason }
POST /api/decisions/{id}/request-revision   { feedback }
POST /api/decisions/{id}/delegate           { assignee_id, note }
POST /api/decisions/{id}/take-over
POST /api/decisions/{id}/pause-task
POST /api/decisions/{id}/comments           { body, mentions[] }
GET  /api/decisions/{id}/similar            similar past decisions + outcomes
PATCH /api/decisions/{id}/due-at            { due_at, reason }

SSE  /api/stream?channels=decision:{id}
```

**Enforcing constraints**: `constraints` must be structured objects (`{type: 'time_window', value: '02:00-05:00'}`) so the Flow Engine can check them at scheduling time, the executing Agent can honor them at runtime, and the Review stage can verify them. A free-text constraint degrades to an "advisory constraint" and is marked as not automatically verifiable.

---

## 10. Instrumentation and Metrics

| Event | Purpose |
| --- | --- |
| `decision_detail_viewed{risk, from}` | Which kinds of decision get examined in depth |
| `option_selected{is_recommended}` | **Recommendation acceptance rate — the core measure of Agent decision quality** |
| `constraints_added{count, type}` | How often constraints are used, and which ones |
| `evidence_opened{type}` | Which evidence types actually get opened (the rest can be simplified) |
| `similar_decisions_viewed` | Whether past decisions are worth surfacing |
| `agent_mentioned_in_discussion` | Uptake of @Agent Q&A |
| `decision_detail_duration` | Time spent on deep decisions (separates "the card was enough" from "the detail page was necessary") |
| `revision_requested{reason_category}` | Where the Agent's options fall short |

**Success criteria for this page**: recommendation acceptance rate of 60–85% (too low means the Agent's options are bad; too high may mean humans are rubber-stamping); constraints attached on > 30% of approvals (evidence that humans are genuinely engaging rather than waving things through).

---

## 11. Edge Cases

| Situation | Handling |
| --- | --- |
| More than 4 options | The table scrolls horizontally; the recommended option is pinned on the left and does not scroll |
| Only one option | Drop the comparison table; use a vertical "description + risk + impact" layout and explain why there is no alternative |
| Agent has no clear recommendation (confidence < 60%) | Do not label anything "recommended"; show "The Agent listed options but has no clear preference. Reason: …" |
| Evidence file is very large | Inline preview of the first N lines + a download link |
| @Agent in the discussion but the Agent is unavailable | Show "The Agent is offline and will reply once it is back" |
| Decision is overdue and the critical path is already paused | Header shows "Critical path paused for 2h"; approval resumes it automatically |
| An approved constraint cannot be enforced by the system | Validate before saving; a non-enforceable constraint is marked "requires manual confirmation" and added to the acceptance checklist |
| A co-signer has left the organization | Automatically reassign to their manager, with the reason shown |
| The same decision is sent back for revision repeatedly (> 2) | Show "Re-analyzed 3 times already — consider talking it through or stepping in directly" |
| No similar past decisions found | Hide the region entirely; do not render an empty state |

---

## 12. Open Questions

1. The type system for structured constraints needs to be defined (time window, threshold abort, approval checkpoint, scope restriction, notification requirement, …). This is what decides whether constraints can actually be enforced; for MVP, define the 5–6 most common types first.
2. How to search for similar past decisions: semantic search vs. type + tag matching? The former works better but costs more. For MVP, match on the triple of type + resource + operation.
3. "How it turned out" has to be filled in after the decision is executed. Who triggers the fill-in — automatic linking to the execution result, or manual annotation? Leaning toward automatic as the default (task succeeded / failed / rolled back), with manual notes on top.
4. Answering in the discussion requires giving the Agent the decision context, which costs money. Should the number of @Agent calls per decision be capped?
5. Making earlier co-signers' comments visible to later ones can create an anchoring effect. Should high-risk decisions switch to blind signing (comments revealed only once everyone has signed)? This needs validation against real usage.
