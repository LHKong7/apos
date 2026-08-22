# 11 Workspace Abstraction

*[中文版本 / Chinese version](11-workspace-abstraction.zh.md)*

The place where an Agent does its work is called a "workspace." This document explains why it is not
"a pluggable storage backend" but rather "one local directory with two swappable ends," and what that
shape buys and costs us.

Where the code lives: the backends are in `packages/workspace-providers/`, the database adapter is in
`apps/api/src/modules/workspace/`, and the contracts are in `packages/contracts/src/workspace/`.

> Terminology note: in this codebase `workspace` means **only the Agent's working directory**. The
> product's top-level container is called an "organization" (`organizations`), never a workspace. If
> both were called workspace, a sentence like "clean up the workspace" would point at two completely
> unrelated things (see the comment on the organizations table in `schema/core.ts`).

---

## 1. Starting point: what exactly was wrong with the Git coupling

Before the rework, a single `WorkspaceProvisioner` class did four jobs: maintain the Git mirror, attach
the worktree, run the quality check, and commit and push. The `RunWorkspace` type it exposed was a pure
Git shape:

```ts
{ repoRef, path, branch, baseBranch, baseCommit, writable, additionalPaths }
```

The problem was not the hypothetical "someday we might want object storage." It was that **a second
implementation already existed**:

In `planning/agent-provider.ts`, a requirements-planning task needs no repository at all (it reads the
raw requirement text and writes a JSON file), so it `mkdir`'d an empty directory of its own and then
hand-forged a fake Git workspace to stuff into the dispatch:

```ts
workspace: { repoRef: 'planning', branch: 'planning', baseBranch: 'planning', ... }
```

The cost was visible: the governance-rules prompt would read those fields and generate a line like

> "You are working on branch planning, which is based on planning. Do not switch branches, do not
> commit…"

and hand it to the Agent. All the Agent could do with that was go looking for a branch that does not exist.

**So the justification for the abstraction was never a guess. It was a second implementation that had
already been written and was already producing wrong behavior.**

---

## 2. The shape: a local directory, plus materialize and publish

What the platform dispatches are headless CLI Agents (claude-code / codex / aider / goose / opencode /
qwen…). Without exception they need to `cd` into a directory and then `open()` files —
**the local POSIX directory is the one part with no pluggability in it**. Making it "one backend among
several" would mean turning the invariant into a variable.

What is genuinely swappable is the two ends:

```
                    ┌─────────────────────────────┐
   materialize      │ Workspace (local directory) │        publish
 ──────────────────▶│                             │──────────────────▶
                    │  the Agent cd's / open()s   │
  git worktree      │  mounts: 1 writable +       │   git commit + push
  empty directory   │  several read-only          │   local archive
  local dir copy    │                             │   object storage upload
  object store sync └─────────────────────────────┘   no delivery (NonePublisher)
```

The two ends are **independently selectable**. That is the key divergence from the "one
`WorkspaceProvider` handles everything" family of designs: those force a 1:1 binding, which cannot
express the single most common combination — "pull code from Git, upload the generated report to
object storage."

### 2.1 Core types

`packages/contracts/src/workspace/index.ts`:

| Type | Purpose |
| --- | --- |
| `SourceKind` | `'git' \| 'empty' \| 'local' \| 'object_storage'` |
| `SourceRef` | Where the content comes from: `{ kind, identifier, label, baseVersion }` |
| `Mount` | One mount point: `{ path, role, writable, source }` |
| `Workspace` | `{ id, runId, root, mounts, writable }` |
| `ChangeSet` | `{ added, modified, deleted, total, truncated }` |
| `PublishResult` | Discriminated union narrowed by `kind` |
| `WorkspaceCheckResult` | Execution record of the quality check |

`identifier` and `label` are kept separate: the former is the backend's own addressing key (Git uses the
repository **id**, and names the mirror directory after it), the latter is the human-facing name (the
repository ref). Renaming a repository should not invalidate the local object store.

### 2.2 Three interfaces

