# 14 Project Integration Settings

*[中文版本 / Chinese version](14-integration-settings.zh.md)*

## 1. Page Information

| Item | Value |
| --- | --- |
| Route | `/projects/:projectId/settings/integrations` (project level)<br>`/admin/integrations` (org-level connection management) |
| Level | Third-level page |
| Primary roles | `pm` / `tech_lead` / `org_admin` |
| Priority | P1 (the MVP only needs the first wave of integrations from product doc 12.2) |
| Product docs | Chapter 9 Integration Capabilities, 9.1 Source of Truth, 9.3 Agent Protocol, Chapter 10 Permissions and Security |

---

## 2. Page Goals

Connect the project to the places where it actually runs — the code repository, the project management system, the collaboration tools, the Agent runtimes.

Questions to answer:

1. Which systems is this project connected to? Are the connections healthy?
2. Which way does data flow? When the two sides disagree, who wins?
3. Where do notifications go, and what gets sent?
4. What did the connection grant? Is it too broad?

**MVP integration scope** (product doc 12.2): GitHub, one code agent, Slack or Feishu, Jira or Plane. This page is designed around those four categories and leaves slots for the rest.

---

## 3. Entry Points and Exits

**In**: project settings; the new-project onboarding flow; "import from an external system" on the requirement intake page; the Agent registration flow; a connection-failure alert.

**Out**:

| Action | Destination |
| --- | --- |
| Agent configuration | `08 Agent Workspace` |
| Resolving a sync conflict | Conflict detail dialog |
| Org-level connection management | `/admin/integrations` |
| Adjusting notification rules | The notification region on this page / user decision preferences |

---

## 4. Page Structure

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Order System Refactor / Settings / Integrations                            │
├────────────────────────────────────────────────────────────────────────────┤
│ 4 connected · ⚠ 1 failing                            [+ Add integration]   │
├────────────────────────────────────────────────────────────────────────────┤
│ 💻 Code and Engineering                                                    │
│ ┌────────────────────────────────────────────────────────────────────────┐ │
│ │ [GitHub]  ● Healthy   Synced 2 min ago        [Configure] [Disconnect] │ │
│ │ Repos    order-service (read/write) · shared-lib (read-only)           │ │
│ │ Sync     PR state → Work Item · Commit → runs · CI → acceptance        │ │
│ │ Grants   ✓read code ✓create branch ✓open PR ✗merge PR ✗change settings │ │
│ │ Today    12 API calls · 3 PRs created                                  │ │
│ └────────────────────────────────────────────────────────────────────────┘ │
│                                                                            │
│ 📋 Project Management                                                      │
│ ┌────────────────────────────────────────────────────────────────────────┐ │
│ │ [Jira]  ⚠ 2 conflicts   Synced 15 min ago     [Configure] [Disconnect] │ │
│ │ Project   ORDER (Scrum Board)                                          │ │
│ │ Direction ⇄ two-way sync                                               │ │
│ │ ─────────────────────────────────────────────────────────────────────  │ │
│ │ Source of Truth settings                       ⚠ critical config       │ │
│ │  Requirement body [APOS ▾]     Status     [APOS ▾]                     │ │
│ │  Owner            [Jira ▾]     Due date   [Jira ▾]                     │ │
│ │  Comments         [Merge ▾]    Artifacts  [APOS ▾]                     │ │
│ │ ─────────────────────────────────────────────────────────────────────  │ │
│ │ ⚠ 2 conflicts pending                          [Resolve conflicts →]   │ │
│ │   · ORDER-142 status changed on both sides (APOS: Review / Jira: Done) │ │
│ │   · ORDER-156 owner does not match                                     │ │
│ └────────────────────────────────────────────────────────────────────────┘ │
│                                                                            │
│ 🤖 Agents and Models                                                       │
│ ┌────────────────────────────────────────────────────────────────────────┐ │
│ │ [Claude Code (MCP)]  ● Healthy                [Configure] [Disconnect] │ │
│ │ Agents     [🤖 code-agent-1] [🤖 code-agent-2]  [Manage agents →]      │ │
│ │ Protocol   Agent Protocol v1 · events, artifacts, human-help requests  │ │
│ │ This month 128 runs · $278                                             │ │
│ └────────────────────────────────────────────────────────────────────────┘ │
│                                                                            │
│ 💬 Collaboration and Notifications                                         │
│ ┌────────────────────────────────────────────────────────────────────────┐ │
│ │ [Feishu]  ● Healthy                           [Configure] [Disconnect] │ │
│ │ Group    #order-refactor                                               │ │
│ │ ─────────────────────────────────────────────────────────────────────  │ │
│ │ What to send (by default, only things that need action)                │ │
│ │  ☑ Decision needed     ☑ Decision timing out ☑ Project risk rising     │ │
│ │  ☑ Agent keeps failing ☑ Task blocked long   ☑ Cost nearing cap        │ │
│ │  ☑ Milestone reached   ☑ Release trouble     ☑ Human takeover asked    │ │
│ │  ☐ Every status change ☐ Every agent run     ← off by default, no spam │ │
│ │ Daily digest  [09:00 ▾] to the group                                   │ │
│ │ Quiet hours   [22:00 - 08:00]  except high-risk decisions              │ │
│ └────────────────────────────────────────────────────────────────────────┘ │
│                                                                            │
│ 🗄 Enterprise Data Systems                                  not connected   │
│ ┌────────────────────────────────────────────────────────────────────────┐ │
│ │ Reach databases, warehouses, and CRMs through governed connectors      │ │
│ │ ℹ An org admin must configure the connector first     [Learn more]     │ │
│ └────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Regions in Detail

