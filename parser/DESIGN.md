# TUI Parser — Design Document

## Overview

A YAML-to-runnable-object compiler for the lazytui framework. Validates config,
resolves variables and helpers, builds layout, and produces execution-ready
objects consumed by both the interactive TUI and command-line mode.

## Pipeline

```
config.yml (human writes)
    ↓
Parser/Validator
    ├── 1. Schema check — structure, required fields, types, unknown keys
    ├── 2. Variable resolution — $VAR / ${VAR} → concrete values
    ├── 3. Helper expansion — @use name → inline script
    ├── 4. Layout — parse or generate default panel layout
    └── 5. Output: ParsedConfig with groups, actions, layout, files
    ↓
TUI (interactive) or CLI (direct execution)
```

## YAML Schema

### Top-level sections

```yaml
project_dir: .                     # optional, default "."

vars:
  KEY_FILE: client/id_ed25519
  CHROME: "$HOME/Applications/Google Chrome.app/..."

helpers:
  init_ssh: |
    if [ -f "$KEY_FILE" ]; then echo "exists"; fi

files:
  - path: client/id_ed25519
    var: KEY_FILE
    desc: SSH private key for dev9 access
  - path: data/cliproxyapi/
    desc: OAuth tokens
    exclude: [logs/, static/]

layout:                            # optional, defaults generated
  left:
    width: 30
    panels:
      - type: containers
        title: Containers
      - type: groups
        title: Groups
      - type: file-manager
        title: Config Files
  right:
    panels:
      - type: actions
        title: Actions
      - type: detail
        title: Detail
        height: 60%

groups:
  dev9-core:
    label: Core Services
    compose: docker-compose.yml
    containers: [dev9-env, dev9-openvpn]
    actions:
      status:
        cmd: docker compose ps
        label: Status
        desc: Show running state of all containers
        tab: true
      ssh:
        label: SSH
        type: spawn
        desc: Open SSH session
        script: |
          ssh -i "$KEY_FILE" -p 2222 root@localhost
```

### Action fields

All actions have the same schema. The `type` field controls behavior.

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `label` | yes | string | Display name in TUI and CLI |
| `cmd` | one of cmd/script | string | Simple command (no resolution) |
| `script` | one of cmd/script | string | Multi-line script (var/helper resolution) |
| `type` | no | string | `run` (default), `spawn`, `background` |
| `desc` | no | string | Description shown in detail panel on browse |
| `confirm` | no | string | Confirmation prompt before execution |
| `args` | no | string | Argument hint (e.g. `client-name`, `[name]`) |
| `tab` | no | boolean | Show as detail panel tab (default: false) |

### Layout section

Optional. When omitted, a default layout is generated based on the config
content (containers panel only if any group has containers, file-manager
panel only if files section exists).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `left.width` | int | 30 | Left column width in characters |
| `left.panels` | list | auto | Left column panels (1–6) |
| `right.panels` | list | auto | Right column panels (1–3) |
| `panels[].type` | string | required | Panel type: containers, groups, file-manager, actions, detail |
| `panels[].title` | string | from type | Display title |
| `detail.height` | int/string | 60% | Detail panel height percent |

Hotkeys auto-assigned: left panels `1`–`6` by position, actions `0`, detail `o`.

## Dataclasses

All selectable dataclasses have `info() -> list[str]` for the detail panel.
The TUI renders these generically — first line bold, `key: value` with dim
keys, indented lines as-is.

