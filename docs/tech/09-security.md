# 09 Identity, Authorization, and Security

*[中文版本 / Chinese version](09-security.zh.md)*

Corresponds to chapter 10 of the product documentation.

**The central claim of this document**: this system contains a new class of actor — one that can read code, modify databases, send messages, and deploy services, but that is not a person, is not bound by HR process, and will never stop because something "felt off." The whole security model is designed around that fact.

---

## 1. Identity model

Product doc 10.1 defines four kinds of identity; the implementation adds a fifth, `system`:

```typescript
type ActorType = 'human' | 'agent' | 'service' | 'external' | 'system';
```

| Type | Who | Credential | Character |
| --- | --- | --- | --- |
| `human` | A user | SSO / password + MFA | Can be held legally responsible |
| `agent` | An Agent instance | Independently issued Agent Token | **Permissions configured independently; never inherited from a human** |
| `service` | Internal service account | mTLS / service token | For system-to-system calls |
| `external` | External integration | OAuth token / webhook signature | Bounded by the integration's scope |
| `system` | The system itself | None | Flow Engine auto-transitions, scheduled jobs |

**Key design: `system` and `agent` are separate.** When the Flow Engine advances state automatically per the state machine, the actor is `system`, not some Agent. That lets the audit trail distinguish *automatic behavior driven by rules* from *automatic behavior driven by an AI decision* — the first is deterministic and predictable, the second is not. The distinction matters enormously during an incident review.

### 1.0 Human credentials and where accounts come from

Human identity is **email + password → JWT**: `POST /api/v1/auth/login` exchanges
them for a token, and every request afterward carries
`Authorization: Bearer <token>`. Implemented in `apps/api/src/modules/auth/`.

> **Before this, identity was an `X-User-Id` header** — no credential at all; whoever's
> uuid you typed is who you were. The entire four-layer decision below sits on top of it,
> so all of it was decoration too. Worse, none of this was visible from the route listing:
> every route was diligently checking roles and membership — it is only that the "who"
> was filled in by the caller.

| Aspect | What we do | Why |
| --- | --- | --- |
| Password storage | scrypt, with the parameters and salt written alongside the hash as `scrypt$N$r$p$salt$hash` | Hash parameters have to be retuned eventually. Hard-code them and the day you retune, every password in the database is invalidated at once — nobody knows which parameters the old batch used |
| Password comparison | `timingSafeEqual` | String `===` short-circuits at the first differing byte, and the timing difference is enough to recover the hash byte by byte |
| Failed login | Account does not exist / has no password / wrong password all return **the same message, in the same time** | Each distinction you make is an enumeration probe for "which email is a real account", and that is step one of credential stuffing |
| Token algorithm | HS256; `verify` accepts the literal `HS256` and nothing else | `alg: none` is the classic JWT bypass, and the root cause is always "the library was willing to accept a different alg" |
| Token lifetime | 12 hours by default, stateless | No revocation (that would need a session table or a blocklist). The cost is that a password change or a disabled account has to wait for natural expiry, so the TTL cannot be long |
| Token for SSE | `access_token` query parameter | EventSource cannot carry custom headers (Last-Event-ID on the same page goes through the query string for the same reason). The cost is the token landing in access logs, mitigated by the short TTL |

**Accounts have exactly three origins, and there is no fourth:**

1. **The superadmin** — from `.env` (`APOS_SUPERADMIN_EMAIL` / `_PASSWORD`),
   bootstrapped idempotently at startup (`modules/auth/bootstrap.ts`).
   The password in `.env` is the **initial** password, used only when the account
   is created — reset it from `.env` on every boot and it becomes a backdoor
   nobody can close.
2. **An account opened by an org admin** — `POST /api/v1/admin/users`, permission
   `organization.members.manage`.

   > ★ Creating the account and joining it to the organization happen in **one
   > transaction**. Split them and a failure in step two leaves an account that
   > "exists but belongs to no organization": it can log in, but every request
   > afterward is a 401 (`resolveCurrentOrg`), while the admin sees "no user with
   > that email" when adding the member — an account they did in fact create.
3. **Self-service signup** — `POST /api/v1/auth/register`, no identity required,
   gated by `APOS_ALLOW_SIGNUP`, **on by default**.

#### Why self-service signup does not break the multi-tenant boundary

The organization boundary *is* the multi-tenant boundary (§2.1.2). What has to be
prevented here is **self-service entry into an existing organization** — that would
let anyone put themselves inside someone else's boundary.

Signup does not do that: **every signup opens a new, empty organization**, and the
registrant is `org_admin` of **that** organization. Nobody lands inside anyone else's
boundary. Getting into someone else's organization still has exactly one path —
being added by an admin of that organization. The line is guarded by `auth.test.ts`,
"★ a newly registered user cannot see other people's organizations and projects".

> **There is no cross-tenant global superadmin in this system.** The `users` table
> carries no global role column at all; every permission comes from
> `organization_members` / `project_members`. The "superadmin" created at startup is
> called that only because they are the first person and automatically own an
> organization of their own — they cannot see other people's organizations either. So
> signup and bootstrap do the same thing; only the trigger changes, from `.env` to
> a form.

Three trade-offs worth remembering:

| Trade-off | Why |
| --- | --- |
| Creating the account and creating the organization happen in **one transaction** | Split them and a failure in step two leaves an account that can log in but belongs to no organization: every later request is a 401, while the signup page said "signup failed", so they try again with a different email |
| Signup **says outright** that the email is taken | The login endpoint deliberately refuses to distinguish "no such email" from "wrong password" (that is an enumeration probe); signup cannot afford the same restraint — without being told the email is taken, the user has no way to finish signing up at all. That is inherent to this kind of endpoint; the mitigation is rate limiting |
| Hash the password before querying the database | The other way around, "does this email exist" returns before the expensive scrypt, and the response time leaks it by itself |

#### The master switch `APOS_ALLOW_SIGNUP`

Default **on** — an instance that never sets the variable allows signup. The vast
majority of deployments (personal use, demos, small teams) want "install it and you
can register"; the deployments that want it off are already writing deployment config.

> ★ **Any value we cannot recognize is treated as "off"**, with the reason stated in
> the startup log. This is a security switch, and the two failure modes cost wildly
> different amounts: write `flase` and read it as on, and ops meant to close it while
> it stayed open with no sign whatsoever; write `ture` and read it as off, and the
> symptom is "the signup button is gone", which somebody reports on the spot. Better
> to err closed.
> Accepted values: `1/true/yes/on/enabled` and `0/false/no/off/disabled`.

With it off, `POST /auth/register` returns **403** (not 404) — the route exists, this
instance just turned it off; a 404 sends whoever is debugging off to suspect the
version, the routing, or the reverse proxy, when the real cause is one line of
environment variable.

The frontend calls `GET /api/v1/auth/config` (no identity required, returns only
`{ allowSignup }`) to decide whether to show the "Sign up" tab. **It cannot be baked
into the build**: the same frontend bundle is served by different instances
(`http/web-app.ts` mounts it inside the API process), and baking it in would mean two
separate builds for two deployments, one with signup open and one with it closed.

