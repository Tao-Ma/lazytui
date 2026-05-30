# Components — the in-tree panel API

> **Naming note.** This file used to be PLUGINS.md and documented two
> APIs: a "Plugin" shape (stateless, callback-style) and a "Component"
> shape (TEA, slice-owning). v0.5 Phase 6 retired the Plugin API; Phase
> 1h renamed `js/plugins/` → `js/components/` and flattened the
> historical `core/` subdirectory. Every in-tree panel is now a
> Component, and external authors write Components too — same API as
> the built-ins. The file kept its name for cross-link stability.

## Architecture

```
┌─ Core TUI ──────────────────────────────────────────┐
│  Layout, keys, panel borders, themes                 │
├─ Component API (require('./components/api')) ───────┤
│  Registry:  registerComponent, getCommands,          │
│             getItems, selectedOrFocused, idOf, ...   │
│  Subsystems: hub                                     │
│  Helpers:   esc, theme, renderPanel, getSel,         │
│             getFilter, execAsync, streamCommand,     │
│             addEphemeralTab, scheduleRender          │
│  Defaults:  :quit, :refresh, :help                   │
├──────────────────────────────────────────────────────┤
│  layout │ groups │ docker │ files │ ... Components   │
└─────────┴────────┴────────┴───────┴──────────────────┘
```

Core TUI is a generic framework. Components own state (a slice) and
respond to messages (`update(msg, slice)`); the framework owns slice
storage and dispatch. See [PRINCIPLES.md §12](PRINCIPLES.md#12-tea-shape-and-the-component-discipline)
for the discipline rules and the spec at
[docs/v0.5-layout-component.md](v0.5-layout-component.md) for the live
arc.

### Component API surface

Component authors import everything from `./components/api`:

```javascript
const {
  // registry
  registerComponent,
  registerEffect,        // register a Cmd handler the framework can run
  dispatchMsg, wrap,     // dispatch a wrapped Msg to one Component
  getComponent, getComponentSlice, getComponentOwningPanel,
  getPanelDef, getItems, idOf, selectedOrFocused,
  // lifecycle
  refreshAll, cleanupComponents,
  // collectors
  getCommands, getGroupActions, statusFor,
  collectViewContributions, _resetViewContributions,
  // subsystems
  hub,
  // helpers (ansi / themes / panel)
  esc, visibleLen, stripMarkup, theme, renderPanel,
  // nav-chrome reads (per-panel; writes go through wrapped Msgs)
  getSel, getScroll, isMultiSel,
  // filter / exec / streaming
  getFilter, execAsync, streamCommand, addEphemeralTab, scheduleRender,
  // viewer tab controls
  setActiveTab, leaveTerminalMode,
} = require('./components/api');
```

Direct imports from `../ansi`, `../panel`, etc. still work but are not
part of the contract — `components/api.js` is the documented surface,
and the only place an API change shows up.

### Framework default `:` commands

Three commands are available without any Component contribution:

| Command | Behavior |
|---------|----------|
| `:quit` | Exit the TUI cleanly |
| `:refresh` | Re-fan a `refresh` Msg to every Component |
| `:help` | Render per-context help into the detail panel |

These live in `components/api.js#FRAMEWORK_COMMANDS`. They're collected by
`getCommands()` alongside Component-contributed commands; the `_source`
field tags each entry's origin (a Component name, or `<framework>` for
the built-ins).

## Component Interface

A Component is a module exporting:

```javascript
module.exports = {
  name: 'my-component',

  // Called once at registration; returns the initial slice.
  init: () => ({ /* per-Component state */ }),

  // Pure: returns the next slice, or [slice, effects], or undefined
  // to leave the slice unchanged.
  update: (msg, slice) => {
    switch (msg.type) {
      case 'key':     return /* ... */;
      case 'refresh': return /* ... */;
      case 'hub':     return /* ... */;
      case 'action':  return /* ... */;
      default:        return slice;     // unknown Msg type
    }
  },

  // Optional: panel renderer(s). `render(panel, w, h, slice)` returns
  // the Rich-markup string for the panel's grid cell.
  panelTypes: {
    mypanel: {
      render: (panel, w, h, slice) => '...',
      getItems: (slice) => [ /* rows */ ],
      getInfo:  (item)  => [ /* detail lines */ ],
      copyOptions: (item) => [ { label, content } ],
      filterText:  (item) => 'searchable',
      idOf:        (item) => 'stable-id',
      keyHints:    'i inspect | t logs',
      claimsKeys:  ['return'],    // suppress framework default for these
    },
  },

  // Optional cross-cutting contributions (collected by the framework).
  viewContributions: { footerLeft, footerRight },
  statusFor:    (name) => 'running' | null,
  groupActions: (group, groupName) => ({ /* actionKey: action */ }),
  commands:     [ { name, desc, run(args) } ],
  getCommands:  (model) => [ /* state-derived verbs */ ],
  cleanup:      () => { /* tear down long-lived children */ },
};
```

