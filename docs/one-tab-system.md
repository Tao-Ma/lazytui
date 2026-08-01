# One tab system (U2) — fold the viewer's content-tabs into position-tabs

> **Status:** COMPLETE — U1 · U2a–U2f all shipped (branch `pane-tabs`). One tab
> system: every tab is a position-tab instance; the viewer god-object is gone.
> **U1 + U2a + U2b shipped** — U1 the keystone interface
> (`leaves/wm/tab-container.js` + consumers routed); U2a the text-view render
> primitive (`leaves/text-view/render.js` + search geometry moved to a leaf); U2b
> the **full per-tab instance model** (each tab a first-class instance) + the
> mint-into-slot primitive (`:text-view` opens a text-view tab into a slot). All
> no-behaviour-change for existing layouts. **U2c SHIPPED** (P0: shared
> `textViewUpdate` interaction reducer + full `text-view` Component + `instanceKind`
> routing fix; P1: action output mints/reuses + streams into a `text-view` instance
> by paneId; P2: the flat action-tab strip + `actionTabBuffers` retired). Action
> output is now fully re-homed to text-view position-tabs. **U2d SHIPPED**
> (terminal-as-pane: the embedded PTY is a minted `terminal` pane, YAML
> `group.terminals` are open-on-demand actions, and the viewer strip's terminal
> segment + `ephemeralTerminals` are excised). **U2e SHIPPED** (the atomic pivot:
> the `detail`/viewer Component dissolved into sibling POSITION-tabs — Info is an
> `info` pane instance, Transcript + opened content are `text-view` instances; the
> content slot is identified by a stable `pane.role==='content'`). **U2f SHIPPED**
> — the parallel machinery is DELETED: `panel/viewer/viewer.js`, `viewer/tabs.js`,
> `leaves/wm/pane-tabs.js`, the flat-tab drag-reorder, `tab_switch`/`viewer_*`
> content Msgs, tab-container's viewer backing, and the drained slice fields
> (`contentTabs`/`tab`/`viewerStreamBuffer`/`viewerOverride`/`infoLines`). The
> content slot's stable identity (`pane.id/type/title = detail/Detail`, a layout
> keyword, no Component) is preserved across tab switches for listings +
> `:save-layout`; `paint` resolves each pane's renderer by its ACTIVE-tab instance
> kind. Follow-up #11 (listings showed the active tab's "Info" not the slot's
> "Detail") + nav-history position-tab capture folded in. ONE tab system now.
> Supersedes the P2–P4 approach in
> [pane-tabs-unification.md](pane-tabs-unification.md) (its P1 — the shared
> `leaves/wm/tab-state` store — stays and is reused here as U1's basis).

## One line

lazytui has **two** tab systems; the viewer reinvented tabs instead of using the
general one. Collapse them: make the viewer's content *kinds* (info / transcript
/ action-output / terminal / file) into small **pane types** hosted as ordinary
**position-tabs**, so there is one tab system and per-tab state is per-instance
everywhere.

## The problem — a tab system bolted next to the tab system

| | **General: position tabs** | **Viewer: content tabs** |
|---|---|---|
| A tab is | a pool-entry **instance** in a layout slot | a content view *inside one* instance |
| Per-tab state | the instance's own slice (free) | bespoke `slice.contentTabs[group][key]` + `slice.tabState` |
| Switcher | the `[≡]` pane-menu (`overlay/pane-menu`) | *that, plus* its own always-on flat strip (`panel/viewer/tab-strip`) |
| Runtime create | `wrapAsPane` (`tabs:[{single}]`) + `tab-drag` | its own content-tab minting + `ephemeralTerminals` + `actionTabBuffers` |
| Content | any Component | text (Info/Transcript/action/file) + PTY |