```python
@dataclass
class ParsedConfig:
    project_dir: str
    groups: dict[str, GroupConfig]
    source_file: str
    files: list[ConfigFile]
    layout: LayoutConfig
    theme: str                  # "monokai", "dracula", etc.

@dataclass
class LayoutConfig:
    left_width: int
    left_panels: list[PanelConfig]
    right_panels: list[PanelConfig]
    detail_height_pct: int
    # Properties: all_panels, panel_order

@dataclass
class PanelConfig:
    type: str       # "containers", "groups", "file-manager", "actions", "detail"
    title: str
    hotkey: str     # "1"-"6", "0", "o"
    column: str     # "left" or "right"

@dataclass
class GroupConfig:
    name: str
    label: str
    compose: str | None
    containers: list[str]
    actions: dict[str, RunnableAction]
    def info(self) -> list[str]: ...

@dataclass
class RunnableAction:
    group: str
    key: str
    label: str
    type: str               # "run" | "spawn" | "background"
    confirm: str | None
    args: str | None
    desc: str | None
    tab: bool
    script: str
    containers: list[str]
    debug: DebugInfo
    def info(self) -> list[str]: ...

@dataclass
class ConfigFile:
    path: str
    var: str | None
    desc: str | None
    exclude: list[str]
    def info(self) -> list[str]: ...

@dataclass
class DebugInfo:
    source_file: str
    action_line: int
    vars_used: dict
    helpers_used: list[str]
    resolved_script: str
```

## Module Structure

```
parser/
  __init__.py       — public API: parse(yaml_path) → ParsedConfig
                      default layout generation, layout parsing
  schema.py         — YAML schema validation (strict unknown-key rejection)
  resolver.py       — $VAR substitution + @use helper expansion
  runnable.py       — dataclass definitions + info() methods
  errors.py         — ParseError → SchemaError, ResolutionError
```

## Resolution Rules

- **Variables**: only vars defined in `vars:` block are substituted. Unknown `$FOO` is left as-is (shell builtins like `$HOME`, `$1`).
- **Helpers**: `@use name` must appear on its own line. Helpers expanded first, then variables resolved.
- **cmd: actions**: no resolution, script = cmd value verbatim.
- **script: actions**: full resolution (helpers + vars).
- **config_copy_to**: auto-generated helper from `files` section.

## Architecture

```
lazytui/
  js/                 — TUI (Node.js, zero npm dependencies)
    tui.js            — entry point, lifecycle
    state.js          — config, layout, generic per-panel state
    term.js           — terminal helpers
    layout.js         — layout calc, view modes, render
    renderers.js      — core panel renderers + plugin delegation
    detail.js         — detail panel, info display, tabs
    actions.js        — action execution (run/spawn/background)
    keys.js           — key dispatch, mouse click handling
    menu.js           — x menu popup overlay
    design.js         — --design mode layout editor
    panel.js          — bordered panel renderer
    scrollbar.js      — scrollbar math
    ansi.js           — Rich markup → ANSI converter
    themes.js         — 5 built-in color themes
    plugins/
      api.js          — plugin loader, registry
      docker.js       — container status + containers panel
  parser/             — YAML→JSON bridge (Python)
    __init__.py       — parse(yaml_path) → ParsedConfig
    schema.py         — YAML schema validation
    resolver.py       — $VAR substitution + @use helper expansion
    runnable.py       — dataclass definitions + info() methods
    errors.py         — ParseError → SchemaError, ResolutionError
  tests/              — 124 parser tests (Python)
```

The JS TUI calls the Python parser to convert YAML to JSON:
```
config.yml → parser (Python) → JSON → tui.js (Node.js) → terminal
                                         ↓
                                    plugins/docker.js
```

## Execution

```
node js/tui.js config.yml            → interactive TUI (Node.js)
node js/tui.js --design config.yml   → with layout editor
```

## Top-level YAML keys

| Key | Type | Description |
|-----|------|-------------|
| `project_dir` | string | Working directory (default `.`) |
| `vars` | dict | Variable definitions for script resolution |
| `helpers` | dict | Reusable script snippets (`@use name`) |
| `files` | list | File registry — paths for save/load |
| `layout` | dict | Panel layout (optional, defaults generated) |
| `theme` | string | Color theme (default `monokai`) |
| `plugins` | dict | Plugin configuration |
| `groups` | dict | Service groups with actions |
