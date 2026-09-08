# 13 · One localization pipeline for both sides

*[中文版本 / Chinese version](13-i18n-unified.zh.md)*

[12 · Localization](12-i18n.md) describes what exists: a message catalog in the front end, and reason codes coming out of the HTTP layer. This document is about the half that is not finished.

The current design has one unstated boundary. **The server can produce a code, but it cannot produce a sentence in any language other than Chinese** — the catalog lives inside `apps/web`, so it is reachable only from a browser. Every path that does not end in a browser therefore ends in hard-coded Chinese: notifications, policy-template forms, guard failures, log lines, exports.

This is not "some strings we forgot". It is a structural gap: the code-plus-params discipline stops at the HTTP response envelope, and everything past that boundary silently reverts to the pre-i18n design.

**The scheme in one sentence: one catalog, one renderer, one wire format — and rendering happens only at the last hop out, in the reader's language.**

---

## 1. What is actually unfinished

| Path | Today | What an English reader gets |
| --- | --- | --- |
| HTTP error | `fail(code, reason, prose, {params})` | ✅ Correct — the UI reads the code |
| Rejection / decision reason | code + params in `blocked_detail`, `reason_detail` | ✅ Correct |
| **Policy templates** | `/policy-templates` ships `name` / `purpose` / `label` / `suffix` as Chinese (`domain/policy/templates.ts:137`) | A whole configuration form in Chinese |
| **Policy explanation** | Sentences assembled in `domain/policy/explain.ts:177` | The one screen that explains what a governance rule does |
| **Notifications** | `buildDecisionMessage` glues Chinese fragments (`domain/notification/decide.ts:133`) | Slack/Feishu/email are Chinese-only |
| **Guard failures** | `` `${unmet.length} 个前置依赖未满足` `` (`domain/flow/guards.ts:110`) | Exempted in `REASONS_WITHOUT_CATALOG` |
| **Role validation** | `` `不认识这些权限：${unknown.join('、')}` `` (`domain/rbac/roles.ts:181`) | Chinese, plus a Chinese list separator |
| **Enum labels** | Two tables — `FACT_LABELS` (zh, domain) and `policyFactLabel()` (catalog, web) | Two tables drift |
| **"Not found"** | Two tables — `NOT_FOUND_PROSE` (zh) and `error.notFound.*` | Same |
| **Durations** | `humanMinutes()` returns `3 小时` | A locale baked into a value |
| **Log lines** | Chinese | A non-Chinese operator on call |

Three distinct failures hide in that table, and they need different fixes:

1. **No catalog on the server.** (notifications, templates, explanations, logs)
2. **Sentences assembled from fragments**, which doc 12 already forbids in the UI but the server has no way to obey. (guards, roles, explanations)
3. **Values with a language inside them** — `3 小时`, `a、b、c`. Even a perfect catalog cannot rescue these, because by the time the string reaches the renderer the language is already in it.

---

## 2. Four layers, one direction

```
produce            catalog              render                  read
─────────          ─────────            ─────────               ────────
domain / api  ──▶  packages/i18n   ──▶  browser (useT)      ──▶  the UI
  emits a          the only place       last hop out            Slack / mail
  descriptor       any language         (notify transport,      a log file
  { key, params }  is written           export, log sink)       an export
```

Two rules define the whole design:

**① Nothing above the catalog layer contains a language.** A function in `domain/` that returns a sentence is a bug, the same way an `import '@apos/db'` inside domain is a bug. It returns a descriptor.

**② Rendering happens as late as possible, and exactly twice.** In the browser, or at the moment a message leaves the product for a channel that cannot carry a descriptor. Nowhere in between.

---

## 3. The decision: the API stays locale-free

The obvious "unified" answer is to have the API read `Accept-Language` and return translated responses. This design deliberately does not, for four reasons — and the reasons are the interesting part, because they are what makes the front end and the back end able to share one catalog rather than one translation service.

| Why not translate in the API | |
| --- | --- |
| **SSE has many readers** | One `project:{id}:board` payload is fanned out to every viewer of the project. There is no single "the requester" whose language it could be rendered in. Any per-request rendering would have to be undone for the push path anyway. |
| **Idempotency replays across users** | A replayed response is served from a stored payload. A payload frozen in the language of whoever sent the first request is then handed to someone else. |
| **The switch must be free** | Toggling language would have to invalidate the entire query cache and refetch. With rendering client-side, it is a re-render of what is already in memory. |
| **The UI needs the code regardless** | `error.reason` drives more than a sentence: which button to show ("grant access", "fix this"), which page to link to, whether to retry. Translating server-side does not remove the need for the code; it just adds a second thing to keep in sync. |

