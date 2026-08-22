# 03 Requirement Intake and AI Clarification

*[中文版本 / Chinese version](03-requirement-intake.zh.md)*

## 1. Page Facts

| Item | Value |
| --- | --- |
| Route | `/projects/:projectId/requirements/new` (intake)<br>`/projects/:projectId/requirements/:reqId` (clarify and confirm) |
| Level | Third-level page |
| Primary roles | `sponsor` / `pm` (enter and confirm); `member` (can enter, cannot confirm) |
| Priority | P0 |
| Related product docs | 8.2 Requirement Center, 8.8.1 HITL in the requirement phase, 6.2 Requirement |

---

## 2. Goal

Turn a vague business description into a **structured requirement both sides agree on and can be decomposed directly**.

The page has to answer:

1. What did the AI understand my requirement to be? (side by side, with the original never lost)
2. What is still missing? What must I decide, and what can the AI assume on its own?
3. What happens after I confirm?

This is the product's first Human Gate, and it is where the quality of every downstream automation is decided. **Two extra minutes here beat three hours of an Agent running on a wrong understanding.**

---

## 3. Entrances and Exits

**Entrances**: automatically after creating a project; "Enter a requirement" on the project overview; New on the requirement list; requirements awaiting confirmation that arrived from an external sync (Jira / email / meeting notes).

**Exits**:

| Action | Destination |
| --- | --- |
| Confirm the requirement | `04 Plan Approval` (the Project Agent starts planning) |
| Save draft | Stay here; requirement status `draft` |
| Reject / hold | Back to the requirement list |
| Delegate the confirmation | Creates a Decision → the other person's `11 Decision Detail` |

---

## 4. Page Structure

### 4.1 Step one: intake

```
┌────────────────────────────────────────────────────────────────────┐
│ ← Order system rework / New requirement               [Save draft] │
├────────────────────────────────────────────────────────────────────┤
│  (1) Intake ── (2) AI analysis ── (3) Clarify ── (4) Confirm       │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  How do you want to enter it?                                      │
│  [✏ Describe] [💬 Chat] [📎 Upload a doc] [🔗 Import from a tool]  │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ Describe what you want, in your own words.                   │  │
│  │                                                              │  │
│  │ Order lookups take several seconds now and support           │  │
│  │ complains every day. We want to speed it up, ideally         │  │
│  │ with search by phone number, order number, and date          │  │
│  │ range. Also the boss wants it live before Friday.            │  │
│  └──────────────────────────────────────────────────────────────┘  │
│  📎 Attached: support-complaints.xlsx  ×   product-mtg-0803.md  ×  │
│                                                                    │
│  Priority [High ▾]   Target date [2026-08-08 📅]                   │
│                                                                    │
│                      Analysis costs ~$0.12   [Start AI analysis →] │
└────────────────────────────────────────────────────────────────────┘
```

### 4.2 Steps two and three: AI analysis and clarification (the core page)

