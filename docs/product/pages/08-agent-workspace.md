# 08 Agent Workspace

*[中文版本 / Chinese version](08-agent-workspace.zh.md)*

## 1. Page Information

| Field | Value |
| --- | --- |
| Route | `/agents` (list)<br>`/agents/:agentId` (workspace) |
| Level | Level-1 / level-2 page |
| Primary roles | `agent_owner` / `tech_lead` (configuration); all members (viewing) |
| Priority | P0 |
| Related product docs | 6.4 Agent, 8.5 Agent Workspace, 9.3 Agents and models, 10.3 Agent permissions |

---

## 2. Page Goals

Manage an agent as a **team member**, not as a configuration entry.

It has to answer:

1. What does this agent do? Where does its capability end?
2. What is it working on right now, and how is that going?
3. What is it allowed to do, and what is it not allowed to do?
4. How much has it cost? Is it worth it?
5. When something goes wrong, how do I step in?

**Design tone**: the page should read like an "employee file + workbench", not a "service settings page". This is where the product's claim that agents are first-class executors becomes concrete.

---

## 3. Entry and Exit

**Entry points**: the global `Agents` nav; the Agent Team panel on the project overview; the agent chip on a board card; the executor on a work item detail; Agent View.

**Exits**:

| Action | Destination |
| --- | --- |
| A task queue entry | `06 Work Item Detail` |
| A run record | `09 Agent Run Detail` |
| The Policy link on a permission item | `13 Policy Configuration` |
| "View performance analytics" | `12 Project Analytics` (agent dimension) |

---

## 4. Layout

### 4.1 Agent list `/agents`

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ Agents                                   [All projects ▾] [Type ▾] [Status ▾]  [+ Register]│
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ Cost this month $486  ·  Tasks 342  ·  Avg success 89%  ·  Takeover rate 7%                │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ Name              Type     Status    Load  Success  Takeover  Cost MTD  Owner              │
│ ────────────────────────────────────────────────────────────────────────────────────────── │
│ [🤖 code-agent-1] Code     ● Running 2/5   92% ▲    4%        $186      Zhang Wei          │
│ [🤖 code-agent-2] Code     ● Idle    0/5   96%      2%        $92       Zhang Wei          │
│ [🤖 test-agent-1] Test     ● Failed  1/3   71% ▼    18% ⚠     $58       Zhang Wei          │
│ [🤖 review-agent] Review   ● Idle    0/8   94%      3%        $104      Li Na              │
│ [🤖 research-1]   Research ● Idle    0/2   88%      9%        $46       Li Na              │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Anomalies come first**: agents with a falling success rate, a takeover rate over threshold, or abnormal cost are marked orange/red and sorted to the top. A row like `test-agent-1` is exactly what whoever is on operations most needs to see.

### 4.2 Agent Workspace `/agents/:agentId`

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ ← Agents   [🤖 code-agent-1]  ● Running                    [⏸ Pause dispatch] [⚙ Configure]│
│ Code Agent · claude-opus-5 · Owner 👤 Zhang Wei · Onboarded 2026-06-12                     │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ ┌─────────────┐┌─────────────┐┌─────────────┐┌─────────────┐┌─────────────┐┌─────────────┐ │
│ │ Current load││ Success     ││ First-try   ││ Takeover    ││ Avg cost    ││ Avg time    │ │
│ │  2 / 5      ││  92% ▲3     ││  78%        ││  4%         ││  $5.20      ││  14m        │ │
│ │ ▓▓░░░       ││ 23/25       ││             ││ 1/25        ││ MTD $186    ││             │ │
│ └─────────────┘└─────────────┘└─────────────┘└─────────────┘└─────────────┘└─────────────┘ │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ [Task Queue] [Runs] [Capabilities & Permissions] [Cost] [Evaluation]                       │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ Running (2)                                                                                │
│ ┌────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ 🔵 Implement multi-filter query API   Order System Refactor   12m   $8.20   ▓▓▓▓▓▓░65% │ │
│ │    Latest: implementing the index query logic                [Details] [Pause] [Abort] │ │
│ ├────────────────────────────────────────────────────────────────────────────────────────┤ │
│ │ 🔵 Fix the export encoding bug        Data Platform           3m    $1.10   ▓▓░░░░░22% │ │
│ └────────────────────────────────────────────────────────────────────────────────────────┘ │
│ Pending (3)      Blocked (2)      Awaiting human (1)      Failed (0)                       │
│ ┌────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ ⏸ Query result cache      Order System Refactor   blocked by "Multi-filter query API"  │ │
│ │ ⏳ Index design spec      Order System Refactor   awaiting DBA approval ⏰2h  [Nudge]  │ │
│ │ ⚪ Improve product search Storefront Refactor     queued · starts in ~25m              │ │
│ └────────────────────────────────────────────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ Last 30 days                                                                               │
│  Success rate  ▁▃▄▅▆▇▇▆▇▇█▇  92%          Cost/task  ▅▄▄▃▃▄▃▂▃▂▂▃  $5.20 ▼                 │
│  ⚠ 08-03 saw 3 failures in a row, all "context missing"                   [View analysis →]│
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Regions in Detail

