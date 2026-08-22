# 06 Agent Protocol

*[中文版本 / Chinese version](06-agent-protocol.zh.md)*

Product doc 9.3 calls for "a unified Agent Protocol" that describes, in one place: agent capabilities, task input, execution status, events, artifacts, permissions, cost, errors, and requests for human intervention.

This document defines that protocol, and how Claude Code, Codex, OpenHands, MCP servers, and custom runtimes get adapted into it.

---

## 1. Why a unified protocol

Without one, every agent you connect needs its own special case in the Flow Engine, on the board, in the Run detail page, and in Analytics. Four or five agents in, that is no longer maintainable.

But there is one fact a unified protocol cannot design its way around: **runtimes differ enormously in what they can actually do**.

| Capability | Claude Code | Generic MCP | Self-built HTTP agent | Some closed SaaS agents |
| --- | --- | --- | --- | --- |
| Streaming events | ✅ | ✅ | Depends on the implementation | Often only the final result |
| Tool calls visible | ✅ | ✅ | Depends on the implementation | ❌ |
| Cost reporting | ✅ | Partial | Depends on the implementation | ❌ |
| Injecting constraints mid-run | ✅ | Partial | Depends on the implementation | ❌ |
| Asking for human help on its own | Partial | ❌ | Depends on the implementation | ❌ |
| Self-reported failure reason | ✅ | ❌ | Depends on the implementation | ❌ |

**So the heart of the protocol is not "here is what every agent must do." It is "negotiate what each agent can do, and define an explicit degraded behavior for every capability it lacks."**

Page doc 14 §5.4 requires the UI to display the compatibility check and the degradation notes — never degrade silently; let the user see what their agent is missing.

---

## 2. Protocol at a glance

```
        APOS                                        Agent Runtime
          │                                               │
          │  ① GET  /capabilities                         │
          │──────────────────────────────────────────────▶│
          │◀────────────── CapabilityManifest ────────────│
          │                                               │
          │  ② POST /tasks          TaskDispatch          │
          │──────────────────────────────────────────────▶│
          │◀────────────── { runId, accepted }────────────│
          │                                               │
          │  ③ Event stream (one of SSE / webhook / poll) │
          │◀═════════════ RunEvent* ══════════════════════│
          │                                               │
          │  ④ POST /runs/{id}/control  { pause | resume | │
          │     terminate | add_constraint }              │
          │──────────────────────────────────────────────▶│
          │                                               │
          │  ⑤ Intervention request (optional capability) │
          │◀────────────── InterventionRequest ───────────│
          │──────────────── InterventionResponse ────────▶│
          │                                               │
```

**Transport**: every message is JSON. For the event stream, SSE is preferred; if the runtime cannot do SSE, a webhook callback; if it can do neither, polling (degraded, high latency).

---

## 3. Capability Manifest

Reported by the agent runtime when it is connected; APOS stores it in `agent_runtimes.capabilities`.

```typescript
interface CapabilityManifest {
  protocolVersion: string;          // '1.0'
  runtime: {
    name: string;                   // 'claude-code'
    version: string;
  };

  // ★ The heart of capability negotiation
  features: {
    streamingEvents: boolean;       // Streaming events
    toolCallVisibility: boolean;    // Tool calls are visible
    reasoningVisibility: boolean;   // Reasoning is visible
    costReporting: boolean;         // Cost reporting
    tokenReporting: boolean;
    progressReporting: boolean;     // Step progress
    runtimeConstraints: boolean;    // ★ Constraints can be injected mid-run
    interventionRequest: boolean;   // ★ Can ask for human help on its own
    selfReportOnFailure: boolean;   // ★ Explains its own failures
    pause: boolean;
    terminate: boolean;
    statusQuery: boolean;           // ★ Status can be queried on demand (needed to reclaim orphans)
    subAgentDelegation: boolean;    // Delegates to sub-agents
    artifactUpload: boolean;
  };

  transport: {
    eventDelivery: 'sse' | 'webhook' | 'poll';
    heartbeatIntervalSeconds: number | null;
  };

  // Tools this runtime declares support for
  tools: Array<{
    name: string;
    description: string;
    parameters: JSONSchema;
    sideEffects: 'none' | 'read' | 'write' | 'destructive' | 'external';
  }>;

  models: string[];
  limits: {
    maxConcurrentRuns: number;
    maxRunDurationSeconds: number;
    maxContextTokens: number;
  };
}
```

### 3.1 Degradation matrix

Every missing capability maps to one explicit degraded behavior. **This table is the central output of the protocol design**; page doc 14 §5.4 renders it directly.

