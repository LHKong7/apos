# 10 Human Decision Center

*[中文版本 / Chinese version](10-decision-center.zh.md)*

## 1. Page Information

| Item | Value |
| --- | --- |
| Route | `/decisions` |
| Level | Top-level page |
| Primary roles | All roles (everyone has their own decision queue) |
| Priority | P0 |
| Related product docs | 8.7 Human Decision Center, 8.7.1 Decision inbox, 11 Notifications and escalation |

---

## 2. Page Goals

**The one place where everything that needs a human lands.**

This is where the product's central promise is either kept or broken: *you don't have to watch the agents; when you're needed, we'll come find you.* If users still feel "I don't know when I'm supposed to step in," this page has failed.

It has to answer:

1. What is waiting on me right now, and which one is most urgent?
2. How much effort does each item cost me?
3. Are there recurring decisions I can turn into a rule so I never have to see them again?

**Design goal: a user can empty the day's decision queue in under 5 minutes.** That goal drives every interaction trade-off on this page — batch actions, keyboard shortcuts, and deciding from inside the card all exist to serve it.

---

## 3. Entrances and Exits

**Entrances**: the global `Decisions` nav item (with an unhandled-count badge); the decision badge in the top bar; the "needs you" section on the project list and project overview; deep links from notifications (Slack / Feishu / email / push).

**Exits**:

| Action | Goes to |
| --- | --- |
| Expand a decision card | Expands in place (no navigation), or opens `11 Decision Detail` |
| Related work item | `06 Work Item Detail` |
| Related run | `09 Agent Run Detail` |
| "Turn into a rule" | `13 Policy Configuration` (conditions pre-filled) |
| After a decision is handled | Stay on the page; advance to the next item automatically |

---

## 4. Page Structure

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│ Decision Center                                           [All projects ▾]  [⚙ Preferences] │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│ ⏰ Overdue 1   ⚠ Due <4h 2   📋 Pending 5   👥 Co-sign 1   ↗ Delegated 2   ✓ Week 18        │
├────────────────────┬────────────────────────────────────────────────────────────────────────┤
│ Category           │  Sort: [Urgency ▾]          [Batch process] [Keyboard mode ?]          │
│ ───────────────────│ ┌────────────────────────────────────────────────────────────────────┐ │
│ ● To me          5 │ │ ⏰ Overdue by 2h10m       🔴 High risk     Order System Refactor   │ │
│   Due soon       2 │ │ ────────────────────────────────────────────────────────────────── │ │
│   High risk      2 │ │ Approve the production database index change                       │ │
│   Co-sign        1 │ │                                                                    │ │
│   Delegated      2 │ │ Why you: production DDL — Policy #7 requires DBA sign-off          │ │
│ ───────────────────│ │ Cost of waiting: blocks 5 downstream tasks; the critical path      │ │
│ ○ Completed     18 │ │ is already 8h behind                                               │ │
│ ───────────────────│ │                                                                    │ │
│ By project         │ │ 🤖 Agent recommends: Option A · create the index online (82%)      │ │
│ Order Refactor   3 │ │    ~12 min, low table-lock risk, reversible                        │ │
│ Website Redesign 1 │ │    Alternatives: B maintenance window · C repartition table        │ │
│ Data Platform    1 │ │                                                                    │ │
│ ───────────────────│ │ Evidence: slow-query report · index impact · rollback   [View all] │ │
│ By type            │ │                                                                    │ │
│ High-risk op     2 │ │ [✓ Approve A] [Approve + constraints] [Pick another option]        │ │
│ Plan change      1 │ │ [Request revision] [Delegate ▾] [Reject]          [Full details →] │ │
│ Req. sign-off    1 │ └────────────────────────────────────────────────────────────────────┘ │
│ Release          1 │ ┌────────────────────────────────────────────────────────────────────┐ │
│                    │ │ ⚠ Due in 3h42m            🟡 Medium risk   Order System Refactor   │ │
│                    │ │ Plan change v3: 6 new tasks, +1.5 days                             │ │
│                    │ │ Why you: scope changed by more than 20% — owner must confirm       │ │
│                    │ │ 🤖 Recommends: approve (the new tasks are required fixes the       │ │
│                    │ │    security scan turned up)                                        │ │
│                    │ │ [✓ Approve] [Diff] [Request changes] [Delegate ▾]      [Details →] │ │
│                    │ └────────────────────────────────────────────────────────────────────┘ │
│                    │ ┌────────────────────────────────────────────────────────────────────┐ │
│                    │ │ 💡 Repeat decisions you could automate                             │ │
│                    │ │ You approved "release to the test environment" 12 times in the     │ │
│                    │ │ last 30 days — approved every one of them.                         │ │
│                    │ │ Create a rule: test env + automated tests pass → auto-approve      │ │
│                    │ │ and notify?                                                        │ │
│                    │ │                          [Create rule] [Stop suggesting] [Details] │ │
│                    │ └────────────────────────────────────────────────────────────────────┘ │
└────────────────────┴────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Regions in Detail