`Accept-Language` is also refused for the same reason doc 12 refuses `navigator.language`: on machines in China it is frequently `zh-CN` while the person deliberately wants the English UI. And a notification is not a request at all — there is no header to read at the moment a Slack message is composed.

**So: the HTTP surface never localizes. Only the two edges do.**

---

## 4. `packages/i18n` — the shared catalog

```
packages/i18n/
  src/
    messages/
      buckets.ts     prefix → module, plus the owner column (§4.1)
      en/            the ten modules from apps/web, unchanged
      zh/            typed against en/, per module, unchanged
    render.ts        render(locale, text) — plurals, interpolation, list joining
    format.ts        number / duration / timestamp / percentage, per locale
    keys.ts          MessageKey, hasMessage
    locale.ts        Locale = 'en' | 'zh', DEFAULT_LOCALE = 'en'
```

Dependency direction gains one link at the bottom:

```
http → modules → domain → contracts → i18n
```

`@apos/i18n` imports nothing. Both `contracts` (for the descriptor type) and everything above may import it.

**Why not put the catalog in `contracts`.** `contracts` is the wire schema — types and Zod, near-zero runtime, and it is what an external agent SDK consumes. Making it carry 2,700 UI strings × 2 languages means anything that wants to know the shape of a `WorkItem` also downloads every button label.

**What stays in `apps/web`**: `useT`, the zustand locale store, `<html lang>`, `useSpecText`, `format/index.ts`'s `xxxLabel()` lookups. Those are React and browser concerns. The move is a pure relocation of the catalogs plus the pure functions — the web app keeps re-exporting from `lib/i18n`, so no call site changes in phase 0.

### 4.1 Key ownership

`buckets.ts` gains a third column: who renders this key.

| Owner | Meaning | Example |
| --- | --- | --- |
| `web` | Rendered only in a browser | `board.column.review` |
| `server` | Rendered only at a last hop out | `notify.decision.title` |
| `shared` | Both | `error.reason.*`, enum labels |

This exists because sharing a catalog creates a new failure mode the front end never had: **someone rewording a button breaks a Slack message or a log line**. `structure.test.ts` is extended to assert that a key rendered by the server is not declared `web`-owned, so the reverse dependency is at least visible in the diff.

---

## 5. The wire format: one descriptor

```ts
// packages/contracts/src/common/text.ts
export interface Text {
  key: MessageKey;
  params?: TextParams;
  /** Prose for rows written before the code existed, and for clients that do not know it */
  fallback?: string;
}

export type TextParams = Record<string, TextValue>;
export type TextValue =
  | string          // the user's own words — passed through, never translated
  | number
  | Text            // a nested sentence (§5.2)
  | TextValue[]     // a list — the renderer joins it (§5.3)
  | { kind: 'duration'; minutes: number }
  | { kind: 'instant'; iso: string }
  | { kind: 'percent' | 'money' | 'count'; value: number };
```

This is a generalization of what `ErrorReason` + `params` already does, given a name and a type so that it can travel anywhere: an event payload, `blocked_detail`, a notification job, an insight, a policy template field.

### 5.1 Language-neutral values only

Already stated in doc 12 §3.6, now enforceable: a raw `string` param is *by definition* the user's own words. Anything the platform computed goes in as a tagged value or a nested `Text`. `params: { range: '近 7 天' }` is not merely discouraged — there is no way to express it that renders correctly, which is the point.

### 5.2 Composition without fragments

The rule "never assemble a sentence" runs into real composite messages: *"blocked: 3 dependencies unmet, and the Review stage is at its WIP limit"*. The answer is nesting, not concatenation:

```ts
{ key: 'guard.blocked_multi', params: { reasons: [
    { key: 'guard.deps_unmet', params: { count: 3 } },
    { key: 'guard.wip_limit',  params: { stage: 'review', limit: 5 } },
] } }
```

Each entry is a whole sentence in its own language; the outer entry decides how they sit together. The renderer resolves depth-first. Nesting is capped at 3 — beyond that the composite should be its own entry.

