# 07 API Design

*[中文版本 / Chinese version](07-api-design.zh.md)*

---

## 1. Conventions

| Item | Convention |
| --- | --- |
| Style | REST, resource-oriented; complex aggregate queries get dedicated read-only endpoints (e.g. `/overview`) |
| Prefix | `/api/v1` |
| Format | JSON; `camelCase` field names (matching the frontend's TypeScript, so neither side has to convert) |
| Time | ISO 8601 UTC strings |
| Money | Decimal as a string (`"8.2000"`), to avoid floating-point precision problems |
| ID | UUID v4 strings |
| Auth | `Authorization: Bearer <jwt>`; Agent callbacks use dedicated short-lived tokens |
| Validation | Zod schemas, shared through `packages/contracts` |

**Why camelCase and not snake_case**: the database is snake_case, the API is camelCase, and the conversion happens once, in the repository layer. Matching the frontend's habits at the API boundary keeps `work_item.human_gate` — an access pattern that reads badly in TypeScript — out of the frontend entirely.

---

## 2. Errors

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "reason": "storage.delivery_target_readonly",
    "params": { "ref": "s3-main" },
    "message": "交货目标 s3-main 登记为只读，收尾时会跳过写回 —— 请先把它改成可写",
    "details": { "field": "deliverTo" },
    "traceId": "req_01J..."
  }
}
```

(The `message` above reads: "delivery target s3-main is registered read-only, so the write-back will be skipped at wrap-up — make it writable first.")

The envelope carries **four** things, each with its own consumer:

| Field | Who reads it | Stability |
| --- | --- | --- |
| `code` | Client-side routing (retry? refresh? bounce to login?), monitoring classified by HTTP semantics | Stable, enumerated in `ErrorCode` |
| `reason` | **The UI's message lookup** — the message key is `error.reason.<reason>` | Stable, enumerated in `ErrorReason` (contracts) |
| `params` | Fills the `{name}` placeholders in that message | Determined by the reason |
| `message` | Logs, alerts, and clients that don't recognize the `reason` | **Unstable**, may change at any time |

**The UI reads codes, the logs read sentences.** `message` is always a ready-made Chinese sentence — the person on call at 2am wants a sentence, not an identifier they have to look up in a table. The UI, meanwhile, has to serve both English and Chinese, so it can only look messages up by code. Both are supplied at once; it isn't one or the other.

**`message` is not part of the contract.** It gets rewritten whenever a better phrasing turns up. Any code that regex-matches it is a time bomb — route on `code`, display from `reason`.

**When the `reason` isn't recognized, fall back to `message`, not to blank.** There will always be a window where the server has shipped a new code and the client hasn't caught up yet; during it the user should see a sentence they can read. Even in the wrong language, that beats a bare `error.reason.some_new_code`, and it certainly beats showing nothing.

### 2.1 Error codes

| HTTP | code | Situation |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | Malformed request body |
| 401 | `UNAUTHENTICATED` | Not logged in, broken token, or the account is gone |
| 403 | `FORBIDDEN` | Insufficient permission; `details` names the role required |
| 404 | `NOT_FOUND` | `reason` is always `not_found`; `params.entity` says which kind of thing |
| 409 | `VERSION_CONFLICT` | Optimistic-lock conflict; `details` carries the current state |
| 409 | `INVALID_TRANSITION` | The state machine disallows it; `details` carries the available triggers |
| 409 | `GUARD_FAILED` | A guard didn't pass; `details` carries the reason (possibly including `overridable`) |
| 409 | `CONFIRMATION_REQUIRED` | Nothing wrong with the request, but the user has to confirm once first |
| 422 | `POLICY_DENIED` | A policy denied it; `details` carries the rule name and its conditions |
| 422 | `BUDGET_EXCEEDED` | Over the project budget |
| 422 | `UNANSWERED_MUST_CONFIRM` | Required clarification questions are still unanswered |
| 429 | `RATE_LIMITED` | `details.retryAfterMinutes` says how long until a retry will work |
| 500 | `INTERNAL` | Server fault; `traceId` is the only lead |
| 501 | `UNSUPPORTED_FEATURE` | Nothing wrong with the request — this runtime just lacks the capability (degradation matrix) |
| 502 | `EXTERNAL_ERROR` | An external system failed — not our bug, and not the user mistyping something |
| 503 | `AGENT_UNAVAILABLE` | The Agent runtime is unreachable |

**`CONFIRMATION_REQUIRED` is kept separate from `VALIDATION_FAILED`.** The latter means "what you sent is wrong"; the former means "what you sent is fine, but I want you to look once and click again." Collapsing both into 400 costs nothing functionally (the feature still works) — it costs you **logs and monitoring**: a normal human interaction and a genuine client error become indistinguishable, and the 4xx rate stops being usable as an alerting signal.

**502 rather than 500, 501 rather than a 4xx.** If the request made it out to an external system, the failure is on that side; if the runtime lacks a capability, that's a property of the deployment, not of the request. Pile all of those into 500 and the "the service is down" signal gets diluted away.

**A 403 must say which permission is missing.** The page docs consistently call for "read-only degradation" rather than a full-page 403, and the frontend needs to know exactly which role is missing before it can render the tooltip.

### 2.2 Raising errors

```ts
throw fail('VALIDATION_FAILED', 'storage.delivery_target_readonly', `交货目标 ${ref} 登记为只读…`, {
  params: { ref },
  details: { field: 'deliverTo' },
});
```

The argument order is `code, reason, message` — **code first, sentence last**. The other order reads more naturally, but it makes "write the sentence now, add the code later" the default path, and the "later" step never happens.

"Not found" goes through `notFound(entity)`, and the argument is an **entity key**, not Chinese: in Chinese the noun comes first, in English `not found` comes last, so a `${what}不存在` template only ever works in Chinese.

Details in [12-i18n.md](12-i18n.md).

---

## 3. Pagination

Cursor pagination, not offset (the data changes in real time, and offsets make you skip or double-read rows):

```
GET /api/v1/projects/{id}/work-items?cursor=eyJpZCI6...&limit=50