```ts
interface SourceMaterializer {           // materialize
  readonly kind: SourceKind;
  materialize(spec: MountSpec): Promise<Mount>;
  diff(mount: Mount): Promise<ChangeSet>;
  dispose(mount: Mount, opts?: { keep?: boolean }): Promise<void>;
}

interface Publisher {                    // publish
  readonly kind: PublishResult['kind'];
  publish(ws: Workspace, changes: ChangeSet, ctx: ReleaseContext): Promise<PublishResult>;
  finalize?(ws: Workspace, result: PublishResult): Promise<void>;
}

// backend-agnostic teardown pipeline
runReleasePipeline(deps, ws, ctx, opts): Promise<ReleaseOutcome>
```

**`diff` belongs to the materializer, not the publisher.** Only the materializer knows what the baseline
is: Git knows `baseCommit`, the empty-directory backend knows the file-listing snapshot it took, and
object storage knows the ETag listing. The publisher receives an already-computed change set and only
has to ship it out. That division of labor is exactly what lets the two ends combine freely.

---

## 3. The load-bearing wall: `baseVersion` and "baseline + change set"

This is the single easiest thing in the whole abstraction to get wrong.

The natural way to write the abstraction is to give every backend a `scanArtifacts()` that walks the
working directory and emits one artifact record per file. **That road is wrong**:

- A repository checkout has tens of thousands of files and the Agent changed 3 — what gets reported has
  to be those 3
- A directory that has been through `npm install` has hundreds of thousands of files
- Input files the platform itself wrote in (the task brief `BRIEF.md`) get counted as "the Agent's output"
- Patching it up with a hardcoded `IGNORED_DIRS = {node_modules, dist, ...}` will never catch up with
  reality (`.venv`, `target/`, `.next/`, `vendor/`…)

The reason the Git version is clean is precisely that it always had a baseline: `status --porcelain`
reports the difference against `baseCommit`, not a directory listing. **The abstraction has to lift that
concept up to the top.**

So `SourceRef.baseVersion` is required (it may be null, but null means "this backend explicitly has no
baseline," not "somebody forgot to fill it in"), and each backend is responsible for computing its own:

| Backend | Where content comes from | baseVersion | How diff is computed |
| --- | --- | --- | --- |
| `git` | mirror + worktree | commit sha | `git status --porcelain=v1 -z` |
| `empty` | create an empty directory | hash of the file-listing snapshot | rescan, compare entry by entry against the snapshot |
| `local` | copy a registered directory from the host machine | hash of the file-listing snapshot | same as above |
| `object_storage` | sync down from an S3-compatible endpoint | hash of the local listing (an ETag listing is stored alongside) | rescan the local directory and compare against the snapshot |

### 3.1 Snapshots for the filesystem-style backends

`snapshot.ts` (shared by the `empty` / `local` / `object_storage` backends). The snapshot records only
`path → size:mtimeMs` and **computes no content hash**: sha256-ing every file in a several-hundred-MB
output directory would add tens of seconds to every teardown, and all it would buy is accuracy in the
case where size and mtime are both unchanged but the content changed — and an Agent editing a file
necessarily changes the mtime. That trade does not pay.

Three lines of defense:

1. **The snapshot lives outside the working directory** (`{root}/state/{key}.json`). Inside, the Agent
   can see it and might casually delete it, and the snapshot file would show up in its own diff.
2. **Stop at 20000 files and mark `truncated`**, carrying the flag all the way onto the `ChangeSet`.
   Silent truncation is the worst possible handling: "the baseline is incomplete" gets read as
   "nothing changed."
3. **When the baseline is lost, report honestly that it is unavailable — do not guess.** Return an empty
   change set plus `truncated: true`, rather than reporting the entire directory as added — the latter is
   exactly the wrong road described above.

### 3.2 `MountSpec.seed`: the ordering of the baseline

Input files the platform writes into the workspace itself have to be counted as part of the **baseline**,
or they will show up in the change set's `added`. Git has no such problem by nature (the baseline is the
baseCommit); the empty-directory backend has to make the ordering explicit:

