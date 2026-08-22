# Autonomous Project OS Page Documentation

*[中文版本 / Chinese version](README.zh.md)*

This directory is the page-level realization of [Product Functional Spec V0.2](../autonomous-project-os.md), covering the 14 MVP pages listed in Chapter 14.

This file defines the **global conventions** (navigation, routes, roles, shared components, state machine, interaction rules). Each page document describes only what is specific to that page; anything shared is referenced from here rather than repeated.

---

## 1. Page Inventory

| # | Page | Doc | Route | Priority |
| --- | --- | --- | --- | --- |
| 1 | Project List | [01-project-list.md](01-project-list.md) | `/projects` | P0 |
| 2 | Project Overview | [02-project-overview.md](02-project-overview.md) | `/projects/:projectId` | P0 |
| 3 | Requirement Intake & AI Clarification | [03-requirement-intake.md](03-requirement-intake.md) | `/projects/:projectId/requirements/:reqId` | P0 |
| 4 | Plan Approval | [04-plan-approval.md](04-plan-approval.md) | `/projects/:projectId/plans/:planId` | P0 |
| 5 | Autonomous Board | [05-autonomous-board.md](05-autonomous-board.md) | `/projects/:projectId/board` | P0 |
| 6 | Work Item Detail | [06-work-item-detail.md](06-work-item-detail.md) | `/projects/:projectId/items/:itemId` | P0 |
| 7 | Execution Graph | [07-execution-graph.md](07-execution-graph.md) | `/projects/:projectId/graph` | P1 |
| 8 | Agent Workspace | [08-agent-workspace.md](08-agent-workspace.md) | `/agents/:agentId` | P0 |
| 9 | Agent Run Detail | [09-agent-run-detail.md](09-agent-run-detail.md) | `/runs/:runId` | P0 |
| 10 | Human Decision Center | [10-decision-center.md](10-decision-center.md) | `/decisions` | P0 |
| 11 | Decision Detail | [11-decision-detail.md](11-decision-detail.md) | `/decisions/:decisionId` | P0 |
| 12 | Project Analytics | [12-project-analytics.md](12-project-analytics.md) | `/projects/:projectId/analytics` | P1 |
| 13 | Policy Configuration | [13-policy-config.md](13-policy-config.md) | `/projects/:projectId/settings/policies` | P0 |
| 14 | Project Integration Settings | [14-integration-settings.md](14-integration-settings.md) | `/projects/:projectId/settings/integrations` | P1 |

> The Home workbench (spec 8.1) is not built as a standalone page in the MVP; signing in redirects to `/projects`, and the Decision Center entry in the global nav carries the decision inbox. The full Home is Post-MVP.

---

## 2. Page Relationship Map

```
                              ┌──────────────────────┐
                              │ 01 Project List      │
                              └─────────┬────────────┘
                                        │ enter project
                              ┌─────────▼────────────┐
        ┌─────────────────────┤ 02 Project Overview  ├─────────────┐
        │                     └─────────┬────────────┘             │
        │                               │                          │
┌───────▼───────────────┐    ┌──────────▼──────────┐    ┌──────────▼───────────┐
│ 03 Requirement Intake │    │ 05 Autonomous       │    │ 12 Project Analytics │
│    & AI Clarification │    │    Board            │    └──────────────────────┘
└───────┬───────────────┘    └─────┬─────────┬─────┘
        │ requirement confirmed    │         │ switch view
┌───────▼──────────┐               │      ┌──▼──────────────────┐
│ 04 Plan Approval │               │      │ 07 Execution Graph  │
└───────┬──────────┘               │      └─────────────────────┘
        │ plan approved            │ click a card
        └─────────────────────┐    │
                          ┌───▼────▼──────────┐
                          │ 06 Work Item      │
                          │    Detail         │
                          └──┬─────────────┬──┘
                             │             │
        ┌────────────────────▼──┐   ┌──────▼───────────────┐
        │ 09 Agent Run          │   │ 11 Decision Detail   │
        │    Detail             │   └──────▲───────────────┘
        └───────▲───────────────┘          │
                │                          │
        ┌───────┴───────────────┐   ┌──────┴───────────────┐
        │ 08 Agent              │   │ 10 Decision          │
        │    Workspace          │   │    Center            │
        └───────────────────────┘   └──────────────────────┘

        Settings: 13 Policy Config ─ 14 Integration Settings ← 02 Project Overview / project settings
```