Every pane is *already* a position-tab container: `leaves/wm/pane.wrapAsPane`
gives each pane `tabs: [{ id, poolId }]` + `activeTabId`, and `paint.js` shows the
`[≡]` switcher for "a viewer with ≥2 tabs, **any other pane** with ≥2 tabs." Yet
the viewer *also* carries a parallel content-tab store, a second strip, and its
own dynamic-tab minting. That duplication is the root of the "two selection
state shapes" (per-instance vs per-content) from
[pane-selection.md](pane-selection.md) — not two real concepts, one concept
implemented twice.

## Target model

Everything is a **pane** (instance) in a **slot** (layout position). Tabs =
multiple panes in one slot. The viewer's content kinds become pane *types*; a
"viewer" slot is just a slot that starts with an `info` tab and **accretes**
`text-view` / `terminal` tabs as actions run and files open — which is exactly
what position-tabs already do. Consequences:

- **One tab system** — `pane.tabs[]` + `activeTabId` + the `[≡]` switcher (and a
  generalized flat strip). No `contentTabs`, no viewer `tab-strip.js`.
- **Per-tab state = per-instance, uniformly.** `tabState` (the P1 leaf) survives
  only as generic per-instance view-state; the viewer's per-content selection
  collapses onto per-instance `model.selection`, retiring the Stage-2 split.
- **The viewer god-object dissolves** into ~4 small content pane-types.

### The content pane-types

| New pane type | Replaces (viewer content-tab kind) | Renders |
|---|---|---|
| `info` | Info | group metadata (mostly static, group-scoped) |
| `text-view` | action-output **and** opened-file **and** Transcript | scrollable text w/ scroll · search · select · cursor |
| `terminal` | terminal tab | the embedded PTY |

Transcript folds into `text-view` (it is just an unrouted-output text buffer);
`info` may stay tiny or also be a `text-view` variant (decide at D3).

## The three hard mechanisms

1. **Mint-into-slot.** Running an action / opening a file must mint a pane
   instance **into a specific slot's `tabs[]`** at runtime. Position-tabs can be
   created, but "add this dynamic instance to *that* slot's tab list + focus it"
   is the core new primitive. Generalizes `tab-drag`'s placement.
2. **Output routing.** Action stdout currently streams into the viewer's
   `actionTabBuffers` / `viewerStreamBuffer` (a content-tab buffer). It must
   instead stream into the routed **`text-view` instance's** slice. The routing
   key moves from `(viewer, contentKey)` to a `paneId`.
3. **Terminal-as-pane.** The PTY (today `ephemeralTerminals` + term content-tabs
   inside the viewer) becomes a first-class `terminal` pane type minted into the
   slot. The PTY side-channel (WAL/replay per foreign-components.md) is unchanged;
   only its host moves.

## Design decisions (pin before building)

