# 09 Agent Run Detail

*[中文版本 / Chinese version](09-agent-run-detail.zh.md)*

## 1. Page Information

| Field | Value |
| --- | --- |
| Route | `/runs/:runId` (standalone page)<br>Can also open as a side drawer from the board or a detail page |
| Level | Level-4 page |
| Primary roles | `member` / `tech_lead` (troubleshooting); `agent_owner` (tuning) |
| Priority | P0 |
| Related product docs | 8.5.3 Agent Run, 8.5.5 Human takeover, 6.9 Event, 10.5 Audit log |

---

## 2. Page Goals

A **complete, replayable record** of one agent execution. This is where the product's "every action is traceable" principle (doc 3.2) actually lands.

It has to answer every question the doc asks for:

- What goal was it handed? What context did it get?
- Which tools did it call, and what did it do with them?
- Why did it fail, and at which step?
- How many tokens, how much money, how long?
- When did a human step in?
- What did it ultimately produce?

**Two kinds of readers, two depths**: a project lead only wants to understand "what did it do and how did it turn out"; an engineer needs the raw request and the tool arguments. The page has to serve both — default to the former, one click to the latter.

---

## 3. Entry Points and Exits

**Entry points**: the run list on a work item detail page; the run history in the Agent Workspace; "View log" on a board card; a deep link from a failure notification; the audit log.

**Exits**:

| Action | Destination |
| --- | --- |
| Parent work item | `06 Work Item Detail` |
| Executing agent | `08 Agent Workspace` |
| Artifact | External (PR / report) |
| Triggered decision | `11 Decision Detail` |
| Policy that fired | `13 Policy Configuration` |
| "Retry" | Creates a new run and jumps to it |

---

## 4. Page Structure

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ ← Multi-condition query API / Run #1284                     [Brief ⇄ Detailed] [Export] │
│ [🤖 code-agent-1] · claude-opus-5 · Running 12m34s                                      │
│ $8.20 · 82.3k tok (in 71.2k / out 11.1k / cache hit 62%)                                │
│                                       [⏸ Pause] [🙋 Take over] [⏹ Terminate] [🔄 Retry] │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░  Step 7/11 · Implementing index query logic                │
├──────────────────────────────────────────────┬──────────────────────────────────────────┤
│ [Stream] [Input] [Artifacts] [Cost] [Errors] │ Summary                                  │
│                                              │ ──────────────────────────────────────── │
│ ● 12:22:04  🚀 Run started                   │ Run ID     #1284                         │
│   Goal: one API for combined lookup by       │ Task       Multi-condition query API     │
│   phone number, order ID, time range         │ Project    Order System Rebuild          │
│   ▸ Expand full input                        │ Trigger    Flow Engine auto-dispatch     │
│                                              │ Attempt    2nd (previous one failed)     │
│ ● 12:22:09  🔧 Load context                  │ Status     Running                       │
│   3 knowledge docs · 12 code files           │ Started    12:22:04                      │
│   Failure reason from Run #1281              │ Elapsed    12m34s / timeout 30m          │
│   ▸ View context manifest                    │ ──────────────────────────────────────── │
│                                              │ Cost                                     │
│ ● 12:22:31  🛠 read_file                     │ Current    $8.20                         │
│   src/order/query.ts (284 lines)             │ Estimate   $6.40  ⚠ 28% over             │
│                                              │ Cap        $15.00 ▓▓▓▓▓▓▓▓░░ 55%         │
│ ● 12:23:02  🛠 search_codebase               │ ──────────────────────────────────────── │
│   "order query index" → 8 hits               │ Tool calls 14                            │
│                                              │  read_file        6                      │
│ ● 12:25:44  💭 Reasoning                     │  search_codebase  3                      │
│   Chose a composite index over sharding      │  write_file       3                      │
│   ▸ Expand reasoning                         │  run_tests        2                      │
│                                              │ ──────────────────────────────────────── │
│ ● 12:27:10  🛠 write_file                    │ Human intervention (1)                   │
│   src/order/query.ts  +142 −31               │ 👤 Zhang Wei 12:31 added constraint      │
│   ▸ View diff                                │ "10% canary only"          [Details]     │
│                                              │ ──────────────────────────────────────── │
│ ● 12:29:52  🛠 run_tests                     │ Artifacts (1)                            │
│   ✓ 48/48 passed · 84% coverage              │ 📎 PR #42  +284 −37                      │
│                                              │ ──────────────────────────────────────── │
│ ● 12:31:18  👤 Human intervention            │ Related                                  │
│   Zhang Wei added "10% canary only"          │ Policy #7 Prod release approval   [View] │
│   Agent acknowledged and adjusted            │ Previous Run #1281 (failed)    [Compare] │
│                                              │                                          │
│ ● 12:33:40  🛠 write_file                    │                                          │
│   src/order/index.sql  +18                   │                                          │
│                                              │                                          │
│ ○ In progress  Implementing index lookup…    │                                          │
│   ⠋ Running 1m12s                            │                                          │
└──────────────────────────────────────────────┴──────────────────────────────────────────┘
```

---

## 5. Region Detail

### 5.1 Header

Agent, model, status, elapsed time, cost, and a token breakdown (including the cache hit rate — it feeds straight into cost, so it is worth surfacing).

**Four action buttons** are the entry points for human intervention (doc 8.5.5):

| Button | Behavior |
| --- | --- |
| Pause | The agent suspends after finishing the current step, keeping its context; it can be resumed |
| Take over | See `06 Work Item Detail` §5.2 |
| Terminate | Stops immediately, with a confirmation; artifacts already produced are kept and labeled "from an unfinished run" |
| Retry | Creates a new run; you can pick retry as-is / retry with more context / switch agents |

**"Add a constraint"** (doc 8.5.5, "adding constraints"): append an instruction to the agent mid-run without interrupting it. This is a small capability that matters a lot — when a user sees an agent drifting, the first instinct is usually to *tell it something*, not to kill the run and start over.

```
Add a constraint to the running agent