{
  "items": [...],
  "nextCursor": "eyJpZCI6...",
  "hasMore": true
}
```

The cursor encodes `(sortKey, id)`, which keeps it stable.

---

## 4. Idempotency

Every write with side effects that might be submitted twice supports the `Idempotency-Key` header:

```
POST /api/v1/decisions/{id}/approve
Idempotency-Key: dec_52_approve_01J8X...
```

**Endpoints that must support idempotency**: decision approve/reject, Run dispatch and retry, release triggers, bulk operations.

The reason: these operations either cost money (dispatching an Agent twice) or are irreversible (approving a production release twice). Duplicate execution from a network retry is a real risk.

Implementation: `(idempotency_key, endpoint)` → the first response, cached for 24 hours. A repeat request gets the original result straight back, with an `Idempotent-Replay: true` response header. See `apps/api/src/http/idempotency.ts`.

**Only 2xx responses are cached.** Cache the failures too and a single transient fault gets nailed in place for 24 hours — every subsequent retry with the same key returns that stale error, and it never recovers.

**What it protects against is not "running twice"** — the state machine handles that layer (approving the same decision twice gets a 409 `VERSION_CONFLICT`, and the side effect does not happen again). What it protects against is **succeeding and being told you failed**: the client POSTs the approval, the network drops on the way back, it retries, this time it gets a 409, and the UI says "approval failed." The user clicks again and it fails again — while the operation succeeded on the very first try. That's harder to debug than a real failure, because the server logs show nothing but success.

---

## 5. SSE

### 5.1 Connecting

```
GET /api/v1/stream?channels=project:abc:board,user:me:decisions&access_token=<jwt>
Accept: text/event-stream
Last-Event-ID: 1284531
```

★ The token travels as a **query parameter** rather than an `Authorization` header, because EventSource cannot send custom headers (for the same reason, the `Last-Event-ID` in §5.3 must also be accepted as a query parameter). The cost is that the token lands in access logs, which a short TTL mitigates. **No token is a 401** — this stream carries every real-time event in the project, and it deserves the same authorization gate as the same data does over REST.

```
id: 1284532
event: work_item.status_changed
data: {"workItemId":"wi_88","from":"executing","to":"reviewing","actorType":"system",...}