| Missing capability | Degraded behavior | What the user sees |
| --- | --- | --- |
| `streamingEvents` | Write a single summary event when the run ends | No live execution stream on the Run detail page; no progress bar on the card |
| `toolCallVisibility` | The execution stream has only a start and an end | Hard to debug; the page says 「该 Agent 不上报执行细节」 ("this agent does not report execution detail") |
| `costReporting` | Estimate from tokens × unit price; with no tokens either, estimate roughly from elapsed time | Cost is labeled 「估算值」 ("estimated") |
| `progressReporting` | No percentage, only elapsed time | The card reads 「执行中 12m」 ("running, 12m") instead of showing a progress bar |
| `runtimeConstraints` | The "Add constraint" button is grayed out, with a hint to use "terminate, add context, rerun" instead | Feature unavailable, but there is an alternate path |
| `interventionRequest` | The agent cannot ask for help; timeouts and failure detection are the only backstop | Stuck tasks are noticed later |
| `selfReportOnFailure` | The Error tab shows only the raw error | Debugging gets slower |
| `pause` | Pause degrades to terminate (needs a second confirmation explaining the difference) | In-flight progress is lost |
| `statusQuery` | An orphaned run's true state cannot be probed; after the timeout it is simply marked failed | A run that is still going may be misjudged |
| `terminate` | Only the local state can be marked; the external run may keep going | **Risk of cost leakage — the page must warn in red** |

**A missing `terminate` is the most serious of these**: it means APOS cannot actually stop a runaway agent. A runtime like this should raise a warning at registration and be forced onto stricter cost ceilings.

---

## 4. Task dispatch

```typescript
interface TaskDispatch {
  runId: string;
  idempotencyKey: string;          // ★ Protection against duplicate dispatch

  goal: {
    title: string;
    description: string;
    acceptanceCriteria: Array<{ id: string; text: string }>;
    constraints: Array<{           // Constraints attached by a human
      type: string;
      value: unknown;
      description: string;         // The natural-language version, for the agent to read
    }>;
  };

  context: Array<{
    kind: 'requirement' | 'knowledge' | 'file' | 'previous_run' | 'decision' | 'external';
    ref: string;
    title: string;
    content?: string;              // Small content, inlined
    uri?: string;                  // Large content ships as a URI for the agent to fetch
    priority: 'must_read' | 'reference';
  }>;

  // ★ Permissions ship as an explicit list; we never rely on the runtime's own config
  permissions: {
    allowedTools: string[];
    deniedTools: string[];
    resourceScopes: Array<{ kind: string; ref: string; access: 'read' | 'write' | 'none' }>;
  };

  // ★ Policy rules that would stop this work for human review — computed at dispatch, already rendered into plain language
  policyGates: Array<{ name: string; explanation: string }>;

  limits: {
    maxCostUsd: number;
    maxDurationSeconds: number;
    maxTokens: number | null;
  };

  model: string | null;
  modelConfig: Record<string, unknown> | null;

  callback: {
    eventsUrl: string;             // Callback address for webhook mode
    token: string;                 // Short-lived token, valid only for this run
  };
}
```

**Shipping permissions explicitly** is the key security decision here. You cannot assume the runtime side is configured correctly — APOS is the single source of truth for permissions, and every dispatch carries the full list. It is the adapter's job to translate that into whatever form the runtime understands (MCP's tool filtering, Claude Code's allowedTools, and so on).

**Idempotency**: for a repeated `idempotencyKey` the runtime must return the run that already exists rather than starting a new one. For runtimes that cannot do this, the adapter deduplicates on the APOS side (recording a key → runId mapping).

**`policyGates` informs; it does not authorize.** The agent never sees the Policy Engine — evaluation happens on the Work Item's state transitions ([05 Policy Engine](05-policy-engine.md) §3), which is platform business; the agent can neither comply with it nor violate it. What it costs to keep quiet is that the agent may spend its entire token budget going down a path that is destined to stop at a human approval gate — a gate that takes effect *after* it finishes, so it does not even get the failure as feedback.

Hence this field is:

- **Computed at dispatch** (`selectPolicyGates`, `packages/domain/src/policy/gates.ts`), from the `contextSnapshot` that transition just produced — the same snapshot written into the `policy.evaluated` event, so the warning and the actual ruling cannot drift apart;
- **Limited to rules that would actually stop a human**, and only those that could **still fire** during this execution (anything already ruled out by fixed facts is left off — a long list dilutes the one rule that will really hit);
- **Shipped as a rendered string** rather than a rule AST — `@apos/agent-runtimes` depends only on `@apos/contracts` and cannot reach domain's `explainPolicy()`;
- **Worded as "this will be held for review," not "you are not allowed to do this."** The interception is carried out by `transition()`, whether or not the agent ever read the field; phrasing it as a prohibition makes the agent believe it is the enforcer, so it may route around the correct solution in the name of "compliance," or do the thing and then not mention it. What we want is exactly the opposite: do the work as usual, then call it out in the final reply.