**Rate limiting (`modules/auth/throttle.ts`)**: signup is unauthenticated, and every
call runs a scrypt and writes four tables; with no gate, a few dozen concurrent
requests peg the CPU — one badly written script is enough. Ten per IP per ten minutes.

> ⚠ That is a coarse **in-process** gate; on a multi-replica deployment the real
> ceiling is that number times the replica count. It stops "one client hammering us",
> not organized distributed abuse — that layer belongs at the edge (nginx / cloud
> WAF). It lives in the code because "the service itself must not fall over at the
> first poke", not because it is sufficient.


### 1.1 Agent credentials

```typescript
interface AgentToken {
  sub: string;              // agent id
  actorType: 'agent';
  orgId: string;
  projectIds: string[];     // the projects this Agent takes part in
  scopes: string[];         // capability scope
  runId?: string;           // ★ Run-scoped token: valid only for that one execution
  exp: number;              // Run-scoped tokens are short-lived (Run timeout + buffer)
}
```

**Two tiers of token**:

| Token | Used for | Lifetime |
| --- | --- | --- |
| Agent long-lived token | Registration, capability queries, health checks | 90 days, rotatable |
| Run-scoped token | Callbacks and artifact uploads for a single execution | Run timeout + 5 minutes |

Run-scoped tokens are issued along with the task dispatch ([06 Agent Protocol](06-agent-protocol.md) §4). They die the moment the Run ends, so even a leaked token is limited to a single execution.

### 1.2 Implementations that are absolutely forbidden

```typescript
// ❌ Never allowed: an Agent borrowing a human identity
async function dispatchRun(item: WorkItem, agent: Agent) {
  const token = await getUserToken(item.ownerId);   // serious mistake
  return runtime.dispatch({ ...task, credentials: token });
}
```

Product doc 10.3 explicitly requires Agent permissions to be configured independently. Borrowing a human token means the audit log shows a person did it, the permission scope equals that person's entire set of permissions, and Agent permissions can never be tightened on their own.

**Enforced at the code level**: functions like `getUserToken` are not exported to the agent module, and CI carries a static check forbidding the agent module from referencing symbols related to human credentials.

---

## 2. Authorization model

### 2.1 Four layers of decision

```
Request → ① Org role → ② Project role → ③ Resource-level Policy → ④ Data permissions (ABAC)
                                                                      ↓
                                                        a deny at any layer is a deny
```

| Layer | What it decides | Example |
| --- | --- | --- |
| ① Org role | Baseline capabilities within the organization | `org_admin` can manage Policies |
| ② Project role | Operational permissions inside a project | `tech_lead` can approve plans |
| ③ Resource-level Policy | Extra governance for high-risk operations | Production releases need DBA approval |
| ④ Data permissions | Attribute-level data visibility | You can only see your own team's cost data |

**How ③ differs from ①②**: ①② answer "are you qualified to do this"; ③ answers "should this be done automatically". A `tech_lead` is qualified to approve a plan (② passes), but if the plan involves production DDL, Policy still demands a DBA's signature (③).

### 2.1.1 Where layers ①② are implemented

①② both land in **one `preHandler` hook** in `apps/api/src/http/routes.ts`
(the decision logic in `apps/api/src/http/rbac.ts`, the rules themselves in
`packages/domain/src/rbac/`), not scattered across individual handlers:

```
preHandler → resolve identity (the JWT in Authorization: Bearer, §1.0)
           → ② membership gate (non-member → 404)
           → ① permission matrix (insufficient role → 403)
```

**② project membership** is intercepted by URL shape:

| Shape | Decision |
| --- | --- |
| `/api/v1/projects/{id}/...` | Look up membership by the project id in the URL |
| `/api/v1/{work-items,runs,decisions,plans,requirements,clarifications,policies,integrations,sync-conflicts}/{id}/...` | Resolve the owning project from the resource id first, then look up membership |
| List endpoints (`/projects`, `/decision-inbox`, `/agents`) | The query itself is narrowed by membership / organization |

**Why a hook rather than one line in every handler**: this class of hole exists
precisely because someone missed a spot. The hook intercepts uniformly by URL shape,
so project routes added later are closed by default.
**A new resource route must be registered in `projectOfResource`** — an unregistered
route is an undefended one.

**Non-members get a 404, not a 403**: a 403 confirms "this project exists",
which turns project ids into an enumerable probe. The message says "does not exist
**or** you do not have access", which neither confirms existence nor leaves someone
who was sent a link wondering whether to switch identities.

**An `org_admin` in the same organization passes even without membership**
(§2.2, "all permissions"), but **not across organizations** — an admin's "all" stops
at the organization boundary, and crossing it is multi-tenant isolation failing.

**The ① permission matrix** is declared by **each route itself** (`config.auth`):

```ts
app.post(
  '/api/v1/plans/:id/approve',
  { config: { auth: { permission: 'plan.approve' } } },
  handler,
);
```

The ②-layer trick of "intercept by URL shape" does not carry over here:
"approving a plan requires `tech_lead`" cannot be derived from a URL shape, so it has
to be written out route by route.

So a different guarantee takes its place: **a write route that forgets to declare,
does not start**. `guardRouteCoverage` counts them as routes register, and any
`POST/PUT/PATCH/DELETE` that neither declares `config.auth.permission` nor sits in the
exemption list makes `buildApp` throw outright.

The declaration sits next to the route rather than in one central table because a
central table stops "forgot to add it" (startup failure) but not **"added the wrong
one"**: copying the neighboring route's permission reads very differently in a table a
thousand lines away than it does next to the handler.

**But scope does not move with it.** The ②-layer project / resource scope is still
inferred from URL shape — a URL shape **cannot be forgotten**, a declaration can, and
read routes have no startup check to fall back on. Making scope declarative too would
trade a defense that does not depend on anyone's memory for one that does.

The full route → permission cross-reference stays in `rbac.test.ts` as an **assertion**
rather than a second runtime source of truth: it pins down every value, so changing a
route's permission means changing it there too — which should have been an explicit
decision anyway.
Exemptions must state a reason (currently seven: health probe, Agent callback,
development webhook sink, creating an organization, login, self-service signup, and
changing your own password), and the reason shows up in the error message.

> Login (`POST /api/v1/auth/login`) being exempt is unavoidable: it **is** the source
> of identity, and "log in before you can log in" does not work. Password change
> (`/auth/password`) is scoped to the callers themselves, has nothing to do with org role,
> and verifies the current password inside the handler.

Cross-project batch endpoints (`/decisions/batch-approve`) are marked with
`deferred('reason')`: the ten decisions in one submission may belong to ten different
projects, none of which is visible in the URL, so each has to be judged individually
inside the handler by its own owner. This is the only legitimate form of exception,
and it too requires a written reason.

