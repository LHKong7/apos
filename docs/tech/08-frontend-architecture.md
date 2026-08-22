# 08 Frontend architecture

*[中文版本 / Chinese version](08-frontend-architecture.zh.md)*

React 18 + TypeScript + Vite. Maps onto the 14 [page documents](../product/pages/README.md).

---

## 1. What makes this frontend hard

This is not an ordinary CRUD admin panel. Three properties drive every architectural tradeoff:

| Property | Challenge |
| --- | --- |
| **State is driven by system events** | The UI has to update live without interrupting whatever the user is doing. The traditional "submit, then refresh" model does not apply |
| **Extremely high information density** | A board card or a decision card has to convey status, executor, cost, deadline, and Gate state in a very small area |
| **Human/Agent duality has to be visible** | Every place that shows an executor must distinguish a person from an Agent — this is the product's core visual differentiator |

The first one is the hardest. A user may be editing a field at the exact moment an Agent updates the same object. Get this wrong and you lose the user's input, which is the least forgivable class of bug there is.

---

## 2. Technology choices

| Purpose | Choice | Why |
| --- | --- | --- |
| Build | Vite | — |
| Routing | React Router v6 | Nested routes match the tab structure inside a project |
| Server state | TanStack Query v5 | Caching, invalidation, optimistic updates; SSE integration in §4 |
| Client state | Zustand | UI state: filters, panel open/closed, keyboard mode |
| Styling | Tailwind CSS | Dense interfaces need fine-grained control over spacing |
| Unstyled primitives | Radix UI | Accessibility for dialogs, dropdowns, tooltips |
| Forms | React Hook Form + Zod | Shares schemas with the backend |
| Virtual scrolling | TanStack Virtual | Board columns, Run event streams (potentially thousands of rows) |
| Graphs | React Flow + dagre | Execution Graph |
| Charts | Recharts | Analytics |
| Types | `@apos/contracts` | ★ Shared with the backend, not generated |

---

## 3. Directory layout

```
apps/web/src/
├── pages/                       one directory per page document (14 of them)
│   ├── ProjectList/
│   ├── ProjectOverview/
│   ├── RequirementIntake/
│   ├── PlanApproval/
│   ├── Board/
│   ├── WorkItemDetail/
│   ├── ExecutionGraph/
│   ├── AgentWorkspace/
│   ├── RunDetail/
│   ├── DecisionCenter/
│   ├── DecisionDetail/
│   ├── Analytics/
│   ├── PolicyConfig/
│   └── IntegrationSettings/
├── features/                    domain features reused across pages
│   ├── work-item/               cards, status badges, client-side state machine checks
│   ├── decision/                decision cards, action bar, constraint editor
│   ├── agent/                   Agent chip, status dot, queue
│   ├── run/                     execution timeline, cost breakdown
│   ├── policy/                  condition editor, natural-language explanation, simulation results
│   └── event/                   Event Timeline (shared by three pages)
├── components/                  generic components (page docs README §5)
│   ├── HumanGateBadge.tsx
│   ├── AssigneeChip.tsx         ★ the one and only implementation of the human/Agent distinction
│   ├── RiskBadge.tsx
│   ├── AutonomyBadge.tsx
│   ├── UpdateSourceTag.tsx
│   ├── CostMeter.tsx
│   ├── BlockedDuration.tsx
│   └── states/                  Loading / Empty / Error / NoPermission
├── lib/
│   ├── api/                     typed client
│   ├── sse/                     ★ SSE connection management and cache sync (§4)
│   ├── query/                   TanStack Query config and key factory
│   ├── permissions/             frontend permission checks (same rules as the backend)
│   └── format/                  cost, duration, relative time
└── stores/                      Zustand
```

**Where `components/` ends and `features/` begins**: `components/` holds the atomic components defined in the page docs' global conventions, with no business logic; `features/` contains data fetching and business rules.

---

## 4. Live data: fusing SSE with the Query cache

This is the single most important piece of frontend design here.

### 4.1 One connection, many channels

```typescript
// lib/sse/connection.ts
class SSEConnection {
  private es: EventSource | null = null;
  private channels = new Set<string>();
  private lastEventId: string | null = null;
  private handlers = new Map<string, Set<Handler>>();

  subscribe(channel: string, handler: Handler): Unsubscribe {
    this.channels.add(channel);
    this.addHandler(channel, handler);
    this.reconnectIfChannelsChanged();      // 100ms debounce, so fast page switching doesn't thrash the connection
    return () => this.unsubscribe(channel, handler);
  }

  private connect() {
    const url = `/api/v1/stream?channels=${[...this.channels].join(',')}`;
    this.es = new EventSource(url);

    this.es.onmessage = (e) => {
      this.lastEventId = e.lastEventId;
      const event = JSON.parse(e.data);
      applyEventToCache(event);              // §4.2
      this.dispatch(event);
    };

    this.es.onerror = () => this.scheduleReconnect();   // exponential backoff
  }
}
```

**Exactly one connection is kept open**: browsers cap same-origin SSE connections (6 under HTTP/1.1). Many components subscribe to different channels, all sharing one connection.

### 4.2 Event → cache patch

```typescript
// lib/sse/apply-event.ts
export function applyEventToCache(event: DomainEvent) {
  const qc = queryClient;

  switch (event.type) {
    case 'work_item.status_changed': {
      const { workItemId, from, to } = event.payload;

      // 1. update the detail cache
      qc.setQueryData(qk.workItem(workItemId), (old) =>
        old ? { ...old, status: to, stage: stageOf(to) } : old);

      // 2. update the board: remove from the old column, add to the new one
      qc.setQueryData(qk.board(event.projectId), (old) =>
        old ? moveItemBetweenStages(old, workItemId, from, to) : old);

      // 3. invalidate derived data (don't patch it — let it refetch)
      qc.invalidateQueries({ queryKey: qk.projectOverview(event.projectId) });
      break;
    }

    case 'agent_run.progress': {
      // high-frequency event: patch locally, never invalidate (that would fire a storm of requests)
      qc.setQueryData(qk.run(event.payload.runId), (old) =>
        old ? { ...old, ...pick(event.payload, ['step', 'cost', 'progressNote']) } : old);
      break;
    }

    case 'decision.created':
    case 'decision.resolved':
      qc.invalidateQueries({ queryKey: qk.decisions() });
      qc.invalidateQueries({ queryKey: qk.actionItems() });   // global badge count
      break;
  }
}
```

**The rules**:

| Event frequency | Handling |
| --- | --- |
| High frequency (progress, cost, run events) | `setQueryData` local patch, no request |
| Low frequency but wide-reaching (status changes) | Patch the primary cache + invalidate derived caches |
| Structural change (task created/deleted) | Invalidate directly |

### 4.3 Protecting what the user is editing

A hard requirement from page docs README §5.10: **a form region the user is editing must never be overwritten by a remote update**.

```typescript
// stores/editing.ts —— global registry of fields currently being edited
export const useEditingStore = create<EditingState>((set, get) => ({
  editing: new Map<string, Set<string>>(),   // entityId → Set<field>
  startEdit: (entityId, field) => { /* ... */ },
  endEdit: (entityId, field) => { /* ... */ },
  isEditing: (entityId, field) => get().editing.get(entityId)?.has(field) ?? false,
}));

// when applying a patch, skip the fields being edited
function patchEntity<T>(entityId: string, old: T, incoming: Partial<T>): T {
  const store = useEditingStore.getState();
  const safe = Object.fromEntries(
    Object.entries(incoming).filter(([field]) => !store.isEditing(entityId, field))
  );
  const conflicted = Object.keys(incoming).filter(f => store.isEditing(entityId, f));

  if (conflicted.length) {
    // don't discard silently: tell the user something changed
    notifyConflict(entityId, conflicted, incoming);
    // → banner at the top: 「该内容已被 Agent 更新，[查看差异] [使用最新]」
    //   ("An Agent has updated this content — [view diff] [use latest]")
  }
  return { ...old, ...safe };
}
```