For planning runs this field is always an empty array: Policy hangs off Work Item transitions, and planning runs before any work items exist — there is nothing to transition.

---

## 5. Events

```typescript
type RunEvent = {
  runId: string;
  seq: number;                     // Monotonically increasing within one run
  ts: string;                      // ISO8601
} & RunEventBody;

type RunEventBody =
  | { type: 'run_started'; model: string; toolsAvailable: string[] }
  | { type: 'context_loaded'; items: Array<{ ref: string; tokens: number; used: boolean }> }
  | { type: 'progress'; step: number; totalSteps: number | null; description: string }
  | { type: 'reasoning'; summary: string; detail?: string }
  | { type: 'tool_call'; toolCallId: string; tool: string; params: unknown }
  | { type: 'tool_result'; toolCallId: string; ok: boolean; summary: string; detail?: unknown }
  | { type: 'artifact'; artifact: ArtifactPayload }
  | { type: 'delegation'; childRunId: string; agentRef: string; goal: string }
  | { type: 'cost'; deltaUsd: number; totalUsd: number;
      tokens: { input: number; output: number; cacheRead: number } }
  | { type: 'intervention_request'; request: InterventionRequest }
  | { type: 'note'; text: string }              // The agent's own natural-language progress note
  | { type: 'error'; error: AgentError }
  | { type: 'run_ended'; outcome: 'completed' | 'failed' | 'terminated';
      summary: string; selfReport?: string };
```

### 5.1 Event promotion rules

Which `run_events` get promoted to domain `events` ([03 Event model](03-event-model.md) §2):

| RunEvent | → DomainEvent | Follow-on action |
| --- | --- | --- |
| `run_started` | `agent_run.started` | — |
| `artifact` | `artifact.produced` | Write to the artifacts table |
| `cost` (cumulative hits a threshold) | `agent_run.cost_threshold_reached` | May trigger Policy |
| `intervention_request` | `decision.created` | Create a decision |
| `run_ended: completed` | `agent_run.completed` | **Triggers flow.transition** |
| `run_ended: failed` | `agent_run.failed` | **Triggers flow.transition → Recovery** |
| everything else | not promoted | run_events only |

### 5.2 Event ordering and loss

- The runtime guarantees `seq` increases monotonically
- When APOS receives events out of order it sorts by seq before persisting; on a gap (5 arrives but 4 never did) it waits 2 seconds, marks that seq `lost`, and moves on
- **`run_ended` is the terminal marker**: after it, later events are ignored (unless they are a backfill with a smaller seq)

### 5.3 Heartbeat

```typescript
// The runtime sends one every N seconds (N comes from manifest.transport.heartbeatIntervalSeconds)
{ type: 'heartbeat', runId, seq, ts, alive: true }
```

APOS updates `agent_runs.last_heartbeat_at`. No heartbeat for more than `3 × N` (minimum 90s) counts as lost, and run-supervisor takes over ([01 Architecture](01-architecture.md) §3.3).

For runtimes without heartbeats: use the timestamp of the last event instead, with the threshold relaxed to 5 minutes.

---

## 6. Error classification

**This is the part of the protocol with the largest effect on product behavior.** The recovery strategies in [04 Flow Engine](04-flow-engine.md) §6.1 rest entirely on error classification — get the class wrong and recovery becomes indiscriminate retrying, which burns money without fixing anything.

```typescript
type ErrorClass =
  | 'context_insufficient'    // Missing information; may succeed once context is added
  | 'capability_mismatch'     // Task is beyond this agent; switch agents
  | 'tool_failure'            // Tool call failed; retriable
  | 'permission_denied'       // Insufficient permission; retrying is pointless, a human must decide
  | 'external_unavailable'    // External service down; retry with backoff
  | 'timeout'                 // Timed out; consider splitting the task
  | 'budget_exceeded'         // Over the cost ceiling; a human must decide
  | 'invalid_task'            // Task description is self-contradictory or unworkable; back to the requirement or plan
  | 'runtime_error'           // The runtime itself broke
  | 'unknown';

interface AgentError {
  class: ErrorClass;
  message: string;             // For engineers
  detail?: unknown;            // Stack trace, etc.
  retriable: boolean;          // The runtime's own suggestion
  // ★ For humans: why it is stuck and what it needs
  selfReport?: string;
}
```

**Why `selfReport` matters** (page doc 09 §5.7):

> "I need the schema of the orders table to design the query index, but I could not find a migration or schema file in the order-service repo. It may live in another repo, or be maintained separately by a DBA."

That paragraph is far more useful than a stack trace — it tells a human exactly what to supply.

**Runtimes that cannot classify**: the adapter infers a class heuristically from the error message (regex matching on common patterns) and marks `classificationSource: 'inferred'`. Inferred results are unreliable, so recovery for these agents should be more conservative (escalate to a human sooner).

