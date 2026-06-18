# Fresh TEA-conformance review — 2026-06-18

**Method.** A deliberately *doc-/memory-/history-blind* re-read of the source, judging
the **architecture / file / dataflow layout** against canonical TEA (The Elm
Architecture: `Model` / `Msg` / `update` / `view` / `Cmd` / `Sub`) as practiced in
reference Elm-style frameworks. Prior review docs, the blessed-exceptions ledger, and
auto-memory were intentionally **not** consulted while forming findings, so that
existing rationalizations don't pre-empt fresh eyes. (A finding may therefore restate
something a prior arc already "blessed" — that's expected and intended; the point is to
re-derive whether it holds up, not to inherit the verdict.)

**Discipline (per the review request).**
1. **Document the finding first** — what was observed, with `file:line` evidence.
2. **Then deep-analyze** — root cause and TEA principle at stake; no surface fixes.
3. **If a fix needs a judgment call, record it as a DECISION** below rather than applying it.

**Passes.** Five passes, each attacking a structurally different surface so coverage
compounds rather than repeats:

| Pass | Angle | Status |
|------|-------|--------|
| 1 | Architecture / file-layout → TEA layer mapping | **DONE** |
| 2 | Model & state ownership (single source of truth, single-writer, no off-model state) | **DONE** |
| 3 | `update`/reducer purity & shape `(msg, state) → (next, cmds)` | **DONE** |
| 4 | Effects (`Cmd`) & subscriptions (`Sub`); render purity | **DONE** |
| 5 | Dataflow / message routing (Msg as sole state-change channel; finalizers) | **DONE** |

**Status legend:** `OPEN` (finding stands, no fix yet) · `DECISION` (needs a human
judgment call — see Decisions Ledger) · `FORWARD` (parked for a later pass to verify) ·
`FINE` (examined, conforms) · `NOTE` (methodology/observation, not a defect).

---

## Decisions Ledger (running — appended by every pass)

> Open judgment calls surfaced by the review. Nothing here is applied; each awaits a call.

- **D1 — What does `leaves/` actually mean, and should it be split?**
  The directory currently means *two different things at once* ("pure transform" AND
  "bottom of the import graph"). Options: (a) split into a truly-pure tier + a
  stateful-bottom-infra tier; (b) rename `leaves/` so it stops implying purity; (c) keep
  as-is and document the redefinition at the directory level, not just inside `hub.js`.
  Evidence: F1.1. *Undecided.*
- **D2 — Should `leaves/` be sub-grouped by domain?** It is a flat 30-file / ~6.1k-LOC
  bucket mixing a layout-editor subsystem, tab-state, render primitives, a pub/sub bus,
  text utilities, and input registries. Evidence: F1.2. *Undecided.*
- **D3 — Is the `render/` vs `leaves/draw.*` bisection of the view layer intended,** and
  if the split axis is purity, why does the impure `render-queue.js` sit on the `leaves/`
  side? Evidence: F1.3. *Undecided.*
- **D4 — Should the TEA "program/runtime" loop have a single identifiable home?**
  Today the cycle is smeared across `control/dispatch.js`, `runtime/fanout.js`, and
  `runtime/effects.js`, with two parallel dispatch pumps (root-Msg vs Component-Msg).
  Evidence: F1.4. *Undecided.*
- **D5 — Frame purity is overclaimed; reconcile it.** `store.js:61-77` asserts "a frame
  is a pure function of the model (and thus of the Msg log → replayable)," yet the render
  path reads ≥5 module-global live stores not reproduced by replaying Msgs (jobs, diag-log,
  hub, terminal sessions, theme cache). Options: (a) correct the claim to state the real
  boundary ("frame = f(model + named live stores); replay reproduces model, not live
  stores"); (b) bring the live stores under TEA — a `Sub` pushes samples into the model via
  Msgs so the model holds the latest snapshot and the frame is genuinely `f(model)`.
  Evidence: F2.1. *Undecided.*
- **D6 — `render(model = getModel())` default.** The view self-fetches the global model
  when not threaded (`paint.js:665`), so its signature isn't pure-by-construction. Finish
  threading the model through all call sites and drop the default, or keep it and document
  why. Evidence: F2.2.
  **RESOLVED (drop default)** — `render(model)` and `renderTerminalOverlay(model, …)` no longer
  default to `getModel()`; the signatures are pure-by-construction. The render-queue seam (a
  pure leaf, invokes callbacks arg-less) is wired with model-fetching THUNKS
  (`render: () => render(getModel())`, `overlay: () => renderTerminalOverlay(getModel())`) — the
  correct runtime boundary for a deferred repaint (reads the latest model at paint time). Direct
  callers threaded: `suspend.js` routes through the `paintNow` seam; `tui.js`'s 250ms timer passes
  `getModel()`. Test harness threads it too (smoke re-exports a `() => render(getModel())` wrapper;
  test-live-render threads `getModel()`). Suite 96/96, smoke 11/11, acyclic, benches parity.
- **D7 — Single-writer violation for the layout slice (renderer-as-writer).** The paint
  pass writes `layoutSlice.paneBounds` (and the viewer writes `paneBounds.detail.tabs`)
  into Component slices during render (`paint.js:16-23`), so the layout slice has a second
  writer besides the layout Component's `update`. Keep (publish geometry from paint, freeze
  tests whitelist the fields) vs relocate `paneBounds` out of the slice into render-local
  state / route it via a Msg. Evidence: F2.3. *Undecided.*
- **D8 — Theme two-store.** `model.theme` (name, source of truth) + `leaves/themes.active`
  (palette object cache), one-way-synced by the `set_theme` effect (`effects.js:240`).
  Render reads the cache, not `model.theme`. An instance of D5 (cache not reproduced on
  replay). Keep the injected cache vs pass the resolved palette through render args.
  Evidence: F2.4. *Undecided.*
- **D9 — Finish the route-read elimination in the root reducer, or accept 2 residual reads.**
  The reducer header self-describes as "ALMOST a pure function of (model, msg)"
  (`reducer.js:27`): two `route.componentForPanel(<constant>)` reads of the ownership
  registry remain (`:1012` set_config, `:1034` reset_group_context). The handler-stamped
  bundle pattern (already applied to the focus arms) would remove them. Drive-to-empty vs
  bless-the-two. Evidence: F3.1.
  **RESOLVED (drive-to-empty)** — both reads eliminated via the handler-stamp pattern. The
  reducer is now a pure function of (model, msg): `set_config` reads `msg.csOwner`,
  `reset_group_context` reads `msg.owners` (`{ panelType: ownerName }`), both resolved by the
  impure-shell dispatchers and stamped on the Msg. New `route.resetGroupOwners()` is the single
  source of the reset panel-list + owner resolution; the groups-cascade path threads `resetOwners`
  through the same groups ctx as `viewerTarget` (D10). *Rejected an earlier "wrap by panel-type,
  let the fanout resolve" approach* — it silently mis-routes (`getPrimaryByKind` is keyed by
  Component NAME, not panel-type: `containers`→docker primary doesn't resolve) and floods the
  "unknown Component" diagnostic with expected noise. Suite 96/96, smoke 11/11, acyclic, benches parity.