---

## 3. Global Navigation

Corresponds to the information architecture in Chapter 7 of the product spec. The bold entries are what the MVP implements.

```
Top bar: [Logo] [Project switcher ▾]      [Search] [Decision badge 🔔3] [Cost alert] [User ▾]

Left main nav:
├── Home              (MVP: redirects to Projects)
├── **Projects**      /projects
├── **Decisions**     /decisions        ← badge showing the pending count
├── **Agents**        /agents
├── Knowledge         (Post-MVP)
├── Analytics         (MVP: project level only, entered from inside a project)
└── Administration    (MVP: Policy / integrations only, entered from project settings)

Project sub-nav (appears once you are inside a project):
Overview | Board | Plan | Graph | Requirements | Agent Team | Decision Log | Analytics | Settings
```

**Decision badge**: the Decision Center's pending count is the highest-priority signal in the whole product, and it is visible from every page. A red dot appears whenever the count is greater than zero; if any decision is about to time out, the badge flashes once and turns orange.

---

## 4. Roles and Permissions

**Roles are data, not an enum**: the list below is the set of built-in roles that ship preconfigured. An org admin can define additional roles — engineering, operations, QA, whatever the team needs — on the Role Definitions page (`/projects/{id}/settings/roles`).

| Role | Description | Typical permissions | Who can hold it |
| --- | --- | --- | --- |
| `org_admin` | Organization admin | Everything; manage identities, **define roles**, model access, global Policy | Human |
| `sponsor` | Project sponsor / business owner | Confirm requirements, approve budget overruns, business acceptance, project closeout | Human |
| `tech_lead` | Technical lead | Approve plans, architecture decisions, handle repeated Agent failures, configure Policy | Human |
| `pm` | Project lead / project manager | Project settings, tighten Policy, scheduling adjustments, member management | Human |
| `member` | Project member (developer, etc.) | Claim and execute work, submit deliverables, take over from an Agent, handle decisions | Human |
| `executor` | Executor | Executes work only; takes no part in any decision or approval | Human / **Agent** |
| `agent_owner` | Agent owner | Configure the capabilities, permissions, and cost ceilings of the Agents they own | Human |
| `viewer` | Observer | Read-only | Human / Agent |

**The same role can be held by a human or by an Agent** — that is the basic shape of a hybrid team: the QA seat might be occupied by a person, or it might be `test-agent-1`. The members page groups the two separately but they share one set of roles.

Roles carrying Human Gate permissions (confirm a requirement, approve a plan, resolve a decision), however, **can never be granted to an Agent**. In the role editor those permissions are marked "humans only"; checking one locks the "may be held by an Agent" toggle and spells out exactly which permissions did it — rather than letting the user submit and get rejected by the server.

**Permission resolution order**: `org role → project role → resource-level Policy → data permissions (ABAC)`. A denial anywhere is a denial.

**Read-only degradation principle**: when you lack a permission, the page **is still visible** (unless data permissions forbid it), but every write control is grayed out with a tooltip reading 「需要 `tech_lead` 角色」 ("requires the `tech_lead` role"). We do not throw a full-page 403, because that leaves the user with no idea which permission they are missing.

**Implementation**: `GET /api/v1/projects/{id}/permissions` returns, in one call, every permission the current identity has in this project along with the reason for each denial; the front end uses `<GatedButton permission="...">` (`apps/web/src/components/Gated.tsx`) to gray the button and hang the reason on its tooltip. The resolution rules live on the server (`packages/domain/src/rbac/`) and the front end never recomputes them — a divergence between two implementations is either "clickable but doesn't work" or "works but isn't clickable."

