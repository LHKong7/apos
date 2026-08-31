# 02 Domain Model and Database Design

*[中文版本 / Chinese version](02-domain-model.zh.md)*

Covers the ten core objects from chapter 6 of the product doc. The database is PostgreSQL 16.

---

## 1. Three modeling decisions that run through everything

Before looking at individual tables, three decisions that shape all of them.

### 1.1 Actor, not User

Section 10.1 of the product doc defines four kinds of identity: Human / Agent / Service / External Integration. Section 10.3 explicitly requires that agent permissions be configured independently of human ones.

**So there is no `user_id` field anywhere in the system — only `(actor_type, actor_id)`.**

```sql
CREATE TYPE actor_type AS ENUM ('human', 'agent', 'service', 'external', 'system');
```

Every "who did this" is that pair of columns. It looks like a naming difference; it isn't:

- The audit log distinguishes human from machine action by construction — nothing has to be inferred after the fact
- Permission checks take one shape of input, so an agent can never accidentally fall onto a human permission path
- The "status source marker" the page docs ask for (🔧 system / 🤖 agent / 👤 human / 🔗 external) renders straight off `actor_type`

**The cost**: no foreign key can point at a single table. The approach is to skip the foreign key, enforce it in the application layer, and provide a view for joins:

```sql
CREATE VIEW actors AS
  SELECT 'human'::actor_type AS type, id, name, avatar_url FROM users
  UNION ALL
  SELECT 'agent', id, name, icon_url FROM agents
  UNION ALL
  SELECT 'service', id, name, NULL FROM service_accounts;
```

### 1.2 One work-item table with a type discriminator

Section 6.3 of the product doc defines Work Item as the unified unit of work, configurable across 13 types (Requirement / Feature / Story / Task / Bug / Research / Review / Test / Incident / Decision / Approval / Release / Knowledge Item).

**The model**: one table, a `type` discriminator column, and `type_data JSONB` for the fields specific to each type.

Not a table per type (that turns every cross-type query, the dependency graph, and every board query into a UNION), and not EAV (unqueryable). Shared fields are columns; type-specific fields go into JSONB with GIN indexes added as needed.

**Note**: the product doc lists `Decision` and `Approval` as Work Item types, while section 6.7 simultaneously defines Decision as a core object in its own right. The resolution here: **Decision is its own table** (it has an owner, a deadline, options, co-signing — real structure), and the `decision` work-item type is only a lightweight placeholder pointing at a Decision, so decisions show up on the board and in the dependency graph.

### 1.3 Multi-tenancy and soft delete

- Every business table carries `org_id`, with Row Level Security enabled
- Domain objects are **never physically deleted**; they get `deleted_at`. The reasons: the audit requirement (10.5) and the integrity of the event causality chain — deleting a work item leaves every historical event that references it dangling
- The `events` table is never deleted, only archived

---

## 2. Identity and organization

**Organization** is the top-level container for all data: projects, work items, agents, code repositories, members, audit events all hang off some `org_id` and are fully isolated from each other. The equivalent of Plane's Workspace.

### 2.0 Why it isn't called Workspace

★★ `workspace` already has a fixed meaning in this codebase: **the git working area an agent does its work in** (`AGENT_WORKSPACE_ROOT`, `WorkspaceProvisioner`, `agent_runs.workspace`). If two concepts share the word, sentences like "clean up the workspace" or "workspace permissions" point at two completely unrelated things at once — and that ambiguity is most expensive exactly when you're debugging, because the person reading the log has no way to tell which one is meant.

The organization concept is already spread across `org_id` on 25 tables, the whole `OrgRole` enum, and every `org_admin` check. Renaming it is pure text-shuffling for zero gain, and it would collide head-on. So: **the product calls it "organization," and the word `workspace` only ever means an agent's working area.**