### 5.3 Lists are joined by the renderer

`joinList()` moves into `packages/i18n` and is applied to any array param: `、` for zh, `, ` with a final `and` for en. `domain/rbac/roles.ts:181` and `domain/policy/explain.ts:91` stop calling `.join()` and send the array.

### 5.4 Durations, numbers, instants

`humanMinutes()` returning `3 小时` is deleted; `{ kind: 'duration', minutes }` is formatted by `Intl.RelativeTimeFormat`/`Intl.NumberFormat` at render time. This is the class of bug a catalog alone does not fix, and it is why the descriptor carries tagged values rather than pre-formatted strings.

---

## 6. Which language, decided where

Rendering needs a locale, and each edge gets it from a different place. Never from a header.

| Surface | Locale from | Fallback chain |
| --- | --- | --- |
| Browser UI | the explicit store (doc 12 §2①) | `en` |
| Notification to a person | `users.locale` | project → org → `en` |
| Notification to a channel (a Slack group is not a person) | `projects.locale` | org → `en` |
| Email | recipient's `users.locale` | `en` |
| Export (CSV/PDF) | the requesting user's locale, passed explicitly as a query param | `en` |
| Log lines, audit prose, `fallback` fields | `APOS_LOG_LOCALE`, fixed at boot for the whole deployment | `en` |
| Agent-facing text in a run | `projects.locale` — the humans reading that run are on that project | `en` |

Three new nullable columns: `users.locale`, `projects.locale`, `organizations.locale`. Nullable is meaningful — `NULL` means "inherit", which is not the same as an explicit `en`, and the difference shows up the day an org sets its default.

`APOS_LOG_LOCALE` is one value per deployment, not per request: a log file where consecutive lines are in different languages is worse than one in the wrong language, because it defeats grep.

---

## 7. Nothing rendered gets stored

`blocked_detail` already stores a code and params rather than a sentence, and that is the pattern for everything: notification jobs, decision reasons, insights, events. **A row written last year renders in the language of whoever reads it today** — impossible if it were stored as prose.

Existing rows have prose and no code. They keep working through `Text.fallback`, which is exactly what `REASONS_WITHOUT_CATALOG` and the current `message` field already do. No backfill, no migration of historical data — the renderer prefers the key and falls back to the stored sentence.

---

## 8. `fail()` loses its sentence

Once the catalog is reachable from the server, the third argument is redundant:

```ts
throw fail('VALIDATION_FAILED', 'storage.delivery_target_readonly', { ref });   // ← three args
```

`message` in the response envelope is then rendered from the catalog at `APOS_LOG_LOCALE`. This is worth doing for two reasons beyond tidiness:

- **It removes the drift.** The prose at the throw site and the catalog entry are two statements of the same thing, edited separately. They already disagree in places.
- **It removes the path that created the gap.** Doc 12 notes that `code, reason, message` ordering exists to stop "write the sentence now, add the code later". Removing the sentence removes the option entirely.

`NOT_FOUND_PROSE` disappears the same way — `error.notFound.<entity>` is the only table.

---

## 9. The two deliberate exceptions become codes

Doc 12 §5 keeps `guard.failed` and `policy.denied` untranslated on purpose, because a generic "a precondition failed" throws away the specific information. That reasoning is correct and this design does not overturn it — it removes the need for it.

```ts
export type GuardReason =
  | { code: 'guard.deps_unmet'; params: { count: number; items: string[] } }
  | { code: 'guard.wip_limit'; params: { stage: StageKey; limit: number } }
  | { code: 'guard.no_executor' }
  | { code: 'guard.no_artifact' }
  | { code: 'guard.acceptance_unmet'; params: { count: number } }
  | { code: 'guard.quality_gate'; params: { checks: string[] } };
```

Six codes for the six branches in `guards.ts`. Policy denial becomes `{ ruleId, ruleName, factCode, expected, actual }` — the rule's name is the user's own words and passes through verbatim; everything else is an enum the UI already has labels for.

`REASONS_WITHOUT_CATALOG` should end up empty. **Keep the mechanism anyway**: it is what distinguishes "deliberately untranslated" from "forgotten", and the next deliberate exception should not have to reinvent it.

---

## 10. The tests that hold the new line

Doc 12's four tests stay. Four more are needed, and they are all watching the same thing: **silent failure that is invisible to whoever wrote the code**.

