# lazytui Layout Design

## Layout framework

The TUI is a **lazytui** framework — a reusable N-column layout. The
pattern is fixed at the structural level (column-major grid, bordered
panes, `actions` anchored to the last column — `detail` places
anywhere since v0.6.4 multi-viewer); the panel content and column
count are YAML-configurable.

### Pattern (fixed)
- Ordered list of columns, left-to-right. Each column carries an
  explicit `width:` in cells except the last, which takes the
  remainder of the terminal. Two columns is the default shape; three
  or more is supported (run-time via drag-edge spawn / `:add-column`).
- Bordered panels with scrollbar, focus color, position counter
- Detail panel(s) with tabs, scroll — position-agnostic since v0.6.4
  multi-viewer (any column, any pane; one or more)
- Footer bar, `x` menu popup, `?` help

### Configuration (YAML `panels:` + `layout:` sections, both optional)

Since v0.6 there are two cooperating blocks. The `panels:` block
declares a POOL of panel definitions (panel identities); the
`layout:` block picks a subset of the pool by id and arranges them
in the column grid. Pool entries not placed in the grid are
*hidden* — still configured, surfaced in the free-config overlay
so you can summon them back without editing YAML.

v0.6.1 generalized the cell model: every cell is a **pane** (a
placement slot), and every pane holds 1+ **tabs** (each tab is a
panel kind instance). Singleton detail retired — `detail` is just
another tab kind, subject to the same pool/cell mechanics.

v0.6.2 generalized the column model: `layout.left:` / `layout.right:`
retire in favor of an ordered `layout.columns:` list (see
[`history/v0.6.2-migrate.md`](history/v0.6.2-migrate.md) for the mechanical
hand-conversion).

```yaml
panels:                # the pool — every panel keyed by id
  containers:
    type: containers
    title: Containers
  groups:
    type: groups
  files:
    type: files
    source: declared
  actions:
    type: actions
  detail:
    type: detail
  notes:               # in pool but not placed below → starts hidden
    type: viewer
    title: Notes

layout:                # the grid — ordered columns, cells reference pool by id
  columns:
    - width: 30        # explicit width in cells
      panels:
        - containers
        - groups
        - files
    - panels:          # last column — width implicit (takes remainder)
        - actions
        - { tabs: [detail], height: 60% }   # mapping form when an override applies
```

**Two layout-cell forms** — bare-string for the common case, mapping
when you need more:

| Cell form | Meaning |
|---|---|
| `groups` (bare string) | Pool-id reference. Single-tab pane, no overrides. |
| `{ tabs: [detail], height: 60% }` | Pool-id list (one or more) plus optional `activeTab`, `heightPct`, `collapsed`, and `height` (detail-only). |

Multi-tab panes use the mapping form too:

```yaml
- { tabs: [docker, logs], activeTab: docker }
```

