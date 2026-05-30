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

A panel's `render(panel, width, height, state)` called twice with the
same inputs produces the same output, and the second call observably
does not change anything that would alter a third call. (`state` is the
root model for a Plugin, or the Component's slice for a Component.) Same
for `render()` at the layout level — calling it back-to-back is a no-op
beyond writing pixels.

This is **weaker than "render is pure"** (no mutation, no I/O).
lazytui admits two intentional impurities the idempotence rule
still permits:

- **Layout calculation** writes derived state — `model.panelHeights`,
  `model.panelBounds`, and `model.ui.scroll` keep-in-view adjustments —
  during `calcLayout()`. These are *outputs* of the layout pass,
  consumed by mouse/input handlers between frames; panel renderers
  read them, don't write them. (Blessed outside-writer; see
  `docs/v0.5-layering.md`.)
- **Lazy hub subscriptions** (stats panel,
  `js/plugins/core/stats.js#_ensureSub`) and **lazy initial-state
  fixup** (config-status panel) happen on first render and are
  idempotent on subsequent calls. Pure-render would prefer these
  in an `init` hook, but the current Plugin API has none — the
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

**Rule for new panel renders:** read the model (Plugin) or the slice
(Component), return a string. If you need a side effect on first
render, make it idempotent and add a comment explaining the lazy-init
pattern (see `stats.js#_ensureSub` for the canonical example).

## 12. Two plugin APIs — Plugin (simple) and Component (strict)

Lazytui has two panel shapes. Both are legitimate TEA — they differ in
*where state lives*, and the choice is a structural decision, not author
taste. **In-tree, every built-in panel is a Component** (9/9 after v0.5
Phase C). The **Plugin** API is preserved as the simpler shape for
**external / user-authored** plugins where a slice + `update` is more
ceremony than the panel needs.

**`Plugin`** — the simple shape. A stateless renderer over the root
model, plus an optional `onKey` that emits the standard verbs (or claims
the key by returning `true`). It owns no slice; per-panel chrome
(cursor / scroll / filter / multi-sel) lives on the root model and is
read via `getSel` / `getScroll` / `isMultiSel`.

```js
module.exports = {
  name: 'history',
  panelTypes: {
    history: {
      render:  (panel, w, h, model) => { /* reads model + a module ring buffer */ },
      getItems: (model) => historyEntries(),
      onKey:   (key, item) => { /* e.g. replay into the detail panel */ },
    },
  },
};
// register with: api.registerPlugin(plugin)
```

**`Component`** — the TEA shape. The framework owns a state slice per
Component. Messages arrive through `update(msg, slice)`, which returns
either the next slice OR `[nextSlice, effects]`. Effects are plain data
descriptors (`{ type, … }`) the effects layer runs: async work, a
viewer write, a repaint, a recurring `tick`, an `apply_msg` re-dispatch
to the root reducer. An effect's async result feeds back as a Msg
(`dispatchMsg`). Render receives the slice, not the root model. No
`onKey` — key events arrive as `{ type:'key' }` Msgs (only to the
focused Component, only when no modal owns input).

```js
module.exports = {
  name: 'mycomp',
  init: () => ({ items: [], selected: null, loading: false }),
  update: (msg, slice) => {
    switch (msg.type) {
      case 'key':
        if (msg.key === 'down') return { ...slice, selected: nextItem(slice) };
        return slice;
      // Async work is an EFFECT, never done inline (keep update pure):
      case 'refresh':      return [{ ...slice, loading: true }, [{ type: 'fetchItems' }]];
      case 'itemsLoaded':  return [{ ...slice, items: msg.items, loading: false }, [{ type: 'render' }]];
      case 'hub':          return { ...slice, last: msg.sample };
      default:             return slice;
    }
  },
  panelTypes: {
    mycomp: {
      render: (panel, w, h, slice) => { /* reads slice */ },
      claimsKeys: ['return'],  // suppress the framework default for keys update handles
    },
  },
};
// register with: api.registerComponent(component); register the fetchItems effect
// with api.registerEffect('fetchItems', fn) — fn does the async work + dispatchMsg.
```

### Rules