**Flag the conflict, never drop it silently**: the user needs to know their edit is now stale, otherwise they hit a 409 on save with no idea why.

### 4.4 Unsaved changes must not vanish silently

§4.3 handles "don't let a remote update overwrite what I'm typing." This one handles the other end: **I finished typing but never hit save — don't let it evaporate**.

Two lines of defense, both required (`lib/useUnsavedGuard.ts`):

1. `beforeunload` — catches reloads and tab closes;
2. `confirmClose()` — catches closing the dialog. **Closing a dialog does not fire `beforeunload`**, and that is the path people actually take.

The test has to be "differs from the initial value," not "this form has been touched." A dialog that asks for confirmation on every close trains users to click through it reflexively by the third time — which disables exactly the defense you just built.

### 4.5 Animation and scrolling

The constraints from page doc 05 §5.5 are implemented here:

```typescript
// card movement animation
const MOVE_STAGGER_MS = 80;      // stagger multiple cards

function useCardMoveQueue() {
  const queue = useRef<MoveEvent[]>([]);
  // user is dragging or has the detail open → defer that card's animation until the interaction ends
  // user is not scrolled to the top → don't auto-scroll; show a "↑ 2 cards moved" bar instead
}
```

**No auto-scrolling** is a requirement that shows up over and over (board, Run event stream, decision list). One shared implementation:

```typescript
function useFollowTail(containerRef) {
  const [pinned, setPinned] = useState(true);   // stuck to the bottom?
  // user scrolls away from the bottom → pinned = false, show "↓ N new items"
  // user scrolls back to the bottom → pinned = true, resume following
}
```

---

## 4.6 Icons are for the eyes; ship the meaning separately

Emoji are everywhere in this UI (🔍 调研 / 🔧 任务 / ⛔ 阻塞 / ⚡ 待决策 — research / task / blocked / awaiting decision). They make excellent scanning anchors, but **only for people who can see color and shape**:

- A screen reader announces the official Unicode name — "🔍" is "magnifying glass tilted left," which has nothing to do with "research task";
- In grayscale print, on a low-resolution display, or in high-contrast mode, everything encoded by color alone simply disappears.

So the convention is: **every emoji gets `aria-hidden` and is immediately followed by `sr-only` text**, or sits next to a visible text label that was already there.

```tsx
<span aria-hidden title={typeLabel(card.type)}>{typeIcon(card.type)}</span>
<span className="sr-only">{typeLabel(card.type)}</span>
```