**The decision rules themselves live in `packages/domain/src/rbac/`, shared by
frontend and backend**: the frontend fetches the whole permission set plus denial
reasons in one call to `GET /api/v1/projects/{id}/permissions`, and uses it to gray
out buttons and show "who to ask". A grayed-out button is not a permission — the
server still decides independently.

#### 2.1.2 "Which organization am I in right now"

Accounts and organizations are **many-to-many** (`organization_members`, see
02-domain-model §2.1), so layer ① of the four-layer decision first needs to know
"which organization does this request belong to". The answer is carried explicitly in
the `X-Org-Id` header, resolved by `resolveCurrentOrg` in `rbac.ts`:

| Case | Behavior | Why |
| --- | --- | --- |
| Header absent | Fall back to a deterministic default (the first by join time) and return `currentOrgId` to the caller | Erroring out shows up as a blank site; letting the frontend guess the default produces "displaying A, data from B" |
| Present but not a member | **404**, not 403 | A 403 confirms the organization exists, turning the id into an enumerable probe |
| Belongs to no organization at all | 401, explaining that an organization must be created or joined first | At that point no operation has any scope |

★★ A write route that carries an organization id in the URL must verify that it is
the **current** organization (`assertCurrentOrg`). The permission decision uses the
orgRole of the current organization, so if the handler then goes and modifies a
different organization named in the URL, that decision was worthless — from
organization A where you are an admin, you send a request pointed at organization B
and act on B with A's admin rights. This is the most classic form of privilege
escalation there is.

★ `POST /api/v1/organizations` (create an organization) is exempt: at that moment
"which organization" does not yet exist, so layer ① has no input. Its only bar is
"are you a logged-in account".

### 2.2 Role definitions

**Roles are data, not an enum.** The ones below are the **built-in roles** seeded when
each organization is created; organizations may define their own alongside them
(engineering, operations, QA, security, data…), see §2.2.1.

| Role | Level | Key permissions | Who can hold it |
| --- | --- | --- | --- |
| `org_admin` | Organization | Everything; identity management, defining roles, org-level Policies, model access, audit viewing | Human |
| `sponsor` | Project | Requirement sign-off, budget-overrun approval, business acceptance, project closure | Human |
| `tech_lead` | Project | Plan approval, architecture decisions, Agent permission changes, Policy configuration, force-pass | Human |
| `pm` | Project | Project settings, tightening Policies, scheduling adjustments, member management | Human |
| `member` | Project | Executing tasks, taking over from Agents, handling decisions, retrying | Human |
| `executor` | Project | **Executes tasks only; takes no part in any decision or approval** | Human / **Agent** |
| `agent_owner` | Resource | Configuration of the Agents they own (across projects) | Human |
| `viewer` | Project | Read-only | Human / Agent |

The permission set of a built-in role is **derived backward from the permission
catalog** (`BUILTIN_ROLE_PERMISSIONS` in `packages/domain/src/rbac/roles.ts`); there is
no hand-written second copy — a hand-written reverse table means remembering to sync it
whenever the matrix changes, and a missed sync shows up as "the matrix says pm can do
it, but pm can't", with no error anywhere.
At startup the built-in roles in the database are aligned to the current code
(`syncBuiltinRoles`), which reduces those rows to a cache.

Built-in roles **cannot be modified or deleted** — they *are* the permission matrix of
§2.3. If every organization could change them, "a tech_lead can approve plans" would
lose its shared meaning in documentation, in audits, and in support. If you want
something different, define a new role.

#### 2.2.1 Custom roles

An `org_admin` can define the organization's own roles (`/api/v1/admin/roles`,
implemented in `apps/api/src/http/roles.ts`). A role = a name + a set of permissions +
**who can hold it**. Three restrictions, each plugging one escalation path:

| Restriction | Path it plugs |
| --- | --- |
| An unrecognized permission name is rejected on the spot | The phantom failure of "but I did give them that permission" — where the permission never takes effect at all |
| **Org-level permissions cannot be delegated downward** | Mint a role that can create roles and hand it out; the recipient mints a broader one, and one step later you have an org admin |
| **`humanOnly` permissions cannot go into an Agent role** | Define a role called "engineering", stuff "modify Policy" into it, and assign it to an Agent (the workaround around §7.2) |

#### 2.2.2 Whether a role is held by a human or by an Agent

This is the basic shape of the product: the "QA" seat may be occupied by a person, or
by `test-agent-1`, or by both. So humans and Agents live in the same
`project_members` table, hold **the same set of roles**, and go through the same
assignment endpoint (`PUT /projects/{id}/members/{memberId}` with `actorType`).

But the roles an Agent may hold have a hard boundary: **a role carrying `humanOnly`
permissions can never be given to an Agent**. Those permissions are where the sentence
"humans always hold the goals, the risk, and the final decision" actually lands:

- `requirement.approve` — the product's first Human Gate
- `plan.approve` — approving a plan = approving a batch of automated behavior
- `decision.act` — decisions **are** the things that were escalated to a human; give an Agent this and the Human Gate becomes a loop asking and answering itself
- `policy.*` / `agent.permissions.*` / member and role management — §7.2

`appliesTo` derives its floor from this rule (`assignableBy`); an admin may narrow it
further within that range ("we only give engineering to humans") but cannot widen it.
The check runs again at assignment time — "put decisions into the engineering role" and
"assign the engineering role to an Agent" are two independent operations, and either
one could be the last step.

★ An Agent holding a role is **not** an Agent inheriting human permissions (§1.2). A
role governs "which product operations you may invoke"; an Agent's tool and resource
permissions (the allowedTools / deniedTools / resourceScopes of §3.1) are configured
separately in the Agent profile, and neither is derived from the other.

### 2.3 Permission matrix (key operations)

| Operation | Requires | Additional requirement |
| --- | --- | --- |
| Approve a requirement | `sponsor` / `pm` | — |
| Approve a plan | `tech_lead` | High-risk projects also need a `sponsor` co-signature |
| Change the autonomy level | `tech_lead` / `pm` | Second confirmation + audit |
| **Broaden Agent permissions** | `tech_lead` | Audit + impact simulation |
| Narrow Agent permissions | `agent_owner` | — |
| Grant production-environment access | `org_admin` | Audit + two-person confirmation |
| **Loosen a Policy** | `tech_lead` | **Must carry simulation results** |
| Tighten a Policy | `pm` | — |
| Force-pass acceptance criteria | `tech_lead` | Mandatory reason + audit |
| Create a task (manually) | `work_item.create` (execution roles) | Always lands as `draft`, cannot be dispatched |
| **Release a manual task for execution** | `tech_lead` (`plan.approve`) | See below |
| Create an organization | Any logged-in account | The creator becomes `org_admin` of that organization |
| **Open an account** | `org_admin` (`organization.members.manage`) | Audited (`user.created`); the only way an account enters the system, see §1.0 |
| Change organization info / membership | `org_admin` | Audit |
| Act on a decision | The decision's assignee | **Cannot be done on someone's behalf**, see §2.4 |
| Terminate an Agent Run | `tech_lead` / `pm` / `agent_owner` | — |
| View a Run in detailed mode | `tech_lead` / `agent_owner` | May contain sensitive context |
| Export the audit log | `org_admin` | The export itself is audited |