```
┌───────────────────────────────────────────────────────────────────────────┐
│ ← Order lookup performance        Draft · AI analyzed  [Save] [Confirm →] │
├───────────────────────────────────────────────────────────────────────────┤
│ Completeness ████████░░ 72   Goal ✓ Scope ✓ Accept ⚠ Deps ✗ Risk ⚠ Tech ✓ │
├──────────────────────────────┬────────────────────────────────────────────┤
│ 📄 Original input    [Edit]  │ 🤖 AI structured result  by Project Agent  │
│ ┌──────────────────────────┐ │ ┌────────────────────────────────────────┐ │
│ │ Order lookups take a few │ │ │ Title                           [Edit] │ │
│ │ seconds now and support  │ │ │ Order lookup performance with multi-   │ │
│ │ complains every day. We  │ │ │ field search                           │ │
│ │ want search by phone,    │ │ ├────────────────────────────────────────┤ │
│ │ order no., date range.   │ │ │ Business context                       │ │
│ │ Boss wants it by Friday. │ │ │ Slow order lookups drive complaints…   │ │
│ │                          │ │ │ Source: sentence 1 + complaints.xlsx   │ │
│ │ 📎 complaints.xlsx       │ │ ├────────────────────────────────────────┤ │
│ │ 📎 product-mtg-0803.md   │ │ │ User problem / Goal / User stories     │ │
│ └──────────────────────────┘ │ │ Functional scope (3 items)             │ │
│                              │ │ Non-functional (P95 < 500ms…)          │ │
│ 💡 Context the AI cited      │ ├────────────────────────────────────────┤ │
│ · Knowledge: orders schema   │ │ Acceptance criteria       ⚠ incomplete │ │
│ · Past req: #28 search opt   │ │ ☑ All three filters queryable          │ │
│ · Repo: order-service        │ │ ☑ P95 response < 500ms                 │ │
│                              │ │ ☐ — missing data volume / concurrency  │ │
│                              │ ├────────────────────────────────────────┤ │
│                              │ │ Potential risks (2) · Dependencies (—) │ │
│                              │ └────────────────────────────────────────┘ │
├──────────────────────────────┴────────────────────────────────────────────┤
│ ❓ Needs clarification (5)   [Must confirm 3] [Default 1] [Auto-solved 1] │
│ ┌───────────────────────────────────────────────────────────────────────┐ │
│ │ 🔴 Must confirm  Q1. What is the maximum span of a date-range search? │ │
│ │    Impact: decides whether we need sharding; up to 3 days of work     │ │
│ │    Agent leans: 3 months (same cap as the reporting module)           │ │
│ │    ┌─────────────────────────────────────────────────────┐            │ │
│ │    │ [Use suggestion] [7d] [1mo] [3mo] [Any]  or type…   │            │ │
│ │    └─────────────────────────────────────────────────────┘            │ │
│ ├───────────────────────────────────────────────────────────────────────┤ │
│ │ 🔴 Must confirm  Q2. Does "live Friday" mean full rollout or canary?  │ │
│ │ 🔴 Must confirm  Q3. Do we keep the old query API for compatibility?  │ │
│ ├───────────────────────────────────────────────────────────────────────┤ │
│ │ 🟡 Default OK    Q4. Search page size? → 20/page (org default)        │ │
│ │                  [Accept default] [I will decide]                     │ │
│ ├───────────────────────────────────────────────────────────────────────┤ │
│ │ 🟢 Solved        Q5. Current order table size? → 42M rows (from KB)   │ │
│ └───────────────────────────────────────────────────────────────────────┘ │
├───────────────────────────────────────────────────────────────────────────┤
│ 📌 Recorded assumptions (2)  · No data migration  · Last 2 years   [Edit] │
├───────────────────────────────────────────────────────────────────────────┤
│ [Reject] [Hold] [Delegate]   [Re-analyze ~$0.09]  [Confirm requirement →] │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Region by Region

### 5.1 Intake methods (product doc 8.2.1)

| Method | Interaction | MVP |
| --- | --- | --- |
| Describe it directly | Large text box + attachments | ✅ |
| Conversation | Chat-style and multi-turn; the Agent asks as it goes | ✅ |
| Upload a document | PRD / meeting notes / email, parsed into the structured form | ✅ |
| External import | Jira / Plane, one at a time or in bulk | ✅ (depends on `14 Integration Settings`) |
| API / webhook | No UI; lands in the requirement list awaiting confirmation | ✅ |
| Customer feedback import | — | Post-MVP |

**Conversation mode** and form mode share the same requirement object and can be switched between at any moment: conclusions reached in conversation are written into the structured panel on the right as they happen. This matters — the user should not have to choose between "chatting" and "filling in a form."

### 5.2 Completeness score (product doc 8.2.3)

Six dimensions: goal, scope, acceptance criteria, dependencies, risks, technical context. Each one ✓ / ⚠ / ✗.

- **The total is not a gate.** It does not stop anyone from confirming a low-scoring requirement, but below 60 a note next to the confirm button reads "completeness is low; expect the Agent to produce more rework"
- Click any dimension and the right-hand panel scrolls to the matching block and highlights it
- The score updates live — it climbs the moment a clarifying question is answered, which is the positive feedback

### 5.3 Original input region

**The original text is kept forever, and can be edited and re-analyzed.** The user has to be able to check that the AI did not distort what they meant.

Every field of the AI's structured result is annotated with its **provenance** (which sentence of the original, which attachment, which piece of knowledge). Hovering highlights the matching span in the original text — this is the interaction that builds trust.

### 5.4 Structured requirement: two paths, AI and by hand (product doc 8.2.2)

Fields: title, business context, user problem, business goal, user stories, functional scope, non-functional requirements, acceptance criteria, potential risks, dependencies, open questions.

**The two sources rank equally**: AI analysis, and filling it in by hand. An empty requirement offers both entrances side by side ("Let the AI analyze it" / "Fill it in myself"),
and New on the requirement list is likewise two buttons — make the manual path a small-print fallback and users only discover it after the AI has failed,
by which point they have already sat through one timeout. In a deployment with no planning Agent configured, by hand is the **only** path that works at all.

Every field:
- Editable (today the whole form submits at once; there is no per-field inline editing). Once edited, a field is marked `👤 Human`; untouched fields stay `🤖 AI`
- Incomplete fields carry a ⚠ and a note about what is missing
- Acceptance criteria render as a checklist — they later become the basis for automatic verification in the Review phase (product doc 8.10.1), so they have to be structured, not free text.
  Hand-written criteria take the **same shape** as AI output (id / status / verification filled in), or they will never be checked in Review;
  the verification method is chosen by a person and defaults to "manual" — the platform has no grounds for deciding that a line of hand-typed text can be verified automatically

**The confirmation gate looks at content, not at provenance**: any one of title, business goal, or acceptance criteria is enough to confirm (a blank page is refused,
and the error offers both the AI and the manual way out). Gating on "has this been analyzed" walls off the manual path at the very last step.

**Who writes this PRD can be chosen per requirement.** A dropdown above the structured panel lists **this project's Agent members** —
all of them, not filtered by applicable type (the same criterion as binding a planning Agent in project settings). Leave it unset and the project's bound planning Agent is used
— behavior for existing requirements does not change at all.

**Applicable type (`applicableTypes`) is not a gate.** It answers "can a work item be dispatched to this Agent," and writing a PRD dispatches no work item at all —
no work item exists yet, which is exactly why `agent_runs.work_item_id` was widened to nullable. Back when it was used as a gate, the result was a project with a full
roster of Agents and zero of them able to write a PRD, with nothing on screen but an empty dropdown that could not explain "go tick a checkbox in Agent settings whose
purpose you don't know." Whether an Agent writes well is something a person decides after reading its output and swapping it out — not something a checkbox ticked
offhand at signup gets to decide in advance. The type now only sets the ordering for **automatic selection**: Agents that declare it sort first (someone stated that
intent explicitly), and the ones that don't are still eligible.

**There is exactly one criterion for writing a PRD: is this an Agent member of this project.** A disabled Agent can still be selected — the UI says plainly
that the next analysis will fail, because disabling is usually temporary and this choice has to survive until the next analysis.

The choice is stored on the requirement (`requirements.author_agent_id`), not on one particular analysis: pick an Agent, leave the page,
come back two days later and hit "Re-analyze," and the choice has to still be there. Otherwise "I picked an Agent to write it" only ever meant "that one happened to be used this once,"
and the next run quietly reverts to the project's bound Agent with no sign of it anywhere on screen.

Three disciplines go with the dropdown; drop any one and it becomes decoration:

- **Once named, never substituted.** When the named Agent is unavailable (disabled, removed from the project, runtime not registered), that analysis falls back
  honestly to the rule-based placeholder, with the reason written into `analysisModel` and shown next to the result heading — even with a perfectly usable
  alternative sitting right there, it is not swapped in. The project binding falling back to an alternative is "the system covering for you"; substituting after
  you named someone is "the system overruled your choice and didn't tell you."
- **The membership check is authorization, not polish.** A planning Run mounts the project's resources read-only into the Agent's workspace, so an Agent that is not
  a member of this project is refused outright — refused at the moment of saving, not after an analysis has already been wasted.
- **An Agent already selected but no longer among the candidates still shows**, with a note that the next analysis will fail. Rendering it as "unset"
  is the worst possible handling: the database still points straight at it.

The "Past analyses" list also shows **which Agent** ran each one — show only the model and the rows on either side of an author-Agent change look identical,
which makes that choice feedback-free.

**When output fails validation, give it one correction round rather than falling back immediately.** When the JSON an Agent writes back does not validate (a misspelled enum value,
a missing field, a dependency pointing at a task that does not exist), the platform hands the validator's own error lines back along with the previous artifact
and lets the **same** Agent run again. Only after two failed rounds does it fall back to the rule-based placeholder, and the fallback reason says "retried and still invalid."

The reason is that these errors are almost always **format** errors rather than comprehension errors: a PRD whose analysis is correct and whose only fault is a `type` set to
an enum value that does not exist — throwing it away writes off the most expensive call in the product and hands the user back a generic template unrelated to their requirement.
The two-round tradeoff belongs here too: a second round that has the error message in hand and still gets it wrong is usually not the "one more look and it'll click" kind of error,
and every extra round costs the user another full Agent execution of waiting.

Three things go with it: **no substitution** (switching Agents loses the previous artifact, and the whole value of a correction round is "fix the last version"),
**one independent Run record per round** (merge them into one and "why did round one fail" gets overwritten by round two — which is the only place anyone can ever see
afterward that this Agent keeps botching enums), and **cost accrues per round** (the discarded round was paid for all the same).

"Invalid output" is the only class worth retrying. No Agent could be picked, the runtime refused it, it timed out, it never wrote an artifact file at all —
the same Agent run again produces the same result, and retrying those only doubles the user's wait.

The author can no longer be changed once a requirement is confirmed or rejected (`409 INVALID_TRANSITION`): in those two states the analysis entrance is closed anyway,
and leaving an editable dropdown behind only suggests "change it and hit Re-analyze."

**Re-analysis does not overwrite fields a human edited** (the concurrency requirement in §9): the criterion is `source: 'human'` in the field's provenance,
and the preserved fields are listed explicitly after the analysis — say nothing and the user concludes "the analysis missed these,"
when the truth is that the platform was protecting the sentences they wrote themselves. To have the AI rewrite one of them, clear it back to blank and analyze again.

### 5.5 Clarifying questions (product doc 8.2.4)

Four classes by impact, forced apart by color and by ordering:

| Class | Marker | Handling |
| --- | --- | --- |
| Must be confirmed by a human | 🔴 | Blocking: the confirm button stays grayed out until it is answered |
| Can be handled by a default rule | 🟡 | Accept the default in one click, or fill it in yourself |
| Can be recorded as an assumption and moved past | 🔵 | Automatically added to "Recorded assumptions"; editable |
| Can be resolved automatically from the knowledge base | 🟢 | Shown collapsed, with its source, for checking |

Every 🔴 question must carry:
- **the question itself**
- **the impact** (what happens if you don't answer, quantified in schedule or scope)
- **the Agent's leaning, plus its basis** (never ask without proposing)
- **shortcut options** (most questions should take one click, not typing)

**This is the most important design on the page**: if the clarifying questions make the user feel the AI is quizzing them, the product has failed. Every question should read as "it has already thought this through and just needs me to make the call."

### 5.6 Recorded assumptions

Maps to `Requirement.confirmed_assumptions`. These assumptions are passed on to the Project Agent and to every execution Agent downstream, so they have to be visible and editable.

When an assumption is later falsified — execution turns up a conflict — the system traces back to this page and generates a decision. This is also the "requirement conflict found" trigger for human involvement in product doc 8.8.4.

### 5.7 Bottom actions (the Human Gate, product doc 8.2.5)

| Action | Behavior |
| --- | --- |
| Confirm the requirement | Status → `approved`, triggers Project Agent planning, jumps to `04` |
| Approve with edits | Just "edit + confirm"; no separate button needed |
| Request re-analysis | The user adds detail and it runs again, with a cost estimate shown |
| Reject | Reason required; status → `rejected`; the submitter is notified |
| Hold | Status → `on_hold`; a reminder time can be set |
| Delegate the confirmation | Creates a Decision assigned to someone else, which you can track |

A short dialog before confirming spells out **what happens next**:

```
After you confirm, the Project Agent will:
· Break the work down and generate an execution plan (est. 2–4 min, ~$0.35)
· Once the plan exists, you or Zhang Wei must approve it before execution starts