### 5.1 The Shared Shape of an Integration Card

| Element | Notes |
| --- | --- |
| Service icon + name | — |
| Connection status | ● healthy / ⚠ failing / ○ not connected |
| Last sync time | Turns amber past a threshold |
| What it is connected to | Repository / project / group |
| What is synced | Spell out which fields move, and in which direction |
| **Granted permissions** | List what is allowed **and what is denied** |
| Usage stats | API call volume, objects created, cost |

**The permission display has to name the denials explicitly** — the same principle as `08 Agent Workspace`. What the user needs to confirm is "this connection cannot merge my code."

### 5.2 GitHub Integration (required for the MVP)

**Connection flow**:

```
[+ Add integration] → GitHub → OAuth authorization (or GitHub App install)
→ pick an organization → pick repositories (several, each set to read or write)
→ configure what syncs → [Test connection] → done
```

**What is synced**:

| Direction | Content |
| --- | --- |
| GitHub → APOS | PR state, CI results, commits, review comments, issues (optional) |
| APOS → GitHub | Create branches, open PRs, PR descriptions (with Work Item links), review comments |

**Least privilege**: `merge` is not granted by default — merging code should go through a Policy decision, not be handed out at the integration layer.

**Webhook setup**: created automatically, used to receive PR/CI events that drive Work Item transitions (product doc 8.4.4). The webhook's health is shown.

### 5.3 Project Management Integration and Source of Truth (product doc 9.1)

**This is the most critical configuration on the page, and the one most likely to go wrong.**

The product doc is explicit: "a Source of Truth must be defined so that systems do not overwrite each other." This page configures it per field:

| Field | SoT options | Default | Why |
| --- | --- | --- | --- |
| Requirement body | APOS / Jira | APOS | The AI-structured requirement is the more complete one |
| Status | APOS / Jira | APOS | Status is driven by Flow Engine events; editing it externally derails them |
| Owner | APOS / Jira | Jira | Staffing is usually managed in the system of record |
| Due date | APOS / Jira | Jira | Same as above |
| Comments | APOS / Jira / two-way merge | two-way merge | Discussion should be visible on both sides |
| Artifact links | APOS | APOS | APOS is where the artifacts are produced |

**Edits on the non-SoT side** get one of three strategies (configurable):

1. **Ignore and write back** (default): the SoT wins, and its value is pushed back to the other side
2. **Record a conflict for a human**: create a conflict entry
3. **Accept and alert**: take the edit but notify the owner

**Conflict resolution UI**:

```
Conflict: ORDER-142 status

  APOS      Review          08-05 14:32  🔧 System (automated tests passed)
  Jira      Done            08-05 14:45  👤 Li Na, edited by hand

  ℹ The Source of Truth for status is APOS

  [Keep APOS (write back to Jira)]  [Keep Jira (one-time exception)]
  [View full change history]

  ☐ Resolve conflicts like this automatically from now on
```

### 5.4 Agent and Model Integration (product doc 9.3)

Supported: Claude Code, Codex, OpenHands, Cursor Agent, browser agents, data agents, in-house enterprise agents, MCP servers, custom Agent runtimes.

The capability negotiation of the **unified Agent Protocol** is surfaced here:

```
Protocol compatibility check
  ✓ Task input (structured goal + context)
  ✓ Execution status reporting
  ✓ Streaming events
  ✓ Artifact return
  ✓ Cost reporting
  ✓ Error classification
  ⚠ Human-intervention requests   Not supported by this runtime; degrades to
                                  handing off to a human after a timeout
  ✓ Permission declaration
```

**Saying what the degradation costs matters**: not every Agent runtime supports every protocol capability, and the page has to state what the missing ones imply instead of degrading silently.

Connection methods:

| Type | Configuration |
| --- | --- |
| MCP server | Server URL, auth method, tool allowlist |
| HTTP API | Endpoint, auth, protocol version |
| Built-in runtime | One-click enable |

### 5.5 Collaboration and Notifications (product doc Chapter 11)

**The notification design principle** (opening of Chapter 11): build around *things that need action*, not around shipping a firehose of Agent logs.

That is why "every task status change" and "every Agent run" are **off** in the default configuration. This is a deliberate product judgment — turn everything on by default and the user mutes the bot within two days, after which the notifications that genuinely need action do not reach them either.

**Notification template** (what lands in the group chat):

```
⚠ Needs your decision · Order System Refactor
Approve the production database index change
Owner: @Wang Qiang   Due: 14:36 (2h left)
Leaving it blocks 5 downstream tasks

Agent recommends: build the composite index online (confidence 82%)
[View details] [Approve]
```

**The key part**: the notification carries **buttons that act directly** (on platforms that support interactive cards), so a low-risk decision can be approved without switching apps. That contributes a lot to the "clear the decision queue in five minutes" goal.

**Escalation rules** (Chapter 11) are configured here:

```
Decision waiting  [4] hours → nudge the owner
Waiting           [8] hours → nudge the project lead
Waiting          [24] hours → nudge their manager and [☑ pause the critical path]
```

### 5.6 Enterprise Data Systems

Reach databases, warehouses, CRMs, ERPs, ticketing systems, knowledge bases, and BI tools through governed connectors.

**Not in the MVP** (product doc Chapter 13 defers "full ERP / CRM integration"). This page carries only a placeholder explanation and a pointer to the org-level configuration.

**Security constraints** (once it is built): data connectors must be configured at the organization level, a project may only use connectors it has been authorized for, and the access scope has to be granted separately in the Agent's permissions (product docs 10.3, 10.4).

---

## 6. Core Interaction Flows

**Setting up a new project**

```
Create project → prompt "connect your code repository" → GitHub OAuth
→ pick repositories → permissions default to the minimum set → test connection ✓
→ "connect a notification channel" → Feishu → pick a group → default notification config
→ done (Jira and more agents can come later)
```

**Resolving a sync conflict**

```
The card shows ⚠ 2 conflicts → [Resolve conflicts]
→ walk through each one, seeing both values and who changed them
→ resolve per the SoT rule, tick "handle this automatically from now on"
→ if conflicts are frequent → reconsider whether the SoT config is right → adjust
```

**Wiring up a new Agent runtime**

```
[+ Add integration] → Agent runtime → pick a type (MCP server)
→ fill in URL and auth → [Test connection]
→ protocol compatibility check → "human-intervention requests" is unsupported
→ confirm the fallback → done → jump to 08 to register the actual agents
```

---

## 7. State Design

| State | Handling |
| --- | --- |
| No integrations at all | Onboarding cards, ordered by the priority of the four MVP categories |
| Connection failing | Red border on the card + the actual cause (token expired / insufficient permissions / service unreachable) + [Reauthorize] |
| Token about to expire | Warned 7 days ahead |
| Sync paused | Show why it paused and how to resume; changes made in the meantime are synced once it comes back |
| Conflict backlog > 10 | Banner at the top: "a lot of sync conflicts — worth checking the Source of Truth configuration" |
| Disconnect confirmation | State the impact plainly: "after disconnecting GitHub, 3 agents will be unable to run code tasks and PR state will stop syncing" |
| Insufficient permissions | Show which permission is needed and how to request it |

---

## 8. Permissions

| Action | Requirement |
| --- | --- |
| View integration status | Project member |
| Add / configure an integration | `pm` / `tech_lead` |
| **Grant write access** (code writes, Jira writes) | `tech_lead` + audit record |
| Change the Source of Truth | `pm` / `tech_lead` (affects data consistency, needs a second confirmation) |
| Disconnect an integration | `pm` and above, with the impact confirmed |
| Configure data-system connectors | `org_admin` |
| Resolve sync conflicts | Project member |
| Configure notifications | `pm` (group level); personal preferences are set by the user |