- **D10 — Make `groups.js` `update` pure (it reads route topology today).** `_groupChangeCmds`
  calls `route.resolveTarget('viewer')` (`groups.js:201-202`) from `update`. Stamp the
  resolved viewer target onto `msg.ctx` in the groups dispatcher (mirrors the root reducer's
  blessed-A fix and `layout.js`), so the arm reads `ctx.viewerTarget`. Recommended:
  do it (it's a true impurity, not a stylistic one). Evidence: F3.2.
  **RESOLVED** — `viewerTarget` now resolved by the impure-shell dispatchers (`nav-state.js`
  `_groupsCtx`, `actions.js`, and `dispatch.js` `navSelect` → threaded through the reducer's
  `nav_select` arm into the `groups_selected` ctx); `_groupChangeCmds` reads `ctx.viewerTarget`
  and the false "Reducer-pure" comment is now true. Suite 96/96, benches parity.
- **D11 — Unify the "refresh viewer info" pathway.** Two ways reach the same effect: the
  reducer-emitted `show_selected_info` Cmd (correct) and the imperative
  `showSelectedInfo()` / `redraw()` handler helpers that resolve route + dispatch
  (`dispatch.js:83-108`). Sweep the imperative call sites onto the Cmd so one gesture →
  one Msg → reducer-decided cascade. Evidence: F3.3. *Undecided.*
- **D12 — Decompose the reducer monolith (cohesion, not purity).** 1,055 LOC / 59-arm
  switch / all Cmd descriptors + the modal sub-machines (confirm/prompt/copy/cmdline/
  register-popup) inline. Consider nested sub-`update`s per modal sub-model (canonical TEA
  scaling) vs keeping the flat switch (also legitimate). Evidence: F3.4. *Undecided.*
- **D13 — Subscriptions: model-driven reconciliation vs mount-time-static.** Subs are wired
  once at Component mount (`state.js:47-65`), topic-keyed + deduped, never torn down
  (except app exit), and their existence can't depend on model state. Canonical TEA
  re-evaluates `Model → Sub Msg` each update and reconciles. The code self-admits "no
  teardown yet … the framework is now SHAPED for" one. Evolve toward model-driven
  start/stop (+ pane-dispose unsubscribe), or keep static and document the boundary.
  Evidence: F4.1. *Undecided.*
- **D14 — The PTY/terminal pane is a non-TEA island; bound it explicitly or model it.**
  PTY `onData` mutates the off-model xterm buffer and calls the render hook directly
  (`terminal.js:94-96`), bypassing the Msg loop; the rendered content is never in the model
  and isn't reproduced by replay. Accept as an explicitly-documented boundary (xterm.js owns
  terminal emulation) vs route PTY state through the model. Evidence: F4.2. *Undecided.*
- **D15 — The 250ms blind repaint timer (`tui.js:306`).** An always-on wall-clock repaint,
  not state-driven — a safety net for off-model xterm changes that arrive without an
  `onData` event. Tied to D14: keep as a bounded safety net (document why), or eliminate it
  if PTY state becomes observable/event-driven. Evidence: F4.3. *Undecided.*
- **D16 — Finalizer writes derived viewport geometry (`viewer.innerH`) straight into the
  slice — route it via a Msg or relocate it.** `fanout.js:123`
  (`route.setInstanceSlice(viewerTab, {...vs, innerH})`) bypasses the Msg channel and the
  viewer's own `update`, while the adjacent scroll-clamp in the *same* finalizer routes
  through a `set_scroll` Msg (`nav-state.js:101`). Same family as D7 (`paneBounds`): both
  are runtime-computed derived viewport geometry written into slices. **Resolve D7 + D16
  together** — either both go via Msgs, or both move to render/finalizer-local state out of
  the slices. Evidence: F5.1. *Undecided.*
- **D17 — Remove the unconsumed broadcast `hub` Msg, or keep it as a documented (unused)
  extension point.** Every `hub.publish` synchronously fans a `{type:'hub'}` Msg to *every*
  instance (`hub.js:124`, `fanout.js:49` BROADCAST_TYPES), but **no Component's `update`
  consumes it** (grep-confirmed) — so each publish runs N no-op updates + a depth-0
  finalizer purely as overhead; the actual repaint comes from the separate
  `onUpdate → scheduleRender`. Drop it (YAGNI) vs keep + document the cost. Evidence: F5.2.
  **RESOLVED (drop)** — removed the `_dispatch({type:'hub'})` emit from `hub.publish`, the
  now-dead `setDispatch`/`_dispatch` seam in `hub.js`, the `hub.setDispatch` wiring in
  `fanout.js`, and `'hub'` from `BROADCAST_TYPES` (down to `refresh`/`action`). Hub publishes
  now reach observers solely via the `onUpdate → scheduleRender` subscription (renderer reads
  hub data live); the event-log recorder is untouched. Living docs swept (PRINCIPLES.md §Msg
  routing + example, PLUGINS.md skeleton + Msg table). Suite 96/96, acyclic both modes, benches
  parity. (`action` is also update-unconsumed but low-frequency + user-triggered — out of scope.)

---

## Pass 1 — Architecture / file-layout → TEA layer mapping

### Ground truth (source-derived, not docs)

Source root `js/`. Top-level layers and their evident intent:

```
app/       boot + CLI orchestration (top)
model/     root model store (mutable ref behind getModel/setModel)
dispatch/  control/ (input→Msg) + update/ (reducer) + runtime/ (effects, fanout, stream)
panel/     Component framework + navigator/ viewer/ monitor/ Components
overlay/   modal UI render fns (state lives in model.modal)
feature/   workflow / side-effecting orchestration
io/        terminal, PTY, logging
parser/    config parse + schema
render/    paint.js + footer.js (impure view orchestration)
leaves/    30 modules / ~6.1k LOC declared "bottom of import graph"
ports/     2 injection seams (feature-host, panel-host)
```

TEA element homes (verified): **Model** `model/store.js`; **Msg/Cmd descriptors** +
**root `update`** `dispatch/update/reducer.js`; **Component `update`** in each
`panel/**` Component; **view** `render/paint.js` + `leaves/draw.js` family; **Cmd
execution** `dispatch/runtime/effects.js`; **Sub/event sources** `dispatch/control/input.js`
+ per-Component `subscriptions()` wired via `leaves/hub.js`; **runtime/loop** split (see F1.4).

The dispatch split (`control` = Sub-ish input→Msg, `update` = reducer, `runtime` = Cmd
performer) is a genuinely clean TEA mapping and the dep-walker reports the module layer
graph acyclic. The findings below are about *where the purity/loop boundaries actually
fall*, not about cycles.

---

### F1.1 — `leaves/` conflates "pure" with "bottom-of-import-graph" — `DECISION` (D1)