```sql
CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          text NOT NULL UNIQUE,             -- human-readable identifier in URLs
  description   text,
  settings      jsonb NOT NULL DEFAULT '{}',
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ★ Accounts are **global**; they belong to no organization
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  name          text NOT NULL,
  avatar_url    text,
  -- product doc 6.5
  skills        text[] NOT NULL DEFAULT '{}',
  approval_scopes text[] NOT NULL DEFAULT '{}',   -- what they may approve: db_change, security_exception...
  notification_prefs jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'active',   -- active | suspended | offboarded
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ★★ Membership and org role live here, not on users
CREATE TABLE organization_members (
  org_id        uuid NOT NULL REFERENCES organizations(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  org_role      text NOT NULL DEFAULT 'member',   -- org_admin | member
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE service_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  name          text NOT NULL,
  purpose       text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

### 2.1 Why account and membership are many-to-many

★★ The old `users.org_id` + `users.org_role` welded account and membership into one-to-one: to join a second organization you had to register a second account. But the boundary between organizations *is* the multi-tenant isolation boundary, so "one person's two accounts" are **two different people** as far as the audit trail is concerned — consultants, contractors, and platform staff who work across organizations simply cannot be described.

★ Org role follows membership rather than the account: the same person can be an admin of org A and an ordinary member of org B. Put it on `users` and that sentence becomes unsayable.

★ Email is therefore globally unique. The same address could previously have one account in each of two organizations; those rows now have to be merged — migration 0014 fails loudly and lists them rather than letting Postgres throw an unrecognizable constraint violation.

### 2.2 "Which organization am I in" is carried explicitly on the request

Once an account can belong to several organizations, this can no longer be read off the account, so it travels in the `X-Org-Id` header (identity in `Authorization: Bearer`, organization in this header; see `resolveCurrentOrg` in `rbac.ts`).

★ **A missing header must not be an error**: old clients, curl scripts, and the first page load after seeding all omit it, and returning 400 there shows up as "the whole site is blank." So a missing header falls back to a deterministic default (the first organization by join time), and the computed `currentOrgId` is returned to the caller — the frontend should not have to guess, because a wrong guess looks like the switcher showing A while the data comes from B, with neither side reporting anything wrong.

★ Header present but not a member → **404, not 403**. A 403 confirms "this organization exists," which turns org ids into an enumerable probe; same reasoning as at the project layer.

★ A write route that carries an org id in the URL (`PATCH /organizations/:id`) must verify that it is the **current** organization: the permission check ran against the current org's `orgRole`, so if the handler then goes and modifies a different organization named in the URL, that check bought nothing.

`approval_scopes` backs the automatic assignment of decision ownership in product doc 8.7.5 — when a decision is created, the system looks up people holding the matching scope for its type.

---

## 3. Project (6.1)

```sql
CREATE TYPE autonomy_level AS ENUM ('human_led', 'agent_led_approval', 'agent_autonomous');
CREATE TYPE project_status AS ENUM ('active', 'paused', 'completed', 'archived');

CREATE TABLE projects (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  name              text NOT NULL,
  goal              text,
  type              text NOT NULL DEFAULT 'development',  -- drives the default flow and Policy templates
  status            project_status NOT NULL DEFAULT 'active',
  autonomy_level    autonomy_level NOT NULL DEFAULT 'agent_led_approval',
  risk_level        risk_level NOT NULL DEFAULT 'medium',

  sponsor_id        uuid REFERENCES users(id),      -- business owner
  tech_lead_id      uuid REFERENCES users(id),      -- technical owner

  starts_at         date,
  ends_at           date,
  budget_amount     numeric(12,2),                  -- NULL = unlimited
  budget_currency   text NOT NULL DEFAULT 'USD',
  cost_spent        numeric(12,2) NOT NULL DEFAULT 0,  -- denormalized running total, so nothing has to aggregate on read

  stage_config      jsonb NOT NULL DEFAULT '[...]', -- the six stages are configurable
  wip_limits        jsonb NOT NULL DEFAULT '{}',    -- { "execution": 8, ... }

  paused_reason     text,
  paused_by         uuid,
  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_members (
  project_id    uuid NOT NULL REFERENCES projects(id),
  actor_type    actor_type NOT NULL,
  actor_id      uuid NOT NULL,
  role          text NOT NULL,        -- pm | tech_lead | sponsor | member | viewer
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, actor_type, actor_id)
);
```

**`project_members` keys on actor, not user**: an agent joins a project through the same table. The product doc calls them "project agents" and lists them separately from project members, but permission checks need to treat the two uniformly — whether an agent belongs to this project and whether a person belongs to this project are the same question.

**The denormalized `cost_spent`**: cost is displayed constantly on the board, the overview, and the cards, and a live `SUM` over `agent_runs` is far too slow. A trigger or the application layer adds to it when a run ends, with a daily reconciliation job to correct drift.

---

## 4. Requirement (6.2)

```sql
CREATE TYPE requirement_status AS ENUM (
  'draft', 'analyzing', 'clarifying', 'awaiting_approval',
  'approved', 'rejected', 'on_hold'
);

CREATE TABLE requirements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  project_id        uuid NOT NULL REFERENCES projects(id),
  status            requirement_status NOT NULL DEFAULT 'draft',

  -- Raw input (never overwritten; product doc 8.2 requires the original stay verifiable)
  raw_input         text NOT NULL,
  input_method      text NOT NULL,   -- manual | conversation | document | external | api
  source_ref        jsonb,           -- { system: 'jira', key: 'ORDER-142', url: ... }

  -- AI structuring result (8.2.2)
  title             text,
  business_context  text,
  user_problem      text,
  business_goal     text,
  user_stories      jsonb NOT NULL DEFAULT '[]',
  scope             jsonb NOT NULL DEFAULT '{}',   -- { in_scope: [], out_of_scope: [] }
  non_functional    jsonb NOT NULL DEFAULT '[]',
  success_metrics   jsonb NOT NULL DEFAULT '[]',
  constraints       jsonb NOT NULL DEFAULT '[]',
  risks             jsonb NOT NULL DEFAULT '[]',

  -- ★ Acceptance criteria must be structured: the later Review stage verifies them automatically
  acceptance_criteria jsonb NOT NULL DEFAULT '[]',

  -- Field-level provenance and human-edit markers (the side-by-side view in 8.2)
  field_provenance  jsonb NOT NULL DEFAULT '{}',
  -- { "title": { "source": "raw_input", "span": [0,24], "edited_by_human": false } }

  completeness      jsonb NOT NULL DEFAULT '{}',   -- the six-dimension score in 8.2.3
  priority          text NOT NULL DEFAULT 'medium',
  due_at            timestamptz,

  approved_by       uuid,
  approved_at       timestamptz,
  reject_reason     text,

  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Clarification questions (the four levels in 8.2.4)
