# 05 Autonomous Board

*[中文版本 / Chinese version](05-autonomous-board.zh.md)*

## 1. Page Facts

| Item | Value |
| --- | --- |
| Route | `/projects/:projectId/board` |
| Level | Third-level page (the most-used page inside a project) |
| Primary roles | All project members |
| Priority | P0 |
| Product docs | 8.4 Autonomous Board, 8.4.4 Cards Move Themselves, 8.6 Flow Engine |

---

## 2. Goal

Show the project's **actual flow**, and make it obvious at a glance where that flow is stuck.

What makes this fundamentally different from a traditional board:

| Traditional board | Autonomous Board |
| --- | --- |
| The user drags cards | **Cards move themselves**; the user corrects them now and then |
| A card is a to-do | A card is a process an agent is currently running |
| A human types in the status | Status is event-driven, and labeled with where it came from |
| Shows "who is working on it" | Shows "whether a human or an agent is working on it, and which gate it's stuck at" |

**Design red line**: if the user comes away thinking "I still have to drag cards around myself," this page has no reason to exist. Dragging is the exception path, not the main one.

---

## 3. Ways In and Out

**In**: the "Board" tab inside a project; the board icon on a project list card; the automatic redirect after a plan is approved; deep links from notifications.

**Out**:

| Action | Destination |
| --- | --- |
| Click a card | `06 Work Item Detail` (side drawer — you never leave the board) |
| Agent chip on a card | `09 Agent Run Detail` |
| Human gate badge on a card | `11 Decision Detail` |
| Switch view to "Execution Graph" | `07 Execution Graph` |
| Card's "View artifact" | External link (PR / test report / deployment record) |

---

## 4. Layout

```
┌───────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Order System Refactor / Board   [Kanban ▾] Filter:[All ▾][Risk ▾][Owner ▾] 🔍                [⚙ WIP]  │
│ ⚡ 2 need your decision  ⛔ 3 blocked  🤖 4 agents running                             [Needs me ○──] │
├──────────────┬──────────────┬────────────────────┬──────────────┬──────────────┬──────────────────────┤
│ Intake 2     │ Planning 1   │ Execution 7        │ Review 4     │ Release 2    │ Done 8               │
│              │              │ WIP 7/8 ⚠          │              │              │                      │
├──────────────┼──────────────┼────────────────────┼──────────────┼──────────────┼──────────────────────┤
│┌────────────┐│┌────────────┐│┌──────────────────┐│┌────────────┐│┌────────────┐│┌────────────────────┐│
││⚠ Approval  │││📋 Plan     │││🤖 Running        │││⚠ Approval  │││⏳ Awaiting │││✓ Completed         ││
││Bulk export │││change v3   │││Implement multi-  │││Prod release│││release     │││Analyzed slow query ││
││request     │││+6 tasks    │││filter query API  │││v1.4.0      │││approval    │││logs                ││
││            │││            │││[🤖 code-1]       │││🔴 High risk│││            │││                    ││
││👤 Li Na    │││👤 Zhang W. │││▓▓▓▓▓▓░░ 65%      │││👤 Zhang W. │││Cache layer │││[🤖 research-agent] ││
││🔴 2h late  │││⏳ within 4h│││12m · $8.20       │││[Handle →]  │││impl        │││✓ Accepted · Li Na  ││
││[Handle →]  │││[Handle →]  │││📎 PR #42         ││└────────────┘││[🤖 c-1]    │││Lead 6h · $1.20     ││
│└────────────┘│└────────────┘││Latest: 48/48     ││┌────────────┐│└────────────┘│└────────────────────┘│
│┌────────────┐│              ││tests passed      │││👁 Reviewing ││┌────────────┐│┌────────────────────┐│
││📥 New req  ││              │└──────────────────┘││UI component│││🚀 Releasing│││✓ Search API design ││
││Support     ││              │┌──────────────────┐││            │││            │││                    ││
││feedback    ││              ││⛔ Blocked 8h12m  │││[🤖 rev]    │││canary 10%  │││[🤖 code-agent-1]   ││
││batch job   ││              ││Order query API   │││+👤 Zhang W.│││▓▓▓░░       │││✓ Passed            ││
││            ││              ││Waiting on DBA    ││└────────────┘││            ││└────────────────────┘│
││Unanalyzed  ││              ││approval          ││              │└────────────┘│  ⋯ Show 6 more       │
││[Analyze →] ││              ││👤 Wang Qiang     ││              │              │                      │
│└────────────┘│              ││not responding    ││              │              │                      │
│              │              ││[Nudge][Reassign] ││              │              │                      │
│              │              │└──────────────────┘│              │              │                      │
│              │              │┌──────────────────┐│              │              │                      │
│              │              ││❌ Failed 2/3     ││              │              │                      │
│              │              ││Payment callback  ││              │              │                      │
│              │              ││test              ││              │              │                      │
│              │              ││[🤖 test-1]       ││              │              │                      │
│              │              ││1 more failure    ││              │              │                      │
│              │              ││→ human handoff   ││              │              │                      │
│              │              ││[Logs][Retry]     ││              │              │                      │
│              │              │└──────────────────┘│              │              │                      │
└──────────────┴──────────────┴────────────────────┴──────────────┴──────────────┴──────────────────────┘
```