The same state is double-encoded as **color + shape**, never color alone. Acceptance criteria render as `✓ / ✕ / ○` (outline marks of equal stroke weight) rather than `✅ / ❌ / ⬜` (three colored glyphs from three different sources, with mismatched weights and baselines — side by side they don't look like one design language). Additions and deletions in a plan diff are **tinted blocks**, not bare `+` / `−` — at body text size those two characters differ by one vertical stroke.

## 4.7 A disabled button has to say why

A gray button with no explanation asks the user to guess. Worse, in most browsers a `disabled` element **does not respond to hover, so the native `title` never appears** — which means the explanation cannot live on the button itself.

What we do instead: put the reason **outside** the button, rendered alongside the disabling condition (always visible, no hover required), and wire it up with `aria-describedby` so a screen reader user hears "unavailable — write something first" rather than just "unavailable."

A button's **visibility** has to track real state too: a button that is guaranteed to error when clicked is worse than no button at all — the user will assume they did something wrong. The test comes from the state machine, not from how the card looks (`blockedSince` is a **marker**; it can hang on a card whose status is still `ready`. Status is the fact, the marker is only an annotation).

## 5. Expressing permissions in the frontend

The page docs uniformly call for **read-only degradation** rather than a full-page 403.

```typescript
// lib/permissions/use-can.ts
export function useCan(action: Action, resource?: Resource): PermissionResult {
  const { user, projectRole } = useAuth();
  const result = evaluatePermission(user, projectRole, action, resource);
  return result;   // { allowed: boolean, missingRole?: string }
}

// usage
function ApproveButton({ plan }) {
  const can = useCan('plan.approve', plan);
  return (
    <Tooltip content={can.allowed ? undefined : `需要 ${roleLabel(can.missingRole)} 角色`}>
      <Button disabled={!can.allowed}>批准并开始执行</Button>
    </Tooltip>
  );
}
```

**The frontend check is not a security boundary** — the backend must verify independently. The point of the frontend check is experience: tell the user immediately what they cannot do, instead of failing after the click.

**One source of rules**: the decision logic lives in `packages/domain/src/permissions` and is shared by both sides. That avoids the two sets of rules drifting apart into "the button is clickable but the request is rejected."

---

## 6. Performance

### 6.1 Budgets for the critical paths

| Page | Target | How |
| --- | --- | --- |
| Board first paint (200 items) | < 1.5s | 20 cards per column up front + virtual scrolling; Done column collapsed |
| Run detail (3000 events) | < 1s | Virtual scrolling + concise mode by default (load milestone events only) |
| Execution Graph (200 nodes) | < 2s | Layout precomputed server-side; Canvas rendering above 100 nodes |
| Decision Center | < 800ms | List items carry everything they need — no second request |

### 6.2 Where virtual scrolling is used

```typescript
// board column
const virtualizer = useVirtualizer({
  count: items.length,
  getScrollElement: () => columnRef.current,
  estimateSize: () => 140,        // card heights are fairly uniform (a design constraint from page doc 05 §5.3)
  overscan: 5,
});
```

**Uniform card height** is a design constraint and simultaneously a performance precondition for virtual scrolling — large height variance makes the scroll position jump around.

### 6.3 Switching renderers in the Execution Graph

```typescript
const renderer = nodeCount > 100 ? 'canvas' : 'svg';
```

SVG is easy to make interactive (hover, click) but stutters past 100 nodes. Canvas requires implementing hit testing yourself, but performs far better. The switching threshold needs to be calibrated by measurement.

> Where we actually are: only the SVG path is implemented. Above 100 nodes the page shows a banner suggesting "critical path" highlighting to focus on the main chain; when a graph that large actually shows up, we'll swap renderers based on measurements (deliberately not built — §11).

### 6.4 Code splitting

```typescript
const ExecutionGraph = lazy(() => import('./pages/ExecutionGraph'));
const Analytics = lazy(() => import('./pages/Analytics'));
const PolicyConfig = lazy(() => import('./pages/PolicyConfig'));
```

React Flow and Recharts are heavy, so they load only with their pages. The core path (project list → board → Work Item) is not split, so navigation there is instant.

---

## 6.5 Design tokens and theming

### Colors are semantic slots, not hex codes

The UI has 1500+ occurrences of `text-slate-500` / `bg-white` / `border-slate-200` scattered through it. Restyling that interface by editing each one is a diff thousands of lines long — and from then on every new page depends on someone remembering to match. It drifts into several different grays eventually.

So the whole palette is **redirected to CSS variables** in `tailwind.config.ts` (the tokens themselves live in `src/index.css`):

```ts
const token = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;
colors: { slate: ramp('slate'), amber: ramp('amber'), white: token('white'), ... }
```

A class name now means "secondary text" instead of "#64748b," and "the raised card surface" instead of "pure white." Swap the theme and the whole app follows, with not one character changed in the pages already written.

| Slot | Meaning | Dark value | Light value |
| --- | --- | --- | --- |
| `slate-50` | Page background | `#070b14` | `#f5f7fb` |
| `white` | Card surface (one layer above the page) | `#101829` | `#ffffff` |
| `slate-100` | Slightly raised: chips, hover surfaces | `#111a2b` | `#eceff5` |
| `slate-200` | Hairline borders, skeleton blocks, progress troughs | `#1e2a41` | `#dfe4ed` |
| `slate-300` | Stronger borders, input borders | `#3e5274` | `#c7cfdd` |
| `slate-400/500` | De-emphasized / secondary text | `#7488a5` / `#8b9cb8` | `#8d99ad` / `#64748b` |
| `slate-900` | Primary text / inverted button background | `#eef3fa` | `#0d1626` |

Two hard constraints:

1. **Tokens store RGB channels, not `#hex`.** Tailwind's opacity modifiers (`bg-gate/15`, `bg-white/70`) only compute if the value goes through `rgb(var(--x) / <alpha-value>)`. Store hex and those classes **fail silently**.
2. **The neutral ramp inverts wholesale in dark mode** (50 darkest → 900 lightest). That makes `text-slate-900` (headings) naturally near-white and `bg-slate-50` (page background) naturally near-black, keeping every existing semantic intact. The cost is that a primary action button like `bg-slate-900 text-white` becomes "near-white background + dark text" in dark mode — that is deliberate, not a bug.

### Three places where the inversion does not apply

- **Scrims**: drawers and overlays use `bg-scrim/[var(--scrim-alpha)]`, not `bg-slate-900/20`. After inversion slate-900 is near-white, so copying that pattern lays a haze over the content instead of dimming it.
- **SVG `fill` / `stroke`**: those are attributes, not classes — Tailwind's ramps cannot reach them. The execution graph and the charts get their own `--graph-*` / `--chart-*` tokens (`features/graph/shapes.tsx`, `features/analytics/palette.ts`); otherwise the whole diagram stays behind when the theme changes.
- **Chart data colors**: the blues in `SERIES` / `ORDINAL` **do not follow the theme**. They were validated on a white background for lightness banding, chroma, and color-blind ΔE, and they still read on a dark background (the lightest, `#86b6ef`, has 8.4:1 contrast). Inverting them would throw that validation away.

### Where the theme actually lands

Dark is the default; light is an explicit choice (`stores/theme.ts`, writing `<html data-theme>` + localStorage). **The assignment that actually matters happens in the inline script in `index.html`** — React mounting waits for the bundle to download and parse, and until then `<html>` carries no `data-theme`, so anyone who picked light mode gets a flash of dark on every reload.

---

## 6.6 There is exactly one project navigation

A project has twelve pages. Before this revision, **only the overview page had navigation** — the execution graph, Analytics, Policy, Agent team, requirements, decision center, and settings pages each had nothing but an `<h1>`. Getting from the execution graph to Analytics meant hitting the browser back button. The four jump buttons on the board toolbar were a patch over that hole, applied in the one place where fifteen controls were already crammed into a single row.

Now navigation has one implementation: `components/ProjectSidebar.tsx`, which appears whenever the route matches `/projects/:projectId`. The twelve-tab horizontal nav on the overview page and the four cross-page links on the board toolbar were deleted along with it — they were duplicate implementations of the same navigation.

**When you add a project page, edit `navGroups()` in that one file. Do not add your own jump links inside the page.**

The three groups are not a layout decision: "Work" is where you live every day, "Insights" is what you look back at, and "Configuration" is what you set up once and never touch again. Mixed together, a board you click twenty times a day looks identical to a role definition you click twice a year.

### The board page collapses the sidebar to an icon rail by default

This was forced by one hard number: six columns without horizontal scrolling need **1216px** (`6 × 12rem + 5 × 8px gap + 24px padding`), and with the 56px icon rail that's **1272px**.

| Viewport | Sidebar | Visible board width | Actual column width | Six columns scroll? |
| --- | --- | --- | --- | --- |
| 1280 | Collapsed 56px | 1224px | 193px | No |
| 1366 | Collapsed 56px | 1310px | 208px | No |
| 1440 | Collapsed 56px | 1384px | 220px | No |
| 1440 | Expanded 224px | 1216px | — | Yes |

Column gaps were originally 12px with a 13rem floor (threshold 1332px). Adding the sidebar would have pushed the threshold to 1388px — every 1366 laptop would start scrolling horizontally. Shrinking to 8px / 12rem brings the threshold back down to 1272px, and costs nothing on wide screens: columns are `flex-1`, so the space saved on gaps goes to the columns themselves (at 1440, each column actually grows from 217px to 220px).

That is why `manual` in `stores/sidebar.ts` is **tri-state** (`true` / `false` / `null`) instead of a boolean: `null` means the user has expressed no preference, so the page decides (collapsed on the board, expanded elsewhere). With a boolean, entering the board would auto-collapse and write back `true`, and leaving the board would leave it collapsed — the user gets a sticky preference they never chose.

Once the user has clicked the collapse toggle, their choice wins over that rule, including "I want it expanded on the board." That makes the board scroll horizontally, but horizontal scrolling is a supported state (`.board-scroll`), whereas "navigation won't open on the page I spend the most time on" is not.

### Run detail: no project in the URL, so the sidebar goes and asks

You reach `/runs/:runId` by clicking "view logs" from the board. There is no projectId in the URL, but that run **belongs to** a project. Having the sidebar vanish here means "clicking a log throws you out of the project."

So the sidebar fetches the Run itself using runId (the same query key the Run detail page uses, so React Query collapses it into one request) and takes the project from `detail.project.id`. **Do not** change this to "the Run detail page writes projectId into some global state" — that approach depends on every page remembering to set it and to clear it, and one miss means the sidebar points at the previous project.

While the data is in flight, render an equal-width empty placeholder: inserting the sidebar once the data arrives shifts the entire content area sideways by 224px at that moment, and the log the user is reading jumps away.

Routes with genuinely no project context get no sidebar. That is correct, not a gap:
- `/` (project list), `/decisions` (the **cross-project** decision inbox, reached from the top-bar badge)
- `/agents/:agentId` (this standalone route is only used when there is no projectId — see `pages/Agents/index.tsx`)

---

## 7. Implementation notes for the key components

### 7.1 AssigneeChip (human vs. Agent)

The product's most important visual distinction, so there must be exactly one implementation:

```tsx
export function AssigneeChip({ actor, size = 'md' }: Props) {
  if (actor.type === 'human') {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Avatar src={actor.avatarUrl} shape="circle" size={size} />
        <span>{actor.name}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-dashed px-1.5">
      <AgentIcon shape="square" size={size} />
      <span className="font-mono text-sm">{actor.name}</span>
      <StatusDot state={actor.state} />   {/* idle / running (pulsing) / blocked / failed */}
    </span>
  );
}
```

The distinction is carried three ways — **shape + border + typeface** — not by color alone (color-vision accessibility).

### 7.2 Event Timeline (shared by three pages)

Work Item detail, Run detail, and decision detail all use it. The differences are props:

```tsx
<EventTimeline
  source={{ kind: 'work_item', id }}
  defaultLevel="milestone"          // Run detail uses 'detail'
  groupConsecutive                  // collapse consecutive tool calls of the same kind
  followTail={isRunning}
  renderDetail={renderRunEventDetail}
/>
```

**Collapsing consecutive same-kind events** (`read_file × 6` folded into one line) is the concise-mode requirement from page doc 09 §5.3.

### 7.3 Policy condition editor

The MVP only ships template-based configuration ([05 Policy Engine](05-policy-engine.md) §10), but the natural-language explanation component does get built:

```tsx
function PolicyExplanation({ condition, action }: Props) {
  // ★ generated by a backend endpoint — don't reimplement the template logic in the frontend
  const { data } = useQuery(qk.policyExplain(condition, action), ...);
  return <div className="rounded bg-muted p-3 text-sm">{data?.text}</div>;
}
```

**The explanation is generated on the backend**: reimplement the template logic in the frontend and the two will drift. The explanation and the actual execution logic have to match exactly.

---

## 8. Unified handling of states and errors

```tsx
// components/states/QueryBoundary.tsx
export function QueryBoundary({ query, empty, children }: Props) {
  if (query.isLoading) return <Skeleton layout={empty.skeletonLayout} />;
  if (query.isError)   return <ErrorState error={query.error} onRetry={query.refetch} />;
  if (isEmpty(query.data)) return <EmptyState {...empty} />;   // must carry a primary action
  return children(query.data);
}
```

Page docs README §5.9 requires every empty state to carry a primary action button — no illustration-only empty states. `EmptyState`'s props enforce `action`:

```typescript
interface EmptyStateProps {
  icon: ReactNode;
  message: string;
  action: { label: string; onClick: () => void };   // required, not optional
}
```

Enforcing a design convention through the type system is more reliable than writing it in a document and hoping people remember.

---

## 9. Testing

| Layer | What | Tools |
| --- | --- | --- |
| Unit | Formatting, permission checks, client-side state machine validation | Vitest |
| Component | Snapshot each state of the generic components | Testing Library |
| Integration | Correctness of SSE event → cache update | Vitest + MSW |
| Integration | Edit protection: remote updates don't overwrite user input | Testing Library |
| E2E | The three core paths | Playwright |

**The three E2E paths**:

1. Requirement intake → clarification → confirmation → plan approval → tasks appear on the board
2. Handle a decision in the Decision Center → the board card's status changes
3. Agent fails → Work Item detail → add context and retry → success

**The SSE integration tests matter most**: this is the part most likely to break and hardest to verify by hand. Simulate the event stream with MSW and assert on both cache state and rendered output.

---

## 10. Open questions

1. **Automatic card movement animations may become distracting with many cards.** Page doc 05 §12 proposes a "quiet mode" toggle; we need to decide whether it ships in the MVP. Leaning yes — it's cheap.
2. **The Canvas implementation of the Execution Graph is a real chunk of work** (hit testing, text rendering, zoom). Should the MVP support SVG only with a 100-node cap and prompt "too many tasks, please filter" beyond that? Leaning yes.
3. **Scope of mobile support**: handling decisions is the most valuable mobile scenario (approve from anywhere). Should the MVP ship a mobile-optimized Decision Center? Leaning toward a responsive Decision Center and detail page, with the remaining pages desktop-first.
4. **Offline and poor connectivity**: when SSE drops, the page shows cached data plus a disconnection notice. Do we need stronger offline capability (e.g. browsing already-loaded data offline)? Leaning no — this is a collaboration product.
5. **The size of `@apos/contracts`**: Zod schemas get bundled into the frontend. If the schemas grow large, we'll need tree-shaking, or export types only (`import type`) and keep runtime validation on the backend. Leaning toward using Zod in the frontend only for form validation and `import type` everywhere else.

---

## 11. What is actually built (apps/web)

The MVP only built what the board loop needs. This section records honestly what exists and what does not, so nobody mistakes the design for the current state.

### Implemented

| Module | Files | Notes |
| --- | --- | --- |
| Project list | `pages/ProjectList` | Entry point into a project; lands on the overview, not the board |
| Project overview | `pages/Overview` | Five metric cards (health / progress / delay risk / pending decisions / cost); health and delay expand into per-item detail; needs-you, blocked, Agents, members, activity feed |
| Requirement intake and clarification | `pages/Requirement` | Original text side by side, four clarification severities, completeness score, confirm → generate plan |
| Plan confirmation | `pages/Plan` | Five-part summary, ★ "what will happen automatically once you approve," task breakdown, request changes (generates a new version) |
| Smart board | `pages/Board` | Four views: Kanban / List / Agent / Pending decisions |
| Task detail drawer | `features/work-item/WorkItemDrawer` | Overview / execution records / timeline; includes retry with added context |
| Decision drawer | `features/decision/DecisionDrawer` | Approve (optionally with constraints) / reject; "cannot be delegated" is visible in the UI |
| Manual move | `features/work-item/ManualMoveDialog` | Reason + category required, recorded as an event |
| Run detail | `pages/RunDetail` + `features/run/` | Five tabs — execution stream / input / artifacts / cost / errors — concise⇄detailed toggle, runtime controls |
| Execution graph | `pages/Graph` + `features/graph/` | Three layouts (layered / stage swimlanes / executor swimlanes), critical path, upstream-downstream tracing, structural diagnostics |
| Analytics | `pages/Analytics` + `features/analytics/` | System insights + four tabs (Flow / Agent / HITL / cost), period-over-period comparison on by default |
| Policy configuration | `pages/Policies` | Summary + rule-set checkup + template-based creation + historical replay simulation + scenario testing |
| Decision Center | `pages/Decisions` | Queue sorted by overdue → time remaining → risk; approve/reject in place on the card; low-risk reversible decisions can be batch-approved; repeated decisions offer an inline entry point for writing a rule |
| Agent Workspace | `pages/Agents` | Roster (load / success rate / first-try success / human override / cost / owner) + detail (effectiveness, active queue, permission boundary, runtime capabilities, execution records, pause) |
| Plan version comparison | `pages/Plan/VersionDiff` | Automation-boundary changes come first, task additions/removals/edits listed field by field, totals and risk deltas; optionally compare against any historical version |
| Policy hit detail | `pages/Policies/HitsPanel` | Per-hit time / task / triggering context / verdict / outcome; gate rules are judged by approval rate, allow rules by whether they were later corrected by a human |
| Analytics quality tab | `pages/Analytics/QualityTab` | Test pass rate / coverage trend / post-release incidents; each item declares its data source and wiring status, and says so explicitly when not wired |
| Analytics cost-benefit tab | `pages/Analytics/BenefitTab` | Baselines supplied by the user; benefits and costs shown side by side; every step of the arithmetic laid out |
| Integration settings | `pages/Settings/Integrations` | Four integration categories on one page: code / project management / Agent runtime / collaboration notifications. Field-level Source of Truth + three presets, sync conflicts resolved in place, allowed and forbidden permissions side by side, notifications configured around "needs action" |
| Source of Truth configuration | `pages/Settings/SotPanel` | Pick who wins per field, with each cell explaining why that is the default; changes show the diff and consequences before you confirm |
| Sync conflicts | `pages/Settings/ConflictPanel` | Both sides' value / time / who changed it, the SoT hint, and "handle this kind automatically from now on" |
| Runtime capability report | `pages/Agents/CapabilityPanel` | Starts with what it cannot do (degraded behavior + user impact + severity), then what it supports. Shared by Agent detail and integration settings |
| SSE | `lib/sse/` | One connection, many channels, backoff reconnect, event → cache patch |
| Edit protection | `stores/editing` | Remote updates don't overwrite fields being edited; conflicts leave a trace |
| Generic components | `components/` | AssigneeChip, Human Gate badge, risk, cost, blocked duration, empty/error states |

### Deliberately not built

| Item | Why |
| --- | --- |
| HTTP adapters for Jira / Plane | The GitHub one works end to end (it really hits api.github.com), and Jira is the same shape: different baseUrl, different field mapping, different auth header. It's unwritten because it would introduce no new judgment calls, only another three hundred lines of isomorphic code — every one of which needs a real Jira instance to verify. When we do wire it up, copy `GitHubAdapter` |
| GitHub OAuth / App installation flow | The adapter works given a token; where the token comes from is a separate matter. An OAuth callback needs a public address and a registered App. For now we read from an environment variable, or go through whatever auth proxy the deployment already has |
| Bulk import (hundreds of Jira issues) | Page docs §11 require an async job + progress display + pre-import preview. Today `linkObject` creates mappings one at a time, which is enough; bulk import waits until a real provider is connected — building it now means building a progress bar with no data source |
| An "approve directly" button inside notifications | Page docs §12.3 lean toward deep links only in the MVP, and that's what we did. Confirming inside a third-party platform that "the person who clicked really is the accountable decision maker" works differently on every platform — and a direct-approve button that can't guarantee that turns a non-delegable decision into whoever-clicks-first, which is worse than not having it |
| Org-level integration management (`/admin/integrations`) | Same reason as org-level Policy management: it needs an org-level identity and permission model. The project page states plainly that data connectors must be configured by an org administrator |
| Enterprise data system connectors | Product doc 13 explicitly defers "full ERP / CRM integration." The page shows a placeholder explanation and a permission notice, with no clickable button |
| Conversational requirement intake / document upload / external import | None of the three is small (multi-turn state sync, document parsing, integration configuration), and what they solve is "intake is smoother," not "does the AI understand it correctly afterward." The latter is where the value of this path lies, so the effort goes to clarification and completeness first |
| Inline editing of requirement fields | `PATCH /requirements/:id` already works and marks the record "edited by a human," but the UI is still read-only. We'll build it when "the AI keeps getting one field wrong" actually happens |
| Reassigning / rescheduling / splitting tasks inside the plan | Same logic as dependency editing in the execution graph: a plan is a thing that gets approved, so casually editing it is a way around approval. Changes should go through "request changes" and let the Agent re-plan |
| A free-form Policy condition editor | Page docs 13 §12.1 recommend against it, and we followed. The person who actually needs to set an Agent's boundaries is the project lead; hand them a condition-expression editor and they will either not dare to configure anything or configure it wrong — both worse than "there are only six templates." The effort saved went into simulation |
| Policy advanced mode (expression editing) | Same as above. Build it when someone is genuinely blocked by the templates, rather than first building an IDE for a rule language nobody uses |
| Org-level Policy management page (`/admin/policies`) | It needs an org-level Policy orchestration UI, which doesn't exist yet. The project page states honestly: "org-level rules cannot be modified; contact an administrator for an exception" |
| Exception request flow for org rules | Page docs §12.3 lean toward not building it in the MVP; "contact an administrator" is the placeholder |
| Analytics export (PDF / CSV) | The page docs put it in the "prepare for the weekly meeting" flow, but sharing a link with the filter parameters (`?tab=&range=&compare=`) is more useful today than exporting a dead image. Revisit if it really has to go into a weekly report |
| Pre-aggregation tables for Analytics | Page docs §9 call for hourly/daily pre-aggregation. Event volume inside a project-level window is in the low thousands; computing live costs far less than maintaining an aggregation pipeline plus its lag and backfill. Build it when the data volume actually grows, rather than pretending to have built it now |
| Cross-project Analytics | Page docs §11 explicitly exclude it from the MVP — it belongs to org-level analysis |
| Canvas rendering for the execution graph (§6.3) | The demo data has 8 nodes; SVG doesn't break a sweat. Switch above 100 nodes — switching now means implementing hit testing yourself with no measurable payoff. Above 100 the page suggests focusing via "critical path" highlighting |
| Editing dependencies directly on the execution graph | Page doc 07 §12.1 leans read-only: dependencies are part of the plan, and changing one with a casual drag is a way around plan approval. The diagnostic's suggested action is "have the Agent re-plan," and the change still goes through approval |
| Timeline (Gantt) layout | Page doc 07 §12.4 leaves it open: tasks have no real scheduling fields, so any timeline we drew would be made up |
| Execution graph export | The graph is live; an export is a dead screenshot. If you really need to share it, a link (`?layout=&highlight=&focus=`) beats an image |
| Virtual scrolling | 20 cards per column on first paint; measurement says virtualization isn't needed. Bring in TanStack Virtual once a column exceeds 50 |
| Radix UI / React Hook Form | With only two dialogs and three form fields today, the benefit of a component library doesn't cover its bundle size |

### Three tradeoffs in Run detail

**Concise vs. detailed is not "which events come back," it's "how deep each event goes."**
We tried splitting on `run_events.level` for a while (concise returned only `milestone`), and concise mode collapsed to three lines — "started / produced / finished." Everything in between was gone, and answering "what did it actually do" is the entire reason this page exists. Concise mode now returns every event but without `payload`: what gets dropped is exactly the bulk (full reasoning text, raw tool arguments, context details), and exactly what the page docs asked to hide. That `level` field is there for SSE degradation and cheap table scans.

**Execution details are polled, not streamed over SSE.**
`run_events` outnumber domain events by two orders of magnitude; pushing them all through would blow up the very tables Analytics and auditing have to scan ([03 event model](03-event-model.md) §2). So there are two paths: SSE carries the low-frequency signal "this Run's status changed," and the high-frequency execution detail is pulled incrementally with an `after` cursor, polled only while the Run is active.

**Report missing capabilities honestly; never degrade quietly.**
Claude Code has no pause semantics, so clicking "pause" would actually terminate. Pause is resumable and termination is not, and that difference is decisive for the user. The backend returns `501 UNSUPPORTED_FEATURE` with the alternative action attached, and the UI shows it together with "here's what you can do next" instead of deciding for the user.

### Three tradeoffs in the execution graph

**Critical path, layout, and diagnostics are all computed server-side; the frontend only draws.**
The three interlock: root-cause attribution needs the critical path first, "false serialization" diagnostics repeatedly recompute the critical path with one edge removed, and swimlane layering needs a topological order. Pushing that to the frontend means moving the whole algorithm — cycle detection included — over there, while it still has to feed `metrics.primaryCause` in `GET /graph`. Today one request returns `nodes / edges / layout / metrics / diagnostics` together, the client never sits in a half-computed intermediate state, and `@apos/domain/graph` has exactly one implementation.

**Diagnostics should under-report rather than over-report.**
The first version of "false serial dependency" flagged 5 of 6 edges — structurally, any two back-to-back tasks look like they could run in parallel, so saying it says nothing. Now three conditions must all hold before we report: removing the edge genuinely shortens the critical path, the reduction is ≥ 1h, and the two ends have different executors; then we rank by payoff and keep the top 2. The diagnostics panel is the only "intelligence" on this page, and once it becomes noise, users start ignoring the genuinely important blocking alerts along with it.

**★ The graph shrank to a dot, and the problem wasn't in the graph.**
The execution graph once rendered at 17% zoom — the data was correct but it looked broken. The root cause was the app shell using `min-h-screen`: with an indeterminate height, `flex-1` has nothing to resolve against, the canvas container's `clientHeight` was near 0, and "fit to window" dutifully computed the minimum zoom. The fix was changing the shell to `h-screen overflow-hidden` (a determinate height, with `min-h-0` threaded all the way down) and using a ResizeObserver to fit only after the size settles — more reliable than guessing a delay with `setTimeout`. Unit tests will never catch this class of bug, so the smoke suite pins down "after fit-to-window, zoom ≥ 40%."

### Three tradeoffs on the entry path

**Confirming a requirement goes straight to the plan page, with no stop in between.**
The user has just made a judgment call; what they most need to see right now is what that judgment produced, not a list they get dumped back into and have to search. So the single "confirm" action chains two steps in the background — approve → generatePlan — and navigates on success.

**★ The human/Agent split on the plan page cannot be counted from `work_items.executorType`.**
Before approval nothing has been scheduled, so `executorType` is null across the board — counting from it always yields "🤖 0　👤 0" while the snapshot on the same page says "4 tasks will be executed automatically by Agents." Worse, that number appears in the approval dialog, at the exact moment the user is ceding execution authority. The correct source is the `humanGates` snapshot taken when the plan was generated: anything not in it is Agent work. For the same reason, task rows show "👤 needs a human / 🤖 Agent" rather than "unassigned" — the latter reads as "someone forgot to assign it," when the truth is "we'll pick when it's scheduled."

**"What will happen automatically once you approve" uses the snapshot, not a recomputation at display time.**
What the user approved was **that list, at that moment**. If a Policy changes later, tracing "what exactly did they approve" has to come from the snapshot — silently substituting the new rules amounts to editing something the user already signed. The page also shows the boundary recomputed under current rules for comparison, and says so plainly when the two disagree.

### Four tradeoffs in Analytics

**A metric's definition has to sit next to the metric, not in a document.**
Confronted with a number like "flow efficiency 55%," the user's first reaction is "how is that computed?" If they can't answer that, they won't act on it, and the page was pointless. So every metric card carries an ⓘ explaining the definition (effective work = a person or an Agent is actively moving it forward; queueing, blocked, and awaiting approval all count as waiting), and every system insight expands into "what makes you say that," which spells out the criterion itself — including the threshold value. Those thresholds come from the criteria table in page docs §5.1: they are experience values the product chose, not industry statistics (§12.2 lists "where do the baselines come from" as unresolved), which is all the more reason to let the user push back on them.

**When a data source isn't connected, say "not wired." Never show 0.**
On-time delivery rate returns `null` when there is no scheduling field, and the page reads "not wired · the plan has no scheduling field." Showing 0% sends someone off to assign blame when the truth is simply that nobody ever filled in a planned completion date — a number that causes the wrong action is much worse than no number. Budget burn and budget days remaining work the same way.

**★ The same word must mean the same thing on two different pages.**
"Blocked" has two expressions in this product: the `blocked` status, and the `blockedSince` marker (the card is still in ready but flagged "waiting on an external dependency") — and the board's "⛔ N blocked" counts the latter. Analytics originally counted only the former, so the board said "1 blocked" while Analytics said "blocked 0h." Both numbers were right, and together they were wrong. Now both sources count, with overlapping intervals counted once.

**It has to be able to produce a positive finding.**
This is not about flattering the user. An analysis page that only ever raises alarms stops getting clicked by the third visit — and an analysis page nobody looks at is worse than no analysis page, because it makes people believe someone is on top of this. So `findInsights` always makes a final attempt to find an improvement signal: if there's a prior period, compare against it; if not, pick something good enough out of the absolute values and say it.

### How the charts are done

No charting library. This page is all "labeled bars" and "one line"; Recharts' bundle size buys nothing, while the behaviors that actually matter — tooltips, direct labeling, table view — would all have to be rebuilt around its default styling. Four primitives live in `features/analytics/charts.tsx`: `BarChart`, `TrendChart`, `StatTile`, `NotWired`.

The palette is **validated**, not picked (`features/analytics/palette.ts` records the full results):

- Two series colors `#2a78d6` / `#eb6834` — color-blind ΔE 24.7, normal-vision ΔE 33.6, contrast ≥3:1, all passing
- An ordered ramp **fits only 5 steps** on a white background. A sixth means either two adjacent steps become indistinguishable or the lightest one dissolves into the background. That ceiling directly changed the design: a chart needing 6 categories (the cumulative flow diagram by stage) was therefore not drawn with a ramp, rather than forcing a sixth color — that is exactly how mistakes like "generate a 9th hue" begin.
- The chart chrome uses the app's own slate ramp, not the warm gray from the palette table. Two neutral systems on one page make the charts look pasted in.

A few rules we hold to consistently: bars get 4px rounded corners on the data end and square corners at the baseline; line width is 2px; gridlines are solid hairlines, never dashed; a value of 0 is drawn as 0 (leaving a sliver reads as "a little bit," which is a lie); status colors always come with an icon and text, so color is never the only cue; trend charts directly label only the peak and the latest value, leaving the rest to hover — and hover is never the only way to read a number, since every trend chart has a "view data" table.

### Four tradeoffs in Policy configuration

**That one summary line is the most important thing on the page.**
Nobody is going to read 12 rules and derive the boundary themselves; what they want is "N categories run automatically, M categories need a human." The hard part is the "it depends" category: the real dividing line is usually a **disjunction** ("production environment, or high risk"), and looking for a split along a single axis finds nothing, degrading into "12 of 20 situations need a human" — a statement that is correct and completely useless. What we do now is first find the single-valued conditions where satisfying it alone always requires a human, then check whether their union covers every human-required scenario; if it does, say it outright.

**The summary and the checkup share one scenario enumeration.**
"Will these two rules conflict?" is, in the general case, a constraint-solving problem. Actually writing a small solver is expensive and produces results that are hard to explain to the user — and what the user wants isn't "proven conflict-free," it's "show me the scenario that goes wrong." Running a finite set of real scenarios yields exactly the counterexample you can put on screen. The cost is stated plainly too: combinations the grid doesn't cover go undetected, so the page says "N problems detected" rather than "no problems," and says explicitly that this is sampling, not proof.

**★ The safety valve lives on the server, and the test is "will this auto-approve," not "did the grid get looser."**
Page docs §9 require loosening changes to carry a `simulation_id`. That id comes from the client, so forging a string bypasses the gate — and this gate is the single most important thing on the page (§10: "100% of loosening rule changes are validated by simulation"). Now the server runs the simulation itself at save time, and if it finds historical cases where the outcome disagrees with the human judgment, it returns 422 with those cases attached; the client has to explicitly `acknowledgeMismatches` to continue.
The test also changed from "did the scenario grid get looser" to "will this rule auto-approve." Those are not equivalent: a rule like "auto-approve medium/low-risk deployments" may loosen zero cells in the grid (those scenarios were already automatic) and still auto-approve 10 tasks that humans historically rejected — judged by the grid, it sails straight through.

**The rule list shows plain language only; condition expressions stay in the editor.**
A project lead can't read `risk == 'low' && cost < 10`, so they won't engage with it, and governance configuration ends up maintained by one engineer. The explanations are assembled from templates, **not from an LLM** — the explanation and the actual execution logic have to be strictly identical, and a model's drift would directly cause users to misconfigure rules. The template → condition/action mapping also has exactly one implementation, on the backend; recomputing it in the frontend gives you two, and sooner or later "the rule shown in the UI" and "the rule actually executed" stop being the same rule.

### Four tradeoffs across overview, Decision Center, Agents, and runtimes

**Every number on the overview expands into where it came from.** Health is not a "composite score"; it is a deduction system starting from 100, and every lost point is clickable. Delay probability is not a model output; it is seven hard-coded heuristics, and the page says so directly: "this is not a statistical model." A score whose origin can't be explained meets one of two fates — cited as fact, or dismissed as astrology, and neither is good. Only by knowing how it's computed does the user know when to ignore it.

**The Decision Center offers batch approve but not batch reject.** A rejection requires a reason, and every reason is different: batch rejection either forces the user to write one universally applicable platitude or lets them write nothing, and both destroy the "every override records a why" floor — which is the only data source for Analytics' "repeated decision → automatable" insight. Batch approval is also limited to decisions that are **reversible and not high risk**: the page docs want the queue cleared in 5 minutes, but with "merge a PR" and "delete production data" mixed in the same queue, a select-all checkbox is the incident itself. Batching saves clicks, not reading. The backend runs each item through the **same function** as single approval — non-delegability, state machine, and Policy are all still enforced (`decisions/batch-approve` → `approveDecisionById`).

**Agent detail is organized like a personnel file, not like a service config.** The order is "who is it → what is it doing → how well is it doing → what is it allowed to do → how do I intervene when something goes wrong." Put the permission table at the top and this page degenerates into a YAML editor. "Task queue" counts only unfinished work: `executorId` is permanent ownership, not a queue, and listing it directly would show "queue 200" for an Agent that has been working for six months and is in fact idle.

**Runtime capabilities lead with what it cannot do.** A panel with green checks on all 14 capability items and the gaps collapsed at the bottom has simply hidden the degradation again. Each gap is spelled out in three parts: the degraded behavior, the impact on the user, and the severity — "pause is not supported" gives the user nothing to decide with; "pause degrades to termination, losing in-flight progress" does. Before assigning a high-risk task, the user has the right to see that "this Agent's pause is actually a kill."

### Identity and caching

Identity uses a JWT obtained at login ([09-security §1.0](09-security.md#10-human-credentials-and-where-accounts-come-from)), stored in `localStorage['apos.token']`, with every request carrying `Authorization: Bearer`.

> This used to be an **identity switcher**: `/users` returned every user in the database, you picked one from a dropdown in the top right, and whoever you picked is who you were — that isn't identity, it's a self-service rename UI.

A whole class of backend responses is computed against the current identity (the decision inbox's "assigned to me," the overview's "needs you," a decision card's `canAct`), and those query keys don't include the user id. Therefore:

- **Invalidate the cache on login** (`invalidateQueries`), **clear it on logout** (`clear`). The two are not interchangeable: `invalidate` only marks data stale, and it is still in memory — so after the next person logs in, they see the previous person's pages until the refetch lands. A system that claims "decisions cannot be delegated" would be showing Alice's to-do list to Bob.
- **If the server rejects the token, sign out on the spot** (`/auth/me` returns 401 → `signOut`). Keeping a dead token around presents as "every page is throwing errors" rather than "please log in again."
- **Identity-dependent pages set `enabled: Boolean(userId)`** so they don't fire a request while identity is undetermined.
- **The SSE token goes in a query parameter** (`?access_token=`): EventSource cannot send custom headers. When logged out we **don't connect at all** — EventSource responds to a 401 by silently reconnecting, so the page shows no error and simply never receives a live update, which looks exactly like the backend not publishing events.

### Four tradeoffs in integrations

**Source of Truth is the only genuinely hard part of this layer, and the difficulty isn't lines of code.** If two systems can both edit the same field, one side's edit is inevitably going to be thrown away. Whether an integration can be trusted comes down to whether it can answer three questions: who wins, what happens to the other side, and where did the discarded edit go. An integration that can't answer them ends, after a while in use, with nobody trusting the data on either side. Hence: the decision (`resolveSync`) is separated from the write, and the decision returns nothing but an auditable `Resolution`; every field's default ownership carries a "why"; and changing the SoT shows the diff and the consequences before you confirm, then writes an event for the record.

**The status field defaults to "record the conflict," not to "write back."** Status is the one field that drives the process forward: quietly writing it back means the person in the external system watches the "Done" they just clicked bounce back to Review, with no explanation whatsoever. Any other field being overwritten is a data inconsistency; status being overwritten reads as "this system is fighting me."

**Only one unresolved conflict per field.** While a conflict is unresolved the sync baseline does not advance (which is correct), so every sync round re-detects the same conflict. Without deduplication, an integration that pulls every 5 minutes accumulates nearly three hundred identical records in a day, and after the user resolves the first one, two hundred ninety-nine remain — the feature works in tests and is unusable in production. The existing record does have to update its snapshot, because the external side may have changed again, and what we show the user has to be the current value.

**Allowed and forbidden permissions must appear side by side, and the forbidden list is hard-coded in the integration layer.** Same principle as 08 Agent Workspace: what the user most needs confirmed is often "this connection **cannot** merge my code." `NEVER_GRANTED_SCOPES` is not "off by default, flip it on if you want" — the integration layer simply does not offer that path, because if it offered it, it would eventually get turned on. When establishing a connection the server re-checks the allowed list the adapter returned, so even a buggy adapter is stopped. Separately, "can connect" and "can let it change my code" are two permission tiers: pm can connect, granting write requires tech_lead.

### A fake external system with a real sync engine

> This section was written before the GitHub transport layer landed. GitHub now goes through the real api.github.com (see the next section); the other providers still use in-process adapters. That validated this approach once: when the real transport layer was wired in, nothing downstream of it changed by a single line.

At the time, the HTTP transport for real providers didn't exist. The approach was not to draw a set of authorization buttons that do nothing when clicked, but instead to:

- Define the `IntegrationAdapter` interface (defined by what the sync engine needs, not by what each vendor's API looks like)
- Write an **in-process adapter** where pulling, writing back, source tagging, external deletion, and rate-limit errors all really happen
- Get everything downstream of it — SoT resolution, conflict creation and deduplication, loop suppression, permission checks, disconnection effects — running end to end and written into the smoke suite
- State honestly on the page that "this provider has no transport layer yet"

The in-process adapter's storage is pluggable: tests use a Map, and the dev environment injects a DB backend (`dev_external_objects`), because the seed script and the API are two separate processes — if the fake external system lived only inside the seed process, clicking "sync now" on the page would do nothing, and that is precisely the step that most needs to be seen working. Once real providers are connected, that table can simply be dropped.

★ `IntegrationAdapter` deliberately provides no `delete`. Deleting external objects is the other system's job; we only notice on pull that "it's gone" and tag it — an integration that can delete external objects has an irreversible cost when it goes wrong.

### Four tradeoffs in the real HTTP transport layer

**Contract tests stand up a real HTTP server; they don't mock fetch.** Mocking fetch tests "what I think I sent"; standing up a `node:http` server tests "what actually arrived on the wire" — a malformed URL, a missing header, the wrong body serialization, only the latter exposes those. The GitHub adapter additionally ran once against the **real api.github.com**: it immediately reported that this token was read-only, so `create_pr` landed in the forbidden list instead of being advertised as available. That's the class of correctness a mock can never test.

**Classifying the error matters more than the error message.** When a sync fails, the page has to answer "should I re-authorize, wait a while, or go find an administrator" — and "request failed 500" answers none of the three. The easiest trap: **GitHub also returns 403 for rate limiting**. Treat it as "insufficient permission" and the user goes off asking an admin for access, when the right move was to wait a few minutes.

**Back off on the other side's terms, but don't actually wait forever.** Prefer `Retry-After` / `x-ratelimit-reset`; computing a shorter interval yourself only means hitting the next rate limit sooner. But there's a trap here we **hit in practice**: one `testConnection` that didn't go through the proxy (and was therefore an anonymous request) ran into GitHub's rate limit, and "doing what the other side says" made it sleep in place for **50.8 minutes** before returning — the request never returned, the connection was never released, and the page spun forever. So we give up on any single backoff longer than 30s and report "how much longer" upward, letting the caller suspend that integration.

**"Couldn't probe it" and "it genuinely isn't there" must not look alike.** That rate-limit incident exposed something else too: when `grantedScopes` probing fails we fall back to read-only (understate rather than overstate, which is correct), but the page displayed that guess as fact — "✗ create PR" — and the user would go ask an administrator for permissions when the truth was that the probe had just been rate-limited. So the permission list carries a `probed` flag, and when it's a fallback the page says plainly that "this does not mean write access was actually withheld."

**An outbound proxy is not a sandbox special case; it's the norm for enterprise deployment.** Node's built-in fetch **does not honor `HTTPS_PROXY`**, so an instance installed inside a corporate network presents as "no integration can connect," while ops tries curl and it works fine — a discrepancy that is extremely hard to arrive at on your own.

### Notifications: decision and delivery are strictly separate

"Design around what needs action, rather than sending piles of Agent logs" becomes, in code, `decideNotification`: its job is not "how to send," it's **"whether to send."** A notification system that only knows how to send gets muted within two days — and once muted, the notifications that genuinely need action are gone too.

- **Do Not Disturb protects attention, not accountability.** High-risk decisions have to be able to break through — a request that says "at 2am, production data is about to be deleted, awaiting your approval" and gets silenced until 9am means this system no longer deserves to say "I'll come find you when I need you."
- **Escalation means "call more people," not "call someone else."** Notify only the top tier and a decision that has waited 24 hours reaches only the supervisor and stops reminding the accountable owner — who is precisely the only person who can handle it.
- **Subscribe to the event stream; don't sprinkle `notify()` calls through business code.** A decision can arise three ways — a Policy interception, an Agent asking for help, the state machine suspending — and adding one line at each site will eventually miss one, presenting as "this kind of decision never notifies anyone," which nobody notices.
- **Record every attempt, including suppressed ones.** The classic notification failure is silent: the webhook was revoked, the group was dissolved, Do Not Disturb ate it — and all the user feels is "this system never reminds me," with no thought of going to check deliveries. Only what you can look up can be fixed.
- ★ Slack and Feishu both express failure as **200 with the failure in the body**. Looking only at the HTTP status treats "that group no longer exists" as a successful delivery, and notifications quietly disappear into a black hole while the page looks perfectly fine — the worst possible failure mode.

### Quality and cost-benefit: keep "no data" distinguishable from "bad data"

**The quality tab was previously uncomputable not because the algorithm is hard, but because there was no data source.**
The `work_items.typeData.qualityGate` field has always existed and the Policy engine has always read it (the rule "no release until tests pass" depends on it), but nothing ever wrote it — so that rule could never fire. It is now backfilled from GitHub check-runs. If we can't fetch it, we don't write it: writing a default of `testsPassed: true` would turn that rule into one that always lets things through, which is far more dangerous than not having the rule at all.

Every metric reports its own `wired` and `source`, says explicitly when it isn't connected and how to connect it, and **never shows 0**: "0 incidents" and "no release went out this period" are completely different things.

**The reason cost-benefit wasn't built before is that the number is unfalsifiable**, not that it was technically out of reach.
So the fix isn't to skip it, it's to make the baseline an input the user supplies and to lay every conversion step out in the open: the baseline is what you entered, the hours are what the system recorded, and the conclusion is the arithmetic between the two. The conclusion always carries "at the $X/hour you entered" and "a different number gives a different conclusion" — a conclusion derived from your own assumptions can be interrogated, and therefore can be believed. The cost side has to be shown at the same time: counting "how much work the Agents did" without "how much human time went into cleaning up after them" produces a marketing number.

### Two tradeoffs in version comparison and hit detail

**The most important part of the diff isn't task additions and removals, it's the change in the automation boundary.**
What the user is approving is v2, and what they remember is v1 — without a diff, their only option is to reread the whole thing, and the realistic outcome of "reread the whole thing" is usually not reading it and approving anyway. So the diff is not a convenience feature; it's what makes the act of approving mean something again. And among all the changes, "v2 added an automatic production deployment that v1 didn't have" is the one class that **you will miss without a diff and that hurts when you miss it**: at worst, other changes mean the plan isn't what you expected; at worst, this class means you approved automation you didn't know about. So it's computed separately, listed first, and flagged prominently when it loosens. It also only counts tasks present in both versions — a new task never had a gate, and counting that as "a gate was removed" would report every task addition as a loosened boundary, and a warning that always cries wolf stops being read by the third time.

**Hit detail has to judge the two kinds of rules by two different standards.**
Gate rules (require_human_review and friends) are judged by approval rate: approving every time means the rule keeps asking a question whose answer is already known and can be relaxed; frequent rejections mean it's catching the right things, so leave it alone. Allow rules produce no decisions at all, so "approval rate" has nothing to attach to — the only place they can be falsified is **whether what they let through was later corrected by a human**. Judge both kinds with the same vocabulary and half of what you say is necessarily filler. We also draw no conclusion below 5 samples: three approvals out of three proves nothing.

### Where the logic has a single source

The frontend does not copy backend rules; both sides reference one implementation:

- **Drag-and-drop targets**: `evaluateDrop` → `manualTargetForStage` (`@apos/domain`); the backend PATCH uses `manualTriggerFor` — the same state machine derivation
- **Which column a card belongs to**: `stageFor` (`@apos/contracts`); the board API and the SSE patch use the same function
- **Integration permissions**: `canIntegration` / `denyReason` (`@apos/domain` permissions/integration).
  The frontend uses them to gray out buttons, the backend uses them to actually block requests — "clickable in the UI but refused by the server" (bad experience) and "allowed by the server but unclickable in the UI" (equivalent to not shipping it) are both unacceptable when the question is "who can grant an external system write access." Sharing one implementation does not mean trusting the frontend: every server write endpoint checks independently
- **The Run success status value**: `RUN_SUCCESS` (`@apos/contracts`). Getting the literal wrong presents as **silently computing 0** — cost-benefit had `'succeeded'` (the actual value is `'completed'`), so "hours carried by Agents" was permanently 0 and the page read "no convertible hours," which looks exactly like "nothing ran this period"
- **Chinese labels for Policy actions**: `ACTION_LABELS` / `actionLabel` (`@apos/contracts`), right next to the `Action` definition. `Record<ActionType, string>` fails to compile the moment a new action is added — any "mapping that must be updated when an enum grows" belongs next to the enum
- **Chinese labels for statuses and decision types**: `STATUS_LABELS` (`@apos/contracts`), `decisionLabel` (`@apos/domain`). The backend also has to assemble human-readable sentences (the "what happens if you don't act" line on a decision card), and we've already seen what two copies costs: the decision-type label table was written using the page docs' vocabulary while the runtime emitted a different set, so the UI kept printing bare keys like `high_risk_operation`

### Running it locally

```bash
bash scripts/dev-up.sh                                   # Postgres → migrations → API(:3000) → Vite(:5173), idempotent
DATABASE_URL=…/apos pnpm --filter @apos/api seed --reset # build demo data (through the real code path; only needed on an empty database)
pnpm --filter @apos/web smoke <projectId>                # real-browser smoke, 111 checks (run seed --reset first: it modifies data)
```

`dev-up.sh` is just the same steps as before (`pg-dev.sh` starts the database, `db:migrate` runs against both databases, `@apos/api start`, `@apos/web dev`); running them by hand works identically. If the container is reclaimed, just run it again.

★ `TEST_DATABASE_URL` must differ from `DATABASE_URL` — the tests TRUNCATE every table in `beforeEach`.