**Observed.**
- `model/store.js:9` calls the tier "a pure leaf"; the directory's de-facto contract
  (and most of its 30 modules — `geometry`, `ansi`, `search`, `arrange`, `nav`,
  `selector`, …) is pure, stateless transforms.
- But `leaves/hub.js` is a **stateful** pub/sub bus: module-level `buffers`, `subs`,
  `windowCache`, `nextToken` (`hub.js:41-49`), mutated by `publish`/`subscribe`/
  `unsubscribe`. Its header (`hub.js:13-14`) states the operative definition outright:
  *"It's stateful (subscribers, ring buffers) but stateful ≠ non-leaf — a leaf is just
  the bottom of the import graph."*
- And `leaves/render-queue.js` is **stateful + effect-triggering**: module latches
  `_renderFn`, `_renderPending`, … (`render-queue.js:29-34`), a `setTimeout`
  (`:51`), and `paintNow()`/`scheduleRender()`/`scheduleOverlay()` that *invoke the
  paint callback* — i.e. drive terminal I/O (`:48-62`). Header claims "Zero dependencies."

**Deep analysis.** Two distinct properties are being collapsed into one directory name:

1. **Purity** — "this never mutates shared state and has no side effects." This is the
   *load-bearing* TEA property: it's what lets `update` be replayable and `view` be a
   pure function of the model. It is the contract a caller cares about when deciding "may
   I call this from a reducer?"
2. **Import position** — "this imports nothing upward." This is a *dependency-graph*
   property that the dep-walker enforces. It is real and useful, but it is **orthogonal**
   to purity: `hub.js` and `render-queue.js` prove a module can be bottom-of-graph while
   being stateful and effectful (the upward calls are injected via `setDispatch`/
   `setRenderers` seams, which is exactly what keeps them at the bottom).

The project has *chosen* definition 2 for the `leaves/` boundary, which is internally
consistent and is what makes the acyclic graph achievable. The cost is at the **reader's
contract**: the name `leaves/` + the "pure leaf" comment + 26 genuinely-pure siblings all
signal "safe, pure," yet two residents are neither. A contributor who internalizes
"leaves are pure" and then calls `hub.publish()` or `scheduleRender()` from inside a
reducer or a pure draw helper introduces an effect / shared-state read into code TEA
needs to keep pure — and nothing in the layout warns them. (This is not hypothetical for
`hub`: see **F1-FWD-a**.) In canonical Elm-style layouts, *purity* is the boundary that
gets a name and a wall; "bottom of the graph" is a consequence, not the label.

**Not a surface fix.** Renaming `hub.js`'s comment, or moving one file, doesn't resolve
it — the question is which property the bottom tier is organized around. → **D1.**

---

### F1.2 — `leaves/` is a flat domain grab-bag — `DECISION` (D2)

**Observed.** 30 modules, ~6,145 LOC, organized solely by "bottom of graph." Distinct
domains co-located with no sub-structure (`wc -l js/leaves/*.js`):
- **Layout editor** — `free-config.js` 320, `free-config-core.js` 392,
  `free-config-mouse.js` 644, `free-config-pool-drag.js` 288 → **~1,644 LOC, one feature.**
- **Tab state** — `pane-tabs.js` 864 (largest single leaf), `tab-drag.js` 133.
- **Render primitives** — `draw.js` 351, `painter.js` 133, `scrollbar.js` 26, `ghost.js` 19,
  `render-queue.js` 73.
- **Pub/sub** — `hub.js` 288.
- **Text** — `ansi.js` 248, `search.js` 200.
- **Input registries** — `keybindings.js` 159, `hotkeys.js` 31, `context-menu.js` 150,
  `modes.js` 101.
- plus `geometry`, `pool`, `arrange`, `nav`, `pane`, `register`, `selector`, `menu`,
  `cmdline-split`, `regex-guard`, `sh-escape`, `themes`.

**Deep analysis.** This is the mirror image of the `panel/{navigator,viewer,monitor}`
tree, which *is* domain-organized and easy to navigate. `leaves/` instead groups by a
technical property, so "where is the layout editor?" or "where are the render
primitives?" resolves to "scattered across a flat 30-file directory next to unrelated
modules." The 864-LOC `pane-tabs.js` and the ~1.6k-LOC `free-config*` cluster are
*subsystems*, not leaf utilities, that happen to be import-bottom. TEA says nothing about
this directly, but the general layout principle — group by what changes together / by
domain, keep cross-cutting disciplines (purity) orthogonal — is violated. Tied to D1:
once "bottom of graph" stops being the *name's* meaning, the natural move is to sub-group
the genuinely-pure transforms by domain (`leaves/render/`, `leaves/layout-editor/`,
`leaves/text/`, …) or relocate domain clusters beside their consumers. → **D2.**

---

### F1.3 — view layer is bisected across `render/` and `leaves/`, and the split axis leaks — `DECISION` (D3)

**Observed.** Rendering is in two top-level homes: `render/` (`paint.js` 803, `footer.js`
230) and `leaves/` (`draw.js`, `painter.js`, `scrollbar.js`, `ghost.js`, `render-queue.js`).
The apparent split axis is purity: pure primitives → `leaves/`, impure orchestration →
`render/`. But `leaves/render-queue.js` is impure (setTimeout + triggers paint, F1.1) yet
sits on the `leaves/` side.

**Deep analysis.** "Where does rendering live?" having two answers is tolerable *if* the
dividing line is crisp and meaningful. Here the line is "purity," which is a reasonable
axis — except the one impure module on the pure side (`render-queue.js`) breaks it, so the
real rule a reader must learn is "rendering is split by purity, except the debounce queue,
which is impure but lives with the pure ones because it's import-bottom." That's the F1.1
conflation surfacing again at the view layer specifically. → **D3** (decide the axis and
make `render-queue.js` obey it, or document the carve-out at the boundary).

---

### F1.4 — the TEA "program/runtime" loop has no single home — `DECISION` (D4)

**Observed.** The core "Msg → update → commit → perform Cmds → schedule view" cycle is
distributed across three files:
- `dispatch/control/dispatch.js` — `applyMsg(msg)` runs `runtime.update(getModel(), msg)`,
  `setModel(next)`, then `runEffects(cmds)` (the *root*-Msg loop).
- `dispatch/runtime/fanout.js` — `_runInstance` runs a Component's `update(msg, slice)`,
  `setInstanceSlice`, `runEffects` (the *Component*-Msg loop), **plus** the post-dispatch
  finalizer (`_finalizeDispatch`: instance reconcile, scroll clamp, viewer `innerH`, PTY
  reconcile) gated on `_dispatchDepth === 0`.
- `dispatch/runtime/effects.js` — `runEffects` + the effect registry shared by both loops.

