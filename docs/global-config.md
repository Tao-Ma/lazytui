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
- **Scalars** (`theme`, `selection`, `editor`) are wholesale — a project
  value wins; absent, the global value applies.

The merge happens on the raw YAML inside `parse()` (before validation and
defaulting), so the merged result validates uniformly and `theme:` /
`selection:` defaults apply after the layer — and it happens BEFORE the
`set_config` Msg, so a recording carries the merged config and replay never
re-reads the file. `--keymap` dumps the effective (merged) bindings.

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
project `editor:` → global `editor:` → `$VISUAL` → `$EDITOR` → `vi`. The
edit affordances that consume it (files-pane `e`, `:edit`, `:config`) ride
the embedded-PTY spawn seam; config edits apply on the next boot (no live
reload — deliberate, see the 2026-08-02 decision in the CHANGELOG arc).

## Tests

`js/test/test-global-config.js` — path resolution, the tolerant-load
contract, the merge rules, the parse()/loadConfig end-to-end layer, and the
`selection:` pass-through fix that rode along with this arc.
