# Plugin System Design

## Architecture

```
┌─ Core TUI ──────────────────────────────────────┐
│  Layout, keys, panel borders, themes             │
├─ Plugin API (require('./api')) ──────────────────┤
│  Registry:  registerPlugin, getCommands, getItems,│
│             selectedOrFocused, idOf, ...          │
│  Subsystems: hub, decorators                      │
│  Helpers:   esc, theme, renderPanel, getSel,      │
│             getFilter, execAsync, streamCommand,  │
│             addEphemeralTab, scheduleRender       │
│  Defaults:  :quit, :refresh, :help                │
├──────────────────────────────────────────────────┤
│  core      │  docker    │  (user plugins) │      │
│  plugin    │  plugin    │  .js or .yml    │      │
└────────────┴────────────┴─────────────────┴──────┘
```

Core TUI is a generic framework. Plugins provide data for panels.
Built-in panel types (groups, actions, file-manager, history, detail)
stay in core. Everything else comes from plugins.

### Plugin API surface

Plugin authors should import everything from `./api`. The facade
re-exports the helpers, read-state, and host capabilities a plugin
typically needs, so a plugin's import line is one statement:

```javascript
const {
  // ansi
  esc, visibleLen, stripMarkup,
  // themes
  theme,
  // panel
  renderPanel,
  // state (read helpers — plugins should not mutate S directly)
  getSel, getScroll, isMultiSel,
  // filter
  getFilter,
  // exec
  execAsync,
  // host capabilities
  streamCommand,         // run a shell command, stream stdout into detail
  addEphemeralTab,       // open a runtime PTY tab and switch to it
  scheduleRender,        // request a debounced redraw on async events
  // decorators
  decorate, decorators,  // shorthand fn + module
  // event hub (HUB.md)
  hub,
  // registry helpers
  getItems,              // canonical filtered list for a panel type
  selectedOrFocused,     // bulk-op operand resolver (multi or focused)
  idOf,                  // stable identity for an item in a panel
  registerPlugin,        // (rare in user plugins; mostly framework)
} = require('./api');
```

Direct imports from `../ansi`, `../panel`, etc. still work but are
not part of the contract — the facade in `plugins/api.js` is the
documented surface, and the only place a plugin API change shows up.

### Framework default `:` commands

Three commands are available without any plugin contribution:

| Command | Behavior |
|---------|----------|
| `:quit` | Exit the TUI cleanly |
| `:refresh` | Re-run `refreshAll` across all plugins |
| `:help` | Render per-context help into the detail panel |

These live in `plugins/api.js#FRAMEWORK_COMMANDS` (not in any plugin)
because they're framework actions, not panel-type behavior. They're
collected by `getCommands(S)` alongside plugin-contributed commands;
the `_plugin` field is `<framework>` for these entries.

## Plugin Interface

```javascript
// plugins/docker.js
module.exports = {
  name: 'docker',

  // Panel types this plugin provides
  panelTypes: {
    containers: {
      mode: 'list',                       // list | content | stream | tree | terminal | input
      render(panel, width, height, state) {}, // return Rich markup string
      getItems(state) {},                 // return RAW items (don't filter — framework filters centrally)
      getInfo(item) {},                   // return Rich-markup lines for detail
      onKey(key, item, state) {},         // optional: panel keys; `item` is
                                          // the focused list row, or null for
                                          // content/stream/tree/terminal panels
      copyOptions(item, state) {},        // optional: items for `y` copy menu
      keyHints: 'i inspect | t logs',     // optional: shown in footer
      filterable: true,                   // optional: enables `/` filter
      filterText: item => item.label,     // optional: which field the `/` filter matches (default: String(item))
    },

    // The framework applies the active filter centrally via api.getItems.
    // Renderers and event handlers MUST call api.getItems(panelType, S) to
    // get the canonical filtered list — never iterate panelDef.getItems
    // directly, or selection index can desync from the rendered list.
  },

  // Inject actions into groups (used by docker for compose lifecycle).
  // Returns { actionKey: { script, type, label, ... } }. YAML actions
  // override plugin actions on key conflict.
  //
  // Receives the full `config` so the plugin can read top-level state
  // (e.g., `config.files`, `config.vars`) instead of holding its own
  // copy. See PRINCIPLES.md § 9 and "State references" below.
  groupActions(group, groupName, config) {},

  // Background refresh (called every ~10s). MUST be async for any I/O —
  // sync I/O blocks the event loop and freezes the UI. Use execAsync
  // from `'./exec'` for shell commands. Return Promise<boolean> (changed).
  async refresh(config) {},

  // Plugin config defaults
  defaults: { refresh_interval: 10 },
};
```