CREATE TYPE clarification_level AS ENUM (
  'must_confirm',        -- 🔴 a human must confirm; blocking
  'default_applicable',  -- 🟡 a default rule applies
  'assumption_ok',       -- 🔵 record the assumption and continue
  'auto_resolved'        -- 🟢 resolved automatically from the knowledge base
);

CREATE TABLE requirement_clarifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id  uuid NOT NULL REFERENCES requirements(id),
  level           clarification_level NOT NULL,
  question        text NOT NULL,
  impact          text,                 -- "what happens if this goes unanswered"
  agent_suggestion text,                -- what the agent leans toward
  suggestion_basis text,                -- why it leans that way
  options         jsonb DEFAULT '[]',   -- quick-pick options
  answer          text,
  answered_by     uuid,
  answered_at     timestamptz,
  resolved_source text,                 -- the knowledge source, when auto_resolved
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Confirmed assumptions: passed on to the Project Agent and every executing agent
CREATE TABLE requirement_assumptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id  uuid NOT NULL REFERENCES requirements(id),
  statement       text NOT NULL,
  origin          text NOT NULL,        -- clarification | agent_inferred | human_added
  confirmed_by    uuid,                 -- NULL = never confirmed by a human
  invalidated_at  timestamptz,          -- marked when execution disproves it
  invalidated_reason text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

**`requirement_assumptions.invalidated_at`** backs "requirement conflict discovered" in product doc 8.8.4 → escalate to a human: when execution finds an assumption doesn't hold, it is marked and a decision is raised.

**`field_provenance`** backs the side-by-side original-text highlighting in page doc 03. It is the interaction that earns trust on the requirement page, and the data has to be recorded at structuring time — it cannot be reconstructed later.

---

## 5. Work Item (6.3)

### 5.0 Numbering and creation paths

**Numbering**: `<project prefix>-<per-project sequence>` (`ORD-19`). The prefix lives in `projects.identifier` (unique within the organization); the sequence is allocated by atomically incrementing `projects.work_item_seq` (`modules/work-item/numbering.ts`).

★★ The reason it exists is that it can be *said out loud*. With nothing but a uuid, you can't read it out in standup, you can't mention it in chat, and writing it into a commit message tells nobody anything — "that order-export task" becomes the only way to refer to it, and a project usually has three of those.

★ A column plus atomic increment, not a Postgres sequence: one sequence per project means creating a project requires DDL, and DDL can't roll back alongside the business transaction. `UPDATE … SET seq = seq + n RETURNING seq` is just as atomic and skips no numbers under concurrency. **Take n at a time** (plan decomposition creates a dozen rows at once); allocating in a loop lets someone else's numbers land in the middle, so the tasks from one plan get discontinuous numbers and read as if some went missing.

★ Store only `number`, don't denormalize the whole `ORD-19`: once a project prefix changes, the denormalized copy needs a bulk rewrite, and missing a row shows up as two prefixes coexisting in the same project — far more expensive than one extra join.

**Two creation paths**:

| Path | Entry point | Landing status | Gate |
| --- | --- | --- | --- |
| Plan decomposition | `POST /requirements/:id/plans` → approve | `draft` → `ready` | `requirement.approve` + `plan.approve` |
| Manual creation | `POST /projects/:id/work-items` | `draft`, a human must release it | `work_item.create`, plus `plan.approve` to release |

★★ Manual creation **does not bypass the Human Gate**.

Before this, a work item could only be generated. That chain is the heart of the product (both Human Gates sit on it), but it also made "jot down a bug" impossible in the system — and that is the single most frequent action in any task tracker.

Adding the entry point must not remove the gate along with it: if a manually created task could be dispatched the moment it exists, anyone who can create a task can make an agent do anything. So manually created items always stop at `draft` (the endpoint **rejects** a caller-supplied status), and moving from `draft` to `ready` requires `plan.approve` — the gate's granularity shifts from "approve a plan" to "approve a task," rather than disappearing.

★ The check lives in the handler, not the route table: the route table can't see the item's **current** status, and `changes_requested → ready` (rework starting over) also lands on `ready`. That step's plan was approved long ago, and demanding approval again would drag the tech lead into every rework cycle.

★ Manually created items leave a trace in `type_data.origin = 'manual'` — an audit has to be able to answer "where did this come from."