---

## 9. Data Dependencies

**Domain objects**: `Integration` (connection config), `SyncMapping` (field mapping and SoT), `SyncConflict`, `Agent`, `Project`, `Event` (sync records)

**Endpoints**

```
GET  /api/projects/{id}/integrations
     → [{ type, provider, status, last_sync_at, config, permissions,
           sync_mappings[], conflicts_count, usage_stats }]

POST /api/integrations/oauth/start          { provider, project_id }
POST /api/integrations                      { provider, config, scopes[] }
POST /api/integrations/{id}/test
PATCH /api/integrations/{id}/sync-mapping   { field, source_of_truth, conflict_strategy }
DELETE /api/integrations/{id}               { confirm_impact: true }

GET  /api/projects/{id}/sync-conflicts
POST /api/sync-conflicts/{id}/resolve       { winner: 'apos'|'external', apply_to_similar? }

GET  /api/integrations/{id}/protocol-check   Agent runtime protocol compatibility
PATCH /api/projects/{id}/notification-config
```

**Credential security**: OAuth tokens and API keys are stored encrypted and never echoed back to the page (only the last four digits, `****1234`). Every use of a credential is written to the audit log.

---

## 10. Instrumentation and Metrics

| Event | Purpose |
| --- | --- |
| `integration_connected{provider}` | The real distribution of usage across integrations, which decides where to invest next |
| `integration_connect_failed{provider, reason}` | Where the setup flow stalls |
| **`sync_conflict_created{field}`** | **Which fields have a bad SoT setting — conflicts clustering on one field means the default is wrong** |
| `sot_changed{field, from, to}` | Which way users correct our defaults |
| `notification_disabled{type}` | Which notifications people turn off (i.e. which ones have no value) |
| `notification_action_clicked` | How often the in-notification actions get used |
| `integration_disconnected{provider, reason}` | Why connections are abandoned |

**Success criteria for this page**: 80% of new projects connect at least one code repository and one notification channel within 24 hours; sync conflict rate < 5%; notification opt-out rate < 20% (a high opt-out rate means the notification strategy is wrong).

---

## 11. Edge Cases and Exceptions

| Situation | Handling |
| --- | --- |
| The external service rate-limits us | Back off and retry automatically; the page shows "syncing slowly"; if the throttling persists, suggest lowering the sync frequency |
| The external service is down | Mark it as failing and pause syncing, catching up once it recovers; in the meantime Agent tasks are handled per Policy (product doc 8.6.4, "external service unavailable") |
| A synced issue is deleted in Jira | The local Work Item is labeled "external object deleted"; local data is never deleted automatically |
| One Work Item mapped to several external objects | Not allowed; validated at configuration time |
| Two-way sync causing an update loop | The sync engine tags its own writes and skips changes it triggered; the page shows "blocked N sync loops" |
| An external admin revokes our access | On a 403, mark the integration as failing and notify — never fail silently |
| Bulk import (hundreds of Jira issues) | Async job with a progress indicator; the mapping result is previewed before the import runs |
| An org-level connector is disabled | Project integrations using it are paused automatically and the project is notified |
| The notification group is dissolved | Once delivery fails, fall back to email and prompt for reconfiguration |

---

## 12. Open Questions

1. Per-field Source of Truth configuration is on the complex side for an ordinary user. Should we offer three presets ("APOS leads", "the external system leads", "APOS owns execution, the external system owns planning") plus an advanced custom mode? Leaning yes.
2. Two-way sync is expensive to build and easy to get wrong. Should the MVP start one-way (external → APOS import, plus APOS → external status write-back)? Leaning toward limiting the MVP to those two directions and deferring full two-way sync to P1.
3. The interactive buttons in a notification (approve directly) require authenticating the user on a third-party platform, and every platform does it differently. Should the MVP ship deep links only, with no in-platform actions?
4. The Agent Protocol needs its own specification document. The protocol compatibility check on this page depends on it.
5. The security model for enterprise data connectors (governed connector + Agent permission, both required) needs sign-off from the security team, particularly how data masking and access auditing are implemented.
6. The org-level vs project-level boundary for integrations: a GitHub App is usually installed at the organization level, but repository selection happens at the project level. This layering needs to be settled before implementation.