---

## 5. Regions in Detail

### 5.1 Top Status Bar

**Not decoration — it's a set of entry points.** Each of the three numbers is clickable, and clicking one applies the matching filter:

- `⚡ 2 need your decision` → filter to cards waiting on the current user
- `⛔ 3 blocked` → filter to blocked cards
- `🤖 4 agents running` → filter to running cards

**The "Needs me" toggle** is the main entry point for the OPC and for busy users: flip it on and the board is reduced to the cards waiting for a human to call it, usually 2–5 of them.

### 5.2 Stage Columns (product doc 8.4.1)

Six columns by default: Intake / Planning / Execution / Review / Release / Done. An organization can configure them per project type (in `13 Policy Configuration` or in project settings).

**Column header shows**: stage name + card count + WIP limit (only when one is configured).

**Over the WIP limit** (product doc 8.6.3): the header turns orange and shows `WIP 7/8 ⚠`. Once the limit is reached the Flow Engine stops scheduling new work into that column, and the header says "At limit — 3 tasks queued."

**The Done column** shows only the 5 most recent cards by default, plus "Show N more," so that a long-running project doesn't grow an unbounded Done column.

### 5.3 Cards (product doc 8.4.2)

Card information density is the hardest design problem on this page. The principle: **let the state decide what to show, instead of showing every field on every card.**

| Card state | Foreground | Hidden |
| --- | --- | --- |
| Awaiting approval / decision | Human gate badge, time remaining, risk, [Handle] button | Progress bar, cost |
| Running | Agent chip, progress bar, elapsed time, cost so far, latest event | Dependencies, acceptance criteria |
| Blocked | How long it's been blocked, **why**, who owns the unblock, [Nudge][Reassign] | Cost, progress |
| Failed | Attempt count, what happens next, [Logs][Retry] | Progress |
| In review | Reviewers (agent + human), review progress | Cost |
| Done | Who did it, lead time, total cost, who accepted it | Everything else |

**Universal elements** (every card): title, work item type icon, priority (shown only for P0/P1), owner chip.

**Card height** stays roughly consistent (about 120–160px) to avoid a masonry-style visual mess. Anything that doesn't fit is elided and shown on the detail page.

### 5.4 Human Gate Markers (product doc 8.4.3)

Uses the eight states from §5.1 of the shared components doc. On the board, human gate cards get extra emphasis:

- A 4px orange/red bar down the left edge of the card
- `decision_overdue` cards pulse gently — once only, not a continuous blink; a continuously blinking card makes people close the page
- The card carries a `[Handle →]` primary button directly, so **you don't have to open the card first to find the button**

### 5.5 Cards Move Themselves (product doc 8.4.4)

Card movement is driven by events; the frontend animates on receiving the SSE message:

```
card fades out of its old column → slides along a path to the new column → highlights there for 1.5s → returns to normal
```

**Animation constraints**:

- When several cards move at once, stagger them (80ms apart) so the screen doesn't turn into noise
- If the user is dragging a card or has its detail open, that card's automatic move **waits until the interaction ends**
- Never auto-scroll the viewport to chase a card while the user is scrolling; show an edge-of-screen banner instead: "↑ 2 cards moved"

**Labeling where the move came from**: after a card moves, a source icon (🔧/🤖/👤/🔗) appears briefly in its corner and fades out after 3 seconds. Hover the card to see the full status change history.

### 5.6 Manual Adjustment (the Exception Path)

Users can still drag cards, but:

1. Dragging onto a column the state machine doesn't allow puts the target column into a red rejected state with the reason spelled out (e.g. "This task's dependencies aren't finished — it can't enter Execution")
2. An allowed drop **opens a reason prompt** (product doc 8.4.4 requires the reason to be recorded):

```
Move "Implement multi-filter query API" from Review to Execution

Reason  ( ) Review found problems, needs rework
        ( ) Requirements changed
        ( ) The system judged the state wrong
        (•) Other [                    ]

☐ Also terminate the running Review Agent

                    [Cancel]  [Confirm]
```

3. The reason goes into an event tagged `👤 human override`, and Analytics reports a "human override rate" from it — the key measure of how accurate the system's automation actually is

### 5.7 Filters and Views (product doc 8.4.5)

**Filter dimensions**: stage, work item type, owner (human / agent / a specific one), risk, priority, human gate state, blocked state, due date, cost range, task origin.

Filters are written into the URL, and can be saved as "my view" and shared.

**View switcher**:

| View | What it is | MVP |
| --- | --- | --- |
| Kanban | Default | ✅ |
| List | A table with multi-column sorting; good for bulk operations | ✅ |
| Execution Graph | Jumps to `07` | ✅ |
| Agent View | Swimlanes by agent | ✅ |
| Human Decision View | Human gate cards only, sorted by deadline | ✅ |
| Timeline | Gantt | P1 |
| Calendar | By due date | P1 |
| Risk View | Grouped by risk level | P1 |
| Delivery View | Grouped by milestone | P1 |

**Agent View** is the view unique to this product, and it deserves a closer look:

```
┌──────────────────────────────────────────────────────────────┐
│ [🤖 code-agent-1] ● Running   Load 2/5   Today $18.40        │
│  ├ Implement multi-filter query API   ▓▓▓▓▓▓░░ 65%   12m     │
│  └ Cache query results                Queued                 │
├──────────────────────────────────────────────────────────────┤
│ [🤖 test-agent-1] ● Failed    2 in a row                     │
│  └ Payment callback test    ❌ 1 more failure → human        │
├──────────────────────────────────────────────────────────────┤
│ [👤 Wang Qiang] DBA          1 decision pending ⏰ 2h late   │
│  └ Database index change approval                            │
└──────────────────────────────────────────────────────────────┘
```

### 5.8 Bulk Operations (List View)

Select several cards, then: reassign in bulk, adjust priority in bulk, add human review in bulk, retry failed tasks in bulk.

Before a bulk operation runs, show an impact estimate (e.g. "This will retry 3 tasks, at an estimated ~$6").

---

## 6. Core Interaction Flows

**The daily sweep**

```
open the board → scan the status bar for anything waiting on you
              → turn on "Needs me" → handle 2–3 cards → turn it off
              → glance at the Execution column for red (failed / blocked) → leave
(target: under 2 minutes)
```

**Handling a block**

```
spot the ⛔ 8h12m card → read the reason: "waiting on DBA approval"
→ hit [Nudge] right on the card (no need to open the detail page)
→ still no response → [Reassign] to a backup DBA
```

**Handling an agent failure**

```
❌ Failed 2/3 card → [Logs] → 09 Agent Run Detail opens in the side drawer
→ diagnose → pick one of three:
   [Add context and retry] / [Reassign to another agent] / [I'll take it over]
```