```sql
CREATE TYPE work_item_type AS ENUM (
  'requirement','feature','story','task','bug','research',
  'review','test','incident','decision','approval','release','knowledge'
);

CREATE TYPE work_item_status AS ENUM (
  -- Intake
  'draft','clarifying','awaiting_requirement_approval',
  -- Planning
  'planning','awaiting_plan_approval',
  -- Execution
  'ready','executing','blocked','failed',
  -- Review
  'reviewing','changes_requested','awaiting_decision',
  -- Release
  'waiting_for_release','releasing','released',
  -- Done
  'acceptance','done','cancelled'
);

CREATE TYPE risk_level AS ENUM ('low','medium','high','critical');

CREATE TABLE work_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  project_id      uuid NOT NULL REFERENCES projects(id),
  requirement_id  uuid REFERENCES requirements(id),
  plan_id         uuid REFERENCES plans(id),

  type            work_item_type NOT NULL,
  status          work_item_status NOT NULL DEFAULT 'draft',
  stage           text NOT NULL,          -- denormalized: derived from status, so the board can query by column
  title           text NOT NULL,
  description     text,
  priority        smallint NOT NULL DEFAULT 2,   -- 0=P0 .. 3=P3
  risk_level      risk_level NOT NULL DEFAULT 'low',

  -- Hierarchy: parent pointer + path for subtree queries
  parent_id       uuid REFERENCES work_items(id),
  path            ltree,                  -- 'root.backend.api'
  position        integer NOT NULL DEFAULT 0,

  -- ★ Accountability is separate from execution (product doc 8.3.4 supports "agent executes, human reviews")
  owner_id        uuid,                   -- human owner (accountable)
  executor_type   actor_type,             -- type of the executing party
  executor_id     uuid,                   -- id of the executing party

  planned_start   timestamptz,
  planned_end     timestamptz,
  actual_start    timestamptz,
  actual_end      timestamptz,
  estimated_hours numeric(6,2),

  estimated_cost  numeric(10,4),
  actual_cost     numeric(10,4) NOT NULL DEFAULT 0,

  -- Acceptance criteria: inherited from the requirement or generated by the plan
  acceptance_criteria jsonb NOT NULL DEFAULT '[]',
  -- [{ id, text, verification: 'auto'|'agent'|'human', status, evidence_ref, verified_at }]

  -- Extra constraints attached by a human (from Approve with Constraints)
  constraints     jsonb NOT NULL DEFAULT '[]',
  -- [{ type, value, enforcement: 'system'|'agent'|'manual', decision_id }]

  -- Current Human Gate state (the eight states in page doc §5.1)
  human_gate      text,
  human_gate_ref  uuid,                   -- the associated decision_id

  blocked_since   timestamptz,
  blocked_reason  text,
  blocked_detail  jsonb,

  type_data       jsonb NOT NULL DEFAULT '{}',   -- type-specific fields
  external_refs   jsonb NOT NULL DEFAULT '[]',   -- [{ system, key, url }]

  version         integer NOT NULL DEFAULT 1,    -- optimistic lock
  deleted_at      timestamptz,
  merged_into     uuid REFERENCES work_items(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON work_items (project_id, stage, status) WHERE deleted_at IS NULL;
CREATE INDEX ON work_items (executor_type, executor_id, status) WHERE deleted_at IS NULL;
CREATE INDEX ON work_items (owner_id) WHERE deleted_at IS NULL;
CREATE INDEX ON work_items USING gist (path);
CREATE INDEX ON work_items (project_id, blocked_since) WHERE blocked_since IS NOT NULL;
```

### 5.1 Dependencies (6.3 dependencies / 8.6.2)

```sql
CREATE TYPE dependency_type AS ENUM (
  'finish_to_start',   -- FS: the default
  'start_to_start',    -- SS
  'artifact',          -- depends on an artifact
  'decision',          -- depends on a human decision
  'permission',        -- depends on a permission grant
  'external',          -- depends on an external system
  'data'               -- depends on data being prepared
);

CREATE TABLE work_item_dependencies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL,
  from_id       uuid NOT NULL REFERENCES work_items(id),  -- predecessor
  to_id         uuid NOT NULL REFERENCES work_items(id),  -- successor
  type          dependency_type NOT NULL DEFAULT 'finish_to_start',
  lag_minutes   integer NOT NULL DEFAULT 0,
  created_by_type actor_type NOT NULL,
  created_by_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_id, to_id, type),
  CHECK (from_id <> to_id)
);

CREATE INDEX ON work_item_dependencies (to_id);
CREATE INDEX ON work_item_dependencies (from_id);
```

**Cycle detection happens in the application layer** (a recursive CTE run before insert), not as a database constraint — PostgreSQL has no constraint that can express acyclicity.

```sql
-- Check whether to_id can reach back to from_id (if so, adding this edge creates a cycle)
WITH RECURSIVE reachable AS (
  SELECT to_id AS node FROM work_item_dependencies WHERE from_id = $to_id
  UNION
  SELECT d.to_id FROM work_item_dependencies d
    JOIN reachable r ON d.from_id = r.node
)
SELECT EXISTS (SELECT 1 FROM reachable WHERE node = $from_id);
```

---

## 6. Plan (6.6)

