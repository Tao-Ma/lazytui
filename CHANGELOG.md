# Changelog

All notable changes to lazytui are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning
follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [0.6.2] — 2026-06-03

### Changed (BREAKING)
- **YAML layout shape.** `layout.left:` / `layout.right:` blocks are
  replaced by an ordered `layout.columns:` list. v0.6.1 configs do
  not parse — the SchemaError points at
  [`docs/v0.6.2-migrate.md`](docs/v0.6.2-migrate.md). One mechanical
  edit per config: wrap the two existing blocks in a `columns:` list
  and drop the `left:`/`right:` keys. Per-cell shape (bare pool-id,
  `tabs: [...]`, `height: 60%`, `heightPct`, `collapsed`, explicit
  `hotkey:`) is unchanged. Last column's `width:` is ignored (warns
  at parse — last column takes the remainder).

  ```yaml
  # v0.6.1 — no longer parses
  layout:
    left:  { width: 30, panels: [groups] }
    right: { panels: [detail] }

  # v0.6.2
  layout:
    columns:
      - { width: 30, panels: [groups] }
      - { panels: [detail] }
  ```

### Added
- **N-column layouts.** The hardcoded two-column shape retires.
  `arrange = { columns: [{width?, panels: [...]}], detailHeightPct,
  pool }` ordered left-to-right. The last column's width is implicit
  (takes the remainder); every other column carries an explicit
  `width:` in cells. Hotkey pool per column: first column gets
  `1`-`6`, last gets `7`-`9`, middle columns get no auto-pool (panes
  must specify hotkeys explicitly). Detail + actions panes still
  anchor to the LAST column by invariant; "must be in the right
  column" error strings now say "must be in the last column."

- **Drag-edge spawn.** In free-config mode, dragging a pane (or a
  pool entry from the `w` overlay) within 2 cells of the terminal's
  left edge or an internal column boundary spawns a fresh column at
  that position. Right-edge spawn is hit-tested but refused — would
  push detail off the last column. Detail / actions sources are
  refused for all new-column drops (they're reserved to the last
  column). New column's width is stolen from the adjacent column(s);
  source columns that go empty are auto-removed.

- **`:add-column [N]` / `:remove-column <N>` cmdline verbs.** Insert
  an empty column at 1-based position `N` (default: just before the
  last column — internal position N-1); remove the column at 1-based
  index `N` (refused for the last column, for non-empty columns, and
  for out-of-range indices). Drag panes in afterwards.

- **Status notices.** `slice.freeConfig.notice` gains a sibling
  `noticeKind` field (`'info'` | `'error'`, defaults to `'error'`).
  The footer paints info notices green and error notices red. New
  column actions emit info notices on success; column-edit refusals
  emit error notices.

### Changed
- **Msg signatures.** `pool_show({column: 'left'|'right'})` →
  `pool_show({columnIndex: int})`. Drag target shape `{kind, column,
  index, …}` → `{kind, columnIndex, index, …}`.
  `free_config_move_col({col: 'left'|'right'})` →
  `free_config_move_col({dir: -1|+1})`. New Msgs:
  `pool_show_new_column({id, position})`,
  `add_column({position})`, `remove_column({columnIndex})`.

- **`pane.column: 'left'|'right'` → `pane.columnIndex: int`.** Every
  pane carries its column index as an integer. The legacy string
  form is gone.

- **Hit-test edge naming.** `'resizing-left-boundary'` and
  `'resizing-right-boundary'` fold into `'resizing-panel-boundary'`
  carrying `columnIndex` and (when on a column boundary)
  `boundaryIndex`. Corner-resize at the column separator now checks
  both flanking columns for a panel boundary at `my` instead of just
  the cursor's column.

### Migration

Hand-conversion per [`docs/v0.6.2-migrate.md`](docs/v0.6.2-migrate.md);
the parser's SchemaError points at the same file.

## [0.6.1] — 2026-06-02

### Changed (BREAKING)
- **YAML layout cell schema.** Layout cells are now bare pool-id
  strings (single-tab pane shorthand) or `{tabs: [pool-id, ...]}`
  mappings; the v0.6.0 inline `{type: ...}` form is rejected at parse
  time. Every pool entry must be declared under the top-level
  `panels:` block before a `layout:` cell can reference it. Hand-
  migrate per [`docs/v0.6.1-migrate.md`](docs/v0.6.1-migrate.md) — the
  parser's SchemaError points at the same file. No silent rewrite.

  ```yaml
  # v0.6.0 — no longer parses
  layout:
    right:
      panels:
        - type: detail
          title: Detail
          height: 60%

  # v0.6.1
  panels:
    detail: { type: detail, title: Detail }
  layout:
    right:
      panels:
        - { tabs: [detail], height: 60% }
  ```