`activeTab` is optional — defaults to `tabs[0]`. Switch active tab
at runtime via `:switch-tab <pool-id>` (cmdline; autocomplete restricts
to the focused pane's other tabs) or from the unified `[≡]` pane-menu's
Tabs section (mouse). `]`/`[` still cycles the active viewer tab's
inner strip (Info / Transcript / action tabs / terminal tabs /
content tabs), not pane-level tabs. See
[`history/v0.6.1-migrate.md`](history/v0.6.1-migrate.md) for the conversion guide
from v0.6.0 inline cells.

**Default layout** generated when neither block is given.

**Per-panel height — `heightPct`.** Optional integer 1–100. Panels
that set it are *anchored*; panels that don't are *flex* and share
whatever's left in their column equally. The detail pane keeps its
own `height: N%` cell knob, and as of v0.6.4 that height lives on the
**pane itself** (the same per-pane `heightPct` every other panel uses)
rather than a single layout-wide scalar — so two panes of the same
kind, or a future second detail pane, each carry an independent height
instead of colliding on a shared type slot. The top-level
`detail_height_pct` (and the in-memory `arrange.detailHeightPct`)
remain as the *default* seed for a detail pane that doesn't specify
its own. When anchored values + reserved (detail) leave less than 3
rows per flex panel, anchored values scale proportionally so every
panel still meets the minimum.

YAMLs without `heightPct` behave as before (equal-share within the
column). The drag UX (below) materializes `heightPct` for any panel
the user resizes — once the layout is saved via `:save-layout`, the
new values appear in the YAML.

### Pane and tab constraints
- First column: soft cap of 6 panes, hotkeys `1`–`6` auto-assigned
  by position
- Last column: soft cap of 3 panes, hotkeys `7`–`9` auto-assigned
- Middle columns (only when N ≥ 3): soft cap of 6 panes (the
  non-last-column cap applies), but no auto-hotkey pool — panes must
  specify `hotkey:` explicitly or accept an empty hotkey (still
  reachable via mouse / `:focus <title>`)
- Per-pane override via YAML `hotkey: <char>` (on the cell);
  auto-assignment skips keys already claimed explicitly
- Soft caps warn at parse but don't refuse — the renderer's
  MIN_PANEL_H + terminal-row floor is the only hard limit
- At least one tab of kind `detail` anywhere — any column, any pane
  (the last-column / last-pane geometry rule was dropped in v0.6.4
  multi-viewer; the parser only refuses zero detail tabs)
- At most one tab of kind `actions` anywhere — in the last column
- No `actions` tab outside the last column; `detail` places anywhere
- A `detail` tab must be the only tab in its pane (multi-tab panes
  hosting detail are deferred)
- No two tabs of the same kind inside one pane

### `pool.type` (kind) vs pool / tab `id` — two roles
Pool entries carry two identifiers that look similar but answer
different questions; they're easy to confuse when reading the
codebase.

- **`pool[id].type`** — the renderer/component kind. Maps to the
  Component that owns the panel via
  `registerComponent({ panelTypes: { <type>: … } })`. Used by the
  render layer (which renderer to call), the dispatch layer (kind
  comparisons via `instanceKind(...)`), and per-kind bookkeeping.
  Same value for every instance of the same kind.
- **`id` (tab id == pool-entry id)** — instance identity. Unique per
  pool entry; reused as the tab id when a layout cell places the
  entry. Used by: the `panels:` pool map (`arrange.pool[id]`), the
  instance-slice registry (`getInstanceSlice(id)`), `pool_hide` /
  `pool_show` / `panel_collapse_toggle` Msgs, and `:save-layout`
  round-trip. Two pool entries with the same `type` (e.g. two
  file-browsers) get distinct ids.

Rule of thumb: read or set `type` when you mean "what KIND of
content"; read or set `id` when you mean "which SPECIFIC instance".
A pane's `tabs[]` array carries `id` references that resolve through
the pool to a `type`. The mapping is built at parser-time in
`state.rebuildLayoutFromConfig`.

## Visual patterns

### Border as information carrier
- **Top border**: `(hotkey)─title` — `╭─(1)─Containers──────╮`
- **Bottom border**: item count — `╰────────────────3 of 7─╯`
- **Right border**: scroll indicator — `▐` replaces `│` at viewport position

### Display rules
- All panels visible at once — no tab switching, maintain state awareness
- Active panel: green border, inactive: dim border (both single-line)
- Dense rows — one item per line, metadata inline
- Position counter in bottom border of every list panel
- `>` marks last-run action in actions panel
- Lines wider than panel are truncated with `…`

### Panel chrome glyphs

Each placed panel's top-border row hosts up to four small interactive
icons, theme-coloured per the Mac traffic-light convention. They're
baked into the row's markup (not painted on top after-the-fact) so they
ride atomically into `paintColumns`' single write — eliminates flicker
on rows that get repainted while a glyph sits over them.

| Glyph | Color | Where | When | Click |
|---|---|---|---|---|
| `[X]` | red | top-right of non-detail panels | free-config mode only | `pool_hide` — unplaces the panel; the entry stays in the pool (reachable via `:show <id>` or the `w` panel-list overlay) |
| `[_]` | yellow | top-right of non-detail panels (4-cell gap left of `[X]` when both visible) | always (normal + free-config) | `panel_collapse_toggle` — collapses the panel to a single header row |
| `[+]` | green | replaces `[_]` when the panel is already collapsed | always | toggle back to expanded |
| `[≡]` | theme accent | top-left of **every** panel (immediately after the hotkey), v0.6.4 unified | shown per-pane when there's something to pick (a viewer with ≥2 tabs, any other pane with ≥2 pane rows); suppressed during drag, and siblings disable while the menu is open on one cell | opens the centered **pane-menu** — one projection-aware overlay (subsumes the former tab-list + pane-select dropdown) with a **Tabs** section (Info, Transcript, action / terminal / content tabs — viewers only) and a **Panes** section for swapping which pool entry occupies this slot (SWAP if picked is placed elsewhere, REPLACE if picked is hidden; half/full views place side-by-side viewers via `pane_menu_place`) |

Detail's top row reads `╭─(o)[≡]─Detail─…─╮` — both the hotkey label
and the pane-menu trigger are visible, the trigger's 3-cell width
absorbed by eating 3 trailing fill dashes before the right corner.
When that absorption can't fit (very narrow detail or very long
title), the trigger replaces `(o)` instead so the affordance still
shows.