While the answer is still in flight the button **stays gray** rather than starting enabled: an optimistic default lets a fast user click during that half-second of loading and collect a 403 dialog for their trouble.

**A grayed button is not a permission.** The server re-checks every write operation independently, so hitting the API directly, or running a stale front-end build, still gets a 403. Roles are edited on the Members & Roles page (`/projects/{id}/settings/members`).

---

## 5. Shared Component Specs

### 5.1 Human Gate Badge

Corresponds to spec 8.4.3. Used identically on cards, list rows, and detail-page headers.

| State | Label | Color | Icon |
| --- | --- | --- | --- |
| `approval_required` | Approval required | Orange | ⚠ |
| `waiting_for_decision` | Waiting for decision | Orange | ⏳ |
| `human_reviewing` | Human reviewing | Blue | 👁 |
| `human_took_over` | Taken over by human | Purple | 🙋 |
| `approved` | Approved | Green | ✓ |
| `rejected` | Rejected | Red | ✕ |
| `escalated` | Escalated | Red | ↑ |
| `decision_overdue` | Decision overdue | Dark red (flashing) | ⏰ |

**Rule**: an object shows exactly one Human Gate state at a time; `decision_overdue` has the highest priority and overrides whatever else would have been displayed.

### 5.2 Assignee Chip (who is doing the work)

Humans and Agents must be visually distinguishable — this is the single most important interface difference between this product and a conventional board.

```
Human:  (👤 Zhang Wei)         Round avatar + name
Agent:  [🤖 code-agent-1]      Square icon + name + status dot
Mixed:  (👤 Zhang Wei) ← [🤖 code-agent-1]   human reviews / Agent executes
```

Agent status dots: `● 空闲` (idle, gray) `● 执行中` (running, blue, with a breathing animation) `● 阻塞` (blocked, orange) `● 失败` (failed, red)

### 5.3 Risk Badge

`低` (low, gray) `中` (medium, yellow) `高` (high, orange) `极高` (critical, red). High and above are always shown on the card; low risk is hidden to keep the noise down.

### 5.4 Autonomy Badge

Corresponds to spec 8.9.4, shown in the project header:

- `Human-led` — humans drive (gray)
- `Agent-led + Approval` — Agents drive with approval at the key gates (blue, the default)
- `Agent-autonomous` — Agents run themselves (purple)

### 5.5 Update Source Tag

Spec 8.3.5 explicitly requires that the source of a status update be distinguishable. Every status change is tagged in the timeline:

`🔧 系统` (system) / `🤖 Agent` / `👤 人类` (human) / `🔗 外部同步` (external sync)

When a human changes a status by hand they **must give a reason** (spec 8.4.4), and that reason is recorded on the Event.

### 5.6 Cost Meter (spend and tokens)

One format everywhere: `$1.24 · 82.3k tok`. Past 80% of the project budget the numbers turn orange; at 100% they turn red and pick up an 「已超限」 ("over budget") tag. Hovering reveals the breakdown (model / input / output / cache).

### 5.7 Blocked Duration

`⛔ 阻塞 4h 12m` ("blocked 4h 12m"). Thresholds: < 2h gray, 2–8h orange, > 8h red. The blocking reason is the tooltip (one of the nine categories in spec 8.6.4).

### 5.8 Event Timeline

Work Item Detail, Agent Run Detail, and Decision Detail all use the same component.

```
│ ● 14:32  🤖 code-agent-1   Called tool read_file(src/api.ts)      [Expand]
│ ● 14:33  🤖 code-agent-1   Submitted deliverable PR #42           [View]
│ ● 14:35  🔧 System          Automated tests passed (48/48)        [Report]
│ ● 14:36  🔧 System          Policy #7 matched → human approval required
│ ● 15:02  👤 Zhang Wei       Approved, constrained to "canary 10%" [Details]
```