**Asymmetric by design**: narrowing permissions requires less than broadening them. Narrowing is always safe; broadening needs a higher bar and extra evidence (simulation results, impact previews).

★★ **Manually created tasks do not bypass the Human Gate.**

Work items could originally only come from "requirement → plan → approval →
decomposition", and both Human Gates (`requirement.approve` / `plan.approve`) sit on
that chain. Once a manual creation endpoint exists, if a task could be dispatched the
moment it is created, then anyone who can create a task can make an Agent do anything —
both gates are bypassed, and the bypass is completely invisible from the route listing.

So a manually created task always stops at `draft` (the endpoint **does not accept** a
caller-specified status), and the `draft → ready` step requires `plan.approve`. The
granularity of the gate changes from "approve a plan" to "approve a task"; it does not
disappear.

★ This check lives in the handler (the status route in `routes.ts`) rather than in the
route table: the route table cannot see the task's **current** status, and
`changes_requested → ready` (rework restarting) also lands on ready — the plan for that
step was approved long ago, and requiring approval again would drag a tech_lead into
every rework, when rework is an executor's everyday move.

#### 2.3.1 How we decide whether a change tightens or loosens

The asymmetric design only holds if the two directions can be **told apart reliably**.
The criteria live in `packages/domain/src/rbac/change-direction.ts`, and both look at
**outcomes, not at how the change was written**:

- **Policy**: run the old and new rule sets across a grid of scenarios. If even one
  scenario moves from "needs a human" to "auto-approved", the whole change counts as
  loosening.
  Comparing two rules to see which is stricter misses "insert a higher-priority
  permissive rule that shadows the strict one" — the strict rule was never touched, yet
  the one that now takes effect is the new one.
- **Agent permissions**: the allowlist getting longer, `deniedTools` getting
  **shorter**, or a resource scope being upgraded — any of the three is a broadening.
  The denylist is the one most easily judged backward: removing an entry retracts a hard
  constraint, and the intuition "shorter list = tighter" scores it as tightening, which
  lets an owner retract "must never merge code" all on their own.

The determination happens after the routing layer and before any side effect. The route
table only turns away people who do not even qualify to tighten; once the direction is
computed, it is checked again (the `assertCan` callbacks of `savePolicy` /
`updateAgent`).
**The order cannot be reversed**: a Policy simulation scans 90 days of historical
evaluations, and running it before the permission check means someone unqualified to
loosen gets to burn the whole computation, and gets handed "which historical tasks
would have been auto-approved" — which they were not supposed to see.

#### 2.3.2 How roles get changed

- Define a role: `/api/v1/admin/roles` (`org_admin`), see §2.2.1
- Assign a role: `/api/v1/projects/{id}/members/{memberId}` (a role holding `project.members.manage`)
- Org identity: `PATCH /api/v1/admin/users/{id}/org-role` (`org_admin`)

All of it is audited (§6.3). A permission system nobody can change ends, in practice,
with "everyone shares one account" — because changing roles is more trouble than
changing people. Three constraints against self-inflicted lockout:

- Every project keeps at least one **person holding `project.members.manage`**;
  otherwise only an org admin can fix that project's permissions. ★ The criterion is the
  permission, not the role name — once roles can be customized, the "lead" may be called
  "operations manager", and checking by name makes this protection fail silently;
- Every organization keeps at least one `org_admin`; otherwise nobody is left who can
  manage identities, define roles, or read the audit log;
- A role currently held by someone (person or Agent) cannot be deleted, and its
  `appliesTo` cannot be narrowed to exclude them — otherwise you are left with a batch of
  members whose permissions nobody can say still count.

Role values are guaranteed by a **foreign key**
(`project_members(org_id, role) → roles(org_id, key)`, migration `0011_custom_roles`).
Where a foreign key beats a CHECK is not the write side but the delete side: it makes a
role that people currently hold undeletable, and "the role was deleted and member
permissions silently went to zero" is exactly the hardest kind of failure to diagnose.
`users.org_role` is still a CHECK (org roles are not customizable).

### 2.4 Decision responsibility cannot be exercised by proxy

```typescript
// ❌ Not even an org_admin may approve someone else's decision directly
async function approveDecision(decisionId: string, actor: Actor) {
  const decision = await getDecision(decisionId);

  const isAssignee = decision.assigneeId === actor.id;
  const isCoSigner = decision.coSigners.includes(actor.id);

  if (!isAssignee && !isCoSigner) {
    throw new Forbidden('DECISION_NOT_ASSIGNED',
      '决策责任不可代行。如需变更责任人，请使用改派功能。');
  }
  // ...
}
```

Product doc 10.5 requires the audit trail to answer "who approved this critical decision". If an admin could approve on anyone's behalf, that question has no reliable answer. **Reassignment is allowed; acting by proxy is not** — and reassignment is itself audited.

---

## 3. Agent permissions

The example from product doc 10.3:

```
Review Agent
Allowed:   read code, read PRs, create review comments
Forbidden: merge code, modify production configuration
```

### 3.0 Semantic capabilities (the vocabulary of authorization)

**What users configure is capabilities, not tool names.** The catalog is defined in `packages/contracts` (`AGENT_CAPABILITIES`); the explanations, profiles, and evaluation live in `packages/domain/src/capabilities/`.

Before this layer existed, "what can this Agent do" could only be expressed in a runtime's tool names (`Read` / `Edit` / `Bash`), at three costs, the last of which is fatal:

1. The user is forced to learn some CLI first. The correct answer to "let it run tests" is `Bash(npm test:*)`, and that is written down exactly nowhere.
2. Switching runtimes means reconfiguring everything — `Edit` does not exist on the Codex side at all.
3. **One word, `repo:write`, meant three things whose risk differs by two orders of magnitude**: editing files inside an isolated workspace, pushing a branch to a remote, and merging changes into the trunk. On the authorization screen they looked identical, so "let the Agent edit code" quietly granted "let the Agent merge code" as well.

The capability catalog splits the third apart:

```
workspace.write     edit files in an isolated workspace; changes do not leave it on their own
repository.push     push a branch to the remote repository
pull_request.merge  merge into the target branch — nothing after this step is reviewed by a human
```

Translating those into a particular runtime's tool names is the **adapter's** job (`CapabilityTranslator`). An adapter is allowed to fall short, but not to stay quiet about it: whatever it cannot translate must come back as a `CapabilityDegradation` and be shown in the UI. An authorization screen that looks restrictive while the runtime is not actually restricted is far worse than an awkward one.

### 3.0.1 Capability profiles: no configuration ≠ no permissions

```
No explicit configuration does not mean "no permissions".
It means "use the safe, useful default profile".
```