| Test | What it guards | Fails when |
| --- | --- | --- |
| `i18n/coverage.test.ts` | Every code in *every* enum — `ErrorReason`, `GuardReason`, `RejectionCode`, `DecisionReason`, `Insight.code`, `PolicyIssue.type`, notification keys, policy template fields — resolves in both catalogs | A new code ships without a sentence |
| `i18n/no-prose.test.ts` | No CJK literal in the server's user-visible builders (`domain/notification/`, `flow/guards.ts`, `policy/explain.ts`, `policy/templates.ts`, `rbac/roles.ts`) | Someone writes a sentence where a descriptor belongs |
| `i18n/params.test.ts` | No param value contains CJK, `、`, or a unit suffix; array params are not pre-joined | A language leaks into a value (§5.4) |
| `i18n/pseudo.test.ts` | With a generated third locale `xx` (every entry wrapped as `⟦…⟧`), rendering every catalog key and every enum code produces no untagged output | Language remains anywhere outside `packages/i18n` |

The last one is the acceptance test for the whole design. If a third language can be added by touching only `packages/i18n/messages/`, the scheme worked. If anything else has to change, it did not.

---

## 11. Migration — five phases, each shippable

| # | Change | Blast radius | Green at the end? |
| --- | --- | --- | --- |
| 0 | Create `packages/i18n`; move the catalogs and pure functions; `apps/web/src/lib/i18n` re-exports | ~30 files moved, 0 call sites changed | Yes — pure relocation |
| 1 | `Text` descriptor in contracts; `render()` on the server; `APOS_LOG_LOCALE`; `fail()` drops its prose argument; delete `NOT_FOUND_PROSE` | Every `fail()` call site (mechanical) | Yes |
| 2 | `users.locale` / `projects.locale` / `organizations.locale`; notifications become descriptors and render per recipient; delete `humanMinutes` | `notification/`, transports, one migration | Yes |
| 3 | `GuardReason` + policy denial codes; empty `REASONS_WITHOUT_CATALOG`; policy templates and `explain.ts` ship descriptors | `flow/guards.ts`, `policy/`, the policy pages | Yes |
| 4 | Delete the `XXX_LABELS` Chinese tables in domain; log lines go through the renderer | `analytics/`, `policy/`, `graph/` | Yes |

Order matters in one place only: phase 1 must land before 2–4, because they all need a server-side renderer. Phases 2, 3 and 4 are independent of each other and can go in any order or in parallel.

Phase 0 is deliberately a no-op. A move that also changes behavior cannot be reviewed — the diff is 30 file renames and the one real change is invisible inside them.

---

## 12. Non-goals

Stated so that they are decisions rather than omissions:

- **RTL.** Arabic/Hebrew need layout mirroring, not just a catalog. Nothing here blocks it; nothing here does it.
- **CLDR plural categories.** `_one` / `_other` covers `en` and `zh`. A language with more categories (ru, ar, pl) means swapping the picker in `render.ts` for `Intl.PluralRules` — one function, and the descriptor format does not change.
- **Translating user content.** Requirement text, policy names, agent names, commit messages. Never. Doc 12 §1.
- **Machine translation of the catalog.** The catalog is small enough to write and too load-bearing to guess at — `error.reason.*` entries tell someone how to unblock themselves.
- **Timezones.** A separate axis from language (a `zh` user in Berlin), and the descriptor already carries instants as ISO strings so the two can be decided independently.
- **Lazy-loading catalogs per language.** Both locales are bundled eagerly today, and a language toggle that awaits a chunk flickers. `buckets.ts` already holds the mapping needed to split by area later — do it when the bundle is measured, not before.

---

## 13. Adding a sentence, after this lands

| It is… | Do |
| --- | --- |
| UI copy | Unchanged from doc 12 §7 — a key in `messages/{en,zh}/<area>.ts` |
| A server error | `fail(code, reason, { params })`, plus `error.reason.<code>` in both catalogs. No prose. |
| A notification / export / log line | Return a `Text`. Render only in the transport, with the recipient's locale. |
| A guard or policy outcome | A code in the relevant union, params as language-neutral values |
| An enum label | Catalog entry + `xxxLabel()`. Never a Chinese table in domain. |
| A number, duration or list | A tagged value or an array. Never a formatted string. |
