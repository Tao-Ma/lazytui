# Components — the in-tree panel API

> **Naming note.** This file used to be PLUGINS.md and documented two
> APIs: a "Plugin" shape (stateless, callback-style) and a "Component"
> shape (TEA, slice-owning). v0.5 Phase 6 retired the Plugin API; Phase
> 1h renamed `js/plugins/` → `js/components/` and flattened the
> historical `core/` subdirectory. The post-v0.5 source reorg further
> moved `js/components/` → `js/panel/{,navigator,viewer,monitor}/`,
> matching the kind taxonomy. Every in-tree panel is still a
> Component, and external authors write Components too — same API as
> the built-ins. The file kept its name for cross-link stability.

## Architecture

```
┌─ Core TUI ──────────────────────────────────────────┐
│  Layout, keys, panel borders, themes                 │
├─ Component API (require('./panel/api')) ────────────┤
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
[docs/history/v0.5-layout-component.md](history/v0.5-layout-component.md) for the live
arc.

### Component API surface

Component authors import everything from `./panel/api`:

```javascript
const {
  // registry
  registerComponent,
  registerEffect,        // register a Cmd handler the framework can run
  dispatchMsg, wrap,     // dispatch a wrapped Msg to one Component
  getComponent, getInstanceSlice, getComponentOwningPanel,
  getPanelDef, getItems, idOf, selectedOrFocused,
  // lifecycle
  refreshAll, cleanupComponents,
  // collectors
  getCommands, getGroupActions, getMergedActions, statusFor,
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
} = require('./panel/api');
```

Direct imports from `../ansi`, `../panel`, etc. still work but are not
part of the contract — `panel/api.js` is the documented surface,
and the only place an API change shows up.

### Framework default `:` commands

Three commands are available without any Component contribution:

| Command | Behavior |
|---------|----------|
| `:quit` | Exit the TUI cleanly |
| `:refresh` | Re-fan a `refresh` Msg to every Component |
| `:help` | Render per-context help into the detail panel |

These live in `js/panel/commands.js#FRAMEWORK_COMMANDS`. They're collected by
`getCommands()` alongside Component-contributed commands; the `_source`
field tags each entry's origin (a Component name, or `<framework>` for
the built-ins).

## Component Interface

A Component is a module exporting:

```javascript
module.exports = {
  name: 'my-component',

  // Called once per instance to mint the initial slice. `seed` is
  // { config, projectDir, paneDef }; seed-blind inits ignore both args.
  init: (paneId, seed) => ({ /* per-Component state */ }),

  // Pure: returns the next slice, or [slice, effects], or undefined
  // to leave the slice unchanged.
  update: (msg, slice) => {
    switch (msg.type) {
      case 'key':     return /* ... */;
      case 'refresh': return /* ... */;
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
      // To suppress the framework default for a key the Component owns,
      // return the `_claimed` sentinel as one of the effects from update():
      //   return [slice, [{ type: '_claimed' }]];
      // The framework consumes the sentinel in dispatchKeyToFocused and
      // skips the global default. Same return statement handles the key
      // AND the claim — no separate `claimsKeys` field. (The legacy
      // `claimsKeys:` declaration retired in v0.5 Phase 6; declaring it
      // now logs a registration warning.)
    },
  },

  // Optional cross-cutting contributions (collected by the framework).
  viewContributions: { footerLeft, footerRight },
  statusFor:    (name) => 'running' | null,
  groupActions: (group, groupName, config, model) => ({ /* actionKey: action */ }),
  groupActionsMemo: true,   // opt-in fast path — see "The groupActions contract"
  // PURE PROJECTION — no IO, no mutation, same inputs → same outputs. ALWAYS
  // enforced (mutation via a read-only Proxy every call; determinism via a
  // one-shot re-call+compare; IO via an opt-in check — prod too, all clock-free).
  // Called transitively on hot read paths (viewer_append per stream line).
  // v0.6.2 added config + model; older 2-arg impls still work.
  commands:     [ { name, desc, run(args) } ],
  getCommands:  (model) => [ /* state-derived verbs */ ],
  cleanup:      () => { /* tear down long-lived children */ },

  // Optional: declarative Model→Sub. PURE projection of the pane def →
  // subscription descriptors (`interval` / `process-stream` /
  // `metrics-mirror`); the framework reconciles them each dispatch — this
  // is how recurring/external work is declared (the replacement for the
  // retired `tick` self-re-arm). docker.js / stats.js are the examples.
  subscriptions: (paneDef, model) => [ /* descriptors */ ],
  // Optional impure-shell hook: stamps model-derived facts onto a Msg
  // (so `update` stays pure of getModel()). docker.js augmentMsg.
  augmentMsg:   (msg, model, slice) => ({ ...msg /* + derived facts */ }),
  // Optional: register the Component's Cmd-effect handlers so a
  // [slice, [{ type: 'myEffect' }]] return actually runs. api.js / docker.js.
  installEffects: (registerEffect) => { /* registerEffect('myEffect', fn) */ },
  // Optional: kind-global service-slot flag (one shared instance per kind,
  // paneId == null) — e.g. docker's host-global daemon owner.
  service:      true,
};
```