In a system where a freshly created Agent has an empty permission array ("can do nothing at all"), **the real default is whichever configuration the user copied from somewhere else**. So an Agent joining a project with no profile specified falls to `standard_executor`: it can edit code, run tests, and deliver artifacts inside an isolated workspace; it cannot push, merge, deploy, read credentials, or touch governance. The criterion is "can the consequences leave the workspace".

The built-in profiles are in `packages/domain/src/capabilities/profiles.ts`. Anything more has to be an explicit decision with a written reason.

**Profiles are versioned, and the expanded result is persisted** (`project_agent_permissions.allowed_capabilities`). Store only the `profileKey` pointer and the day the platform adds a capability to `standard_executor`, every running Agent widens at once without anyone having made a decision — which is the single most typical way the permission creep of §7 happens. A new profile version is surfaced in the UI only; it never upgrades anything automatically.

### 3.0.2 Project-level authorization

Permissions hang off `project_agent_permissions(project_id, agent_id)`, not off `agents`.

The old model hung `allowedTools` / `resourceScopes` on the Agent itself, so loosening things once for one project loosened them for every project in the organization; the only way around it was to create two Agents from the same configuration — and from then on those two have separate credentials, separate budgets, and separate statistics, and "who is using this key" no longer has an answer.

The database uses a **composite foreign key** to guarantee that an Agent with a permission record is a member of that project. Do it in the application layer instead and there is a window between deleting the membership and deleting the permissions — and in that window the Agent holds an authorization nobody owns.

Evaluation (`resolveEffectiveAgentAccess`):

```
platform security baseline
  ∩ the organization's capability ceiling for this Agent (agents.capability_ceiling)
  ∩ the capabilities granted inside the project (project_agent_permissions)
  ∩ what the runtime can actually do
  + project resource scopes
  = an immutable Run permission snapshot
```

**An explicit deny at any layer always beats an allow.** The ceiling layer is the other half of multi-project isolation: a project admin can pick a profile inside their own project, but cannot pick capabilities the organization never intended this Agent to have — without it, anyone who can create a project can give any Agent any permission.

**One evaluator, four call sites**: the scheduler choosing candidates, the snapshot frozen before dispatch, the UI showing effective permissions, and the impact preview before saving. The cost of two implementations is not duplicated code, it is two answers that disagree — and they only diverge on the inputs where they disagree, which is exactly where nobody is looking.

### 3.0.3 The org-level record keeps only the "ceiling"

The Agent layer now answers only "how far can this Agent **at most** be authorized":

| Stays on `agents` | Moved to `project_agent_permissions` |
| --- | --- |
| Runtime configuration and credentials, owner | The capabilities actually in effect |
| `capability_ceiling` (NULL = no ceiling) | Resource scopes |
| `denied_capabilities` (org-level hard deny) | The selected capability profile |
| Model, budget, concurrency, timeout | |

