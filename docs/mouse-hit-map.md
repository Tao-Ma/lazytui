# Mouse hit-map — first-class mouse input

> **Status**: Release 1 SHIPPED in v0.6.56 (2026-11-13; `f6d152c3..38275d37`
> + the release commit), including the 4-track pre-release review's fixes.
> Release 2 SHIPPED in v0.6.57 (2026-11-14; `c075b2ca..980e40ff` + the release
> commit), including the fixes from its 4-track review and two further review
> rounds (§Release 2 — as built). Release 3 not started. Written 2026-11-13. Trigger: field
> report *"when confirm popup shows, I cannot click mouse"*. Root-caused to
> a routing gap, then widened (user call: "fix mouse from the ground up,
> make it a first-class citizen") into this three-release plan.
> Shape mirrors [overlay-compositor-migration.md](overlay-compositor-migration.md).

## Motivation

> Line references in §Motivation, §What is NOT being rebuilt and §Diagnosis
> describe the code at the design baseline `f6d152c3` (before R1); the
> forward-looking sections use symbol names.

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
| `[_]`/`[+]`, `[X]`, `[≡]` trigger | **published** at paint (`panel/chrome-regions.js`) — **on the hit map since R2** |
| tree fold markers | **published** (`panel/tree-regions.js`) — **on the hit map since R2** |
| text-select / row mapping | **published** (`panel/select-view.js recordContent`) |
| graph hover value | **published** (`panel/hover-region.js`) |
| menu rows | re-derived (`overlay/menu.js:79`, shared `overlayBox` + `menuScroll`) — **published on the hit map since R1** |
| pane-menu rows | re-derived (`overlay/pane-menu.js:249 _geom`) — **published on the hit map since R1** |
| panel-list rows | re-derived (`overlay/panel-list.js:295`) |
| border-control strip + bottom legend | re-derived (`panel/chrome-hittest.js:108`, mirrors `bc.fits`) — **published on the hit map since R2** |
| slot tab-strip | re-derived, then clipped by published `titleClip` (`input.js:879`) — **published on the hit map since R2** |
| action-status `✗ cancel` | re-derived (`chrome-hittest.js:160` via `cancelHitInfo`) — **published on the hit map since R2** |
| replay seek strip | re-derived (`overlay/replay-scrubber.js:82`) |

Every re-derived site carries a comment explaining how it mirrors the
paint; the phantom-hit arc was the cost of one that didn't. Four
published registries existed, each with its own clear/publish/get and its
own reader (since R2, two remain: select-view's content capture and
hover-region — both feed pane-body behavior that moves in R3).

**C — Gesture state is ad-hoc module locals.** `_armedSelect`
(`input.js:507`), `_armedZoom` (`:514`), `_lastHover` (`:566`), the
double-click triple (`:1182`), plus `slice.freeConfig.drag` for free-config.
Mutual exclusion between arms is enforced by hand ("zoom wins the gesture
PANE-WIDE … clear it").

**D (latent at design time; reproduced + fixed in R1, `3ceb19e7`) — batched chunk hit-tests a stale frame.**
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
  overlay `hitTest` are deleted (R2 deleted the first three; panel-list's and
  the replay scrubber's `hitTest` go in R3).

## Mechanism

### Region

```js
{
  id:    'chip:y',                  // 'backdrop' | 'box' | 'row:<lineIdx>' | 'chip:<key>'
  rect:  { x, y, w, h },            // screen cells, 0-based, inclusive-exclusive
  z:     1013,                      // see §Z bands
  owner: 'confirm',                 // overlay id (R1) | paneId (R2+)
  opaque: false,                    // stops the walk even with no handler (boxes, backdrops)
  repeat: true,                     // hint chips + top-strip steppers: a fast 2nd click re-presses (§Press→double)
  on: {                             // gesture → handler; absent gesture = not handled here
    press:        { key: 'y', seq: 'y' },
  },
}
```

Gestures are the existing `handleMouse` kinds: `press`, `double`, `right`,
`middle`, `wheel-up`, `wheel-down`, `motion`, `release`, `hover`.

**Handler forms** (all plain data; the router realizes them):

| Form | Realized as | Used by |
|---|---|---|
| `{ key, seq? }` | `handleKey(key, seq ?? seqForKey(key))` — the keyboard path itself. `seqForKey` (leaves/render/hints) mirrors `input._dispatchToken`: a single character carries itself as `seq`, a named key (`return`, `escape`, `backtab`, `up`, …) carries none — so a handler's "printable seq → typed text" fallback never types a key's NAME | hint chips, wheel-on-list (`up`/`down`), outside policy (`escape`) |
| `{ msg, owner? }` | `applyMsg(msg)` or `dispatchMsg(wrap(owner, msg))` | row picks (`menu_activate {idx}`), pane chrome (`panel_collapse_toggle`, `pool_hide`, `activate_tab`), tree toggle, `cancel_job` |
| `{ intent }` | `intent.realize(intent)` | pane body: focus / select / activate / context / scroll |
| `{ capture: name, ...args }` | start pointer capture with a named drag controller (§Pointer capture) | text-select, graph-zoom, free-config, pool-drag (R3) |
| `{ act: name, ...args }` | a named input-time action (`dispatch/control/mouse-acts.js`) — the Msg is computed at click time against current state, after re-checking the target is still shown | border controls, `[≡]` open (R2) |
| `'swallow'` | consume, no-op | backdrops, box borders |
| `'legacy'` | the region owns its cells, but the legacy cascade realizes the gesture (the router returns false) — a migration shim, retired in R3 | the free-config panel list's box (R2) |
| `[h1, h2, …]` | realize each in order | row double-click = `[{ msg: nav to i }, { key: 'return' }]` |

`{ key }` is the load-bearing choice: a chip, a wheel notch over a list,
and an outside-click all become *the keystroke the user could have typed*,
so chips, wheel and outside-clicks add **zero** reducer arms and cannot
drift from the keyboard mode handler (`dispatch.js` `_modeHandlers`).

**Row clicks are the one place new reducer surface is needed.** Every list
popup's nav Msg is relative (`dir: ±1`) or symbolic (`to: 'top' | 'bottom'
| 'pageup' | 'pagedown'`); none accepts an absolute row except
`menu_activate { idx }` (`update/modal/menu.js`). R1 extends each list
nav reducer with a numeric `to: <idx>` (clamped like the symbolic forms) —
copy, diag-log, jobs, pane-menu, register-popup, cmdline — and adds one
Msg, `fabric_form_focus { idx }` (before R1 only `focus_next` / `focus_prev`
existed). Activation still goes through `{ key: 'return' }` after the nav, so
the activate path stays the keyboard's. The `count` / `vh` / `n` / `sepIdx`
a list's key handler computes are baked into the row target at paint time —
derived from the same model + viewport; a list change between paint and
click re-stamps the frame (§Stale-frame rule).

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
| In-pane affordances | 30 | tree fold markers (R2) |
| Mode backdrop, below chrome | 35 | in-grid overlays that let chrome through (`suppressChrome: false`): jobs, pane-menu, which-key (R2); filter / search / agent backdrops wait for R3 (the T13 gate covers them until then) |
| Pane chrome | 40 | `[_]`/`[+]`/`[X]`/`[≡]`, border controls, bottom legend, tab strip, `✗ cancel` chip (R2 — the chip sits with chrome because it is live under in-grid modes today, like the chrome cluster it was hit-tested in) |
| Overlay *k* | 1000 + 10·zIndex_k + {0 backdrop, 1 box, 2 rows, 3 chips} | compositor-registered overlays (R1) |
| Replay owner | 20000 | replay scrubber full-screen capture (R3) — above every overlay band (the highest, hover-tooltip's, is 1000 + 10·999) |

The pre-R2 tree-marker-vs-dropdown fix (a source-order move in `handleMouse`)
became a z fact (30 < 35 / 1000+). The `suppressChrome` column decides where an
overlay's backdrop sits ("at 1000+, above chrome" vs "at 35, below it") and,
read at paint, whether chrome publishes at all.

### Publishing

- **Registry**: `js/panel/hit-map.js` — `clear(stamp)`, `publish(region)`,
  `publishOwned(region, zOff)` + `enterOwner` / `exitOwner` (the overlay
  bracket), `enterPane(paneId, rect, activeTabId)` / `exitPane` +
  `publishLocal(region, z)` (the pane bracket, R2 — pane-local rects translated
  + clipped to the pane, tab-scoped unless `paneLevel`), `tabMoved(region,
  layoutSlice)` (§Stale-frame rule, Tab scope), `retractOwner(owner)`, `resolve(mx, my, gesture)`, `claims(mx, my)`,
  `stampOf(model, layoutSlice)` / `stampsEqual` / `frameStamp()`, `all()`
  (tests / diag), `BANDS` (the pane-anchored z bands). Panel layer
  (dispatch→panel and render→panel are legal edges).
- **Cleared** at the top of every main-frame paint in `render()`
  (`render/paint.js`, beside the hover-region clear) and repopulated in the
  same synchronous pass.
- **Leaves publish through an injected sink** (`draw.setHitSink`), the
  `setChromeSink` precedent — `leaves/render/draw.js` stays pure and
  import-free of the panel layer (leaves purity wall).
- **Owner + z are ambient.** `overlay-compositor.paintActive` sets the
  current overlay `{id, zIndex}` around each descriptor's render — the
  `select-view.enterPane` pattern — so `renderOverlay` stamps regions
  without every overlay threading its id.

### renderOverlay contract (as built, R1)

`renderOverlay` (`leaves/render/draw.js`) takes one optional input,
`hit: { lineTargets, lineChips, box }`. **Absent → nothing is published**, so
an overlay that hasn't opted in keeps its legacy mouse path (an always-
published opaque box would swallow clicks its legacy handler owned).

- `lineTargets: Array<handlerMap|null>` — index-aligned with `lines`.
  `publishBox` applies `scrollOffset` and the box clip, then publishes a
  `row:<i>` region for each **visible** line with a target — a border or a
  scrolled-off line can never map to an item (agreement by construction;
  this replaced the retired `menu.hitTest`'s hand-written border check).
- `lineChips: { [lineIdx]: chips }` — from `leaves/render/hints.formatHints`.
- `box: handlerMap` — the opaque box's own handlers (e.g. wheel → up/down);
  `{}` = consume everything inside the box.

**Hints.** `formatHints(hints, opts?)` takes declared entries
`{ cap, label, key, seq? }` — `cap` is the bracket text, `key` the handleKey
token or `null` for a drawn-but-inert hint (`[↑/↓] nav`, `[type] filter`) —
and returns `{ markup, chips: [{ key, seq, x0, x1 }] }` (columns relative to
the line, spanning the whole `[cap] label`). Truncation is decided at publish
time: `chipSurvives(chip, lineW, innerW)` mirrors renderPanel's `truncate`
(an over-wide line keeps `innerW - 1` cells then `…`), so a cut chip publishes
nothing. Declared, not regex-parsed from markup.

Key tokens are the `handleKey` names: `'return'`, `'escape'`, `'\t'` (Tab —
NOT `'tab'`, which no handler matches; dispatch.js notes the same trap),
`'backtab'`, `'up'`, `'down'`, `' '`, or the literal char.

**Overlays with their own box.** pane-menu and cmdline call `renderPanel` +
`compositeRow` with their own geometry, so they call the shared publisher
directly: `publishBox({ x, y, w, h, scrollOffset, lines, lineTargets,
lineChips, box })` — the same function `renderOverlay` uses. It **clips
every region to the screen** (pane-menu's `_geom` also keeps its dropdown on
screen since R2 — §Adjacent findings 4).

Pre-sliced overlays (diag-log, jobs, register-popup, action-palette, pane-
menu, cmdline slice their own visible window) pass `lineTargets` aligned with
the lines they pass; the targets carry absolute indices (`to: scroll + i`),
so the slice offset is applied once, by the overlay that owns it.

### Backdrop + outside policy

The compositor descriptor gains `mouse: { outside }`:

| `outside` | Meaning |
|---|---|
| `{ key: 'escape' }` | outside-click = press Esc (cancel / close) |
| `'swallow'` | outside-click consumed, nothing happens |
| `null` | no backdrop — misses fall through (R1: to legacy) |

For each active descriptor with a non-null `outside`, `paintActive`
publishes a full-screen opaque region (viewport-sized — including the
footer row, which `newRows` stops above) at the overlay's backdrop z with
`on.press = on.right = on.middle = outside`, and `double` + wheel →
`'swallow'` (a backdrop `double` is never a gesture of its own: a first click
out there already ran the policy; otherwise the box moved or shrank between
the two clicks and the second must not cancel). Policy per overlay in
§Per-overlay mapping. Rule of thumb: **cancel is safe → Esc; read-only →
Esc; holds typed input → swallow** (a stray click must not discard a
half-filled form).

Note the name clash a maintainer will meet: the descriptor's `modal` (the
compositor's one-modal-at-a-time invariant), modes.js `modal` (owns the
footer row) and modes.js `suppressChrome` (blocks chrome clicks) are three
different facts. `mouse.outside` is keyed off none of them. The rule is pinned
by `test-overlay-mouse-policy.js`: an overlay whose mode has `suppressChrome:
true` publishes its backdrop in its own band (above all pane chrome); one whose
mode leaves chrome live publishes none, or — `mouse.backdrop: 'below-chrome'`,
R2: jobs, pane-menu, which-key — publishes it at z 35, under the chrome band,
so chrome stays clickable while an outside click elsewhere runs the policy.

### Pointer capture (R3)

A press handler `{ capture: 'text-select', paneId }` starts a capture: the
router stores `{ controller, args }` in ONE module-local slot. Every
subsequent `motion` / `release` goes to the capturing controller regardless
of position; `release` ends it. Controllers are code, registered by name:

| Controller | Replaces | Emits |
|---|---|---|
| `text-select` | `_armedSelect` (input.js) | `select_begin` / `select_extend` / `register_push` / `select_cancel` |
| `graph-zoom` | `_armedZoom` (input.js) | `graph_drag` / `graph_zoom` |
| `free-config` | `_mouseHandleFreeConfigMode` (input.js) | `free_config_mouse_*` |
| `pool-drag` | panel-list press → `pool_drag_*` | `pool_drag_start/motion/release` |

Mutual exclusion becomes structural: one slot, the press's winning region
picks the controller. Capture state stays input-shell (like `_lastClick*`),
not model — the visible effects already ride Msgs.

### Hover

`hover` is just another gesture: stats / composite pane bodies publish a
`hover` handler; the router's coalescing (`_lastHover`, input.js)
moves into the hover resolution unchanged. The hover tooltip overlay never
publishes regions (display-only — it must not steal clicks).

### Press→double continuation (R1, found during implementation)

The parser emits a same-cell second click as `double`. When the first click
was a hit-map press that picked a popup item, the popup has usually closed
(or been replaced by a submenu) before the `double` arrives — and the
`double` then fell through to whatever is now under the pointer: the
pane's double-click intent, `activate` → `run_selected`. **This was a live
bug for the menu before R1** (reproduced: double-clicking a menu item ran
the item AND the groups row beneath it).

Rule, in the router: a `double` at the same cell as the last hit-map press
belongs to that press's owner. If the owner no longer holds the cell (or
the frame is stale), the `double` is swallowed. Runs before the stale-frame
check — in a batched chunk the popup can close without a repaint. Rows that
activate on press (menu, copy, palette, pane-menu) leave `double` unhandled
so a second click can't activate what slides under the pointer either.

**Chips repeat.** A hint chip publishes `repeat: true`: if the SAME chip
(owner + id) is still under the pointer, the second click is another press
of its key — two fast clicks on `[tab]` are two Tabs, as typed. A different
chip that slid under the pointer (`[space] choices` → `[enter] pick`) does
not repeat, so a double-click can't open-and-pick.

### Stale-frame rule

A multi-token stdin chunk paints once, at the end (render-queue batch), so a
click batched behind a key resolves while the screen still shows the
PRE-key frame. The hit map is stamped with **what the frame showed** —
`stampOf(model, layoutSlice)`: the active chain modes plus the identity of
`model.modal`, `prefixSeq`, `layout.paneMenu`, and `jobs` / `diagLog` while
their window is open. Mode flags alone are not enough: Enter on a context-
menu row can replace the menu with a submenu in place, Space toggles
fabric-form's choices list, typing refilters the palette — all under an
unchanged mode. (Every popup reducer replaces `model.modal` on a change and
keeps it otherwise; `clock_tick` / `focus_event` leave it alone.)

On a mismatch (`stampsEqual` false) the user aimed at a screen that no
longer exists:

- if the stale frame drew **any region** under the pointer
  (`hitMap.claims`), the click was meant for it → **swallowed** — resolving
  it against changed state, or handing it to the pane the popup covered, are
  both wrong (reproduced before the fix: `n`+click in confirm moved focus to
  the pane beneath; Enter+click injected into a port the user never saw);
- if it drew nothing there, the legacy cascade decides, as before.

R3 (no legacy cascade) makes the second case a drop too.

**Geometry (R2).** Once pane chrome is on the map, a batched key that moves
panes (collapse, hide, view mode, half-view swap, resize) must stale the frame
too. Stamping the `layout` slice's identity would over-stale: `graph_hover`
writes it on every cell change over a graph, and motion + press routinely share
one stdin chunk over SSH — every such click would be swallowed. So the stamp
carries `geom`: a string of the VISIBLE pane rects (`paneId:x,y,w,h;…`, the
same view-mode-aware derivation as `visibleBoundsFor`). It changes exactly when
a visible pane moves, resizes, collapses, appears or disappears — not on hover,
normal-view focus, selection, data refresh or a tab switch.

**Tab scope (R2, review round 3).** A slot that switches tabs shows another
renderer's border controls and fold markers at the same rect, and their
handlers resolve the pane's CURRENT instance at click time — so a click aimed
at the old tab's control must not reach the new tab. That staleness is per
pane, not per frame: every region published inside the pane bracket records
the tab it was painted under (`tab`), and the router swallows a click on one
whose pane has since switched tabs (`hitMap.tabMoved`). The `[_]`/`[+]`/`[X]`/
`[≡]` glyphs and the tab strip act on the pane, not its tab, and publish with
`paneLevel: true` — live across a switch. (Round 2 first put the active tabs
into `geom`; one pane's switch then staled every pane — a row click that
auto-switches the content slot back to Info, batched with a `[_]` click on
another pane, lost the `[_]` click.)

Content drift inside an unmoved pane is handled by the handler form, not the
stamp: chrome handlers are either **absolute** (`panel_collapse_toggle {id}`,
`pool_hide {id}`, `activate_tab {tabPoolId}`, `tree_toggle {id}`,
`cancel_job {jobId}` — act on what the user saw; a vanished target is a no-op)
or **resolved at click time** through `{ act }` (border controls, `[≡]` open —
the Msg is computed against current state exactly as the keyboard would, and
the act re-checks the control is still shown, so a stale legend click on a pane
that lost focus does nothing).

### TEA, purity, replay

- Handlers are data, so the frame stays `f(model)`; realization happens at
  input time, exactly where `handleMouse` dispatches today.
- The hit map is a per-frame derived side output of render — the status
  chrome-regions had before it (and select-view / hover-region still have); no
  new blessed exception.
- Replay: the WAL holds the resolved Msgs (a chip click is the same Msgs as
  its keystroke). Raw mouse events are not in the event log; each click the
  router resolves is recorded as `input {kind:'mouse', gesture, owner, id}` so
  a post-mortem can tell a synthesized keystroke from a typed one.

### Performance

Regions per frame: panes (~10–30) + visible overlay rows (≤ terminal
height) + chips + chrome glyphs — O(100). Pane rows are **not** published
per row: the pane-body region resolves its row at realize time through the
existing select-view capture (`_rowIndexAt`, input.js). Resolve is a
linear top-down scan — microseconds, even under mode 1003 hover. Gate:
`bench-hotpaths.js` and the Release-2 render-construction baseline
(`reference_release_2_bench_baseline`) within noise, same-directory runs.

## Per-overlay mapping (Release 1)

Facts from a per-overlay inventory (2026-11-13). "Typed" = the overlay
holds text the user typed, so an outside-click must not discard it.

| Overlay (z) | Row click | Row double | Wheel | Chips (clickable keys) | Outside | New reducer surface |
|---|---|---|---|---|---|---|
| **confirm** (10) | — (no items) | — | swallow | `y`, `n` | Esc = reject (safe; fires `onReject` rollback exactly like `n`) | none |
| **copy** (20) | `[nav to i, return]` = pick | — (2nd click swallowed) | `up`/`down` (`copy_nav` wraps) | none today | Esc = `copy_cancel` | `copy_nav { to }` |
| **diag-log** (30) | nav to i | — (no Enter verb) | `up`/`down` | `y`, `c`, `s`, `escape` (`[↑/↓]`, `[g/G]` not clickable) | Esc = close | `diag_log_nav { to }` |
| **jobs** (40) | nav to i (row 0 = header, no target) | `[nav, return]` = jump to job | `up`/`down` | `escape` | R1: none (chrome stays live) → R2: Esc at z 35 | `jobs_nav { to }` |
| **pane-menu** (50) | `[nav to i, return]` = `_paneMenuPick` (keeps the single-click activate) | — (2nd click swallowed) | `up`/`down` | none | R1: legacy outside-close arm kept → R2: Esc at z 35 | `pane_menu_nav { to }` |
| **register-popup** (70) | nav to i | `[nav, return]` = promote | `up`/`down` | `d`, `return`, `escape` — the hint was bare words (`j/k move · … · Esc close`); now declared `[k] label` hints (visible restyle) | Esc = cancel | `register_popup_nav { to }` |
| **which-key** (80) | `{ key: k }` per continuation row — click the next chord key | — | swallow | none | R1: none → R2: Esc (cancels the chord) at z 35 | none |
| **action-palette** (90) | `{ msg: palette_pick { groupPath, actionKey } }` — the row carries its own target | — (2nd click swallowed) | `up`/`down` | `return`, `escape` (`[↑/↓]`, `[type]` not clickable) | **swallow** (typed filter; Esc only clears it) | none |
| **menu** (100) | `{ msg: menu_activate { idx } }` on press / right / middle (the pre-R1 behavior) | — (2nd click swallowed) | `up`/`down` | none | Esc = `menu_close` (today's behavior) | none |
| **cmdline** (110) | nav to match (rows are **reversed**: row i = match `scroll+k-1-i`) | — | `up`/`down` (key parity absorbs the reversal) | none | **swallow** (typed) | `cmdline_nav { to }` |
| **fabric-form** (120) | a field's input AND desc rows → `fabric_form_focus { idx }` (the reducer closes an open choices list); choice row → `fabric_form_choices_pick { port, value }` (existing). Rows are not field-aligned — section headers, warnings, preview, help are null targets | — | picking: `up`/`down`; else swallow | form: `tab`, `backtab`, `' '` (if `hasChoices`), `return`, `escape`; choice list: `return`, `escape` | **swallow** (typed per field) | `fabric_form_focus { idx }` |
| **fabric-field** (130) | — | — | swallow | `return`, `escape` | **swallow** (typed) | none |
| panel-list (60) | R3 — rows are pool-drag sources (§Pointer capture) | | | | | |
| replay-scrubber (140) | R3 — needs a coordinate-carrying seek handler; module state, not model | | | | | |
| hover-tooltip (999) | never — display-only, publishes nothing | | | | | |

Chips repeat on a fast second click (§Press→double continuation); every
other "—" in the Row double column means the second click is swallowed.

R1 publishes a backdrop only for overlays that block chrome
(`suppressChrome: true`) — pinned by `test-overlay-mouse-policy.js`. For the three that let chrome through (jobs,
pane-menu, which-key), a full-screen backdrop at the overlay band would
newly block chrome clicks — so their outside policy waits for R2, when
chrome is in the map and the backdrop can sit at z 35 below it.

## Release 1 — popups (proposed v0.6.56) — the plan

Fixes the field report; makes every popup mouse-capable.

1. `js/panel/hit-map.js` registry + unit tests (z order, opaque stop,
   fall-through, stale-frame rule).
2. `leaves/render/hints.js formatHints` + `draw.setHitSink` + the shared
   `publishBox` helper; `renderOverlay` gains `hit` (see §renderOverlay
   contract for the shape as built);
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
5. Per-overlay commit = descriptor `mouse` + `hit` targets/chips + the
   overlay's numeric `to:` nav extension (or `fabric_form_focus`) with its
   reducer test + a paint-capture test + a raw-SGR test (as built: through
   `input._dispatchToken`; the batched stale-frame cases go through
   `_makeDataHandler`) (`feedback_render_test_new_overlays`,
   `feedback_key_path_integration_tests`).

Exit: every R1 overlay passes the chip≡key parity property (below); the
T13 test (`test-mouse-wheel.js` [4]) updated only where outside policy
intentionally changes behavior; full suite + smoke green under `env -u TMUX`.

## Release 2 — pane chrome + in-pane affordances (proposed v0.6.57)

Plan agreed 2026-11-13 (refines the design-time draft). One commit per step.

0. This section + §Stale-frame rule (Geometry) + the z-band table.
1. **Pane bracket + geometry stamp.** `hitMap.enterPane(paneId, rect, tab)` /
   `exitPane()` around every pane render (composeRects, renderHalf, renderFull —
   the select-view `enterPane` precedent) and `publishLocal(region, z)`, which
   translates a pane-local rect to the screen, clips it to the pane and stamps
   `owner = paneId`. `stampOf` gains `geom` (§Stale-frame rule). Tests: batched
   collapse-key + click on a moved glyph is swallowed; batched hover + click and
   focus-click + chrome click still resolve.
2. **Glyph chrome.** `[_]`/`[+]`/`[X]`/`[≡]` publish from the drawn-chrome
   record renderPanel (and `_renderCollapsed`) already emits — the paint layer
   turns it into regions with handlers. `[≡]`: open → `pane_menu_close`;
   available → `{ act: 'pane-menu-open', paneId }` (shares the cursor seeding
   with the keyboard `T` path). Published only when the mode allows chrome
   clicks (`suppressesChromeClicks` read at paint instead of at click — exact
   parity; the free-config title-edit press keeps reaching the free-config
   handler; the column retires in R3 with free-config capture).
3. **Border controls.** Pane renderers pass the control objects (spec +
   text) to renderPanel, which reports where each drew; the paint layer calls
   `spec.regions` there and publishes `{ act: 'border-control', paneId, type,
   specId, action }`. Repeat chips (`- +`, `‹ ›`) take a fast 2nd click.
4. **Tab strip.** Renderers pass `titleTargets` (from `tabBounds`);
   renderPanel publishes only the tabs that survived truncation (`titleClip`
   retires).
5. **`✗ cancel` + tree markers** publish from text-view's and table's own
   renders (pane-local). Markers only when no chain mode is active (the T13
   parity). `cancelHitInfo` and `tree-regions` go.
6. **Below-chrome backdrops.** Descriptor `mouse.backdrop: 'below-chrome'`
   → the compositor publishes the backdrop at z 35 instead of the overlay band:
   jobs, pane-menu, which-key, each outside = Esc. `_mouseHandlePaneMenuMode`
   goes; the policy test pins "suppressChrome ⇒ band backdrop, else below-chrome
   or none".
7. **Delete** `panel/chrome-regions.js`, `panel/chrome-hittest.js`, the chrome
   cluster and tab-strip arm in `handleMouse`; re-point
   `test-chrome-hittest-agreement` / `test-chrome-trigger-truncation` and every
   test reading the deleted registries; extend the width sweep to chrome.
8. **Adjacent finding 4** (pane-menu right edge) — repro, then fix.
9. Bench vs v0.6.56 (same dir), docs / CHANGELOG / memory, then the 4-track
   pre-release review.

Intentional behavior changes: a key + click in one chunk where the key moved
panes or changed mode swallows a click on chrome (it used to hit whatever is
there now); outside-click closes jobs and which-key (it was dropped); a
double-click on a chrome glyph or fold marker is one toggle (the second click
used to fall through to the pane's double-click intent).

Exit: the re-pointed agreement + truncation tests and the width sweep green;
full suite + smoke green under `env -u TMUX`.

## Release 3 — pane bodies, drags, cascade deleted (proposed v0.6.58)

1. One pane-body region per visible pane: `press` → focus+select intents,
   `double`/`right`/`middle` → `mouseBindings.intentFor`, wheel → `scroll`
   intent, `hover` on stats/composite.
2. Pointer capture + the four controllers (§Pointer capture); panel-list
   rows become `pool-drag` capture sources.
3. Replay scrubber → z 20000 full-screen region with seek-strip handler.
4. Delete: the remaining cascade, `_modeMouseHandlers`,
   `_dispatchActiveModeMouse`, `_MOUSE_MODE_PRECEDENCE`, the
   `isChainActive` mouse gate, `_armedSelect`, `_armedZoom`, every overlay
   `hitTest` export. `handleMouse` becomes the ~30-line router.

Exit: `handleMouse` has no per-mode or per-pane-kind branches; the ~25
mouse-pinning test files green (list in §Test strategy).

Carried from the R2 round-3 review (not bugs today):
- When panel-list rows get real handlers, the stamp must carry
  `layout.panelList` (its `'legacy'` box re-checks live state, so R2 needs none).
- Region owners share one namespace: a pane's owner is its paneId
  (`pane-<pool id>`), an overlay's its descriptor id — a pool entry named
  `menu` owns `pane-menu`, the pane menu's id. The press→double continuation
  compares owners; no collision is reachable now (no shared region ids;
  backdrops swallow `double`), but pointer capture keys on the owner —
  namespace pane owners first.

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
  through the input pipeline (`input._dispatchToken`; batched chunks through
  `_makeDataHandler`), not by calling `handleMouse` directly.
- **Stale-frame** — batched key+click chunks (`test-mouse-stale-frame.js`):
  a click aimed at a vanished/replaced popup is swallowed; a point the stale
  frame drew nothing at still reaches legacy.
- **Bench** — `bench-hotpaths.js` + render-construction before/after, same
  directory (`feedback_benchmark_same_dir`).

## Open questions — resolved

All four were proposals at design time; the user started Release 1 on the
proposals (2026-11-13), and R1 ships them:

1. **Outside policy** — §Per-overlay mapping as built.
2. **Row click** — pure pickers (copy, palette, fabric-form choice list)
   single-click = pick; lists whose activation does something else (jobs =
   jump, register-popup = promote) single-click = cursor, double-click =
   `return`; menu / pane-menu keep the single-click activate; diag-log and
   cmdline: click moves the cursor.
3. **Wheel over a list popup** — synthesizes `up`/`down` (keyboard parity).
   Over the popup only: a wheel notch outside a menu / pane-menu no longer
   steps it (it did before R1 — CHANGELOG §Changed).
4. **Stale frame** — swallow what the stale frame drew (§Stale-frame rule);
   flushing was rejected because the user aimed at the old frame.

## Adjacent findings

Found while mapping the overlays and during R1; none is the reported bug.
Each needed a repro before it was called a bug
(`feedback_dont_speculate_commit`). Item 1 is still unverified and folds into
R3 (the panel-list migration); item 4 was reproduced and fixed in R2.

1. **panel-list header/footer press starts a drag** — *likely bug.* A press
   on the header, footer or preview area leaves the cursor and, if the
   highlighted item is not essential, still dispatches `pool_drag_start`
   for it. The comment in input.js `_mouseHandleFreeConfigMode` says such clicks are swallowed;
   that only holds when the highlighted item is essential. → R3 (panel-list
   migration).
2. **Hover tooltip lingered under some popups** — **FIXED in R1** (`51804536`,
   then `0d57572d`; reproduced first). The tooltip hid on `isModal` (the
   modes.js `modal` column), which is false for confirm, register-popup,
   cmdline, pane-menu, jobs and diag-log: opened by keyboard with the pointer
   parked over a graph, the tooltip painted at z 999 OVER the popup. The
   first fix (`isChainActive`) newly showed it in terminalMode (modal,
   non-chain), where it froze; the gate is now `isChainActive || isModal`.
3. **Two different "modal" flags disagree** — *smell.* The compositor's
   `modal` (one-at-a-time invariant) and modes.js `modal` (owns the footer
   row) disagree for confirm, pane-menu, register-popup and cmdline. Both
   are internally consistent with their own meaning; the shared name
   invites exactly the hover-tooltip mistake in (2). The hit map keys its
   backdrop off neither — off the descriptor's explicit `mouse.outside`.
4. **pane-menu dropdown right edge was not clamped to the screen** — **FIXED
   in R2** (`620ddc84`; reproduced first). Half view on a ~30–34-column
   terminal: the content slot is ~17 wide, and `_geom`'s `w = min(50, max(20,
   paneB.w))` anchored at `paneB.x` spilled past the right edge, cutting the
   border, `╮` and the count. `_geom` now shifts the box left and caps it at
   the screen width (publishBox already clipped the regions).

5. **Double-click on a menu item also activated the pane beneath** — **FIXED
   in R1** (`e0241991`; reproduced first). See §Press→double continuation.
6. **Popup backdrop missed the footer row** — *R1-internal bug, caught by the
   suite, fixed* (`716a11f7`). The first cut sized the backdrop by `newRows`,
   which stops above the footer; a click on the bottom line slipped past the
   popup's outside policy. The backdrop is now viewport-sized.

7. **Pre-release review (4 tracks) — fixed in R1**, each reproduced by a
   reviewer script first: stale frames fell through to the pane under a
   vanished popup, and a content change under an unchanged mode (menu →
   submenu in place) went undetected (`3ceb19e7`); synthesized named keys
   carried their name as `seq` (`098e2d0e`); a backdrop `double` pressed Esc
   when the box shrank, and a fast 2nd chip click was swallowed
   (`aebfe03d`); fabric-form focus left the choices list open on the old
   field (`46a8ea63`).

## Release 1 — as built

All 12 overlays in §Per-overlay mapping shipped as planned, one commit each,
confirm first; commits `dc58dffd..` on main. Deviations / notes:

- `renderOverlay` publishes **only when passed `hit`** — an always-published
  opaque box would have swallowed clicks that unmigrated overlays' legacy
  handlers owned during the migration.
- Test harness `js/test/_helpers/hit-click.js`: raw SGR through
  `input._dispatchToken` after a real paint; resets the double-click triple
  via `input._classifyPress` (an off-screen *press* is itself an outside
  click for a legacy outside-close overlay).
- The API differs from the plan's first draft: one `hit: { lineTargets,
  lineChips, box }` input instead of separate `lineTargets` / `hints`;
  hints are `{ cap, label, key, seq? }`; truncation is decided at publish
  (`chipSurvives`). §renderOverlay contract describes the built shape.
- Width sweep `test-hit-map-agreement.js` (widths 20…200, 1227 checks) pins
  the paint↔hit agreement property for every hit-mapped overlay.
- **Bench gate** (2026-11-13, same filesystem, 10 alternating rounds of
  `bench-render-construction.js`, baseline `f6d152c3` vs R1 HEAD; medians):
  realistic 1068.7 → 1071.5 µs/frame (+0.3%); active-search 1139.8 → 1142.9
  (+0.3%); 50k stress 1101.5 → 981.6 (spread 820–1160 on both trees —
  noise). Both trees show the same bimodal fast runs on the search row.
  Router micro-bench: stamp check + resolve 0.34 / 0.48 / 0.82 µs per click
  at 20 / 150 / 500 regions; publishing 3 / 6 / 18 µs per frame — against a
  ~1070 µs frame. No regression.
- Tests: `test-hit-map.js` / `test-hints.js` (registry, stamp, hints),
  `test-mouse-router.js` (handler forms, stale rule, double rules),
  `test-mouse-stale-frame.js` (batched chunks end to end),
  `test-overlay-mouse-policy.js` (backdrop ⇔ suppressChrome),
  `test-hover-tooltip-chain-gate.js`, and per overlay
  `test-{confirm,fabric-field,copy,diag-log,jobs,register-popup,which-key,
  action-palette,menu,pane-menu,cmdline,fabric-form}-mouse.js`.

## Release 2 — as built

Steps 0–8 of §Release 2 shipped one commit each on main (`c075b2ca..`), step 6
and adjacent finding 4 together (both touch `overlay/pane-menu.js`). Notes:

- **Pane bracket.** `_safeRender` (and the collapsed-pane path in
  `composeRects`) brackets each pane render with `hitMap.enterPane(paneId,
  rect, activeTabId)`; the screen origin rides `opts.x/y`. Pane renderers and paint publish
  pane-local rects through `publishLocal`, which translates and clips to the
  pane. A pane whose render throws `retractOwner`s what it published.
- **One chrome publisher.** renderPanel's drawn-chrome record (the old
  chrome-regions payload) now also reports where each border control drew
  (`controls`, `bottomControl` — the control objects ride through renderPanel)
  and which title targets survived truncation (`tabs`). `render/pane-hits`
  (`begin` / `end` bracket + `publishChrome`) turns the record into regions
  for the pane being rendered. Gates, decided once per frame in paint's
  `_chromeContext` and passed to every pane render: `chromeLive` (chrome band —
  `!suppressesChromeClicks`, terminalMode excepted, no free-config drag) and
  `bodyLive` (`!isChainActive` — tabs and fold markers, which sat below the T13
  gate).
- **`{ act }`** (`dispatch/control/mouse-acts.js`): `pane-menu-open`
  (`pane-menu.openAt`, cursor seeding shared with the keyboard `T` via
  `seedCursor`) and `border-control` (`resolveBorderControl` — re-runs
  `borderControlsFor` with the current focus + mode, checks the action is still
  offered, then `spec.dispatch`). A spec's `regions()` declares which parts
  repeat on a fast 2nd click (steppers: refresh `-`/`+`, sort `‹`/`›`);
  toggles and item actions don't.
- **`buildTextView` passes `titleTargets` through** — the first cut published
  no tabs for info / text-view because the builder whitelists renderPanel opts.
- **Deleted:** `panel/chrome-regions.js`, `panel/tree-regions.js`,
  `panel/chrome-hittest.js`, text-view `cancelHitInfo`, pane-menu
  `hitTestTrigger`, `_mouseHandlePaneMenuMode`, the chrome cluster / tab-strip /
  tree-marker arms of `handleMouse`, and the paint-mirroring helpers that only
  existed for click-time re-derivation (`border-controls` fits / placeX0s /
  reservedW / bottomX0; `refresh-control` BorderX0 / Fits / Dir).
- **Adjacent finding 4 — reproduced and fixed.** Half view on a ~30–34-column
  terminal: the content slot is ~17 wide, the dropdown's 20-cell floor anchored
  at the pane's x spilled past the right edge (border, `╮`, count cut).
  `_geom` now shifts the box left and caps it at the screen width.
- Tests: `test-chrome-mouse.js` (glyphs, mode gating, stale geometry, double,
  tab strip); the pinned R1 tests for jobs / pane-menu / which-key / stale-frame
  updated for the below-chrome backdrops; every test that read the deleted
  registries re-pointed at painted fixtures (`hit-click` helpers `screenRows`,
  `screenText`, `chromeAt`/`triggerAt`/`collapseAt`/`closeAt`,
  `borderControlAt`, `cancelAt`, `treeMarkerAt`).

### Pre-release review (4 tracks) — fixed before release

Each reproduced by a reviewer script first:

- **Leaving terminal mode and clicking in one chunk** turned a `[_]` click into
  a body click: paint gated chrome on `terminalMode` (suppressChrome, but
  non-chain — not in the stamp). `chromeLive` now ignores terminalMode (its
  mouse goes to the PTY anyway), and the gates live in one place.
- **Every top-strip control repeated** on a fast 2nd click — a double-click on
  `‹ tree ›` or the sort label toggled twice (a no-op). Specs now declare
  `repeat` per part.
- **A body click batched behind the key that closed jobs / pane-menu /
  which-key was swallowed** anywhere on screen: the below-chrome backdrop
  claimed every cell of the stale frame. Those backdrops are `invisible` to
  `claims` (the panes under them look live); the click reaches legacy, as in
  v0.6.56.
- **Chrome pushed onto the footer row** (min-height floors on a short terminal)
  was clickable there — inherited from v0.6.56's registries. The pane bracket
  clips to the composed frame.
- **Border controls of a collapsed pane shown in half / full view** were dead
  (the act rejected `collapsed`; half / full render it expanded). The act checks
  the visible bounds instead.
- **A router-consumed press left a pending text-selection arm** (inherited
  since R1 for chips): presses now disarm before the router.
- **Bench gate caught a regression** (10 alternating rounds of
  `bench-render-construction.js`, v0.6.56 `9eb8e2a5` vs R2, same filesystem,
  quiet machine; medians): realistic 1044.8 → 1132.4 µs/frame (+8.4%, ranges
  barely overlapping). Root cause: `hit-map.stampOf` called
  `require('./route')` inside the function — ~65 µs per call, per frame AND per
  click. Cached (paint.js documents the same trap); the four slot renderers'
  and slot-strip's per-render requires (pre-existing, on lines R2 rewrote)
  likewise. Re-gated on `8a3b34b2`: realistic 991.2 → 901.7 (−9.0%), 50k
  stress 986.5 → 908.5 (−7.9%), active search 1122.6 → 1001.5 (−10.8%).
- **Round 2** (two fresh reviewers on the fix commit + angles round 1 missed;
  replay, hover, right / middle / wheel found clean): the composite cycler's
  label is a stepper and repeats; a batched tab switch + a click on the old
  tab's control reached the new tab's instance (fixed in `geom`, re-fixed per
  pane in round 3 — §Stale-frame rule, Tab scope); the `border-control` act finds its spec by
  identity (plugin specs need no / no unique `id`); a spec whose `regions()`
  throws loses only its own clicks instead of turning the pane into an error
  block; and the free-config panel list owns its box (`'legacy'` handler — the
  legacy handler still realizes its clicks until R3), so chrome under it is no
  longer clickable through it (inherited). Kept: a click during the resize
  debounce is dropped (the stamp includes dims — the safe side).
- **Round 3** (two fresh reviewers: the round-2 fix commit, and angles neither
  round covered — 26.4k-click every-cell differential sweep vs v0.6.56 across
  14 scenarios found no R2 behavior change beyond the intended backdrops).
  Fixed, each reproduced first:
  - one pane's tab switch staled every pane's clicks (round-2 regression) —
    the tab check is now per region (Tab scope above);
  - a `regions()` returning a non-array or a null part still turned the pane
    into an error block (round-2 guard caught only a throw) — malformed parts
    are dropped, the error recorded ONCE per pane / control / message (it was
    every frame);
  - a plugin whose `borderControls` getter builds fresh spec objects per read
    never matched by identity (round-2 regression) — the act falls back to a
    unique `id`, else records the miss; a throwing click-time `regions()` /
    `dispatch` is recorded, not thrown; region ids use the spec's own key when
    its `id` is missing or shared (the double-click continuation can't confuse
    two controls);
  - on a terminal of ≤ 6 rows (availRows' floor) chrome under the footer row
    still took clicks (inherited) — the hit frame stops above the footer;
  - an unclosed `[` in a title or hotkey paired with a later fragment's `]`, so
    `[_]`/`[X]`/`[≡]` painted off their regions (inherited) — every fragment of
    the composed top row (and the collapsed bar) is sealed (`ansi.sealMarkup`);
  - a narrow pane whose glyph cluster doesn't fit draws its tab strip in the
    bare border, unclickable (inherited) — the fallback reports its tabs too.
- Plus doc / comment parity, `titleClip` and three dead exports removed, the z
  bands in one table (`BANDS.OVERLAY_BASE`), and the chrome publisher moved to
  `render/pane-hits.js`. `buildEntryStrip` keeps its pane-local `tabBounds`: the
  tab-click smoke test checks the published regions against them.

## Rollback

R1 keeps the legacy cascade as the miss path, so reverting a single
overlay's commit restores the old behavior for it alone. R2 does not: each
step deleted its own legacy `handleMouse` arm, and step 7 deleted the
registries those arms read — revert R2 as a whole (`c075b2ca..` on main), not
per element. R3 removes the cascade; its rollback is a release revert.

## Non-goals

- Terminal-mode (embedded PTY) mouse — stays raw passthrough.
- Horizontal wheel (66/67) — still dropped; lazytui has no horizontal axis.
- New mouse *features* (drag-to-reorder lists, resize popups, hover
  highlight of chips). The hit map makes them cheap later; not in scope.
- Changing the `mouse:` YAML surface.

## Session kickstart

Releases 1 and 2 are built (popups; pane chrome). Next is Release 3 (pane
bodies, pointer capture, replay scrubber, the legacy cascade deleted). Read
this doc, then `js/panel/hit-map.js`, `js/dispatch/control/mouse-router.js`,
`js/dispatch/control/mouse-acts.js`, `js/render/paint.js`
(`_safeRender`'s pane bracket), `js/render/pane-hits.js` (pane-body regions
publish there too), `js/dispatch/control/input.js` (`handleMouse` — the
router call, then the legacy cascade R3 replaces: `_modeMouseHandlers`, the
T13 gate, `_armedSelect` / `_armedZoom`, the body press loop),
`js/overlay/panel-list.js` and `js/overlay/replay-scrubber.js` (the last
re-derived `hitTest`s). Start at §Release 3 step 1.
