# 07 Execution Graph

*[中文版本 / Chinese version](07-execution-graph.zh.md)*

## 1. Page Information

| Item | Value |
| --- | --- |
| Route | `/projects/:projectId/graph`<br>`?focus=:itemId` anchors on a node |
| Level | Third-level page |
| Primary roles | `pm` / `tech_lead` (main audience); `member` (looks at the chain they are on) |
| Priority | P1 (MVP ships a read-only version; editing can come later) |
| Product docs | 8.3.3 Execution graph generation, 8.6.2 Dependency management, 8.6.6 Delay forecasting |

---

## 2. Goal

The board answers "which column is each card in." The execution graph answers **"how are these cards related, and which chain decides when the project finishes."**

It has to answer:

1. Which path is the critical one? How much of it is left?
2. How much downstream work is a given blocker holding up?
3. What is running in series that could just as well run in parallel?
4. Where do the human approval gates sit, and are they the bottleneck?

**This is the project lead's primary tool for diagnosing "why is this slow."**

---

## 3. Ways In and Out

**In**: the "Execution graph" tab inside a project; the board's view switcher; the delay-risk card on the project overview; the dependency-graph view on the plan approval page; "View in execution graph" on a work item detail.

**Out**:

| Action | Destination |
| --- | --- |
| Click a node | `06 Work Item Detail` (side drawer — you stay in the graph) |
| Double-click a node | Expands the subgraph (if the node has subtasks) |
| Click an approval node | `11 Decision Detail` |
| Click the run badge on an agent node | `09 Agent Run Detail` |
| "Back to board" | `05 Autonomous Board` (filters carried over unchanged) |

---

## 4. Page Structure

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Order Refactor / Graph  [Layout: Layered ▾] [🔍 ──●──] [Fit] [Export]                  │
│ Show: [✓Critical] [✓Blocked] [ My tasks] [ High risk] Filter:[All phases ▾]            │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  Critical path 4.5d · 2.8d left · ⚠ 68% delay risk (main cause: decision wait 8h12m)   │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│   ┌──────────────┐                                                                     │
│   │✓ Slow query  │                                                                     │
│   │  log analysis│                                                                     │
│   │ 🤖 4h        │                                                                     │
│   └──────┬───────┘                                                                     │
│          │                                                                             │
│   ┌──────▼───────┐    ┌──────────────┐                                                 │
│   │✓ Search API  │    │🤖 Implement  │                                                 │
│   │  design      ├───▶│  query API   │──┐                                              │
│   │ 🤖 3h        │    │▓▓▓▓▓░ 65%    │  │                                              │
│   └──────────────┘    └──────────────┘  │   ┌──────────────┐                           │
│                                         ├──▶│⏸ Integration│                           │
│   ┌══════════════┐    ┌──────────────┐  │   │  tests       │                           │
│   ║⛔ DB index   ║    │⏸ Query      │  │   │🤖 not started│                           │
│   ║  change      ║───▶│  result cache│──┘   └──────┬───────┘                           │
│   ║ 👤 Wang Qiang║    │🤖 not started│             │                                   │
│   ║ blocked 8h12m║    └──────────────┘             │                                   │
│   ╚═══╦══════════╝                          ┌──────▼───────┐      ┌──────────────┐     │
│       ║                                     │◇ Multi-agent │      │◆ Prod release│     │
│   ┌═══▼══════════┐                          │  cross-review├─────▶│  approval    │     │
│   ║◆ DBA approval║  ⏰ Overdue 2h           └──────────────┘      │ 👤 Zhang Wei │     │
│   ║ 👤 Wang Qiang║  [Nudge] [Reassign]                            └──────┬───────┘     │
│   ╚══════════════╝                                                       │             │
│                                                                   ┌──────▼───────┐     │
│                                                                   │🚀 Canary     │     │
│                                                                   │  release     │     │
│  ═══ Critical path   ─── Dependency   ┄┄ Data dependency          └──────────────┘     │
│  ◆ Approval  ◇ Verification  ⏸ Waiting  🤖 Agent  👤 Human                            │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 💡 Findings in this graph (3)                                                          │
│ · ⛔ "DB index change" blocked 8h12m — 5 downstream tasks wait, 62% of critical path   │
│   → Fix: nudge DBA / reassign to backup / split off ready part            [See options]│
│ · ⚡ "Query result cache" has no real dependency on "Multi-filter API"      [Edit deps]│
│ · 👤 2 human approval gates on the critical path; avg wait 5.2h           [Tune Policy]│
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Regions in Detail

### 5.1 Nodes (product doc 8.3.3)

Seven node types, distinguished by shape *and* color — never by color alone, since some readers cannot tell the colors apart:

| Type | Shape | Icon | Notes |
| --- | --- | --- | --- |
| Human task | Rounded rectangle | 👤 | Executed by a person |
| Agent task | Rectangle | 🤖 | Executed by an agent |
| Approval node | Diamond (double border) | ◆ | Human gate |
| Automation node | Rectangle (dashed border) | ⚙ | CI, deploy, and other automatic steps |
| Waiting node | Circle | ⏸ | Waiting on an external condition |
| Verification node | Hexagon | ◇ | Test / review |
| Release node | Rectangle (heavy border) | 🚀 | Release |

**What a node shows** (varies with zoom level):

- Zoomed out: icon plus status color, nothing else
- Medium: icon + title (truncated) + status
- Zoomed in: adds executor, duration, progress bar, cost

**Status colors**: done green, executing blue (breathing), blocked orange, failed red, waiting gray, awaiting approval orange (pulses once).

### 5.2 Edges (product doc 8.3.3)

| Type | Style |
| --- | --- |
| Prerequisite (finish-to-start) | Solid arrow |
| Data dependency | Dashed arrow + data icon |
| Approval dependency | Double-line arrow |
| Trigger relation | Solid line + lightning icon |
| Retry relation | Curved self-loop |
| Rollback relation | Reversed red dashed line |

**The critical path**: nodes and edges along it are drawn with heavy double lines, so they stand out sharply against everything else.

### 5.3 Critical Path Bar

A single line at the top: total critical-path duration, time remaining, delay-risk probability, and **the main cause**.

That attribution — "main cause: decision wait 8h12m" — is this page's value condensed into one clause. It tells the lead directly what to go fix.

Click it to expand the full critical-path sequence as a list, each entry showing planned vs. actual elapsed time.

### 5.4 Highlight Modes

Multi-select toggles that stack:

| Mode | Effect |
| --- | --- |
| Critical path | The path thickens; everything off it drops to 40% opacity |
| Blocked chain | The blocked node and every node downstream of it get a red border, labeled "affects N tasks" |
| My tasks | Highlights nodes I own or that need a decision from me |
| High risk | Adds a red corner badge to nodes at high risk and above |
| Agent distribution | Colors nodes by agent (useful for spotting one agent carrying everything) |

### 5.5 Layouts

| Layout | Good for |
| --- | --- |
| Layered (default) | Left to right by dependency depth — the most immediately readable |
| Timeline | The horizontal axis is real time and nodes sit at their planned times, so parallelism and idle gaps become visible |
| Phase swimlanes | One lane per phase, matching the board's six phases |
| Executor swimlanes | One lane per agent or person — shows who the bottleneck is |

Switching layouts animates the transition (nodes glide to their new positions), which keeps the user's mental map intact.

### 5.6 Interaction

| Action | Behavior |
| --- | --- |
| Hover a node | Tooltip: full title, executor, status, elapsed, cost, reason it's blocked |
| Hover a node (highlight mode) | Every upstream and downstream path through that node lights up and the rest fades — **this is the single most effective way to understand a dependency graph** |
| Single click | Opens the work item detail in the side drawer |
| Double click | Expands / collapses the subgraph |
| Right click | Context menu: reassign, edit dependencies, split, nudge, locate on the board |
| Marquee select | Multi-select nodes → batch actions |
| Scroll / gesture | Zoom; `Fit` resets in one click |
| Drag the canvas | Pan |

### 5.7 Editing Dependencies (P1)

Read-only in MVP. P1 adds:

- Drag from a node's edge to another node to create a dependency
- Click an edge to delete the dependency
- Any change recomputes the critical path and duration live, and the header shows `Duration 4.5d → 3.8d ↓`
- Changes require [Apply changes] to confirm; that produces a new plan version which goes through `04 Plan Approval` (there is no way around plan approval)

### 5.8 Findings in This Graph

Diagnostics the system derives automatically from the graph structure. This is where the page earns the word "smart":

| Diagnostic | Trigger | Suggestion |
| --- | --- | --- |
| Blocker amplification | A blocked node has ≥ 3 downstream tasks | Nudge / reassign / split |
| False serialization | Two tasks with no data dependency scheduled in series | Run them in parallel |
| Approval bottleneck | A human node on the critical path whose historical wait exceeds the threshold | Adjust the policy, or add a backup approver |
| Single point of dependency | A node that ≥ 5 other nodes depend on | Schedule it earlier, or split it |
| Agent overload | One agent carries ≥ 60% of the critical path | Spread the work out, or raise concurrency |
| Dependency cycle | A cycle is detected | Must be resolved; execution is blocked until it is |

Every diagnostic carries an executable action. **We do not ship a diagnosis with no remedy attached.**

---

## 6. Core Flows

**Diagnosing a delay**

```
Project overview shows "68% delay risk" → click through to the execution graph
→ header reads "main cause: decision wait 8h12m"
→ turn on "Blocked chain" → the DBA approval is holding up 5 downstream tasks
→ right-click the approval node → [Nudge] / [Reassign to backup DBA]
```

**Improving parallelism**

```
Switch to the "Timeline" layout → lots of idle gaps show up
→ the findings panel says "Query result cache can run alongside Implement API"
→ [Edit deps] → delete that edge → duration 4.5d → 3.8d
→ [Apply changes] → goes through plan approval
```

