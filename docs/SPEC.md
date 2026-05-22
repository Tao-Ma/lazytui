# lazytui — Plugin Authoring Spec

This is the authoring spec for the lazytui plugin system. It bundles
the documents you need to write a plugin without searching the
codebase. The TUI itself can print this entire bundle to stdout:

```sh
node js/tui.js --spec
```

The output is this file plus the five documents listed in **Index**
below, concatenated in read order. Pipe it to a file, or feed it to an
LLM as context, and you have everything required to write a plugin
correctly.

## Quickstart — minimal plugin

A plugin is a CommonJS module. The smallest viable plugin file:

```javascript
// plugins/hello.js
module.exports = {
  name: 'hello',

  panelTypes: {
    hello: {
      mode: 'list',
      getItems: () => ['one', 'two', 'three'],
      getInfo: (item) => [`item: ${item}`],
    },
  },
};
```

Reference it from your YAML config:

```yaml
plugins:
  hello:
    path: ./hello.js

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

Run: `node js/tui.js path/to/config.yml`. The plugin's `hello`
panel appears in the left column, populated by `getItems()`. Selecting
an item shows `getInfo(item)` in the detail panel.

That's the floor. Everything from here is on top of that contract:
async refresh, hub publish/subscribe, decorators, copyOptions,
streaming output, group-action injection, custom `:` commands.

## Index — read order

Read the sections in this order. Each is the original `.md` file from
the repo root, also shipped on disk for human reading.

1. **PRINCIPLES** — invariants. "YAML defines, TUI renders." Type-based
   dispatch. Markup safety rules (`esc()`, `[reverse]` no inner markup).
   Read this first; it disciplines every other doc.
2. **PLUGINS** — plugin contract. Module shape, panel types, async
   rules, `copyOptions`, `groupActions`, JS vs YAML plugins, merge rules
   for split YAML configs. The core authoring reference.
3. **PROJECT** — user-project contract. Directory shape, discovery
   rules, what the framework owns vs what a user project owns. Read
   this if you are adopting the TUI in a new project, or deciding
   where to put a new file.
4. **HUB** — pub/sub event bus for sharing data across plugins. Three
   data shapes (time series, snapshot, matrix), retention by subscriber
   window, wildcard subscriptions.
5. **DECORATORS** — slot framework for adding text to row/title/tab/
   footer surfaces. How a plugin contributes inline glyphs without
   touching the renderer.
6. **LAYOUT** — panel-type catalog, navigation, view modes, themes.
   What the user sees and how they drive it.

## Where features live (not in this spec)

- **CMDMODE.md** — `:` command mode (`:quit`, `:refresh`, custom
  per-plugin commands, args plumbing).
- **TERMINAL.md** — embedded PTY tabs (`terminals:` block in YAML,
  ephemeral runtime tabs).
- **STATS.md** — worked example of building a hub consumer end-to-end.

These are deep-dive references. The `--spec` output does **not**
include them — read them separately when you need that subsystem. They
build on the five core docs above.

## YAML schema

The plugin/config YAML schema is described in **PLUGINS.md** (plugin
section) and **LAYOUT.md** (layout section). When the two disagree,
the parser under `js/parser/` is authoritative — covered by the
JS test suite (`js/test/test-parser-*.js`).

## Conventions used in the spec

- Code fences with `javascript` / `yaml` / `sh` are paste-ready unless
  marked otherwise.
- Tables describing API surfaces use `|` columns; keep ordering when
  excerpting.
- "Producer" / "consumer" refer to hub roles. "Plugin author" / "user"
  refer to the human writing config.
- All Rich markup examples follow PRINCIPLES §7–8 — `[` always escaped
  in dynamic strings, `[reverse]` rows have no inner markup.

---
