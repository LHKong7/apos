# 12 Project Analytics

*[中文版本 / Chinese version](12-project-analytics.zh.md)*

## 1. Page Information

| Item | Value |
| --- | --- |
| Route | `/projects/:projectId/analytics` |
| Level | Third level |
| Primary roles | `pm` / `tech_lead` / `sponsor` |
| Priority | P1 (MVP ships the baseline metrics listed in product doc 12.2) |
| Related product docs | 8.13 Delivery Analytics, 8.6.6 Delay Forecasting, 12.2 MVP Baseline Analytics |

---

## 2. Page Goals

Analyze the **delivery system itself**, not the task count — product doc 8.13 says so in its first line.

Questions it has to answer:

1. Is work flowing? Where does it slow down?
2. How are the agents doing? Are they worth what they cost?
3. Is the human involvement necessary or redundant? How much time went into waiting on people?
4. Did we get better than last period?

**Design red line**: every chart has to lead somewhere — to an action someone can take. A chart that earns nothing but a "huh" does not ship.

---

## 3. Entrances and Exits

**Entrances**: the "Analytics" tab inside a project; drilling down from a metric card on the project overview; "View performance analysis" in the Agent Workspace; links inside weekly reports and digests.

**Exits**:

| Action | Destination |
| --- | --- |
| Drill into a bottleneck stage | The Work Item list for that stage |
| A specific task | `06 Work Item Detail` |
| Drill into an agent metric | `08 Agent Workspace` |
| Decision-wait analysis | `10 Decision Center` (pre-filtered) |
| Acting on an "optimization suggestion" | `13 Policy Configuration` / plan adjustment |
| Export | Weekly report PDF / data CSV |

---

## 4. Page Structure

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Order System Refactor / Analytics   [Last 30 days ▾] [Compare ☑]  [Export ▾] │
│ [Flow] [Agent] [Human-in-the-Loop] [Cost] [Quality]                          │
├──────────────────────────────────────────────────────────────────────────────┤
│ 💡 System findings (3)                                                       │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ 🔴 Decision waiting is 34% of total cycle (industry ref <15%), mostly DBA│ │
│ │    approvals. 12 of 12 approved in 30 days → rule it   [Create rule →]   │ │
│ │ 🟡 Review rework rate 22%; 68% of it from unclear criteria [View cases]  │ │
│ │ 🟢 Agent first-pass rate +11% vs last period, mostly from context tuning │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────────────────┤
│ Flow metrics                                                                 │
│ ┌────────────────┐┌────────────────┐┌────────────────┐┌────────────────┐     │
│ │ Lead Time      ││ Cycle Time     ││ Flow Efficiency││ Throughput     │     │
│ │  3.2 d         ││  1.8 d         ││   42% ⚠        ││  12 /wk        │     │
│ │  ▼0.6 improved ││  ▼0.3          ││   ▲5%          ││  ▲3            │     │
│ └────────────────┘└────────────────┘└────────────────┘└────────────────┘     │
│                                                                              │
│ Cycle time breakdown (where the time actually went)                          │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ Intake            ▓▓ 0.2d  6%                                            │ │
│ │ Planning          ▓▓▓ 0.3d  9%                                           │ │
│ │ Execution         ▓▓▓▓▓▓▓▓ 0.9d  28%   ← real work                       │ │
│ │ Awaiting decision ▓▓▓▓▓▓▓▓▓▓▓ 1.1d  34% 🔴 ← biggest bottleneck          │ │
│ │ Review            ▓▓▓▓▓ 0.5d  16%                                        │ │
│ │ Release           ▓▓ 0.2d  7%                                            │ │
│ │                                                                          │ │
│ │ Working time 44%  ·  Waiting time 56%   [Drill into decision wait →]     │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│ Cumulative flow diagram (CFD)          Blocked time trend                    │
│ ┌─────────────────────────┐            ┌─────────────────────────┐           │
│ │      ▁▂▃▄▅▆▇█ Done      │            │  ▃▅▂▇▄▂▁▃▂▁             │           │
│ │    ▂▃▄▄▅▅▅▅▅ Review     │            │  Peak 08-03: 18h        │           │
│ │  ▃▄▅▅▄▃▃▂▂▁ Execution   │            │  Cause: DBA approvals   │           │
│ └─────────────────────────┘            └─────────────────────────┘           │
│ WIP stable, Review column building up   [View blocked details →]             │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Regions in Detail