---

## 7. Human intervention requests

Product doc 9.3 lists "human intervention request" as a protocol element. This is the channel through which an agent says, on its own, "I need help."

```typescript
interface InterventionRequest {
  runId: string;
  reason: 'ambiguous_requirement' | 'permission_needed' | 'risky_operation'
        | 'conflicting_information' | 'low_confidence' | 'external_blocker';
  question: string;
  options?: Array<{
    id: string;
    label: string;
    description: string;
    consequence: string;
  }>;
  recommendation?: { optionId: string; confidence: number; rationale: string };
  urgency: 'blocking' | 'can_continue';   // Whether execution is blocked
  context: unknown;
}

interface InterventionResponse {
  requestId: string;
  resolution: 'answered' | 'constraint_added' | 'terminated' | 'taken_over';
  answer?: string;
  selectedOptionId?: string;
  additionalConstraints?: Array<{ type: string; value: unknown; description: string }>;
}
```

**On the APOS side**: request arrives → create a Decision (type mapped from reason) → it lands in the Decision Center → a human handles it → the outcome goes back as an `InterventionResponse`.

With `urgency: 'can_continue'` the agent keeps working (e.g. "I used a default value, please confirm"); with `blocking` the run enters `paused`.

---

## 8. Control commands

```typescript
type ControlCommand =
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'terminate'; reason: string }
  | { action: 'add_constraint'; constraint: { type: string; value: unknown; description: string } };
```

**What `add_constraint` means** (the answer to open question 3 in page doc 09 §11):

The constraint is injected into the agent's next turn of context. It **does not restart the run and does not roll back completed steps**. On receiving it, the runtime should:

1. Apply it after the current step finishes
2. Send back a `note` event acknowledging receipt (so the user can see "the agent got it")
3. Honor the constraint from then on

The page states this explicitly: 「Agent 将在当前步骤结束后应用该约束（约 40s 后生效），已完成的步骤不会回滚」 ("the agent will apply this constraint after the current step ends, roughly 40s from now; completed steps will not be rolled back").

---

## 9. Adapters

```
packages/agent-runtimes/
├── base/
│   ├── adapter.ts          Abstract interface
│   ├── event-normalizer.ts Each vendor's events → RunEvent
│   ├── error-classifier.ts Heuristic error classification (for degraded runtimes)
│   └── idempotency.ts      Local dedup when the runtime cannot do it
├── claude-code/
├── mcp/
├── http-generic/
└── builtin/                Simple built-in agents (e.g. requirement structuring)
```

### 9.1 Abstract interface

```typescript
interface AgentRuntimeAdapter {
  getCapabilities(): Promise<CapabilityManifest>;
  dispatch(task: TaskDispatch): Promise<{ externalRunId: string; accepted: boolean }>;
  subscribe(runId: string, onEvent: (e: RunEvent) => Promise<void>): Promise<Unsubscribe>;
  queryStatus(runId: string): Promise<RunStatus>;        // statusQuery capability
  control(runId: string, cmd: ControlCommand): Promise<void>;
  respondIntervention(runId: string, resp: InterventionResponse): Promise<void>;
}
```

### 9.2 Notes on each adapter

| Adapter | Key implementation points |
| --- | --- |
| **Claude Code** | Starts a session through the Agent SDK; permissions map onto tools/allowedTools/disallowedTools + canUseTool; streaming and cost reporting are native, so this is the most complete runtime. Implementation notes in §9.4 |
| **MCP** | Tools are exposed over MCP; MCP itself has no concept of a "task," so task semantics have to be wrapped on top of it; tool calls are visible but reasoning may not be |
| **Generic HTTP** | Minimal contract: `POST /tasks` plus a webhook callback; suits enterprise-built agents; capabilities come entirely from the manifest |
| **Codex** | A CLI wrapper; permissions are sandbox-level rather than tool-level, so mapping always tightens. Implementation notes in §9.5 |
| **Generic headless CLI** | pi / Gemini CLI / Aider / Goose / OpenCode / Qwen Code share **one** adapter plus a declarative profile table. Implementation notes in §9.6 |
| **Built-in** | Cases where APOS calls an LLM itself — requirement structuring, plan generation — go through the same Run records so they stay traceable |

**Built-in agents go through the protocol too**, and that is worth stressing: requirement structuring and plan generation are agent behavior as well, and they also need run records, cost accounting, and traceability. "It's our own LLM call" is not a reason to take the back door — take it and the cost numbers in Analytics are incomplete.

### 9.3 Event normalization example