All glyphs suppress during a drag in flight (the drag affordance owns
the screen — drop targets, live preview, footer). Theme slots
`chrome_close`, `chrome_collapse`, `chrome_expand`, `chrome_trigger`
let palettes override the defaults. Glyphs dim with the panel when
the panel isn't focused (composes `[dim]` with the color rather than
defaulting to the terminal's plain `[dim]` foreground).

## Concept

**Groups panel focused, Status tab active:**

```
╭─(1)─Containers─────────╮╭─(0)─Actions────────────────────────────────╮
│ ● dev9-env              ││ > Status                                  │
│ ● dev9-openvpn          ││   SSH                               ⧉    │
│ ● dev9-gitea            ││   Browse                            ⇱    │
│ ● dev9-cliproxyapi      ││   Logs                              ⧉    │
│ ● dev9-webdav           ││   Start                                  │
│ ○ dev9-noip             ││   Stop                         [confirm] │
│ ● dev9-status           ││   Init                         [confirm] │
╰──────────────────7 of 7─╯╰────────────────────────────────1 of 7─╯
╭─(2)─Groups──────────────╮╭─(o)─Info─[Status]──────────────────────────╮
│❶ Core Services     7 ●  ││ $ docker compose ps                        ▐
│  Dev9 VPN          1 ●  ││ NAME              STATUS    PORTS          ▐
│  Work VPN          1 ●  ││ dev9-env          running   0.0.0.0:2222   ▐
│  Config            0    ││ dev9-openvpn      running   0.0.0.0:9999   │
│  Build             0    ││ dev9-gitea        running   0.0.0.0:3000   │
│  Maintenance       0    ││ dev9-cliproxyapi  running                   │
╰──────────────────1 of 6─╯│ dev9-webdav       running                   │
╭─(3)─Config Files────────╮│ dev9-noip         exited                    │
│ client/id_ed25519       ▐│ dev9-status       running                   │
│ client/*.ovpn           ││                                             │
│ conf/gitea/app.ini      ││ Done.                                       │
│ conf/noip.env           ││                                         9/11│
╰─────────────────1 of 24─╯╰─────────────────────────────────────────────╯
 ↑↓ select  ←→ panel  Enter run  x menu  q quit
```

## Panel types

### Left column

**containers** — Docker container status for selected group
- `●` green = running, `●` red = stopped, `○` dim = unknown
- Navigable — selected container shows name + status in detail
- Content changes when group selection changes

**groups** — Service groups with container counts
- Highlight selected group with reverse/bold
- Container count + summary dot inline (e.g. `7 ●`)
- Selecting a group updates containers and actions panels
- Detail shows group info (compose, containers, action list)

**files** — Browse declared file registry, filesystem, or a container's
filesystem; select with `source:` (`declared` / `filesystem` / `both` /
`docker`). `file-browser` is a hardcoded `filesystem` alias.
- Shows path only — details shown in detail panel on browse
- Scroll indicator when list overflows

### Right column

**actions** (positional hotkey) — Executable actions for selected group
- `>` marks selected action (when unfocused) or last-run action
- `[reverse]` highlight on selected action only when panel is focused
- Type indicators: `⧉` spawn, `⇱` background
- `[confirm]` tag, `<args>` hint
- Detail shows desc + script preview on browse