id: 1284533
event: agent_run.progress
data: {"runId":"run_1284","step":7,"totalSteps":11,"cost":"8.2000",...}

: keepalive
```

### 5.2 Channels

| Channel | Authorization required | Contents |
| --- | --- | --- |
| `project:{id}:board` | Project member | Work Item status, progress, blockage |
| `work_item:{id}` | Project member | Every event on that item |
| `run:{id}` | Project member | The execution stream (high frequency) |
| `agent:{id}` | Organization member | Agent status and queue |
| `user:me:decisions` | The user themselves | Decision created / resolved / escalated |

**Authorization is checked per channel at subscribe time.** Channels the caller isn't entitled to are dropped from the subscription list and reported to the client in the first frame — the connection as a whole is not refused.

### 5.3 Resuming after a disconnect

`Last-Event-ID` carries the last event ID received. On reconnect:

```sql
SELECT * FROM events
WHERE id > $lastEventId AND <channel filter>
ORDER BY id LIMIT 500;
```

Past 500 unread events, send a `resync` event and let the client do a full refresh instead of replaying everything — a backlog that large means the client has been offline for a long while, and refetching beats an incremental catch-up.

### 5.4 Backpressure

- Multiple `progress` events for the same entity within 200ms collapse into the last one
- When a single connection's pending queue exceeds 1000, degrade: send only `level=milestone` events plus one `degraded` notice
- Clean up the subscription the moment the client disconnects

---

## 6. Endpoints

Organized to follow the page docs. Only the key endpoints and the non-obvious design points are listed.

### 6.0 Login and accounts

The reasoning behind this is in [09-security §1.0](09-security.md#10-human-credentials-and-where-accounts-come-from).

```
POST   /auth/login                      ★ the one write route that needs no identity — it is where identity comes from
       ← { email, password }
       → { token, user }
       On 401, "no such account", "no password set" and "wrong password" return the
          same sentence and take the same amount of time; telling them apart hands
          out a directory-enumeration probe

GET    /auth/me
       → { user, currentOrgId, orgRole }
       The frontend asks once at startup: the token may have expired, or may belong
       to an account that has since been deleted.
       401 → the frontend logs out on the spot (instead of every page erroring on its own)

POST   /auth/password                   change your own password; the scope is the caller themselves
       ← { currentPassword, newPassword }
       → { ok, token }                  ★ hands back a fresh token

POST   /admin/users                     create an account; requires organization.members.manage
       ← { email, name, password, orgRole? }
       → 201 { id, name, email, orgRole }
       ★ Creating the account and joining it to this organization happen in one
         transaction — split them and a failure on step two leaves an account that
         "can log in but belongs to no organization", whose every request is a 401
       409 means the email already has an account: the right move then is "add member",
       not "create". One person with two accounts is two people in the audit trail
```

```
POST   /auth/register            no identity required
       ← { email, name, password, orgName? }
       → 200 { token, user, organization }
       ★ Every registration **opens a new, empty organization**, with the registrant as
         its org_admin — it does not join an existing one. Getting into someone else's
         organization still happens only one way: an admin adds you
       ★ Unlike login, a 409 says outright "email already registered": without that the
         user cannot finish registering. The mitigation is rate limiting (per IP,
         10 attempts per 10 minutes), not vagueness
       429 means the rate limit was hit
       403 means this instance has self-service signup turned off (APOS_ALLOW_SIGNUP)

GET    /auth/config             no identity required
       → 200 { allowSignup }
       ★ The login page uses this to decide whether to show the "Register" tab. The
         switch is a **server-side** matter and must not be baked into the frontend
         build — one build artifact gets hosted by many different instances
