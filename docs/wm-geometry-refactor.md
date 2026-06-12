# WM geometry refactor — the "real A2" (de-conflate · purify · re-home)

> Status: **EXECUTED 2026-06-12** — all 4 phases shipped on branch
> v0.6.4 (`3d7e2d0..000534c`, 6 commits). Supersedes the file-shuffle
> framing of A2 in [`v0.6.3-arch.md`](v0.6.3-arch.md) Track 1 (Phase A2
> "carve `js/wm/`"). Decisions taken at execution: home = (a)
> `leaves/geometry.js`; scroll-sync = per-frame in paint (NOT an
> effect — preserves the every-frame safety-net semantics exactly; an
> effect would have to enumerate every geometry-changing Msg). Release
> target still **TBD (user's call)**.
> Results: logical-graph cycles through the geometry math 1535 → 0;
> global top-level-require SCC scan: zero load-time cycles; facade
> deleted; new pin test `test-scroll-clamp.js` (also pins the
> pre-existing one-frame clamp lag on resize — see Phase 1.1 note).

## Why (the finding that motivated this)

A2 was specced as "move the window-manager files into `js/wm/`." A dependency
analysis (2026-06-12) showed that carve creates **no real module boundary**
(the heavy members `pool`/`pane`/`pane-tabs` are genuinely app-wide shared
leaves; `paint` is correctly render-layer) and has **no perf benefit**
(`require()` cost is depth-independent — measured: shallow 0.25µs vs 5-deep
0.22µs/call). So the file-shuffle A2 is **not worth doing**.

But probing "is Theme B's seam correct?" surfaced the real issue. Theme B
split the 1334-LOC `render/layout.js` god-file along a **math-vs-paint** cut
(`geometry-core` + `paint` + thin `geometry` facade). **The cut is right;
the homing is wrong.** Three proofs:

1. **Fingerprint** — `render/geometry-core.js` imports **zero** render
   primitives (no ansi/painter/panel/themes/decor) and **zero** overlays.
   Its deps are `io/term` (screen dims) + model + routing + `pool`/`pane`.
   That is the signature of a **window-manager spatial-model** module
   ("where do the panes go"), not a view. It is mis-shelved in `render/`.
   By contrast `paint.js` pulls all 5 render primitives + 10 overlays.

2. **Cycle hub** — all ~40 load-time cycles in the tree route through the
   `render/geometry.js` facade. Because the facade re-exports `paint`
   (→ 10 overlays + every render primitive), **every consumer that imports
   it for *math*** (`dispatch` halfProjection, `panel/layout`
   visibleBoundsFor, `actions` getPanelViewportH, overlays invalidateRows)
   **transitively drags in the entire paint+overlay stack.** This is what
   forces the ~32 inline `require()` cycle-breakers scattered across the
   hot paths (`dispatch/input.js`, `dispatch/dispatch.js`, `panel/layout.js`).

3. **Impurity** — `calcLayout` / `boundsFor` / `visibleBoundsFor` /
   `getPanelViewportH` / `getCurrentLayout` read `getModel()` /
   `getInstanceSlice('layout')` directly, and **`calcLayout` performs a
   side effect**: `geometry-core.js:353` calls
   `syncPanelScroll(p.paneId, getPanelViewportH(p.paneId))` (a wrapped
   `set_scroll` dispatch) *during layout computation*. This model-reach +
   write is the edge that splices geometry into the cycle, and it is a
   TEA-purity violation ([[tea-reducer-discipline]], [[elm-tea-discipline]]).

**The layering inversion is already real today:** model/controller code
(`panel/layout`, `dispatch/*`) reaches "up" into `render/` for geometry math,
and `geometry-core` reaches sideways into `app/state` impurely. The
"directory = layer" story does not hold.

## Target architecture

Separate the **window-manager spatial model** (pure math) from the
**view** (paint), so math-consumers never touch the paint/overlay stack.

```
WM spatial model (PURE: slice + dims → rects; no getModel, no side effects)
  wm-geometry.js         ← was render/geometry-core.js, purified + re-homed
    distributeColumnHeights, halfProjection, calcLayout(slice,dims),
    boundsFor(slice,key), visibleBoundsFor(slice,key),
    getPanelViewportH(slice,paneId), getCurrentLayout()*
  pool.js, pane.js, arrange.js   (already pure WM primitives)
  layout.js (Component reducer)   (already model-layer)

WM view (render layer — depends DOWN on wm-geometry)
  render/paint.js        ← renderNormal/Half/Full, compositing, chrome,
                            overlay dispatch, render()/redraw()
  render/footer.js
```

Home for `wm-geometry.js`: candidate options, decide in Phase 3 —
(a) `leaves/geometry.js` (alongside `pool`/`pane`/`arrange` — it IS a WM
primitive), or (b) a new `js/wm/` dir if we also relocate `layout.js` +
the gesture family there. **Recommendation: (a)** — smallest, truest to the
"it's a primitive" finding; defer any `js/wm/` dir to a later optional move.

`getCurrentLayout()`/`_currentLayout` is a module-published cache of the
last computed layout (read by hit-tests between frames). It can stay a
module-local cache inside `wm-geometry.js` — but the WRITE to it should
happen at the one calcLayout call site, not be re-derived impurely.

## Phased plan (each phase ends suite-green + smoke-green)

### Phase 1 — Purify the geometry math (NO file moves) ★ standalone slice
The high-value, cycle-breaking core. Independently shippable.

1. **Lift the side effect out of `calcLayout`.** Remove the
   `syncPanelScroll(...)` loop (geometry-core.js ~341-355) from layout
   computation. Return the computed layout; have the **render loop**
   (`paint.render`, the per-frame caller) perform the scroll-sync AFTER
   `calcLayout` returns, OR move it to a dedicated effect. This is the
   behavior-sensitive step — pin it with a test that scroll still clamps to
   the new viewport on a resize. (Find all `calcLayout` callers first.)
2. **Parametrize the readers.** Change `calcLayout(model=getModel())`,
   `boundsFor(key)`, `visibleBoundsFor(key)`, `getPanelViewportH(paneId)` to
   take the `layoutSlice` (and `dims`) explicitly instead of calling
   `getInstanceSlice('layout')` / `getModel()` / `io/term` internally.
   Thread the slice from each call site (callers already have model access).
   Watch the leaves-purity wall ([[leaves-purity-wall]]): tests pass a local
   slice, so the pure form must accept it.
3. Drop the `require('../app/state')` (syncPanelScroll/allPanels) and
   `getModel`/`getInstanceSlice` imports from the math module once unused.
4. Re-run the cycle analysis (script below) — the
   `geometry-core → app/state` cycle edge should be gone.
5. Suite + smoke + a render probe (two-pane + half/full) to confirm no
   visual regression.

### Phase 2 — De-facade (split math vs paint consumers)
1. Enumerate the ~14 distinct importers of `render/geometry` (facade) and
   classify each by the export it uses:
   - **MATH** → `calcLayout`/`boundsFor`/`visibleBoundsFor`/
     `getPanelViewportH`/`getCurrentLayout`/`halfProjection`
   - **PAINT** → `render`/`redraw`/`forceFullRepaint`/`invalidateRows`/
     `renderTerminalOverlay`/`_normalizeRender`/`renderFooter`
   (Known: `dispatch/actions`, `dispatch/dispatch`, `panel/layout`,
   `overlay/pane-menu`(partial) = MATH; `app/suspend`, `dispatch/effects`,
   `overlay/cmdline`, `app/tui` = PAINT. `input.js` uses both.)
2. Point MATH importers at the geometry module directly; PAINT importers at
   `render/paint` (or a slimmed paint facade). The math import no longer
   pulls the paint+overlay stack.
3. Thin or delete the `render/geometry.js` facade. If kept, it must NOT
   bundle paint into the math path.

### Phase 3 — Re-home the pure geometry module
1. Move `render/geometry-core.js` → `leaves/geometry.js` (recommended) and
   fix the now-cheap import paths (MATH consumers only — small set after
   Phase 2). Mechanical; suite catches misses.
2. Update DATAFLOW.md / PRINCIPLES.md layering notes + `v0.6.3-arch.md`
   A2 entry (mark superseded by this doc).

### Phase 4 — Reclaim the inline requires (the perf payoff)
1. With the cycle hub dissolved, convert the ~32 inline cycle-breaker
   `require()`s (esp. in `dispatch/input.js`, `dispatch/dispatch.js`,
   `panel/layout.js`) to top-level imports where the cycle is now gone.
   Re-run the cycle script after each batch to confirm no new cycle.
2. Optional perf confirmation: in-app probe timing the converted hot-path
   call sites. NOTE: isolated bench showed cached relative require ≈ 1.3µs
   (not the 70µs in the `c3d1cbc` memo — discrepancy unresolved; if the
   70µs reproduces in the real boot, this phase is a real win; if ~1µs,
   it's cleanliness-only). Decide whether to memoize residual inline
   requires per [[v064-backlog]]'s c3d1cbc lesson.

## Verification toolkit

- **Cycle re-check** (re-author per phase): top-level-require-only graph,
  DFS for cycles through `{panel/layout, render/geometry*, render/paint,
  leaves/geometry}`. The previous run found ~40 cycles, ALL through the
  facade — target is zero through the math module.
- **Dependency fingerprint**: assert the re-homed geometry module has zero
  `render-primitive`/`overlay` top-level deps.
- Suite (86/87, xz env-only) + 9 smoke + a live two-pane half/full render
  probe (catches layout-math regressions the unit tests can miss; see
  [[capture-render-output]]).

## Risks / gotchas

- **`calcLayout`'s scroll side-effect (Phase 1.1)** is the one
  behavior-sensitive change — scroll-clamp-on-resize must keep working.
  Reproduce with a probe before/after ([[dont-speculate-commit]]).
- `getCurrentLayout`/`_currentLayout` between-frame cache: keep the cache,
  but write it only from the (now pure) calcLayout call site.
- Leaves-purity wall: pure forms must accept a passed slice; don't let a
  test-local slice diverge from the published one.
- Phase ordering matters: purify (1) BEFORE de-facade (2) BEFORE re-home
  (3) BEFORE inline-reclaim (4). Each is suite-green on its own.

## Open decisions (resolve at start of execution)

1. **Home for the pure module** — `leaves/geometry.js` (recommended) vs a
   new `js/wm/` dir (only if also moving `layout.js` + gesture family).
   → TAKEN at execution: (a) `leaves/geometry.js`.
2. **Scroll-sync new home (Phase 1.1)** — inline in `paint.render` after
   calcLayout, vs a dedicated `syncScroll` effect. (Lean: effect, cleaner
   TEA.)
   → TAKEN at execution: **per-frame in paint** (`paint.js#_syncScrollClamp`,
   right after calcLayout in all three view modes), AGAINST the lean.
   Rationale: the clamp is a safety net — per-frame catches every cause of
   cursor-off-viewport (cursor moves, collapse, drag-resize, view-mode
   switches, terminal resize) without enumerating them; an effect fires on
   Msgs, so it needs a maintained every-geometry-Msg list AND a resize
   event source that doesn't exist (resize emits no Msg — the effect would
   never fire for the most important case). Cost: one render-side Msg
   dispatch survives as a DATAFLOW.md blessed exception. Revisit only if a
   SIGWINCH → `term_resized` Msg pipeline is built first.
3. **Release target** — its own point release, or fold into the next.
   → STILL OPEN (user's call). The 7 wm-geo commits sit on branch v0.6.4.

## Post-execution open items (user decisions, 2026-06-12)

1. **Approve or overrule decision 2 above** (scroll-clamp stays per-frame
   in paint vs invest in the effect + resize-Msg redesign).
2. **One-frame resize clamp lag — FIXED (user-approved 2026-06-12).**
   Was PRE-EXISTING (predated this refactor; the refactor preserved it
   bit-for-bit): the clamp read viewport heights via `boundsFor →
   slice.paneBounds`, but the frame's paneBounds was written AFTER the
   clamp ran — so the clamp judged against the PREVIOUS frame's heights,
   and after a terminal shrink the selected row could sit off-screen
   until the next render. FIX: the `_syncScrollClamp` call moved after
   the paneBounds rewrite in renderNormal/Half/Full, so the clamp sees
   this frame's fresh bounds and a resize re-clamps on the same render.
   `test-scroll-clamp.js` [3] flipped to clamp-immediately. Side benefit
   in half/full view: off-screen panes now fall through to the fresh
   `_currentLayout.rects` instead of a stale previous-frame slice entry.
3. **Release target** (decision 3 above).