```typescript
// Claude Code SDK event → RunEvent
function normalize(raw: SDKMessage, ctx: RunContext): RunEvent[] {
  switch (raw.type) {
    case 'assistant':
      return raw.message.content.flatMap(block => {
        if (block.type === 'text')
          return [{ type: 'reasoning', summary: truncate(block.text, 120), detail: block.text }];
        if (block.type === 'tool_use')
          return [{ type: 'tool_call', toolCallId: block.id, tool: block.name, params: block.input }];
        return [];
      }).map(withSeq(ctx));

    case 'result':
      return [
        { type: 'cost', deltaUsd: raw.total_cost_usd - ctx.lastCost,
          totalUsd: raw.total_cost_usd, tokens: raw.usage },
        { type: 'run_ended',
          outcome: raw.subtype === 'success' ? 'completed' : 'failed',
          summary: raw.result },
      ].map(withSeq(ctx));
    // ...
  }
}
```

### 9.4 Claude Code adapter: implementation notes

Code lives in `packages/agent-runtimes/src/claude-code/` and depends on `@anthropic-ai/claude-agent-sdk` (an optional peer dependency, loaded dynamically at runtime — a deployment that never connects Claude Code does not have to install it).

#### Permissions: deny by default

APOS's `AgentPermissions` maps onto four SDK switches, which together produce closed-world semantics:

| APOS | SDK | Effect |
| --- | --- | --- |
| Base tool names from `allowedTools` | `tools` | Determines which tools the agent can **see** |
| `allowedTools` verbatim (scopes included) | `allowedTools` | Determines what runs **without confirmation** |
| `deniedTools` | `disallowedTools` | Denylist, highest priority |
| Everything else | `canUseTool` | Lands in the adapter's hands |

Two additional constraints:

- **`settingSources: []`** — do not load user / project / local config. Otherwise a `.claude/settings.json` sitting in the repo could put back a tool that Policy denied, and the permission model is theater.
- **When writability cannot be established, disable every write tool** (`Write` / `Edit` / `MultiEdit` / `NotebookEdit`). Writing "please don't modify files" in the prompt is not access control.

"Writable" is decided at two levels, and **the platform's own facts win**:

| Situation | Basis |
| --- | --- |
| The platform already prepared a workspace (`task.workspace`) | Use `RunWorkspace.writable` directly; it governs in both directions |
| No workspace | Fall back to inferring from resource scopes: a **repo or dataset** scope with `access: 'write'` |

Neither line is optional:

- **A dataset counts as writable too**, matching the primary-mount rule in §7.3 (writable repo → writable dataset). Recognize only repos and an agent granted dataset write gets a writable workspace with every write tool disabled — the access page says Write, the agent says it has no Write tool, both subsystems are individually "correct," and no layer raises an error.
- **The workspace's `writable` overrides scope inference.** A planning run's scratch directory has **no resource scope corresponding to it at all**, so inference alone can never conclude "writable" — the platform hands over a writable directory and the agent cannot produce an artifact in it. The reverse direction is covered too: a read-only mount tightens explicitly.

The override touches only the "writable" conjunct; it **cannot release a tool the capability gate never granted**. Write tools are picked back out of `allowedTools`, and without `workspace.write` they were never in there; an explicit denylist is likewise not undone. The sandbox-level runtimes (Codex, generic CLI) use the same test, landing on `workspace-write` versus `read-only` instead — if three runtimes gave three different answers, "switching runtimes makes writes work" turns into folklore.

#### Ungranted tools → human decision

`canUseTool` fires only when a tool was neither allowlisted nor denylisted, which is precisely "the agent wants a capability nobody gave it." The adapter splits on that:

- Explicit denylist hit → refuse outright, don't bother a human (Policy already ruled)
- Ungranted → emit an `intervention_request` (`reason: permission_needed`) and refuse with `interrupt: true`

The second turns the agent's request for help into a Decision on someone's queue (via the promotion rules in `ingest.ts`) instead of letting it keep probing without the capability. To turn this off, set `onUngrantedTool: 'deny'` — and then `interventionRequest` in the capability manifest flips to `false` to match. No silent degradation.

#### Credential and environment isolation

- Credentials come from `APOS_AGENT_ANTHROPIC_API_KEY`, **kept separate from the platform's own `ANTHROPIC_API_KEY`**. If it is not configured, dispatch is refused outright; it never quietly falls back to the platform key. Reusing it requires setting `allowInheritedCredentials` explicitly, which leaves an audit trail.
- The child process environment gets only `PATH`, `HOME`, and the agent's own key. No `{ ...process.env }` — that would hand the agent the database password and every other service's token, right past resource-scope control.

#### Connecting a relay: endpoint, credential variable name, environment table

Beyond the official endpoint there is a whole class of connections: relays, self-hosted gateways, Bedrock/Vertex fronting proxies. The three things they need land in three different places:

| What to configure | Where it goes | What it becomes |
| --- | --- | --- |
| Gateway address | The agent's "endpoint" (`agents.endpoint`) | `ANTHROPIC_BASE_URL` |
| Authentication scheme | The `credentialEnv` config item | Whether the credential is delivered as `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` |
| Any other variable | The `env` config item (a JSON blob) | Passed through to the child process verbatim |

**Why `credentialEnv` deserves its own config item**: the official endpoint uses `x-api-key`, while most relays use `Authorization: Bearer` and read `ANTHROPIC_AUTH_TOKEN`. Getting the variable name wrong surfaces as a bare 401, and nothing in a 401 points at "you used the wrong name." An explicit field with two choices beats making someone guess their way through an environment table. Once switched, **`ANTHROPIC_API_KEY` is no longer sent alongside** — send both and the SDK prefers the API key, and the symptom is "I definitely switched to AUTH_TOKEN, and the request still hits the official endpoint with x-api-key."

**Why the free-form `env` JSON exists at all**: the platform's config schema will always lag behind the runtimes. A gateway address and a token belong to **this agent**, not to the APOS process — `passthroughEnv` (name a variable, take its value from the APOS environment) cannot express that, and changing a deployment environment variable for one agent would hit every other agent sharing that name.

★ The runtime config as a whole is itself a **custom JSON document** (in the UI it is literally a JSON textarea): keys the platform knows are validated against their spec, and keys it does not know are **stored as-is and written to the database as-is**, with the unrecognized ones simply listed back to the user after saving (`unknownConfigKeys`). Dropping them means "I definitely typed that and it vanished"; rejecting them means "the runtime shipped a new option, the platform hasn't released yet, so this agent cannot be saved" — and both push someone toward editing the database by hand. The price is that a typo'd key (`modle`) is no longer treated as an error; that notice is all you get.

`env` is still **a declared field** within that document, so it carries two more constraints:

- **Value shapes are still validated.** Keys must be legal variable names and values must be strings — `{"MAX_TOKENS": 4096}` is rejected at save time rather than letting Node quietly turn it into `"4096"`.
- **Secret-looking keys still go through the credential channel.** When a key name contains `TOKEN` / `KEY` / `SECRET` / `AUTH` and the like (the test is `isSecretEnvKey`, matching on underscore-separated segments, so `GIT_AUTHOR_NAME` does not count), the literal value is converted into a `secret://` reference (encrypted if `APOS_SECRET_KEY` is set, plaintext if not — see 09-security §5.4), and the API returns only the placeholder `secret://saved`. Posting that placeholder back unchanged means "leave this one alone" — the UI is a single JSON textarea, so changing the gateway address resubmits the whole document, and without that convention editing one field would wipe the token sitting next to it.
- **Hand-written `secret://` references are not accepted.** Otherwise anyone who can edit an agent could paste in `secret://env/DATABASE_URL` and read any variable in the APOS process environment out to the agent — exactly what the `passthroughEnv` allowlist exists to prevent. To pull a value from the process environment you must write `env:VARIABLE_NAME`.
- **References that cannot be resolved are not delivered, and are listed on the config page.** Quietly delivering an empty string surfaces as the agent reporting a 401, with nothing on the scene pointing at "the environment variable holding that key was never set."

**The layering order runs platform → user, with `env` last**: minimal set → credential → endpoint → `passthroughEnv` → `env`. What the user typed always takes effect, even at the cost of letting them overwrite their own credential — "I set it and it didn't take" is the worst failure mode a configuration feature has.

State the cost plainly: this field can route around the security settings above (say, by hand-setting a variable that relaxes a limit), so it is labeled "affects the security boundary" in the UI.

**The credential may live only in `env`.** In that case the credential field is empty, and `dispatch`'s credential gate recognizes that shape — otherwise an agent that is fully configured and genuinely works would be refused dispatch, with an error message confidently telling the user to go configure `APOS_AGENT_ANTHROPIC_API_KEY`. The same rule applies to Codex and to the six generic CLIs.

#### Cost: estimate, then correct against the authoritative number

Claude Code only produces the authoritative `total_cost_usd` when the run ends, but the board needs cost while the run is still going. So there are two tracks:

1. Each turn, estimate from the real token counts in `message.usage` × a local price table and emit a `cost` event
2. When `result` arrives, emit one delta event that corrects the running total to `total_cost_usd`, with `tokens` all zero (ingest treats tokens as additive, so reporting them again would double count)

A stale price table only affects the in-flight display, never the final books. Separately, `limits.maxCostUsd` is passed straight to the SDK's `maxBudgetUsd` — the budget is a hard constraint on the runtime side, with no need to wait for our cost events to catch up.

#### Capabilities and degradation

