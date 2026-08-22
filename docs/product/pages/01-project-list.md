# 01 Project List

*[中文版本 / Chinese version](01-project-list.zh.md)*

## 1. Page Facts

| Item | Value |
| --- | --- |
| Route | `/projects` |
| Level | Top-level page (default landing page after sign-in) |
| Primary roles | All roles |
| Priority | P0 |
| Related product docs | 8.1 Home workspace, 6.1 Project, 8.9.4 Autonomy levels |

---

## 2. Purpose

One screen, three questions: **which projects do I have, which ones are in trouble, and what do I need to do right now.**

For the MVP this page doubles as the Home workspace (doc 8.1), so alongside the project cards it must carry a "Needs you" area — especially for OPC users, for whom this is the only page they need to open on a given day.

---

## 3. Ways In and Out

**In**: default after sign-in; clicking the logo in the header; the global `Projects` nav item.

**Out**:

| Action | Destination |
| --- | --- |
| Click a project card | `02 Project Overview` |
| Click the board icon on a card | `05 Autonomous Board` |
| Click a "needs my decision" row | `11 Decision Detail` |
| Click "New project" | New-project dialog → `03 Requirement Intake` |
| Click a risk callout | `02 Project Overview`, anchored to the risk section |

---

## 4. Page Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│  Projects                         [+ New project]  [cards | list ⇄]  │
├──────────────────────────────────────────────────────────────────────┤
│  ⚡ Needs you                                           View all →   │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ ⏰ Overdue 2h       Payment gateway     [Order rework]  [Open] │  │
│  │ ⚠ Needs approval    Prod release v1.4.0 [Website]       [Open] │  │
│  │ 👁 Needs sign-off    User export         [Data platform] [Open] │  │
│  └────────────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────────┤
│  Filters: [All ▾] [Status ▾] [Risk ▾] [Autonomy ▾] [My role ▾]  🔍   │
├──────────────────────────────────────────────────────────────────────┤
│  ┌────────────────────────────┐  ┌────────────────────────────┐      │
│  │ Order system rework      ⋯ │  │ Website redesign         ⋯ │      │
│  │ Agent-led + Approval       │  │ Human-led                  │      │
│  │ ────────────────────────── │  │ ────────────────────────── │      │
│  │ Health   ██████░░░░ 62 ⚠   │  │ Health   █████████░ 91     │      │
│  │ Progress ████████░░ 78%    │  │ Progress ███░░░░░░░ 31%    │      │
│  │                            │  │                            │      │
│  │ 👤 3  🤖 5 (2 running)     │  │ 👤 2  🤖 1 (idle)          │      │
│  │ ⏳ Pending 2  ⛔ Blocked 1 │  │ ⏳ Pending 0               │      │
│  │ $128.40 / $500  ▓▓▓░░      │  │ $12.80 / $200              │      │
│  │                            │  │                            │      │
│  │ ⚠ Critical path slip  High │  │ Milestone M1  6 days left  │      │
│  │ ────────────────────────── │  │ ────────────────────────── │      │
│  │ Zhang Wei · 3 min ago      │  │ Li Na · 2 hours ago        │      │
│  └────────────────────────────┘  └────────────────────────────┘      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 5. Areas in Detail

### 5.1 Needs You (Action Bar)

**Only items that require action from me personally.** No project activity feed, no Agent logs. This is the highest-priority area on the page.

| Field | Source | Notes |
| --- | --- | --- |
| Human Gate status | `Decision.status` / `WorkItem.human_gate` | Uses the shared component, §5.1 |
| Item title | `Decision.title` / `WorkItem.title` | Truncated when long, full text on hover |
| Owning project | `Project.name` | Clickable, jumps to the project |
| Time remaining | `Decision.due_at` | Once past due, shows "Overdue Xh" and pins to the top |
| Action button | — | Goes straight to the decision detail, no intermediate page |

**Sort order**: `overdue → due within 4h → high risk → everything else by due time`.

**Cap**: at most 5 rows; beyond that, show "N more →" linking to `10 Decision Center`.

**When empty**: the whole area collapses to a single green line — "Nothing needs you right now" — and takes up no vertical space.

### 5.2 Filters and Views

| Filter | Options |
| --- | --- |
| Scope | Projects I'm on (default) / Projects I own / All |
| Status | Active / Paused / Closed / Archived |
| Risk | Low / Medium / High / Critical |
| Autonomy level | Human-led / Agent-led + Approval / Agent-autonomous |
| My role | Sponsor / Tech lead / PM / Member |

Filter state is persisted into the URL query, so a filtered view can be shared as a link.

**List view**: the same card data as a table, plus two extra columns — "median lead time" and "delivered this week" — so managers can compare projects side by side.

### 5.3 Project Card

| Block | Fields | Source |
| --- | --- | --- |
| Header | Project name, autonomy-level badge, overflow menu | `Project` |
| Health | 0–100 score + bar + trend arrow | `Analytics.health_score` (doc 8.13.4) |
| Progress | Completed work items / total | `WorkItem` aggregate |
| Team | Humans, Agents, Agents currently running | `Project.members` / `agents` |
| Queue | Pending decisions, blocked work items | `Decision` / `WorkItem` aggregates |
| Cost | Spent / budget + progress bar | `Project.budget` (component, doc 5.6) |
| Risk line | The single highest-priority risk, or the next milestone | Risk engine / `Plan.milestones` |
| Footer | Owner + last activity time | Latest `Event` |