- A Component **may read** the root model via `require('./runtime').getModel()`
  (focus, currentGroup, mode flags — anything app-global) but **never writes**
  it. The Component's own slice is the only thing its `update` writes
  directly. Cross-layer writes go out as effects — `apply_msg` re-dispatches
  through the root reducer, `dispatch_msg` re-dispatches to another
  Component. The framework runs them, so single-writer per layer holds.
- **Msg routing.** `refresh` / `hub` / `action` fan to every Component's
  `update`. **Key Msgs go ONLY to the Component owning the focused panel, and
  ONLY when no modal mode is active** — a modal (filter / menu / cmdline / …)
  owns input, so the focused panel must not also see the key. A panel declares
  `claimsKeys: [...]` to suppress the framework's *default* for keys it handles
  in `update` (e.g. files claims `return`; config-status claims `] [ return`).
- **Effects stay out of `update`** — return `[slice, effects]`, never perform
  I/O inline (keeps `update` pure + replayable). The framework runs effects;
  an effect's async result re-enters as a Msg.
- **Periodic work is self-driven.** There is no Plugin-style poll loop for
  Components — a Component drives its own cadence by re-emitting a `tick`
  effect from its tick-Msg handler (docker polls this way — the
  self-re-arming-tick Cmd pattern).
- An `update()` returning `undefined` leaves the slice unchanged (no-op
  escape hatch).
- Components also contribute `commands` / `groupActions` / `statusFor` /
  `decorators` / `cleanup`, collected by the framework exactly like a Plugin's.
- Components and Plugins coexist in one panelType namespace; a Component-owned
  panel wins on collision (caught at registration as a warning).

### Why both?

Components carry real benefits — slice isolation, no cross-panel state
corruption, async folded through a single writer, replay — at the cost of
boilerplate. In-tree the choice landed on Components everywhere (v0.5 Phase
A→B→C; see `docs/v0.5-layering.md`). External plugins keep the Plugin shape
because a small custom panel — a list backed by a YAML field, a status
read-out — doesn't need a slice or an `update`. The single-writer rule
per layer is preserved either way: a Plugin doesn't write the model at all
(it's a renderer); a Component writes only its own slice and re-dispatches
across layers via effects.

### Two homes for state — and the "one API" question

Both shapes are legitimate TEA. They differ in *where* state lives:

- **Centralized** (the pure-Elm shape) — state in the root model
  (`model.modal.*`, `ui.sel`, `ui.scroll`, etc.), logic in the root reducer
  (`runtime.update`); the view is a function over it. The chrome cluster —
  per-panel cursor / scroll / filter / multi-sel — lives here.
- **Decentralized** (nested sub-models) — state in a per-Component slice,
  logic in the panel's own `update`. The slice is the Component's
  encapsulation boundary; cross-layer reads go through `getModel()`,
  cross-layer writes through effects.

In-tree every panel is a Component, so the *panel* surface is uniform; the
"two homes" still applies to **where each piece of state lives**:

> **Is this state messy + self-contained enough that isolating it in a
> Component slice (with its own effects) beats folding it into the shared
> root model?**

The genuine isolation wins go in slices: docker's polling loop + stats +
events subprocess; files' per-panel directory browsers; config-status'
git-worktree cache; the viewer's content tabs + ephemeral terminals; the
groups tree's `expanded` Set. Everything chrome-shaped (cursors, scroll,
filters, focus, mode flags, modal sub-models) lives in the root model where
the reducer can write it uniformly.

**Corollaries:**

- For an external Plugin, don't reach for a Component "for consistency." If
  the panel is a stateless view over data the framework already holds, a
  Plugin is shorter to write and just as correct.
- "Component" is not "better than" Plugin. It's a *different home* for
  state, chosen for isolation. Picking it for a panel with no slice-shaped
  state is pure boilerplate (the anti-pattern an early all-Components
  attempt hit; see `docs/v0.5-tea.md`).
- If you ever want *one* surface, that's a deliberate redesign (collapse
  to one pole), not a cleanup — see `docs/v0.5-tea.md`.

## 13. Checklist for new features

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
- [ ] Does the panel pick the right shape — Component if it owns slice-shaped state / fires async work, Plugin if it's a stateless view? (§12)
- [ ] If a Component: does `update()` return a new slice (or `[slice, effects]`) rather than mutate, keep effects/I-O out of `update`, and never write the root model directly? Does it `claimsKeys` for the keys it handles? (§12)