### Added
- **Panes as containers, tabs as content.** Every cell in the grid is
  a **pane** (placement slot) holding 1+ **tabs** (panel-kind
  instances). The singleton-detail assumption that threaded through
  v0.5/v0.6 retires: every pane can host any tab kind, the slice
  store keys by tab id (instance) instead of by Component name, and
  `getFocus()` returns a tab id rather than a panel-type string.
  Detail is just another tab kind — same pool/cell mechanics, same
  drag/hide/show verbs.

  Configs that look exactly like v0.6.0 (one tab per pane, detail in
  the right column's last pane) migrate to v0.6.1 in two mechanical
  steps: split each inline cell into a pool entry + a bare-string
  cell reference; lift `height: N%` onto the cell as
  `{ tabs: [detail], height: N% }`. See the migration guide.

- **Instance-keyed slice registry.** A new `route._instances` map
  keys panel state by tab id (`getInstanceSlice(tabId)`); the prior
  Component-name-keyed shim retired in Phase 8. Producer-side viewer
  writes route through a single `resolveTarget('viewer')` chokepoint
  (`leaves/route.js`) — focused viewer-kind → `lastViewerTab` →
  first viewer-kind in `rightPanels` → any viewer-kind → null. v0.7
  workflow features extend this seam; no role / channel metadata
  shipped in v0.6.1.

- **Multi-tab panes via YAML.** A `{tabs: [docker, logs]}` cell mounts
  two tabs in one pane; `activeTab` picks the boot-active tab (defaults
  to `tabs[0]`). Switch the active tab at runtime via the new
  `:switch-tab <pool-id>` cmdline verb (autocomplete restricts to the
  focused pane's other tabs). Keyboard / mouse UX deferred to v0.7 (see
  `docs/v0.6.1-panes-tabs.md` §Decisions #4). Layout cells reject
  duplicate kinds inside a pane.

- **`:switch-tab <pool-id>` cmdline verb.** Direct active-tab flip for
  the focused pane. No-op on single-tab panes.

### Changed
- **Serializer always writes both blocks.** `:save-layout` always
  emits the `panels:` pool block and the `layout:` block in v0.6.1
  shape — the v0.6.0 "keep the legacy inline form when nothing
  requires the pool block" gate is gone. Idempotent: parse → save →
  parse → save produces identical bytes.

- **`setDetail` retires in favor of `setViewerContent(tabId, text)`.**
  Producer-side writers (action runner, commands, history, config-
  status, help-text, file-loader) call `state.setViewerContent(null, text)`
  to write to whatever viewer `resolveTarget` selects. The dead
  `'setDetail'` effect handler in `dispatch/effects.js` retires.

- **`getFocus()` returns a tab id, not a panel-type string.** For
  singleton-instance kinds (today's default configs) the tab id
  coincides with the Component name, so existing comparison sites
  like `getFocus() === 'detail'` keep working byte-for-byte. Kind-
  intent comparisons should go through `instanceKind(getFocus()) ===
  '<kind>'` (resilient to multi-instance, where tab id ≠ kind).
  External Components reading `slice.focus` directly should audit.

- **Navigator slice shape — `slice.nav` collapses to a single entry
  for single-panel navigators.** v0.6 had `slice.nav[panelType] =
  entry`; v0.6.1 single-panel Components (groups, docker, actions,
  config-status, history) store the entry directly at `slice.nav`.
  The files Component, which owns multiple panel types, keeps the
  `slice.nav[panelType]` shape. Shape is detected by `'cursor' in
  slice.nav`. External plugins reading nav state need a one-line
  branch.

- **Pane shape on arrange entries.** `arrange.leftPanels[i]` and
  `arrange.rightPanels[i]` now carry `paneId` (slot identity),
  `tabs: [{id, poolId}]`, and `activeTabId` alongside the legacy
  `id/type/title/config` fields. Anyone scripting against
  `:save-layout` output sees these additional keys. Legacy fields
  mirror the active tab's pool entry and stay populated through
  v0.6.1 for compat; Phase 10+ retire them.

### Migrated
- **Live demos and test fixtures.** `test/test.yml`,
  `demo/postgres/tui.yml`, and `demo/cloudberrydb/tui.yml` ship in
  v0.6.1 form. The PGDATA `files` panel in postgres keeps id `files`
  with title `PGDATA` — id is the round-trip key, title is the UI
  label.

## [0.6.0] — 2026-06-01

### Added
- **Free-config mode + panel pool.** The v0.5 design mode evolves
  into "free-config mode" — a layout editor with a configurable
  trigger and an explicit save command. The new top-level `panels:`
  block declares a POOL of panel definitions; the `layout:` block
  picks a subset of those by id. Pool entries that aren't placed in
  the grid are *hidden* — still configured, surfaced in the panel-
  list overlay so users can summon them back. More panels available
  under the hood than the grid shows at once.

  ```yaml
  panels:                 # the pool
    docker: { type: docker }
    logs:   { type: tail, file: /var/log/syslog }
    notes:  { type: viewer, title: Notes }   # hidden by default
    actions: { type: actions }
    detail:  { type: detail }

  layout:                 # the grid (id-refs into the pool)
    left:  { panels: [docker, logs] }
    right:
      panels:
        - actions
        - { id: detail, height: 60% }
  ```

  Legacy configs with inline `{ type: ... }` cells continue to parse
  and round-trip unchanged — the pool synthesizes implicitly at load
  time, and `:save-layout` only writes the new `panels:` block when
  the legacy inline form can't express the state (hidden entries OR
  a user-declared pool).

- **Panel-list overlay.** A modal popup inside free-config (open by
  pressing `w`, or automatically when the pool has hidden entries on
  mode entry). Shows every pool entry with its status — placed /
  essential (detail) / hidden — and lets the user toggle membership
  in the grid:

  - **Keyboard**: arrow keys nav, `Enter` to context-pick (placed →
    hide; hidden → show + place; detail no-op).
  - **Mouse**: drag a list item onto the grid. Drop on a cell →
    REPLACE (occupant returns to the pool). Drop in a column area
    (between or below cells) → APPEND to that column. Drop outside
    the layout → cancel.

- **`:hide <id>` / `:show <id>` cmdline verbs.** Direct pool↔grid
  mutation from the command line; same Msgs the overlay drives.
  Detail refuses to hide (the layout invariant requires exactly one);
  pool_show refuses to place a second detail / actions panel or
  exceed column caps. Autocomplete restricts to valid ids.

- **`:free-config` cmdline verb.** Opens the layout editor. `:design`
  remains as a v0.5 alias for muscle memory. The boot-time `--design`
  CLI flag now auto-enters free-config after the first paint instead
  of gating cmdline visibility — the mode is always available.

### Changed
- **Mode flag renamed.** `model.modes.designMode` → `freeConfigMode`
  throughout (26 references across 13 files). Mechanical rename;
  behavior under the old flag preserved. External plugins reading
  the flag name need a one-line update.

- **Freeze gate during free-config mode.** While the mode is active,
  the dispatch layer drops broadcast Msgs (refresh / hub / action)
  and wrapped Msgs targeting non-`layout` components. Components
  render their last snapshot until the user exits, so the canvas
  stays stable under drag / resize / pool mutations — matches the
  tmux prefix-mode mental model. Mode entry/exit ride the root
  reducer, not the gated dispatch path, so the mode itself always
  transitions cleanly.

- **`:save-layout` writes the `panels:` block when needed.** Legacy
  configs (every entry synthesized AND placed) continue to write the
  v0.5 inline form, byte-for-byte where possible. Configs with
  hidden entries or a user-declared pool write both blocks; layout
  cells become id-refs. Round-trip is idempotent — parse → save →
  parse → save produces the same bytes.

- **Chrome glyphs on every panel.** Top-border row now hosts up to four
  small interactive icons, theme-coloured (Mac traffic-light convention):

  - `[X]` red — quick-hide. Free-config only. Click → `pool_hide` for
    that panel (occupant goes to the pool; layout stays open).
  - `[_]` yellow — collapse. Always visible. Click → `panel_collapse_toggle`.
  - `[+]` green — expand a collapsed panel back to full height. Same
    click semantics as `[_]`, just the glyph differs by state.
  - `[≡]` theme accent — tab-list trigger, painted at detail's top-left
    only. Click → opens the centered tab switcher (see below).

  Glyphs are baked into the panel's top-border markup so they ride into
  the same `paintColumns` write as the row's content — no second
  cursor-move-and-overpaint pass. Pre-fix the glyphs visibly flickered
  as `─` on every detail-scroll frame (paint-on-top happened after
  paintColumns wrote the row). Glyphs are suppressed during any drag
  (the drag affordance owns the screen) and during overlay-owning
  modes (cmdline, menu, confirm, prompt, register popup, etc.).

- **Tab-list overlay.** The `[≡]` glyph at detail's top-left opens a
  centered popup listing every tab in the detail panel — Info,
  action tabs, terminal tabs, content tabs. Cursor navigates,
  `Enter` switches to the selected tab, `Esc` / click-outside / re-click
  the trigger close. Working state lives on `slice.tabList`
  (`{open, cursor, scroll}`); the trigger renders open-state via
  `[reverse]` when `tabListMode` is on. Available in every view
  mode (normal, half, full).

- **`(o)[≡]` layout on detail.** The trigger glyph sits adjacent to the
  hotkey — `╭─(o)[≡]─Detail─…─╮` — preserving both the keyboard
  reference and the mouse affordance. Earlier in v0.6 the trigger
  replaced `(o)`; now both are visible side-by-side. The trigger paints
  in normal, half, and full view (was normal-only).

- **Tab reorder via mouse drag.** Inside free-config, drag a content
  tab in detail's tab bar to a new slot. Live reorder — the tab bar
  re-renders in the new order as the cursor crosses each slot
  boundary, no commit-on-release single jump. Pure leaf at
  `leaves/tab-drag.js`; the Msg `viewer_reorder_content_tab` is the
  one allowed non-`layout`-wrapped dispatch through the free-config
  freeze gate.

- **Click-to-close `[x]` on content tabs.** Each content tab in detail's
  tab bar carries a tiny `[x]` close hint. Click it to drop the tab
  (independent of free-config). Tab-bar hit-test machinery lives on
  `panelBounds.detail.tabs` (view-output cache).

- **`:open <path>` cmdline verb.** Open any file as a content tab in
  detail. TAB-completion via a pluggable scheme registry
  (`feature/open-target.js`):

  - **Host paths** — relative or absolute. Catch-all scheme; matches
    anything without a `<word>://` prefix.
  - **`docker://<container>/<path>`** — read a file out of a running
    container via `docker exec`. Container-name completion (sync
    probe on first use, throttled async refresh after) plus
    path-in-container completion (cached per directory).

  Future schemes (ssh, s3) plug in via the same `match` / `complete` /
  `open` contract.

- **Cmdline live preview.** Cmdline entries can opt into a live preview
  via `preview: () => teardownFn`. The framework calls `preview()` on
  every selection change (typing-narrowed matches or arrow-nav),
  stashes the teardown, and runs it on the next selection change OR on
  cancel. `:theme <name>` uses this — themes switch as the user
  navigates matches; Esc reverts; Enter commits.

- **Collapse-toggle widget on every non-detail panel.** Click `[_]` /
  `[+]` to collapse / expand any non-detail panel, available in both
  normal and free-config modes. The `collapsed` flag round-trips
  through `:save-layout` (real layout state, not session-only).

- **Live drag preview.** During pool drag or in-grid drag with a
  valid target, `slice.arrange` is swapped to the would-be-after-
  release arrangement for the duration of the paint pass and
  restored before the next mouse event. The user SEES the post-
  release layout while dragging — replaces the old seam-bar / cell-
  frame hints, which were one-line indicators of "where the panel
  would land." Restore window also includes
  `renderTerminalOverlay` so the xterm session in detail paints at
  preview-shifted coordinates while a free-config drag is in flight.

- **3-zone hit-test per cell.** Both pool drag and in-grid drag use a
  unified cell layout:

  - **Top third** → insert before this cell.
  - **Middle third** → for pool drag: REPLACE the occupant (occupant
    returns to pool). For in-grid drag: SWAP the dragged panel with
    the occupant (cross-column swap supported; same-column swap
    preserved). Self-swap (source == occupant) is a valid no-op
    surfaced in the footer as `(no-op — release to cancel)`.
  - **Bottom third** → insert after this cell.

  Replaces the v0.5 / early-v0.6 pool-drag scheme (`replace on cell
  hit + APPEND in a 2-row strip at column tail`), which left no way
  to insert between cells. Detail-at-end clamp annotated in the
  footer (`→ insert at right:N (clamped — detail stays at end)`)
  when the user drops in a position that would land past detail in
  the right column. Detail and `actions` can't live in the left
  column from either gesture (was an asymmetry: in-grid drag
  blocked it, pool drag let it through).

- **View-mode × free-config guards.** Free-config can only be entered
  from normal view; the view-mode keys (`[`, `]`) and any cmdline
  verb that would change view-mode are blocked while free-config is
  active. Refusals surface a footer notice (`free-config requires
  normal view ([ to return)` / `exit free-config (q) to change view
  mode`) that auto-clears on the next unrelated user intent. Drag
  motion Msgs preserve the notice (single drag intent in flight).

- **Half-view non-detail focus tracking.** In half view, when focus
  moves to detail (e.g., clicking a tab in detail's bar), the LEFT
  side now keeps showing the most recently focused non-detail panel
  instead of duplicating detail. Tracked in `slice.halfLeftPanel`,
  updated in `focus_set` (non-detail target) and committed on
  `design_exit` (catches free-config nav, which bypasses
  `focus_set`).

- **Theme-driven chrome palette.** New theme slots: `chrome_close`,
  `chrome_collapse`, `chrome_expand`, `chrome_trigger`. Default
  mappings follow the Mac traffic-light convention; themes can
  override per slot. Glyphs dim with the panel when the panel isn't
  focused (composes `[dim]` with the color, not the terminal default
  fg).

### Changed
- **Mode flag renamed.** `model.modes.designMode` → `freeConfigMode`
  throughout (26 references across 13 files). Mechanical rename;
  behavior under the old flag preserved. External plugins reading
  the flag name need a one-line update.

- **Freeze gate during free-config mode.** While the mode is active,
  the dispatch layer drops broadcast Msgs (refresh / hub / action)
  and wrapped Msgs targeting non-`layout` components. Components
  render their last snapshot until the user exits, so the canvas
  stays stable under drag / resize / pool mutations — matches the
  tmux prefix-mode mental model. Mode entry/exit ride the root
  reducer, not the gated dispatch path, so the mode itself always
  transitions cleanly. Narrow exception: the tab-reorder gesture's
  `viewer_reorder_content_tab` Msg passes through (live reorder
  within detail's tab bar, same justification as `pool_hide`/`show`).

- **`:save-layout` writes the `panels:` block when needed.** Legacy
  configs (every entry synthesized AND placed) continue to write the
  v0.5 inline form, byte-for-byte where possible. Configs with
  hidden entries or a user-declared pool write both blocks; layout
  cells become id-refs. Round-trip is idempotent — parse → save →
  parse → save produces the same bytes.

- **Pool drag UX.** Replaces the v0.6 Phase 5 scheme (replace on cell
  + append in a 2-row strip at column tail) with the unified 3-zone
  per-cell hit-test described above. Every visible cell now offers
  insert / replace / insert at thirds; the user can drop between any
  pair of adjacent panels without hunting for a tiny append strip.
  Same UX works in normal, half, and full views.

- **Cmdline matcher uses full buffer text.** Multi-word entry names
  (`theme dracula`, `focus FilePanel`) score against the entire
  buffer rather than just the first whitespace-delimited token, so
  the user can refine through the registered display string. Single-
  word entries still match `query`-only, so trailing positional args
  don't disturb their fuzzy scores.

- **Page-up / page-down** (`,` / `.`) move a full page. Earlier moved
  half a page.

- **Chrome paint method.** `[_]`/`[X]`/`[≡]` glyphs are baked into the
  panel's top-border row markup, written atomically by `paintColumns`.
  Pre-fix the glyphs were painted in a separate cursor-move pass after
  paintColumns, which let the row's `─` fill briefly show through on
  every detail-scroll frame — visible as flickering glyphs in the
  lower-left panels.

- **`free-config` footer label.** Reads "Free Config" (was "Design
  Mode" through the rename).

### Fixed
- **Pool drag/show refuses `detail` / `actions` into the left column.**
  In-grid drag already blocked this gesture; pool drag and the
  `pool_show` reducer didn't, letting users land an `actions` panel in
  the left column with a positional hotkey instead of the conventional
  `0`. Now both gestures refuse with the same reason text the in-grid
  drag uses.

- **Half-view dup-detail bug.** Clicking a tab in detail's tab bar or
  clicking detail's content area dispatched `focus_set` to detail;
  `renderHalf` paints `focusedPanel` on the left + `detail` on the
  right, so detail showed up on BOTH sides. Now the left side falls
  back to the most recently focused non-detail panel
  (`slice.halfLeftPanel`).

- **Same-column right-column drag past detail.** The detail-at-end
  clamp in `validateTarget` pre-decremented for same-column source
  AND `applyInsert` re-decremented for the splice-shift — net
  double-counting left the source pinned at its own slot for any
  drag past detail. Now uses pre-removal `detailIdx` only; the
  insert's existing decrement handles the shift correctly.

- **Self-swap with detail flagged as invalid.** The "detail must stay
  at end" rule applied unconditionally to swap targets involving
  detail; releasing a drag onto detail's own middle-third showed a
  red ✗ in the footer for what's semantically a no-op. Now self-swap
  (source == occupant) is always `valid:true`; the subsequent
  detail-at-end rule only applies to cross-panel swaps.

- **Terminal overlay during drag.** `renderTerminalOverlay` reads
  `panelBounds.detail` to position the xterm session. The drag-
  preview swap-window used to end before the terminal overlay's
  paint, so the overlay drew at original (pre-shuffle) coordinates
  while the surrounding layout showed preview-shifted detail. Now
  the swap covers the terminal overlay too; restore happens before
  the viewport-cache dispatch.

- **Detail-at-end clamp visible in the footer.** Dropping in the
  bottom third of detail clamps the insert index back to detail's
  slot (panel ends up just before detail). Pre-fix this happened
  silently — the user saw their preview paint above detail with no
  signal that the target was rewritten. Now the footer reads
  `→ insert at right:N (clamped — detail stays at end)`.

- **Self-swap reads as `(no-op)` in the footer.** After the self-swap
  validity fix, the footer would have shown `dragging X → swap X
  (col)` in bold yellow — looks like a real action. Now reads
  `(no-op — release to cancel)` in dim.

- **Footer truncation under overflow.** Pre-fix a long footer wrapped
  to a second row, scrolling the screen up and looking like the
  frame was shrinking each render. Now markup-aware-truncated to
  fit the terminal width.

- **`bold red` / `bold green` / other bold-color combos** map through
  richToAnsi correctly. Pre-fix only the bold was emitted, dropping
  the color half.

- **Cmdline dropdown scroll** advances with the selection so the
  highlighted entry stays in view even when the match set is larger
  than the dropdown viewport.

- **Cmdline Tab accepts the SELECTED match,** not always
  `matches[0]`. Pre-fix arrow-down then Tab completed the first
  match rather than the highlighted one.

- **Cmdline Enter on a refinable entry behaves like Tab** —
  directories and container names rewrite the buffer instead of
  firing `run()`, keeping the user in cmdline so they can continue
  refining.

- **Cmdline hint shows on partial prefix** (`:open dock` now shows
  the `docker://` hint). Pre-fix the hint only showed on empty
  input.

- **Cmdline residue persists when `:free-config` triggers from cmdline
  mode.** Modal transitions A→B drop A's pixels before B paints; the
  force-full-repaint fingerprint computes over the active overlay
  SET, not a single bool, catching every overlay drop.

- **Pool-drag motion only repaints on TARGET change,** not every
  pixel. Rapid drag no longer makes the affordance blink.

- **Free-config focus preserves on entry.** Entering free-config used
  to reset focus to the first placed panel; now keeps the user's
  current focus when it points at a placed panel.

- **Panel title markup-aware truncation.** Titles carrying markup
  (`[docker:pg]`, `[dim]`, `\[…\]`) used to be length-sliced
  ignoring visible-width math, sometimes cutting mid-tag and
  swallowing the right border `╮`. Now truncate() is markup-aware
  and short-circuits when the title already fits.

- **Pool-drag invalid-append surfaces a reason.** Trying to drop into
  a column at cap now paints the bar in red AND surfaces the reason
  in the footer; pre-fix the bar still painted green and release
  silently cancelled.

- **Force-repaint on overlay drop AND transition,** not just
  overlay-close. Pre-fix a same-cycle A→B overlay swap left A's
  pixels under B.

- **Pool_show right-column inserts BEFORE detail,** not at the very
  end. Detail-at-end invariant enforced consistently across all
  panel-arrangement gestures (in-grid reorder, pool show via
  cmdline, pool drag, drop-on-empty-column).

- **Drag motion equality** compares every preview-affecting field
  (kind, column, index, occupantId, occupantType, valid). Pre-fix
  the helpers only checked a subset, so insert@0 → insert@1 (same
  column, both undefined occupantId) reported "equal" and skipped
  the repaint, leaving a stale preview at the old index.

### Internal
- **`js/leaves/pool.js`** — pure derivations over `arrange.pool` /
  `leftPanels` / `rightPanels`: `placedIds`, `hiddenIds`, `isPlaced`,
  `isHidden`, `getPoolEntry`, `orphanPlacements`, `panelListItems`,
  `placementFromPoolEntry`. Tested directly; no model access.

- **New leaves**:
  - `js/leaves/design-pool-drag.js` — pool-drag gesture state machine
    (`poolDragStart`/`Motion`/`Release`, `pointToPoolDropTarget`,
    `computePoolDragPreviewArrange`). Depends on `leaves/design` for
    the shared 3-zone hit-test and `leaves/pool` for
    `placementFromPoolEntry`. Pure transform.
  - `js/leaves/tab-drag.js` — content-tab reorder gesture for the
    detail tab bar.
  - `js/leaves/cmdline-split.js`, `js/leaves/sh-escape.js`,
    `js/leaves/hotkeys.js` — small shared helpers.

- **New overlays**:
  - `js/overlay/tab-list.js` — tab-list overlay + the `injectTabTrigger`
    helper that bakes `[≡]` into detail's top-row markup.
  - `js/overlay/panel-list.js` — modal panel-list inside free-config,
    with optional side-by-side preview pane (terminals ≥ 75 cols).
  - `js/overlay/cmdline.js` — cmdline render carve-out from
    `dispatch/cmdline.js`. Resolves a layering inversion where
    `render/layout.js` required `dispatch/`.

- **New features**:
  - `js/feature/open-target.js` — pluggable scheme registry for
    `:open` (`match` / `complete` / `open` hooks).
  - `js/feature/open-docker.js`, `js/feature/open-file.js` — docker
    and host schemes plugging into the registry.
  - `js/render/panel-widgets.js` — `injectTopRowChrome` for
    `[X]`/`[_]`/`[+]` and the hit-tests that read `panelBounds`.

- **Carve-outs reducing the largest files**:
  - `js/panel/commands.js` — `:` cmdline command registry, peeled
    out of `panel/api.js`.
  - `js/dispatch/actions.js` — `handleAction` switch, peeled out of
    `dispatch/dispatch.js`.

- **New Msgs on the layout slice:** `pool_hide`, `pool_show` (with
  optional `index` field for drag drops), `panel_list_{open, close,
  nav, pick}`, `pool_drag_{start, motion, release}`,
  `tab_drag_{start, motion, release}`, `panel_collapse_toggle`,
  `set_arrange`. Plus the existing `design_*` family. Single-writer-
  per-slice preserved; release Msgs return `dispatch_msg` Cmds that
  re-emit `pool_hide` / `pool_show` so the Phase 2 handlers do the
  mutation. **Target shape**: pool-drag targets are tagged
  `{kind:'insert'|'replace', column, index|occupantId, valid,
  reason?, clamp?}`; in-grid drag targets are `{kind:'insert'|'swap',
  column, index, occupantType?, valid, reason?, clamp?}`.

- **New Msgs on detail (viewer):** `tab_list_{open, close, nav, page,
  pick}`, `tab_list_close_selected`, `viewer_reorder_content_tab`,
  `viewer_remove_content_tab`, `viewer_set_viewport`.

- **New cmdline-buffer arms in the root reducer:** `cmdline_set_text`,
  `cmdline_set_matches`, `cmdline_nav`, `cmdline_submit`,
  `cmdline_cancel`, `cmdline_revert_preview`. The live-preview teardown
  ride a `cmdline_preview` Cmd through `dispatch/effects.js`.

- **New slice fields** on the layout slice: `arrange.pool` (id → entry),
  `design.drag.previewArrange` (computed on target change), `design.notice`
  (transient hint surfaced in the footer), `halfLeftPanel` (last
  non-detail focus, half-view's left-side panel),
  `panelList.{open, cursor}`, `tabList.{open, cursor, scroll}` (on
  detail's slice).

- **Test coverage**: twelve new test files pinning the v0.6 surface —
  `test-pool-schema.js`, `test-pool-derivation.js`,
  `test-pool-cmdline.js`, `test-free-config-freeze.js`,
  `test-panel-list-overlay.js`, `test-pool-drag.js`,
  `test-pool-save.js`, `test-collapse.js`, `test-tab-list.js`,
  `test-view-mode-guards.js`, `test-half-view-focus.js`. Plus
  expanded coverage in `test-design-drag.js` (3-zone hit-test, swap,
  preview snapshots, repaint emission across zone changes). Suite
  green across 60+ files.

## [0.5.0] — 2026-05-30

A refactor release. No new end-user features; the panel grid, key
bindings, and YAML config surface all look the same. What changed is
the internal architecture — and one externally visible API surface
that breaks for anyone using `dispatch.applyMsg` directly.

### Changed
- **Plugin API retired; Component API is the only extension shape.**
  External authors register a Component the same way the built-ins do
  (`require('../panel/api').registerComponent(spec)`). A Component
  owns a slice (`init()` returns the initial slice; `update(msg, slice)`
  is the single writer; `panelTypes` declares the render contract).
  The legacy Plugin API + the YAML `plugins:` loader are gone; a
  non-empty `plugins:` block in a config logs a one-line warning and
  is otherwise ignored. The migration shape is documented in
  `docs/v0.5-layering.md` and `docs/PLUGINS.md`.
- **`dispatch.applyMsg` signature changed: `applyMsg(msg)`.** The
  previous `applyMsg(model, msg)` shape carried a model argument that
  became unsafe across cascades once the reducer turned pure (a
  captured ref would lose intermediate writes if a Cmd re-entered the
  dispatch graph). The function now reads `getModel()` internally;
  callers drop the leading arg. Affects anyone using `applyMsg`
  outside this codebase — typically only test code in plugin trees.
- **Single-writer per slice.** Every Component is the sole writer of
  its own slice; the root reducer (`runtime.update`) is the sole writer
  of root-model fields. Cross-layer writes ride out as `apply_msg` /
  `dispatch_msg` Cmds. The invariants are documented in
  `docs/v0.5-layering.md §5`.
- **Pure-TEA reducer + Components.** The reducer and every Component's
  `update` now return new state objects (`{ ...slice, field: next }`)
  rather than mutating their arg. Hot-path append (streamed action
  output) spreads `[...lines, line]` per the no-in-place-exceptions
  rule. Freeze-test coverage in `js/test/test-immutable-*.js`.
- **Per-panel chrome lives on each Navigator's slice.** Cursor,
  scroll, multi-select, and committed filter text used to live at
  `model.ui.{sel,scroll,multiSel,filters}`. They now live on each
  Component's `slice.nav[panelType]`. The `model.ui` field retired.
- **Layout state lives on a layout Component slice.** The
  arrange struct (column widths + panel order), focus, view mode,
  panel bounds, design-mode working state, and the layout-dirty
  flag all live on `slice.panels.layout` now, not on the root model.
  The layout Component is registered before any other and nests
  every other Component's slice under `layout.panels[name]`.
- **viewer (detail) + groups are Components.** The final two
  bespoke panels migrated to the Component API. Their reducers,
  cascade logic (group switch → viewer reset, etc.), and slice
  state all live in `panel/viewer/viewer.js` and
  `panel/navigator/groups.js`.

### Removed
- **`type: file-manager` panel alias.** The v0.3.0 declared-registry
  panel was a subset of v0.5's unified browser. Migrate to
  `type: files, source: declared` for identical behavior. The
  auto-generated default left panel (when a project declares a
  top-level `files:` block but no explicit layout) now uses the new
  shape automatically.
- **Decorators framework.** The `decorate('panel:slot')` /
  `decorate('row:left:panelType')` extension surface was retired —
  nothing in-tree contributed, and the seam wasn't reachable from
  the new Component-shape panels. Panels compose their own row /
  badge logic inline now (e.g. groups' `running/total ●` badge).
  `viewContributions` (footer / overlay strips) remains.
- **The `S` shim.** The pre-v0.5 façade over the root model + slices
  was removed in chunks A–E during the migration. Production reads
  `getModel()` / `getComponentSlice()` directly.

### Internal
- **Source tree reorganized.** The flat `js/` directory split by
  kind: `app/` (runtime, state, tui boot), `io/` (terminal, ansi,
  streams), `render/`, `dispatch/`, `overlay/` (modal/popup
  overlays), `panel/` with sub-trees `navigator/` (list-style
  panels), `viewer/`, `monitor/`, plus `leaves/` (pure transforms)
  and `feature/` (history, register).
- **Wrapped Msg dispatch.** Component-targeted Msgs now travel as
  `{ kind: 'componentName', msg }` wrappers via `dispatchMsg`. The
  framework rejects flat Component-specific Msgs with an error log
  to catch missed wrap sites.
- **Centralized claim signaling.** Panels that claim a keystroke
  return a `_claimed` sentinel effect from their `update`; the
  framework consumes it in `dispatchKeyToFocused`. The previous
  `claimsKeys:` declaration retired.
- **Pre-release reviews.** A 4-track audit (arch / file layout /
  code / doc parity) ran before tagging. Code track: five rounds
  surfaced ~30 BUGs + 26 RISKs (3 verified by repro:
  regex DoS, ANSI breakout in panel titles, UTF-8 chunk-boundary
  corruption in streamed output). Arch track caught two dead Msg
  routes (`toggle_group` on Enter-on-branch, `toggle_groups_tab` on
  `[`/`]`) — Msgs that moved to a Component but kept being routed
  through the root reducer's no-op default; added
  `js/test/test-msg-routing.js` as a static check that every
  `applyMsg` literal in the dispatch spine has a matching reducer
  case. File-layout track moved two CLI-mode groupAction
  contributors (`archive`, `image-backup`) out of `panel/` into
  `feature/` — they were never Components, never registered.
  Doc-parity track refreshed PLUGINS.md's stale `claimsKeys`
  guidance to the post-Phase-6 `_claimed` sentinel and added a
  retired-`S`-shim substitution table to TERMINAL.md.
- **Hot-path perf measured.** `viewer_append` and `select_extend` —
  the two paths flagged for measurement when the arc rule of "no
  in-place exceptions" was adopted — measured well within budget
  at realistic loads (21k ops/sec at 10k-line buffer; 3.2M ops/sec
  for `select_extend`). Numbers, conditions, and mitigation options
  if usage shifts: `docs/v0.5-perf.md`; benchmark script
  `js/test/bench-hotpaths.js`.

### Fixed
- **`--spec` doc-bundle path.** `tui.js --spec` aborted with
  `missing doc js/docs/SPEC.md`. The v0.5 reorg moved `tui.js` from
  `js/` to `js/app/` but `printSpec()` still resolved `..` once from
  `__dirname`, landing in `js/docs/` instead of `<repo>/docs/`. Now
  walks up two levels to the repo root. Pinned by a new spawn-based
  test block in `js/test/test-cli.js` so a future relocation can't
  silently break the bundle again.
- **`plugins:` warning scope.** The boot-time deprecation warning
  fired on every non-empty `plugins:` block, including YAML config
  splits — the parser-level merge feature that's still supported and
  documented as unrelated to the retired runtime Plugin API. The
  warning now fires only on non-split entries (paths that don't end
  in `.yml`/`.yaml`, plus malformed entries that would silently
  no-op) and names them in the message, so config-split users boot
  quietly. Predicate exported from `js/parser/index.js` so the parser's
  own split-detection and the boot warning share one rule; pinned by
  `js/test/test-retired-plugin-entries.js`. PLUGINS.md updated to
  match the corrected behavior.

## [0.4.0] — 2026-05-27

### Added
- **Prefix (leader) key — a fresh `<space><key>` namespace.** Pressing
  the leader (default
  `<space>`) opens a binding namespace resolved as a TREE, so chords
  nest: `<space>g g` → top, `<space>g e` → bottom, `<space>r` →
  refresh, `<space>?` → help. Esc (or a second leader press) cancels a
  pending sequence. Bindings live in a registry (`js/keybindings.js`).
  After the leader (and at each nested level) a **which-key popup**
  lists the available continuations — `key → label`, sorted, with
  `+name …` for subtrees — so chords are discoverable, not memorized.

  Bind your own chords in a top-level **`keys:`** block. Each entry
  targets exactly one of `action:` (run a declared action by its
  `actions:` key — honors the action's `args:` prompt and `confirm:`),
  `command:` (run a `:` cmdline command, resolved by exact name), or
  `builtin:` (a framework action like `refresh` / `goto_top`); an
  optional `label:` sets the popup text. Sequences nest naturally
  (`<leader>gg`). User bindings **override** the built-in chords, so
  you can reclaim `g` / `r` / `?` for your own actions:
  ```yaml
  keys:
    "<leader>b":  { action: build }
    "<leader>L":  { command: "logs" }
    "<leader>gg": { builtin: goto_top, label: top }
  ```

  Because `<space>` previously toggled list multi-select, selection now
  lives behind a **v-mode** mirroring the detail panel's visual mode:
  `v` enters list-select mode (footer shows `[select]`), `space` toggles
  the focused row *inside* that mode, `*` selects all (and enters the
  mode), `v`/`Esc` exit. Outside v-mode `space` is always the leader —
  the rule is uniform because the mode chain already suppresses the
  leader inside detail-visual / terminal / text-input modes.
- **Unified `files` core panel — declared registry + filesystem browser
  in one panel type.** Replaces the v0.3 `file-manager` (declared-only)
  with a `source:` config that picks the behavior:
  - `source: declared`   — read `S.config.files` (the YAML `files:` block).
                           Same content as the v0.3 file-manager panel.
  - `source: filesystem` — real directory browser. Enter drills into
                           dirs, files open as content tabs in detail.
                           Hidden dotfiles excluded; `:show-hidden
                           on|off|toggle` flips visibility at runtime.
                           Regex filter via `/` (case-insensitive,
                           invalid pattern shows everything).
  - `source: both`       — declared rows first (marked ★), then the
                           filesystem listing. For projects that want
                           both their curated set and ad-hoc browsing.

  File loads are async with configurable caps (`max_bytes`, default 1MB
  text; `hex_after`, default 256KB hex). Binary files detected via
  null-byte scan in the first 8KB → canonical hexdump format.

  Backwards-compat aliases (no YAML changes required):
  - `type: file-manager` keeps the **verbatim v0.3 behavior** — substring
    (not regex) filter, no Enter-opens-file, `decorate('row:left:file-manager')`
    /`row:right:file-manager` extension hooks preserved. Users opting
    into the new declared-list rendering migrate to `type: files,
    source: declared`.
  - `type: file-browser` → `type: files, source: filesystem` alias.

  Example:
  ```yaml
  - type: files
    source: both
    root: ./src          # initial cwd for filesystem mode
    max_bytes: 2MB       # text-read cap
    hex_after: 512KB     # hex-render cap
  ```
- **`source: docker` — browse paths inside a running container.** A
  fourth source for the `files` panel that shells out to `docker exec
  <container> ls -lA --time-style=+%s` for listings and `head -c <cap>`
  for binary-safe capped reads. Same navigation, content tabs, hex
  view, and copy options as the local source; the panel just operates
  inside the named container instead of on the host. Async with a
  `Loading…` placeholder during the first fetch; cache busts on cwd
  change. Use when the data you care about lives in a named volume
  (e.g. postgres `PGDATA`) and a host-side bind mount isn't an option.

  Declared registry entries also accept a `container:` field so
  `source: declared` (and `both`) can mix host and container paths in
  one curated list.

  ```yaml
  - type: files
    source: docker
    container: pg
    root: /var/lib/postgresql/data
  ```
- **Content tabs** — new tab category in the detail panel for
  read-only text/hex surfaces. Sits alongside action tabs and terminal
  tabs (so `[`/`]` cycle through all of them). Created by plugins via
  `tabs.addContentTab(group, key, label, lines)`; reusing the same
  key updates the existing tab in place rather than duplicating. `x`
  on a focused content tab closes it.
- **`customFilter: true` plugin opt-in.** Lets a panel def take over
  filtering instead of the framework's substring matcher. Used by
  file-browser to wire regex filter via the same `/` flow; available
  to any future plugin that wants fuzzy / case-sensitive / structured
  filtering.

### Hardening
- **Panel-type registration is validated + collision-aware.** A single
  panel-def check at registration covers the whole contract
  (`render` required; `getItems`/`getInfo`/`onKey`/`copyOptions`/
  `filterText`/`idOf` must be functions; `customFilter` boolean;
  `mode`/`keyHints` strings) so a typo'd hook surfaces at load instead
  of as a silent no-op later. Panel-type **namespace collisions** now
  warn instead of silently last-wins shadowing: Plugin↔Plugin (the
  later registration shadows the earlier) and Plugin↔Component
  (split-brain — Component owns `render`, Plugin owns the other hooks),
  making real the collision warning PRINCIPLES §12 documented.
- **Extensible group schema** (PRINCIPLES §1/§5/§9). Group-level YAML
  keys are no longer rejected against a hardcoded whitelist baked into
  framework core — the framework validates the keys it owns
  (`label`/`actions`/`terminals`/`children`/`quick`) and the bundled
  plugins' shapes, but unknown keys pass through to the parsed group
  (mirroring how panel `extras` already pass through) so a plugin can
  introduce a group-level key without editing `parser/schema.js`.
- **config-status off the render path.** The panel used to spawn a git
  worktree synchronously on first render (blocking the paint + input,
  and making render impure per §11). The git computation now runs
  deferred off the render/keypress path; the first frame shows a
  `computing…` placeholder and repaints when the cache lands. `r`
  likewise defers instead of blocking the keystroke.
- **View-mode transitions force a full repaint.** `+`/`_` (normal↔
  half↔full) now invalidate the diff cache like the terminal-unzoom
  path already did, so shrinking no longer leaves stale wide-mode
  pixels.
- **Plugin / refresh-loop teardown.** Refresh loops are tracked and
  stopped on quit (and are idempotent on restart — no doubled chains);
  a new optional `plugin.cleanup()` hook fires from the framework's
  cleanup path, letting the docker plugin tear down its long-lived
  `docker events` child through the framework instead of relying solely
  on a `process.on('exit')` backstop.
- **Mode registry — single source of truth for modal states**
  (`js/modes.js`). The set of modes was previously duplicated across
  four hand-maintained lists (dispatch `modeChain`, layout
  `overlayActive`, layout `inModal`, `initState` reset) that drifted —
  a mode added to one but not the others left stale overlay pixels on
  close or leaked across re-init (the `initState` list was in fact
  missing `confirmMode`/`promptMode`/`designTitleEditMode`). All four
  now derive from one table; adding a mode is a one-line edit, and
  dispatch throws at load if a chain mode has no handler.
- **Mode-chain wedge guard.** A modal key handler that throws no longer
  traps the user in an unexitable mode — the dispatcher catches, logs,
  and force-clears the offending flag so the next key returns to normal
  dispatch.
- **Layout constraints enforced at parse time** (PRINCIPLES §10).
  `validateLayout` rejects configs with ≠1 `detail` panel, >1 `actions`
  panel, >6 left / >3 right panels, or a panel missing `type` — these
  previously passed `parse()` and crashed or silently misbehaved at
  render (two `detail` panels clobbered each other's bounds).
- **Detail-transient state no longer leaks across transitions.**
  `resetGroupContext` clears the visual selection + detail cursor on
  group switch; `setDetail` invalidates a committed `/`-search (whose
  match offsets pointed into the now-replaced content).
- **Leader-bound actions resolve plugin-synthesized actions.** A `keys:`
  `action:` binding now sees the same merged set as the actions panel
  (plugin `groupActions` + YAML `actions:`), routed through the shared
  args-prompt/confirm path — so binding e.g. a docker-contributed action
  works instead of silently doing nothing.
- **Per-panel-type files state** (`S.fileBrowsers[panelType]`) — the
  `files` and `file-browser` panel types now hold independent cwd /
  showHidden / lastError slots. Earlier global singleton meant a
  layout with both panel types collapsed to one cwd.
- **`_fsItems` mtime cache.** Directory listings memoize on cwd +
  cwd-mtime; unchanged dirs return cached items with zero syscalls.
  Refresh / cd / `:show-hidden` bust the cache. Earlier code did
  readdirSync + N statSyncs every render frame.
- **UTF-8 codepoint alignment + BOM detection** in file-loader. The
  text cap is rounded back to the last complete UTF-8 codepoint so
  trailing partial bytes don't render as U+FFFD. Files with a UTF-8
  BOM get it stripped silently; UTF-16-LE BOM routes through a
  utf16le-decoded text path; UTF-16-BE BOM is acknowledged and
  routed to hex view (no native Node decoder).
- **Declared dotfiles respect `:show-hidden`** in `source: both`
  mode. Previously the filter ran only over filesystem entries —
  YAML-declared `.env` etc. always rendered with the ★ marker.
- **Regex-DoS guard** (`js/regex-guard.js`). The `/`-filter (files
  panel) and `/`-search (detail panel) compile user-typed buffers
  into RegExps; without a guard, patterns like `(a+)+x` freeze the
  event loop indefinitely. The shared `safeRegex(pattern, flags)`
  caps pattern length at 200 chars and rejects the classic
  catastrophic-backtracking shapes (`(a+)+`, `(.*)+`, etc.) before
  ever compiling.
- **Rich-markup escaping** in file-loader's hex ASCII column and
  text-line output — file bytes containing `[` no longer get
  re-parsed as markup tags and corrupt downstream styling.
- **Async file-open race fixes** in `_openFileAsTab`:
  - Capture `S.currentGroup` at submit time so a mid-load group
    switch doesn't dump content into the wrong group.
  - Resolve `item.path` against `S.projectDir` before reading so
    declared relative paths land at the right file regardless of
    the process's launch directory.
  - Use new `tabs.updateContentTabLines(group, key, lines)` on
    completion so a slow load can't yank focus back to detail
    after the user navigated away.
- **`removeContentTab` refreshes the detail body** after rewinding
  `S.activeTab` — closing the active content tab now loads the
  sibling tab's lines (or re-emits Info via `showSelectedInfo`)
  instead of leaving the closed file's text painted on screen.

- **`LAZYTUI_PATH` version trampoline.** When set in the environment,
  every `bin/lazytui` re-exec's against the lazytui checkout at that
  path instead of the locally-installed one. Lets a consumer project
  (e.g. `~/exchange/pg-tui`) point at an in-development lazytui
  (`~/exchange/lazytui`) without npm install/publish churn, then
  `unset LAZYTUI_PATH` to fall back to whatever the consumer
  shipped with. Same-directory guard prevents infinite re-exec when
  the path resolves to the current install. Fails loud (exit 1, error
  on stderr) when set to a non-directory or a directory missing
  `js/tui.js`, so misconfiguration can't silently fall through to the
  wrong version.

## [0.3.0] — 2026-05-24

### Changed
- **`type: spawn` no longer depends on tmux for non-blocking
  execution.** Outside tmux, spawn now opens an ephemeral PTY tab
  in the detail panel (reusing the existing node-pty +
  @xterm/headless infrastructure that already backs `terminals:`
  blocks) and sets `S.viewMode = 'full'` so the child gets the
  whole terminal via the already-shipping full-screen view.
  Multiple concurrent spawns each get their own tab. The user can
  step back to the normal layout with `_` while the child keeps
  running; `+` re-zooms; clean exit auto-closes the tab and drops
  back to normal layout; non-zero exit keeps the tab so the error
  is readable but drops the zoom so the rest of the TUI is
  reachable. The tmux branch (`process.env.TMUX` set) is kept as
  an opt-in tier — a real OS-level new window is still preferred
  for long-lived interactive sessions, and existing users who
  already run lazytui under tmux see no change.
  - Replaces the prior `suspendTerminal` / `spawnSync(stdio:
    'inherit')` / `resumeTerminal` dance, which blocked Node's
    event loop for the child's entire lifetime — refresh ticks
    and hub publishers were frozen, and the user couldn't
    navigate to other panels until the spawned command exited.
  - `terminal.js#onExit` factored into a new exported
    `_onSessionExit(id, exitCode)` so the view-reset behavior is
    unit-testable without mocking node-pty. `tabs.handleSession
    CleanExit` is unchanged.
  - On session exit (clean, non-zero, or signal like SIGQUIT
    from Ctrl+\), `_onSessionExit` calls `forceFullRepaint()`
    when the exiting session was the user-visible one. Without
    it, the diff cache held the PTY-painted cells as "unchanged"
    and skipped them — chrome behind the dead PTY never redrew,
    leaving the last frame stuck on screen. Same diff-cache-
    reclaim pattern as the SIGCONT/suspend path.
  - **Ctrl+\ drops viewMode='full' along with terminal mode.**
    In `input.js`, Ctrl+\ is intercepted before reaching the
    PTY — it just toggles `S.terminalMode = false` so the user
    can navigate via lazytui keys while the child stays alive.
    Pre-v0.3.0, that was enough because PTY tabs lived in
    `viewMode='normal'`. With auto-zoom from `type: spawn`,
    keeping `viewMode='full'` after Ctrl+\ left the user in a
    chrome-less full-screen detail panel with no PTY input and
    no obvious way out. The handler now also drops the zoom and
    forces a repaint. Same fix applied to the sibling "session
    already dead" branch.
  - **Tab keys use a monotonic counter** —
    `spawn-<actionKey>-<ts>-<seq>` — so two spawns of the same
    action within a single millisecond produce distinct tabs.
    Without it, `addEphemeralTab` silently reused the existing
    tab and its dead PTY session.
  - **Child-lifecycle note (PTY-tab path only).** Because the
    embedded PTY session lives as a child of the lazytui Node
    process, the spawned child dies when lazytui quits — same
    contract as lazygit / lazydocker / k9s subprocesses. The
    tmux branch (`$TMUX` set) keeps its old detach-survival
    semantics: child runs in a sibling tmux window and outlives
    lazytui. If you need detach-survival without tmux, wrap the
    script in a session manager (`tmux new-session -d`,
    `dtach`, `abduco`). There's no in-process node-pty trick
    that gives both an embedded display and survive-quit —
    the PTY master fd in our process is the child's lifeline,
    so when it closes the slave gets SIGHUP.
  - Tests: replaces `test-spawn-bare.js` (which pinned the old
    blocking semantics) with `test-spawn-pty-tab.js` — 21
    assertions across 5 sections covering the new path, the
    tmux path still routing through `tmux new-window`, and the
    onExit view-reset for clean / non-zero / non-active-session
    cases.

- **Parser rewritten from Python to JS — lazytui is single-runtime now.**
  The Python parser (`parser/`, 1124 LOC) and its pytest suite (`tests/`,
  1101 LOC) are deleted. Replaced by an in-process JS parser at
  `js/parser/` (~700 LOC) backed by `js-yaml` for YAML loading; the
  ported test suite lives at `js/test/test-parser-*.js` (88 cases
  across 4 files). The runtime path swaps `python -m parser` for
  `require('./parser').parse()` — saves an out-of-process spawn on
  every TUI launch and removes the dual-runtime install story.
  - **`bin/lazytui`** drops the `.venv/bin` PATH shim — no Python
    needed at runtime.
  - **`package.json`** adds `js-yaml ^4.1.1` as a runtime dep
    (alongside `node-pty` and `@xterm/headless`), and flips
    `"private": true` → `false` now that the dual-runtime install
    story is gone. `npm publish` passes its CLI guard; the actual
    publish to npmjs.com is still a separate manual step (no
    `release.yml` automation yet — see RELEASING.md).
  - **CI** drops the "Set up Python / install pyyaml / run pytest"
    steps from both `.github/workflows/test.yml` and `release.yml`.
    `requirements.txt` and `pytest.ini` are removed.
  - **Output parity**: a differential harness (parse the same YAML
    through both parsers, deep-diff JSON output) ran on every
    fixture + both demos before deletion — 14/14 identical, including
    error-message strings for schema and resolution failures. State.js
    consumes the same JSON shape unchanged.
  - **Test fixtures** moved from `tests/fixtures/` to
    `js/test/fixtures/` so the JS suite owns them.
  - **Docs** updated: README, DEMO, CONTRIBUTING, RELEASING,
    docs/TESTING, docs/SPEC drop their Python-prereq references.
    History entries in CHANGELOG.md describing the prior dual-runtime
    state are left intact as a chronological record.

- **Design Mode v2 (Phase 3 follow-up): per-panel `heightPct` +
  corner drag + keyboard `[`/`]`.** Drag-to-resize extends from
  two single-axis seams (column separator + detail top) to every
  same-column horizontal boundary, plus a corner handle at the
  col-separator × column-boundary intersections that adjusts both
  axes in one gesture.
  - **Per-panel `heightPct` (YAML).** New optional key on any
    non-detail panel — fraction of the column's total height.
    Panels that set it are anchored; panels that don't are flex
    and share whatever's left in their column equally. Existing
    YAMLs without `heightPct` behave exactly as before
    (equal-share). Oversubscribed sums scale proportionally;
    every panel still meets `minH=3`. Detail keeps its own
    `detailHeightPct` knob (layout-level), unchanged.
  - **Every same-column boundary is draggable.** New
    `boundaryNear()` hit-test runs on press. Drags between two
    non-detail panels mutate both `heightPct` values; drags
    involving detail mutate `detailHeightPct` (clamped [20, 90])
    and the non-detail neighbor's `heightPct`. D1 semantics:
    `freezeColumnFlex` runs on press so siblings keep their
    displayed height instead of redistributing mid-drag and
    outrunning the cursor.
  - **Corner handle.** At intersections of col-separator × any
    column boundary (left or right), the press dispatches
    `resizing-corner`; motion fires both `applyColResize` and
    `applyBoundaryResize` per event. One diagonal gesture moves
    `leftWidth` + the column boundary together.
  - **Keyboard `]` / `[`.** Grow / shrink the focused non-detail
    panel's `heightPct` by 5 pp, stealing from the panel below
    (mirrors drag D1). Detail keeps `+`/`-`. No-op at the last
    position in a column. Footer learns the binding:
    `+/- col/detail · [/] panel h`.
  - **docs/LAYOUT.md** grows a "Resizing panels (design mode)"
    section with drag-target and keyboard tables; the YAML
    example shows `heightPct`.
  - **Tests:** new sections `[3a]`–`[3f]` in
    `js/test/test-design-phase3.js` cover within-col boundary
    drag, corner drag on both sides, freeze-on-press, `calcLayout`
    distribution math (anchored / flex / oversubscribed), and the
    `]` / `[` keys (grow, shrink, detail-skipped, last-position
    no-op, detail-clamp). 97 assertions across 41 cases.

- **Design Mode v2 (Phase 3): undo/redo, drag-to-resize, title edit,
  and `:restore-layout`.** Four features stacked on top of Phase 2:
  - **Drag-to-resize separators.** Mouse press on the column boundary
    (`x ≈ leftWidth`, ±1 cell tolerance) drags `leftWidth` with the
    cursor. Press on the detail-panel top border (`y === panelBounds.detail.y`)
    drags `detailHeightPct`. Both clamp to the same ranges as the
    keyboard `+/-` keys (20–60 for `leftWidth`, 20–90 for
    `detailHeightPct`). Hit-test runs BEFORE the panel-drag arming
    so the separator (which visually sits on a panel border) is
    reachable.
  - **Edit panel title in place.** `t` in design mode enters a
    sub-mode that buffers keystrokes against the focused panel's
    title; Enter commits, Esc cancels. A new `S.designTitleEditMode`
    flag sits ABOVE `S.designMode` in the dispatch chain so design's
    main key handler is skipped while editing.
  - **`:restore-layout` cmdline.** Discards runtime layout changes
    and reloads the `layout:` block from the YAML config file.
    Clears `S.layoutDirty` and the design-mode undo history (the
    new layout is unrelated to anything in the stacks). Companion to
    `:save-layout`; both share the new pure-function
    `rebuildLayoutFromConfig(config)` extracted from `state.js#initState`.
  - **Multi-step undo / redo within a design-mode session.** Every
    layout mutation pushes a snapshot to an in-memory stack (cap 50).
    `u` pops to undo, `Ctrl+R` redoes. Drag gestures push exactly one
    snapshot per gesture (on press), not per motion event. Stack is
    session-scoped: cleared on `enterDesign` and on `:restore-layout`.
    A new mutation after an undo invalidates the redo stack (the
    branched-off timeline no longer applies).
  - Footer hints expanded inline: `Design Mode | drag move/resize |
    J/K reorder | ←→ swap col | +/- resize | t rename | u undo |
    C-r redo | :save-layout | q exit`.
  - Input layer: `\x12` (Ctrl+R) now translates to a named `'ctrl-r'`
    key event in `js/input.js`, alongside the existing `\x03 → exit`
    handling. Currently only design mode acts on it.
  - Tests: new `js/test/test-design-phase3.js` (57 assertions across
    6 describe blocks) covers hit-test math, drag-resize gestures,
    undo/redo round-trip across all mutation types, title-edit buffer
    handling, and `rebuildLayoutFromConfig` purity.

- **Design Mode v2 (Phase 2): drag-and-drop in the real layout.**
  The centered modal overlay is gone. Mouse press on any panel
  inside design mode arms a drag; ≥1 cell of motion enters dragging
  state and paints a green/red insertion line across the target
  column where the panel will land. Release commits the move
  (sets `S.layoutDirty`) or snaps back (invalid target — detail or
  actions into the left column). Keyboard bindings stay (`↑↓ J/K
  ←→ +/-`) — mouse is additive, not replacing.
  - SGR mouse mode 1002 is now enabled at startup (motion-while-held).
    Cost is bounded: terminal only reports motion when a button is
    down. Press → motion+ → release events now fan out through
    `input.js#handleMouse`; non-design code paths still only act on
    press (existing focus+select behavior unchanged).
  - Drop-target math: top half of a panel = insert before, bottom half
    = insert after, below the last panel in a column = append. Empty
    column drops at index 0. Detail and Actions panels are blocked
    from the left column with a footer reason; the insertion line
    paints red instead of green over the blocked target.
  - Design-mode footer now surfaces the affordance hints inline
    (`drag move | J/K reorder | ←→ swap col | +/- resize |
    :save-layout | q exit`) so the discovery path doesn't need
    external docs.
  - Tests: new `js/test/test-design-drag.js` (44 assertions) pins
    state machine transitions (press → armed → dragging → release),
    drop-position math (top/bottom half, append, empty column,
    invalid column), and cross-column splice/insert math with
    same-column-index adjustment.

- **Design Mode v2 (Phase 1): save is decoupled from mode exit.**
  Hitting Enter inside design mode no longer writes to YAML; neither
  does `q`/`Esc`. Mutations apply to `S.layout` at runtime and the
  footer shows `• unsaved (:save-layout)` while they differ from the
  on-disk config. To persist, run the new `:save-layout` cmdline
  command. Rationale: makes the editing surface a free-form
  experiment-and-tweak space (live tweaker UX) without conflating
  exit with commit. A future `:restore-layout` will revert runtime
  state to the YAML's contents; for now, restart the TUI to re-read
  from disk.
  - Lossy save is fixed in passing. `:save-layout` writes through a
    new `js/yaml-layout.js` module whose `serializeLayout()` walks
    every key on each panel object except runtime-derived ones
    (`hotkey`, `column`, `config`) and the detail panel's synthesized
    `height`. Plugin panel keys (`topic`, `select_from`, `decorators`,
    `refresh_interval_ms`, custom plugin options) survive the round
    trip — previously they were silently dropped, breaking the stats
    panel's hub subscription on any save.
  - `S.layoutDirty` tracks divergence from disk; set by every
    layout-mutating handler in `design.js`, cleared by
    `:save-layout` on success.
  - Phase 2 (drag-and-drop in the real layout, replacing the centered
    modal overlay) is planned but not in this commit.
  - Tests: `js/test/test-yaml-layout.js` covers scalar emission,
    per-panel key preservation, full emit→write→reparse round-trip
    through the Python parser, and the existing-block splicer.

### Fixed
- **JS-plugin loading was a silent no-op (parser-port regression).**
  The JS parser-port from earlier in v0.3.0 dropped the `plugins:`
  block from `parse()`'s returned config — `loadPlugins(S.config.plugins,
  ...)` received `undefined` and iterated zero entries, so JS plugins
  (`path: ./foo.js` style) never `require()`d and never registered
  their panel types. Layouts that referenced a JS-plugin-provided
  panel type rendered the slot as an empty string; in `paintColumns`
  the short-left-output then concatenated the right column's bottom
  rows into the empty left rows, painting the detail panel under the
  groups panel at column 0 with right-column width. YAML plugins
  (`.yml`/`.yaml` paths) were unaffected because `mergeYamlPlugins`
  inlines their content into groups/vars/files before validation.
  The differential parser test that gated the JS port passed only
  because neither postgres nor cloudberrydb demo uses a `.js` plugin
  path — the codepath had no fixture coverage. Fix: include
  `data.plugins || {}` in `parse()`'s return; two regression tests
  pin the round-trip and the no-plugins-block → `{}` contract.
  Surfaced by the ssh-fleet demo, which is lazytui's first JS-plugin
  user.

- **Cmdline (`:`) polish from manual testing.** A cluster of
  user-reported glitches in the cmdline dropdown and bare-Esc
  dispatch, fixed in sequence as they surfaced:
  - **Bordered dropdown panel + theme integration.** The match
    list used to paint raw `\x1b[7m` / `\x1b[2m` rows directly
    onto the cells beneath, with no border or separator — read
    as visual bleed-through against whatever panels happened to
    sit at the bottom of the screen. Now renders through
    `renderPanel` (same helper menu / design overlays use):
    bordered box, themed chrome, count badge (`<sel>/<total>`),
    centered horizontally just above the prompt row. Selection
    follows PRINCIPLES.md §8 — outer `[reverse]` wraps the
    whole row, no inner style nesting.
  - **Width scales with the terminal.** The previous 80-col cap
    left a small box hovering in unused space on wide
    terminals. New formula `panelW = max(40, COLS - 4)` bottoms
    out at 40 on narrow terminals and grows with everything
    else.
  - **Clean shrink residue.** When the match set shrunk
    (additional chars narrowed matches), the previous frame's
    taller panel left ANSI residue on rows the new panel no
    longer covered — the underlying panels' diff cache had no
    reason to think they'd been touched. New
    `layout.invalidateRows(startY, endY)` empties the per-row
    diff cache for the affected range so the next render
    repaints from the panels below; `cmdline.js` also blanks
    those rows synchronously so the current frame stays clean.
    `invalidateRows` is reusable by any future overlay with a
    similar incremental-shrink pattern.
  - **Collapse newlines in match desc.** YAML `desc: |` block
    scalars carry literal `\n`. The dropdown formatter passed
    them through to `renderPanel`; `truncate()` counted `\n` as
    width 1 but the terminal honored it as a real line break,
    so the right border dropped onto its own row. Whitespace
    runs in both `display` and `desc` are now collapsed to
    single spaces in `formatMatchLine` — the single-line
    guarantee is enforced at the formatter, not relied on from
    the data source. Full multi-line desc still renders
    untouched in the Info panel.
  - **Bare Esc dispatch (input layer).** Pressing Esc inside
    cmdline sometimes didn't exit. Some terminals + Node
    stdin buffering states deliver bare Esc as `\x1b\x1b`
    (the legacy literal-Esc trick) or `\x1b<followup>` (Esc
    plus a buffered keypress in one chunk); the strict
    `data === '\x1b'` check on `input.js` only matched a clean
    single-byte chunk. Defensive fallthrough now treats any
    chunk that starts with `\x1b` and survived all the
    specific-sequence checks (focus events, paste, SGR mouse,
    arrow keys, PgUp/PgDn, Ctrl+R) as `'escape'`. Trailing
    bytes are discarded — lazytui has no Alt/Meta bindings.

- **`type: spawn` actually works outside tmux now.** Previously, the
  no-tmux branch ran the script *detached* with `stdio: 'ignore'`, so
  interactive subprocesses (`psql`, `less`, `$EDITOR`) got `/dev/null`
  for stdin/stdout and silently exited — making the action feel like
  it "had no effect". The fix mirrors the SIGTSTP dance from
  `suspend.js`: suspend the TUI's terminal modes, hand the child our
  TTY synchronously (`spawnSync` with `stdio: 'inherit'`), then
  restore. Suspend/resume primitives are factored into
  `suspend.js#suspendTerminal/resumeTerminal` so both call sites stay
  in sync. The detail panel now also reports the child's exit status
  (clean, non-zero, signal, or spawn-error), so a quick failure is
  no longer indistinguishable from a no-op. Regression test in
  `js/test/test-spawn-bare.js`.

### Considered but not shipped for v0.3.0
- **Printf-above-program output.** Persistent messages printed above
  a TUI's main render area need altscreen — lazytui doesn't use it
  (deliberate — leaves prior shell content visible after quit) so
  the "above" concept doesn't translate. The detail panel +
  `streamCommand` already cover the underlying use case (streamed
  action output landing somewhere visible and persistent).
- **External event injection.** Useful for IPC and test harnesses,
  but every implementation (HTTP server, Unix socket, named pipe)
  adds attack surface for a feature with no concrete user demand
  yet. The key-filter middleware (above) already covers the
  in-process injection case for tests. Defer until a real use case
  surfaces.
- **Embeddable widget library + declarative styling DSL.** Big
  architectural moves from the earlier feature audit. Each is a
  v1.0-scale undertaking; deferred deliberately.

### Added — v0.3.0 surface (terminal-citizen polish)
- **Component API — strict TEA-shaped alternative to Plugin.** New
  `api.registerComponent(component)` registers a plugin whose state
  is framework-owned (slice per Component), messages flow through
  `update(msg, slice) → newSlice`, and render functions receive the
  slice (not the global `S`). Coexists with `registerPlugin` —
  every existing plugin keeps working unchanged. Plugin authors
  pick per-plugin: Plugin for the fast-path (mutate-S, simple) or
  Component for the discipline (replay, snapshot tests, isolation).
  See PRINCIPLES.md §12 for the contract.
  - Framework wiring: registration validates `init` + `update`,
    init runs at register time, panel types tracked separately
    from Plugin panel types, decorators / statusFor reused as-is.
  - Msg dispatch: every key (via `dispatch.handleKey`), refresh
    tick (via `refreshAll`), hub publish (via `hub.publish`), and
    action invocation (via `actions.runAction`) fans out to every
    Component's `update()`. Msg shape mirrors event-log entries.
  - Update isolation: a Component's update() throw is logged and
    that Component's slice stays put; other Components keep
    processing the same Msg.
  - Render integration: `layout.rendererFor(type)` checks the
    Component-owned panel map first; falls through to the
    Plugin-owned path if no Component claimed the panelType.
  - Tests: `js/test/test-component.js` (15 assertions) covers
    registration validation, init-at-register, Msg fan-out, return
    shapes (new slice / undefined / throw), and component-panel
    render wiring. JS suite now 21/21 (was 20).
- **Key-filter middleware.** `dispatch.registerKeyFilter(fn)` adds a
  pre-dispatch hook. Each filter receives `{key, seq}` and may
  return the (possibly modified) event, the event unchanged, or
  null to suppress. Filters run in registration order; the dispatch
  layer logs + dispatches whatever survives the chain. Use cases:
  keyboard remapping (vim-mode hjkl → arrows), key throttling /
  debouncing, pre-dispatch analytics, test instrumentation. New
  test file `js/test/test-key-filters.js` (13 assertions).
- **Per-plugin refresh cadence.** Plugins gain optional
  `refreshIntervalMs` (default 10000). New
  `plugins/api.startRefreshLoops(config, opts)` starts a self-scheduling
  setTimeout *per plugin*, with overlap-skip (if a previous tick is
  still running, skip the new one) and focus-gating (via the
  `isFocused` callback the caller passes — keeps api.js
  state.js-agnostic). Stats plugins that want ~1s ticks can declare
  it; rare-poll plugins (image archives, config branch) can declare
  5min and stop wasting CPU. Replaces the previous single 10s
  refresh-everything loop in tui.js. `refreshAll()` is preserved for
  one-shot use (initial paint + `:refresh` cmdline).
- **Suspend / resume (SIGTSTP / SIGCONT).** Ctrl+Z used to corrupt
  the terminal (raw mode + mouse + focus reporting all stayed on
  for the shell). New `js/suspend.js` installs the standard Unix
  dance: on SIGTSTP, restore the terminal then re-raise the signal
  so the kernel actually stops the process; on SIGCONT, re-enter
  raw mode, re-enable mouse/focus/paste, hide cursor, invalidate
  the render diff cache, repaint. Embedded PTY children get SIGCONT
  automatically. No-op on Windows.
- **Live debug log stream (`LAZYTUI_LOG=path`).** Event log gains
  `attachStream(path)` / `detachStream()` and an auto-attach from
  the `LAZYTUI_LOG` env var at module load. Every recorded event
  also gets a JSON line appended to the file via `appendFileSync`
  (sync writes at TUI event rates are ~3 kB/s — negligible vs
  stream complexity). Tail with `tail -F` in another window for
  live diagnostics.
- `layout.js` exports `forceFullRepaint()` — resets the diff cache
  so the next `render()` does a full clear + redraw. Used by the
  SIGCONT handler; future use cases include returning from any
  external subprocess that scribbled on the screen.
- **Focus / blur events (DEC 1004).** `\e[?1004h` enabled at startup;
  `\e[I` and `\e[O` parsed in `input.js`. `S.focused` defaults to
  true (so terminals without focus reporting still refresh). The
  `refreshLoop` in `tui.js` skips its `refreshAll()` call while
  blurred — saves CPU + docker API calls while the user has tabbed
  away. On focus return, `scheduleRender()` paints the cached frame
  immediately; the next loop iteration runs the real refresh.
- **Bracketed paste (DEC 2004).** `\e[?2004h` enabled at startup.
  Pasted multi-line blocks arrive wrapped in `\e[200~ ... \e[201~`;
  `input.js` collapses each into a single `paste` key event with
  the inner text in `seq`, instead of dispatching per-byte. Mode
  handlers that want the multi-line content (prompt, cmdline) read
  the seq arg; other modes ignore.
- `js/term.js` gains `enableFocusEvents` / `disableFocusEvents` and
  `enableBracketedPaste` / `disableBracketedPaste`. Both disabled
  in `cleanup.js` for clean terminal restore on exit.

### Added — v0.2.0 surface (TEA-inspired discipline)
- **Event log recorder (`js/event-log.js`).** In-memory ring buffer
  capturing input events: key presses (via `dispatch.handleKey`),
  hub publishes (via `hub.publish`), refresh ticks (via
  `plugins/api.refreshAll`), and action invocations (via
  `actions.runAction`). Default cap 500 events (~50 kB). Exposes
  `record / enable / setCap / clear / snapshot / size / save`. The
  `save(path)` helper serializes to JSON with a version header,
  suitable for attaching to bug reports. Foundation for the planned
  replay path; deliberately producer-only in v0.2.0 — see "Pending
  for v0.2.x" below.
- **Render idempotence principle (PRINCIPLES.md §11).** A panel's
  `render(panel, w, h, S)` called twice with the same inputs produces
  the same output. Articulates the actual discipline lazytui follows
  (weaker than strict purity — layout writes derived state, stats
  panel lazy-subscribes to the hub on first render — but stronger
  than "anything goes"). New checklist bullet in §12.
- **`js/test/test-event-log.js`** — covers the ring buffer, enable
  / disable gate, JSON save round-trip, and the wired hub +
  refreshAll hooks (key + action hooks are exercised indirectly by
  the existing dispatch + cli test suites). 22 new assertions; JS
  suite now 19/19 (was 18/18).
- **`js/test/test-render-idempotent.js`.** Exercises representative
  core plugin renders (groups, actions, detail, file-manager,
  history) twice per panel under two focus configurations. 15 new
  assertions; total JS suite now 18/18 (was 17/17). Docker, stats,
  config-status skipped: docker needs runtime status setup; stats +
  config-status have known idempotent-but-impure lazy-init that is
  covered separately by their existing tests.

### Removed
- **tidb demo (parseable-only) dropped from advertised support.** The
  in-flight `dev-demo-tidb` branch is removed from `origin`. v0.1.0's
  CHANGELOG entry referenced "tidb on `dev-demo-tidb` branch awaiting
  live-test merge"; that was overpromising for a release that hadn't
  verified the demo on Docker. Restored as a future demo once a real
  use-case drives it (and once a live test actually runs).

### Changed
- README's demos table column renamed `Notes` → `Status`, and the
  cloudberrydb row now reads "YAML parses; live build not yet
  verified" instead of "live build deferred." More upfront for a
  first-time visitor.

## [0.1.0] — 2026-05-18

First public tagged release.

### Framework
- Renderer (Node.js, zero npm runtime deps except `node-pty` and
  `@xterm/headless` for embedded PTY tabs).
- Parser (Python, validates and resolves the YAML config).
- 17 JS smoke suites + 6 pytest files. Live integration harness
  under `test/`.
- Built-in panel types: `groups`, `actions`, `file-manager`,
  `history`, `detail`, plus `containers` and `stats` from the
  docker plugin.
- Subsystems: hub (pub/sub), decorators (UI slot framework),
  cmdline (`:`) verbs, embedded PTY terminals, 6 themes, design
  mode, CLI mode (`--exec`, `--list`), `--spec` bundle for AI
  agents.

### Demos
- `demo/postgres` — Shape A (build from source). Verified end-to-end
  on Docker. Includes a `POSTMORTEM.md` documenting the DinD
  bind-mount discovery and the "fix the prompt, not the artifact"
  two-layer fix that resulted.
- `demo/cloudberrydb` — Shape B (wrap upstream's `devops/sandbox/`).
  YAML parses; live build deferred. `POSTMORTEM_v1.md` captures the
  drop-and-rewrite decision when the first producing pass diverged
  from upstream's actual conventions.
- `demo/tidb` — Shape A variant (orchestrate pre-built `pingcap/*`
  images). Lives on the `dev-demo-tidb` branch pending a live-test
  merge.

### Docs
- `README.md` — positioning, ASCII TUI mockup, quickstart, comparison
  table against Make / shell / Taskfile, three-demo table, "Read next"
  with split for using vs contributing.
- `DEMO.md` codifies the two demo shapes and the loop discipline.
- `docs/` subtree: framework + plugin authoring (SPEC, PRINCIPLES,
  PLUGINS, PROJECT, LAYOUT, HUB, DECORATORS, CMDMODE, TERMINAL,
  STATS, TESTING). `docs/history/` for the dev9-era retrospective and
  FUTURE backlog.
- Standard OSS files: `CONTRIBUTING.md`, `CHANGELOG.md`,
  `SECURITY.md`, `CODE_OF_CONDUCT.md`, `LICENSE` (MIT).

### Release plumbing
- `.github/workflows/test.yml` — JS + pytest CI on push / PR.
- `.github/workflows/release.yml` — on `v*.*.*` tag push, runs
  tests, builds `lazytui-X.Y.Z.tgz` (npm-style) +
  `lazytui-X.Y.Z-source.tar.gz` (full git-archive), creates a
  GitHub Release with both tarballs attached.
- `RELEASING.md` documents the maintainer flow.
- `package.json` ready for publish; `private: true` retained until
  the dual-runtime npm-install question is resolved.

### Pre-tag history
The single-commit public state at `b384d19` (2026-05-15) was the
first form of lazytui visible on GitHub. v0.1.0 is the first state
with a semantic version, a CHANGELOG entry, and downloadable
release tarballs. Full pre-squash development history is preserved
on the internal gitea mirror under the `backup/main-history` branch
and the `v0.1.0-pre-squash` tag.

[Unreleased]: https://github.com/Tao-Ma/lazytui/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/Tao-Ma/lazytui/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Tao-Ma/lazytui/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Tao-Ma/lazytui/releases/tag/v0.3.0
[0.1.0]: https://github.com/Tao-Ma/lazytui/releases/tag/v0.1.0
