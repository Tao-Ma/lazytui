# One tab system (U2) — fold the viewer's content-tabs into position-tabs

> **Status:** planning. A large, multi-release arc — do not start without an
> explicit commitment. Supersedes the P2–P4 approach in
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

- **U1 — tab-container interface.** Define the contract + two backings; route the
  per-tab-state consumers (selection/scroll/cursor/search) through it. Reuses the
  P1 `tab-state` leaf. No behaviour change. *The keystone — everything else
  migrates behind it.*
- **U2a — extract `text-view`.** Pull the viewer's text rendering (scroll/search/
  select/cursor over a line buffer) into a standalone `text-view` pane type; the
  viewer delegates its content rendering to it. No new panes yet.
- **U2b — mint-into-slot.** Build the runtime "add instance X to slot S's tabs +
  focus" primitive (generalize tab-drag placement). Prove it by opening a manual
  `text-view` tab in a slot.
- **U2c — route action output to a `text-view` instance.** Running an action mints
  (or reuses) a `text-view` in the viewer's slot; output streams to that
  instance. Retire `actionTabBuffers` / action content-tabs.
- **U2d — `terminal` pane type.** PTY becomes a minted `terminal` pane; retire
  `ephemeralTerminals` + term content-tabs.
- **U2e — `info` (+ Transcript → `text-view`).** The viewer slot starts with an
  `info` tab; Transcript becomes a `text-view`. The "viewer" Component is now
  just a default slot layout.
- **U2f — retire the parallel machinery.** Delete `contentTabs`, `tab-strip.js`
  (folded into the slot strip at D2), the viewer's `select` state (now per-
  instance), and `pane-tabs.js`'s viewer-only tab-kind logic. `tab-state` (P1)
  remains as the generic per-instance view-state store.

Selection unification lands as a *consequence* of D4 across U2c–U2f, not as a
separate phase.

## What gets deleted (the payoff)

`slice.contentTabs`, `slice.tabState`-as-viewer-special, `slice.ephemeralTerminals`,
`slice.actionTabBuffers` / `viewerStreamBuffer` routing, `panel/viewer/tab-strip.js`,
the viewer-specific tab-kind machinery in `leaves/wm/pane-tabs.js`, and the
per-content selection in `panel/viewer/select.js`. The viewer stops being a
god-object; there is one tab concept, one strip, one selection model.

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