[ Only touch order-service, leave shared-lib alone           ]

⚠ The agent will apply this after the current step ends (~40s)
   Steps already completed are not rolled back

                                          [Cancel]  [Send]
```

### 5.2 Progress Bar

Step N/M plus a description of the current step. The step count is planned by the agent itself and can change — when it does, show "planned steps adjusted from 9 to 11" so the user is not left puzzling over progress that appears to move backward.

### 5.3 Execution Stream (the core region)

A timeline. Each entry carries a timestamp, a type icon, a one-line summary, and expandable detail.

**Types and what they show**:

| Type | Icon | Shown in brief mode | Added in detailed mode |
| --- | --- | --- | --- |
| Run started | 🚀 | The goal | Full prompt, model parameters |
| Load context | 🔧 | How many context sources | Content and token count of each context item |
| Tool call | 🛠 | Tool name + key arguments + result summary | Full argument JSON, full return value |
| Reasoning | 💭 | The conclusion in one line | Full reasoning text |
| Sub-agent delegation | 🤝 | Sub-agent name + task | Link to the sub-run |
| Human intervention | 👤 | Who did what | The full context at the moment of intervention |
| Policy ruling | ⚖ | Rule matched + outcome | Rule conditions and the input values |
| Error | ❌ | Error summary | Stack trace, raw response |
| Artifact | 📎 | Artifact name + size | External link, metadata |

**The brief / detailed toggle** is the single most important switch on this page. In brief mode:

- Full reasoning text, raw tool arguments, and context details are hidden
- Consecutive calls of the same tool are merged (`read_file × 6` collapses to one row, expandable)
- Only the readable narrative of "what happened" survives

**Live append**: for a running run, new events are appended at the bottom. **Auto-scroll is off by default** (the user may be reading something further up); a "↓ 3 new events" button appears at the bottom instead. Scrolling to the bottom re-enables follow mode.

### 5.4 Tab: Input

- **Goal**: task description, acceptance criteria, constraints added by humans
- **Context manifest**: the source of each item (project knowledge / code file / prior run / requirements doc / external system), its token count, and whether the agent actually referenced it

The context manifest is the key troubleshooting artifact: **a great many failures come down to "we never gave it the thing it needed"**, and this list makes the gap obvious at a glance.

- **Model configuration**: model, temperature, max tokens, tool-set snapshot, permission snapshot

The permission snapshot matters — an agent's permissions may be changed after the run, and reconstructing what happened requires knowing what they were at the time.

### 5.5 Tab: Artifacts

Every artifact this run produced, including inline code-diff previews (no need to leave the page), test reports, generated documents, and screenshots.

Viewing the code diff in place beats bouncing out to GitHub and back by a wide margin.

### 5.6 Tab: Cost

- Token breakdown (input / output / cache read / cache write) with the corresponding unit prices
- A bar chart of cost by step — this is how you **find out which step is burning the money**
- Comparison against the historical average for the same agent on the same kind of task
- An attribution hint when the run overshoots its estimate (e.g. "context was 3.2× the average, mostly from 12 code files")

### 5.7 Tab: Errors (only shown for failed runs)

```
❌ Run failed · attempt 1 · 12:18:33