☑ Notify me when the plan is ready

              [Back to edit]  [Confirm]
```

---

## 6. Core Interaction Flows

**Main flow**

```
Enter the original text → [Start analysis] (20–60s, showing what the Agent is doing)
                        → structured result + clarifying questions
                        → answer the 3 required questions (mostly one click each)
                        → completeness 72 → 91
                        → [Confirm the requirement] → 04 Plan Approval
```

**Conversational intake**

```
User:  "I want to speed up order lookups"
Agent: "Got it. Where does the slowness show up most? (1) list page (2) search (3) detail page"
User:  "Search"
Agent: "Understood. Two more things and we can start: what response time do you expect? Which search filters do you need?"
       ↑ the structured panel on the right grows in step
```

**Requirements imported from outside**

```
Synced in from Jira → an "awaiting confirmation" badge appears in the requirement list → open this page
→ the original-input region shows the Jira source text and the field mapping
→ conflicts with local edits are handled per the Source of Truth setting (see 14 Integration Settings)
```

---

## 7. State Design

| State | Handling |
| --- | --- |
| AI analyzing | The right-hand region fills field by field as it streams, showing the current step ("Searching the project knowledge base…", "Generating acceptance criteria…"); cancelable |
| Analysis failed | Keep the original text, show the reason plus a retry; never clear what the user typed |
| Analysis timed out (> 3 min) | "This analysis is taking unusually long" + [Keep waiting] [Cancel and fill it in by hand] |
| Confirmed (read-only) | Every field read-only, the header shows who confirmed it and when, with [Reopen] (requires `pm`, recorded as an Event) |
| Confirmed by someone else | Live notice — "Li Na confirmed this requirement 2 minutes ago" — and the page switches to read-only |
| Long document being parsed | Parsing progress shown next to the attachment; does not block typing in the main text box |

---

## 8. Permissions

| Action | Requirement |
| --- | --- |
| Enter a requirement | Project member |
| Edit structured fields | Project member (before confirmation) |
| Answer clarifying questions | Project member |
| **Confirm the requirement** | `sponsor` / `pm` (the Human Gate owner; product doc 8.7.5, business scope → product owner) |
| Reject | `sponsor` / `pm` |
| Reopen a confirmed requirement | `pm` or above, audited |

---

## 9. Data Dependencies

**Domain objects**: `Requirement` (all fields), `Event`, `Artifact` (attachments), Knowledge (cited context), `Decision` (when the confirmation is delegated)

**Endpoints**

```
POST /api/projects/{id}/requirements                    create a draft
PUT  /api/requirements/{id}/author-agent                { agentId }, null = back to the project binding
POST /api/requirements/{id}/analyze                     trigger structuring, streamed back over SSE
     → event: field_updated { field, value, sources[] }
     → event: question_added { id, level, question, impact, suggestion, options[] }
     → event: score_updated { total, dimensions{} }