```sql
CREATE TABLE plans (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id),
  requirement_id    uuid REFERENCES requirements(id),
  version           integer NOT NULL,
  status            text NOT NULL DEFAULT 'draft',
                    -- draft | awaiting_approval | approved | superseded | rejected

  scope             jsonb,
  phases            jsonb NOT NULL DEFAULT '[]',
  critical_path     uuid[] NOT NULL DEFAULT '{}',
  milestones        jsonb NOT NULL DEFAULT '[]',
  risks             jsonb NOT NULL DEFAULT '[]',
  release_plan      jsonb,
  rollback_plan     jsonb,

  estimated_hours   numeric(8,2),
  estimated_cost    numeric(10,2),
  estimated_end     date,

  -- ★ "What will happen automatically," shown before approval; produced by a Policy dry run and snapshotted
  auto_actions      jsonb NOT NULL DEFAULT '[]',
  human_gates       jsonb NOT NULL DEFAULT '[]',

  -- Generation metadata
  generated_by      uuid,              -- agent_id
  generation_run_id uuid,
  model             text,
  generation_cost   numeric(10,4),
  generation_ms     integer,

  approved_by       uuid[],            -- supports dual sign-off
  approved_at       timestamptz,
  revision_feedback text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, requirement_id, version)
);
```

**`auto_actions` must be stored as a snapshot**, not recomputed each time it is displayed. The reason: what the user approved was **that list, at that moment**. If the Policy changes afterward, answering "what exactly did they approve?" requires the snapshot. This is a governance-traceability requirement.

---

## 7. Agent (6.4)

```sql
CREATE TABLE agents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  name              text NOT NULL,
  type              text NOT NULL,      -- code | test | review | research | data | browser
  description       text,

  runtime_id        uuid NOT NULL REFERENCES agent_runtimes(id),
  runtime_ref       text NOT NULL,      -- identifier inside the runtime
  model             text,

  -- ★★ Both columns are RETIRED: never written, never read. What an agent takes
  --    on is decided by the scheduler (ordinary work) or a project role binding
  --    (special duties) — see 04-flow-engine §4.3. They survive only as the record
  --    of pre-change configuration, and are dropped once nothing depends on them.
  skills            text[] NOT NULL DEFAULT '{}',
  applicable_types  work_item_type[] NOT NULL DEFAULT '{}',

  -- ★ Permissions: configured independently, inherited from no human user
  allowed_tools     text[] NOT NULL DEFAULT '{}',
  denied_tools      text[] NOT NULL DEFAULT '{}',   -- explicit denial, wins over allowed
  resource_scopes   jsonb NOT NULL DEFAULT '[]',
  -- [{ kind: 'repo', ref: 'order-service', access: 'write' },
  --  { kind: 'env',  ref: 'production',    access: 'none'  }]

  -- Cost and limits
  max_concurrency   integer NOT NULL DEFAULT 3,
  timeout_seconds   integer NOT NULL DEFAULT 1800,
  cost_limit_per_run numeric(10,4),
  cost_limit_daily  numeric(10,2),
  retry_policy      jsonb NOT NULL DEFAULT '{"max_attempts":2,"backoff_seconds":[60,300]}',

  owner_id          uuid NOT NULL REFERENCES users(id),   -- human owner, never null

  status            text NOT NULL DEFAULT 'active',  -- active | paused | offline | retired
  paused_reason     text,

  -- Denormalized stats (written back periodically by analytics, so nothing aggregates on read)
  stats             jsonb NOT NULL DEFAULT '{}',
  -- { success_rate, first_pass_rate, takeover_rate, avg_cost, avg_duration_s, sample_size }

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_runtimes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  name            text NOT NULL,
  kind            text NOT NULL,   -- claude_code | mcp | http | codex | openhands | builtin
  endpoint        text,
  credential_ref  text,            -- points at secret management; no plaintext here
  protocol_version text,
  capabilities    jsonb NOT NULL DEFAULT '{}',   -- result of protocol capability negotiation; see doc 06
  status          text NOT NULL DEFAULT 'active',
  last_check_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Permission-change audit (required by 10.5)
CREATE TABLE agent_permission_changes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      uuid NOT NULL REFERENCES agents(id),
  changed_by    uuid NOT NULL REFERENCES users(id),
  direction     text NOT NULL,     -- tighten | loosen
  before        jsonb NOT NULL,
  after         jsonb NOT NULL,
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

**`denied_tools` wins over `allowed_tools`**: an explicit denial cannot be inherited away or overridden by a template. Page doc 08 requires denials to be shown explicitly in the UI, so the data model has to support it.

**`owner_id NOT NULL`**: every agent has a human owner. This is not optional — the accountability chain must not break when something goes wrong.

---

## 8. Agent Run (8.5.3)

```sql
CREATE TYPE run_status AS ENUM (
  'queued','dispatching','running','paused',
  'completed','failed','timeout','terminated'
);