**Deep analysis.** Canonical TEA has *one* identifiable runtime/program that owns the
loop. Here there are **two parallel pumps** — a root-Msg pump in `control/` and a
Component-Msg pump in `runtime/fanout.js` — sharing one effect runner. That two-pump shape
may be *essential* (the root model and the per-instance Component slices are genuinely
different state homes with different writers), but the layout doesn't make that intent
legible: the root loop is filed under `control/` (which otherwise means "input→Msg"),
while the Component loop + the big impure post-update finalizer are filed under `fanout`
(a name about *routing*, not about *being the after-update hook*). A reader cannot point
at "the runtime loop." Deep question for the fix: is the duplication essential (then name
it — e.g. a single `runtime/loop.js` that hosts both the root and instance dispatch and
the finalizer hook), or is it accidental (then unify)? Either way the finalizer's home is
suspect — it is "the runtime's after-update phase," not "fan-out." → **D4.** (Cross-refs
Pass 5, which will trace the routing in detail.)

---

### F1.5 — mapper claimed two `ports/` dirs; only one exists — `NOTE`

`js/panel/ports/` is empty/absent; the injection seams live solely in `js/ports/`
(`feature-host.js`, `panel-host.js`). The first mapping agent reported `panel/ports/`
holding those files — wrong. No architecture defect; recorded only as evidence that
agent/summary output must be verified against source before it becomes a finding
(which is why every F-item above cites read `file:line`, not the map).

---

### Forward-pointers (to verify in later passes)

- **F1-FWD-a (→ Pass 4/5).** `hub.publish()` synchronously calls `_dispatch(...)` and
  `_recorder(...)` (`hub.js:120,124`) — so `publish` is an *effect trigger*, and consumers
  read mutable buffers via `hub.snapshot()/history()`. **If `render` (or any Component
  `render`) reads `hub.snapshot()` at frame time, the frame is not a pure function of the
  model**, which would contradict the `model.now`/`model.theme` replayability claims in
  `store.js:61-77`. Must trace who reads the hub and when.
- **F1-FWD-b (→ Pass 2/4).** `render/paint.js` reportedly defaults its `model` arg to
  `getModel()`. A pure `view` should *receive* the model, never fetch it. Defaulting to a
  global read makes `render` callable impurely; verify and assess.
- **F1-FWD-c (→ Pass 2).** The model is a **module-global mutable ref** (`store.js:147`)
  read everywhere via `getModel()`. Re-derive whether the "impure-shell reads, pure core
  threads" boundary actually holds, independent of the existing ledger's verdict.
- **F1-FWD-d (→ Pass 3).** `reducer.js` is ~1,055 LOC hosting the root `update`, **all**
  Cmd descriptors, and the root state writer. Assess monolith/cohesion vs TEA's
  nested-update decomposition.

---

## Pass 2 — Model & state ownership

### Ground truth (source-derived)

State in this app lives in **three** kinds of home, not one:

1. **Root model** — `model/store.js`, a single object behind a mutable ref
   (`_modelRef`, `:147`), reducer is sole writer, read via `getModel()`.
2. **Component slices** — the per-instance store in `panel/route.js`; each Component's
   `update` is the sole writer of its own slice.
3. **Module-global mutable stores** — a dozen `let`/`Map`/array module locals across
   `leaves/`, `io/`, `feature/`, `overlay/`, `dispatch/` that hold genuine app/UI state
   outside both of the above. Enumerated (writer in parens):
   - `leaves/hub.js` — `buffers`/`subs`/`windowCache` pub/sub bus (producers via `publish`)
   - `leaves/themes.js:121-122` — `active`/`activeName` palette cache (`set_theme` effect)
   - `feature/jobs.js:24` — `_jobs` live job registry (stream/terminal/action-runner)
   - `feature/history.js` — id counter + hub-backed history
   - `io/diag-log.js:35` — `_buf` diagnostics ring (effects via `record`)
   - `io/event-log.js` — `_buf` event/Msg log ring (dispatch boundary + hub)
   - `io/terminal.js:27` — `sessions` PTY map (effects; **also written during render**)
   - `overlay/copy.js:28` — `_options` copy-thunk closures (cmdline/copy collect)
   - `dispatch/control/cmdline.js:30` — `_full` cmdline run-closures
   - `render/paint.js:186` — `_frame` compositor diff cache (render)

This pass treats #1+#2 as the intended TEA state and asks: how much of #3 is genuine
app state that the *render* depends on — i.e. how far is the model from being the single
source of truth a frame is computed from?

---

### F2.1 — The frame is **not** a pure function of the model; replayability is overclaimed — `DECISION` (D5)

**Observed.** `store.js:61-77` states the invariant explicitly: the render path reads
`model.now` instead of `Date.now()` "so a frame is a pure function of the model (and thus
of the Msg log → replayable)." But the render path reads several module-global live stores
that are **not** part of the model:
- `overlay/jobs.js:97,110` → `jobs.list()` (the `feature/jobs.js` `_jobs` Map). The jobs
  module's own header (`feature/jobs.js:1-8`): *"no slice, no Msgs — same out-of-TEA store
  rationale … The Running overlay reads `list()` at render time."*
- `overlay/diag-log.js:69` → `diag.snapshot()` (the `io/diag-log.js` `_buf`).
- `panel/navigator/history.js` → `hub.history(TOPIC)` at frame time.
- `render/paint.js:580`, `render/footer.js:26` → `getSession(id)` (PTY session buffers).
- `render/footer.js:225`, `overlay/cmdline.js:51` → `theme()` (the `leaves/themes` cache).

**Deep analysis.** Replaying the Msg log reconstructs the **model** (Msgs → reducer →
model), but it does **not** re-run effects (effects do real I/O — spawn processes, read
PTYs). So on replay the jobs registry, diag buffer, hub buffers, PTY sessions, and theme
cache would be **empty / at module-default**, while the reconstructed model might say
"jobs overlay open" or "theme=dracula." The replayed frame would therefore differ from the
original. **The frame is a pure function of `(model + those live stores)`, not of `model`
alone** — so the invariant `store.js` advertises is narrower than stated, and the
`model.now`/`model.theme` work (done precisely to achieve frame-purity) is necessary but
not sufficient: these other live reads punch straight through it.

This is a genuine design tension, not a careless bug: the jobs/diag overlays read live
*on purpose* (`store.js:116-123` documents that they deliberately don't snapshot, so a
warning arriving while the window is open shows live). Snapshotting into the model at open
time would make them stale. So the real question is which way to resolve the mismatch
between the claim and the code. **Severity calibration:** the cost is only as large as the
reliance on frame-level replay. If replay is used merely to reconstruct *model* state
(likely), the overclaim is a documentation/clarity defect. If frame-identical replay is an
actual tested feature, this is a correctness gap. Pass 5 will check whether anything
replays frames.

**Not a surface fix.** Either correct the stated invariant or move the live stores under
TEA (a `Sub` that feeds samples into the model via Msgs, the canonical Elm-style answer
for external event streams). → **D5.**

---

### F2.2 — `render(model = getModel())` self-fetches the global model — `DECISION` (D6)

**Observed.** `render/paint.js:665`: `function render(model = getModel())`. The module
imports `getModel` at `:53`; the comment (`:667-672`) calls the default a v0.5 migration
artifact, "to be removed once all call sites thread the model."