### 5.1 Header

Agent name, type, model, owner, onboarding date, current status.

**[⏸ Pause dispatch]**: stop handing it new tasks; anything already running can either be left to finish or aborted immediately. A reason is required, and the owners of the affected projects are notified — pausing an agent directly changes what several projects can deliver.

### 5.2 The six metric cards (product doc 8.13.2)

| Metric | Meaning | Suggested alert threshold |
| --- | --- | --- |
| Current load | Running / max concurrency | Permanently maxed out → suggest scaling up |
| Success rate | Completed / total tasks | < 80% orange, < 70% red |
| First-try success rate | Share that succeeded with no retry | < 60% points at task-description quality or a capability mismatch |
| Takeover rate | Taken over by a human / total tasks | > 15% red |
| Average cost | Cost per task | +50% period over period → alert |
| Average duration | Time per task | +100% period over period → alert |

Each card carries a period-over-period trend arrow. Clicking one opens the matching breakdown in `12 Analytics`.

### 5.3 Tab: Task Queue (product doc 8.5.2)

Six groups: running, pending, blocked on dependencies, awaiting a human decision, failed, completed.

**Running** entries update progress, elapsed time, cost, and the latest event summary live, and offer [Details][Pause][Abort].

**Awaiting a human decision** entries have to show who is being waited on and for how long — which is what makes the reason an agent is idle visible: **an idle agent doesn't necessarily mean there is no work, it may mean nobody approved it**. That insight matters a great deal for tuning the flow.

**Failed** entries show the failure-reason category and what Policy does next.

### 5.4 Tab: Runs (product doc 8.5.3)

A run list, filterable by project, status, time, and cost:

```
Run ID   Task                                Project          Status     Time  Cost    Human
#1284    Implement multi-filter query API    Order Refactor   Running    12m   $8.20   —
#1283    Fix the export encoding bug         Data Platform    ✓ Done     8m    $3.10   —
#1281    Implement the order state machine   Order Refactor   ❌ Failed  4m    $2.10   retried
#1279    Refactor the payment callback       Order Refactor   ✓ Done     22m   $11.40  👤 taken over
```

Clicking a row opens `09 Agent Run Detail`.

### 5.5 Tab: Capabilities & Permissions (product docs 6.4, 10.3)

This is the most important governance surface on the page.

```
Basics
  Name          code-agent-1
  Type          Code Agent
  Model         claude-opus-5              [Switch model ▾]
  Runtime       Claude Code (MCP)          [Connection ✓]
  Owner         👤 Zhang Wei                ← who answers for this agent when it misbehaves

Capabilities
  Description   Backend implementation, refactoring, and writing unit tests
  Skills        [SQL tuning] [TypeScript] [REST API design] [Unit tests]  [+ Add]
                └ from the organization Skill library, reusable (product doc 8.12.2)
  Task types    Backend / Bugfix / Refactor / Unit Test

Callable tools
  ☑ read_file        ☑ write_file       ☑ run_tests
  ☑ git_commit       ☑ create_pr        ☐ merge_pr        ← merging is denied
  ☑ search_codebase  ☐ run_migration    ☐ deploy
  ☐ query_prod_db    ☐ send_email
                                              [Apply a template ▾] [Change history]

Permission scope
  Repositories  ✓ order-service (read/write)   ✓ shared-lib (read-only)   ✗ payment-core
  Environments  ✓ dev  ✓ test  ✗ staging  ✗ production
  Data          ✗ production database   ✓ test database   ✗ customer PII
  Outbound      ✗ sending email or messages to the outside world

  ⚠ A permission change re-evaluates every Policy that touches it       [Simulate impact]

Cost and limits
  Per-task cost ceiling  $15      On breach, [Pause and ask a human ▾]
  Daily cost ceiling     $80      So far today $18.40  ▓▓░░░░░
  Max concurrency        5
  Per-task timeout       30 min
  Retry policy           at most 2 retries, 1 min / 5 min apart
  3 failures in a row    → pause and notify 👤 Zhang Wei      [Edit Policy →]
```