| Capability | Supported | Notes |
| --- | --- | --- |
| `pause` | ✗ | The SDK has no pause/resume semantics. Per the degradation matrix, pause degrades to terminate with a second confirmation |
| `runtimeConstraints` | ✓ | The prompt is fed as an `AsyncIterable`, so constraints can be injected mid-run (Approve with Constraints genuinely reaches the runtime) |
| `terminate` | ✓ | `abortController.abort()` |
| `statusQuery` | ✓ | Only for runs held by this process. Not found means terminated — the session is a child process of this process, and after a restart that child no longer exists, so the answer is actionable for orphan detection |
| `artifactUpload` | ✓ | Claude Code has no artifact upload channel, so the adapter synthesizes them from the final reply: the body is stored as a `document`, and any PR link in the reply is broken out as a `pull_request` |
| `subAgentDelegation` | ✓ | `task_started` messages are translated into `delegation` events |

#### Error classification

Prefer the structured signals the runtime **reports** (`classificationSource: 'reported'`); fall back to text heuristics only when there are none (marked `'inferred'`, which recovery treats more conservatively):

| Signal | Classification |
| --- | --- |
| `error_max_budget_usd` | `budget_exceeded`, not retriable |
| `error_max_turns` | `timeout`, retriable |
| `permission_denials` non-empty | `permission_denied`, not retriable |
| `SDKAssistantMessage.error` | Mapped by error code (auth → `permission_denied`, rate limit / overload → `external_unavailable`, …) |
| Module load failure | `runtime_error`, not retriable — no number of retries fixes a deployment problem |

**`subtype: 'success'` does not mean the task succeeded.** Errors like an authentication failure come back as `subtype='success'` with `is_error=true`, and the `result` text *is* the error message. Look only at subtype and a completely failed run gets recorded as `completed`, the task promptly transitions to reviewing, and it carries an artifact whose body is an error message. So the adapter uses three signals to declare failure: `subtype !== 'success'`, `is_error`, and whether a fatal error occurred during execution. `queryStatus` also takes its terminal state straight from the `run_ended` outcome rather than deciding again — two independent judgments will eventually disagree.

> Both of these only showed up against the real SDK; a fake SDK in a unit test does not invent that combination on its own.

#### Event ordering

`subscribe` chains delivery into a single Promise chain, guaranteeing subscribers receive events strictly in `seq` order. `(runId, seq)` is the primary key of `run_events`, and out-of-order delivery breaks both deduplication and incremental updates. `run_started` is emitted before the session actually starts — if the session fails to come up, you still need to see that the run began.

### 9.5 Codex adapter: implementation notes

Code lives in `packages/agent-runtimes/src/codex/`. It forced out an assumption the protocol had never had to test: **a permission model is not necessarily tool-level**. Codex has only sandbox levels (`read-only` / `workspace-write`), which cannot express "Bash is allowed but rm is not." The mapping always **tightens**, and rules that cannot be expressed are listed in `unenforceable` and shown in the Run detail page — swallow them silently and the user will believe `deniedTools` took effect here too.

### 9.6 Generic headless CLI adapter

Code lives in `packages/agent-runtimes/src/cli/`. **One** `GenericCliRuntime` plus a declarative profile table covers six CLIs:

| kind | Binary | Prompt delivery | Output shape | Streaming | Tools visible | Tokens |
| --- | --- | --- | --- | --- | --- | --- |
| `pi` | `pi` | `-p <prompt>` | Plain text | ✓ | ✗ | ✗ |
| `gemini_cli` | `gemini` | `-p <prompt>` | **A single JSON blob** | ✗ | ✗ | ✓ |
| `aider` | `aider` | `-m <prompt>` | Plain text | ✓ | ✗ | ✗ |
| `goose` | `goose` | stdin | stream-json | ✓ | ✓ | ✓ |
| `opencode` | `opencode` | Positional argument | Plain text | ✓ | ✗ | ✗ |
| `qwen_code` | `qwen` | `-p <prompt>` | stream-json | ✓ | ✓ | ✓ |

**Why they share one adapter**: copying the Codex adapter six times copies the same thing six times — spawn a child process, set cwd, hand it a minimal environment, SIGTERM on timeout followed by SIGKILL, keep a tail of stderr, deliver events serially by seq. That part is identical across every CLI, and it is the part where **the mistakes have already been made once**. The genuinely different pieces are five: binary name, argv, where the prompt goes in, output shape, credential environment variable. Those are data, not logic.

**Why the parsing is defensive**: the output formats for these six come from their respective docs, not from measurement. Write field-by-field mappings straight from the docs, and one renamed field makes the event stream **go silently empty** — the run is executing, the UI shows nothing, and no error is raised anywhere. So `translate.ts` works from the other end: recognize only what is structurally recognizable (usage numbers, errors, text, tool calls), and **pass anything unrecognized straight through as a note**. The cost is an event stream less detailed than Claude Code's; the benefit is that nothing is ever lost, and the next person can fill the mapping in by reading the notes.