**Deep analysis.** A TEA `view` is `model → frame`; it should *receive* the model, never
reach out and fetch the ambient global. While the default exists, `render()` is callable
with zero args as an impure global reader, and the signature doesn't enforce purity by
construction — a contributor can call `render()` from anywhere and it silently binds to
"whatever the current model is," which is exactly the stale-ref hazard `store.js:144-146`
warns about. This is low-severity (the real call sites do thread it) but it keeps the
view's purity a convention rather than a guarantee. → **D6** (finish the migration + drop
the default, or document the carve-out).

---

### F2.3 — Single-writer broken for the layout slice: render writes geometry into it — `DECISION` (D7)

**Observed.** `render/paint.js:16-23` (module header) documents the "renderer-as-writer"
pattern: `renderNormal/Half/Full` populate `layoutSlice.paneBounds` directly during the
paint pass, and "the viewer Component does the same for `paneBounds.detail.tabs`." Pure-TEA
freeze tests on the layout slice must *whitelist* these renderer-written fields.

**Deep analysis.** Two TEA rules collide here. (1) `view` must not mutate the model — but
the paint pass writes into `layoutSlice`, which is a Component slice (part of the model
tree). (2) Each slice has a single writer — but the layout slice now has two: the layout
Component's `update` **and** the renderer. The rationale (geometry is a pure function of
view state, so recompute-and-publish each frame instead of routing a Msg) is reasonable
for *avoiding a per-frame Msg*, but the chosen mechanism — writing the result back into the
owned slice — is what breaks both rules, and the giveaway is that the freeze tests need a
whitelist to tolerate it. A cleaner shape keeps the same recompute-each-frame behavior
without the violation: hold `paneBounds` in **render-local** state (it's render-derived and
only render + hit-tests consume it), so it never enters the slice at all. That's a
structural change with consumers (hit-tests read `paneBounds` via geometry accessors), so
it's a decision, not a surface edit. → **D7.**

(Note: the `_frame` compositor diff cache at `paint.js:186` and the per-session
`prevFrame`/`prevViewportY` written during render at `paint.js:601,608,619` are a *milder*
case — they are private render-pipeline memo, invisible to the model and the Msg log. The
only smell is that `prevFrame` lives **on the `io/terminal` session object**, coupling the
compositor's diff state to the PTY-session struct owned by another layer; worth keeping the
diff cache render-local too, but lower priority than the slice write.)

---

### F2.4 — Theme stored twice (model name + leaf palette cache) — `DECISION` (D8)

**Observed.** `model.theme` holds the theme **name** (source of truth, `store.js:73-77`).
`leaves/themes.js:121-127` holds `active` (the palette object) + `activeName`, mutated by
`setTheme()`, which is called only by the `set_theme` effect (`effects.js:240`). Render
reads the **cache** via `theme()` (`footer.js:225`, `overlay/cmdline.js:51`), never
`model.theme`.

**Deep analysis.** The two-store exists because the pure render leaves can't import the
model (that would invert the dependency / form a cycle), so the palette is delivered to
them via a module cache synced from `model.theme` by an effect. It's internally consistent
*and* it's a concrete instance of **F2.1/D5**: the cache is not reproduced by replaying
Msgs, so a replayed frame loses the theme. The one-way sync is also fragile to a second
writer — any future path that sets `model.theme` without emitting `set_theme` leaves render
on the stale palette (today the reducer is disciplined, but nothing structural enforces
it). Canonical alternative: resolve the palette where the model *is* readable (the impure
shell / paint entry) and **pass it through the render call args** alongside the model, so
the pure leaves receive it as data and no module cache exists. → **D8.**

---

### Carried forward / resolved from Pass 1

- **F1-FWD-a** (hub read at render) — **confirmed** and folded into F2.1 (hub is one of the
  five live stores). Pass 5 still owns the routing detail of `hub.publish` → Component Msg.
- **F1-FWD-b** (`getModel()` default in render) — **confirmed**, promoted to F2.2.
- **F1-FWD-c** (global mutable model ref) — examined: the mutable ref itself is a deliberate
  container the dispatch boundary swaps; the *real* ownership issue isn't the ref but the
  off-model stores the view reads around it (F2.1). The ref is FINE **as a container**; the
  open question is the SoT fragmentation, captured in D5.
- **F1-FWD-d** (reducer monolith) — deferred to Pass 3 as planned.

---

## Pass 3 — `update`/reducer purity & shape

### Ground truth (source-derived)

- **Root reducer** `dispatch/update/reducer.js`: `function update(model, msg)` (`:191`),
  a 59-arm `switch (msg.type)`, returns `[nextModel, cmds]`. No `getModel()`/`Date.now()`/
  `Math.random()` executed in the body (grep clean except the module-export of `getModel`
  and one deferred `require('../../panel/navigator/groups')` at `:294`). Imports `route`
  (`panel/route`) directly at `:63`.
- **Component `update`s** (signatures verified by read/grep): `layout.js:272`,
  `docker.js:295`, `files.js:402`, `config-status.js:422`, `groups.js:241`,
  `history.js:131`, `viewer.js:370`, plus trivial arrows `actions.js:115`, `stats.js:199`
  — **all `(msg, slice)`; none takes a third `model` arg.** The `(msg, slice)` shape (never
  `(msg, slice, model)`) is upheld everywhere, and root facts are threaded via Msg payload
  (`msg.filesModel`, `msg.viewerModel`, `msg.ctx`, `msg.entries`, `msg.route`) — the
  augment/bundle pattern. **This part of the contract is solid**; the findings below are
  the residual leaks a drive-to-empty review should still surface.

---

### F3.1 — Root reducer is self-admittedly "ALMOST pure": 2 residual route-registry reads — `DECISION` (D9)

**Observed.** `reducer.js:27` states the reducer is "ALMOST a pure function of (model,
msg)." The two residual reads are `route.componentForPanel(<constant>)`:
`'config-status'` (`:1012`, set_config arm) and the panel type in `reset_group_context`
(`:1034`). `route.wrap(...)` (a pure Msg constructor) is used widely and is fine.

**Deep analysis.** `componentForPanel(x)` reads the panel→Component **ownership registry** —
runtime state populated at boot in `panel/route`. Even with a literal argument, the
*result* depends on which Components are registered, so it is a read of mutable
module-global state from inside `update`; the function is not pure of the registry. The
header rationalizes it as "a static ownership-registry lookup, NOT a focus/topology read,"
which is true *relative to* the (worse) focus reads that were eliminated — but "static"
overstates it (the registry is built at runtime and is exactly the kind of ambient state a
pure reducer shouldn't consult). The fix is the pattern the codebase already chose for the
focus arms: the **handler stamps** the resolved owner onto the Msg (the bundle), and the
arm reads `msg.route`. It simply wasn't extended to these two arms. Leaving them is a
deliberate stop-short; whether that's acceptable is a values call (drive-to-zero vs
diminishing returns). → **D9.**

---

### F3.2 — `groups.js` `update` is genuinely impure: reads route topology at reduce time — `DECISION` (D10)