**Key design points**:

1. **An agent's permissions are configured independently of any human user's** (product doc 10.3 requires this explicitly). The page deliberately offers no "inherit person X's permissions" option, so nobody can escalate by borrowing someone else's access.
2. **Denials are shown explicitly**, not just grants. The user needs to confirm at a glance that "it cannot merge code" and "it cannot reach the production database".
3. **A permission change gets a dry run first**: [Simulate impact] reports something like "this change flips the outcome of 3 Policies; 2 queued tasks will now need approval."
4. **The change history is auditable**: who gave this agent which permission, and when, has to be answerable.

### 5.6 Tab: Cost

Cost broken down by project, by time, and by task type. It shows:

- A cost trend line with the budget line drawn on it
- The top 5 most expensive tasks (drill down into the run)
- Cost composition (input tokens / output tokens / cache hit rate / tool calls)
- **Cost efficiency**: cost per *successful* task, side by side with other agents of the same type

The comparison is what makes it useful — `$5.20/task` on its own means nothing; `code-agent-2 runs $3.80/task and succeeds more often` is what actually drives a decision.

### 5.7 Tab: Evaluation (product doc 8.13.2, agent evaluation)

- Time series for success rate / first-try success rate / takeover rate
- **Failure-reason distribution**: missing context / capability mismatch / tool call failed / timeout / insufficient permissions / external service error
- **Performance by task type**: which kinds of task it is good at and which it is not (feeds the dispatch matching in 8.3.4)
- Human feedback rollup (from reviews and from takeover reasons)
- System suggestions, e.g. "this agent succeeds on only 52% of 'database migration' tasks — consider dropping that from its task types"

---

## 6. Core Interaction Flows

**Day-to-day operations**

```
Agent list → test-agent-1's takeover rate is flagged red at 18%
→ open its workspace → Evaluation tab → 62% of the failures are "missing context"
→ conclusion: this is not the agent's problem, it is the quality of the task descriptions
→ go to 03 Requirement Intake / 04 Plan Approval and tighten the breakdown granularity
```

**Tightening permissions (a governance scenario)**

```
A security audit requires it → Capabilities & Permissions tab
→ revoke write_file on shared-lib
→ [Simulate impact] → warns that 2 queued tasks are affected
→ Save → the change lands in the audit log and the project owners are notified
```

**Registering a new agent (product doc 9.3)**

```
[+ Register] → pick the integration (Claude Code / Codex / OpenHands / MCP Server / custom HTTP)
→ fill in the connection details → [Test connection]
→ the system probes the capabilities and tools the runtime declares
→ a human confirms the capability description, narrows the permissions,
  sets the cost ceilings, and names an owner
→ [Trial run]: run one sample task in a sandbox project to verify it
→ Enable
```

**The trial run is not optional** — dropping an unverified agent straight into a real project is too big a risk.

---

## 7. State Design

| State | Handling |
| --- | --- |
| Agent offline / connection failed | Red bar in the header: "Runtime connection failed, last connected 12 minutes ago" + [Retry connection][View diagnostics]; queued tasks automatically go back to waiting or get reassigned (per Policy) |
| No tasks (freshly registered) | The queue area shows "No tasks assigned yet" + [Assign a trial task] |
| Not enough samples for a metric (< 10 tasks) | Show "not enough data" rather than a misleading percentage |
| Dispatch paused | Yellow bar across the top of the page, with the pause reason and who paused it |
| Configuration saving | The save button goes into loading; permission fields are locked |
| Daily cost ceiling reached | Red bar: "Daily cost ceiling $80 reached, dispatch paused" + [Raise the ceiling (needs approval)] |

---

## 8. Permissions