**Health colors**: ≥80 green, 60–79 yellow, <60 red. Below 60, the card also gets a 4px red bar down its left edge.

**Overflow menu**: open board / open Analytics / project settings / pause project / archive. "Pause project" halts all Agent scheduling, so it takes a second confirmation that spells out the consequences.

### 5.4 New Project

A lightweight dialog that collects only what it has to and leaves the rest for the Project Agent to infer:

```
Project name        [                    ]  *
Project goal        [                    ]  multi-line, optional
Project type        [R&D ▾]                 sets the default flow and Policy template
Autonomy level      (•) Agent-led + Approval  ← default
                    ( ) Human-led
                    ( ) Agent-autonomous      requires tech_lead
Budget cap          [$        ] optional
Business owner      [👤 ▾]
Tech lead           [👤 ▾]

            [Cancel]  [Create and enter requirements]
```

On creation the user goes straight to `03 Requirement Intake` rather than landing on an empty project page — nobody knows what to do when handed a project with nothing in it.

---

## 6. Core Interaction Flows

**First sign-in (no projects)**

```
Empty state → "Create your first project" + "Import from Jira / GitHub"
            → new-project dialog → requirement intake
```

**Day-to-day use (the OPC scenario, doc 8.1)**

```
Land → Needs-you area (today's calls to make) → work through it row by row
                                              ↓ done
     → Glance at card health scores → open only the projects with a red edge bar
```

**Manager scenario**

```
Switch to list view → sort by health → find the troubled project → open Analytics for the bottleneck
```

---

## 7. States

| State | Handling |
| --- | --- |
| Loading | Six card skeletons; the "Needs you" area loads independently and renders as soon as it arrives |
| Empty (no projects) | See §6, first sign-in |
| Empty (no filter matches) | "No projects match these filters" + a clear-filters button |
| Error | Keep the cached project cards, show a yellow bar at the top saying the refresh failed |

---

## 8. Permissions

| Action | Requirement |
| --- | --- |
| View a project card | Be a member of the project, or hold org-level `viewer` |
| Create a project | `org_admin` / `pm` / `sponsor` |
| Set Agent-autonomous | `tech_lead` or above (the option is grayed out in the autonomy dropdown for everyone else) |
| Pause / archive a project | `pm` or above |

Projects you are not on do not appear in the list by default. An `org_admin` can see them by filtering to "All", but the cards show with their internals redacted — the real data only appears after requesting to join.

---

## 9. Data Dependencies

**Domain objects**: `Project`, `Decision`, `WorkItem` (aggregate), `Event` (last activity), `Analytics.health_score`

**Endpoints**

```
GET  /api/projects?scope=mine&status=&risk=&autonomy=
     → { projects: [{ ...project, metrics: { health, progress, cost, blocked, pending_decisions } }] }

GET  /api/me/action-items?limit=5
     → { items: [{ type, id, title, project, human_gate, due_at, overdue_by }], total }

POST /api/projects
     ← { name, goal, type, autonomy_level, budget, sponsor_id, tech_lead_id }
     → { project_id, requirement_draft_id }

SSE  /api/stream?channels=user:{id}:action-items,projects:mine
```

**Performance**: project metrics come from a precomputed table; the page never aggregates them live. Staleness of up to 60s is acceptable, and the card notes "metrics updated X ago".

---

## 10. Instrumentation and Metrics

| Event | What it tells us |
| --- | --- |
| `project_list_viewed` | DAU, landing-page retention |
| `action_item_clicked{type, overdue}` | Whether the needs-you area actually gets used |
| `project_card_clicked{health_bucket}` | Whether the health score is steering people |
| `project_created{type, autonomy}` | The real distribution of autonomy-level choices |
| `time_to_first_action` | Time from landing to first click — the measure of whether the page is legible at a glance |

**Success criteria for this page**: 80% of sessions produce a meaningful click within 15 seconds; click-through on the needs-you area above 60%.

---

## 11. Edge Cases

| Situation | Handling |
| --- | --- |
| More than 50 projects | Paginate the card view (24/page) and suggest switching to list view |
| Health score not yet computed (project under 24h old) | Show "computing" rather than a score of 0, so new projects aren't all red |
| No budget set | The cost line shows spend only, with no progress bar |
| All Agents offline | The team block shows "🤖 5 (all offline)" in orange, and a system notice is inserted into the needs-you area |
| Project archived by someone else | Removed from the list in real time, with a toast: "Order system rework was archived by Zhang Wei" |
| A needs-you item handled by someone else first | The row fades and is labeled "handled by Li Na", then disappears after 3s |

---

## 12. Open Questions

1. The health-score formula (doc 8.13.4 lists ten dimensions but assigns no weights) needs sign-off from product and data. Should the MVP ship a simplified version first (progress 40% + blocked 30% + decision wait 30%)?
2. OPC users may only have one or two projects, where the card view buys little. Should a single-project user be routed straight to the project overview?
3. Should "Needs you" include items *I* delegated where the other party is now overdue? Leaning yes, but it has to stay consistent with how Decision Center categorizes them.