```ts
materialize(spec) {
  await mkdir(spec.path);
  await spec.seed?.(spec.path);   // ★ the platform's input files land on disk first
  const snapshot = await this.snapshot(spec.path);   // ★ then the baseline is recorded
}
```

The planning task's `BRIEF.md` goes through exactly this path.

---

## 4. The teardown pipeline: where the abstraction pays off

`pipeline.ts`. The order is the same for every backend:

```
compute change set  →  run quality check  →  publish  →  reclaim mounts  →  publisher finalize
      diff()              runCheck()         publish()      dispose()          finalize()
```

Implementing it once instead of making every backend write its own buys three things:

1. **There is exactly one implementation of the quality check.** It is **entirely orthogonal** to the
   materialize/publish backends — all it does is "run a command inside a local directory." It carries the
   one piece of **non-self-reported** test evidence in the reviewing stage (`ingest.ts` writes it into
   `workItems.typeData.qualityGate`, and `flow/review.ts` reads `testSource === 'workspace_check'`).
   A second copy that got it wrong would never be noticed — "the check failed" and "the check never ran"
   look almost identical in the result.
2. **The ordering constraint "the check runs before publishing" only has to be honored once.** What is
   being tested is the directory state the Agent left behind; and publishing happens whether the check
   passes or fails — "the tests didn't pass so I threw the code away" is the worst possible handling.
3. **Adding a backend = implementing three methods**, instead of rethinking this sequence along with every
   one of its pitfalls.

### 4.1 Why `Publisher.finalize` is its own hook

After a successful Git publish, the local branch in the mirror has to be deleted (the remote already has a
copy; not deleting means unbounded accumulation at the rate of Runs). But **git refuses to delete a branch
that is currently checked out by a worktree** — so this step has to come after `dispose()`. It straddles
publish and dispose, and stuffing it into either one is wrong.

---

## 5. Honesty conventions

A few constraints deliberately written into the types:

| Convention | The wrong way | Why |
| --- | --- | --- |
| `PublishResult` is a discriminated union | `metadata: Record<string, unknown>` | Trading `unknown` for generality is the worst bargain in an abstraction: every consumer degrades to unsafe field reads, on fields that were strongly typed to begin with |
| `NonePublisher` never reports `persisted: true` | "local means already published" | The directory is reclaimed at teardown, and once the container goes away nothing is left at all. Marking it published only makes users click into the artifact and find a path that does not exist |
| `ChangeSet.truncated` is separate from the artifact metadata's `listTruncated` | merge them into one flag | "the baseline is gone" and "there were too many files so only the first 200 were recorded" are not equally severe |
| Artifact metadata records the file-name list | record only a count | At review time "which files changed" is far more useful than "3 files changed," and that information is already in hand at the moment the diff is computed |
| Unrecognized host means no branch link | make up a URL | A link that 404s is worse than no link |
| No artifact is recorded when the change set is empty | record a "0 files" entry | It only pollutes the review view |
| A partially failed object-storage upload does not report `persisted` | count whatever got uploaded | A half-uploaded batch of objects is more dangerous than none: the remote sits in a state that is neither the old one nor the new one, and a caller that sees "persisted" will never look at it again |
| Refuse to archive / upload when the change set is incomplete | copy whatever the incomplete listing says | It produces a result that looks successful but is missing files, and nothing anywhere can say which ones |
| Unrecognized object-storage endpoint gets no console link | guess a path | Self-hosted MinIO / Ceph console paths are all over the map — same discipline as "unrecognized host, no link" on the git side |

---

## 6. The four backends

### 6.1 `git`

Mirror plus worktree. Why not "clone once per Run": cloning a medium-sized repository takes tens of
seconds to several minutes, and the scheduler may dispatch a dozen Runs in a minute. The mirror is created
only the first time; after that each Run attaches its own worktree off the shared object store, which
takes milliseconds.

Read-only reference repositories are attached **detached**: the content is identical to the baseline, and
`worktree remove` does not delete branches — so creating one means garbage piling up permanently in the
mirror at a rate of "Runs × reference repositories."

