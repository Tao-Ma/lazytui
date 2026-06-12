# Resize-as-Msg + update-layer scroll clamp

Status: **EXECUTED** (drafted + executed 2026-06-12; user said
"execute the spec"). All 4 phases on branch v0.6.4, commits
`fc54d44` (P1) → `8915bac` (P2) → `2abb00d` (P3) → `010f572` (P4),
each suite-green (88/89, xz env-only + 9 smoke + 12/12 render probe).
Follow-on to docs/wm-geometry-refactor.md — resolves its post-execution
open item 1 by *redesign* rather than approval: the scroll-clamp leaves
the render path entirely, and terminal resize becomes a first-class Msg.

## Execution results (2026-06-12)

- Open question 1 (Msg naming): **`term_resized`**, plain — as leaned.
- Open question 2 (release target): STILL OPEN, travels with the wm-geo
  commits ([[release-closes-when-user-says]] convention).
- P4 found and fixed a real perf hazard: the finalizer benched ~19μs/Msg
  pre-memo, and the comparison was further distorted by the repo mount's
  slow-stat filesystem (lazy `require()` per call = ~35μs of fs stats
  there). Fixes in `010f572`: (a) `_finalizeLayout` memoizes calcLayout
  on (arrange, dims, viewMode) ref identity — correct because reducers
  update those immutably; (b) app/state's nav hot trio got memoized
  module refs (cycle-safe laziness without per-call re-resolution).
  Same-fs bench vs pre-arc baseline `8eea6e9`: every case within noise,
  single-dispatch latency slightly BETTER (13.5μs vs 14.6μs).
- Render-purity pin landed as test-scroll-clamp [4]: a direct
  (non-dispatch) scroll break survives a render untouched; the next
  dispatch repairs it.
- Behavior shift absorbed by two existing tests: test-scroll-clamp [1]
  (cursor moves clamp at dispatch, not render) and the multi-instance
  smoke's scroll-independence step (clamp-stable value now required).

## Why (the long-term argument)

The wm-geometry refactor made layout math pure, but left one render-side
write standing: `paint.js#_syncScrollClamp` dispatches `set_scroll` Msgs
from inside the view pass, blessed as a DATAFLOW.md exception. The
defense for keeping it there was (a) the clamp is a safety net that must
catch cursor-off-viewport from ANY cause without enumerating Msgs, and
(b) terminal resize emits no Msg, so an update-layer clamp would miss
the most important trigger.

Both halves dissolve on inspection:

- (a) conflated "runs without Msg enumeration" with "runs in render".
  A pass that runs after *every dispatch* has the same no-enumeration
  property — and since v0.5 every state change in this codebase IS a
  dispatch. The viewer's `_finalize` (v0.6.2 T2) already established
  derive-after-update as the house pattern for invariants; this extends
  it one level up.
- (b) is not a constraint, it is a hole. `tui.js` already listens to
  `process.stdout 'resize'` — it just routes the event straight to
  `scheduleRender()`, bypassing the update layer. The entire model is
  blind to the terminal's dimensions; render smuggles them in via
  `io/term.dims()`. Window size is a fundamental input; a TEA app
  models inputs as Msgs and keeps them in the model.

The payoff is the invariant itself: **all writes flow through dispatch;
render is a pure Model → frame function.** No DATAFLOW exceptions, no
precedent for the next render-side write, one-line teachable, greppable,
machine-checkable. At this stage of the framework that uniformity is
worth more than any single feature.

## Design

Three pieces, in dependency order.

### 1. `term_resized` Msg — dims live in the model

- New layout-slice field `layoutSlice.dims = { cols, rows }`. Seeded at
  boot (initState) from `io/term.dims()`. Single writer: the new
  `term_resized` arm in the layout Component reducer
  (`panel/layout.js`), which just stores the payload.
- The `tui.js` resize listener becomes
  `dispatch(wrap('layout', { type: 'term_resized', cols, rows }))`
  with cols/rows read from `process.stdout` at event time. The existing
  `scheduleRender()` call stays beside it (render scheduling is already
  debounced; whether dispatch should auto-schedule renders generally is
  out of scope).
- No debounce on the Msg itself: terminals emit 30+ resize events/sec
  during a window-edge drag, but the reducer arm is a field write and
  the finalizer pass (piece 2) is microseconds; the expensive part —
  painting — stays coalesced behind the render queue.
- All geometry *call sites* switch from `io/term.dims()` to
  `layoutSlice.dims`: render/paint.js (3 view modes), dispatch/input.js,
  dispatch/actions.js, and the P4-hoisted sites (panel-layout,
  pane-menu, decor) — `dims()` becomes boot-seed + resize-listener only.
  One clock: between the OS resize and the Msg landing, the whole app
  agrees on the (old) size and repaints once when the Msg arrives —
  standard TEA staleness, self-correcting.

### 2. Dispatch finalizer — the clamp's new home