**Observed (first-hand).** `groups.js` `_groupChangeCmds(res, ctx)` calls
`route.resolveTarget('viewer')` at `:201-202` and emits a Msg wrapped for that target.
This helper is invoked from `update` via `_cascadeCmds` (`:226`, used by `toggle_group`
`:271` and `toggle_groups_tab` `:277`) **and** directly from the `groups_selected` arm
(`:262`). The helper's docstring at `:191` asserts **"Reducer-pure (ctx threaded, no
getModel())."**

**Deep analysis.** `resolveTarget('viewer')` resolves the focused-or-sticky-or-first viewer
pane — a **focus/topology** read of live layout state. So a Component `update` consults
runtime topology to decide its cascade. This is precisely the anti-pattern (`reducer reads
producer/topology state`) that the root reducer's "blessed-A elimination" removed — it
survives here. Worse than the root case: the docstring **claims purity it doesn't have**,
so a reader auditing `groups.js` would (and the first audit pass nearly did) wave it
through. The data needed is just "which viewer pane should receive `viewer_reset_chrome`,"
which the dispatcher knows; the existing `msg.ctx` bundle (already carrying `groups /
currentGroup / paneMenuMode`, `:232`) is the natural place to stamp `viewerTarget`, after
which `_groupChangeCmds` reads `ctx.viewerTarget` and becomes genuinely pure. Recommended
to fix (it's a real impurity + a false comment), but it touches the groups dispatcher and
both cascade callers, so it's a decision, not a one-liner. → **D10.** *(Also fix the
docstring regardless of the chosen path — it currently misdescribes the code.)*

---

### F3.3 — Dual pathway for "refresh viewer info"; imperative path orchestrates in the handler — `DECISION` (D11)

**Observed (first-hand).** Two routes reach the same effect:
- **Reducer-emitted Cmd** — `{ type: 'show_selected_info' }` returned by reducer arms
  (e.g. `groups.js:227` in `_cascadeCmds`; the root reducer emits it too). This is the
  TEA-correct shape: the reducer decides the cascade.
- **Imperative handler helper** — `showSelectedInfo(paneId)` (`dispatch.js:83-89`) resolves
  `route.resolveTarget('viewer')` and calls `dispatchMsg(...)` directly; `redraw()`
  (`dispatch.js:104-108`) = `showSelectedInfo()` + `render()`.

**Deep analysis.** The `navSelect` handler comment (`dispatch.js:111-117`) documents the
intended discipline outright: pre-R6 it "imperatively dispatched 2-3 Msgs … the
orchestration was invisible from the reducer's view," and R6 collapsed it to one Msg whose
reducer emits the cascade. That discipline is the right one — but it wasn't applied
everywhere: `showSelectedInfo()`/`redraw()` remain as imperative helpers some handlers call
*after* a separate `applyMsg(...)`, so for those gestures the cascade is decided in the
handler (two dispatch entry points for one user action) rather than the reducer. Route
resolution itself landing in the impure shell is fine; the smell is the **handler
sequencing two state-changing steps**, and the **redundancy** of having both a Cmd and a
hand-callable helper for one effect (drift risk: the two can diverge). The fix is to sweep
the remaining imperative callers onto the `show_selected_info` Cmd, leaving one pathway.
→ **D11.** (Cross-refs Pass 1 F1.4 — the handler layer carrying cascade-decision logic is
the same "runtime loop smeared across control/" smell, seen from the reducer side.)

---

### F3.4 — Reducer monolith & inline modal sub-machines — `DECISION` (D12)

**Observed.** `reducer.js` is 1,055 LOC: the 59-arm root `switch`, all Cmd-descriptor
construction, and the modal sub-models' arms (confirm `:303-328`, prompt `:330-378`, copy
`:380-410`, register-popup `:412-497`, cmdline `:498-621`) all inline in one function/file.

**Deep analysis.** This is **not** a purity violation — a large flat `update` switch is a
legitimate and common TEA shape, and the arms here are clean return-new transforms. The
only question is cohesion at scale: the modal editing buffers live under `model.modal.*`
and each modal is a self-contained little state machine (open/key/nav/submit/cancel).
Canonical TEA scales a growing `update` by **nested sub-updates** — `updateCmdline(msg,
model.modal.cmdline) → [nextCmdline, cmds]` delegated from the root arm — which would carve
the 1k-LOC switch into the root chrome reducer plus a handful of focused modal reducers,
each independently testable. That's an organizational improvement with a real cost
(indirection, more files) and no correctness change, so it's purely a judgment call —
hence a decision, not a finding-to-fix. → **D12.**

---

### Resolved from earlier passes

- **F1-FWD-d** (reducer monolith) — examined here as F3.4.
- Net Pass-3 verdict: the **shape** contract `(msg, slice) → (next, cmds)` is fully upheld
  (no `(msg, slice, model)` anywhere; root facts threaded via Msg). The **purity** contract
  has two real leaks — `groups.js` (F3.2, with a false "pure" comment) and the root
  reducer's 2 registry reads (F3.1) — plus one structural redundancy (F3.3).

---

## Pass 4 — Effects (`Cmd`) & subscriptions (`Sub`); render purity

### Ground truth (source-derived)

- **Effect channel** `dispatch/runtime/effects.js`: one registry `_handlers` (`:24`),
  `runEffects(effects)` looks up by `eff.type` and calls `fn(eff, host)` (`:59-77`).
  Unknown types are logged, not thrown (`:65-68`). The injected `_host` (`:42-57`,
  built lazily) carries `dispatchMsg`/`applyMsg`/`wrap`/`streamCommand`/… so handlers feed
  Msgs back without importing upward. A `_crossLayerDepth` guard caps re-entrant
  `apply_msg`/`dispatch_msg` at 32 (`:107-119`).
- **Subscriptions**: Components export a pure `subscriptions(paneDef)` (`stats.js:44-47`);
  `app/state.js:_wireSubscriptions` (`:47-65`) calls it at mount and `hub.subscribe(topic,
  {window, onUpdate: scheduleRender})`, deduped by `${topic}:${window}` in `_wiredSubs`.

**Verdict up front:** the **effect/`Cmd`** side is the strongest-conforming part of the
codebase — see F4.4/F4.5 (FINE). The TEA divergence is entirely on the **subscription /
external-event** side (F4.1–F4.3).

---

### F4.1 — Subscriptions are wired once at mount, not re-evaluated against the model — `DECISION` (D13)

**Observed.** `_wireSubscriptions` (`state.js:47-65`) runs each Component's
`subscriptions(paneDef)` at mount, subscribes to the hub topics, and records them in a
`_wiredSubs` dedup set that is **never cleared post-boot** (`:68` `_resetSubscriptions` is
test-only). The subscription factory is pure of the model (`stats.js:44-47` keys only on
`paneDef`). A comment at `state.js:42-45` states plainly: "no teardown yet — there is no
post-boot topic-change or pane-dispose-unsubscribe path today; growing one is a follow-on
the framework is now SHAPED for."