**Understanding a task's blast radius**

```
Hover a node → its upstream and downstream chains light up
→ "if this one slips, here is exactly what slips with it"
```

---

## 7. States

| State | Handling |
| --- | --- |
| Loading | Skeleton graph (gray placeholder nodes); fades in once layout is computed |
| Plan not yet approved | Shows the draft plan's graph (read-only, watermarked "Draft") + [Go approve] |
| Fewer than 5 nodes | The graph adds little here: "Not many tasks yet — the board may serve you better" + a shortcut to it |
| More than 200 nodes | Collapsed to two levels by default, with a "Critical path only" shortcut mode; warns that performance may suffer |
| Dependency cycle | Every node in the cycle turns red, joined by red loop edges; a red banner blocks execution + [Let an agent fix it] [Break it manually] |
| Live updates | Status colors change, and completing a node sends a "current" animation once along its outgoing edges |
| Layout computation times out | Falls back to a plain layered layout and says so |

---

## 8. Permissions

| Action | Requirement |
| --- | --- |
| View | Project member / `viewer` |
| Edit dependencies (P1) | `pm` / `tech_lead`, and the change goes through plan-change approval |
| Right-click shortcuts | Same permission as the underlying action (reassigning needs `pm`, and so on) |
| Export image / JSON | Project member |

---

## 9. Data Dependencies

**Domain objects**: `Plan` (dependency graph and critical path), `WorkItem`, `Decision` (approval nodes), `AgentRun` (a node's run state)

**Endpoints**

```
GET /api/projects/{id}/graph?layout=layered&depth=2
    → { nodes: [{ id, type, title, status, assignee, duration, progress, cost, risk,
                   blocked_since, blocked_reason, parent_id }],
        edges: [{ from, to, type }],
        critical_path: [node_ids],
        metrics: { total_days, remaining_days, delay_risk, primary_cause },
        diagnostics: [{ type, severity, message, affected_nodes[], actions[] }] }

POST /api/projects/{id}/graph/simulate      preview the impact of a dependency change (nothing persisted)
     ← { changes: [{ op: 'remove_edge', from, to }] }
     → { new_duration, new_critical_path, conflicts[] }

POST /api/projects/{id}/graph/apply         produces a new plan version → goes through 04 approval
```

**Rendering**: MVP uses an off-the-shelf graph layout library (dagre / elkjs) with Canvas or SVG rendering. Above 100 nodes, switch to Canvas. Layout is precomputed and cached server-side; the front end only applies incremental updates.

---

## 10. Instrumentation and Metrics

| Event | What it tells us |
| --- | --- |
| `graph_viewed{entry_from}` | Where people arrive from — is this a diagnostic tool or a browsing tool? |
| `diagnostic_action_taken{type}` | **Adoption rate of the suggestions — direct evidence of whether the page's intelligence is worth anything** |
| `highlight_mode_used{mode}` | Which highlight modes are actually useful |
| `layout_switched{to}` | Layout preferences |
| `node_hover_depth` | Whether people use upstream/downstream highlighting to understand dependencies |
| `dependency_edited` (P1) | How often humans correct the AI's dependency judgments |

**Success criteria**: suggestion adoption rate > 40%; of users who arrive from the overview's delay-risk card, 70% take an action.

---

## 11. Edge Cases

| Situation | Handling |
| --- | --- |
| Graph is very sparse (almost no dependencies) | "Few dependencies between tasks — consider adding parallelism." This is actually good news |
| Graph is very dense (edges > 3× nodes) | Hide non-critical edges by default, with a "Show all dependencies" toggle |
| Subgraph nesting deeper than 3 | Expand only the subgraph of the node currently in focus; keep the rest collapsed |
| Nodes jump around during live updates | Layout stability wins: new nodes are inserted rather than triggering a full re-layout; re-layout only happens when the user asks for it |
| Multiple critical paths at once | Mark all of them, with a note at the top: "2 critical paths of equal length" |
| A plan change reshapes the graph substantially | Offer a [Diff against the previous version] mode |
| Export | PNG (legend included) and JSON (for outside analysis tools); PNG is what goes into the weekly report |

---

## 12. Open Questions

1. Does MVP need dependency editing at all? We lean read-only — adjusting dependencies ought to happen by *asking the agent to replan*, which fits the product's premise better. But users may find that too indirect.
2. Performance for large graphs (> 200 nodes) needs technical validation. Do we need server-side rendering or chunked loading?
3. Who maintains the diagnostic rules? Hard-coded rules vs. having the Project Agent generate diagnoses? The latter is more flexible but costly and unstable. We lean toward six hard-coded rules for MVP.
4. In the timeline layout, not-started tasks use planned times and finished ones use actual times — where do in-progress tasks go? Needs design.
5. Do we need "history replay" (scrub the timeline to see the graph as it stood at some past moment)? Very valuable for retrospectives, but expensive; suggest post-MVP.
