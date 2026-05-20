# lazytui — Core Principles

Rules for the YAML config and the TUI renderer. Read this before
adding features or modifying either layer.

## 1. YAML defines, TUI renders

The YAML config is the source of truth. It defines what exists, what
it's called, what it does, and how it behaves. The TUI is a generic
renderer and executor — it should never contain domain knowledge.

**Test**: if you delete the TUI and write a new one from scratch, does
the YAML still fully describe the application? If yes, the separation
is correct.

Bad:
```python
# TUI knows what "inspect" means for a container
def _show_container_details(self):
    cmd = f"docker inspect -f '{{{{.State}}}}' {name}"
```

Good:
```yaml
# YAML defines what to run
inspect:
  type: inspect
  script: "docker inspect -f '{{.State}}' {name}"
```
```python
# TUI just executes whatever the YAML said
def _show_info(self, item):
    lines = item.info()
    self._set_output(formatted(lines))
```

## 2. Uniform schema, differentiated by `type`

Every action has the same fields. The `type` field is the only thing
that controls behavior. Don't add new top-level concepts — extend
`type` instead.

```yaml
# Every action, regardless of type, has the same shape:
action_key:
  label: "..."                    # display name (required)
  type: run|spawn|background|...  # execution mode (default: run)
  cmd: "..."                      # simple command
  script: |                       # or multi-line script (with var/helper resolution)
    ...
  desc: "..."                     # description shown in output panel
  confirm: "..."                  # optional confirmation prompt
  args: "..."                     # optional argument hint
```

Adding a new behavior = adding a new `type` value + one handler in
the TUI. No new fields, no new YAML structure, no new parser logic.

## 3. Data models describe themselves

Each dataclass has an `info() -> list[str]` method that returns
plain-text lines for the output panel. The TUI calls `_show_info(item)`
generically — first line bold, rest plain, all escaped for Rich.

The TUI never inspects dataclass fields to build display strings.
If the output needs to change, change `info()` in the dataclass, not
the TUI.

```python
# In parser/runnable.py — the model knows its own details
@dataclass
class ConfigFile:
    path: str
    var: str | None = None
    desc: str | None = None

    def info(self) -> list[str]:
        lines = [self.path]
        if self.desc:
            lines.extend(["", self.desc])
        if self.var:
            lines.append(f"var: ${self.var}")
        return lines

# In tui.py — the TUI knows nothing about ConfigFile fields
def _show_info(self, item):
    lines = item.info()
    formatted = [f"[bold]{_esc(lines[0])}[/]"] + [_esc(l) for l in lines[1:]]
    self._set_output("\n".join(formatted))
```

## 4. YAML order = display order

The order of groups in YAML is the order in panel 2. The order of
actions within a group is the order in panel 0. No sorting, no
priority fields. The YAML author controls layout by ordering entries.

## 5. TUI is a framework, not an application

The TUI provides:
- Panel rendering with borders, focus, scroll
- Keyboard navigation between panels
- Action execution by `type`
- Output display via `info()` or command result

The TUI does NOT provide:
- Knowledge of what containers are or what Docker is
- Knowledge of what any specific action does
- Business logic for any service or workflow
- Hardcoded commands, paths, or service names

## 6. Extend `type`, don't add concepts

When you need new behavior, ask: "can this be a new action `type`?"

| Need | Wrong approach | Right approach |
|------|---------------|----------------|
| Show container details | Add `inspect` field to group | Add `type: inspect` action |
| Stream logs | Add `output: stream` field | Add `type: stream` |
| Run per-container | Add `container_action` field | `type: inspect` with `{name}` template |
| Preview action | Add `preview` field | Add `desc` (same schema, always available) |

## 7. Escape `[` in all markup text

The panel renderer uses Rich-style markup (`[bold]`, `[green]`, etc.)
converted to ANSI escape sequences. Any literal `[` that reaches the
renderer will be misinterpreted as a markup tag — silently vanishing
and breaking `visibleLen()` width calculation, misaligning borders.

**Rule: every string with literal `[` must be escaped.**

- **Dynamic text** (user data, command output, YAML values): use `esc()`
  ```javascript
  setDetail(`[bold]${esc(action.label)}[/]\n${esc(text)}`);
  ```
- **Static strings** with intentional markup: write `\[`
  ```javascript
  `  \\[1] Containers  Status of containers in selected group`
  ```

`esc()` replaces `[` → `\[`. Defined in `js/ansi.js`.

## 8. Selected lines: plain text in `[reverse]`, no inner markup

Selected/highlighted lines use `[reverse]` with NO closing `[/]` —
the panel renderer's padding spaces extend the highlight to fill
the full line width. A `[/]` reset before the right border stops
the bleed.

**Rule: no `[/]`, `[dim]`, `[green]`, or any markup inside a
`[reverse]` line.** Any `[/]` (ANSI reset) kills the reverse.

```javascript
// WRONG — [green]●[/] resets the reverse mid-line
return `[reverse] [green]●[/] ${name}`;

// RIGHT — plain text only, colors on unselected items
if (selected) return `[reverse] ● ${esc(name)}`;
return ` [green]●[/] ${esc(name)}`;
```

## 9. Plugins read state, they don't hold it

A plugin's YAML config carries plugin-specific *parameters* — values that
configure how the plugin operates (branch name, output dir, refresh
interval, image list). It does NOT carry the user's *domain data* — the
paths, image refs, container names, or other facts that already live in
the project's top-level state.

