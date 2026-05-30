# lazytui Layout Design

## Layout framework

The TUI is a **lazytui** framework — a reusable two-column layout. The
layout pattern is fixed; the panel content is YAML-configurable.

### Pattern (fixed)
- Two columns: left (narrow, default 30 chars), right (wide, rest)
- Bordered panels with scrollbar, focus color, position counter
- Detail panel with tabs, scroll
- Footer bar, `x` menu popup, `?` help

### Configuration (YAML `layout:` section, optional)
```yaml
layout:
  left:
    width: 30                # optional, column width in chars
    panels:
      - type: containers
        title: Containers
        heightPct: 30        # optional, panel height as % of column
      - type: groups
        title: Groups
        heightPct: 70
      - type: file-manager
        title: Files
  right:
    panels:
      - type: actions
        title: Actions
      - type: detail
        title: Detail
        height: 60%          # optional, layout-level detailHeightPct
```

Default layout generated when `layout:` is omitted.

**Per-panel height — `heightPct`.** Optional integer 1–100. Panels
that set it are *anchored*; panels that don't are *flex* and share
whatever's left in their column equally. Detail keeps its layout-
level `height: N%` knob (becomes `detailHeightPct`). When anchored
values + reserved (detail) leave less than 3 rows per flex panel,
anchored values scale proportionally so every panel still meets the
minimum.

YAMLs without `heightPct` behave as before (equal-share within the
column). The drag UX (below) materializes `heightPct` for any panel
the user resizes — once the layout is saved via `:save-layout`, the
new values appear in the YAML.

### Panel constraints
- Left: 1–6 panels, hotkeys `1`–`6` auto-assigned by position
- Right: 1–3 panels, hotkeys `7`–`9` auto-assigned by position
- Per-panel override via YAML `hotkey: <char>`; auto-assignment skips
  keys already claimed explicitly
- Detail panel required in right column

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

**file-manager** — File registry paths from the top-level `files:` section
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
- **Tab 0 (Info)**: always present — shows `info()` for selected item
- **Tab 1+**: actions with `tab: true` — runs action, shows result
- `]`/`[` cycles between tabs
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

Actions with `tab: true` appear as detail tabs alongside the implicit Info tab.
`]`/`[` cycles between them. Tab actions execute silently (bypass confirm/args,
don't mark as last-run). Navigating items on a non-info tab keeps the tab
output; switch to Info tab to see item details.

```yaml
actions:
  status:
    cmd: docker compose ps
    label: Status
    tab: true          # appears in detail panel tabs
  ssh:
    type: spawn
    label: SSH         # no tab — spawn opens a terminal
```

## Terminal tabs

Groups can define `terminals:` — interactive PTY sessions embedded as
detail panel tabs. Tab order: Info → action tabs → terminal tabs.

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

**Normal** (default) — standard two-column layout with all panels visible.

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

## Resizing panels (design mode)

Design mode (`--design` flag or `:design`) is where layout gets
mutated interactively. Saves are explicit: `:save-layout` writes
to YAML, `:restore-layout` reloads from disk.

### Drag — mouse

Every seam between panels is a drag target:

| Press on | Gesture | Mutates |
|---|---|---|
| Column separator (the vertical line) | drag left/right | `leftWidth` (clamped 20–60) |
| Boundary inside the right column | drag up/down | the two adjacent panels' `heightPct` (or `detailHeightPct` when detail is one of the pair, clamped 20–90) |
| Boundary inside the left column | drag up/down | the two adjacent panels' `heightPct` |
| **Corner** — col-separator × any boundary | drag diagonally | both axes in one gesture |

All drag gestures use ±1 cell tolerance so you don't have to land
the cursor exactly on the seam. D1 semantics (steal from neighbor
only): when you drag a boundary, the column's other panels keep
their current heights — they get frozen as `heightPct` on press if
they were previously flex, so the seam follows the cursor instead
of being smeared across the column.

### Keyboard

| Key | Mutates |
|---|---|
| `+` / `-` on detail panel focus | `detailHeightPct` ±5 |
| `+` / `-` on left-column panel focus | `leftWidth` ±2 |
| `]` / `[` on any non-detail panel | focused panel's `heightPct` ±5 (steals from the panel below; no-op at last position) |
| `u` / `Ctrl+R` | undo / redo any layout mutation (max 50 in stack) |

`+`/`-` keeps its current bindings so existing muscle memory works.
`]`/`[` are the new ones for per-panel height — they mirror the
within-column boundary drag from the keyboard.

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
