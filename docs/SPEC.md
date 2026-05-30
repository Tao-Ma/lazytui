# lazytui — Component Authoring Spec

This is the authoring spec for the lazytui Component system. It bundles
the documents you need to write a Component without searching the
codebase. The TUI itself can print this entire bundle to stdout:

```sh
node js/tui.js --spec
```

The output is this file plus the documents listed in **Index** below,
concatenated in read order. Pipe it to a file, or feed it to an LLM as
context, and you have everything required to write a Component
correctly.

> **History.** Before v0.5 Phase 6 retired the Plugin API, lazytui
> shipped two panel shapes — "Plugin" (simple, stateless) and
> "Component" (TEA, slice-owning). Today every panel is a Component;
> external authors write Components too. The `_plugin` source-tag
> field on cmdline commands is historical (the rename to `_component`
> wasn't worth the cmdline-display churn).

## Quickstart — minimal Component

A Component is a CommonJS module. The smallest viable one:

```javascript
// js/components/hello.js
module.exports = {
  name: 'hello',
  init: () => ({}),
  update: (msg, slice) => slice,
  panelTypes: {
    hello: {
      mode: 'list',
      render: (panel, w, h, slice) => `(stub render of ${panel.title})`,
      getItems: (slice) => ['one', 'two', 'three'],
      getInfo: (item) => [`item: ${item}`],
    },
  },
};
```

Register it at boot in `tui.js`:

```javascript
registerComponent(require('./components/hello'));
```

Reference the panel type in your YAML config:

```yaml
layout:
  left:
    panels:
      - type: hello
        title: Hello
      - type: groups
        title: Groups
  right:
    panels:
      - type: actions
        title: Actions
      - type: detail
        title: Detail
```

Run: `node js/tui.js path/to/config.yml`. The Component's `hello`
panel appears in the left column, populated by `getItems()`. Selecting
an item shows `getInfo(item)` in the detail panel.

That's the floor. Everything from here is on top of that contract:
async refresh via the self-arming `tick` Cmd, hub publish/subscribe,
viewContributions (footer slots), `copyOptions`, streaming output,
group-action injection, custom `:` commands.

## Index — read order

Read the sections in this order. Each is the original `.md` file from
`docs/`, also shipped on disk for human reading.

1. **PRINCIPLES** — invariants. "YAML defines, TUI renders." Type-based
   dispatch. Markup safety rules (`esc()`, `[reverse]` no inner markup).
   The Component discipline + the "two homes for state" question. Read
   this first; it disciplines every other doc.
2. **PLUGINS** — the Component contract. Module shape, panel types,
   Msg types, effects, discipline rules, viewContributions,
   `copyOptions`, `groupActions`, YAML config splits.
3. **PROJECT** — user-project contract. Directory shape, discovery
   rules, what the framework owns vs what a user project owns. Read
   this if you are adopting the TUI in a new project, or deciding
   where to put a new file.
4. **HUB** — pub/sub event bus for sharing data across Components.
   Three data shapes (time series, snapshot, matrix), retention by
   subscriber window, wildcard subscriptions.
5. **LAYOUT** — panel-type catalog, navigation, view modes, themes.
   What the user sees and how they drive it.

(Historical: `DECORATORS.md` retired in v0.5 Phase 5; the file remains
as a one-page retirement note pointing at viewContributions.)

## Where features live (not in this spec)

- **CMDMODE.md** — `:` command mode (`:quit`, `:refresh`, custom
  per-Component commands, args plumbing).
- **TERMINAL.md** — embedded PTY tabs (`terminals:` block in YAML,
  ephemeral runtime tabs).
- **STATS.md** — worked example of building a hub consumer end-to-end.

These are deep-dive references. The `--spec` output does **not**
include them — read them separately when you need that subsystem. They
build on the core docs above.

## YAML schema

The schema is described in **PLUGINS.md** (Component contract + YAML
config) and **LAYOUT.md** (layout section). When the two disagree, the
parser under `js/parser/` is authoritative — covered by the JS test
suite (`js/test/test-parser-*.js`).

## Conventions used in the spec

- Code fences with `javascript` / `yaml` / `sh` are paste-ready unless
  marked otherwise.
- Tables describing API surfaces use `|` columns; keep ordering when
  excerpting.
- "Producer" / "consumer" refer to hub roles. "Component author" /
  "user" refer to the human writing config.
- All Rich markup examples follow PRINCIPLES §7–8 — `[` always escaped
  in dynamic strings, `[reverse]` rows have no inner markup.

---