Register with `api.registerComponent(component)`.

### Minimum viable Component

```javascript
// components/counter.js
const mnav = require('../leaves/wm/nav');
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
        // Producer-side viewer write. Two helpers re-exported from
        // app/state.js (canonical home: panel/nav-state.js):
        //   setViewerContent(tabId, text, opts) — REPLACES slice.lines.
        //                                     For discrete documents
        //                                     (history replay, diff,
        //                                     help text, job info).
        //   appendViewerLines(text)         — APPENDS to the unrouted
        //                                     accumulator (lands in
        //                                     the Transcript tab).
        //                                     For ephemeral event /
        //                                     status messages.
        // Pick by intent: "show me this document" vs "record this event."
        if (msg.key === 'i') {
          require('../app/state').setViewerContent(null, 'n = ' + slice.n);
          return { ...slice, lastKey: msg.key };
        }
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
| `'action'` | Every action invocation, before confirm gating | `actionKey`, `args`, `actionType` (`'run'` / `'spawn'` / `'background'`) |
| _Wrapped Msgs_ | Routed via `api.dispatchMsg(api.wrap('name', innerMsg))` | inner msg's payload — the wrapper is unwrapped by the framework |

Plus the shared nav-chrome Msgs (`set_cursor`, `set_scroll`,
`multisel_toggle`, `multisel_select_all`, `multisel_clear`) handled by
`js/leaves/wm/nav.js`.

Future Msg types will be additive — a Component's `default:` arm
ignoring unknown types is forward-compatible.

### Discipline rules

1. **Components MAY read the root model** for app-global concerns
   (focus, currentGroup, mode flags). Use
   `require('../app/runtime').getModel()` (re-export; canonical home is
   `require('../model/store').getModel()`). The model is not passed as an
   argument.
2. **Components MUST NOT write the root model.** A Component's own
   slice is the only thing its `update` writes directly; cross-layer
   writes go out as a `{type:'msg', msg}` effect — a wrapped Msg
   (`api.wrap('target', innerMsg)`) fans out to the named Component;
   a flat Msg re-dispatches through the root reducer. The framework
   runs them, so the single-writer rule per layer is preserved.
3. **`update()` is pure.** No I/O, no `setTimeout`, no side effects.
   The output is the next slice (or `[slice, effects]`). Async work
   is an effect: return a Cmd descriptor, the framework runs it, the
   result re-enters as a Msg. Recurring or external work is declared
   instead as a **subscription** — see `subscriptions(paneDef, model)`
   below (docker.js's `subscriptions()` is the canonical example).
4. **Returning `undefined`** from `update()` leaves the slice
   unchanged. Explicit escape hatch for "this Msg is a no-op for me."
5. **Throwing from `update()`** is isolated — the failing
   Component's slice stays put; other Components keep processing the
   same Msg. The error is logged.

### The `groupActions` contract

A Component MAY expose `groupActions(group, groupName, config, model)` to
**synthesize actions for a group** — e.g. `docker` turns a group's
`compose:` into `up`/`down`/`logs`/`restart` actions. The framework merges
every Component's contribution with the group's YAML `actions:`
(`api.getMergedActions`), and it drives the tab strip, the actions panel,
and leader-key resolution — so it is called transitively on **hot read
paths**, including once per line of streamed output (`viewer_append`).

Because of that, `groupActions` **MUST be a pure projection**:

- **No mutation** of `group` / `config` / `model` (they are shared app
  state owned by the reducers — mutating them corrupts the model).
- **No IO / no shelling out / no `Date`/random** — same inputs → same
  outputs. A blocking call here stalls the event loop on every frame.

**This contract is ALWAYS ENFORCED — in production, not just dev.** The
framework (`panel/plugin-guard.js`) checks it **directly** — purity is a static
property, so each check runs at most once per `(group, Component)` and **never
reads the wall clock on the render path** (the guard must not itself be impure):

- **Mutation** (every call): the args are wrapped in a recursive read-only
  `Proxy`. A **write** at any depth throws; the offending Component contributes
  **nothing** for that call and a `plugin-impure` warning is recorded in the
  diagnostics window (`leader e`). The real `config`/`model` are never touched,
  so the rest of the app behaves identically.
- **Determinism** (once per group): on first use the projection is run a second
  time with the **same** args and the two outputs compared (back-to-back on one
  snapshot — `model` is an input, so comparing across renders would false-flag a
  legitimately model-dependent projection). A difference records a
  `plugin-nondeterministic` warning (it read `Date`/random or did varying IO).
- **IO** (opt-in, `LAZYTUI_VERIFY_PLUGINS=1`): the projection is run once more
  with `fs`/`child_process` intercepted; touching either records a `plugin-io`
  warning. Off by default (it patches globals) — for plugin authors / CI.

Warnings dedupe per `(code, key)` for the session.

#### `groupActionsMemo` — the opt-in fast path

The read-only `Proxy` makes every property access the Component does go
through a trap, so a hook that reads a lot of `config`/`model` costs several
× a raw call. Since `config` is **boot-static** (the `group` objects never
change for the life of the session), a *pure* `groupActions` returns the
**same result every call** — so there is no reason to recompute it.

A Component declares this by setting **`groupActionsMemo: true`**. The
framework then:

1. runs `groupActions` **once per group, still under the guard** (so purity
   is verified exactly once), then
2. **caches** the result keyed on the `group` object and reuses it on every
   later call — skipping both the call and the `Proxy`.

A config reload mints new `group` objects, so the cache self-invalidates (a
`WeakMap`); no invalidation logic is needed.

The incentive is deliberate: **opting in is a purity promise** (the result
must depend only on `group`), and only a pure hook can be safely memoized. A
careful, pure Component pays the `Proxy` cost **once** and is free
thereafter; a Component that does **not** opt in pays it on **every** call.
Memoize when your `groupActions` is a pure function of the group; leave it
off if it legitimately varies with live `model` state (and accept the
per-call cost).

### Nav chrome and the `dispatch.navSelect` helper

Every Navigator panel's `slice.nav[panelType] = { cursor, scroll,
multiSel, filter }` is the canonical per-panel chrome (Phase 4a + 4c).
The shared `js/leaves/wm/nav.js` leaf handles seven uniform Msg shapes
(`set_cursor` / `set_scroll` / `multisel_toggle` /
`multisel_select_all` / `multisel_clear` / `set_filter` /
`clear_filter`) — every Navigator's `update` should call
`mnav.apply(slice, msg)` first and fall through on miss.

For cursor moves with cascade behavior (refresh detail body; on the
groups panel also fire the currentGroup-change cascade), use the
`dispatch.navSelect(panelType, index)` helper instead of
emitting `set_cursor` by hand. It bundles:

1. `dispatchMsg(wrap(<owner>, { type: 'set_cursor', panel, index }))`
2. `dispatchMsg(wrap('detail', { type: 'viewer_show_info' }))` — refresh the focused panel's info
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
  contributes `getItems` / `getInfo` / `copyOptions` / `idOf`. To claim
  a keystroke (suppress the framework default), return a `_claimed`
  sentinel effect from the Component's `update`. Groups, actions,
  history, containers (docker), files, config-status.
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
panels:
  containers: { type: containers }                    # docker Component
  groups:     { type: groups }                        # groups Component
  files:      { type: files, source: declared }       # files Component
  #                                                     declared / filesystem / both / docker
  actions:    { type: actions }                       # actions Component
  detail:     { type: detail }                        # viewer Component (the detail panel)

layout:
  left:
    panels:
      - containers
      - groups
      - files
  right:
    panels:
      - actions
      - detail
```

The `plugins:` top-level block no longer drives runtime plugin loading.
Entries whose `path:` ends in `.yml`/`.yaml` are still consumed by the
parser as YAML config splits (see "Config splits" below). tui.js
surfaces a one-time warning naming any non-split entries — the ones
that would have been runtime plugins under the retired API — so they
don't silently no-op. The parser preserves the block verbatim for
round-trip fidelity.

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