The three columns `allowed_tools` / `denied_tools` / `resource_scopes` are **retired**: no longer written, no longer read. The columns stay rather than being dropped, for two reasons, neither of them "just in case" — they are the only record of the pre-migration configuration (0031's backfill was derived from them, and dropping them would make it permanently impossible to check whether the derivation was right), and dropping a column is a DDL you cannot roll back.

> **NULL and an empty array mean opposite things.** A NULL `capability_ceiling` means "no ceiling"; an empty array means "grant nothing" — the latter would leave this Agent unable to work in any project. The distinction is explicit in the type (`AgentCapability[] | null`) and is caught on save (an empty list is rejected outright, with an explanation of how to write "no ceiling").

### 3.1 Three dimensions (the runtime layer)

Capability translation still lands on these three dimensions; they are the **protocol shape handed to the runtime**, no longer the shape the user configures:

```typescript
interface AgentPermissions {
  allowedTools: string[];       // allowlist
  deniedTools: string[];        // ★ denylist, takes precedence over the allowlist
  resourceScopes: Array<{
    kind: 'repo' | 'env' | 'database' | 'external_service' | 'dataset';
    ref: string;                // 'order-service' | 'production'
    access: 'none' | 'read' | 'write';
  }>;
}
```

**Denylist wins**: a tool in `deniedTools` is unavailable no matter what, and cannot be overridden by a template, by inheritance, or by bulk configuration. It exists to express hard constraints like "this Agent must never merge code".

**Deny by default**: any resource not listed in `resourceScopes` is `none`. Wildcard grants (`repo: *`) are not allowed — every repository has to be listed explicitly.

**Resource scopes narrow along with capabilities**: a read-only profile plus a repository scope of `access:'write'` is two statements contradicting each other, and the runtime only sees the second. At evaluation time the capability side wins.

### 3.2 Two enforcement points

```
① At dispatch: the permission list goes to the runtime with the task (doc 06 §4)
   → the runtime filters tools against it
② At callback: APOS re-checks destructive operations
   → in case the runtime implementation has a bug or was bypassed
```

```typescript
// Second check: even if the runtime allowed it, APOS still blocks
async function validateToolCall(runId: string, tool: string, params: unknown) {
  const run = await getRun(runId);
  const perms = run.permissionSnapshot;          // ★ the snapshot taken at dispatch, not the current config

  if (perms.deniedTools.includes(tool)) {
    await emitSecurityEvent('agent.permission_violation', { runId, tool });
    throw new Forbidden('TOOL_DENIED');
  }

  const toolMeta = getToolMeta(tool);
  if (toolMeta.sideEffects === 'destructive') {
    const scope = resolveTargetScope(tool, params);
    if (!hasAccess(perms.resourceScopes, scope, 'write')) {
      await emitSecurityEvent('agent.permission_violation', { runId, tool, scope });
      throw new Forbidden('RESOURCE_DENIED');
    }
  }
}
```

**Use the permission snapshot, not the current configuration**: permissions may change after a Run is dispatched. A Run in flight should use the permissions it started with — mid-flight changes produce inconsistent behavior and are hard to audit. Tightening permissions does not take immediate effect on a Run already executing (page doc 08 §11 states this).

**Snapshots come in two generations, and are never migrated.** v1 has only the three runtime fields above; v2 (`AgentPermissionSnapshot`) additionally records the semantic capabilities, the profile key and version, and where each capability came from. Six months later, the person reading the audit trail is asking "what was it **authorized to do** at the time", and tool names cannot answer that — the same `['Read','Edit']` does not mean the same thing before and after an adapter revision. Historical snapshots are kept exactly as they were: they are the credentials of that particular execution, and rewriting them is fabricating evidence. The read side tells them apart by `version` (absent means v1).

**A permission violation is a security event**: `agent.permission_violation` raises a high-priority alert to `org_admin` and `agent_owner`. Repeated violations automatically suspend the Agent.

### 3.3 Previewing a permission change

Page doc 08 §5.5 requires a [Simulate impact] action:

```typescript
async function simulatePermissionChange(agentId: string, changes: PermissionChanges) {
  return {
    affectedPolicies: await findPoliciesReferencingAgent(agentId, changes),
    queuedTasksImpact: await findQueuedTasksRequiring(agentId, changes.removed),
    runningRunsImpact: await findRunningRunsUsing(agentId, changes.removed),
    newlyRequiringApproval: await countTasksThatWillNeedApproval(agentId, changes),
  };
}
```

Output looks like: "this change will alter the outcome of 3 Policies; 2 queued tasks will now require approval."

**Preview and save must share the same decision logic.** Compute them separately and the promise "we tell you what will happen before you save" stops holding — and it fails in the hardest way to notice: the preview says "nothing will change", the save changes permissions, and both records are internally consistent. On the project-level authorization path, the only difference between preview and save is whether it writes to the database.

### 3.4 Governed mutations: a fixed order

`apps/api/src/http/governed-mutation.ts` pins this pipeline down:

```
read current state → determine direction → authorize → validate reason / simulation / co-signature → transaction → audit
```

The order cannot be rearranged; that — not code reuse — is why this function exists:

- **Direction before authorization**. Without knowing the direction you do not know which permission to check, so each implementation has to pick one, and usually picks the broader one (`agent.permissions.restrict`) — at which point the asymmetric design of §2.3 is void, and someone who may only tighten can also loosen.
- **Reason / simulation / co-signature before the transaction**. Putting them inside the transaction means a loosening that should have been refused was already written, with rollback as the safety net.
- **Audit after the transaction**. Publishing inside the transaction pushes a change to the browser that is then rolled back (the same rule as the event bus).

`PermissionSpec.governance` used to be **descriptive**: the catalog said "this one needs a reason", while the actual enforcement was scattered across handlers and depended on everyone's diligence. Now, if the catalog says it is required, it is required.

---

## 4. High-risk operations

Product doc 10.4 lists nine classes of operation that need extra governance:

| Operation | Default governance | Can org-level rules loosen it |
| --- | --- | --- |
| Modify production data | DBA approval | No |
| Delete a resource | Multi-person co-signature | No |
| Modify permissions | `org_admin` | No |
| Access sensitive data | Data owner approval + redaction | No |
| Send information externally | Human confirmation | Conditionally (e.g. internal notification channels only) |
| Execute a payment | Multi-person co-signature + `sponsor` | No |
| Release to production | Release owner approval | Conditionally (a mature process may be automated, product doc 8.8.6) |
| Modify security policy | `org_admin` + audit | No |
| Use high-cost resources | `tech_lead` approval | Yes (a threshold can be set) |

### 4.1 Where the floor is

Of those nine, **three are hard-coded into the evaluator** (`NEVER_AUTO_APPROVE`, [05 Policy Engine](05-policy-engine.md) §3.2):

deleting a resource · modifying permissions · executing a payment

Whatever the autonomy level, whatever the project rules say, they never get an `allow`. Hard-coding is not laziness — a floor that configuration can get around is not a floor.

**The other six are governed by rules the user writes.** The platform does not write them for the user: when none exist, the Policy page's health check states plainly that "this class of operation currently falls through to the autonomy-level default" (`coverage_gap`), and a new project with zero rules is shown a setup wizard first.

> **This section used to be ten hard-coded org-level baseline Policies** (`BASELINE_POLICIES`, priorities 1–20), which took part in every evaluation whether or not the database held any rules, and could be neither deleted nor loosened. They were removed not because they governed the wrong things, but because they made "what rules is this project actually running under" unanswerable from the UI: the rule list the user could see and the rules actually in effect were not the same list. And a governance configuration you cannot read in full is more dangerous than a thin one — what it gives you is false confidence. Now **the rules in effect = the ones the user entered into the database**, and the three that are genuinely not negotiable are caught by the evaluator directly.

**Test guarantees** ([05](05-policy-engine.md) §9): enumerate every autonomy level against adversarial project rules and assert that those three operations never get an `allow`; then assert that **a misspelled value cannot slip past either** — an `operationType` of `"delete_resrouce"` stops evaluation with an error rather than sailing through as "code change". Both are blocking tests in CI.

---

## 5. Data security

### 5.1 Data classification

```typescript
type DataSensitivity = 'public' | 'internal' | 'confidential' | 'restricted';
```

| Level | Example | Agent access |
| --- | --- | --- |
| `public` | Public documentation | ✅ |
| `internal` | Internal code, requirements | ✅ (within project scope) |
| `confidential` | Customer data, finance | Explicit grant + redaction |
| `restricted` | PII, keys, payment information | ❌ denied by default |

### 5.2 Context redaction

Agent context is the easiest place to leak sensitive data — it aggregates information from everywhere and ships it to an external runtime.

```typescript
async function buildAgentContext(item: WorkItem, agent: Agent): Promise<ContextItem[]> {
  const raw = await gatherContext(item);

  return raw
    .filter(c => canAgentAccess(agent, c.sensitivity))    // filter
    .map(c => ({
      ...c,
      content: redactSensitive(c.content, {                // redact
        patterns: SENSITIVE_PATTERNS,   // phone numbers, national ID numbers, keys, tokens
        onRedact: (kind) => recordRedaction(item.id, kind),
      }),
    }));
}
```

Page doc 09 §11 requires the UI to label it 「已脱敏，共 3 处」 ("redacted in 3 places") — redaction has to be visible, or debugging turns into confusion over "why does the Agent say it cannot find this value".

**Viewing the original**: only an `org_admin` may request it, and the viewing itself is audited.

### 5.3 Secret management

| Type | Storage | Access |
| --- | --- | --- |
| Integration OAuth token | KMS envelope encryption | integration module only, decrypted on demand |
| Agent runtime credentials | Same | agent module only |
| LLM API key | Environment variable / secret manager | Server-side only |
| Run-scoped token | Not persisted (self-contained JWT) | — |

**Never echoed back**: API responses give only the last four characters (`****1234`). Encrypted database fields never reach the logs or an event payload.

### 5.4 Code repository credentials (GitHub / GitLab / …)

Registered under "Agent configuration → Code repositories"
(`/api/v1/admin/repositories`, requires `repository.manage`).
Credentials take three forms (`modules/security/secrets.ts`):

- `env:GITHUB_TOKEN` — the database holds only the variable name; the plaintext lives only in the process environment. **Preferred in production**
- Pasted directly, with `APOS_SECRET_KEY` configured — AES-256-GCM encrypted at rest, the key living outside the database
- Pasted directly, without `APOS_SECRET_KEY` — stored in plaintext (`secret://plain/…`), for local development and demo environments

★ The master key determines **how a secret is stored**, not **whether it can be stored**.
Previously, with no master key configured, the endpoint refused every pasted value
outright; but an Agent's runtime configuration is a JSON blob the user writes themselves,
and any value whose key name contains `TOKEN` / `KEY` / `AUTH` went through the same
check — so "configure a proxy endpoint" turned into "go change the deployment's
environment variables and restart first". A security measure that locks ordinary
configuration out buys you users who route around the page. It now always stores the
value, and states plainly on the configuration page which of the three forms is in use
(`encryptsInlineSecrets`). All three forms carry the `secret://` prefix, so the "never
echo it back" discipline applies to them uniformly.

The permissions a token needs are exactly clone / fetch / push
(a GitHub fine-grained PAT with Contents: Read and write is enough) —
the platform does not call GitHub's or GitLab's APIs.

#### 5.4.1 The credential username placeholder

HTTPS tokens go through Basic auth, and each vendor wants something different in the username field:

| Service | Username placeholder |
| --- | --- |
| GitHub / GHE | `x-access-token` |
| GitLab (including self-hosted) | `oauth2` |
| Bitbucket | `x-token-auth` |

Left blank, it is inferred from the domain (`resolveAuthUsername`): public cloud
domains and self-hosted instances **whose first label is the vendor name**
(`gitlab.acme.com`) are both recognized; `git.acme.com` is not — underneath it could be
Gitea, Gogs, GitLab, or Bitbucket Server, and a wrong guess is a 401, so it falls back
honestly to the default, flags a warning on the configuration page, and lets a human
fill it in.

★ Getting this field wrong shows up as a 401, and nothing in a 401 points at it.
So the configuration page displays **the placeholder value about to be used, and where
it came from** (typed in / inferred from the domain / fallback) directly, and a failed
probe reports the placeholder along with the failure.

#### 5.4.2 SSH private keys (`ssh://` and `git@` forms)

Same credential field: for an ssh address you paste the **full private key**, and both
forms share the same `env:` / encrypted-inline storage. The form is validated at
registration time (`inspectPrivateKey`).

**★★ The private key never touches disk; it goes through ssh-agent.**

OpenSSH's `ssh -i` only accepts a file path, so "write a temporary key file" is the
first thing anyone thinks of — but it does not hold up on this platform: the container
is simultaneously running Agents from other Runs, as processes of the **same OS user**,
so as long as the key is on disk, any Agent's Bash tool can `cat` it. "Write it before
the run, delete it after" does not help, because with concurrent Runs there is always
somebody else's Agent running. This is the same discipline as the two rules already in
§5.4: no token spliced into the remote URL (`.git/config` sits right there in the
Agent's working directory), and no credential helper (it writes to disk). A private key
is worth more than a token; the standard should not be lower.

So: the key is fed to `ssh-add -` from stdin and lives only in the agent process's
memory; `SSH_AUTH_SOCK` goes only into the environment of the **git subprocess** (the
Agent's runtime environment is built separately and never gets it); the socket sits in
a 0700 temporary directory; and the agent's lifetime is strictly wrapped by
`withSshAgent`, with a `finally` that kills it and removes the directory.

**★★ Passphrase-protected private keys are not supported, and are rejected at save time.**

An unattended run has no way to type a passphrase, so such a key is doomed never to
work. Let it into the database and the failure is deferred to the first dispatch —
and it is **not an error**: `ssh-add` sits there waiting for the passphrase, which
presents as "the task has been executing forever". The runtime additionally sets
`SSH_ASKPASS_REQUIRE=never` as a backstop, so that anything that slips through fails
immediately instead of hanging.

**★★ Host keys are pinned after TOFU.**

`repositories.ssh_known_hosts` stores the host public key (in plaintext — it is the
copy meant to be compared publicly in the first place). When it is empty, the first
connection uses `accept-new` and **writes the learned key straight back to the database
as soon as the connection succeeds**, switching to `StrictHostKeyChecking=yes`
thereafter.

Without pinning, `accept-new` is equivalent to `no`: every connection gets a brand new
temporary known_hosts, the condition "unknown host" is always true, and so everything is
accepted every time — a man-in-the-middle swapping the host key connects just fine. For
TOFU to mean anything, what was learned the first time has to survive. We never use
`StrictHostKeyChecking=no` under any circumstances. An admin may also prefill it with
`ssh-keyscan` (stronger), or clear it to relearn (when the server really did rotate its
key).

**★ Identity is constrained with `IdentityAgent` + `IdentityFile=none`, never with `IdentitiesOnly=yes`.**

`IdentitiesOnly` means "use only the identity **files** named in the configuration or on
the command line", which excludes the identities the agent offers — and our key exists
only inside the agent. Add it and the symptom is `Permission denied (publickey)`: it
looks like the repository was not authorized, when in fact the key was never offered at
all.

★ An ssh repository with no private key configured still falls back to the host's
`~/.ssh` (historical behavior, and a legitimate use on a machine that has SSH configured),
and the configuration page notes that a container usually does not have that config.

#### 5.4.3 Connectivity probe

`POST /api/v1/admin/repositories/{id}/probe` runs one `git ls-remote --heads` and
verifies three things: the domain resolves and connects, the credential works, and the
default branch exists. Read-only, nothing written to disk, no mirror created.

★ It exists so that a misconfiguration is visible on the configuration page. Without it,
the only way to verify a credential is to dispatch a task and watch it end with
"workspace preparation failed: … 401" — an error that cannot distinguish an expired
token from insufficient scope from a wrong username placeholder, and those three call
for completely different next steps.

`ls-remote` rather than `clone`: it answers all three questions in seconds, whereas
cloning a large repository takes minutes — and a check so expensive nobody clicks it
twice is no check at all.

#### 5.4.4 The quality verification command

`checkCommand` (e.g. `pnpm test`) runs in the workspace after the Agent finishes and
**before the commit**; a failure still commits (failed changes need to be seen too).

★★ It is the only source of **real** test data in the reviewing stage. Without it, the
`qualityGatePassed` gate has nothing to go on but "the Agent said it ran the tests" —
which is a self-report, not evidence. So when it is unconfigured, the configuration page
says exactly that.

★ It is an arbitrary command executed in a server-side shell, and the permission to
configure it is `repository.manage` (org admin), the same tier as registering a
repository — anyone who can register a repository can already have Agents write code
into it, so a higher bar would be pointless.

---

## 6. Audit log

Product doc 10.5 requires recording: the actor, the identity type, the time, the input, the operation, the target resource, the Policy decision, the approval record, the execution result, the failure reason, and the associated project and task.

### 6.1 Implementation

The audit log **is not a separate system**; it is a view over the `events` table — because the event model ([03](03-event-model.md)) already records every element:

| Audit element | Event field |
| --- | --- |
| Actor + identity type | `actor_type`, `actor_id` |
| Time | `occurred_at` |
| Operation | `type` |
| Target resource | `subject_type`, `subject_id` |
| Input | `payload` |
| Policy decision | `payload` (policy.evaluated events) + `context_snapshot` |
| Approval record | decision.* events |
| Execution result | agent_run.* events |
| Failure reason | `payload.error` |
| Associated project and task | `project_id`, `correlation_id` |

```sql
CREATE VIEW audit_log AS
SELECT id, occurred_at, actor_type, actor_id, type AS action,
       subject_type, subject_id, project_id, payload, correlation_id
FROM events
WHERE level = 'milestone' OR type IN (
  'policy.evaluated', 'agent.permission_violation',
  'work_item.force_passed', 'policy.updated', 'agent.permissions_changed'
);
```

**This is the direct payoff of taking the event model seriously**: no extra audit code at every operation site, and therefore no hole of the form "some path forgot to write an audit record".

### 6.2 Tamper resistance

```sql
REVOKE UPDATE, DELETE ON events FROM apos_app;
```

The database role the application connects with has no modify rights. Archives to S3 are written with object lock (WORM) enabled.

### 6.3 Operations that must be audited

Beyond the ordinary events, the following are forcibly marked `audit: true`:

- Permission changes (human and Agent)
- Policy creation / modification / deactivation
- Autonomy level changes
- Force-pass (acceptance criteria, blockers)
- Decision reassignment
- Integration connect / disconnect, Source of Truth changes
- Viewing the original of sensitive data
- Audit log export

The corresponding event types are in `AUDIT_EVENTS` in `packages/contracts/src/events/index.ts`.
Authorization changes come in two kinds:

- **Who holds which role** (the subject is the person / Agent being changed):
  `project.member_added` / `project.member_role_changed` /
  `project.member_removed` / `user.org_role_changed`
- **What the role itself is** (the subject is the role):
  `role.created` / `role.updated` / `role.deleted`

**Why both kinds are needed**: §7 lists permission creep as a threat specific to this
product, and its first mitigation is "audit every permission change". Record only the
first kind and "who gave the engineering role the power to loosen rules" is
unanswerable — and going through people's authorization records one by one will not
reconstruct it either, because each person's record only ever says "they have always been
engineering".

---

## 7. Threat model

Threats specific to this product:

| Threat | Scenario | Mitigation |
| --- | --- | --- |
| **Agent privilege escalation** | An Agent invokes an unauthorized tool or reaches a resource outside its scope | Two enforcement points (§3.2) + violation alerts + automatic suspension |
| **Prompt injection** | Instructions embedded in a requirement document / code comment / PR description lure an Agent past its permissions | Context and instructions kept separate; the permission check on the tool-call side never depends on the Agent's judgment; destructive operations always go through Policy |
| **Cost attack** | Malice or misconfiguration puts an Agent in an infinite loop burning money | Per-Run cost ceiling + hard project budget block + anomalous-growth detection |
| **Permission creep** | A series of small loosenings ends with an over-privileged Agent | Full audit of permission changes + periodic permission review report + loosening requires `tech_lead` |
| **Decision bypass** | Modify a Policy so a high-risk operation becomes automatic | The floor for three classes of operation is hard-coded in the evaluator (§4.1) + loosening requires a simulation + Agents cannot modify Policies |
| **Spelling bypass** | Use an unrecognizable `operationType` so the security floor never matches | Fact values are parsed strictly against the enum; anything unrecognized is refused, never coerced to the nearest match (§4.1) |
| **Run token leak** | The external runtime environment is compromised | Short-lived Run-scoped token + operations limited to that runId |
| **Sync poisoning** | Malicious requirements injected through an external system (Jira) | Externally imported requirements need human confirmation before entering Planning |
| **Audit forgery** | Tampering with history to cover behavior | The events table is immutable + WORM archives |

### 7.1 Concrete defenses against prompt injection

This is the threat this product has to take most seriously — everything an Agent reads (code, documents, PR descriptions, externally synced requirements) can be injected.

**The defense is not "make the Agent smarter at spotting injections", it is making a successful injection unable to cause damage**:

1. **Permissions are not determined by what the Agent says about itself.** An Agent saying "I need merge_pr permission" has no effect whatsoever; permissions can only be set by a human in the Agent Workspace.
2. **Destructive operations always go through Policy.** Even if an Agent is talked into dropping a database, `operationType: db_ddl` + `environment: production` hits an org-level rule demanding DBA approval.
3. **The second check on the tool-call side** (§3.2) does not look at the Agent's intent, only at the permission list.
4. **Context is labeled with its origin.** Externally sourced content is explicitly marked in the prompt as "untrusted external data", and the system prompt explicitly instructs that instructions inside it are not to be executed.

**Product doc 8.8.4's "involves an irreversible operation" trigger for human involvement** is, in security terms, exactly this line of defense.

### 7.2 Agents cannot modify Policies

Product doc chapter 13 explicitly puts "Agents modifying Policies automatically" out of MVP scope. This is not only a scoping question, it is a security floor:

```typescript
// Write operations in the policy module enforce this
function assertHumanActor(actor: Actor, operation: string) {
  if (actor.type !== 'human') {
    throw new Forbidden('POLICY_HUMAN_ONLY',
      `${operation} 只能由人类执行。Agent 可以建议规则，但不能创建或修改。`);
  }
}
```

**If an Agent can modify its own constraints, the entire governance system is decoration.** An Agent may generate rule suggestions (which land in the decision center), but they take effect only after a human confirms them.

---

## 8. Compliance

| Requirement | Implementation |
| --- | --- |
| Data retention | Events hot for 12 months + archive; retention period configurable |
| Data deletion request (GDPR) | User data can be anonymized (event structure preserved, personal identifiers erased) |
| Data residency | Isolation at the deployment level; multi-region within one instance is out of MVP scope |
| Employee monitoring regulations | Individual performance data is aggregated by default; per-person detail is visible only to `pm` (page doc 12 §8) |
| Access auditing | §6 |
| Encryption | TLS 1.3 in transit; KMS envelope encryption at rest (sensitive fields) |

**The boundary around individual performance data deserves particular care**: Analytics can compute each person's average decision time and number of timeouts. In some jurisdictions that may constitute employee monitoring. Page doc 12 already specifies aggregate-only display; the implementation must enforce it at the API layer — not by having the frontend decline to show it.

---

## 9. Open questions

1. **Are the prompt-injection defenses sufficient?** The four defenses in §7.1 depend on Policies being configured correctly. If a user configures some class of operation as auto-approved, injection has an opening. Do we need a class of operation that "Policy cannot approve" (hard-coded)? Leaning yes: deleting resources, modifying permissions, and executing payments hard-coded as always requiring a human.
2. **Rotation for Agent long-lived tokens**: 90-day rotation needs cooperation from the runtime. What do we do about runtimes that do not support rotation?
3. **Permission review report**: generate a periodic (quarterly) report of "which Agents had permissions loosened, and are the current permissions still necessary". Do we build it in MVP? Leaning P1, but the permission change audit (the data it rests on) must exist in MVP.
4. **Strength of multi-tenant isolation**: MVP is single-instance multi-tenancy (RLS + application layer). Financial and healthcare customers may require physical isolation. That is a deployment-shape question and needs product confirmation on the target customer.
5. **Accuracy of sensitive data detection**: regex matching will miss things. Do we need to integrate a dedicated DLP service? For MVP the suggestion is regex plus user-labeled field sensitivity.
6. **Where responsibility lies for the `system` actor**: when a Flow Engine auto-transition goes wrong, who is responsible? Technically "the rules executed the configured behavior", but a person wrote the configuration. The audit trail should be able to trace back to "who configured this rule" — which means `system` events need to carry the `policy_id` of the triggering rule and that rule's author.