### 6.2 `empty`

Create an empty directory. Planning, research, and pure-documentation output go this way. It still has a
baseline (see §3).

### 6.3 `local`

Copy content in from a **registered** directory on the host machine (`storage_targets.kind = 'local'`).
Datasets, asset libraries, and directories produced by external tools all fall into this category.

**Copy, rather than letting the Agent work directly in the source directory**: two concurrent Runs would
overwrite each other, and a failed Run would corrupt the source directory with nothing able to restore it.
The cost is that copying a large directory takes time.

`dereference: false` — do not follow symlinks. Following them means a single link pointing at `/etc` copies
the host's configuration into the Agent's workspace, and the allowlist guards mount points, not the link
targets inside them.

**Two gates**:

| Gate | Where | What it guards |
| --- | --- | --- |
| `storage_targets` registration | in the database | The administrator's intent: which directories tasks are allowed to reference |
| `APOS_LOCAL_MOUNT_ROOTS` | environment variable | The operator's floor: a registration filled in as `/` hands the entire machine to the Agent |

The allowlist compares **resolved** absolute paths and requires boundary alignment, otherwise `/data/public`
would also let `/data/public-secrets` through.

Publishing goes through `LocalPublisher`: copy the change set into `APOS_ARCHIVE_ROOT/{runId}/`. With no
archive root configured it falls back to "no delivery" and says so honestly — the entire value of
LocalPublisher is moving things outside the workspace, and without an archive directory there is nowhere
to move them to.

> ★ The archive root must be **different** from `AGENT_WORKSPACE_ROOT`, and on a genuinely durable volume.
> If it sits under the workspace root, `pruneOrphans` will delete it along with the worktrees —
> by which time the user has already seen "archived" on the artifacts page.

### 6.4 `object_storage` (S3-compatible)

Sync the objects under `bucket/prefix` down to a local directory. **What the Agent gets is still a local
directory** — headless CLIs do not speak S3, so what happens here is "sync it down," not "let the Agent
read the bucket directly."

Publishing uploads only `changes.added ∪ changes.modified` and deletes `changes.deleted`.
**This is the most direct payoff of keeping the ChangeSet concept**: a 20 GB dataset is mounted, the Agent
changed 3 files — upload those 3. Degrade to "upload everything" and every teardown becomes 20 GB of egress.

#### Why SigV4 is hand-written instead of pulling in `@aws-sdk/client-s3`

Only four operations are used (List / Get / Put / Delete), and the SDK would drag in dozens of transitive
dependencies. The more practical point: **the SDK could not be integration-tested here either** (there is
no real S3 in the environment), so "trade a mature SDK for correctness" does not actually add up.

The correctness of the hand-written version is anchored by two layers of tests:

| Layer | What it tests | Against what |
| --- | --- | --- |
| `sigv4.test.ts` | derived key → canonical request → string to sign → final signature | The published values from AWS's signing documentation and its general test suite |
| `s3.test.ts` | how requests are sent and responses parsed | An in-process fake S3, asserting URL / method / headers / body line by line |

A few places that are easy to get wrong and extremely hard to diagnose once wrong:

- **`encodeURIComponent` cannot be used**: it leaves `!'()*` alone, while AWS requires those to be encoded
  too. One character off and the signature does not match; the symptom is "objects with certain filenames
  won't upload."
- **Addressing style is explicit configuration**: MinIO / Ceph / homegrown gateways essentially only support
  path-style. Default to virtual-host and the symptom against a self-hosted endpoint is a DNS resolution
  failure — which points nowhere near "addressing style."
- **Listing has to page all the way through**: take only the first page and a bucket with more than 1000
  objects is silently undercounted, and the symptom of undercounting is "these objects aren't in the
  baseline," so at teardown they all come out as additions.
- **XML entities have to be unescaped**: `&` and `<` legitimately appear in object keys, and without
  unescaping those keys read as "different from local" and get reported as modified on every teardown.
- **A partial failure does not count as persisted**: a half-uploaded batch of objects is more dangerous
  than none — the remote sits in a state that is neither the old one nor the new one, and a caller that
  sees `persisted: true` will never look at it again.