Supports filtering by source and by type, and jumping to the originating Run or deliverable.

### 5.9 Page States

Every page must define these four states; the "State design" section of an individual page document records only the differences:

| State | Default handling |
| --- | --- |
| Loading | Skeleton screen (layout must not jump); past 3s, explain what is taking so long |
| Empty | Icon + one-line explanation + **primary action button** (never a bare illustration) |
| Error | What went wrong + retry button + a "view event log" link |
| No permission | See the read-only degradation principle in §4 |

### 5.10 Live Updates

State in this product is driven by system events (spec 8.4.4), so no page may depend on the user hitting refresh.

- Transport: SSE (subscribe to the `project:{id}` / `run:{id}` / `user:{id}:decisions` channels)
- Update animation: new or changed elements highlight for 1.5s and then fade — **never auto-scroll**, which interrupts whatever the user is reading
- A form region the user is currently editing is not overwritten by a remote update; instead a banner appears at the top: 「该内容已被 Agent 更新，[查看差异] [使用最新]」 ("an Agent updated this content — [View diff] [Use latest]")
- Disconnection: a yellow bar at the top reading 「实时连接已断开，正在重连…」 ("live connection lost, reconnecting…"), followed by a catch-up fetch once it recovers

---

## 6. State Machine

### 6.1 The Six Phases and Their Work Item States

| Phase | States it contains | Who advances it |
| --- | --- | --- |
| **Intake** | `draft` `clarifying` `awaiting_requirement_approval` | Agent structures it → human confirms |
| **Planning** | `planning` `awaiting_plan_approval` | Project Agent generates → human approves |
| **Execution** | `ready` `executing` `blocked` `failed` | Agent / human executes |
| **Review** | `reviewing` `changes_requested` `awaiting_decision` | Review Agent / human |
| **Release** | `waiting_for_release` `releasing` `released` | Policy decides whether approval is needed |
| **Done** | `acceptance` `done` `cancelled` | Human business acceptance |

### 6.2 Normal Transitions (spec 8.4.4)

```
Work Item created             → ready
Agent Run starts              → executing
Agent finishes its output     → reviewing
Automated tests + Review pass → waiting_for_release
Release completes             → acceptance
Human business acceptance     → done
```

### 6.3 Exception Transitions (spec 8.6.5)

```
Agent Run fails                     → failed → (Policy) auto-retry / swap Agent / hand to a human
Dependency unmet                    → blocked
Matched a Policy requiring approval → awaiting_decision (creates a Decision object)
Decision times out                  → escalated → (escalation rules) notify up the chain / pause the critical path
Human takes over                    → executing (executor switches to Human)
```

---

## 7. Page Document Template

New page documents follow this structure:

```
1. Page info (route / roles / priority / corresponding product-spec chapter)
2. Page goal (one sentence + the core questions it must answer)
3. Entry and exit points
4. Page structure (ASCII wireframe)
5. Region-by-region detail (fields / data sources / interactions)
6. Core interaction flows
7. State design (only where it differs from the global conventions)
8. Permissions
9. Data dependencies (domain objects + endpoints)
10. Instrumentation and metrics
11. Edge cases and failures
12. Open questions
```

---

## 8. Design Principles That Run Through Every Page

1. **Answer "what do you need from me" before "what happened."** The top of every page belongs to the items awaiting a human; execution detail comes second.
2. **Humans and Agents must be visually distinguishable.** Anywhere the executor is shown, use the spec in §5.2.
3. **Every automated result is traceable.** Next to any status, deliverable, or conclusion there must be a link to the Run / Event / Policy that produced it.
4. **Never raise an alert with no action attached.** Every warning on a page carries a clickable next step.
5. **Manual actions leave a trail.** When a human overrides the system's judgment, the reason is recorded and lands in the Event stream and the audit log.
6. **Cost is always visible.** Any button that triggers Agent execution shows an estimated cost beside it.