**Spectator mode (this product's signature experience)**

```
the user does nothing at all — the board is just open on a second monitor
→ cards slide from Execution to Review to Release on their own
→ this is the product's most convincing moment; animation quality directly
  shapes how the user perceives the system
```

---

## 7. State Design

| State | Handling |
| --- | --- |
| Loading | Column structure renders first, cards as skeletons |
| Plan not yet approved | The board shows guidance: "The plan isn't approved yet, so nothing will start flowing" + [Go approve] → `04` |
| Everything empty (plan just approved) | Intake/Planning have cards; every other column shows "Waiting on upstream tasks" |
| No filter results | Each column shows "No matches" + clear filters |
| Project paused | Full-page gray overlay + top bar: "Project is paused — cards won't move on their own" |
| SSE disconnected | Yellow top bar: "Live updates disconnected, reconnecting…"; cards show their last-updated time |
| Many cards moving at once | Staggered animation + a summary banner at the top: "6 cards updated" |

---

## 8. Permissions

| Action | Requires |
| --- | --- |
| View the board | Project member / `viewer` |
| Drag a card (human override) | `member` and above; a reason is mandatory |
| Nudge | Project member |
| Reassign a task | `pm` / `tech_lead` |
| Terminate an agent run | `tech_lead` / `pm` / `agent_owner` |
| Retry a failed task | `member` and above (cost counts against the project budget) |
| Configure WIP limits | `pm` / `tech_lead` |
| Configure stages (add/remove columns) | `pm` / `org_admin` |

---

## 9. Data Dependencies

**Domain objects**: `WorkItem`, `AgentRun` (progress and cost), `Decision` (human gate), `Agent`, `Event` (drives movement), `Policy` (WIP and state machine validation)

**Endpoints**

```
GET  /api/projects/{id}/board?view=kanban&filters=...
     → { stages: [{ key, name, wip_limit, count, items: [...] }] }

PATCH /api/work-items/{id}/status
     ← { to_status, reason, reason_category, terminate_running_run? }
     → 409 on a state machine violation, returning { allowed_transitions[], reason }

POST /api/work-items/{id}/retry
POST /api/work-items/{id}/reassign   { assignee_type, assignee_id }
POST /api/work-items/{id}/takeover
POST /api/decisions/{id}/remind

SSE  /api/stream?channels=project:{id}:board
     → work_item_moved { id, from, to, source, actor, reason? }
     → work_item_progress { id, progress, cost, elapsed, latest_event }
     → work_item_blocked { id, reason, blocked_since }
     → agent_run_failed { work_item_id, attempt, next_action }
```

**Performance**: a single project may hold thousands of work items. The board paginates per column (20 cards in the first screenful of each, more on scroll); Done is collapsed by default. SSE events are coalesced on the frontend — multiple progress updates for the same card within 200ms render once.

---

## 10. Instrumentation and Metrics

| Event | What it's for |
| --- | --- |
| `board_viewed` / `board_dwell_time` | Usage frequency and dwell time |
| **`card_manual_moved{from,to,reason}`** | **Human override rate — the core measure of how accurate the system's automated judgment is. It should fall over time** |
| `only_mine_toggled` | How much the "Needs me" toggle gets used |
| `card_action{action}` | Ratio of actions taken directly on a card vs. actions that required opening the detail page (the former should be far higher) |
| `view_switched{to}` | Which views actually get used, which sets the priority order for the P1 views |
| `blocked_card_action_latency` | How long a blocked card sits before someone deals with it |
| `auto_move_observed` | How many automatic moves happened while a user was watching (the reach of the "spectator experience") |

**Success criteria for this page**: human override rate under 15% and falling month over month; 80% of card actions completed on the board itself, without opening the detail page.

---

## 11. Edge Cases

| Situation | Handling |
| --- | --- |
| More than 50 cards in one column | Load on scroll + a second level of grouping within the column (by risk or by owner) |
| A card is deleted while the user is looking at it | The card fades out with "This task was merged into XXX" |
| The system moves a card while the user is dragging it | The user's action wins; on drop, show "The system moved this card to Review at the same time — your action overrode it" |
| Two people drag the same card at once | The second one fails with "Zhang Wei just moved it to Execution" |
| WIP is full and a high-priority task arrives | Don't preempt automatically; raise a decision instead: "WIP is full — raise the limit, or pause a lower-priority task?" |
| An agent's progress hasn't changed in a long time | The card shows "No update for 12 minutes" + [View run]; past the threshold, policy marks it blocked |
| Cost spikes while you're on the board | A red bar drops in at the top: "This project's cost grew $80 in the last hour" + [View breakdown] [Pause scheduling] |
| Stage configuration changes (columns added or removed) | Existing cards migrate by the mapping rules; anything that can't be mapped lands in a temporary `Unclassified` column with a prompt to sort it out |

---

## 12. Open Questions

1. Automatic card movement may become distracting when there are a lot of cards. Do we need a "quiet mode" (state updates without animation)? Leaning toward offering the toggle, with animation on by default.
2. Should manual dragging be disabled outright in `Agent-autonomous` projects? Leaning toward keeping it but adding a confirmation step — having a manual fallback matters more than being pure.
3. How long do cards stay in the Done column? This ties into the data archival policy.
4. How does Agent View relate to Kanban — a peer view, or a grouping mode of the board? Grouping may be the more natural framing.
5. Should "Needs me" be the default view? For the OPC yes; for a PM probably not — consider a per-role default.