---

## 7. Package and directory layout

```
packages/workspace-providers/          ← backends; knows nothing about the database
├── ports.ts              injection points: SecretResolver / RemoteResolver / HostKeyStore
├── types.ts              SourceMaterializer / MountSpec
├── publisher-types.ts    Publisher / ReleaseContext
├── pipeline.ts           backend-agnostic teardown pipeline
├── check.ts              quality check (orthogonal to the backends)
├── snapshot.ts           file-listing snapshot (shared by empty / local / object_storage)
├── paths.ts              root directory layout
├── git/                  cli · ssh · auth · source · publisher
├── empty/                source · none-publisher
├── local/                source · publisher
└── object-storage/       sigv4 · s3 · source · publisher

apps/api/src/modules/workspace/
├── index.ts              WorkspaceService — database adaptation only
└── workspace.test.ts

{AGENT_WORKSPACE_ROOT}/
├── mirrors/{repoId}.git        bare mirror, a repository-level shared object store
├── runs/{runId}/{ref}/         one worktree / one synced-down copy per execution
├── planning/{runId}/           empty directory for planning tasks (kept for later inspection)
└── state/{key}.json            baseline snapshots for the filesystem-style backends

{APOS_ARCHIVE_ROOT}/{runId}/    local archive (must be a different durable volume)
```

### 7.1 Why the backends live in their own package

`git/auth.ts` used to be called `credentials.ts`, with the signature `withRepoAuth(db, repoRow, fn)` — it
took a drizzle `Database` and a row of `repositories` directly. Which means that to run this logic at all
you first needed a Postgres, a set of business tables, and that particular row inside them.

What it actually needs is three things, written as the three interfaces in `ports.ts`:

| Injection point | What it does | How the host implements it |
| --- | --- | --- |
| `SecretResolver` | `secret://…` → plaintext | `resolveSecret` (`modules/security/secrets.ts`) |
| `RemoteResolver` | look up a remote's description by id | query `repositories` |
| `HostKeyStore` | store host public keys learned via TOFU | write `repositories.sshKnownHosts` |

**The second consumer is exactly these new backends**: object storage and local directories also need
credentials resolved, and they have nothing to do with the `repositories` table — stay on the old road and
an S3 bucket would have to disguise itself as a git repository just to get at its own access key.

### 7.2 The registry table: `storage_targets`

Non-Git sources are registered in this table rather than crammed into `repositories`. Every column of that
table is a git concept (`remoteUrl` / `defaultBranch` / `branchPrefix` / `sshKnownHosts`); an S3 bucket
squeezed in there would have to fill those columns with placeholders, and placeholders flow all the way to
the UI ("Default branch: main") — which is precisely the trap the planning task fell into back when it
pretended to be a git repository with `branch:'planning'` (§1).

Database-level constraints pin down the required columns of each kind separately: an object-storage
registration missing its `bucket` cannot be written at all. Without that check the symptom is a "mount
failed" at dispatch time while the administrator looks at the registration and sees nothing wrong.

`ResourceScope` references it with `kind: 'dataset'`, separate from a repository's `kind: 'repo'` — which
makes "what was authorized" self-describing in the permission snapshot.

The registration entry point is under **Settings → Workspace Sources** (its own slot in the navigation,
`/projects/:projectId/settings/storage`; `POST/PATCH/DELETE /api/v1/admin/storage-targets`, permission
`storage_target.manage`).
It is separate from `repository.manage` because the risk surfaces differ: the worst case of registering a
repository is that an Agent can write code into a repository, whereas registering a `local` target hands
the Agent a directory on the host machine.

### 7.2.1 All three source kinds live on one page

**Code repositories and storage targets are a single list in the UI**
(`pages/Settings/WorkspaceSources.tsx`); clicking "Register" first asks for the kind (git / object storage /
host directory), then shows that kind's own form.