When a plugin needs to act on state that already exists at the top level
(e.g., `files:`, `vars:`), the plugin should **reference** that state,
not duplicate it.

**Test**: if a path, name, or other user fact appears in two places in
the project YAML — once at the top level and once inside a plugin's
config block — one of them is wrong. The duplicate inevitably drifts; a
fix in one place is forgotten in the other.

Bad — `config_branch:` redeclaring the path list:
```yaml
files:
  - { path: client, category: secret }
  - { path: data/cliproxyapi, category: secret, exclude: [data/cliproxyapi/logs/] }

groups:
  config:
    children:
      branch:
        config_branch:
          branch: config
          paths: [client, data/cliproxyapi]      # ← duplicates files
          excludes: [data/cliproxyapi/logs]      # ← duplicates per-file exclude
```

Good — `config_branch:` references `files:`:
```yaml
files:
  - { path: client, category: secret }
  - { path: data/cliproxyapi, category: secret, exclude: [data/cliproxyapi/logs/] }

groups:
  config:
    children:
      branch:
        config_branch:
          branch: config              # plugin parameter — fine
          source: files               # explicit reference
          categories: [secret, config]
```

The plugin code mirrors the rule: hooks receive the full config
(`groupActions(group, name, config)`), so a plugin can read top-level
state without snapshotting it. The plugin is a pure function; user state
is its input, not its possession.

When a plugin must accept the same data both ways (legacy explicit list
*or* reference), expose `source:` as one alternative and validate at
parse time that exactly one of them is set. Never silently fall back —
explicit refusal beats a surprising default.

See **PLUGINS.md** § "State references" for the worked
`resolveFromSource` pattern used by `config-branch.js`.

## 10. Layout framework

The TUI is a **lazytui** framework — a reusable two-column layout for
lazygit/lazydocker-style projects. The layout pattern is fixed; the
content is YAML-configurable.

- **Fixed**: two columns, bordered panels with scrollbars, navigation
  (hotkeys, ↑↓ j/k, ←→ h/l, mouse, `x` menu, `?` help), detail panel
  tabs (`]`/`[`), view modes (`+`/`_`), themes, design mode (`--design`),
  action execution.
- **Configurable**: panels, panel types, sizes, theme, layout — via the
  YAML `layout:` section.
- **Constraints**: 1–6 left panels (hotkeys `1`–`6` auto-assigned by
  position), 1–3 right panels (hotkeys `7`–`9` auto-assigned by
  position); exactly one `detail` panel; at most one `actions` panel.
  YAML can override per-panel via `hotkey: <char>` — auto-assignment
  skips keys claimed explicitly.

See **LAYOUT.md** for the full panel-type catalog, YAML schema, and
visual concept. See **PLUGINS.md** for how plugins contribute panel types.

## 11. Render is idempotent on equal state

A plugin's `render(panel, width, height, S)` called twice with the
same inputs produces the same output, and the second call observably
does not change anything that would alter a third call. Same for
`render()` at the layout level — calling it back-to-back is a no-op
beyond writing pixels.

This is **weaker than "render is pure"** (no mutation, no I/O).
lazytui admits two intentional impurities the idempotence rule
still permits:

- **Layout calculation** writes derived state — `S.panelHeights`,
  `S.panelBounds`, and `S.scroll` keep-in-view adjustments — into
  `S` during `calcLayout()`. These are *outputs* of the layout pass,
  consumed by mouse/input handlers between frames; plugin renderers
  read them, don't write them.
- **Lazy hub subscriptions** (stats panel,
  `js/plugins/core/stats.js#_ensureSub`) and **lazy initial-state
  fixup** (config-status panel) happen on first render and are
  idempotent on subsequent calls. Pure-render would prefer these
  in an `init` hook, but the current plugin API has none — the
  idempotent lazy-init pattern is an accepted middle ground.

**Why the rule matters:**

- **Replay tests.** If render output is a function of state alone,
  a stored state snapshot replays to a known string. The
  TEA-inspired event log (planned for v0.2.x) needs this guarantee.
- **Snapshot tests.** Same-state-twice can be asserted in unit
  tests without elaborate setup. `js/test/test-render-idempotent.js`
  is the canonical example.
- **Diff repaint.** `layout.js#paintColumns()` writes only the rows
  that changed since the previous frame. If render were
  non-idempotent the diff cache would silently desync — the user
  sees stale pixels.

**Rule for new plugin renders:** read `S`, return a string. If you
need a side effect on first render, make it idempotent and add a
comment explaining the lazy-init pattern (see `stats.js#_ensureSub`
for the canonical example).

## 12. Checklist for new features

Before implementing, verify:

- [ ] Is the behavior defined in YAML, not hardcoded in TUI?
- [ ] Does it use the existing action schema (same fields)?
- [ ] If new behavior, is it a new `type` value (not a new field)?
- [ ] Does the dataclass have `info()` for output panel display?
- [ ] Does display order come from YAML order?
- [ ] Can you delete the TUI and rebuild it from the YAML alone?
- [ ] Is every dynamic string passed through `esc()` before markup?
- [ ] Do static strings with literal `[` use `\[`?
- [ ] Do selected lines use plain text in `[reverse]` with no inner markup?
- [ ] Is the `[reverse]` left unclosed (panel renderer adds reset before border)?
- [ ] Does the plugin reference top-level state (`source: files`, top-level vars) rather than redeclaring it inside its own config block?
- [ ] Is each plugin's `render()` idempotent on equal state? (§11)