### Async contract — DO NOT block the event loop

The TUI is a single Node.js process. Anything synchronous in a plugin
hook freezes the UI for the duration of the call: keys queue up, renders
freeze, terminal overlays stutter. The user perceives this as "stuck".

**Hooks that MUST be async** (run on a timer or in response to fast events):
- `refresh(config)` — runs every ~10s; should return `Promise<boolean>`
- `getItems(S)` if it does I/O (rare — most plugins have items in memory)
- `groupActions(group, name, config)` if it does I/O

**Hooks that MAY be sync** (user-initiated, brief):
- `render(panel, w, S)` — pure rendering, no I/O
- `onKey(key, item, S)` — user pressed a key, brief work OK; for streaming
  output use `streamCommand` from `actions.js` (already async). `item` is
  the focused row when the panel has `getItems`; otherwise `null`. Return
  `true` to claim the key (suppresses framework default), anything else to
  fall through.
- `getInfo(item)` — formatting cached data
- `copyOptions(item, S)` — return options; expensive `content` should be
  thunks `() => string` so they only run if user picks them

**Helper**: `execAsync(cmd, options)` (re-exported from `./api`)
returns a Promise of stdout. Captures partial output on non-zero exit.
Pass `timeout`, `cwd`, `env` in options. Never rejects — errors yield
empty string.

```javascript
const { execAsync } = require('./api');

async refresh(config) {
  const out = await execAsync('docker ps -q', { timeout: 5000 });
  // ... parse, update caches, return changed flag ...
  return changed;
}
```

`refreshAll` awaits each plugin sequentially, so a slow plugin only
slows itself, not others' subsequent ticks.

### State references — `source:` over redeclaration

PRINCIPLES.md § 9 lays out the rule: **plugins read state, they don't
hold it.** A plugin's YAML config block carries plugin parameters
(branch name, output dir, refresh interval). User domain data — paths,
image refs, container names — already lives at the top level (`files:`,
`vars:`, `containers:`). The plugin should reference that, not duplicate
it.

To honor this, plugins receive the full `config` in `groupActions(group,
name, config)`. When the user passes a `source:` reference into the
plugin's YAML block, the plugin resolves it against `config` at action-
synthesis time. The pattern, as in `config-branch.js`:

```javascript
function resolveFromSource(cfg, config) {
  if (cfg.source !== 'files') return null;          // sentinel only
  const files = (config && config.files) || [];
  const categories = Array.isArray(cfg.categories) ? cfg.categories : null;
  const paths = [];
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || !f.path) continue;
    if (categories && !categories.includes(f.category)) continue;
    paths.push(f.path);
  }
  return { paths };
}

function groupActions(group, _name, config) {
  const cfg = group.config_branch || {};
  if (!cfg.branch) return {};
  const fromSource = resolveFromSource(cfg, config);
  const paths = fromSource ? fromSource.paths : cfg.paths;
  if (!paths || !paths.length) return {};
  // ... synthesize actions using `paths` ...
}
```

YAML — explicit list (legacy or one-off):

```yaml
config_branch:
  branch: config
  paths: [client, data/openvpn]
```

YAML — reference into the registry:

```yaml
config_branch:
  branch: config
  source: files
  categories: [secret, config]   # filter into the registry
```

Validate at parse time: exactly one of `source:` / `paths:` must be set;
flag both-or-neither as a schema error. Don't fall back silently — the
user must declare which input style they're using. See
`parser/schema.py`'s `config_branch` block for the mutual-exclusion
check.

The plugin code holds zero copies of paths / image refs / etc.; it
projects from `config` on every call. That keeps two-registry drift
(the bug that prompted this rule) impossible.

### copyOptions hook

Press `y` opens a popup of copy targets. Each plugin contributes options
for its panel based on the focused item:

```javascript
copyOptions(item, S) {
  return [
    { label: 'Container name',  content: item },
    { label: 'Status',          content: cachedStatus(item) },
    // Lazy — content() called only if user picks this option
    { label: 'Inspect (JSON)',  content: () => execSync(...) },
  ];
}
```