**Deep analysis.** Canonical TEA models subscriptions as `subscriptions : Model → Sub Msg`,
re-evaluated every update; the runtime **diffs** the returned set against the live set and
starts/stops the delta. That makes "what's subscribed" a pure function of current state —
a panel subscribes only while it should, and disposal automatically unsubscribes. Lazytui
instead treats subscriptions as **mount-time lifecycle hooks**, topic-keyed and global
(deduped across panes), model-independent and (except app exit) permanent. Consequences:
(1) a subscription stays live when its pane is off-screen / its group not current — the hub
keeps buffering work nothing is showing; (2) disposing a pane does **not** unsubscribe
(mitigated only because subs are topic-deduped and bounded by the distinct-topic count, so
it's a slow/bounded leak, not unbounded); (3) conditional subscriptions ("subscribe only
while visible") aren't expressible. This is a *defensible simplification* for a TUI with a
fairly static topic set, but it is a real departure from the canonical Sub, and the code
itself flags the teardown gap as unfinished. → **D13.**

---

### F4.2 — PTY data bypasses the Msg loop into an off-model island — `DECISION` (D14)

**Observed (first-hand).** `io/terminal.js:94-96`: the node-pty `onData` callback writes
bytes into the (off-model) `@xterm/headless` buffer and calls `_renderHook()` (=
`scheduleOverlay`) **directly** — no Msg, no reducer. The render path then reads the xterm
buffer live (`paint.js:580`, F2.1) to paint the terminal overlay.

**Deep analysis.** This is the most concrete instance of the Pass-2 frame-purity theme
(F2.1) *and* a render-trigger that bypasses dispatch. In TEA terms, PTY output is an
external event stream that "should" be a `Sub` producing Msgs that update model state, with
the view rendering from that state. Here the terminal's entire state lives in xterm.js
(outside the model), updates outside the Msg loop, and triggers paint directly — so the
Msg log cannot replay a terminal pane, and two of the app's render triggers exist
(`applyMsg`-then-paint for everything else; `onData`→`scheduleOverlay` for PTY). The
pragmatic justification is strong (xterm.js *is* the terminal emulator; funnelling every
PTY byte through a Msg and into the model would be heavy and redundant). The issue isn't
that the choice is wrong — it's that this non-TEA island is currently **implicit**, glossed
by the same store.js purity claim it contradicts. The decision is whether to **name and
bound it** ("terminal panes are an explicitly non-TEA region; the model holds the PTY
*lifecycle* but not its screen contents; replay excludes terminal output") or invest in
modeling it. → **D14.**

---

### F4.3 — A 250 ms blind repaint timer drives render off the wall clock — `DECISION` (D15)

**Observed (first-hand).** `tui.js:301-306`: `setInterval(() => renderTerminalOverlay(),
250)`, commented as a "safety-net poll for terminal overlay — primary updates come from
xterm.write callback … This catches edge cases where internal state changes without parse
events. Always-on."

**Deep analysis.** This is a render triggered by elapsed time, not by a state change — the
opposite of "view is a function of model, repainted when the model changes." It is a direct
consequence of F4.2: because the terminal's state is off-model and can mutate without an
`onData` event (xterm internal state), nothing in the Msg/effect graph knows when to
repaint, so the app falls back to polling. The cost is largely bounded (the overlay paint
early-returns when no terminal tab is active, and the diff cache makes a no-change repaint
cheap), so this is a low-severity smell, but it is a genuine "render outside the loop"
and it only exists to paper over the off-model island. Resolving D14 (or getting a
change-signal out of xterm) would let this timer go. → **D15.**

---

### F4.4 — `Cmd`s are pure data descriptors; closures resolved by index — `NOTE` (FINE, with caveat)

**Observed.** Every effect is a plain `{type, ...fields}` descriptor; no closure is carried
in a Cmd. Where a closure is unavoidable (copy-menu content thunks, cmdline run-closures),
it is held module-side and the Cmd carries an **index**: `copy_commit {idx}` →
`_options[idx]` (`overlay/copy.js:25-28`, `effects.js` copy handler); `cmdline_run {sel}` →
`_full[sel].run()` (`dispatch/control/cmdline.js:30,65-67`).

**Deep analysis.** This correctly upholds "Cmds are serializable data" (a load-bearing TEA
property for the event log / replay), and is the right way to handle unavoidable closures.
The only caveat: the index is a pointer into a module-held table that must stay in lockstep
with the model projection it parallels (`model.modal.copy.options` / `…cmdline.matches`).
Today they're rebuilt together (cmdline rebuilds `_full` alongside `matches` each
keystroke), so they stay synced — but it is a *parallel state channel*, and a future change
that rebuilds one without the other would silently invoke the wrong closure. Worth a guard
or a test asserting the lengths/identities stay aligned. Not a defect today. **FINE.**

---

### F4.5 — Render emits no Msg / dispatch / model write — `NOTE` (FINE)

`grep` of `render/paint.js` for `applyMsg|dispatchMsg|setModel` is empty; the render-queue
seam is unidirectional (dispatch/overlay → render, never back, `render-queue.js:18-23`). So
on the **dispatch axis** the view is pure. Render's purity problems are confined to its
**reads** (off-model live stores, F2.1) and its one **write** (`layoutSlice.paneBounds`,
F2.3) — both already logged. No new finding. **FINE.**

---

### Addendum to F2.1/F2.4 — terminal dims are double-stored

The resize handler (`tui.js:314-328`) dispatches `term_resized` as a Msg (good — lands dims
in `model`/`layoutSlice.dims` for geometry) **but also** imperatively refreshes the
`io/term` `cols()/rows()` mirror, which "footer/overlay/panel renderers still read"
(`:315-321`) instead of `model.dims`. So terminal size lives in two places (model + io/term
mirror), and render reads the mirror — another instance of the off-model-read / two-store
family (F2.1, F2.4). Folded under **D5**.

### Resolved from earlier passes

- **F1-FWD-a** (hub fan-out at render) — the effect side is now clear: `hub.publish`
  synchronously fans a `hub` Msg via the injected `_dispatch` and the live read is at render
  (F2.1). The remaining routing-order detail (publish → Component Msg → render) is Pass 5.

---

## Pass 5 — Dataflow / message routing

### Ground truth (source-derived)

- **Routing.** A wrapped Cmd `{type:'msg', msg:{kind,msg}}` runs through the `msg` effect
  → `fanout.dispatchMsg` (`fanout.js:166`). Wrapped Msgs route to the owning instance and
  `_runInstance` → `comp.update(msg, slice)` → `route.setInstanceSlice(id, next)` →
  `runEffects(effects)` (`fanout.js:320-337`). Broadcast types (`refresh`, `hub`, `action`,
  `fanout.js:49`) fan to every instance.
- **Ordering (both pumps).** Root: `applyMsg` = `update` → `setModel(next)` →
  `runEffects(cmds)` (`dispatch.js:1002-1011`). Component: `_runInstance` =
  `update` → `setInstanceSlice` → `runEffects`. State commits **before** effects, so
  re-entrant cross-layer Cmds see fresh state. `_dispatchDepth` gates `_finalizeDispatch`
  to the depth-0 exit (`fanout.js:167-172`); cross-layer recursion capped at 32.

---

### F5.1 — The finalizer writes `viewer.innerH` directly into the slice (off-Msg), inconsistently with its own scroll path — `DECISION` (D16)

**Observed (first-hand).** In `_finalizeDispatch` (`fanout.js:93-157`):
- Scroll clamp: `syncPanelScroll(p.paneId, …)` → `setScroll` → `_navDispatch(…,
  {type:'set_scroll'})` (`nav-state.js:101`) — **routes through a Msg.** ✓
- Viewer innerH: `route.setInstanceSlice(viewerTab, {...vs, innerH})` (`fanout.js:123`) —
  **writes the slice directly**, bypassing the Msg channel and the viewer's `update`. ✗
- Instance reconcile (`_instanceReconciler()`, `:104`) and PTY `ensureSession/resizeSession`
  (`:145-147`) — lifecycle / off-model I/O, not model-state writes.

**Deep analysis.** Within one function, two viewport-geometry updates use two different
disciplines: scroll goes through `set_scroll` (the correct, single-channel way — and a
deliberate prior fix), while `innerH` is poked straight into the viewer slice. The direct
write means (a) **Msg is not the sole state-change channel** (the slice changes with no
Msg), and (b) the **viewer slice has two writers** — `viewer.update` and the finalizer
(single-writer violation). `innerH` is runtime-derived viewport geometry (a pure function
of committed layout + dims) cached on the slice — exactly the same category as
`layoutSlice.paneBounds` written by the renderer (F2.3/D7). So this is one problem with two
instances (renderer writes `paneBounds`; finalizer writes `innerH`), best resolved as one
decision: route both via Msgs (consistent with `set_scroll`), or relocate derived viewport
geometry out of slices into render/finalizer-local state. → **D16**, paired with **D7**.

---

### F5.2 — `hub.publish` broadcasts an unconsumed `hub` Msg to every instance — `DECISION` (D17)

**Observed (first-hand).** `hub.publish` synchronously calls `_dispatch({type:'hub', …})`
(`hub.js:124`); `hub` is a BROADCAST type (`fanout.js:49`) so `_dispatchMsgInner` runs
`_runInstance` for **every** instance (`fanout.js:229-237`). A grep for a `hub`-Msg consumer
across `panel/` finds **none** (`stats.update` is a passthrough; navigators handle only
their own Msgs). Separately, each matching subscriber's `onUpdate` fires
`scheduleRender()` (`state.js:62`).

**Deep analysis.** Each `hub.publish` does two things: (1) a synchronous, **untargeted**
broadcast Msg that runs N Component `update`s — all no-op for `type:'hub'` — then, at depth
0, a full `_finalizeDispatch`; and (2) the targeted `onUpdate → scheduleRender` that
actually causes the repaint (the renderer reads hub data live, F2.1). Publishes fire from
producers' (typically async, depth-0) effect handlers, so **every docker-stats /
config-status / monitor sample triggers N no-op updates + one finalizer pass**,
synchronously, for no functional effect. The broadcast is an *extension point* ("a Component
*could* pull hub data into its slice in `update`") that **no Component uses today**, paid
for on every sample. Both a dataflow-clarity smell (two notification mechanisms, one inert)
and a perf cost. Decision: drop the broadcast (rely on `onUpdate → render` + render-time
reads — YAGNI), or keep the hook and document that it's currently unused and costs N updates
+ a finalizer per publish. → **D17.**

---

### F5.3 — Routing, ordering, and re-entrancy are sound — `NOTE` (FINE)

Genuine strengths, recorded so the review isn't only negative: state commits **before**
effects on both pumps (re-entrant Cmds see fresh state, `dispatch.js:1009-1010` /
`fanout.js:326-327`); the depth counter correctly gates the finalizer to the outermost
dispatch (`fanout.js:171`); wrapped-vs-broadcast routing is cleanly discriminated and a flat
unwrapped Msg is logged + dropped (catches missed `wrap` sites rather than silently
mis-routing); cross-layer recursion is capped at 32 with a diagnostic. Solid TEA runtime
mechanics. **FINE.**

---

# Synthesis & priorities (review close — 5/5 passes done)

The shape contract is upheld (every `update` is `(msg, slice)`; root facts threaded via Msg)
and the runtime mechanics (effect channel, routing, ordering, acyclic module graph) are
sound. Findings cluster into six themes; **all 17 items (D1–D17) are decisions for the
maintainer — nothing was changed.** Rough priority by value/risk:

1. **State fragmentation & frame purity (largest, most conceptual).** D5 is the umbrella:
   the model is not the single source of truth and the frame is **not** a pure function of
   the model — render reads ≥5 off-model live stores (jobs, diag, hub, PTY sessions, theme
   cache; + the dims mirror), none reproduced by replay. Sub-instances: D8 (theme two-store),
   D14 (PTY off-model island), D15 (250ms blind repaint), D6 (`render` `getModel()` default).
   *Most likely resolution:* **correct the overclaimed invariant** and explicitly bound the
   non-TEA islands (PTY especially) — modeling them is heavy and their live-ness is
   intentional. The honest documentation fix is high-value, low-risk.

2. **Derived viewport geometry written into slices.** D7 (`paneBounds` by render) + D16
   (`innerH` by finalizer) — one problem, two sites; Msg-not-sole-channel + second-writer.
   Resolve together (route via Msg, or relocate out of slices).

3. **Residual `update` impurities (concrete, low-risk fixes).** **D10** is the sharpest:
   `groups.js update` genuinely reads route topology behind a docstring that *falsely* claims
   "Reducer-pure" — fix the code (stamp `viewerTarget` on `msg.ctx`) *and* the comment. D9
   (root reducer's 2 registry reads), D11 (unify the dual show-info pathway).

4. **Layering taxonomy.** D1 (`leaves/` conflates purity with import-position — `hub`/
   `render-queue` are stateful/effectful there), D2 (`leaves/` domain grab-bag), D3 (view
   bisected `render/` ↔ `leaves/`), D4 (the runtime loop has no single home; finalizer
   discipline).

5. **Subscriptions & hub.** D13 (subs are mount-time/static, not model-driven `Model → Sub`;
   no teardown), **D17** (drop the unconsumed broadcast `hub` Msg — low-risk perf+clarity).

6. **Cohesion (lowest).** D12 (1,055-LOC reducer / nested sub-updates vs flat switch).

**Suggested first moves (cheap, high-confidence):** D10 (+ its false comment), D17, D6, and
the D5 documentation correction. The rest are genuine design forks best taken deliberately.

*Method caveat:* during this review three agent summaries asserted things first-hand reads
disproved (a hallucinated `panel/ports/` dir; "all updates pure" while `groups.js` wasn't;
"innerH through a Msg" — it isn't). Every F-item above is grounded in a quoted `file:line`,
not an agent summary.