- New post-dispatch invariant pass in `panel/api.js`: after the
  *outermost* dispatch completes, run the scroll clamp over all
  non-detail, non-collapsed panes (the exact loop `_syncScrollClamp`
  runs today). Both top-level entries — `dispatchMsg` AND
  `dispatchKeyToFocused` — share a depth counter; the pass fires once
  at depth-0 exit, so effect-chained nested dispatches don't multiply
  it. Async effect callbacks dispatch later as fresh top-level entries
  and each get their own pass — correct, that's when state changed.
- **Freshness**: the pass computes `geo.calcLayout(layoutSlice,
  layoutSlice.dims)` itself and judges viewports against THOSE rects —
  it must NOT go through `boundsFor → slice.paneBounds`, which at
  dispatch time still holds the *last render's* bounds (the same
  staleness class as the just-fixed one-frame resize lag, `8eea6e9`).
  Mechanically: `getPanelViewportH` gains an optional precomputed-
  `layout` argument whose rects take priority; existing callers are
  untouched.
- **Writes stay single-writer**: the pass calls the existing
  `syncPanelScroll` (wrapped `set_scroll` Msg to the owning navigator
  — already identity-preserving). A re-entrancy flag in the pass makes
  the nested `set_scroll` dispatches skip the finalizer rather than
  relying on bounded-depth convergence — explicit beats clever.
- Free-config freeze: the gate drops most Msgs while frozen and panels
  render snapshots; the pass still runs on the layout-wrapped Msgs
  that flow. Harmless (clamp is identity-preserving), no special case.
- Coverage argument, for the record: per-frame-in-paint caught state
  changes from any source *because render follows every change*. The
  dispatch finalizer catches them *because every change IS a dispatch*
  — cursor moves, list shrinks (refresh broadcasts), collapse,
  drag-resize, view-mode switches all arrive as Msgs, and resize now
  does too (piece 1). The two are equivalent iff no state mutates
  outside dispatch — which is exactly the invariant the codebase
  enforces and this redesign completes.

### 3. Render purity — the deletions

- `paint.js#_syncScrollClamp` and its three call sites delete. Render
  no longer dispatches anything.
- The DATAFLOW.md "render-side writes" entry for set_scroll CLOSES
  (not blessed). The paneBounds render-write remains, explicitly out
  of scope (see Deferred).

## Phases (each lands suite-green, behavior-pinned first)

- **P1 — dims into the model.** Seed `layoutSlice.dims`, add the
  `term_resized` arm, flip the tui.js listener to dispatch, migrate
  the `io/term.dims()` call sites to slice dims. Render's own clamp is
  UNTOUCHED in this phase — behavior identical, pin tests stay green.
  New test: `term_resized` dispatch updates slice dims; geometry
  readers see them without a render.
- **P2 — dispatch finalizer.** Depth counter + pass + re-entrancy flag
  in panel/api.js; `getPanelViewportH` layout param. Render clamp still
  present (double-clamp is identity-preserving — safe overlap window).
  New tests: cursor-move Msg clamps WITHOUT a render; `term_resized`
  clamps WITHOUT a render; nested-effect dispatch runs the pass once.
- **P3 — delete the render clamp.** Remove `_syncScrollClamp` + call
  sites; rewrite test-scroll-clamp.js around dispatch-time clamping;
  add the render-purity pin (a render pass leaves every nav slice's
  scroll untouched / dispatches nothing). Close the DATAFLOW.md
  exception; update wm-geometry-refactor.md open item 1 → resolved.
- **P4 — verification.** Full suite + 9 smoke + render probe +
  bench-hotpaths (the pass adds one calcLayout per outermost dispatch;
  record the delta next to the v0.6.2 bench numbers).

## Tests (summary)

| pin | before | after |
|---|---|---|
| cursor below viewport | clamped at next render | clamped at dispatch, pre-render |
| terminal shrink | clamped at next render (`8eea6e9`) | clamped when `term_resized` lands, no render needed |
| render purity | n/a (render dispatched set_scroll) | render mutates no nav scroll, dispatches nothing |
| finalizer once-per-dispatch | n/a | effect-chained nested dispatches → one pass |

## Deferred (recorded, not in scope)

- **paneBounds derivation in the update layer.** The remaining
  render-side write. Blocked on decoupling renderHalf/Full's
  focused-panel fallback (`if (!focusedPanel) return renderNormal`)
  from bounds computation; the dispatch finalizer is the natural future
  home once that unknots. Separate spec when taken up.
- **Retiring `io/term` module-local COLS/ROWS** entirely (render's
  `cols()`/`rows()` reads) in favor of slice dims — mechanical once P1
  proves out, but touches every paint path; fold into the paneBounds
  work.
- **SIGWINCH directly**: Node's stdout 'resize' event already wraps it;
  no reason to go lower.

## Open questions (user calls before execution)

1. **Msg naming**: `term_resized` (proposed, past-tense-event house
   style) — or fold into a broader `term_event` envelope if more
   terminal-state Msgs are foreseen (focus in/out from DEC 1004 is a
   candidate someday)? Lean: `term_resized`, plain.
2. **Release target**: this is a structural arc — ship inside v0.6.4's
   closure alongside the wm-geo commits, or first thing on the next
   branch? (Same open call as wm-geo item 3; they should likely travel
   together.)