**D1 — U1 (uniform tab-container interface) is the bridge, not a throwaway.** A
single contract — `listTabs / activeTab / switchTab / perTabState` — with two
backings (instance-backed for slots, `tabState`-backed for the today-viewer.
Selection/scroll/cursor route through it, container-agnostic. Every later phase
migrates a kind *behind* this interface so the viewer never stops working.

**D2 — Generalize the flat strip; retire the `[≡]`-only presentation gap.** The
viewer's always-on flat strip (`tab-strip.js`) is nicer than a menu for many
tabs. Make it the **slot** strip: any slot with ≥2 tabs shows it. One strip for
all panes; `[≡]` stays as the compact/overflow switcher.

**D3 — `text-view` is one renderer for action-output + file + transcript.** They
already share scroll/search/select/cursor. `info` stays a thin separate type
(group metadata isn't scrollable text). *Open:* could `info` be a `text-view`
seeded with metadata lines — decide when text-view exists.

**D4 — Per-tab state is per-instance; `model.selection` becomes the only
selection.** The viewer's `slice.select` + per-content persistence retire; a tab
switch shows a different instance, whose selection is its own. This makes the
Q2 decision (persist-per-group) fall out for free: a group's tabs are its own
instances.

**D5 — Incremental, gate-green, no big-bang.** Each kind migrates in its own
phase behind U1; the parallel machinery is deleted only after its replacement
ships and passes the gate (suite · smoke · acyclic · DEAD 0 · bench parity).

## Phasing (each phase ships behind the gate)

- **U1 — tab-container interface. ✅ SHIPPED.** `leaves/wm/tab-container.js`
  defines the contract (`listTabs / activeTab / switchTab / perTabState`) over a
  descriptor tagged by `backing`, with the viewer (tabState-backed, model-path +
  from-bundle twin) and instance (slot `pane.tabs[]`, `perTabState` a documented
  U2b stub) backings. Consumers routed: the `[≡]` pane-menu list + pick
  (`_flatTabs`/`items`/`triggerVisible`/`_paneMenuPick`) and the viewer's
  per-tab-state (finalizer capture + `show_info`/`set_tab`/`tab_switch` restores +
  the R4 drop) — the viewer no longer touches `slice.tabState` raw. `switchTab` is
  read-only (names `{target, msg}`; the caller dispatches). Reuses the P1
  `tab-state` leaf (+ a new `entry()` accessor). No behaviour change (adversarially
  reviewed). *The keystone — everything else migrates behind it.*
- **U2a — extract `text-view`. ✅ SHIPPED.** The viewer's scrollable-text
  rendering (window a line buffer → decorate → renderPanel args) is now the pure
  leaf `leaves/text-view/render.js#buildTextView`; `viewer.render()` derives the
  content (`pt.viewerLines`, tab-kind-aware — stays) and hands the leaf resolved
  decoration state. Prereq landed: the search highlight geometry moved from the
  impure `panel/viewer/search.js` into `leaves/text/search.js#decorateWindow`
  (mirror of `select-core#decorateWindow`), making search symmetric with
  selection. Interaction reducer arms (scroll/search/select/cursor) STAY in the
  viewer — extracting them into a shared `textViewUpdate` is U2c (when a routed
  instance shares it). No new panes minted. No behaviour change (A3 windowed-
  decorate byte-identical, ~326µs flat; adversarially reviewed).
- **U2b — mint-into-slot. ✅ SHIPPED.** Two parts. (1) The **full per-tab instance
  model** (approach K3): `reconcilePaneInstances` mints one instance per TAB
  (`tabInstId = pane-<poolId>`, kind from the tab's pool entry — fixing cross-kind
  slots), and `route._activeInstanceOf[paneId]` maps a slot to its active tab's
  instance; the four slice accessors + `componentForPanel`/`paneTypeOf` resolve a
  paneId through it (`getInstance` stays literal so a non-active tab is
  addressable). Byte-identical for existing layouts (single-tab: tabInstId ===
  paneId, identity map). (2) The **mint primitive**: `pool.mintPoolEntry`
  (transient, replay-deterministic id) + `pane.addTab` + a `mint_tab` layout Msg;
  the `text-view` pane type; a `:text-view` verb that mints into the focused slot;
  serialization drops transient entries (session-only). Adversarially reviewed.
- **U2c — route action output to a `text-view` instance.** Running an action mints
  (or reuses) a `text-view` in the viewer's slot; output streams to that
  instance. Retire `actionTabBuffers` / action content-tabs. Decomposed P0/P1/P2.
  **Lifecycle (decided): accrete + persist + hint** — a `tab:true` action's output
  tab is minted on first run, keyed by a `hint = {origin:'action', group, key}`,
  persists as a position-tab across group switches, and is reused on re-run (no
  empty pre-declared tab). The tab-groups clustering UI (collapsible hint sections
  + hint-guided drag, generalizing D2) is a **separate follow-on** — U2c only
  *stamps* the hint. Interim: the slot strip is flat and coexists with the viewer's
  internal Info/Transcript strip until U2e unifies them.
  - **P0 (shipped).** The scroll/search/select/cursor state machine extracted from
    the viewer into the shared pure leaf `leaves/text/text-view-update.js#reduce`
    (`(msg, slice, lines, ownKind)`); the viewer delegates its interaction arms to
    it (byte-identical, ownKind `'detail'`) and the `text-view` Component adopts it
    (ownKind `'text-view'`), gaining full search/select/cursor + per-instance
    selection (the partial D4 collapse). `innerH` is stamped by a `text-view`
    `augmentMsg` via the shared `panel/pane-viewport.js#paneInnerH` (no
    viewer↔text-view edge). `route.instanceKind` now routes through `_resolveActive`
    (follow-up #1) so a runtime-switched slot's `focusKind`/keymap read the active
    tab's kind. No routing change; `actionTabBuffers` untouched. Gate: suite 155 ·
    smoke 14 · dep-walker `[]` both modes · dead-exports 0 · bench parity.
  - **P1 (shipped).** Producer re-target. `action-runner.ensureActionTab` mints (or
    reuses, via the `mint_tab` id-collision no-op) a `text-view` in the viewer's slot
    keyed by the hint-derived poolId `tv-act-<group>-<key>`, stamps the hint, and
    returns stream opts: a `slotKey` (the per-action concurrency/preempt key — always
    distinct, a pure function of group+key) kept SEPARATE from `tabInstId` (the
    display target, set only when the instance exists — so a no-layout env still runs
    on its own slot). `stream.js` streams `tv_stream_start`/`tv_append`/
    `tv_append_lines` to the instance by paneId (off-tab lands via the distinct
    instance id — no R2 collision); the per-instance bottom-stick lives in the
    text-view's `update`, so the old `_routedBundle` (currentGroup/activeActionTabKey
    threading) is deleted. Focus policy: `mint_tab`/`set_active_tab` FOCUS-FOLLOW the
    target slot, so a background action run shows its output without stealing focus
    (`:text-view`, which mints into the focused slot, still focuses). Fabric `run:`
    routes its DISPLAY here too; its RAW output → `model.fabric.output` (unchanged)
    is what output ports derive from, independent of the display. `actionTabBuffers`
    is now dead-fed (deleted in P2). Gate: suite 156 · smoke 14 · dep-walker `[]` both
    modes · dead-exports 0 · bench parity. New test-action-tab-route (mint/reuse/
    accrete/off-tab) + updated test-mint-tab / test-stream-multi-job / test-fabric-demo.
  - **P2 (shipped).** Retired the vestigial flat action-tab machinery across ~8
    files: `slice.actionTabBuffers` + the routed branches of `viewer_append`/
    `viewer_append_lines`/`stream_start`; `flatTabInfo`'s `actionTabs` enumeration +
    all the `2 + actionTabs.length` index math (`isActionTabIn`/`activeActionTabIn`/
    `actionTabCount` deleted; terminals/content now index from 2); the tab-strip +
    tab-container action rendering + the `●` running-glyph set; the merged-actions
    provider seam (`setMergedActionsProvider`/`_mergedFor`, its only consumer). Info
    (tab 0) + Transcript (tab 1 / `viewerStreamBuffer`) + the unrouted stream path
    STAY (they migrate in U2e). **Two gestures degraded to follow-ons** (they already
    pointed at the now-dead flat tabs after P1, so not regressions of working
    features): the Running-overlay "jump to a stream-routed job's tab" (now focus-
    only) and Enter-to-rerun-on-the-action-tab (re-run from the actions list) — both
    re-wire to the text-view position-tab later (Enter via the `{origin:'action'}`
    hint). `actionCount` is neutralized to 0 in the model bundle so the terminal/
    content mutators' `2 + actionCount + …` index math stays correct without churn
    (those mutators are reworked when terminals move — U2d). Deleted the tests that
    pinned the retired feature (`test-action-tab-buffer`, `test-plugin-tab`,
    `smoke/action-tab`); updated the index-scheme + jump/glyph tests. Gate: suite 154
    · smoke 13 · dep-walker `[]` both modes · dead-exports 0 · bench parity.
  Follow-up #2 (`resolveViewerPaneId` viewer-specific): REUSED as-is, not
  generalized (the action text-view's container *is* the viewer slot).
- **U2d — `terminal` pane type (shipped).** The embedded PTY becomes a first-class
  minted `terminal` pane instead of a viewer content-tab. The PTY WAL/replay
  contract (docs/foreign-components.md) is unchanged — only the terminal's host
  moves. Sub-phases:
  - **P0a (shipped).** Behavior-preserving overlay refactor: `renderTerminalOverlay`
    consumes a `visibleTerminalSurfaces` list (per-session force-state) instead of
    the single-terminal singletons — still single-source.
  - **P0b (shipped).** The `terminal` pane-type Component + the missing `remove_tab`
    primitive (`layout.remove_tab` / `mpane.removeTab` / `mpool.removePoolEntry`) +
    `destroySession`-on-orphan; the shared `panel/terminal-surfaces.js` selector
    (one producer) wired into the overlay + poll gate; the finalizer per-pane PTY
    reconcile loop.
  - **P1a/P1b (shipped).** Interactive terminal panes (input · Enter-activation ·
    exit · `:terminal`); `type:spawn` mints a `terminal` pane (bare-PTY branch;
    tmux untouched).
  - **P2.5 (shipped).** Docker exec mints a reused `terminal` pane; `addEphemeralTab`
    retired.
  - **P2a (shipped).** YAML `group.terminals` migrate to auto-generated
    `type:'terminal'` actions (open-on-demand — the docker-`compose` precedent),
    resolving the fork to option B: position-tabs, not group-derived content.
    Configured terminals stay discoverable in the actions list; the only UX change
    is no auto-show. Also fixed a latent framework bug: cmdline verbs that mint a
    pane (`:terminal`/`:text-view`/`:add-column`) never triggered the finalizer, so
    the pane didn't spawn/paint until the next keypress (`loop.js#applyMsg` now
    finalizes when the arrange changed under it).
  - **P2b (shipped).** Excised the vestigial terminal content-tab machinery +
    re-based the viewer strip to `[Info] [Transcript] [contentTabs…]` (content
    starts at 2): dropped `slice.ephemeralTerminals` + `groupTerminals` +
    `addEphemeral`/`removeEphemeral` + the `viewer_add/remove_ephemeral_terminal`
    arms + the `isTerminalTab`/`activeTerminalId`/`activeTerminalConfig`/
    `findEphemeralByid`/`removeEphemeralTab`/`handleSessionCleanExit`/
    `paneForSessionId` facades + `modelBundle`'s `yamlTerminals`/`actionCount` + the
    `2 + actionCount + termTabs.length` index math across every mutator/reader.
    Rewired all consumers (finalizer legacy PTY block, footer terminal label →
    focused pane, wheel scrollback → terminal pane, mousedown-select guard,
    pane-menu close, dead-terminal `x`, `run_selected`, `jobs_route` pty branch,
    tab-strip/tab-container). Retired the dead `destroy_pty_session` effect. Gate:
    suite 155 · smoke 13 · dep-walker `[]` both modes · dead-exports 0 · bench parity.
- **U2e — `info` (+ Transcript → `text-view`). ✅ SHIPPED** (the atomic pivot,
  P0→P4). The content slot's default tab is an `info` instance; Transcript + opened
  content are `text-view` instances; the slot is identified by a stable
  `pane.role==='content'` (not the `detail` kind). The override writers
  (config-diff/history/help/job-info) rehome to text-view content tabs.
- **U2f — retire the parallel machinery. ✅ SHIPPED.** Deleted
  `panel/viewer/viewer.js` (the `detail` Component), `viewer/tabs.js`,
  `leaves/wm/pane-tabs.js`, the flat-tab drag-reorder (`tab-drag.js` + `tab_drag_*`),
  `tab_switch`/`viewer_set_tab`/`viewer_*_content_tab` Msgs, tab-container's `viewer`
  backing (only `instance` remains), `tab-strip.js#buildTabStrip` (only
  `buildEntryStrip` for the slot strip), and the drained slice fields
  (`contentTabs`/`tab`/`viewerStreamBuffer`/`viewerOverride`/`infoLines`). The
  content slot's `pane.id/type/title` stay the stable `detail`/`Detail` keyword
  (no Component) across tab switches — that's what listings + `:save-layout`
  serialize (from `role`, not a `detail`-typed tab); `paint._safeRender` resolves
  each pane's renderer by its ACTIVE-tab instance kind, not `pane.type`. Kept the
  generic infrastructure: `tab-state`, `tab-container` (`instance`), `tvu`,
  `buildTextView`, `viewer/{search,select}.js` (shared facades). Folded in
  follow-up #11 (`placedIds`/`hiddenIds`/`panelListItems` key on the slot's stable
  id + skip transient tabs → listings show "Detail", not the active "Info") and
  nav-history position-tab capture (`_captureNavLocation` gates on `isViewerKind`,
  records the active tab's poolId, restores via `set_active_tab`). Executed as 3
  commits (C1 flat-tab-drag · C2 vestigial reads · C3 the atomic delete + fold-ins
  + fanned test migration); 2 latent prod bugs the migration surfaced were fixed
  (blank content-slot render; empty nested job-info card). Gate: suite 157 · smoke
  13 · dep-walker `[]` both modes · dead-exports 0.

Selection unification lands as a *consequence* of D4 across U2c–U2f, not as a
separate phase.

## What gets deleted (the payoff)

`slice.contentTabs`, `slice.tabState`-as-viewer-special, `slice.ephemeralTerminals`,
`slice.actionTabBuffers` / `viewerStreamBuffer` routing, and the viewer-specific
tab-kind machinery in `leaves/wm/pane-tabs.js` (the pure strip-geometry engine
survives as `leaves/wm/tab-strip.js` — re-homed from `panel/viewer/` via
`panel/content/` — and now drives every pane's slot strip).
The viewer stops being a god-object; there is one tab concept and one strip.

The selection collapse (D4) landed **partially** in this arc: keyboard
visual-mode selection stayed in the content instance's own `slice.select`
(per-tab, driven by a `v`/`V` state machine), distinct from the single-owner
`model.selection` that mouse drag-to-copy used in every other pane, sharing only
the geometry core (`leaves/text/select-core.js`). *Follow-up (2026-08-01): the
collapse completed — in the OPPOSITE direction from D4's sketch. `slice.select`
won as the one shape (per-instance ⇒ per-tab persistence for free, exactly what
this arc's instance-per-tab made possible); `model.selection`, the `mouse_sel_*`
arms, and the viewer facade are gone. See docs/pane-selection.md.*

## Non-goals

- Not changing the PTY WAL/replay contract (foreign-components.md) — only its host.
- Not a new persistence surface — per-tab state stays in-model, session-transient.
- Not removing the `[≡]` switcher — it stays as the compact/overflow control.

## Risks

- **Blast radius.** The viewer is one of the most-tested, hottest paths (streaming
  output, terminals, search, selection). This is weeks of careful, phase-gated
  work.
- **Output-routing regressions.** Moving from content-key routing to paneId
  routing (U2c) is the subtlest change; concurrent action streams + off-tab
  appends (see the v0.6.2 viewer-stream work) must keep working.
- **Terminal lifecycle** (U2d) — minting/disposing a `terminal` pane must not
  orphan or duplicate PTYs.

## Open questions

- **Q1:** Does a slot need a *default* pane type (the "start with `info`")
  concept, or is an empty slot valid until the first tab is minted?
- **Q2:** How do `info` / `transcript` (group-scoped singletons today) behave as
  instances across group switches — one instance retargeted, or per-group
  instances?
- **Q3:** Is `text-view` a bundled pane type usable in user configs (place a
  scrollable text pane directly), or internal-only at first?

## Relationship to prior work

Builds on the position-tab system (v0.6.1 panes-as-containers), the P1
`tab-state` leaf, and the per-pane selection ([pane-selection.md](pane-selection.md)).
Revises [pane-tabs-unification.md](pane-tabs-unification.md): that doc's instinct
(uniform per-tab state) is right, but the direction inverts — instead of giving
flat panes their own content-tabs, dissolve the viewer's content-tabs into the
position-tabs flat panes already have.