The two used to live in different places: repositories were the third tab of "Agent configuration," and
storage targets were another slot in the navigation. The reason for keeping them apart was a data-layer one
— the two tables barely share a column, and the delivery semantics differ — but those reasons are about
**tables and forms**, not about **lists and navigation**: standing here, the user is asking "where does this
project's code and data live," and one question should not be answered in two places. Hanging them under
"Agent configuration" also got the ownership wrong: neither is a property of some Agent, they are
project-level (or organization-level) resource registrations — a monorepo referenced by five Agents and a
bucket referenced by three are both perfectly normal, and deleting one is a question of "does any Agent
authorization point at it."

**What was merged is the entry point, not the model**: underneath there are still two tables and two
permissions, and the registration forms are written separately (merge them into one form and the
inapplicable half can only render as grayed-out placeholders — and placeholders get read as real
configuration, e.g. an S3 bucket labeled "Default branch: main"). The list is interleaved by `ref` rather
than grouped by kind: grouping renders as two sections again, and `ref` is precisely the key an Agent's
resource scopes actually reference.

The route is still `/settings/storage`. Changing it to `/settings/workspace-sources` would buy nothing but a
more apt string, at the cost of 404ing every bookmark anyone saved.

**Authorization** still lives in Agent configuration (`resourceScopes` with `kind: 'repo' | 'dataset'`), so
this page points explicitly back there — the one exception is in §7.2.2.

### 7.2.2 Project-level repositories are read-only by default for Agents in that project

The rule is in `effectiveResourceScopes()` in
`packages/domain/src/permissions/resource-scopes.ts`: explicitly configured scopes plus a read-only entry for
this project's **project-level** registered repositories.

A project usually has exactly one code repository, and "can this project's Agents read this project's code"
has the answer "obviously yes" 99% of the time. Authorizing that Agent by Agent buys no security whatsoever
— the symptom of forgetting to configure it is an Agent starting work in an empty directory and then
reporting "no relevant code found, created a new implementation."

Three boundaries:

| Boundary | Why |
| --- | --- |
| The default stops at `read` | `write` must be granted explicitly — a review Agent should be read-only and only a code Agent writes; that distinction is the single thing the whole governance system most needs to state clearly, and defaulting it away cancels it |
| Only **project-level** registrations participate | Org-level repositories are visible to the whole organization, and handing them out by default means "project A's Agents can automatically read project B's code" |
| Explicit configuration always wins, **including an explicit `none`** | Otherwise "revoke this Agent's repository access" has no way to be expressed at all: delete the entry and it falls back to the read-only default, set it to `none` and the default overrides it |

The injection point is where `dispatchRun()` builds the `permissionSnapshot`, and **only there** — the
snapshot is both persisted as the audit record and passed verbatim to `acquire()`, so computing it once here
guarantees the two sides agree. Candidate filtering (`resolveExecutor`) uses the same function: the symptom
of the two disagreeing is "the scheduler says there are no candidates, but dispatching manually actually
works," and the reason shown in the candidates panel would send someone off to configure authorizations one
by one.

`ResourceScope.origin` (`'explicit' | 'project_default'`) encodes the provenance into the snapshot. Without
it, "this Agent could read this repository at the time" has two completely different readings during an
audit — an administrator granted it, or the platform gave it by default — and those two are exactly what
after-the-fact accountability most needs to tell apart. The registration API strips this field
(`ResourceScope.omit({ origin: true })`), otherwise a caller could disguise an explicit grant as a platform
default.

Two things appear on that page that appear nowhere else, both of the "say nothing and it blows up at the
first dispatch" variety:

- **The current value of `APOS_LOCAL_MOUNT_ROOTS`.** It is a deployment-environment variable that an
  administrator can neither change nor see in the UI, and whether a `local` registration passes the gate is
  entirely up to it — without showing it, a registration that got gated looks exactly like a working one.
- **The connectivity probe** (`POST …/probe`). Object storage lists one page of objects, a local directory
  gets a stat, and it **reuses `isMountRootAllowed`, the very same predicate function**. The cost of a
  second copy is a UI that says "mountable" while dispatch reports "outside the allowed range," and an
  administrator staring at that green probe result would never think to go check an environment variable.