**Three degradations that hold for every CLI**, written honestly into the capability manifest:

1. **Permissions are sandbox-level** — reuse `mapSandbox` from §9.5; rules that cannot be expressed are listed in the Run detail page
2. **There is no system prompt channel** — governance rules can only be folded into the front of the user message (`buildInlinePreamble`), which carries less weight than a real system prompt
3. **Single-shot execution, no mid-run injection** — `runtimeConstraints` and `interventionRequest` are both false

A few targeted behaviors: Aider is forced to `--no-auto-commits` (committing is the workspace provider's single responsibility, and committing on both sides makes one run produce a scatter of fragmentary commits); auto-approval (`--yolo` / `--approval-mode yolo`) is granted only under a writable sandbox; Gemini CLI emits a note at `subscribe` time explaining that there is no output until the run finishes, otherwise the user stares at a motionless execution stream and assumes it hung.

**Adding a seventh CLI**: add a profile to `cli/profile.ts` and a spec to `contracts/runtime-config.ts`. Neither the adapter nor the factory changes by one character, and the config UI grows that runtime's configurable-option list and JSON defaults on its own.

Each of the six also carries its own `env` table (the rules from §9.4 apply unchanged). The ones whose profile has `baseUrlEnv` set to `null` (pi / gemini_cli / goose / opencode) have no declarative endpoint channel, so connecting a self-hosted endpoint has to go through `env` — which is exactly why that escape hatch exists: nobody has to wait for the platform to add a `baseUrlEnv` for every CLI first.

---

## 10. Security

| Concern | Measure |
| --- | --- |
| Callback authentication | Each run gets a short-lived token at dispatch, valid only for that runId and dead when the run ends |
| Event forgery | Signed callbacks (HMAC) plus a check that the runId and the token are bound to each other |
| Permission escape | The permission list ships on every dispatch; APOS re-checks high-risk tool calls on its own side rather than fully trusting the runtime's enforcement |
| Credential isolation | Agents use their own credentials and never reuse a human user's token ([09 Security](09-security.md) §4) |
| Context leakage | Context is filtered by data classification before it is sent; sensitive data never enters an agent's context |
| Cost attacks | Hard cost ceilings; anomalous-growth detection; when the runtime is uncontrollable (no terminate capability), a forcibly lower ceiling |

**What "not fully trusting the runtime's enforcement" means in practice**: even after `allowedTools` has been handed to the agent, tool calls involving destructive operations (`sideEffects: 'destructive'`) are re-checked against permissions and Policy on the APOS side. This guards against a buggy or bypassed runtime implementation.

---

## 11. Versioning

- `protocolVersion` follows semantic versioning
- Backward-compatibility rule: new event types must be safely ignorable by older versions; new capability fields default to `false`
- APOS supports talking to runtimes on several protocol versions at once
- Breaking changes require a major version bump and at least one version's worth of transition period

---

## 12. Open questions

1. **Should `selfReport` be mandatory?** It has a large effect on debugging speed (page doc 09), but not every runtime can provide it. Proposal: the protocol specifies `SHOULD`, and where it is unsupported the adapter feeds the last few events to APOS's own LLM to generate a speculative explanation, clearly labeled 「由 APOS 推断，非 Agent 自述」 ("inferred by APOS, not reported by the agent").
2. **How should task semantics be defined on top of MCP?** MCP is a tool protocol, not an agent protocol. We need to decide whether to wrap a layer on top of MCP (with APOS driving the conversation loop itself) or to require MCP servers to expose a task-level interface. The former gives more control but makes APOS carry the complexity of the agent loop.
3. **Cost and permission ownership for sub-agent delegation**: does a child run's cost roll into the parent run or stand alone? Are a sub-agent's permissions inherited from the parent or configured separately? Leaning toward accumulating cost into the parent run (easier for users to understand total spend) and intersecting parent and child permissions (least privilege).
4. **Should runtimes without `terminate` be allowed to connect at all?** From a governance standpoint this is a major defect. Proposal: allow them, but force a "restricted runtime" label, forbid their use on high-risk tasks, and pin their cost ceiling at half the organization default.
5. **How does `seq` continue after an orphan is reclaimed?** The instance taking over does not know how far the previous one got. Approach: seq is generated by the runtime rather than by APOS, and APOS only deduplicates (the `(runId, seq)` primary key deduplicates naturally). We need to confirm every runtime can guarantee globally monotonic seq.
6. **Does the protocol need to support "cleanup after cancellation"?** An agent may already have created a branch and opened a PR. Should the runtime be required to clean up on termination? Leaning toward not requiring it (cleanup logic is complex and error-prone) and instead having APOS record the uncleaned resources and prompt a human to handle them.