CREATE TABLE agent_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  project_id        uuid NOT NULL,
  work_item_id      uuid NOT NULL REFERENCES work_items(id),
  agent_id          uuid NOT NULL REFERENCES agents(id),
  attempt           integer NOT NULL DEFAULT 1,
  previous_run_id   uuid REFERENCES agent_runs(id),

  status            run_status NOT NULL DEFAULT 'queued',
  idempotency_key   text NOT NULL UNIQUE,   -- guards against duplicate dispatch

  -- Input snapshot (★ the core of both debugging and auditing)
  goal              text NOT NULL,
  input_context     jsonb NOT NULL DEFAULT '[]',
  -- [{ kind:'knowledge'|'file'|'previous_run'|'requirement', ref, tokens, used }]
  model             text,
  model_config      jsonb,
  tools_snapshot    text[],                 -- the tool set at dispatch time
  permission_snapshot jsonb,                -- ★ the permissions at dispatch time

  -- Progress
  step_current      integer,
  step_total        integer,
  step_description  text,
  progress_note     text,                   -- the agent's natural-language progress summary

  -- Metering
  tokens_input      bigint NOT NULL DEFAULT 0,
  tokens_output     bigint NOT NULL DEFAULT 0,
  tokens_cache_read bigint NOT NULL DEFAULT 0,
  cost              numeric(10,4) NOT NULL DEFAULT 0,
  tool_call_count   integer NOT NULL DEFAULT 0,

  -- Failure
  error_class       text,   -- see the error taxonomy in doc 06
  error_message     text,
  error_detail      jsonb,
  agent_self_report text,   -- ★ the agent explains, in plain language, why it is stuck

  started_at        timestamptz,
  ended_at          timestamptz,
  last_heartbeat_at timestamptz,
  timeout_at        timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON agent_runs (status, last_heartbeat_at)
  WHERE status IN ('running','dispatching');   -- dedicated to orphan detection
CREATE INDEX ON agent_runs (work_item_id, attempt DESC);
CREATE INDEX ON agent_runs (agent_id, created_at DESC);
```

**`permission_snapshot`**: an agent's permissions may be changed after a run. An audit trail has to know what the permissions were at execution time, and page doc 09 §5.4 explicitly requires displaying them.

**`agent_self_report`**: the key design in page doc 09 §5.7 — have the agent explain the failure in human terms, which is far more useful than a stack trace. It needs Agent Protocol support; for runtimes that don't provide it the field stays empty.

### 8.1 Run events (high volume, kept separate from domain events)

```sql
CREATE TABLE run_events (
  run_id        uuid NOT NULL REFERENCES agent_runs(id),
  seq           integer NOT NULL,
  ts            timestamptz NOT NULL DEFAULT now(),
  type          text NOT NULL,
  -- run_started | context_loaded | tool_call | tool_result | reasoning
  -- | delegation | artifact | human_intervention | policy_check | error | run_ended
  level         text NOT NULL DEFAULT 'detail',   -- milestone | detail
  summary       text NOT NULL,                    -- shown in concise mode
  payload       jsonb,                            -- shown in detailed mode
  cost_delta    numeric(10,6),
  PRIMARY KEY (run_id, seq)
) PARTITION BY RANGE (ts);
```

The `level` column is what makes the "concise ⇄ detailed" toggle in page doc 09 work: concise mode queries only `level='milestone'`.

---

## 9. Decision (6.7)

```sql
CREATE TYPE decision_status AS ENUM (
  'pending','approved','rejected','revision_requested',
  'delegated','taken_over','expired','cancelled'
);

CREATE TABLE decisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  project_id        uuid NOT NULL REFERENCES projects(id),
  work_item_id      uuid REFERENCES work_items(id),
  run_id            uuid REFERENCES agent_runs(id),

  type              text NOT NULL,
  -- requirement_approval | plan_approval | high_risk_operation | release_approval
  -- | budget_overrun | scope_change | conflict_arbitration | agent_failure
  status            decision_status NOT NULL DEFAULT 'pending',
  risk_level        risk_level NOT NULL,
  reversible        boolean NOT NULL DEFAULT true,

  title             text NOT NULL,
  background        text,
  why_human         text NOT NULL,        -- why a human has to decide this
  consequence       text,                 -- ★ what happens if it is left alone
  impact            jsonb NOT NULL DEFAULT '{}',
  -- { blocked_tasks: 5, critical_path_delay_hours: 8.2, projected_delay_days: 1 }

  -- What triggered it
  triggered_by_policy uuid REFERENCES policies(id),
  policy_trace      jsonb,                -- the full evaluation trace; the UI displays it

  -- Responsibility
  assignee_id       uuid REFERENCES users(id),
  assignee_role     text,                 -- records the original role when resolved by role
  delegated_from    uuid,
  requires_cosign   boolean NOT NULL DEFAULT false,

  due_at            timestamptz,
  escalation_level  smallint NOT NULL DEFAULT 0,   -- 0/1/2/3, matching chapter 11 of the product doc
  escalated_at      timestamptz,
  reminded_at       timestamptz,          -- reminder cooldown

  -- Outcome of the decision itself
  selected_option_id uuid,
  resolution_note   text,
  resolved_by       uuid,
  resolved_at       timestamptz,
  applied_constraints jsonb NOT NULL DEFAULT '[]',

  -- Result written back later (feeds "how did it turn out" under "similar past decisions" on page 11)
  outcome           text,                 -- succeeded | failed | rolled_back
  outcome_note      text,
  outcome_at        timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON decisions (assignee_id, status, due_at) WHERE status = 'pending';