### 5.1 System Findings (top of the page, the most important region)

Conclusions produced by automated analysis, each paired with a suggested action. This is the bridge that turns data into behavior.

| Finding type | Example criterion | Suggested action |
| --- | --- | --- |
| Decision-wait bottleneck | decision wait / total cycle > 25% | Turn the repeated decision into a rule / add a backup owner |
| Rework rate too high | Rework Rate > 15% | Read the rework cases — they usually point at acceptance criteria or requirement quality |
| Agent behaving oddly | one agent's success rate down 10% period over period | Drill into the agent evaluation |
| Cost efficiency slipping | cost per task up 30% period over period | Open the cost breakdown |
| WIP piling up | a stage stays over its WIP limit | Adjust the WIP limit or add execution capacity |
| Improvement signal | any core metric improves materially | Positive feedback — name what we got right |

**Positive findings are mandatory.** An analytics page that only ever reports bad news is a page people learn to avoid.

### 5.2 Flow Metrics (product doc 8.13.1)

| Metric | Definition | Direction |
| --- | --- | --- |
| Lead Time | Requirement filed → delivered | Lower is better |
| Cycle Time | Execution started → done | Lower is better |
| Throughput | Work Items completed per unit time | Higher is better |
| WIP | Work in progress | Stable beats high |
| **Flow Efficiency** | Working time / total cycle time | **The single most important metric in this product** |
| Blocked Time | Total time blocked | Lower is better |
| Decision Waiting Time | Time spent waiting on a human decision | Specific to this product; watch it closely |
| Rework Rate | Reworked tasks / total tasks | Lower is better |
| On-time Delivery Rate | Share delivered on schedule | Higher is better |

**Why Flow Efficiency ranks first**: any traditional project management tool can push "tasks completed" up. What this product claims is different — that work should actually *flow*. If the agents are fast but 56% of the elapsed time is spent waiting for a human to click approve, the promise has not been kept. This metric measures the promise directly.

### 5.3 Cycle Time Breakdown

Where the time went, stage by stage. The most actionable chart on the page.

**Key design choice**: "awaiting decision" is its own line rather than being folded into whichever stage it happened in. It is the time loss unique to this product, so it has to be visible on its own.

The one-line summary at the bottom — "Working time 44% / Waiting time 56%" — lands harder than any chart above it.

### 5.4 Tab: Agent Metrics (product doc 8.13.2)

```
Agent performance, side by side
┌────────────────┬───────┬─────────┬──────────┬──────────┬──────────┬──────────┐
│ Agent          │ Tasks │ Success │ 1st pass │ Takeover │ Avg cost │ Avg time │
├────────────────┼───────┼─────────┼──────────┼──────────┼──────────┼──────────┤
│ code-agent-1   │ 25    │ 92%     │ 78%      │ 4%       │ $5.20    │ 14m      │
│ code-agent-2   │ 18    │ 96%     │ 89%      │ 2%       │ $3.80    │ 11m ✓    │
│ test-agent-1   │ 14    │ 71% ⚠   │ 50% ⚠    │ 18% ⚠    │ $4.10    │ 9m       │
│ review-agent   │ 32    │ 94%     │ 91%      │ 3%       │ $3.20    │ 4m       │
└────────────────┴───────┴─────────┴──────────┴──────────┴──────────┴──────────┘
💡 code-agent-2 beats code-agent-1 on success rate, cost and duration alike
   → Shift the scheduling weight, or diff the two configs   [Compare →]

Trends   Review pass rate ▇▇▆▇█▇  Agent utilization ▄▅▆▅▇▆  Token spend ▃▄▅▄▃▄
Failure causes   Thin context 42% · Wrong capability 24% · Tool failure 18% ·
                 Timeout 16%
```

**Side-by-side comparison is the whole point of this tab.** One agent's absolute numbers mean nothing; only the contrast tells you what to change about scheduling.

### 5.5 Tab: Human-in-the-Loop (product doc 8.13.3)