Failure class    Insufficient context
Failed step      Step 4/9 · search_codebase
Error summary    Could not locate the orders table definition; no schema
                 file found anywhere in the codebase

The agent's own account
"I needed the structure of the orders table to design the query index, but
 I could not find a migration or schema file in the order-service repo. It
 may live in a different repo, or be maintained separately by the DBA."

System ruling
  ⚖ Policy #12 "Agent failure handling" → retry permitted (1/2)
  Retry Run #1284 created automatically, with added context:
  knowledge-base article "Orders table schema"

▸ Expand raw error and stack trace

  [Retry with more context] [Reassign] [Hand to a human] [Flag as a requirements problem]
```

**"The agent's own account"** is the key design here: having the agent explain in plain language why it got stuck is far more useful than a stack trace. It is the heart of troubleshooting efficiency on this page.

### 5.8 Right-Hand Summary Panel

Run metadata, cost, tool-call statistics, human interventions, artifacts, and related objects (policies, the previous run, decisions this run triggered).

**"Compare with the previous run"**: in a failure-and-retry situation, diff the two runs' context and execution paths to see quickly whether the context you added actually made a difference.

---

## 6. Core Interaction Flows

**Diagnosing a failure (engineer)**

```
Arrive from the board via [View log] → Errors tab
→ Read the agent's account → conclude it is a context problem
→ Input tab confirms the context manifest really is missing the schema
→ [Retry with more context] → pick the knowledge entries to add → new run starts
```

**Supervising a running run (project lead)**

```
Brief mode → skim the execution stream → notice the agent editing a repo it shouldn't
→ [Add a constraint] "Only touch order-service" → takes effect in 40s
→ keep watching → looks fine → leave
```

**Investigating a cost anomaly**

```
28% over estimate → Cost tab → cost by step
→ "Load context" accounts for 62% → Input tab, check the context manifest
→ 12 irrelevant code files were pulled in
→ report back to the agent's owner to tune the context retrieval strategy
```

**Audit reconstruction (compliance)**

```
Audit log → locate a particular production change → open the corresponding run
→ Detailed mode → inspect the permission snapshot, policy rulings, and human approvals as of that moment
→ export as an audit report
```

---

## 7. State Design

| State | Handling |
| --- | --- |
| Running | Events append live; progress bar and cost update live; all action buttons available |
| Completed | The execution stream is fully replayable; actions narrow to [Retry][Export] |
| Failed | Opens on the Errors tab by default (don't make the user hunt for it); offers the four remedies |
| Terminated | Records who terminated it and why; artifacts already produced are labeled "from an unfinished run" |
| Paused | Shows how long it has been paused plus [Resume][Terminate]; indicates that context is being held |
| Timed out | Labeled "terminated on timeout (30min)" plus suggestions (split the task / raise the timeout / switch models) |
| Very large event count (> 1000) | Virtual scrolling plus "Jump to failure" and "Jump to end" shortcuts |
| Not permitted to see detailed mode | Brief mode is visible; detailed mode (which includes the raw prompt) requires `tech_lead` |

---

## 8. Permissions

| Action | Requirement |
| --- | --- |
| View a run (brief mode) | Project member |
| View detailed mode (raw prompt, tool arguments, full context) | `tech_lead` / `agent_owner` (may contain sensitive data) |
| Pause / terminate | `tech_lead` / `pm` / `agent_owner` |
| Add a constraint | `member` and above |
| Take over | `member` and above |
| Retry | `member` and above (the cost counts against the budget) |
| Export the run record | `tech_lead`; the export itself is audited |

**Data masking**: if the context contains sensitive data (customer PII, secrets), it is masked automatically according to its data classification. Only `org_admin` may request the original, and that view is audited.

---

## 9. Data Dependencies

**Domain objects**: `AgentRun` (all fields, doc 8.5.3), `Event`, `Artifact`, `Agent`, `WorkItem`, `Policy` (ruling records)

**Endpoints**

```
GET  /api/runs/{id}
     → { run, agent_snapshot, permission_snapshot, input: { goal, context[], model_config },
         metrics: { tokens, cost, duration, tool_calls }, artifacts[], interventions[],
         error?, related: { policies[], previous_run, triggered_decisions[] } }