Register with `api.registerComponent(component)`.

### Minimum viable Component

```javascript
// components/counter.js
const mnav = require('../model-nav');
module.exports = {
  name: 'counter',
  init: () => ({
    n: 0, lastKey: null,
    nav: { counter: mnav.init() },          // cursor/scroll/multiSel
  }),
  update: (msg, slice) => {
    if (mnav.isNavMsg(msg)) return mnav.apply(slice, msg);
    switch (msg.type) {
      case 'key':
        if (msg.key === '+') return { ...slice, n: slice.n + 1, lastKey: msg.key };
        if (msg.key === '-') return { ...slice, n: slice.n - 1, lastKey: msg.key };
        // Effect example — emit a setDetail to push text into the viewer.
        if (msg.key === 'i') return [slice, [{ type: 'setDetail', lines: ['n = ' + slice.n] }]];
        return { ...slice, lastKey: msg.key };
      default: return slice;
    }
  },
  panelTypes: {
    counter: {
      render: (panel, w, h, slice) =>
        `count: ${slice.n}\nlast key: ${slice.lastKey || '(none)'}`,
    },
  },
};
```

### Msg types a Component receives

The framework fans every input event out to every registered
Component's `update()`. Msg shape mirrors event-log entries — same
data, different consumer.

| Msg `type` | When fired | Payload fields |
|---|---|---|
| `'key'` | Every key event after key-filter middleware (focused panel's Component only) | `key` (string, e.g. `'up'`, `'q'`, `'a'`), `seq` (raw bytes for paste etc.) |
| `'refresh'` | Boot, `r`, `:refresh` | (none) |
| `'hub'` | Every `hub.publish()` call, before retention dedup | `topic`, `rowKey`, `sample` |
| `'action'` | Every action invocation, before confirm gating | `actionKey`, `args`, `actionType` (`'run'` / `'spawn'` / `'background'`) |
| _Wrapped Msgs_ | Routed via `api.dispatchMsg(api.wrap('name', innerMsg))` | inner msg's payload — the wrapper is unwrapped by the framework |

Plus the shared nav-chrome Msgs (`set_cursor`, `set_scroll`,
`multisel_toggle`, `multisel_select_all`, `multisel_clear`) handled by
`js/model-nav.js`.

Future Msg types will be additive — a Component's `default:` arm
ignoring unknown types is forward-compatible.

### Discipline rules

1. **Components MAY read the root model** for app-global concerns
   (focus, currentGroup, mode flags). Use
   `require('./runtime').getModel()`. The model is not passed as an
   argument.
2. **Components MUST NOT write the root model.** A Component's own
   slice is the only thing its `update` writes directly; cross-layer
   writes go out as effects — `apply_msg` (re-dispatch a Msg through
   the root reducer) or `dispatch_msg` (re-dispatch to another
   Component, with `api.wrap('target', innerMsg)`). The framework
   runs them, so the single-writer rule per layer is preserved.
3. **`update()` is pure.** No I/O, no `setTimeout`, no side effects.
   The output is the next slice (or `[slice, effects]`). Async work
   is an effect: return a Cmd descriptor, the framework runs it, the
   result re-enters as a Msg (often via the `tick` self-re-arming-Cmd
   pattern — see docker.js for an example).
4. **Returning `undefined`** from `update()` leaves the slice
   unchanged. Explicit escape hatch for "this Msg is a no-op for me."
5. **Throwing from `update()`** is isolated — the failing
   Component's slice stays put; other Components keep processing the
   same Msg. The error is logged.

### Nav chrome and the `dispatch.navSelect` helper

Every Navigator panel's `slice.nav[panelType] = { cursor, scroll,
multiSel, filter }` is the canonical per-panel chrome (Phase 4a + 4c).
The shared `js/model-nav.js` leaf handles seven uniform Msg shapes
(`set_cursor` / `set_scroll` / `multisel_toggle` /
`multisel_select_all` / `multisel_clear` / `set_filter` /
`clear_filter`) — every Navigator's `update` should call
`mnav.apply(slice, msg)` first and fall through on miss.

For cursor moves with cascade behavior (refresh detail body; on the
groups panel also fire the currentGroup-change cascade), use the
`dispatch.navSelect(model, panelType, index)` helper instead of
emitting `set_cursor` by hand. It bundles:

1. `dispatchMsg(wrap(<owner>, { type: 'set_cursor', panel, index }))`
2. `showSelectedInfo(model)` — refresh the focused panel's info
3. For `panelType === 'groups'`: `dispatchMsg(wrap('groups', { type:
   'groups_selected', index }))` — the cascade that updates
   `currentGroup`, resets per-group chrome, and resets the viewer.

j/k, page-up/down, goto-top/bottom, mouse click on a panel row, and
`state.selectGroup()` all route through `navSelect` so the cascade
fires consistently.

### viewContributions — footer slot composition

```javascript
viewContributions: {
  footerLeft:  (slice, ctx) => 'segment-text',
  footerRight: (slice, ctx) => ({ text: '...', weight: 100 }),
}
```

`api.collectViewContributions('footerLeft' | 'footerRight', ctx)`
composes registered contributors per frame: stable sort ascending by
weight, `footerRight` reversed (so highest-weight segment sits
rightmost on screen), joined with ` │ `, truncated to `ctx.width`. See
`docs/DECORATORS.md` for the migration history.

### Tests

`js/test/test-component.js` exercises the framework wiring: shape
validation, init-at-register, Msg fan-out, return shapes (new slice /
undefined / throw), Component-panel render, viewContributions. Use it
as the template for your own Component tests.

## Panel kinds (informal)

Three kinds of panel coexist in tree (a taxonomy from the v0.5 design
docs, not a runtime-enforced enum):

- **Navigator** — list/tree of selectable rows. Owns a per-panel
  cursor / scroll / multiSel on `slice.nav[panelType]` (Phase 4a) and
  contributes `getItems` / `getInfo` / `copyOptions` / `idOf` /
  optional `onKey` / optional `claimsKeys`. Groups, actions, history,
  containers (docker), files, file-manager, config-status.
- **Viewer** — single scrollable content surface (the detail panel).
  Owns content + scroll + tabs + search + selection on its own slice.
- **Monitor** — pure projection (stats). No cursor; no multiSel; the
  panel reads upstream data (typically the hub) and renders.

The `panelTypes[X]` def has no enum that distinguishes these — the
shape of the def (presence of `getItems` / `idOf` / `keyHints`) tells
the framework what behavior to apply.

## YAML Configuration

Panel selection happens in the `layout:` block; each panel type names
the Component that owns it.

```yaml
layout:
  left:
    panels:
      - type: containers    # docker Component
      - type: groups        # groups Component
      - type: file-manager  # file-manager Component
  right:
    panels:
      - type: actions       # actions Component
      - type: detail        # viewer Component (the detail panel)
```

The `plugins:` top-level block (legacy Plugin loader) is no longer
read at runtime; tui.js surfaces a one-time warning if the block is
non-empty. The parser still preserves it for round-trip fidelity.

## Config splits — YAML "plugins"

Plain YAML files using the same schema as the main config (typically
just `groups:` / `vars:` / `helpers:` / `files:`) can be referenced by
the main config to split a long config into modules. The feature is
parser-level (the merge happens before validation) and is unrelated to
the retired runtime Plugin API.

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
```

Use cases: split a long top-level YAML into per-group modules; share
reusable group definitions; layer environment-specific overrides.

**Merge rules** (parser-level, before validation):
- Groups are merged by name. New groups added; existing groups have
  their `actions` / `terminals` merged in (the split doesn't override
  existing keys), and `containers` list extended.
- `vars` / `helpers`: split entries fill gaps only; main YAML wins on conflict.
- `files`: split entries appended.
- `layout` / `theme` / `plugins` from a split file are ignored.

## Inline scripts stay

Actions with `cmd:` / `script:` continue to work as before. Components
are an additional data layer, not a replacement for the YAML-declared
action model.