The most distinctive analysis dimension in this product:

```
Human involvement, overall
  Decisions 34   Avg time to decide 4.2h ⚠   Overdue 5   Automated 68% ▲
  Manual takeovers 6   Time blocked waiting on a human 38h

Human involvement by stage
  Intake     ████████████ 100%  (requirement confirmation, mandatory)
  Planning   ████████ 62%        (plan approval)
  Execution  ██ 12%              (exception handling)
  Review     ██████ 45%          (sampling plus mandatory reviews)
  Release    ██████████ 88%      (production release approval)

Decision response time distribution
  < 1h  ████████ 12
  1-4h  ██████████ 15
  4-8h  ████ 5
  > 8h  ██ 2  🔴 all of them DBA approvals

Top 3 repeated decisions                          Automation potential
  1. Test-env release approval  12x  100% approved   🟢 High   [Create rule]
  2. Low-risk copy change        8x  100% approved   🟢 High   [Create rule]
  3. Database change approval    5x   80% approved   🟡 Medium

Why humans took over
  Agent stuck in a loop 33% · Context misread 33% · Time pressure 17% · Other 17%
```

**"Automation potential" is where this tab lands.** It tells the user, in so many words, which work they can stop doing — and hands them a one-click path to a rule. This is the flywheel by which the product keeps lowering the human load.

### 5.6 Tab: Cost

- Cost trend plus budget burn forecast (at the current rate, when does it run out)
- Cost broken down by agent, by task type, and by stage
- **Cost per delivery**: average cost to complete one Work Item, compared across periods
- List of cost anomalies (a single Run over threshold)
- **Cost-benefit view**: agent spend against an estimate of the human hours saved (requires a configured labor cost baseline)

### 5.7 Tab: Quality

- First-pass rate (share that clears Review on the first try)
- Rework rate and the distribution of rework causes
- Automated test pass rate and coverage trend
- Issues found per Review Agent and how accurate those findings were (false-positive rate)
- Production traceback: incidents raised after release and the Work Items they trace to

### 5.8 Time Range and Comparison

One shared control: last 7 / 30 / 90 days / custom / by milestone.

**Compare to previous period is on by default** — the absolute number doesn't matter, the trend does. Every metric shows its period-over-period change.

---

## 6. Core Flows

**Prepping for the weekly meeting (PM)**

```
Pick "last 7 days" → read the system findings → paste them into the weekly report
→ export the PDF → discuss the decision-wait bottleneck in the meeting
→ afterward, hit [Create rule] and turn DBA approval into a rule
```

**Diagnosing a delivery slowdown**

```
Lead Time is up → cycle time breakdown → awaiting decision is 34%
→ drill down → Human-in-the-Loop tab → decision response distribution
→ everything over 8h turns out to be a DBA approval → two options:
   ├ rule it (auto-approve the low-risk cases)
   └ add a backup DBA owner
```

**Tuning agent configuration**

```
Agent tab → code-agent-2 beats code-agent-1 across the board
→ [Compare] → the difference is in the context retrieval strategy
→ go to 08 Agent Workspace and adjust code-agent-1
→ come back next period and check whether it moved
```

---

## 7. States

| State | Handling |
| --- | --- |
| Not enough data (project younger than 7 days, or fewer than 10 items done) | Show "Still gathering data — about N more tasks before the analysis is reliable," plus the raw counts we do have |
| Loading | Skeleton metric cards; charts load in batches |
| No comparison period | Hide the deltas, note "First period — comparison available next time" |
| No system findings | Show "Nothing unusual right now," plus the core-metric overview |
| A data source is unavailable (CI not connected, say) | That metric reads "Not connected" with a setup link — never a 0 |
| Export in progress | Progress indicator; large exports are generated asynchronously and notify when ready |

---

## 8. Permissions

| Action | Requires |
| --- | --- |
| View Flow / Agent / Quality | Project member |
| View cost | `pm` / `tech_lead` / `sponsor` (cost can be sensitive) |
| View per-person Human-in-the-Loop data | `pm` or above; members see only their own |
| Export | `pm` or above |
| Create a rule from a suggestion | `tech_lead` / `pm` |