| Action | Requirement |
| --- | --- |
| View the agent list and workspace | All members |
| View the capability and permission configuration | Project members (read-only); `agent_owner` / `tech_lead` (editable) |
| Change tools and permission scope | `agent_owner` / `tech_lead` |
| **Widening permissions** (a new tool, a new environment) | `tech_lead` + an audit entry; production access needs `org_admin` |
| Narrowing permissions | `agent_owner` alone (tightening is always safe) |
| Change cost ceilings | `agent_owner`; going past the project budget needs `sponsor` |
| Pause / abort a run | `agent_owner` / `tech_lead` / the `pm` of the project involved |
| Register a new agent | `org_admin` / `tech_lead` |
| Delete an agent | `org_admin`, and only once every project association has been removed |

---

## 9. Data Dependencies

**Domain objects**: `Agent` (all fields), `AgentRun`, `WorkItem` (the queue), `Skill`, `Tool`, `Policy`, `Event` (configuration-change audit)

**Endpoints**

```
GET   /api/agents?scope=&type=&status=
GET   /api/agents/{id}
      → { agent, metrics, queue: { executing[], pending[], waiting_dep[],
          waiting_decision[], failed[] }, trends }
GET   /api/agents/{id}/runs?project=&status=&cursor=
GET   /api/agents/{id}/evaluation
      → { success_by_task_type[], failure_reasons[], human_feedback[], suggestions[] }
GET   /api/agents/{id}/cost?group_by=project|day|task_type

PATCH /api/agents/{id}                       configuration change (audited)
POST  /api/agents/{id}/permissions/simulate  dry run of a permission change
POST  /api/agents/{id}/pause                 { reason, running_run_handling }
POST  /api/agents/{id}/resume
POST  /api/agents                            register
POST  /api/agents/{id}/test-connection
POST  /api/agents/{id}/trial-run             { sample_task_id }

SSE   /api/stream?channels=agent:{id}
```

---

## 10. Instrumentation and Metrics

| Event | Purpose |
| --- | --- |
| `agent_workspace_viewed{entry_from}` | When users actually start caring about an agent (it should cluster around trouble) |
| **`permission_changed{direction, field}`** | **The ratio of tightening to loosening — a governance-maturity signal** |
| `agent_paused{reason}` | The real distribution of agent stability problems |
| `trial_run_before_enable` | How often the trial-run step is actually performed (should be near 100%) |
| `evaluation_tab_viewed` | Whether users really make decisions off the evaluation data |
| `cost_comparison_viewed` | Uptake of the side-by-side cost comparison |

**Success criteria for this page**: 100% of new agents go through a trial run before being enabled; more than 80% of agents whose takeover rate crosses the threshold are dealt with within 7 days (retuned, restricted to fewer task types, or retired).

---

## 11. Edge Cases

| Situation | Handling |
| --- | --- |
| Declared capabilities don't match reality | The Evaluation tab flags "declared capability X has an actual success rate of 41%" and suggests removing it |
| One agent serving several projects | The queue groups by project; cost is apportioned by project; pausing spells out which projects are affected |
| Agent runtime version upgrade | Show the version change and mark the boundary in the evaluation (metrics before and after are counted separately) |
| A running task fails because permissions were tightened | The pre-change dry run warns about it; runs already in flight keep the permission snapshot they started with until they end |
| The cost ceiling trips while a task is halfway through | Let the current run finish (no half-built artifacts), but dispatch nothing new |
| Several people editing the configuration at once | Optimistic locking + a conflict prompt; a conflict on a permission field forces a refresh and a redo |
| An agent is deleted but its run history has to be kept | Soft delete: runs and audit records are kept forever, the agent is marked `已下线` (retired) |
| Malicious or anomalous behavior (a flood of denied attempts) | Automatic pause + a high-priority alert to `org_admin` and `agent_owner` |

---

## 12. Open Questions

1. The relationship between an agent's Skills and the organization Skill library needs to be pinned down (product doc 8.12.2 mentions Skill candidates). For MVP, do we do agent-level Skill tags only and skip the reusable library?
2. Where the "owner's" responsibility ends: when an agent causes a production incident, what does the owner carry? That has to be settled together with corporate compliance, but the product must at minimum guarantee that the responsible person is unambiguous and traceable.
3. Cost apportionment rules when several projects share an agent (charge each run to the project it belongs to vs. spreading fixed costs proportionally).
4. Where do the trial run's sample tasks come from? Do we need a built-in standard evaluation task set? That would be very valuable for comparing agents against each other.
5. The finest granularity for agent permissions: is tool-level enough, or do we need "a particular parameter range of a particular tool" (e.g. `write_file` restricted to one directory)? Leaning toward two layers for MVP: tool + resource scope.