GET  /api/runs/{id}/events?level=brief|detailed&cursor=&after=
GET  /api/runs/{id}/cost-breakdown?group_by=step
GET  /api/runs/{id}/diff/{otherRunId}          compare with the previous run

POST /api/runs/{id}/pause
POST /api/runs/{id}/resume
POST /api/runs/{id}/terminate      { reason }
POST /api/runs/{id}/constraints    { constraint }        append a constraint mid-run
POST /api/runs/{id}/retry          { additional_context[], agent_id? }
GET  /api/runs/{id}/export?format=json|pdf

SSE  /api/stream?channels=run:{id}
     → run_event { seq, ts, type, summary, detail_ref }
     → run_progress { step, total, description, cost, tokens }
```

**Event storage**: run events are voluminous and have to be retained for a long time (audit requirement). The suggested split is hot data (30 days) in the primary database and cold data archived to object storage, loaded by the page on demand.

---

## 10. Instrumentation and Metrics

| Event | Purpose |
| --- | --- |
| `run_detail_viewed{status, entry_from}` | Under what circumstances users open a run (failures should dominate) |
| **`mode_switched{to: detailed}`** | **Whether brief mode is good enough — a high switch rate means brief mode is under-informative** |
| `constraint_added` | How often "add a constraint" gets used, and in what situations |
| `retry_with_context{context_added}` | How much adding context lifts the retry success rate |
| `error_tab_action{action}` | The distribution across the four remedies |
| `cost_breakdown_viewed` | Adoption of cost diagnosis |
| `run_export{format}` | Audit and reporting demand |

**Page success criteria**: for failed runs, > 75% settle on a remedy within a single action on this page; detailed-mode switch rate < 30% (meaning brief mode is doing its job).

---

## 11. Edge Cases and Exceptions

| Situation | Handling |
| --- | --- |
| The event stream stops (agent runtime crashed) | Show "event stream interrupted, last event 3 minutes ago" plus [Check agent status]; after the timeout, policy declares it failed |
| A single tool returns an enormous payload | Collapse to the first 200 lines plus [View full][Download] |
| Context contains sensitive data | Mask automatically and label "masked, 3 occurrences" |
| Several people act on the same run at once | Serialize the actions; the later one is told "Zhang Wei just paused this run" |
| The run has been archived (past the hot-data window) | Loads a little slower, showing "loading from archive…"; action buttons are disabled (you cannot retry an archived run) |
| Sub-agent delegation nests deeply | Sub-runs render as an indented tree, collapsed beyond 3 levels |
| Cost spikes abnormally within a single run | Insert a red warning event into the stream: "cost has reached 80% of the cap"; hitting the cap auto-pauses per policy |
| Still failing after retries (limit reached) | The Errors tab shows a banner: "retry limit reached, policy escalated to a human" plus a link to the decision |

---

## 12. Open Questions

1. "The agent's own account" requires the agent runtime to emit a structured failure explanation. Different agent integrations (Claude Code / Codex / custom) vary in what they can produce — should the unified Agent Protocol (doc 9.3) make that field mandatory? Leaning toward mandatory, degrading to the raw error when it is missing.
2. Event retention and archival policy needs to line up with compliance requirements (audits typically demand 1–3 years).
3. The semantics of "add a constraint": inject it into the next turn of the conversation, or restart the run carrying the new constraint? The former is faster but may be ignored; the latter is reliable but throws away work already done. Leaning toward the former, with a requirement that the agent explicitly acknowledge it.
4. Detailed mode exposes the raw prompt, which may reveal internal prompt engineering. Should whether it can be viewed be configurable per organization policy?
5. The value of run comparison needs validation — is it worth building for the MVP? Leaning P1.
