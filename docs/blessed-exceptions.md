# Blessed-exception elimination arc

> **STATUS: SPECCED, not started (2026-06-14).** A standing-debt arc, not a
> v0.6.4 release blocker. Each phase is a strict behavioral no-op — it
> relocates *where* state is produced, never *what* the user sees. Sequence
> is by leverage, not dependency: phases are independent and can ship in any
> order, but the listed order front-loads the framework-hardening wins.

## Why

lazytui documents a strict discipline — single-writer-per-slice, pure
reducers, pure render (`model → string`) — and then lists a handful of
**blessed exceptions** to it (`docs/DATAFLOW.md`, `docs/PRINCIPLES.md §11/§12`,
`docs/history/v0.5-layering.md`). Every exception is signed-off and commented
at its site, so none is a bug.

But this is an early-stage **framework**: plugin and config authors (humans and
models) learn the allowed patterns *by example*. An exception that lets render
write state, or a reducer read across slices, teaches that those moves are
fine. The project's own history shows the exceptions are not load-bearing —
they keep getting converted to Msgs/events (D3 boot-init, P5.1 terminal-exit,
resize-as-Msg scroll-clamp, the wm-geometry math purification). This arc
continues that trajectory with the goal of driving the live set toward empty.

## Ground-truth inventory (verified against code 2026-06-14)

A read of every documented site found the canonical doc lists **lag the code**.
Already retired — do not re-track:

- `setImmediate(terminal_exit)` from render → event-driven via
  `pty-lifecycle.handleExit` (v0.6.3 P5.1). `paint.js:609` is now pure paint.
- boot `m.config` / `m.register` direct writes → `set_config` / `set_register`
  Msgs (v0.6.3 D3, `state.js:119,224`). `designEnabled` removed with design-mode.
  Only `register.js:62`'s comment is stale.
- `calcLayout` render-side `set_scroll` dispatch → moved to the post-dispatch
  finalizer (resize-as-Msg); render dispatches nothing (`test-scroll-clamp`).

The live exceptions collapse into **five root-cause clusters** plus one
cosmetic. Phases below are ordered by leverage.

**Standing sanctioned reads (NOT eliminated, by design — listed so the
register is complete):** a deep TEA-purity sweep (2026-06-14) found two
impure reads that are sanctioned, not bugs, and intentionally kept:

- ✅ **`viewer.update()` boundary `getModel()` read — ELIMINATED 2026-06-15
  (#3).** Was the only Component whose `update()` read the global store.
  Now the framework's `augmentMsg` hook threads a `pt.viewerModelBundle` as
  `msg.viewerModel`, and `viewer.update` derives lines + the tab-transition
  capture from it via the `*FromBundle` readers — no `getModel()` in the
  update path. The read is RELOCATED to the dispatch shell (the work is the
  same), but every Component reducer is now pure of the store. See the #3
  entry below + PRINCIPLES §12.
- ✅ **config-status init-time fixup — ELIMINATED 2026-06-15 (#4).** Was
  the last cross-slice init read: `init(paneId)` reached for `getModel()` +
  `getInstanceSlice('layout')` to seed its slice. Now the framework mint
  loop (`state.js`) threads a seed `{ config, projectDir, paneDef }` into
  `init(paneId, seed)` — the blessed shell reads `getModel()`, init is a
  pure function of `(paneId, seed)` with NO `getModel` / `getInstanceSlice`.
  Mirrors the existing `register.init(config.register)` precedent + Phase
  D's `subscriptions(paneDef)` seam. config-status no longer imports either
  global accessor. **Bug found + fixed in the same change:** the pre-#4
  `_branchFromArrange` read `paneDef.config.branch`, but `widenPane` spreads
  the pool entry's config onto the pane (`branch` lands TOP-LEVEL, no
  `.config`), so a placed pane's custom `branch:` ALWAYS fell back to
  DEFAULT in production (masked by the single/default-branch case + a unit
  fixture that used a shape the parser never emits). `_branchFromPaneDef`
  now reads top-level `branch` (nested fallback kept); the test derives
  panes through the real `rebuildLayoutFromConfig` widening path. See
  PRINCIPLES §11.

**Overlay-subsystem render exceptions — RESOLVED by the model-clock arc
2026-06-15** (found by a second, file-by-file code sweep that audited
`js/overlay/` — the first sweep stopped at `panel/`/`leaves/`/`render/paint.js`).
Both reads that made overlay renders non-idempotent on equal *model* state
have been brought under the model-clock discipline:

- ✅ **Dims from the `io/term` singleton → `model.dims` (Finding B).** Overlays
  + `renderOverlay` + the footer now resolve dims via
  `leaves/draw.js#viewportDims()` (the layout-slice dims arrive through the
  `setDimsProvider` seam wired from `panel/api` since the render-exit arc moved
  the renderer to a leaf; `io/term` is a boot fallback only). The dims
  source-of-truth is unified; the 1-frame resize desync is gone. Pinned by
  `test-overlay-dims.js`. See PRINCIPLES §11.
- ✅ **Wall-clock age → threaded `now` → `model.now` (Finding A, FULLY
  ELIMINATED).** `renderDiagLog`/`renderJobsOverlay` take `now` (threaded from
  `paint.render(model)`) instead of reading `Date.now()` in-body. The former
  residual frame-boundary read (`paint.render`'s `now = Date.now()` default)
  is now GONE: `render()` reads `model.now`, advanced by the `clock_tick`
  reducer arm (its cadence is the model-conditional `clock` interval Sub —
  declared only while an age overlay is open, FIX-3 Phase 6; the wall-clock read
  is in the Sub's `onTick`, the impure shell). So the rendered frame is now pure
  of the WALL CLOCK — exception D was specifically the wall-clock render read,
  and it is gone. The residual #D5 gap this entry once noted (overlays rendering
  from out-of-TEA `feature/jobs` / `io/diag-log` registries; the frame reading
  history / theme too) has since been closed: **v0.6.6 FIX-1** mirrored jobs /
  diag / history into `model.{jobs,diagLog,history}` (the store-mirror Sub), and
  the theme palette is projected from `model.theme` at the render entry (#D8).
  The **#D5 replayability boundary** has therefore shrunk to the terminal island
  alone (the PTY/xterm buffer + `io/term` dims) — see `model/store.js`
  §Replayability boundary. See docs/model-now-tick.md. Pinned by
  `test-overlay-clock.js` + the `clock_tick` reducer tests. See PRINCIPLES §11.

Everything else below was an eliminable exception and has been removed.

---

## Remaining standing exceptions — recommended fix order

**All five recommended-fix-order items are now DONE (2026-06-15).** Findings
A + B (overlay model-clock arc), #3 (viewer.update bundle), #4 (config-status
init-injection), and #5 (`groupActions` contract enforced + memo) are all
shipped — the eliminable-exception set is empty. Kept here for the record;
order was by **(correctness value × tractability)**.

**1. ✅ DONE — Finding B — unify the dims source (overlays + footer read
   `model.dims`).** Shipped via `leaves/draw.js#viewportDims()` (renderer moved
   to a leaf in the render-exit arc; dims via the `setDimsProvider` seam);
   overlays + footer + `renderOverlay` read `layoutSlice.dims` (io/term = boot
   fallback).
   Mechanical, removed the 1-frame resize desync, laid the plumbing #2 rode.
   Pinned by `test-overlay-dims.js`.

**2. ✅ DONE — Finding A — overlay age via a threaded `now`, THEN `model.now`.**
   Shipped in two steps. First: `renderDiagLog`/`renderJobsOverlay` take `now`
   from `paint.render`, so the render fns are pure of wall-clock; the single
   clock read was concentrated to the frame boundary. Then (model.now / tick
   arc, docs/model-now-tick.md) that residual boundary read was eliminated too:
   `render()` reads `model.now`, advanced by the `clock_tick` reducer arm (its
   cadence is the model-conditional `clock` interval Sub — declared only while an
   age overlay is open, FIX-3 Phase 6; the wall-clock read is in the Sub's
   `onTick`, the impure shell). The frame is now pure of the WALL CLOCK (this was
   exception D / the render-replay blocker for the clock dimension). The broader
   "not a pure function of the model" gap this entry noted (render reading
   off-model jobs / diag / history / theme) has since been closed by **FIX-1**
   (jobs/diag/history mirrored into the model via the store-mirror Sub) + **#D8**
   (theme projected from `model.theme`); the only off-model frame read left is the
   terminal island (PTY). That residual is the #D5 replayability boundary (see
   `model/store.js` §Replayability boundary).
   Pinned by `test-overlay-clock.js` + the `clock_tick` reducer tests.

**3. ✅ DONE 2026-06-15 — `viewer.update()` boundary `getModel()` → threaded
   bundle.** Shipped across P0–P5 (commits `89201d8` → P5). The viewer reducer
   is now pure of `getModel()`: the framework's `augmentMsg` hook threads a
   `pt.viewerModelBundle` as `msg.viewerModel`, and `update` derives lines +
   the tab-transition capture from it via the `*FromBundle` readers. The read
   is RELOCATED to the dispatch shell (work unchanged); §12 now has zero
   Component-reducer store reads. No-bundle fallback decision (P3): NO
   `getModel` fallback in `update` — a missing bundle degrades safely
   (info/transcript resolve, per-group tabs read empty); all production
   dispatch threads it via the two augmented `comp.update` sites. Phase record
   below.

   *Original investigation (2026-06-15)* — the read was NOT a small-scalar swap:
   it feeds `viewerLines →
   found the read is NOT a small-scalar swap: it feeds `viewerLines →
   flatTabInfo`, which needs the **full current-group tab structure** (merged
   actions + terminals), used both for the active-tab content AND the
   tab-transition capture in `_withDerivedFields` (which needs `originalSlice`,
   so it can't move to the post-dispatch finalizer). The model dependency
   reduces to a `viewerModelBundle(model, groupName) = {currentGroup, group,
   mergedActions, yamlTerminals}`, consumed by `flatTabInfo` / `viewerLines` /
   `resolveTabKey` (+ viewer's `_activeTabKey` / `_tabKeyExistsIn`). Production
   dispatch funnels through ONE choke point (`api._dispatchMsgInner`); only
   tests call `update()` directly. NOTE: this RELOCATES the read from the
   viewer reducer to the framework dispatcher (the impure shell) — it does not
   remove the work; the gain is a `(msg, slice)`-pure viewer reducer + §12
   reaching zero reducer-store reads. Plan (execute one phase per commit, full
   viewer suite as the gate between each):

   - **P0 — `pt.viewerModelBundle(model, groupName)` (pure leaf).** New
     accessor capturing the fact-set the readers need from the model. One read
     site. No callers yet; unit-test the shape.
   - **P1 — parametrize the leaves to accept the bundle (back-compat, no
     behavior change).** `flatTabInfo` / `viewerLines` / `resolveTabKey`
     (+ viewer `_activeTabKey` / `_tabKeyExistsIn`) derive their facts from a
     bundle; keep the `(…, model, …)` signatures working by computing the
     bundle inline when handed a model, so render + existing dispatchers stay
     green. Suite green.
   - **P2 — thread the bundle at the framework choke point.** In
     `api._dispatchMsgInner`, when the routed target resolves to a viewer
     instance, compute `viewerModelBundle(getModel(), currentGroup)` once and
     spread `viewerModel` into the msg before `comp.update`. Covers all
     production dispatch (sync + async/effect); gated on viewer-kind so
     non-viewer dispatch pays nothing. Cost ≈ today's per-update flatTabInfo
     (relocated, not added).
   - **P3 — `viewer.update` reads `msg.viewerModel`, drops `getModel()`.**
     `update(msg, slice)` uses the threaded bundle for `viewerLines` +
     `_withDerivedFields`. No `getModel()` in the update path. (Render-side
     `viewerLines`/`detailTitle` keep reading `getModel()` — render may.)
   - **P4 — update direct-call tests + add a guard test.** Thread the bundle
     in tests that call `viewer.update` directly; add a test that spies
     `getModel` and asserts ZERO calls while dispatching viewer msgs.
   - **P5 — cleanup + docs.** Drop the dead `getModel` import from the update
     path if fully removed; update PRINCIPLES §12 (zero reducer-store reads)
     + this register. Decide the no-bundle fallback (require it vs a one-time
     compute) at P3 and document the choice.

**4. ✅ DONE 2026-06-15 — config-status init cross-slice read →
   init-injection hook.** The mint loop (`state.js`) threads a seed
   `{ config, projectDir, paneDef }` into `init(paneId, seed)`; config-status
   derives files/projectDir/branch from it and no longer imports `getModel` /
   `getInstanceSlice`. Curated-seed shape chosen over passing the whole model
   (consistent with `register.init(config.register)` + #3's narrow bundle —
   both established precedents). The seam is generic: any Component's `init`
   may take `(paneId, seed)`; seed-blind inits arity-ignore it. **Latent bug
   fixed in the same change:** placed panes carry `branch` TOP-LEVEL (widenPane
   spreads the pool config), so the old `.config.branch` read always defaulted
   in production — `_branchFromPaneDef` now reads top-level branch; test derives
   panes through the real widening path. Seam + fix verified by an end-to-end
   boot probe (two panes, `config`/`prod` → routed correctly). Suite 92/93
   (xz env-only) + 9/9 smokes.

**5. ✅ DONE 2026-06-15 — `groupActions` purity contract enforced in
   production + opt-in memoization.** Originally framed as enforce-vs-accept
   (likely wontfix-in-prod). Resolved by a better split the binary framing
   missed: the guard's two checks have very different cost (a benchmark put
   the read-only Proxy at ~4–12× a raw call — but in absolute terms ~0.2–2 µs,
   negligible at real call frequency; timing is free). So `plugin-guard` now
   guards **every** call (the `LAZYTUI_STRICT_PLUGINS` gate is retired — always
   strict), AND a Component opts into a fast path with **`groupActionsMemo:
   true`**: guarded once per (boot-static) `group`, then cached in a `WeakMap`
   → a pure Component pays the Proxy once, a non-memoized one pays every call
   (the incentive to be pure). Note: the "plugin" concept was retired in v0.5
   (everything is a Component); this is a **Component-contract** upgrade,
   documented in docs/PLUGINS.md §"The groupActions contract". Verified the
   only built-in `groupActions` (docker) is pure, so always-on is a no-op for
   it. Tests: `test-plugin-purity.js` (always-enforced + memo: runs-once,
   keyed-on-group, impure-caught-on-first-call, reset clears). Suite 92/93
   (xz env-only) + 9/9 smokes.

---

## Phase E — Enforce the plugin purity contract — ✅ SHIPPED 2026-06-14 (uncommitted)

**Highest leverage. Smallest change.**

> **SUPERSEDED 2026-06-15 by item #5 above** — the guard is now ALWAYS-ON
> (the `LAZYTUI_STRICT_PLUGINS` opt-in gate is retired) + `groupActionsMemo`
> opt-in caching. The original Phase-E ship (dev-only opt-in) is recorded
> below for the trail.
>
> **DONE (Phase E original).** New `js/panel/plugin-guard.js` (recursive
> read-only Proxy + timing, dedup'd warns to the diag window), wired into
> `api.getGroupActions`. Strict mode is opt-in via `LAZYTUI_STRICT_PLUGINS=1`
> (dev/test); production is an unguarded pass-through. Decisions resolved:
> **record-and-continue, not throw** — a violation drops the plugin's
> contribution for that call + records a `plugin-impure` warn (the real
> model/config are NEVER mutated, so the app behaves identically); a slow
> call records `plugin-slow`; a genuine plugin bug re-throws for api.js's
> existing catch. Guard homed in `panel/` not `leaves/` (it records
> diagnostics → not behind the purity wall). Tests: `test-plugin-purity.js`
> (24 checks). Suite 89/90 (xz env-only) in BOTH default and strict mode;
> `test-plugin-tab.js` green under strict (guard is a no-op on the real
> docker plugin). Implementation notes below kept for the record.

**The exception.** `api.getGroupActions` calls each Component's
`groupActions(group, name, config, model)` (`api.js:787`). The contract
(`api.js:778`, `leaves/pane-tabs.js:54`) requires a **pure projection**: no IO,
no mutation of the args, no `Date`/random, same inputs → same outputs. It runs
on read paths (tab strip, actions panel, per-render). It is **documented, not
enforced** — a plugin that mutates `config`/`model` corrupts reducer purity; one
that shells out blocks the event loop per call.

**Why it's the priority.** Every other exception is internal code the
maintainers control. This one is the *external* surface — exactly the contract
that user- and model-authored plugins will violate, silently, because nobody
reads it.

**Fix.**
1. Wrap the plugin call in a dev/debug guard (gated on an env flag, e.g.
   `LAZYTUI_STRICT_PLUGINS=1`, default on in the test suite): `Object.freeze`
   (shallow, or a dev-only deep freeze) the `config` and `model` args before
   the call. Any write throws synchronously, attributed to `comp.name`.
2. Time the call; if it exceeds a threshold (e.g. 2 ms), record a warning to
   the diagnostics window (`leader e`) naming the plugin — surfaces IO /
   blocking work without failing the run.
3. Errors/throws already funnel through the `try/catch` at `api.js:792`; route
   the freeze-violation message through the same path with a clear contract
   citation.

**Files.** `js/panel/api.js` (the `getGroupActions` loop), maybe a small
`js/leaves/plugin-guard.js` if the freeze/time logic is worth isolating.

**Tests.** `test-plugin-tab.js` (or a new `test-plugin-purity.js`): a synthetic
Component that (a) mutates `config` → asserts a thrown/recorded violation under
strict mode, (b) is slow → asserts a diag warning, (c) is pure → asserts no
noise and identical output.

**Risk.** Low. Strict mode is opt-in/dev-only; production behavior unchanged
unless a plugin was already violating the contract (in which case surfacing it
is the point). **Note:** this subsumes R1's durable residual — R1's WeakMap
cache only *bounds* impurity damage; enforcement *prevents* it.

---

## Phase B — Drag-preview: thread `arrangeOverride` instead of swapping the slice — ✅ SHIPPED 2026-06-14 (uncommitted)

**Fully removable. Deletes code.**

> **DONE (the `arrange` half).** `calcLayout(layoutSlice, dims, opts)` now
> resolves `arrange = opts.arrangeOverride || layoutSlice.arrange`;
> `renderNormal/Half/Full` take the override and pass it down; `render()` no
> longer mutates `layoutSlice.arrange` — `savedArrange` + the swap + its
> restore are deleted. **Refinement found while implementing:** `paneBounds`
> is a SEPARATE mutation (renderNormal writes preview bounds, still needs
> restore so the next hit-test reads original geometry). It's a derived
> view-output cache, not semantic state, and its full retirement is Phase A
> — so the `savedBounds` save/restore intentionally STAYS for now (the
> dangerous mutation, semantic `arrange`, is what Phase B removes).
> `renderTerminalOverlay` needed no change (reads `paneBounds`, not
> `arrange`). Tests: `test-layout-value.js [8]` (override honored — fails on
> pre-Phase-B calcLayout, which ignored a 3rd arg — + slice arrange
> referentially unchanged). Suite 89/90 (xz env-only); drag tests + smoke
> green; headless preview-render verified (no throw, arrange survives).

**The exception.** During a free-config drag, `render()` mutates
`layoutSlice.arrange` → `previewArrange`, paints the would-be-after-drop layout
(including the terminal overlay), then restores `arrange` **and** `paneBounds`
in a `finally` (`paint.js:668-701`). The comment justifies the in-place
mutate/restore by arguing that routing the restore through `setInstanceSlice`
would emit a model snapshot mid-render and trip the reactivity boundary.

**The insight.** The swap exists only because `calcLayout` reads `arrange` off
the slice. If the preview arrange is passed **as a parameter** instead, render
never touches the slice at all — so the reactivity argument is moot (there is
nothing to restore).

**Fix.**
1. Extend the pure geometry entry: `calcLayout(layoutSlice, dims, opts)` where
   `opts.arrangeOverride` (when present) is used in place of `layoutSlice.arrange`.
   (`leaves/geometry.js` already takes explicit `(layoutSlice, dims)`.)
2. `renderNormal/Half/Full` read `const drag = layoutSlice.freeConfig?.drag` and
   pass `drag?.previewArrange` down as `arrangeOverride` — no slice write.
3. `renderTerminalOverlay` already needs preview-coord bounds; have it read the
   override the same way (or take the already-computed layout).
4. Delete the `savedArrange` / `savedBounds` / `finally`-restore block.

**Files.** `js/leaves/geometry.js`, `js/render/paint.js`.

**Tests.** Existing drag smoke (`smoke/drag.js`) + `test-free-config-drag` must
stay green; add an assertion that `layoutSlice.arrange` is **referentially
unchanged** across a preview render (the teeth: it fails against the old
swap-and-restore if restore ever regresses).

**Risk.** Low–medium. The override must reach both the main paint and the
terminal overlay; a missed call site shows a stale preview. Covered by the
referential-stability assertion + drag smoke.

---

## Phase A — Render-side view-output writes → finalizer / selectors

**The biggest render-purity win.** Render currently writes three perf caches:
`paneBounds` (`paint.js:402/449/509`), viewer `tabBounds` (`viewer.js:1111`,
own-slice since P4.1), viewer `innerH` (`paint.js:724`). The geometry *math* is
already pure (`leaves/geometry.js`); these are write-backs so the input layer
(hit-tests) and viewer reducers (scroll clamp) avoid recompute.
`panel/layout.js:185` is just the slice-shape declaration of `paneBounds`.

### A.1 — innerH into the finalizer — ✅ SHIPPED 2026-06-14 (uncommitted)

> **⚠️ SUPERSEDED — exception B RETIRED in v0.6.6 FIX-2 (2026-06-24).** A.1 moved
> the `innerH` write from `render()` into the finalizer, which became
> blessed-exception B (a runtime same-slice write). v0.6.6 eliminated B entirely:
> `viewer.augmentMsg` now stamps `msg.innerH` (computed in the shell from the
> pane's committed geometry) and the viewer's OWN pure reducer commits it, so
> there is no outside writer of `slice.innerH`. The finalizer's innerH block is
> deleted. See `docs/v0.6.6.md`. The A.1 record below is kept accurate-to-era.

> **Location update (v0.6.5 B/S6, then #D4):** the finalizer (`finalizeDispatch`,
> this innerH write = blessed-exception B) relocated `panel/api.js` →
> `dispatch/fanout.js` when the Component fan-out moved to the dispatch layer
> (B/S6), then #D4 (2026-06-18) split the fan-out file into `runtime/loop.js`
> (the pump) + `runtime/finalize.js` (the after-update phase). The v0.6.4 text
> below is historically accurate for the render→finalizer move; the current home
> of this write is `dispatch/runtime/finalize.js`. See docs/v0.6.5-dispatch-loop.md.

> **DONE.** The viewer `innerH` write moved from `render()` (`paint.js`) into
> the post-dispatch finalizer (`panel/api.js _finalizeDispatch`). Computed via
> `getPanelViewportH(layoutSlice, resolveViewerPaneId(), dims, layout)` off
> THIS dispatch's fresh Layout — so it's strictly fresher than the old
> render-side write, which read `paneBounds` one frame stale (the resize-lag
> the render code worked around). Kept the `!==` guard (preserves the viewer
> slice's reference identity when unchanged). Render's innerH block deleted;
> render no longer writes another Component's slice (only `paneBounds` +
> viewer's own `tabBounds` remain → A.2). Tests: `test-resize-msg.js [9]` —
> innerH produced with NO render call, and tracks a resize freshly (21→9, no
> one-frame lag). Suite 89/90 (xz env-only); all viewer/scroll tests green.

Original plan:

`innerH` is a pure function of layout bounds. The resize-as-Msg arc already
built a **post-dispatch finalizer** (`panel/api.js`) that runs after every
state change with access to dims+layout and writes the scroll clamp. Compute
and write `innerH` there — part of the dispatch cycle, not render. Render's
`paint.js:712-725` block deletes.

- **Files.** `js/panel/api.js` (finalizer), `js/render/paint.js` (delete the
  write), any reducer reading `slice.innerH` is unchanged (still reads the slice).
- **Tests.** `test-scroll-clamp` + a viewer-viewport test: innerH is correct
  after a resize Msg with render mocked to a no-op (proves render isn't the writer).
- **Risk.** Low — reuses proven finalizer infrastructure.

### A.2 — paneBounds → memoized pure selector — ✅ SHIPPED 2026-06-14 (uncommitted)

> **DONE (paneBounds; tabBounds deferred).** Chosen strategy: **(a) memoized
> pure selector**, the same normalization as the `slice.lines` removal.
> New reusable primitive `leaves/selector.js` `createSelector(inputsOf,
> compute)` (reselect-style single-slot ref-memo) — THE model for derived
> data going forward (generalizes `matchesFor`/`_layoutMemo`). geometry.js:
> extracted a pure `_layoutRects(arrange, dims)` (no `_currentLayout` side
> effect), a memoized `_normalBoundsMap` selector, and pure
> `_halfBoundsMap`/`_fullBoundsMap`; `boundsFor`/`visibleBoundsFor` now
> compute via these. Render's `paneBounds` writes (normal/half/full) deleted;
> the drag-preview `savedBounds` save/restore deleted (Phase B residue gone —
> the terminal overlay gets preview coords via a threaded arrange override).
>
> **Deviation from a literal `slice.lines`-style field deletion (forced by
> the [[leaves-purity-wall]]):** ~20 fixtures seed `slice.paneBounds`
> directly, and P1.3's reader-flip was reverted once for this. So the FIELD
> stays in the slice shape as an optional **seed/override** input (tests +
> boot edge); production never writes it → bounds are pure-derived in
> production. Full field deletion = a separate ~20-fixture rewrite, available
> as a follow-on.
>
> **UPDATE — #D7 2026-06-18: production FIELD declaration deleted; override
> branch KEPT as a test-only seam.** The `paneBounds: {}` slice init is gone
> (`panel/layout.js`), so the production model shape no longer advertises a
> field it never writes, and `test-component` now asserts its ABSENCE. The
> geometry/`boundsOf` override read-branches stay — they're now documented as
> a **test-only** affordance. The *full* migration (force the ~20 fixtures
> onto real `calcLayout` geometry, deleting the override) was investigated and
> **declined**: those fixtures set NO `dims` and seed deliberately-simplified
> rects to **decouple the hit-test-math unit tests from the layout-math** (a
> legitimate test-isolation device, not laziness). Re-running it confirmed 9
> files / ~90 assertions would need recomputing against derived geometry, and
> the result would couple two subsystems in the tests — which is why P1.3's
> flip was reverted. So the override survives as an explicitly test-only seam.
>
> **One production read needed routing:** `free-config-core.boundsOf` read
> `slice.paneBounds` directly → now seed-first (both keys) then `geo.boundsFor`.
> Tests migrated: `test-viewer-pane-bounds` rewritten for the derived
> contract; 5 smokes updated to read bounds via `visibleBoundsFor` instead of
> the now-empty `slice.paneBounds` (hit-zones, mouse-gestures, mouse-raw-sgr,
> dual-viewer, + action-tab adapted to finalizer-derived innerH). Suite 89/90
> (xz env-only); all 9 smokes green; headless production probe confirms
> paneBounds empty after render + bounds resolve for every pane.
> **tabBounds** (viewer's OWN slice) left as a milder optional follow-on.

### A.3 — tabBounds → compute-on-read (the follow-on) — ✅ SHIPPED 2026-06-14

> **DONE.** The viewer tab-strip's hit-test bounds were the LAST render-side
> slice write (`detailTitle` → `route.setInstanceSlice(..., { tabBounds })`).
> Retired via **compute-on-read** (not the finalizer): a render-written cache
> read by mouse hit-tests, and mouse events are rare vs frames — same rationale
> as paneBounds, but compute-on-read here avoids churning the viewer slice's ref
> identity every dispatch (a finalizer array-write would). Extracted a pure
> `tabStripFor(slice, model, hotkey)` in `viewer.js` (the old `detailTitle`
> prologue: `flatTabInfo` on THIS pane's slice + running-job glyph set +
> `buildTabStrip`); `detailTitle` calls it for the title only and writes
> NOTHING; new exported `tabBoundsFor(slice, model, hotkey)` returns the bounds.
> The 3 input.js hit-test sites (tab-drag motion, tab-press detect, pane-click
> loop) recompute via `tabBoundsFor` — hotkey from the pane def (`p.hotkey`, or
> `_viewerHotkey()` for the focused viewer), matching render's `panel.hotkey`.
> `slice.tabBounds` is fully retired (no writer, no reader). **Probe: a viewer
> render now leaves the slice ref UNCHANGED (`before === after`)** — render is a
> pure view. Tests: `test-instance-registry` rewritten (render writes no
> tabBounds; tabBoundsFor recomputes per-pane), `smoke/hit-zones` recomputes via
> `tabBoundsFor` (paint-vs-hittest parity + close behavior both still green).
> Suite 89/90 (xz env-only) + 9/9 smokes. **With A.3, render writes NO slice
> state at all — Phase A is fully complete.**

Original plan (memoized selectors vs recompute):

Two options; pick one in the Decisions section:

- **(a) Memoized selectors** keyed on `(arrange, dims)` — the exact shape the
  viewer-lines-selector arc proved out for `slice.lines`. The input layer reads
  `boundsFor(...)` which resolves through the memoized selector; render stops
  writing. Cache invalidates on arrange/dims identity change.
- **(b) Recompute-on-read.** Mouse events are rare vs frames; the input layer
  calls pure `calcLayout` / `buildTabStrip` on demand. No cache, no write, render
  pure. Simplest; costs a layout recompute per mouse event (bench-confirmed cheap).

- **Files.** `js/render/paint.js` (delete writes), `js/leaves/geometry.js`
  (selector or accessor; the old `render/geometry.js` facade was deleted by
  the wm-geometry refactor), `js/dispatch/input.js` +
  `js/panel/viewer/*` (hit-test read sites), `js/panel/layout.js:185` (drop the
  field if fully derived).
- **Tests.** `test-mouse-wheel`, `test-viewer-pane-bounds`, tab-strip hit-test
  tests stay green; add a render-purity assertion (render produces no slice diff).
- **Risk.** Medium — touches every hit-test reader. The half/full visible-bounds
  path (via `resolveViewerPaneId`) is the subtle case; `test-viewer-pane-bounds`
  guards it.

---

## Phase C — `jobs_activate`: split into a two-Msg cascade — ✅ SHIPPED 2026-06-14

**Removes the last root-reducer cross-slice value read.**

> **DONE.** Split into THREE pieces, each obeying the discipline:
> `jobs_activate` (pure root arm) closes the overlay, resolves the target
> group from the job payload (model-only read), queues `set_current_group`
> (if cross-group) + a new `{type:'jobs_route', job, now}` Cmd, and reads NO
> Component slice. The `jobs_route` **effect** (`effects.js`, modeled on
> `cmdline_rebuild` — "the Cmd that reads then produces a Msg") runs AFTER
> the queued switch commits, so `getModel().currentGroup` is the POST-switch
> group — **the synthetic `postModel` is gone**; it reads the viewer slice
> (`flatTabInfo`/`resolveTabKey`) in the dispatch layer and threads
> `viewerTarget`/`groupName`/`tabIdx`/`targetKey`/`fromTabKey` into a flat
> `jobs_routed` Msg. The `jobs_routed` **pure root arm** emits the Cmd
> cascade (tab_switch + focus + terminal_enter / info card) from the threaded
> payload — no slice read. The kind→Cmds cascade stays in the reducer (not
> handler-orchestrated, per `[[tea-reducer-discipline]]`); only the
> view-derived read moved to dispatch. Dead `pt` import removed from
> runtime.js (reads now live in the effect). PRINCIPLES.md §12 updated: **no
> exceptions remain** to the root-reducer no-cross-slice-read rule. Tests:
> `test-jobs-activate.js` 25/25 unchanged (incl. the cross-group
> scroll-bottom-pin regression that the old `postModel` existed for — now
> correct by construction). Suite 89/90 (xz env-only); 9/9 smokes.

**The exception.** `jobs_activate` (`runtime.js:835`) switches `currentGroup`,
then *within the same Msg* reads the viewer slice (`flatTabInfo` /
`resolveTabKey`) using the group it just computed, to route the job to its tab.
The handler can't precompute those reads at dispatch time because the switch
hasn't happened yet — "not threadable" (PRINCIPLES.md:355).

**The insight.** "Not threadable" is true only *within one Msg*. The codebase
already has the `{type:'msg'}` effect channel: a flat Msg re-enters the root
reducer next tick.

**Fix.** Split:
1. `jobs_activate` switches the group and emits **two** effects: the existing
   group-switch cascade, plus a flat `{type:'msg', msg:{type:'jobs_route', job}}`.
2. By the time `jobs_route`'s arm runs, `currentGroup` is committed. Its handler
   (dispatch-side) reads `flatTabInfo`/`resolveTabKey` and threads the resolved
   tab as payload — the `jobs_route` arm is then fully pure.

**Files.** `js/app/runtime.js` (the arm), `js/dispatch/*` (the `jobs_route`
handler that does the now-safe read), `docs/PRINCIPLES.md` (remove the
documented exception once gone).

**Tests.** `test-jobs-activate.js` — route a routed/pty/info job across a group
switch; assert it lands on the correct tab and the `jobs_route` arm reads no
slice values directly (spy/inspect).

**Risk.** Medium — introduces a second dispatch + an ordering dependency
(group switch must commit before `jobs_route`). The flat-Msg channel guarantees
that ordering; the test pins the cross-group case.

---

## Phase D — `stats` subscription at mount, not first render — ✅ SHIPPED 2026-06-14

> **SUPERSEDED 2026-06-18 by #D13** — Phase D moved the subscribe off render
> to a declared seam wired at MOUNT, but with no teardown (a placed-then-removed
> pane leaked a live sub). #D13 completed it into a canonical `Model → Sub`
> reconciler: `app/state.reconcileSubscriptions` re-evaluates the desired set
> each dispatch (via the finalizer) and diffs/starts/stops — so subs now tear
> down on pane-remove. `_wireSubscriptions` is gone. See PRINCIPLES §subscriptions.

**The exception.** `stats.js _ensureSub` (`stats.js:46`) registers a hub
subscription lazily on first render — paint mixed with lifecycle. Blessed on
YAGNI: no post-boot topic-change pathway exists today (the comment names the fix).

> **DONE — chose the declared-subscriptions framework seam (the spec's
> envisioned shape, picked over the minimal in-init variant after a
> Cmd-vs-Sub analysis: a hub subscription is an ongoing `Sub`, so the
> TEA-correct model is a declared subscription the runtime wires, not a
> one-shot init Cmd).** stats exports a PURE `subscriptions(paneDef) →
> [{topic, window}]`; render() no longer touches the hub (the `_ensureSub`
> Set + call are deleted, `scheduleRender` import dropped). The framework
> performs the side effect in `app/state.js#_wireSubscriptions`, called per
> placed pane in the initState mint loop — deduped by `topic:window` (the
> old module Set, now framework-owned; `onUpdate` is always a repaint).
> No-op for Components without the hook. **No teardown yet** — no post-boot
> topic-change / pane-dispose-unsubscribe path exists, but the framework is
> now SHAPED to grow one (Component declares, runtime could diff +
> unsubscribe). config-status's lazy initial-state fixup is now the LAST
> lazy-render holdout (out of scope here). Tests: `test-stats.js` [14] (pure
> hook: topic/window projection, default 40, empty cases) + [15] (framework
> wires at mount with NO render — publish→history retained is the teeth;
> dedup; no-hook no-op); live boot probe (loadConfig+initState, no render →
> docker.stats retained) confirms the mint loop calls it end-to-end. Suite
> 89/90 (xz env-only) + 9/9 smokes. PRINCIPLES.md §11 updated (declared-sub
> rule replaces the `_ensureSub` canonical-example). Spec note below kept.

**Fix.** Subscribe at **mount/init** — when the stats pane is minted — via an
init effect keyed by the config-derived `(topic, window)`. The framework shape:
a Component declares its subscriptions; the framework wires them at mount.
Remove the render-time `_ensureSub` call.

**Files.** `js/panel/monitor/stats.js`, possibly the Component mint path in
`js/app/state.js` / the init-effect plumbing.

**Tests.** `test` for stats: subscription exists after mint (render mocked
no-op); a topic change re-subscribes (the case YAGNI deferred — now covered).

**Risk.** Small–medium. Must dedupe identically to the current module-private
`Set` so a re-mint doesn't double-subscribe.

---

## Phase F — Cosmetic — ✅ SHIPPED 2026-06-14

- ✅ **`redraw()` re-homed** `render/paint.js` → `dispatch/dispatch.js`.
  `redraw()` is a dispatch-then-paint helper (`showSelectedInfo()` then
  `render()`) — it dispatches a Msg, so it was a dispatch ORCHESTRATION, not a
  render. It now lives next to `showSelectedInfo` in the dispatch layer and
  lazy-requires `paint.render()`. **paint.js no longer requires any
  `dispatch/*` module** — its mode-table read is now `leaves/modes` (pure, to
  know which overlays to paint; re-homed out of `dispatch/` in v0.6.5 §4) and
  its error recording in `_safeRender`'s catch is `io/event-log` (diagnostic,
  on-throw only; re-homed out of `dispatch/` in v0.6.5 §1 Phase 3). So the render module is a pure view: `model → output`, no
  dispatch edge. Sole prod caller (`tui.js:278`) now imports `redraw` from
  dispatch (and dropped the now-unused `render` import). `smoke/dual-viewer.js`
  (2 sites) + its dead `paint` require updated.
- ✅ **Stale comment** `leaves/register.js:62` fixed — it claimed `state.js sets
  m.register = init()`; corrected to "state.js dispatches `set_register`"
  (v0.6.3 D3; reducer is sole writer).

**No-exception verdict.** With C + D + F landed, the render module dispatches
nothing and writes no layout/Component state; the root reducer reads no
Component-slice value (PRINCIPLES §12 has zero exceptions); hub subscriptions
are declared + framework-wired. The only documented lazy-render side effect
left anywhere is config-status's idempotent initial-state fixup (separate from
this arc). Suite 89/90 (xz env-only) + 9/9 smokes.

---

## Decisions to resolve before starting

1. **A.2 strategy** — memoized selectors (a) vs recompute-on-read (b)? (b) is
   simpler and render-purest; (a) matches the established viewer-lines-selector
   precedent. Recommend **(b)** unless a bench shows per-mouse-event recompute
   matters.
2. **Phase E strict-mode default** — on in tests only, or on in dev builds too?
   Recommend tests + an opt-in env flag; never hard-fail production.
3. **Scope/sequencing** — ship as one arc or fold opportunistically into
   whatever next arc touches each file? Phases are independent; E + F + A.1 are
   cheap enough to bundle, B is self-contained, A.2 + C + D each warrant their
   own commit.

## Non-goals

- No behavioral change. Every phase is a no-op for the user.
- Not a v0.6.4 blocker — this is post-tag standing debt.
- R1's WeakMap cache is **not** in scope: Phase E (enforcement) supersedes its
  intent; the cache itself is a measured non-win (`[[v062-merged-actions]]`).

## Tracking

Auto-memory `[[v064-backlog]]` §"Blessed-exception register" is the live status
line. Update it as phases land (the live set should shrink, mirroring the
"already retired" trajectory above).