`content` may be a string (eager) or a thunk `() => string` (lazy —
useful for expensive ops like `docker inspect`). Core appends a
"Detail panel" entry when the detail panel has content, plus a
trailing "Cancel" entry. 0 options → no-op; 1 option → copies
directly; 2+ → popup with arrow nav.

## Component Interface — the strict alternative

Plugins (the API above) are the fast path: mutate `S` directly, react
to keys via `onKey`. **Component** is a strict, TEA-shaped alternative
that exists alongside Plugin — every existing plugin still works
unchanged; new code chooses per file. The contract lives in
[PRINCIPLES.md §12](PRINCIPLES.md#12-two-plugin-apis--plugin-simple-and-component-strict);
this section is the practical reference for authoring one.

### When to choose Component over Plugin

- You want **snapshot tests** or **replay determinism** for the
  plugin's behavior — Component's `update(msg, slice) → newSlice` is
  pure, so a stored slice + a Msg list replays to an exact final
  state.
- The plugin maintains **non-trivial state** that you don't want
  other plugins (or future you) accidentally trampling. Components
  own a slice the framework hands them; cross-Component access goes
  through the runtime, not through shared `S`.
- You're comfortable writing a `switch (msg.type)` in exchange for
  the discipline.

Otherwise use Plugin. The mutate-S shape is faster to write and
correct for the common case.

### Minimum viable Component

```javascript
// components/counter.js
module.exports = {
  name: 'counter',

  // Framework calls init() once at registration. Returns the
  // initial slice — the plugin's private state.
  init: () => ({
    n: 0,
    lastKey: null,
  }),

  // Framework calls update() once for every Msg. Pure function:
  // returns the new slice (or `undefined` to leave it unchanged).
  update: (msg, slice) => {
    switch (msg.type) {
      case 'key':
        if (msg.key === '+') return { ...slice, n: slice.n + 1, lastKey: msg.key };
        if (msg.key === '-') return { ...slice, n: slice.n - 1, lastKey: msg.key };
        return { ...slice, lastKey: msg.key };
      case 'refresh':
        // No-op for this Component, but the Msg still arrives.
        return slice;
      default:
        return slice;
    }
  },

  // Panel types use the same shape as Plugin's, but render gets
  // (panel, w, h, slice) — the slice, NOT the global S.
  panelTypes: {
    counter: {
      render: (panel, w, h, slice) =>
        `count: ${slice.n}\nlast key: ${slice.lastKey || '(none)'}`,
    },
  },
};
```

Register with `api.registerComponent(component)` (compare:
`api.registerPlugin(plugin)` for the Plugin shape).

### Msg types a Component receives

The framework fans every input event out to every registered
Component's `update()`. Msg shape mirrors event-log entries — same
data, different consumer.

| Msg `type` | When fired | Payload fields |
|---|---|---|
| `'key'` | Every key event after key-filter middleware | `key` (string, e.g. `'up'`, `'q'`, `'a'`), `seq` (raw bytes for paste etc.) |
| `'refresh'` | Every refresh tick (per-plugin cadence or `:refresh`) | (none) |
| `'hub'` | Every `hub.publish()` call, before retention dedup | `topic`, `rowKey`, `sample` |
| `'action'` | Every action invocation, before confirm gating | `actionKey`, `args`, `actionType` (`'run'` / `'spawn'` / `'background'`) |

Future Msg types will be additive — a Component's `default:` arm
ignoring unknown types is forward-compatible.

### Discipline rules

1. **Components MAY read `S`** for app-global concerns: focus,
   currentGroup, mode flags, panel dimensions. Components MUST
   import it explicitly — `S` is not passed as an argument.
2. **Components MUST NOT write to `S`.** The Plugin/Component
   boundary depends on Components staying read-only with respect to
   shared state. v0.3.0 enforces this by documentation only — no
   `Object.freeze` / Proxy. If you find yourself wanting to write
   to `S`, you probably want a Plugin, not a Component.
3. **`update()` is pure.** No I/O, no `setTimeout`, no side effects.
   The slice is the only output. (Want async? Trigger it from a
   Plugin's `refresh()` or `onKey()`; the result arrives back as a
   `'hub'` Msg if you publish it.)
4. **Returning `undefined`** from `update()` leaves the slice
   unchanged. Explicit escape hatch for "this Msg is a no-op for me."
5. **Throwing from `update()`** is isolated — the failing
   Component's slice stays put; other Components keep processing
   the same Msg. The error is logged.

### What Component does NOT have

- **`onKey`** — gone. Keys arrive as `'key'` Msgs through
  `update()`. The key-filter middleware (also v0.3.0;
  `dispatch.registerKeyFilter`) runs *before* dispatch, so a
  Component's update sees whatever survived the filter chain.
- **Direct hub subscription** — instead, every `hub.publish()` fans
  out as a `'hub'` Msg. A Component interested in a topic filters by
  `msg.topic` in its `update()`. (Plugins still use
  `hub.subscribe()` if they need a windowed history retention.)

### What Component still has

Decorators, `groupActions`, `statusFor`, `copyOptions`, `keyHints`,
`filterable`, custom `:` cmdline verbs — all of these work
identically to the Plugin API. The Component / Plugin split is
narrowly about *state ownership and update flow*; everything else is
shared.

### Tests

`js/test/test-component.js` exercises the framework wiring: shape
validation, init-at-register, Msg fan-out, return shapes (new slice
/ undefined / throw), component-panel render. Use it as the
template for your own Component tests.

## Panel Modes

| Mode | Behavior | Example |
|------|----------|---------|
| `list` | Static items, ↑↓ selection, scroll | containers, files, branches |
| `content` | Readonly scrollable text | diffs, file preview, script display |
| `stream` | Async line append, auto-scroll | `log -f`, build output |
| `tree` | Expand/collapse nodes | file tree, resource hierarchy |
| `terminal` | PTY in panel region | embedded shell |
| `input` | Editable text | commit message, search |

Core TUI handles the rendering/interaction pattern for each mode.
Plugins provide data and respond to events.

## YAML Configuration

```yaml
plugins:
  docker:
    refresh_interval: 10

layout:
  left:
    panels:
      - type: containers    # docker plugin provides this
      - type: groups        # core built-in
      - type: file-manager  # core built-in
  right:
    panels:
      - type: actions       # core built-in
      - type: detail        # core built-in
```

## Core vs Plugin

The framework ships built-in panel types (`groups`, `actions`,
`file-manager`, `history`, `detail`) implemented as a `core` plugin.
Everything else — including the `containers` panel — comes from
plugins. New panel types are added by writing a plugin.

For the current panel-type catalog, see **LAYOUT.md**.

## Plugin Loading

1. Core reads `plugins:` section from YAML
2. Looks for `plugins/<name>.js` relative to TUI install
3. Calls `plugin.init(pluginConfig)` with YAML config
4. Registers panel types from `plugin.panelTypes`
5. Unknown panel type in layout → asks loaded plugins
6. Calls `plugin.refresh()` on background interval

## User Plugins

Two flavors:

### JS plugins (runtime behavior)

Place `.js` files in a directory next to the config. Reference in YAML:

```yaml
plugins:
  my-status:
    path: ./my-status-plugin.js    # relative to config file
    custom_option: value
```

The plugin file exports the same interface as built-in plugins
(`name`, `panelTypes`, `refresh`, `groupActions`, `init`, ...).
Used for: defining new panel types, per-item shortcut keys (onKey),
synthesizing actions from group metadata (groupActions).

### YAML plugins (declarative config splits)

Plain YAML files using the same schema as the main config
(but typically just `groups:` / `vars:` / `helpers:` / `files:`).
Reference by path ending in `.yml` or `.yaml`:

```yaml
# main config.yml
plugins:
  maintenance:
    path: tui-plugins/maintenance.yml
  vpn:
    path: tui-plugins/vpn.yml
```

```yaml
# tui-plugins/maintenance.yml
groups:
  maintenance:
    label: Maintenance
    actions:
      archive: { ... }
      ...
```

Use cases: split a long top-level YAML into per-group modules; share
reusable group definitions; layer environment-specific overrides.

**Merge rules** (parser-level, before validation):
- Groups are merged by name. New groups added; existing groups have
  their `actions` / `terminals` merged in (plugin doesn't override
  existing keys), and `containers` list extended.
- `vars` / `helpers`: plugin entries fill gaps only; main YAML wins on conflict.
- `files`: plugin entries appended.
- `layout` / `theme` / `plugins` from a plugin file are ignored.

## Inline scripts stay

Actions with `cmd:` / `script:` continue to work as before.
Plugins are an additional data layer, not a replacement for
the action execution system.