**detail** (positional hotkey) — Tabbed info/output display
- In v0.6.1+ the `detail` kind is one of many possible tab kinds in
  a pane — the singleton-detail assumption retired, even though the
  default layout still places exactly one detail tab. A detail tab
  must be the SOLE tab in its pane, so `{tabs: [detail, history]}`
  is rejected at parse — multi-tab panes hosting a viewer are
  deferred (see
  [`history/v0.6.1-migrate.md`](history/v0.6.1-migrate.md)).
- Position-agnostic since v0.6.4 multi-viewer — a detail pane can
  live in any column and any position; there is no last-column /
  last-pane anchor invariant, and a layout may place two or more
  detail panes.
- **Tab 0 (Info)**: always present — shows `info()` for selected item
- **Tab 1+**: actions with `tab: true`, terminal sessions, and
  content tabs opened via `:open` or file-browser Enter
- `]`/`[` cycles the tabs visible in detail's tab strip
- `PgUp`/`PgDn` scrolls content
- Bottom border shows scroll position when content overflows

## Navigation

| Key | Action |
|-----|--------|
| `1`–`6` | Focus left panel by position |
| `0` | Focus actions panel |
| `o` | Focus detail panel |
| `↑`/`k` `↓`/`j` | Navigate within focused panel |
| `←`/`h` `→`/`l` | Move focus linearly (no wrapping) |
| `]` `[` | Cycle detail panel tabs |
| `PgUp` `PgDn` | Scroll detail panel |
| `Enter` | Execute selected action / show details |
| `+` | Expand view: normal → half → full |
| `_` | Shrink view: full → half → normal |
| `x` | Toggle keybinding menu popup |
| `r` | Refresh container status |
| `/` | Filter panel items |
| `Enter` | Activate terminal tab (when on terminal tab) |
| `Ctrl+\` | Exit terminal mode |
| `?` | Show help in detail panel |
| `<leader> o` / `<leader> i` | Navigation history: jump back (older) / forward (newer) — v0.6.7 |
| `q` | Quit |
| Mouse click | Focus panel + select item |

## Mouse

SGR mouse reporting enabled (`\x1b[?1000h` + `\x1b[?1006h`).
Left click on a panel focuses it. Click on an item selects it.
Panel bounds tracked during render for hit testing. Mouse disabled
on cleanup.

Note: enabling mouse reporting takes over the mouse from the
terminal — native text selection may not work while the TUI runs.

## Detail tabs

The detail strip has two implicit global tabs followed by per-group
tabs:

```
[Info] [Transcript] [actionTabs...] [termTabs...] [contentTabs...]
   0        1          2..1+A          2+A..1+A+T   2+A+T..1+A+T+C
```

- **Info** (idx 0) — pure selection-info. Refreshes as the cursor
  moves in actions / groups / files / containers.
- **Transcript** (idx 1, v0.6.2) — singleton accumulator for all
  unrouted output: `type:run` streams without `tab: true`, spawn
  launch confirmations, cmdline-verb outcomes. Cap 1000 lines,
  bottom-pin on restore, `[dim](no transcript yet)[/]` placeholder
  when empty.
- **Action tabs** — actions with `tab: true` (see below).
- **Terminal tabs** — `terminals:` PTYs.
- **Content tabs** — files opened via `:open` / Enter on a file row.

`]`/`[` cycles between them. Tab actions execute silently (bypass
confirm/args, don't mark as last-run). Navigating items in a list
panel auto-yanks the viewer back to Info from any non-Info tab, so
selection-info always appears with the cursor (v0.6.2 — the unrouted
transcript stays available via Transcript).

```yaml
actions:
  build:
    cmd: make
    label: Build
    tab: true          # long-running stream → dedicated tab
  ssh:
    type: spawn
    label: SSH         # no tab — spawn opens a terminal
  ps:
    cmd: docker compose ps
    label: PS          # no tab — one-shot snapshot → Transcript
```

The rule for `tab: true`: opt in for long-running streams, multi-
action concurrency, or output you'll diff across runs. One-shot
snapshots and ad-hoc commands fit Transcript naturally and don't
need their own tab.

## Terminal tabs

Groups can define `terminals:` — interactive PTY sessions embedded as
detail panel tabs. Strip position: after action tabs (i.e., starting
at `idx = 2 + actionTabs.length`).

```yaml
groups:
  database:
    terminals:
      sql:
        cmd: "psql -h localhost mydb"
        label: "SQL Editor"
```

Press `]`/`[` to reach the terminal tab. Press `Enter` to activate
terminal mode (keystrokes go to PTY). Press `Ctrl+\` to return to TUI.
Sessions persist across group switches. See TERMINAL.md for details.

## View modes

Three view modes, cycled with `+` (expand) and `_` (shrink):

**Normal** (default) — standard N-column layout with all panels visible.

**Half** — focused panel and detail panel split the full screen width,
each taking half. Other panels are hidden. Useful for browsing long
action lists or config files alongside their detail output.

**Full** — focused panel takes the entire screen. Useful for reading
long command output or scanning large container/config lists.

Footer shows `[half]` or `[full]` when not in normal mode.

**Why `+`/`_` and not `=`/`-`:** the shift-only pair is intentional.
`+` and `_` read as a paired expand/shrink visually (both are stretched
glyphs), and they sit on the same two physical keys as `=`/`-` so the
ergonomic argument doesn't actually save a keystroke. Unshifted `=`/`-`
are also more likely to collide with future per-panel bindings (numeric
adjustments, zoom-style verbs). Keeping shift-only here leaves the
unshifted slots free. Reconsider only if a panel-level use of `=`/`-`
forces the issue.

## Free-config mode (layout + pool editor)

Free-config mode is where the layout gets mutated interactively —
column widths, panel heights, panel arrangement, hidden/shown
membership. Entry:

- `:free-config` (cmdline)
- (configurable keybinding — slot one into the `keys:` block)

Saves are explicit: `:save-layout` writes to YAML, `:restore-layout`
reloads from disk and clears the session's undo history.

**Freeze gate.** While the mode is active, all panel Components are
visually frozen (last snapshot rendered, poll/stream updates queued
or dropped behind the gate). This keeps the canvas stable under
drag / resize / pool mutations and matches tmux prefix-mode
semantics — the user's input is for editing, not interacting with
the panels.

### Panel-list overlay

Press `w` while in free-config to open the panel-list overlay (or
it opens automatically on entry when the pool has hidden entries).
Each pool entry shows with a status marker:

| Marker | Status | Pick action (Enter) |
|---|---|---|
| `[green]●[/]` | Placed in the grid | hide (returns to pool) |
| `[dim]●[/]` | Essential (sole detail) | no-op — only when it's the last remaining viewer; with ≥2 detail panes each is an ordinary hideable `[green]●[/]` entry |
| `[yellow]○[/]` | Hidden — pool only | show (appends at the last column's tail) |

| Key | Effect |
|---|---|
| `↑` / `↓` (or `k` / `j`) | Navigate the list |
| `Enter` | Context-pick (hide / show / no-op per status above) |
| `w` or `Esc` | Close the overlay (free-config stays open) |
| `q` | Exit free-config entirely |

**Mouse drag from the overlay onto the grid** (3-zone per cell, same
rule as in-grid reorder):

| Drop zone (within a cell) | Effect |
|---|---|
| Top third | **Insert before** this cell. |
| Middle third | **Replace** — occupant returns to the pool; source lands in the occupant's slot. A detail occupant refuses only when it's the sole viewer (essential); `actions` refuses if the slot is outside the last column. |
| Bottom third | **Insert after** this cell. Bottom-of-last-cell = append at tail. |
| Screen edge / column gap (v0.6.2) | **Spawn a new column** at that position (left edge → position 0; column gap → between the two adjacent columns). The right edge is NOT a spawn zone — the rightmost cells fall through to the last column's in-column 3-zone hit. `actions` sources refuse all new-column spawns (it must stay in the last column); detail spawns freely. |
| Outside the layout | Cancel; the overlay reopens if it was open at drag-start. |

While a drag has a valid target, the layout reshuffles in real time —
**live preview**. The render pass swaps `slice.arrange` for the
would-be-after-release arrangement, so insert opens a gap, replace
swaps the pool entry into the cell, and the existing layout shifts
to make room. Release commits the preview; cancel reverts to the
pre-drag layout. Self-swap (source's own cell, middle third) is a
valid no-op surfaced in the footer as `(no-op — release to cancel)`.

The same 3-zone scheme applies to in-grid reorder (drag an already-
placed panel), with the middle third meaning **swap** instead of
replace — the dragged panel and the occupant trade slots
(cross-column supported; only `actions` stays pinned to the last
column, detail swaps anywhere since v0.6.4 multi-viewer).

### Resizing — drag (mouse)

Every seam between panels is a drag target:

| Press on | Gesture | Mutates |
|---|---|---|
| Column separator (vertical line between two columns) | drag left/right | the left-side column's `width` (clamped 20–60) |
| Boundary inside any column | drag up/down | the two adjacent panes' own `heightPct` (detail's clamps to 20–90); addressed per-pane, so a same-kind sibling in the column is unaffected |
| **Corner** — col-separator × any panel boundary | drag diagonally | both axes in one gesture (the corner falls back to the OTHER flanking column's panel boundary when the cursor's column has none at that y) |

All drag gestures use ±1 cell tolerance so you don't have to land
the cursor exactly on the seam. D1 semantics (steal from neighbor
only): when you drag a boundary, the column's other panels keep
their current heights — they get frozen as `heightPct` on press if
they were previously flex, so the seam follows the cursor instead
of being smeared across the column.

### Resizing — keyboard

| Key | Mutates |
|---|---|
| `+` / `-` on detail panel focus | the focused detail pane's own `heightPct` ±5 (clamped 20–90) |
| `+` / `-` on a non-last-column panel focus | that panel's column's `width` ±2 |
| `]` / `[` on any non-detail panel | focused panel's `heightPct` ±5 (steals from the panel below; no-op at last position) |
| `u` / `Ctrl+R` | undo / redo any layout mutation (max 50 in stack) |

`+`/`-` keeps its current bindings so existing muscle memory works.
`]`/`[` are the new ones for per-panel height — they mirror the
within-column boundary drag from the keyboard.

### Hide / show — cmdline (no overlay needed)

`:hide <id>` and `:show <id>` directly mutate the pool↔grid mapping
from the command line. Same Msgs the overlay drives:

| Verb | Effect |
|---|---|
| `:hide <id>` | Remove that panel's placement from the grid; pool entry stays. Refused on a detail pane only when it's the sole remaining viewer. |
| `:show <id>` | Append a hidden pool entry at the last column's tail (a second detail is allowed since v0.6.4 multi-viewer). Refused on unknown / already-placed / second-actions. Column caps are SOFT — placement is allowed past them. |
| `:add-column [N]` (v0.6.2) | Insert an empty column at 1-based position `N` (default: just before the last column). Refused at the right-edge slot and out-of-range. |
| `:remove-column <N>` (v0.6.2) | Remove the empty column at 1-based index `N`. Refused for the last column, non-empty columns, and out-of-range. |

Autocomplete restricts the id argument to currently-valid targets
(placed panels for hide; hidden panels for show). The dynamic
registration in `panel/commands.js#_frameworkDynamicCommands`
(reached via `panel/api.js#getCommands` → `commands.collectCommands`)
regenerates the verb list every cmdline open.

## Context-sensitive detail (Info tab)

| Focused panel | Detail shows |
|---------------|-------------|
| Containers | Container name + cached status |
| Groups | Compose file, container list, action list with type indicators |
| Config Files | File description, var linkage, exclude patterns |
| Actions | Description, type/args/confirm metadata, script preview |

## Implementation

Node.js TUI with zero npm dependencies. Component system for extensibility.

```
config.yml → parser → in-mem config → tui.js (Node.js) → terminal
                                         ↓
                                  components/<name>.js
```

For module-level architecture, read the source under `js/`
(every file is small and self-describing). For Component authoring,
see PLUGINS.md.

### Themes

Set via YAML `theme:` field. Built-in: monokai (default), dracula,
solarized, gruvbox, nord, minimal. Themes control border colors,
selection style, status indicators, and footer.