```

**Registration does not break the multi-tenant boundary.** The organization boundary *is* the tenant boundary, and what has to be prevented is **self-service entry into an existing organization**; what registration opens is a new organization nobody else can see. See 09-security §1.

### 6.1 Projects

```
GET    /projects?scope=mine|all&status=&risk=&autonomy=
       → includes precomputed metrics; metrics carry metricsUpdatedAt

POST   /projects
       ← { name, goal, type, autonomyLevel, budget, sponsorId, techLeadId }
       → { projectId, requirementDraftId }   ★ returns the requirement draft ID directly so the frontend can navigate straight there

GET    /projects/{id}/overview
       → returns everything the overview page needs in one call (metrics / blockers / agents / members / summary / flow)
         every region of page doc 02, avoiding 8 concurrent requests

PATCH  /projects/{id}
       ← { autonomyLevel? , status? }
       High-risk changes require the header X-Confirm-Token (obtained after the frontend's second confirmation)

GET    /me/action-items?limit=5
       → cross-project "waiting on me", shared by the project list page and the overview page
```

### 6.2 Requirements

```
POST   /projects/{id}/requirements                   create a draft

POST   /requirements/{id}/analyze                    ★ streams back over SSE
       → event: field_updated  { field, value, sources }
       → event: question_added { id, level, question, impact, suggestion, options }
       → event: score_updated  { total, dimensions }
       → event: done           { cost, durationMs }

PATCH  /requirements/{id}                            fill in / edit structured fields by hand
POST   /requirements/{id}/questions/{qid}/answer
POST   /requirements/{id}/approve   { note? }        → triggers plan generation (async)
POST   /requirements/{id}/reject    { reason }       reason is required
POST   /requirements/{id}/delegate  { assigneeId, note }
```

**`analyze` uses SSE rather than polling**: the structuring pass takes 20–60 seconds, and filling the fields in one by one as they stream is exactly the experience page doc 03 §7 calls for.

**`PATCH` and `analyze` are two parallel paths to a structured requirement, not a primary and a fallback**:

- `PATCH` accepts **every** structured field. Expose only a handful of patchable ones and the manual path can never produce a complete requirement (five of the six completeness dimensions live in those fields)
- Only fields that **actually changed** get `source: 'human'` provenance. The editor submits the whole form at once, and recording provenance by "what was submitted" would mark an entire panel as human-authored just because one field was edited — that row of markers would then be a lie
- `analyze` **does not overwrite** fields already marked `human`, and reports back `keptHumanFields` in its response
- The confirmation gate only asks whether there is content at all (a title, a business goal, or acceptance criteria), not who produced it

### 6.3 Plans

```
POST   /requirements/{id}/plans          trigger generation (async task)
       → { taskId }  poll it, or subscribe over SSE for the completion notice

GET    /plans/{id}
       → { plan, workItems, criticalPath, milestones, risks,
           costEstimate, autoActions, requiredApprovals }

GET    /plans/{id}/auto-actions          ★ policy dry-run results
       → [{ description, policyId, policyName, reversible, externalVisible }]

GET    /plans/{id}/diff?from=v1&to=v2

PATCH  /plans/{id}/work-items/{itemId}
       ← { assignee? | durationHours? | delete? }
       → { affectedItems[], newCriticalPath, newDuration }   ★ returns the impact

GET    /work-items/{id}/assignee-candidates
       → [{ type, id, name, matchScore, matchReasons[], successRate, load, costEstimate }]
       ★ matchReasons must be human-readable — the page displays them as-is

POST   /plans/{id}/approve   { note?, acknowledgedOverrun? }
POST   /plans/{id}/revise    { feedback }
```

### 6.4 Board and Work Items

```
GET    /projects/{id}/board?view=kanban&filters=...
       → { stages: [{ key, name, wipLimit, count, items[], hasMore }] }
       Each column paginates independently; the Done column returns only 5 items by default

PATCH  /work-items/{id}/status
       ← { toStatus, reason, reasonCategory, terminateRunningRun? }
       ★ reason is required (a human override must record why)
       → on 409 INVALID_TRANSITION, returns allowedTriggers so the UI can suggest what is possible

POST   /work-items/{id}/takeover     { agentHandling, reason }   reason required
POST   /work-items/{id}/handback     { handoverNote }
POST   /work-items/{id}/reassign     { assigneeType, assigneeId, reason }
POST   /work-items/{id}/retry        { additionalContext? }
POST   /work-items/{id}/split        { subtasks[] }
POST   /work-items/{id}/force-pass   { reason, criteria[] }      requires tech_lead

GET    /work-items/{id}/events?level=milestone|detail&source=&cursor=
```

### 6.5 Agents and Runs

```
GET    /agents?scope=&type=&status=
GET    /agents/{id}
       → { agent, metrics, queue: { executing, pending, waitingDep,
           waitingDecision, failed }, trends }

PATCH  /agents/{id}
       Changes that widen permissions require the header X-Audit-Reason

POST   /agents/{id}/permissions/simulate     ★ dry-run the impact of a permission change
       ← { changes }
       → { affectedPolicies[], queuedTasksImpact[], runningRunsImpact[] }

POST   /agents/{id}/pause    { reason, runningRunHandling }
POST   /agents/{id}/trial-run { sampleTaskId }

GET    /runs/{id}
       → { run, agentSnapshot, permissionSnapshot, input, metrics,
           artifacts, interventions, error?, related }
GET    /runs/{id}/events?level=brief|detailed&cursor=
GET    /runs/{id}/cost-breakdown?groupBy=step
POST   /runs/{id}/constraints  { constraint }     add a constraint mid-execution
POST   /runs/{id}/terminate    { reason }
POST   /runs/{id}/retry        { additionalContext[], agentId? }
```

### 6.6 Decisions

```
GET    /decisions?scope=mine&category=&project=&type=&sort=urgency&cursor=
       → { stats: { overdue, dueSoon, pending, coSign, delegated, completedWeek },
           decisions: [...] }
       ★ Every list item must carry the eight fields from page doc 10 §5.3 (whyYou /
         consequence / recommendation / alternatives / evidence) itself, so the UI
         never has to fetch the detail of each row separately

GET    /decisions/{id}
       → full detail, including the option comparison, evidence, similarDecisions, discussion

POST   /decisions/{id}/approve
       ← { optionId, constraints: [{ type, value, enforcement }], note? }
       Idempotency-Key required
POST   /decisions/{id}/reject            { reason }   required
POST   /decisions/{id}/request-revision  { feedback }
POST   /decisions/{id}/delegate          { assigneeId, note }
POST   /decisions/batch                  { ids[], action, note }
       ★ Validated server-side: only low-risk decisions of the same type can be batched;
         high-risk ones are excluded automatically and the response says so

GET    /decisions/{id}/similar           similar past decisions + how they turned out
GET    /decisions/automation-suggestions repeat decisions that could be automated
POST   /decisions/{id}/comments          { body, mentions[] }
```

### 6.7 Policy

```
GET    /projects/{id}/policies
       → { orgPolicies[], projectPolicies[], summary: { autoActions[], humanRequired[] },
           conflicts[] }
       ★ summary is where "14 kinds handled automatically, 6 kinds need confirmation" comes from

POST   /policies
PATCH  /policies/{id}
       ★ when direction=loosen, a valid simulationId is mandatory, otherwise 422

POST   /policies/simulate                replay against history
       ← { policyDraft, projectId, range }
       → { totalSamples, skippedForMissingFacts, wouldAutoHandle,
           mismatches[], suggestions[], confidence }

POST   /policies/evaluate                test a hand-built scenario
       ← { context }
       → { result, matchedPolicy, evaluationTrace[] }
       ★ the trace shows "which higher-priority rule intercepted this"

GET    /policies/{id}/history
```

### 6.8 Analytics

```
GET /projects/{id}/analytics/flow?range=30d&compare=true
GET /projects/{id}/analytics/agents?range=30d
GET /projects/{id}/analytics/hitl?range=30d
GET /projects/{id}/analytics/cost?range=30d&groupBy=
GET /projects/{id}/analytics/quality?range=30d
GET /projects/{id}/analytics/insights?range=30d
    → [{ severity, type, message, evidence, actions[] }]
    ★ actions carry a directly callable endpoint plus prefilled parameters
```

**Every analytics endpoint returns a `dataAsOf` field** (the cutoff of the pre-aggregation), so the page can show "data as of 15:00".

### 6.9 Integrations and Agent callbacks

```
GET    /projects/{id}/integrations
POST   /integrations/oauth/start        { provider, projectId }
PATCH  /integrations/{id}/sync-mapping  { field, sourceOfTruth, conflictStrategy }
GET    /projects/{id}/sync-conflicts
POST   /sync-conflicts/{id}/resolve     { winner, applyToSimilar? }

# External webhook entry points (authenticated separately)
POST   /webhooks/github     signature verified
POST   /webhooks/jira
POST   /webhooks/{provider}

# Agent callbacks (dedicated short-lived tokens, see doc 06 §10)
POST   /agent-callback/runs/{runId}/events
       Authorization: Bearer <run-scoped-token>
       ← RunEvent | RunEvent[]
POST   /agent-callback/runs/{runId}/artifacts
```

---

## 7. The trade-off behind aggregate endpoints

A few endpoints (`/overview`, `/board`, the decision list) are deliberately built to "return everything one screen needs in a single call", which breaks pure REST's resource orientation.

**Why**: these pages have very high information density. Split `/projects/{id}/overview` into 8 resource endpoints and the first paint costs 8 round trips, which feels terrible on a mobile network. On top of that, this data is naturally consumed together and has no independent reuse value.

**Where the line is**: only the high-density pages the page docs explicitly define get an aggregate endpoint; everything else goes through standard resource endpoints. Aggregate endpoints do not accept arbitrary field-selection parameters (that road ends in half a GraphQL) — their response shape is fixed.

---

## 8. Long-running operations

For slow work like requirement analysis, plan generation, simulation, and export:

| Duration | Approach |
| --- | --- |
| < 3s | Synchronous response |
| 3–60s, with the process visible | SSE stream (requirement analysis) |
| > 60s | Async task + polling/notification (plan generation, bulk import) |

Async tasks all take the same shape:

```
POST /requirements/{id}/plans   → 202 { taskId }
GET  /tasks/{taskId}            → { status, progress, result?, error? }
                                  or subscribe over SSE to user:me:tasks
```

---

## 9. Rate limits

| Target | Limit |
| --- | --- |
| Ordinary read endpoints | 300 req/min/user |
| Write endpoints | 60 req/min/user |
| LLM-triggering endpoints (analyze/plan/simulate) | 10 req/min/user + the project cost ceiling |
| Agent callbacks | 1000 req/min/run (event-dense) |
| Webhooks | Configured per provider |

The limit on LLM-triggering endpoints isn't only there to protect the service — it's a **cost guardrail**, keeping a user from burning money by clicking "re-analyze" over and over. The cost estimate shown on the frontend button works together with this limit.

---

## 10. Open questions

1. **API versioning strategy**: today it's a `/v1` path prefix. Given that frontend and backend ship together during the MVP, is a version even needed? Leaning toward keeping the prefix but promising no compatibility during the MVP.
2. **Caching aggregate endpoints**: `/overview` data changes often and is not cheap to compute. Should there be a short TTL cache (10s)? It would mean a refresh right after an action doesn't show the latest result, so it would need SSE to compensate.
3. **Response shape for bulk operations**: on partial success, return 200 with per-item results, or 207 Multi-Status? Leaning toward 200 plus explicit per-item results — simpler for the frontend to handle.
4. **Token leakage risk on Agent callbacks**: the token is handed to an external runtime along with the task. If that runtime environment is compromised, the token can be used to forge events. Do we need a separate signature over the event contents? Leaning toward short-lived tokens + an IP allowlist for the MVP (workable for self-hosted runtimes), and accepting the risk for SaaS runtimes.
5. **SSE reliability behind corporate proxies**: some corporate proxies buffer SSE streams. Do we need a WebSocket fallback path? The suggestion is to start with SSE plus a periodic full refresh as a backstop, and add one only if it actually bites.