CREATE INDEX ON decisions (project_id, status);
CREATE INDEX ON decisions (type, status, created_at DESC);  -- duplicate-decision detection

CREATE TABLE decision_options (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id   uuid NOT NULL REFERENCES decisions(id),
  name          text NOT NULL,
  description   text,
  is_recommended boolean NOT NULL DEFAULT false,
  confidence    numeric(4,3),             -- 0.000–1.000
  rationale     text,
  uncertainties text[],                   -- ★ the agent states where it is unsure
  attributes    jsonb NOT NULL DEFAULT '{}',  -- values for the comparison table's dimensions
  reversible    boolean,
  position      smallint NOT NULL DEFAULT 0
);

CREATE TABLE decision_approvals (           -- co-signing
  decision_id   uuid NOT NULL REFERENCES decisions(id),
  approver_id   uuid NOT NULL REFERENCES users(id),
  status        text NOT NULL DEFAULT 'pending',
  opinion       text,
  decided_at    timestamptz,
  PRIMARY KEY (decision_id, approver_id)
);

CREATE TABLE decision_evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id   uuid NOT NULL REFERENCES decisions(id),
  kind          text NOT NULL,     -- artifact | external_link | metric | report
  title         text NOT NULL,
  ref           text,
  produced_by_type actor_type,
  produced_by_id uuid,
  is_live       boolean NOT NULL DEFAULT false,   -- live data (e.g. a monitoring dashboard)
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

**`outcome` is the field most likely to be forgotten and the most valuable**: the whole point of "similar past decisions" in page doc 11 §5.7 is showing *what was decided then and how it turned out*. It needs to be filled in automatically when the associated task completes, fails, or is rolled back.

---

## 10. Artifact (6.8)

```sql
CREATE TABLE artifacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  project_id    uuid NOT NULL,
  work_item_id  uuid REFERENCES work_items(id),
  run_id        uuid REFERENCES agent_runs(id),

  kind          text NOT NULL,
  -- code | pull_request | test_report | document | design | data_analysis
  -- | screenshot | deployment | release_note | meeting_notes
  title         text NOT NULL,
  storage       text NOT NULL,     -- external | s3 | inline
  external_url  text,
  storage_key   text,
  content       text,              -- when storage='inline'
  metadata      jsonb NOT NULL DEFAULT '{}',
  -- PR: { repo, number, branch, additions, deletions, ci_status, review_status }

  produced_by_type actor_type NOT NULL,
  produced_by_id uuid,
  from_incomplete_run boolean NOT NULL DEFAULT false,  -- came from a terminated run

  created_at    timestamptz NOT NULL DEFAULT now()
);
```

---

## 11. Policy (6.10)

```sql
CREATE TABLE policies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  project_id    uuid REFERENCES projects(id),   -- NULL = organization-level
  name          text NOT NULL,
  description   text,
  priority      integer NOT NULL,               -- lower matches first
  enabled       boolean NOT NULL DEFAULT true,

  condition     jsonb NOT NULL,   -- condition AST; see doc 05
  action        jsonb NOT NULL,   -- action; see doc 05

  -- Statistics (written back by analytics)
  hit_count_30d integer NOT NULL DEFAULT 0,
  avg_wait_seconds integer,

  created_by    uuid NOT NULL,
  disabled_by   uuid,
  disabled_reason text,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON policies (org_id, project_id, priority) WHERE enabled;

CREATE TABLE policy_versions (       -- change history, required for auditing
  policy_id     uuid NOT NULL REFERENCES policies(id),
  version       integer NOT NULL,
  snapshot      jsonb NOT NULL,
  changed_by    uuid NOT NULL,
  direction     text,                -- tighten | loosen | neutral
  simulation_id uuid,                -- a loosening change must reference a simulation result
  changed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (policy_id, version)
);
```

---

## 12. Event (6.9)

The event table design is covered in [03 Event Model](03-event-model.md). Only the structure is listed here:

```sql
CREATE TABLE events (
  id            bigserial,
  org_id        uuid NOT NULL,
  project_id    uuid,
  type          text NOT NULL,
  level         text NOT NULL DEFAULT 'milestone',

  actor_type    actor_type NOT NULL,
  actor_id      uuid,
  subject_type  text NOT NULL,
  subject_id    uuid NOT NULL,

  payload       jsonb NOT NULL DEFAULT '{}',
  context_snapshot jsonb,        -- ★ required to replay a Policy simulation

  causation_id  bigint,          -- the event that directly caused this one
  correlation_id uuid,           -- same business process

  occurred_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
```

---

## 13. Integrations (chapter 9)

