# Global user config

App-behavior preferences that follow the USER across projects, layered under
every project's config at boot.

## Location

`~/.config/lazytui/config.yml` — honoring `$XDG_CONFIG_HOME` when set
(`$XDG_CONFIG_HOME/lazytui/config.yml`). `LAZYTUI_GLOBAL_CONFIG` overrides
the path outright; the empty string disables the lookup entirely (the test
harness sets this so runs stay hermetic).

## What may live there

Only the app-behavior sections are honored (`parser/schema.js
GLOBAL_TOP_KEYS`):

```yaml
theme: nord                 # wholesale — a project theme: wins
selection: true             # wholesale — global text-selection default
editor: nvim                # wholesale — see §editor below
color_depth: auto           # wholesale — auto | truecolor | 256 | 16 (see below)
keys:                       # entry-level merge — per key-sequence
  "<space>g": { command: "grep TODO" }
keymap:                     # entry-level merge on normal:, version project-wins
  normal: { G: cursor_bottom }
mouse:                      # entry-level merge — per gesture
  right-click: context
context-menu:               # list — global entries first, project's appended
  - { label: "My Refresh", builtin: refresh }
```

Project content (`groups`, `layout`, `vars`, `helpers`, `files`, `plugins`,
`panels`, `register`, `project_dir`) belongs to the per-project config; any
such key in the global file warns (`global.ignored_key` in the boot ⚠
diagnostics) and is ignored.

## Merge rules

The global file layers UNDER the project config:

- **Keyed sections** (`keys`, `keymap.normal`, `mouse`) merge at the ENTRY
  level — a global binding applies everywhere unless the project rebinds
  that same key/gesture.
- **`context-menu`** is a list: global entries first, project entries after.
- **Scalars** (`theme`, `selection`, `editor`, `color_depth`) are wholesale —
  a project value wins; absent, the global value applies. For `color_depth`,
  a project `auto` ALSO counts as absent: `auto` means "detect from the
  environment", i.e. no override opinion, so an explicit global depth
  applies under it.

### color_depth

Render color depth (truecolor arc, docs/truecolor.md P3). The pipeline is
canonically truecolor; this key overrides the DEVICE adaptation applied at
the write boundary. `auto` (the default) detects from the environment:
`LAZYTUI_COLOR` env override → `COLORTERM=truecolor|24bit` → `TERM`
(`*direct*`/`*truecolor*` → truecolor, `*256color*` → 256, else 16). Set an
explicit `truecolor`/`256`/`16` only when detection gets your terminal
wrong (e.g. tmux without the RGB capability advertising a truecolor-less
TERM). Depth never changes the frame — only the emitted bytes.

The merge happens inside `parse()`: the project config validates STANDALONE
first (its errors surface unchanged, global file or not), the pre-validated
global sections then layer in before the output assembly, so `theme:` /
`selection:` defaulting applies to the merged result. It all happens BEFORE
the `set_config` Msg, so a recording carries the merged config and replay
never re-reads the file. `--keymap` dumps the effective (merged) bindings.

## JSON configs

A `.json` config is the parser's RESOLVED output shape, so it always carries
explicit `theme`/`selection` values — the global scalars can't apply there
(nothing is "absent"); `editor: null` counts as unset, so a global `editor:`
still lands. The keyed sections (`keys`, `keymap`, `mouse`, `context-menu`)
layer exactly as they do for YAML.

## Failure contract

A global file must never brick a project:

- missing file / empty file — silently fine;
- unreadable or invalid YAML — `global.unreadable` warning, project-only;
- a malformed HONORED section (e.g. `editor: 42`) — `global.invalid`
  warning, project-only;
- unknown/project keys — per-key `global.ignored_key` warning, key dropped.

All warnings ride the normal boot-diagnostics path (`config.warnings` →
event log + the footer's ⚠ notice + `<leader> e`).

## editor

`editor:` names the command that opens files for editing (a program name or
path, optionally with arguments — `nvim`, `code --wait`). Resolution chain:
project `editor:` → global `editor:` → `$VISUAL` → `$EDITOR` → `vi`.

The edit affordances that consume it ride the embedded-PTY spawn seam
(`dispatch/runtime/edit.js` — mint a terminal tab, auto-zoom, return on
quit; exit-0 auto-closes the tab):

- **`e`** on a files-pane row (host files only — a docker-sourced row has
  no local path to hand an editor);
- **`:edit <path>`** (host-path TAB completion, resolved against
  `project_dir`);
- **`:config`** — the project config; **`:config global`** — this file,
  created with a commented skeleton on first use.

On a clean editor exit, a serializable `onExit` continuation on the minted
tab refreshes an open doc tab showing that file (gated — it never opens
one) and, after a config edit, prints "changes apply on the next lazytui
start" on the Transcript. No live reload — deliberate (2026-08-02): a
mid-session re-parse conflicts with every piece of state derived from the
boot config. Under tmux the editor opens in a `tmux new-window` lazytui
doesn't own; the continuation doesn't fire there.

## Tests

`js/test/test-global-config.js` — path resolution, the tolerant-load
contract, the merge rules, the parse()/loadConfig end-to-end layer, and the
`selection:` pass-through fix that rode along with this arc.