### 7.3 Choosing the primary mount and the publish backend

One execution can mount several resources at once. **Publishing acts only on the primary mount**:

1. First a writable repository
2. Then a writable dataset
3. Then any resolvable one

Repositories outrank datasets because for a task that mounts both a code repository and a dataset, the
output belongs on a branch in the repository, not overwriting the dataset. Every other mount is a read-only
reference.

The publish backend is **taken from the delivery target configured on the registration; only when none is
configured is it inferred from the primary mount's kind**:

```
repositories.delivery_target_id / storage_targets.delivery_target_id
  ├── configured → by the target's kind: object_storage → ObjectStoragePublisher (deliver semantics)
  │                                      local          → LocalPublisher (archive root = the target's rootPath)
  └── not configured → by the primary mount: git → GitPublisher, object_storage → ObjectStoragePublisher
                       (sync semantics), local → LocalPublisher (archive root from
                       APOS_ARCHIVE_ROOT; falls back to none if unset), empty → NonePublisher
```

This column is what makes good on the "two independently selectable ends" promised in §2. Before it existed,
the publish backend could **only** be determined by the primary mount, which means the very example §2 uses
to explain the design — "pull code from Git, upload the generated report to object storage" — was precisely
the one that could not be expressed.

**It overrides, it does not append.** Configure a delivery target and the branch is no longer pushed. To get
"push the branch *and* upload a copy to S3" you would need `pipeline` to support multiple publishers,
`PublishResult` to become an array, and artifacts to write multiple rows — a change of a different magnitude.

### 7.4 `sync` and `deliver` are two different semantics and must be separated in the types

| | Target | `changes.deleted` | Destination |
| --- | --- | --- | --- |
| `sync` | the primary mount's own source | **deletes** the remote objects | in place at `{prefix}` |
| `deliver` | a different target | **untouched** | `{prefix}{runId}/` |

★★ The consequence of not separating them is **data loss**: on a deliver, `changes.deleted` means "the Agent
deleted these files in the workspace," while a key of the same name in the target bucket belongs to someone
else — deleting along with it means taking one Run's change set and applying it to an unrelated bucket. This
is the only operation in the entire publish path that can destroy someone else's data, which is why it is
locked behind `if (!deliver)`.

Splitting by `runId` follows the same logic: without it, two Runs that both produce `report.md` mean the
second silently overwrites the first, while the artifacts page shows two records pointing at the same key.

On a deliver, the primary mount's `writable` is **not consulted** — the primary mount may be a read-only git
worktree, which has nothing to do with "can we write to the target"; the target's own writability was already
checked by `WorkspaceService` when it picked the backend.

**Delivering to a host directory must also pass `APOS_LOCAL_MOUNT_ROOTS`.** That gate used to guard only
"mounting in," and "writing out" is if anything more destructive — a registration pointing at `/etc` is a
leak on the way in and an overwrite on the way out.

**Every case where it was configured but did not take effect has to state a reason** (target does not exist /
disabled / read-only / blocked by the allowlist), carried into the teardown notes via `NonePublisher(reason)`.
Without one, the text the user sees is identical to "no delivery target was ever configured" — and of those
two, one means the configuration did not take effect and the other is working as intended.

> ★ `ObjectStoragePublisher` must be **constructed per invocation**; it cannot be registered globally the way
> git's is. At publish time all that is left on the mount is the snapshot key, and getting back to the
> endpoint and credentials requires knowing the `targetId` — and that mapping lives in the mount list this
> Run persisted. Make it a global singleton and you have to hang a mutable "which Run is current" field on the
> instance, while the supervisor's timeout check and the event stream's `run_ended` already arrive
> concurrently: interleave two teardowns and one Run's output gets uploaded into another Run's bucket. A
> closure capturing this invocation's mount list has no such problem by construction.

---

## 8. Two channels

### 8.1 The persisted channel (execution Runs)

`acquire()` / `release()`. State is written into `agent_runs.workspace` (jsonb) — after a process restart the
system has to be able to answer "what did this orphaned Run leave behind, and on which branch."