**Protecting personal data**: decision response time and anything else that reads as individual performance is aggregated by default; per-person detail is visible only to `pm`. The point is to keep this page from being used as a monitoring tool — that is how you turn the team against the entire system.

---

## 9. Data Dependencies

**Domain objects**: `Event` (the raw source of every metric), `WorkItem`, `AgentRun`, `Decision`, `Agent`, `Project`

**Endpoints**

```
GET /api/projects/{id}/analytics/flow?range=30d&compare=true
    → { lead_time, cycle_time, throughput, wip, flow_efficiency, blocked_time,
        decision_waiting_time, rework_rate, on_time_rate,
        cycle_breakdown: [{ stage, days, percent }], cfd[], blocked_trend[] }

GET /api/projects/{id}/analytics/agents?range=30d
GET /api/projects/{id}/analytics/hitl?range=30d
    → { total_decisions, avg_resolution_time, overdue_count, automation_rate,
        takeover_count, blocked_by_human_hours,
        intervention_by_stage[], response_distribution[],
        repeated_decisions: [{ type, count, consistency, automation_potential, suggested_policy }],
        takeover_reasons[] }
GET /api/projects/{id}/analytics/cost?range=30d&group_by=
GET /api/projects/{id}/analytics/quality?range=30d
GET /api/projects/{id}/analytics/insights?range=30d
    → [{ severity, type, message, evidence, actions[] }]

POST /api/projects/{id}/analytics/export  { format, tabs[], range }
```

**Computation**: metrics are pre-aggregated off the event stream at hourly/daily grain. The page queries the pre-aggregated tables and never recomputes over the full history at request time. An hour of lag is acceptable; the page states "Data as of 15:00".

---

## 10. Instrumentation and Metrics

| Event | What it tells us |
| --- | --- |
| `analytics_viewed{tab, range}` | Which tabs actually get used — decides where the next investment goes |
| **`insight_action_taken{type}`** | **How often a system finding is acted on — the direct measure of this page's value** |
| `drill_down{from_metric}` | Which metrics people really drill into (the ones they don't can be demoted) |
| `policy_created_from_analytics` | Conversion from analysis to rule |
| `export{format, tab}` | The real shape of the reporting demand |
| `comparison_toggled` | How much the period-over-period comparison is used |

**Success criteria for this page**: findings are acted on more than 30% of the time; at least one Analytics-driven configuration change (a rule, a scheduling weight, a WIP limit) every month.

---

## 11. Edge Cases

| Situation | Handling |
| --- | --- |
| Short project, small sample | Label the low confidence plainly; draw no strong conclusions |
| A single outlier skews the average | Show the median alongside it; mark the outlier and make it clickable |
| Someone wants cross-project comparison | Not in MVP; point at "Cross-project analysis lives in org Analytics" (post-MVP) |
| A metric's definition is ambiguous | An ⓘ beside every metric explaining how it is computed and what is included or excluded |
| Historical data corrected after the fact (events backfilled) | Mark the chart "Data corrected" and keep the correction record |
| An agent switches models mid-period | Mark the change point on the trend line so it isn't misread as a swing in capability |
| A user disputes the numbers | Every metric drills down to the raw event list — fully verifiable, end to end |

---

## 12. Open Questions

1. How is "working time" defined for Flow Efficiency? Agent execution time counts as work, but what about time an agent spends waiting on an external API? The definition has to be pinned down.
2. Are the "system finding" rules hardcoded or configurable? This includes where the industry baselines come from (the "decision wait < 15%" figure, for instance) and whether they hold up.
3. Where does the labor cost baseline come from, the one the cost-benefit view needs? It requires org-level configuration and may be sensitive. Should MVP skip that view entirely?
4. The boundary on showing individual performance data needs sign-off from HR and compliance — in the EU and similar jurisdictions it can fall under employee-monitoring law.
5. MVP scope (product doc 12.2) calls for six things only: project progress, Lead Time, Blocked Time, agent success rate, manual intervention count, and agent cost. This document describes the finished shape, so we need to decide which tabs MVP actually ships. The suggestion: a simplified Flow tab, a simplified Agent tab, and Cost, with the full Human-in-the-Loop tab at P1 — it carries the most differentiating value, but it depends on having enough decision data to say anything.