POST /api/requirements/{id}/questions/{qid}/answer      { answer, accept_default? }
PATCH /api/requirements/{id}                            manual field edits
POST /api/requirements/{id}/approve                     { note? } → triggers Plan generation
POST /api/requirements/{id}/reject                      { reason } (required)
POST /api/requirements/{id}/delegate                    { assignee_id, due_at }
```

**Concurrency**: fields a human edited are not overwritten by re-analysis (implemented; the criterion is the field provenance `source: 'human'`,
and the analysis result reports back which fields it preserved). Field-level optimistic locking and "show the difference on conflict and let the user choose" are not built yet —
today the whole form submits at once, so when several people edit the same requirement the last write wins.

---

## 10. Instrumentation and Metrics

| Event | What it tells us |
| --- | --- |
| `requirement_input_method{method}` | The real distribution across the four intake methods |
| `analysis_duration` / `analysis_cost` | Performance and cost baselines |
| `question_answered{level, used_suggestion}` | **Adoption rate of the Agent's leaning — the core measure of clarification quality** |
| `field_edited{field}` | Which fields the AI consistently writes badly |
| `completeness_at_approval` | The score at which users actually let things through |
| `requirement_reopened` | Requirement rework rate (should stay as low as possible) |
| `time_to_approve` | Time from intake to confirmation (target < 5 minutes) |

**Success criteria for this page**: adoption of the Agent's leaning > 60%; rework caused by a misunderstood requirement after confirmation < 10%.

---

## 11. Edge Cases

| Situation | Handling |
| --- | --- |
| Input too short (< 20 characters) | Does not block analysis, but warns "short description; the AI will ask more questions" |
| Input too long (> 20k characters) | Warns that it will be processed in segments, may take a while, and gives a cost estimate |
| Unsupported attachment format | List the supported formats plainly; unsupported files can still be kept as attachments, they just do not feed the analysis |
| More than 10 clarifying questions | Collapse to "N must-answer" shown first, the rest folded away — do not scare people off |
| The user skips every clarification and confirms | Allowed (with the low-completeness warning); unanswered questions become "recorded assumptions" tagged `unconfirmed` |
| The AI's analysis is clearly off the rails | [Report as inaccurate] collects the case; offer "clear and start over" rather than making the user fix it field by field |
| The source requirement changes in Jira after confirmation | Generate a "requirement changed" decision; never silently overwrite confirmed content |
| Several people editing the same requirement | Field-level locking plus avatars of whoever else is in the room |

---

## 12. Open Questions

1. The weights of the six completeness dimensions still need to be defined; does every project type use the same set? "Technical context" should not weigh the same for an engineering requirement as for a research one.
2. Should 🔵 "record the assumption and move on" questions be read back to the user again at the planning stage? Leaning toward listing every unconfirmed assumption at the top of `04 Plan Approval`.
3. How is data kept in sync between conversation mode and form mode over a long multi-turn conversation without losing anything? Needs a technical design.
4. Who owns requirement confirmation: product doc 8.7.5 says business-scope changes belong to the product owner, but a small team may have no dedicated product person. Should the project creator be allowed to configure who owns this Gate?