### 8.2 The non-persisted channel (planning Runs)

`acquireLocal()` / `releaseLocal()`.

**This is the one genuine coupling point in the whole abstraction, and it is worth spelling out**: planning
Runs are **deliberately not in `agent_runs`** — `agent_runs.work_item_id` is NOT NULL with a foreign key,
and planning happens before the work item exists (the full reasoning is at the top of
`planning/agent-provider.ts`). So the persisted channel has nothing it could write for them.

Opening an explicitly non-persisted path, rather than letting the caller `mkdir` and hand-forge a workspace
— the latter is exactly what happened before the rework, and the cost is written up in §1.

---

## 9. Migrations and cleanup

| Migration | Contents |
| --- | --- |
| `0019_storage_targets` | Create the `storage_targets` table (generated from the schema by drizzle-kit) |
| `0020_workspace_mounts_backfill` | Add RLS to it; backfill `agent_runs.workspace.mounts` |
| `0021_delivery_target` | Add `delivery_target_id` to `repositories` and `storage_targets` |

`delivery_target_id` **deliberately has no foreign key**: two tables pointing at the same place would need two
constraints, and the delete semantics are not cascade either (deleting a target should not quietly flip the
registrations that depend on it to "no delivery"). The check lives in `deleteStorageTarget` instead — if any
registration delivers to it, the delete is refused. Without that check the delete succeeds, and those
registrations' output silently falls back to "no delivery" at the next teardown: the task still succeeds, the
artifacts page still has records, the output just never went anywhere.

**Why RLS needs its own migration**: `0017_supabase_rls` "walks every table that existed at the time," which
does not reach tables created afterward. And `storage_targets` holds object-storage credential references —
exactly the class of data that should least appear on an anonymous REST endpoint. Missing it produces no
symptom at all: the app runs normally, the logs are clean, and you find out only after the data has been
exfiltrated.

**Why the backfill needs its own migration**: `0019` was generated from the schema by drizzle-kit, so the next
schema change regenerates and overwrites it. Anything hand-written has to live in its own file.

**Why `mounts` once needed no migration**: it is a field added **inside** the `workspace` jsonb column;
`$type<>` is only a TS-level annotation and the column type is still `jsonb` — `drizzle-kit generate` produces
no diff at all. The cost is that old rows do not have the key, and without it none of those Runs' reference
worktrees can be reclaimed. Once `0020` filled the data in, the code's "fall back to the primary path when
mounts is unreadable" fallback was downgraded from a **correctness dependency** to **insurance for the rolling
deploy window** (after the migration runs, old processes may still be writing rows in the old shape).

The backfill only fills in rows whose shape is complete: rows missing `path` or `repoId` were already broken,
and making up a `mounts` for them would only disguise bad data as good data.

---

### 9.1 Environment variables

| Variable | Purpose | Consequence of leaving it unset |
| --- | --- | --- |
| `AGENT_WORKSPACE_ROOT` | Workspace root directory | Uses `/tmp/apos-workspaces` |
| `APOS_ARCHIVE_ROOT` | Local archive root | `local`-kind workspaces fall back to "no delivery" and honestly report `persisted: false` |
| `APOS_LOCAL_MOUNT_ROOTS` | Allowlist of host directories that may be mounted (`:`-separated) | No restriction — any registered path can be mounted |
| `APOS_WORKSPACE_PUSH_ON_FAILURE` | Push the branch even for failed Runs | Changes from failures stay only on a local branch in the mirror |
| `APOS_WORKSPACE_KEEP_LOCAL_BRANCHES` | Keep the local branch in the mirror after a successful push | Deleted on a successful push (the remote already has a copy) |

---

## 10. Related documents

- [06 Agent Protocol](06-agent-protocol.md) — the dispatch contract for `TaskDispatch.workspace`
- [09 Identity, Permissions and Security](09-security.md) — how repository credentials are injected (tokens never enter argv, never hit disk)
- [04 Flow Engine](04-flow-engine.md) — why teardown must happen before the status transition
