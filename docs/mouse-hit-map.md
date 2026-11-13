# Mouse hit-map — first-class mouse input

> **Status**: DESIGN — written 2026-11-13, not started. Trigger: field
> report *"when confirm popup shows, I cannot click mouse"*. Root-caused to
> a routing gap, then widened (user call: "fix mouse from the ground up,
> make it a first-class citizen") into this three-release plan.
> Shape mirrors [overlay-compositor-migration.md](overlay-compositor-migration.md).

## Motivation

The confirm popup paints `[y] confirm   [n] cancel`. They look like buttons;
they are text. Every click while the popup is open is dropped by the T13
modal gate (`js/dispatch/control/input.js:711`, `if (isChainActive(model.modes))
return;`) because `confirmMode` has no entry in `_modeMouseHandlers`
(`input.js:293`).

That is one instance. **10 of 15 overlays have no mouse at all** —
confirm, copy, fabric-field, fabric-form, action-palette, jobs,
register-popup, which-key, cmdline, diag-log — and most paint key hints
that read as clickable (`[enter] run   [esc] cancel`, `[y] copy   [c] clear
[s] save   [Esc] close`). Only menu, pane-menu, panel-list (free-config) and
replay-scrubber handle the pointer.

Adding ten more `_modeMouseHandlers` entries would fix the symptom and
deepen the cause. The cause is architectural, and it has bitten before in
other shapes (the narrow-pane phantom-hit arc —
`reference_paint_hittest_agreement`; the tree-marker-vs-dropdown precedence
fix at `input.js:839`; the zoom-vs-select arm fight at `input.js:930`).

## What is NOT being rebuilt

"Ground up" applies to **routing and hit-testing** only. These layers are
sound and stay:

| Layer | Where | Why it stays |
|---|---|---|
| SGR tokenizer + mouse decode | `leaves/input/tokenize.js`, `input.js:1519 _dispatchMouseEvent` | correct, battle-tested over SSH (network-lag arc) |
| Gesture classifier (press/double/right/middle, wheel 64/65 vs 66/67) | `input.js:1184 _classifyPress` | correct; double-click window already YAML-tunable |
| Intent layer (focus/select/activate/context/scroll) | `dispatch/control/intent.js` | the keyboard↔mouse parity seam (v0.6.4 Theme F) — the router *targets* it |
| `mouse:` YAML gesture→intent bindings | `dispatch/control/mouse-bindings.js` | user-facing contract; unchanged |
| Terminal-mode mouse (PTY passthrough / scrollback) | `input.js:1002 _classifyTerminalChunk` | bypasses `handleMouse` entirely, by design |
| Reducer Msgs (`menu_activate`, `select_*`, `pool_drag_*`, …) | various | the router emits the SAME Msgs; no new store concepts |

## Diagnosis — three root causes (+ one latent)

**A — Routing is a hand-ordered `if`-cascade with a blanket gate.**
`handleMouse` (`input.js:595–967`) resolves an event by walking, in source
order: replay owner → hover → chrome cluster (`suppressChrome`-gated) → the
four `_modeMouseHandlers` → **`isChainActive` gate (drops everything)** →
button gestures → wheel → motion/release (select / zoom) → press: tree
marker → tab strip → focus+select. Precedence *is* source order. Any mode
without a handler is mouse-dead. Each precedence bug was fixed by moving
an `if` (tree marker relocated below the gate so it can't hijack an open
dropdown; zoom arm explicitly clears the select arm).

**B — Hit-testing uses two strategies, one of which can drift from paint.**

| Hit-test | Strategy |
|---|---|
| `[_]`/`[+]`, `[X]`, `[≡]` trigger | **published** at paint (`panel/chrome-regions.js`) |
| tree fold markers | **published** (`panel/tree-regions.js`) |
| text-select / row mapping | **published** (`panel/select-view.js recordContent`) |
| graph hover value | **published** (`panel/hover-region.js`) |
| menu rows | re-derived (`overlay/menu.js:79`, shared `overlayBox` + `menuScroll`) |
| pane-menu rows | re-derived (`overlay/pane-menu.js:249 _geom`) |
| panel-list rows | re-derived (`overlay/panel-list.js:295`) |
| border-control strip + bottom legend | re-derived (`panel/chrome-hittest.js:108`, mirrors `bc.fits`) |
| slot tab-strip | re-derived, then clipped by published `titleClip` (`input.js:879`) |
| action-status `✗ cancel` | re-derived (`chrome-hittest.js:160` via `cancelHitInfo`) |
| replay seek strip | re-derived (`overlay/replay-scrubber.js:82`) |

Every re-derived site carries a comment explaining how it mirrors the
paint; the phantom-hit arc was the cost of one that didn't. Four
published registries exist, each with its own clear/publish/get and its
own reader.

**C — Gesture state is ad-hoc module locals.** `_armedSelect`
(`input.js:507`), `_armedZoom` (`:514`), `_lastHover` (`:566`), the
double-click triple (`:1182`), plus `slice.freeConfig.drag` for free-config.
Mutual exclusion between arms is enforced by hand ("zoom wins the gesture
PANE-WIDE … clear it").

**D (latent, unreproduced) — batched chunk hit-tests a stale frame.**
`render-queue.paintNow` defers while `_batchDepth > 0`
(`leaves/infra/render-queue.js:73`). A chunk carrying `Enter` (opens a
confirm) then a click resolves the click against the *previous* frame's
published regions while the model already has the popup open. Today the
T13 gate masks it for overlays; chrome-regions readers are exposed. Needs a
repro before it is called a bug; the design below closes it structurally
either way (§Stale-frame rule).

## End state

- **One per-frame hit map.** Paint publishes every clickable thing it drew:
  `{ rect, z, owner, on: { gesture → handler } }`. Handlers are **data**
  (a key, a Msg, an intent) — a TEA view declaring `onClick msg`, the same
  shape border-control specs already return (`{ owner, msg }`).
- **One router.** `handleMouse` = classify → capture? → resolve topmost
  region with a handler → realize → paint. Precedence is z-order.
- **Popups are mouse-capable by construction.** `renderOverlay` publishes
  the box, its visible rows, and its key-hint chips. Clicking a chip feeds
  that key through `handleKey` — mouse can never diverge from keyboard.
- **Modals block by backdrop, not by gate.** A modal publishes a
  full-screen opaque backdrop below its box carrying an *outside policy*.
  The `isChainActive` mouse gate and the `suppressChrome` column retire.
- **One pointer-capture slot** replaces `_armedSelect` / `_armedZoom` /
  the free-config drag routing.
- chrome-regions, tree-regions, chrome-hittest.js and every re-derived
  overlay `hitTest` are deleted.

## Mechanism

### Region

```js
{
  id:    'confirm:hint:y',          // stable — tests + diag
  rect:  { x, y, w, h },            // screen cells, 0-based, inclusive-exclusive
  z:     1013,                      // see §Z bands
  owner: 'confirm',                 // overlay id | paneId
  opaque: false,                    // stops the walk even with no handler (boxes, backdrops)
  on: {                             // gesture → handler; absent gesture = not handled here
    press:        { key: 'y' },
    'wheel-up':   'swallow',
  },
}
```

Gestures are the existing `handleMouse` kinds: `press`, `double`, `right`,
`middle`, `wheel-up`, `wheel-down`, `motion`, `release`, `hover`.

**Handler forms** (all plain data; the router realizes them):

| Form | Realized as | Used by |
|---|---|---|
| `{ key, seq? }` | `handleKey(key, seq ?? key)` — the keyboard path itself | hint chips, wheel-on-list (`up`/`down`), outside policy (`escape`) |
| `{ msg, owner? }` | `applyMsg(msg)` or `dispatchMsg(wrap(owner, msg))` | row picks (`menu_activate {idx}`), border controls, tree toggle |
| `{ intent }` | `intent.realize(intent)` | pane body: focus / select / activate / context / scroll |
| `{ capture: name, ...args }` | start pointer capture with a named drag controller (§Pointer capture) | text-select, graph-zoom, free-config, pool-drag (R3) |
| `'swallow'` | consume, no-op | backdrops, box borders |
| `[h1, h2, …]` | realize each in order | row double-click = `[{ msg: nav to i }, { key: 'return' }]` |

`{ key }` is the load-bearing choice: a chip, a wheel notch over a list,
and an outside-click all become *the keystroke the user could have typed*,
so chips, wheel and outside-clicks add **zero** reducer arms and cannot
drift from the keyboard mode handler (`dispatch.js:1055 _modeHandlers`).

**Row clicks are the one place new reducer surface is needed.** Every list
popup's nav Msg is relative (`dir: ±1`) or symbolic (`to: 'top' | 'bottom'
| 'pageup' | 'pagedown'`); none accepts an absolute row except
`menu_activate { idx }` (`update/modal/menu.js:70`). R1 extends each list
nav reducer with a numeric `to: <idx>` (clamped like the symbolic forms) —
copy, diag-log, jobs, pane-menu, register-popup, cmdline — and adds one
Msg, `fabric_form_focus { idx }` (today only `focus_next` / `focus_prev`
exist). Activation still goes through `{ key: 'return' }` after the nav, so
the activate path stays the keyboard's.

### Resolve

Walk regions top-down by `z` (ties: later-published wins, matching paint
order). The first region containing `(mx, my)` that has a handler for the
gesture wins. A containing region with `opaque: true` and no handler stops
the walk (event consumed). No hit → R1/R2: fall through to the legacy
cascade; R3: nothing (event dropped).

Boxes are opaque; rows and chips inside them are not — so a wheel over a
chip falls to its row, then to the box's wheel handler.

### Z bands

| Band | z | Publishers |
|---|---|---|
| Pane body | 10 | one region per visible pane (R3) |
| In-pane affordances | 30 | tree markers, `✗ cancel` chip (R2) |
| Mode backdrop, below chrome | 35 | chain modes that let chrome through today (`suppressChrome: false`): filter, search, prefix/which-key, jobs, pane-menu, agent (R2) |
| Pane chrome | 40 | `[_]`/`[+]`/`[X]`/`[≡]`, border controls, bottom legend, tab strip (R2) |
| Overlay *k* | 1000 + 10·zIndex_k + {0 backdrop, 1 box, 2 rows, 3 chips} | compositor-registered overlays (R1) |
| Replay owner | 9000 | replay scrubber full-screen capture (R3) |

The tree-marker-vs-dropdown fix (`input.js:839`) becomes a z fact (30 <
1000+) instead of a source-order fact. The `suppressChrome` column becomes
"backdrop at 35 vs at 1000+".

### Publishing

- **Registry**: `js/panel/hit-map.js` — `clear()`, `publish(region)`,
  `resolve(mx, my, gesture)`, `frameStamp()`. Placed in the panel layer
  alongside chrome-regions (dispatch→panel is a legal edge).
- **Cleared** at the top of every main-frame paint in `render()`
  (`render/paint.js:904`, where chrome/tree/hover registries clear today) and
  repopulated in the same synchronous pass.
- **Leaves publish through an injected sink** (`draw.setHitSink`), the
  `setChromeSink` precedent (`paint.js:118`) — `leaves/render/draw.js` stays
  pure and import-free of the panel layer (leaves purity wall).
- **Owner + z are ambient.** `overlay-compositor.paintActive` sets the
  current overlay `{id, zIndex}` around each descriptor's render — the
  `select-view.enterPane` pattern — so `renderOverlay` stamps regions
  without every overlay threading its id.

### renderOverlay contract (R1)

`renderOverlay` (`leaves/render/draw.js:529`) gains two optional inputs:

- `lineTargets: Array<handlerMap|null>` — index-aligned with `lines`. After
  applying `scrollOffset` and the box clip, publish a row region for each
  **visible** line with a non-null target. This replaces the hand-written
  "reject border rows BEFORE applying scroll" logic in `menu.hitTest`
  (`overlay/menu.js:91`) — agreement by construction.
- `hints: Array<{ key: string|null, label: string, seq?: string }>` —
  replaces hand-built `'[dim]\\[y] confirm   \\[n] cancel[/]'` markup. A
  pure leaf `leaves/render/hints.js formatHints(hints, innerW)` returns
  `{ markup, chips: [{ key, x0, x1 }] }`; chips that truncation cut publish
  nothing. `key: null` draws a non-clickable hint (`[↑/↓] nav`,
  `[type] filter`). Declared, not regex-parsed from markup.

Key tokens are the `handleKey` names: `'return'`, `'escape'`, `'tab'`,
`'backtab'`, `'up'`, `'down'`, `' '`, or the literal char.

Two overlays bypass `renderOverlay` — **pane-menu** (`overlay/pane-menu.js:356`)
and **cmdline** (`overlay/cmdline.js:84`) call `renderPanel` + `compositeRow`
directly with their own geometry. The box/row/chip publishing therefore
lives in a shared leaf helper `publishBox({ x, y, w, h, scrollOffset,
lineTargets, chips })` that `renderOverlay` calls and those two call
directly. The helper **clips every region to the screen** — pane-menu's
right edge is not clamped today (`_geom`, `pane-menu.js:223`).

Pre-sliced overlays (diag-log, jobs, register-popup, action-palette slice
their own visible window before calling `renderOverlay`) pass
`lineTargets` sliced the same way; the targets carry absolute indices
(`to: scroll + i`), so the slice offset is applied once, by the overlay that
owns it.

### Backdrop + outside policy

The compositor descriptor gains `mouse: { outside }`:

| `outside` | Meaning |
|---|---|
| `{ key: 'escape' }` | outside-click = press Esc (cancel / close) |
| `'swallow'` | outside-click consumed, nothing happens |
| `null` | no backdrop — misses fall through (R1: to legacy) |

For each active descriptor with a non-null `outside`, `paintActive`
publishes a full-screen opaque region at the overlay's backdrop z with
`on.press = on.double = on.right = on.middle = outside` and wheel →
`'swallow'`. Proposed policy per overlay in §Per-overlay mapping. Rule of
thumb: **cancel is safe → Esc; read-only → Esc; holds typed input →
swallow** (a stray click must not discard a half-filled form).

### Pointer capture (R3)

A press handler `{ capture: 'text-select', paneId }` starts a capture: the
router stores `{ controller, args }` in ONE module-local slot. Every
subsequent `motion` / `release` goes to the capturing controller regardless
of position; `release` ends it. Controllers are code, registered by name:

| Controller | Replaces | Emits |
|---|---|---|
| `text-select` | `_armedSelect` (`input.js:507`) | `select_begin` / `select_extend` / `register_push` / `select_cancel` |
| `graph-zoom` | `_armedZoom` (`:514`) | `graph_drag` / `graph_zoom` |
| `free-config` | `_mouseHandleFreeConfigMode` (`:218`) | `free_config_mouse_*` |
| `pool-drag` | panel-list press → `pool_drag_*` | `pool_drag_start/motion/release` |

Mutual exclusion becomes structural: one slot, the press's winning region
picks the controller. Capture state stays input-shell (like `_lastClick*`),
not model — the visible effects already ride Msgs.

### Hover

`hover` is just another gesture: stats / composite pane bodies publish a
`hover` handler; the router's coalescing (`_lastHover`, `input.js:566`)
moves into the hover resolution unchanged. The hover tooltip overlay never
publishes regions (display-only — it must not steal clicks).

### Stale-frame rule

The hit map stamps the frame with the set of active chain-mode flags at
publish time. Before resolving, the router compares it with
`getModel().modes`; on mismatch the event is **dropped**. The user aimed at
a screen that no longer matches state (a batched `Enter`+click, §D), and
dropping is what the T13 gate does today. Same-mode staleness (a list
scrolled between frames) is safe: row handlers carry absolute targets
(`idx`, node id), so the click hits what the user *saw*.

### TEA, purity, replay

- Handlers are data, so the frame stays `f(model)`; realization happens at
  input time, exactly where `handleMouse` dispatches today.
- The hit map is a per-frame derived side output of render — the same
  status chrome-regions has today; no new blessed exception.
- Replay: mouse events are not recorded (`io/event-log.js:19`); the WAL
  holds the resolved Msgs. Unchanged.

### Performance

Regions per frame: panes (~10–30) + visible overlay rows (≤ terminal
height) + chips + chrome glyphs — O(100). Pane rows are **not** published
per row: the pane-body region resolves its row at realize time through the
existing select-view capture (`_rowIndexAt`, `input.js:361`). Resolve is a
linear top-down scan — microseconds, even under mode 1003 hover. Gate:
`bench-hotpaths.js` and the Release-2 render-construction baseline
(`reference_release_2_bench_baseline`) within noise, same-directory runs.

## Per-overlay mapping (Release 1)

Facts from a per-overlay inventory (2026-11-13). "Typed" = the overlay
holds text the user typed, so an outside-click must not discard it.

| Overlay (z) | Row click | Row double | Wheel | Chips (clickable keys) | Outside | New reducer surface |
|---|---|---|---|---|---|---|
| **confirm** (10) | — (no items) | — | swallow | `y`, `n` | Esc = reject (safe; fires `onReject` rollback exactly like `n`) | none |
| **copy** (20) | `[nav to i, return]` = pick | same | `up`/`down` (`copy_nav` wraps) | none today | Esc = `copy_cancel` | `copy_nav { to }` |
| **diag-log** (30) | nav to i | — (no Enter verb) | `up`/`down` | `y`, `c`, `s`, `escape` (`[↑/↓]`, `[g/G]` not clickable) | Esc = close | `diag_log_nav { to }` |
| **jobs** (40) | nav to i (row 0 = header, no target) | `[nav, return]` = jump to job | `up`/`down` | `escape` | R1: none (chrome stays live) → R2: Esc at z 35 | `jobs_nav { to }` |
| **pane-menu** (50) | `[nav to i, return]` = `_paneMenuPick` (keeps today's single-click activate) | same | `up`/`down` | none | R1: legacy outside-close arm kept → R2: Esc at z 35 | `pane_menu_nav { to }` |
| **register-popup** (70) | nav to i | `[nav, return]` = promote | `up`/`down` | `d`, `return`, `escape` — the hint is bare words today (`j/k move · … · Esc close`); converts to declared hints (visible restyle) | Esc = cancel | `register_popup_nav { to }` |
| **which-key** (80) | `{ key: k }` per continuation row — click the next chord key | — | swallow | none | R1: none → R2: Esc (cancels the chord) at z 35 | none |
| **action-palette** (90) | `{ msg: palette_pick { groupPath, actionKey } }` — the row carries its own target | same | `up`/`down` | `return`, `escape` (`[↑/↓]`, `[type]` not clickable) | **swallow** (typed filter; Esc only clears it) | none |
| **menu** (100) | `{ msg: menu_activate { idx } }` — today's behavior, all four buttons | same | `up`/`down` | none | Esc = `menu_close` (today's behavior) | none |
| **cmdline** (110) | nav to match (rows are **reversed**: row i = match `scroll+k-1-i`) | — | `up`/`down` (key parity absorbs the reversal) | none | **swallow** (typed) | `cmdline_nav { to }` |
| **fabric-form** (120) | field row → `fabric_form_focus { idx }`; choice row → `fabric_form_choices_pick { port, value }` (existing). Rows are not field-aligned — section headers, desc, warnings, preview are null targets | — | picking: `up`/`down`; else swallow | form: `tab`, `backtab`, `' '` (if `hasChoices`), `return`, `escape`; choice list: `return`, `escape` | **swallow** (typed per field) | `fabric_form_focus { idx }` |
| **fabric-field** (130) | — | — | swallow | `return`, `escape` | **swallow** (typed) | none |
| panel-list (60) | R3 — rows are pool-drag sources (§Pointer capture) | | | | | |
| replay-scrubber (140) | R3 — needs a coordinate-carrying seek handler; module state, not model | | | | | |
| hover-tooltip (999) | never — display-only, publishes nothing | | | | | |

R1 publishes a backdrop only for overlays that block chrome today
(`suppressChrome: true`). For the three that let chrome through (jobs,
pane-menu, which-key), a full-screen backdrop at the overlay band would
newly block chrome clicks — so their outside policy waits for R2, when
chrome is in the map and the backdrop can sit at z 35 below it.

## Release 1 — popups (proposed v0.6.56)

Fixes the field report; makes every popup mouse-capable.

1. `js/panel/hit-map.js` registry + unit tests (z order, opaque stop,
   fall-through, stale-frame drop).
2. `leaves/render/hints.js formatHints` + `draw.setHitSink` + the shared
   `publishBox` helper; `renderOverlay` gains `lineTargets` / `hints`;
   compositor ambient owner/z + backdrop publishing; descriptor
   `mouse.outside`; router support for array (sequence) handlers.
3. Router entry in `handleMouse`, **after** replay/hover, **before** the
   chrome cluster, discrete gestures only (`press`/`double`/`right`/
   `middle`/wheel). `motion`/`release` stay legacy until R3 (capture). Miss
   → legacy cascade, untouched.
4. Migrate overlays one commit each, **confirm first** (ships the fix),
   then the other 11 rows of §Per-overlay mapping. menu: its
   `_modeMouseHandlers` entry and `hitTest` are deleted in the commit its
   regions land. pane-menu: the row/wheel arms and `hitTest` go; the
   outside-close arm stays until R2 moves it to a z-35 backdrop.
5. Per-overlay commit = descriptor `mouse` + `lineTargets`/`hints` + the
   overlay's numeric `to:` nav extension (or `fabric_form_focus`) with its
   reducer test + a paint-capture test + a raw-SGR test through
   `_makeDataHandler` (`feedback_render_test_new_overlays`,
   `feedback_key_path_integration_tests`).

Exit: every R1 overlay passes the chip≡key parity property (below); the
T13 test (`test-mouse-wheel.js:131`) updated only where outside policy
intentionally changes behavior; full suite + smoke green under `env -u TMUX`.

## Release 2 — pane chrome + in-pane affordances (proposed v0.6.57)

1. renderPanel's chrome sink publishes hit regions for `[_]`/`[+]`, `[X]`,
   `[≡]` (it already computes the drawn ranges, `draw.js:291`); collapsed
   panes publish from `_renderCollapsed`.
2. Border-control specs' `regions()` + `dispatch` (`chrome-hittest.js:108`)
   → published at paint where `bc.fits` / `bc.bottomFits` drew them.
3. Slot tab-strip publishes per-tab regions from the strip it drew (the
   `titleClip` clip becomes unnecessary — clipped tabs never publish).
4. `✗ cancel` chip and tree markers publish from their renders.
5. Mode table: `suppressChrome` column → `mouse: { backdrop: 'above' |
   'below-chrome' | null, outside }`. In-grid chain modes publish their
   backdrop at z 35 — the T13 gate's semantics as data. jobs / pane-menu
   get outside = Esc here (their backdrop must sit below chrome, which only
   exists once chrome is in the map).
6. Delete `panel/chrome-regions.js`, `panel/tree-regions.js`,
   `panel/chrome-hittest.js`, the chrome cluster in `handleMouse`
   (`input.js:629–691`), and the tab-strip arm (`:879–900`).

Exit: `test-chrome-hittest-agreement.js` and `test-chrome-trigger-truncation.js`
re-pointed at the hit map and green; narrow-terminal property sweep green.

## Release 3 — pane bodies, drags, cascade deleted (proposed v0.6.58)

1. One pane-body region per visible pane: `press` → focus+select intents,
   `double`/`right`/`middle` → `mouseBindings.intentFor`, wheel → `scroll`
   intent, `hover` on stats/composite.
2. Pointer capture + the four controllers (§Pointer capture); panel-list
   rows become `pool-drag` capture sources.
3. Replay scrubber → z 9000 full-screen region with seek-strip handler.
4. Delete: the remaining cascade, `_modeMouseHandlers`,
   `_dispatchActiveModeMouse`, `_MOUSE_MODE_PRECEDENCE`, the
   `isChainActive` mouse gate, `_armedSelect`, `_armedZoom`, every overlay
   `hitTest` export. `handleMouse` becomes the ~30-line router.

Exit: `handleMouse` has no per-mode or per-pane-kind branches; the ~25
mouse-pinning test files green (list in §Test strategy).

## Test strategy

- **Existing pins (must stay green, modified only for intentional
  changes)** — 25 files touch mouse/hit-test behavior: `test-mouse-wheel`,
  `test-groups-click`, `test-graph-hover`, `test-stats-zoom`,
  `test-stats-select`, `test-gauge`, `test-table`, `test-table-tree`,
  `test-composite`, `test-chrome-hittest-agreement`, `test-context-menu`,
  `test-menu-scroll`, `test-pane-select`, `test-tab-list`, `test-select`,
  `test-select-core`, `test-half-view-focus`, `test-action-status`,
  `test-docker-component`, `test-replay-control-pane`, and smoke
  `mouse-gestures`, `mouse-raw-sgr`, `hit-zones`, `pane-select`,
  `agent-pane`.
- **Chip≡key parity property** — for every published `{ key }` handler:
  model after clicking the chip deep-equals model after `handleKey(key)`
  from the same start state.
- **Paint↔hit agreement property** — every published region's rect lies
  inside cells the frame actually drew for its owner; swept across
  terminal widths 20…200 (truncation drops chips → no region).
- **Raw-byte path** — every new mouse behavior tested by feeding SGR bytes
  through `_makeDataHandler`, not by calling `handleMouse` directly.
- **Stale-frame** — batched `Enter`+click chunk: click dropped, no
  underlying pane mutation.
- **Bench** — `bench-hotpaths.js` + render-construction before/after, same
  directory (`feedback_benchmark_same_dir`).

## Open questions

1. **Outside policy** per overlay — the proposal is in §Per-overlay
   mapping; needs a user yes/no.
2. **Row click: select or activate?** Menu and pane-menu activate on a
   single click today (shipped behavior, keep). Proposal, as in the
   table: pure pickers whose activation only *chooses* (copy, palette,
   fabric-form choice list) single-click = pick; lists whose activation
   *does something else* (jobs = jump away, register-popup = promote)
   single-click = move cursor, double-click = `return`; diag-log and
   cmdline have no row activation — click moves the cursor.
3. **Wheel over a list popup** — synthesize `up`/`down` (moves the cursor,
   menu precedent) vs scroll the window without moving it. Proposal:
   `up`/`down`, for keyboard parity.
4. **Stale frame: drop or flush?** Proposal: drop (above). Alternative:
   flush the pending batch paint and resolve against the fresh frame —
   but the user aimed at the old one.

## Adjacent findings (from the inventory — unverified, repro before fixing)

Found while mapping the overlays; none is the reported bug. Each needs a
repro before it is called a bug (`feedback_dont_speculate_commit`).
Confirmed ones fold into the release that touches the code.

1. **panel-list header/footer press starts a drag** — *likely bug.* A press
   on the header, footer or preview area leaves the cursor and, if the
   highlighted item is not essential, still dispatches `pool_drag_start`
   for it. The comment at `input.js:252` says such clicks are swallowed;
   that only holds when the highlighted item is essential. → R3 (panel-list
   migration).
2. **Hover tooltip lingers under some popups** — *likely bug.* The tooltip
   hides on `isModal` (the modes.js `modal` column), which is false for
   confirm, register-popup, cmdline, pane-menu, jobs and diag-log. It
   clears only on the next motion event (when `_handleHover` sees a chain
   mode). Opening confirm by keyboard with the pointer parked over a graph
   would leave the tooltip painted over or beside the popup. → R1 if
   reproduced (the backdrop is the natural place to clear hover).
3. **Two different "modal" flags disagree** — *smell.* The compositor's
   `modal` (one-at-a-time invariant) and modes.js `modal` (owns the footer
   row) disagree for confirm, pane-menu, register-popup and cmdline. Both
   are internally consistent with their own meaning; the shared name
   invites exactly the hover-tooltip mistake in (2). The hit map keys its
   backdrop off neither — off the descriptor's explicit `mouse.outside`.
4. **pane-menu dropdown right edge is not clamped to the screen** —
   *possible bug* on a pane near the right edge of a narrow terminal
   (`pane-menu.js:223`, `w = min(50, max(20, paneB.w))` from `paneB.x`).
   `publishBox` clips regions regardless; the paint side needs a repro.

## Rollback

R1 and R2 keep the legacy cascade as the miss path, so reverting a single
overlay's (or chrome element's) commit restores the old behavior for it
alone. R3 removes the cascade; its rollback is a release revert.

## Non-goals

- Terminal-mode (embedded PTY) mouse — stays raw passthrough.
- Horizontal wheel (66/67) — still dropped; lazytui has no horizontal axis.
- New mouse *features* (drag-to-reorder lists, resize popups, hover
  highlight of chips). The hit map makes them cheap later; not in scope.
- Changing the `mouse:` YAML surface.

## Session kickstart

Read this doc, then `js/dispatch/control/input.js` (`handleMouse` at
:595), `js/leaves/render/draw.js` (`renderOverlay` :529, chrome sink :291),
`js/render/overlay-compositor.js`, `js/render/paint.js` `render()`
(:779, registry clears :904). Start at Release 1 step 1.