### 5.1 Top Statistics Bar

Six numbers, each clickable as a filter. `Overdue` is always first and always red — overdue decisions are the single biggest killer of flow in this system (product doc 8.13.3, "time blocked waiting on a human").

`✓ Week 18` is the positive half: it shows people what they actually contributed.

### 5.2 Category Sidebar (product doc 8.7.1)

| Category | Meaning |
| --- | --- |
| To me | I'm the owner and haven't handled it |
| Due soon | Due within 4h (threshold configurable in decision preferences) |
| High risk | Risk level high or above |
| Co-sign | Needs several approvers and I'm one of them |
| Delegated | Things I handed to someone else, kept here so I can track them |
| Completed | Things I've handled (for looking back) |

Two more filter axes on top: by project and by type. Types map to the ownership split in product doc 8.7.5 (business scope change, architecture change, database change, security exception, budget overrun, production release).

### 5.3 Decision Card (product doc 8.7.2)

**The card must answer all eight questions the product doc lists**, and the user must not have to open a detail page to see any of the answers:

| Question | Card element |
| --- | --- |
| What has to be decided | Title |
| Why a human has to decide it | The "Why you" line, naming the Policy that fired |
| What the agent recommends | "🤖 Agent recommends" plus a confidence figure |
| What the alternatives are | Alternatives list (collapsed) |
| What each option would do | Impact summary for the recommended option |
| What happens if nobody acts | The "Cost of waiting" line |
| The latest it can be handled | Deadline marker at the top of the card |
| Where the evidence is | Evidence links |

**"Cost of waiting" is the field most likely to be skipped and the most effective one there is** — it turns urgency from an abstract "high priority" into a concrete "blocks 5 tasks."

**Deciding from inside the card**: the common actions (approve / approve with constraints / pick another option) can all be completed on the card itself, with no trip to a detail page. Only decisions that need real evaluation should require "Full details."

### 5.4 Agent Recommendation and Confidence

A recommendation must carry three things: the option, its **confidence**, and the reasoning behind it.

Show confidence with restraint:
- ≥ 80%: display normally
- 60–79%: display with "medium confidence — worth checking the evidence"
- < 60%: don't call it a "recommendation" at all; say "the agent listed 3 options but has no clear preference"

**A low-confidence recommendation must never look as certain as a high-confidence one** — that erodes trust, and trust is what this product is built on.

### 5.5 Decision Actions (product doc 8.7.3)