```sql
CREATE TABLE integrations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  project_id    uuid REFERENCES projects(id),   -- NULL = organization-level connection
  provider      text NOT NULL,   -- github | jira | plane | slack | feishu | ...
  status        text NOT NULL DEFAULT 'active',
  config        jsonb NOT NULL DEFAULT '{}',
  credential_ref text NOT NULL,                 -- points at secret management
  scopes        text[] NOT NULL DEFAULT '{}',
  last_sync_at  timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ★ Source of truth is configured per field (explicitly required by product doc 9.1)
CREATE TABLE sync_mappings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id  uuid NOT NULL REFERENCES integrations(id),
  entity_type     text NOT NULL,     -- work_item | requirement
  field           text NOT NULL,     -- status | assignee | due_at | comments | ...
  source_of_truth text NOT NULL,     -- apos | external | merge
  conflict_strategy text NOT NULL DEFAULT 'record',  -- overwrite | record | accept_notify
  UNIQUE (integration_id, entity_type, field)
);

CREATE TABLE sync_links (         -- local object ↔ external object
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id  uuid NOT NULL,
  entity_type     text NOT NULL,
  entity_id       uuid NOT NULL,
  external_key    text NOT NULL,
  external_url    text,
  last_pushed_at  timestamptz,
  last_pulled_at  timestamptz,
  UNIQUE (integration_id, entity_type, entity_id),
  UNIQUE (integration_id, external_key)
);

CREATE TABLE sync_conflicts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id  uuid NOT NULL,
  entity_type     text NOT NULL,
  entity_id       uuid NOT NULL,
  field           text NOT NULL,
  local_value     jsonb,
  local_changed_at timestamptz,
  local_changed_by jsonb,        -- { actor_type, actor_id, name }
  remote_value    jsonb,
  remote_changed_at timestamptz,
  remote_changed_by text,
  status          text NOT NULL DEFAULT 'open',
  resolved_winner text,
  resolved_by     uuid,
  resolved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

**Preventing sync loops**: every write produced by a sync carries `origin: 'sync:{integration_id}'` in `events.payload`. On the outbound pass, a syncer skips changes whose origin is itself.

---

## 14. Entity relationship overview

```
organizations
 ├── users ─────────────────┐
 ├── agents ────────────┐   │
 │    └── agent_runs ───┼───┼──▶ run_events
 ├── agent_runtimes     │   │
 └── projects           │   │
      ├── project_members ──┘   (actor: human | agent)
      ├── requirements
      │    ├── requirement_clarifications
      │    └── requirement_assumptions
      ├── plans ──────────▶ work_items
      ├── work_items ◀────┬─ work_item_dependencies
      │    ├── artifacts ─┘
      │    └── decisions
      │         ├── decision_options
      │         ├── decision_approvals
      │         └── decision_evidence
      ├── policies ── policy_versions
      ├── integrations
      │    ├── sync_mappings
      │    ├── sync_links
      │    └── sync_conflicts
      └── events  (references everything, referenced by everything, but with no foreign keys)
```

---

## 15. Indexing and performance notes

| Query scenario | Index |
| --- | --- |
| Loading a board column | `work_items (project_id, stage, status) WHERE deleted_at IS NULL` |
| My decision queue | `decisions (assignee_id, status, due_at) WHERE status='pending'` |
| Agent queue | `work_items (executor_type, executor_id, status)` |
| Orphan run detection | `agent_runs (status, last_heartbeat_at) WHERE status IN (...)` |
| Blocked-item scan | `work_items (project_id, blocked_since) WHERE blocked_since IS NOT NULL` |
| Event timeline | `events (subject_type, subject_id, occurred_at DESC)` |
| Duplicate decision detection | `decisions (type, status, created_at DESC)` |
| Dependency traversal | `work_item_dependencies (to_id)` / `(from_id)` |
| Subtree query | `work_items USING gist (path)` |

**Partitioning**: `events` and `run_events` are partitioned by month. Nothing else is partitioned in the MVP.

**Denormalized fields and reconciliation**: `projects.cost_spent`, `agents.stats`, and `work_items.stage` are denormalized. A daily reconciliation job verifies and corrects them and logs any discrepancy — the correctness of a denormalized field is guaranteed by reconciliation, not by developer discipline.

---

## 16. Open questions

1. **Should `work_items.path` use ltree or a closure table?** ltree is simpler, but re-parenting a node requires rewriting the path of the entire subtree. Given that the Project Agent adjusts task decomposition dynamically (8.3.2), moves may not be rare. The recommendation is to start with ltree and switch to a closure table if moves turn out to be frequent.
2. **The relationship between Decision and Work Item**: this document models Decision as its own table, with the `decision` work-item type as a placeholder. Whether that placeholder is genuinely necessary needs confirming — it lets the dependency graph express "waiting on a decision," but it also introduces two places that have to stay in sync.
3. **Does `acceptance_criteria` belong on the requirement or the work item?** Right now it exists in both (the work item inherits from the requirement). We need to settle whether the two may diverge after inheritance, and what happens to already-passed criteria when the requirement changes.
4. **What level of multi-tenant isolation?** RLS or application-layer filtering? RLS is safer but harder to debug and has implications for connection pooling. The recommendation is application-layer enforcement in the MVP with RLS as a second line of defense.
5. **How much should `events.context_snapshot` store?** Store everything and the table balloons; store too little and Policy simulation becomes inaccurate. The exact set of fields has to be pinned down against the fact catalog defined in [05](05-policy-engine.md).
6. **Knowledge-related tables** are not defined in this document (not implemented in the MVP). When they are introduced, we need to consider whether they warrant a separate service and separate storage (possibly a vector database).