| Action | Description | On card | On detail page |
| --- | --- | --- | --- |
| Approve | Approve the recommended option | ✅ | ✅ |
| Approve with Constraints | Approve and attach constraints (they're passed to the agent) | ✅ | ✅ |
| Edit | Modify the option, then approve | — | ✅ |
| Request Revision | Ask the agent for a new proposal | ✅ | ✅ |
| Delegate | Hand it to someone else | ✅ | ✅ |
| Take Over | Do it myself | — | ✅ |
| Pause | Pause the related work | — | ✅ |
| Reject | Reject it | ✅ | ✅ |
| Terminate | Terminate the task | — | ✅ |
| **Create Policy** | Turn this decision into a rule | ✅ | ✅ |

**Create Policy is this product's key lever** (product doc 3.2, "policy-driven, not approve-every-step"). Offer the entry point after every decision:

```
✓ Approved "release v1.4.0 to the test environment"

💡 You've approved 12 decisions like this one this year — every one approved.
   Create a rule and matching decisions get handled automatically, without
   bothering you again.

   When:  environment = test AND automated tests pass AND cost < $5
   Then:  auto-approve and notify you

                    [Create rule] [Not now]
```

### 5.6 Batch Processing

Select several decisions of the same kind and approve them together. **Limits**:

- Batch actions are allowed only on **low-risk** decisions **of the same type**
- High-risk decisions must be handled one at a time; a batch selection drops them automatically and says why
- Show an impact summary before the batch runs

### 5.7 Keyboard Mode

For heavy users (a PM or tech lead may work through 20+ decisions a day):

```
J / K      Next / previous
Enter      Expand the current card
A          Approve
C          Approve with constraints
R          Request revision
D          Delegate
X          Reject
G          Create a rule
?          Shortcut help
```

Handling one item advances to the next automatically, which gives the queue an assembly-line rhythm. This is what makes the "empty the queue in 5 minutes" goal reachable.

### 5.8 Repeat Decisions Worth Automating

The system watches for a user approving the same kind of decision over and over and proposes a rule unprompted. Detection:

- Same decision type + similar conditions
- At least 5 occurrences in the last 30 days
- At least 90% consistent outcomes

This card appears inline in the decision stream rather than in a section of its own — **acceptance is highest right after the user has just handled a decision of that kind**.

### 5.9 Decision Preferences

User-level settings:

- Notification channels and timing (immediate / digest / do-not-disturb windows)
- How far ahead "due soon" fires (default 4h)
- Default delegate (for time off)
- Auto-delegation rules (e.g. "if untouched for more than 8h, hand it to the backup owner")

---

## 6. Core Interaction Flows

**Emptying the daily queue (the target scenario)**

```
Notification → open Decision Center → keyboard mode
→ J to browse → A to approve → auto-advance → A → C (with constraints) → D (delegate) → …
→ queue empty → "6 handled today, 42s average"
(target < 5 minutes)
```

**Handling a high-risk decision**

```
See 🔴 High risk → card isn't enough → [Full details] → 11 Decision Detail
→ read the impact analysis, the evidence, similar past decisions
→ approve with the constraint "canary at 10% only, watch for 2h before scaling up"
→ the constraint is passed to the executing agent and written onto the work item
```

**Turning it into a rule (cutting future load)**

```
After approving, see the "worth automating" prompt → [Create rule]
→ jump to 13 Policy Configuration (conditions pre-filled)
→ adjust the conditions → [Simulate: would have handled 12 cases in the last 30 days, no exceptions]
→ enable → decisions like this stop appearing in the queue
```

**Delegation and escalation**

```
A decision arrives that's outside my area → [Delegate ▾] → pick Wang Qiang (DBA)
→ write a handoff note → the original owner tracks it under "Delegated"
→ if the delegate also runs out of time → escalation rules notify the project owner (product doc 11)
```

---

## 7. State Design

| State | Handling |
| --- | --- |
| Loading | Skeleton cards; the statistics bar renders first |
| **Empty queue** | **Important positive feedback**: "✓ All clear" plus this week's totals and the automation rate ("68% of items like these were handled by rules this week, saving you about 2 hours") |
| Only delegated / co-sign items left | Show the items being waited on and how far along they are |
| Decision handled by someone else | The card fades with "Li Na approved this a minute ago" and is removed after 3s |
| Auto-escalated after timing out | The card is marked "escalated to Zhang Wei" but stays in my list (it's still my responsibility) |
| Action fails (concurrent conflict) | "This decision has changed state" plus a refresh |
| Batch action partially fails | Show N succeeded, M failed, with the reason for each failure |

---

## 8. Permissions

| Action | Requirement |
| --- | --- |
| View my own decision queue | All users |
| View someone else's decision queue | `pm` (this project) / `org_admin` |
| Act on a decision | Must be the decision's owner or a co-signer |
| Delegate | The owner themselves / `pm` (reassignment) |
| Batch process | The owner; low-risk, same-type only |
| Create a rule | `tech_lead` / `pm` (Policy changes require permission) |
| Act on someone else's behalf | Forbidden. Only the formal delegation flow |

**The ban on acting for someone else is absolute** — responsibility for a decision has to attach to exactly one person, and that is the foundation of the audit requirements in product doc 10.5.

---

## 9. Data Dependencies

**Domain objects**: `Decision` (all fields, product doc 6.7), `WorkItem`, `AgentRun`, `Policy`, `Human` (owner resolution), `Event`

**Endpoints**

```
GET  /api/decisions?scope=mine&category=&project=&type=&sort=urgency&cursor=
     → { stats: { overdue, due_soon, pending, co_sign, delegated, completed_week },
         decisions: [{ id, title, type, risk, project, due_at, overdue_by,
                       why_you, consequence, recommendation: { option, confidence, rationale },
                       alternatives[], evidence[], available_actions[] }] }

POST /api/decisions/{id}/approve        { constraints?, note? }
POST /api/decisions/{id}/reject         { reason }  (required)
POST /api/decisions/{id}/request-revision { feedback }
POST /api/decisions/{id}/delegate       { assignee_id, note }
POST /api/decisions/{id}/select-option  { option_id, constraints? }
POST /api/decisions/batch               { ids[], action, note }
GET  /api/decisions/automation-suggestions
     → [{ pattern, occurrences, consistency, suggested_policy }]
GET  /api/me/decision-preferences  /  PATCH on the same path

SSE  /api/stream?channels=user:{id}:decisions
     → decision_created / decision_resolved_by_other / decision_escalated / decision_due_soon
```

---

## 10. Instrumentation and Metrics

These map to the Human-in-the-Loop metrics in product doc 8.13.3; this page is their main data source.

| Event | Purpose |
| --- | --- |
| **`decision_resolution_time`** | **Average decision time — the product's core metric** |
| `decision_overdue_count` | Overdue decisions (should trend down continuously) |
| `decision_action{action, from_card_or_detail}` | Share handled straight from the card (target > 70%) |
| `recommendation_accepted{confidence_bucket}` | **Acceptance rate by confidence band — calibrates the quality of agent recommendations** |
| `keyboard_mode_used` | How much heavy users reach for the efficiency tooling |
| **`policy_created_from_decision`** | **Rule conversion rate — whether the system is genuinely reducing human load** |
| `automation_suggestion_accepted` | Acceptance rate for automation suggestions |
| `queue_cleared_duration` | Time to empty the queue (target median < 5min) |
| `delegate_rate{type}` | Whether decisions land on the right owner (a high delegation rate means the ownership mapping in 8.7.5 is wrong) |

**Success criteria for this page**:
- Average decision time < 4h, overdue rate < 5%
- More than 70% of decisions handled directly from the card
- At least 2 policies per month created out of decisions, with the auto-handled share rising month over month

---

## 11. Edge Cases and Exceptions

| Situation | Handling |
| --- | --- |
| Queue backlog > 20 items | Banner: "large backlog — consider batch-processing the low-risk items or creating a rule," plus a one-click low-risk filter |
| User leaves items untouched for a long time | Escalate per the rules in product doc 11 at 4h / 8h / 24h; after 24h, pause the critical path and notify their manager |
| Owner leaves the company / account disabled | The decision moves to their manager or the project owner, marked "original owner unavailable" |
| The work item the decision depends on was canceled | The decision closes automatically, marked "related task canceled," and leaves the queue |
| Some co-signers have already approved | The card shows signing progress `2/3`; earlier approvers' comments are visible to those still to sign |
| Co-signers disagree | Escalate automatically to their common manager, with everyone's position attached |
| The same decision arrives over several notification channels | Notifications are deduplicated; handling it in any one channel retracts the rest |
| The agent's recommendation is clearly wrong | Offer a [Recommendation is wrong] feedback action that feeds agent evaluation data |
| An urgent decision during do-not-disturb | High-risk plus due-soon decisions break through; everything else is deferred per the settings |

---

## 12. Open Questions

1. Who generates the "cost of waiting" impact analysis? Having the Project Agent compute downstream blocking is workable, but business impact (say, "delays a customer launch") has to be annotated by a human or inherited from the requirement. Should the MVP cover technical impact only?
2. Confidence needs a defined and calibrated computation. Confidence figures from different agents aren't comparable — do we need a per-agent calibration mapping?
3. How co-sign disagreements resolve: majority rule vs. any-veto vs. escalation? Leaning toward configurable, defaulting to escalation.
4. The risk boundary for batch processing: even for low-risk items, should approving 20 at once require a second confirmation? Leaning toward confirming above 5.
5. "Pause the critical path" after a decision times out is a heavy action — should it be on by default? Leaning toward on by default but switchable off, because it's the only hard constraint that makes people take decision deadlines seriously.
6. The detection thresholds for automation suggestions (5 occurrences / 90% consistency) need validation against real data; the MVP can start conservative to avoid bad suggestions.
