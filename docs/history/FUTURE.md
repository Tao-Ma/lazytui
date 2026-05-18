# lazytui — Future Requirements

Research from lazygit, lazydocker, k9s, ctop, dry, go-task.

## Medium Priority

### Copy menu (`y`) — plugin-driven, lazygit-style
Lazydocker doesn't have it; lazygit pops up a menu showing which content
the user wants to copy (commit hash, message, file path, full diff, etc.).

Plugin contract: `panelDef.copyOptions(item, S)` returns an array of
`{ label, content }` where `content` is either a string or a thunk
returning a string (lazy — for expensive ops like `docker inspect`).

Press `y` flow:
- Core collects options from focused panel's plugin + a global
  "Detail panel content" entry when detail has lines.
- 0 options → no-op
- 1 option → copy directly (OSC52)
- 2+ options → popup menu, ↑↓ to choose, Enter to copy, Esc cancels.

Plugin examples:
- containers: name / status / cpu / mem / inspect-json
- actions: key / label / resolved script
- file-manager: path / file contents
- groups: name / label / container list

### Syntax highlighting plugin
Highlight code shown in info / detail panels — primarily action.script
in the actions-info tab, entry.cmd in the history-info tab, and copy-
options File-contents previews. Static views only (live streaming
output is not in scope).

**Plugin contract:**
- Plugin exports `highlighters: { <lang>: (text) => richMarkup }`.
- `plugins/api.js` registers them into a `lang -> fn` map; first plugin
  to register a language wins (later registrants logged + skipped).
- Public API: `api.highlight(text, lang) -> richMarkup`. Falls back to
  Rich-bracket-escaped plain text when no highlighter owns `lang`, so
  callers can splice the result unconditionally.

**Two implementation paths:**

1. *Pure-JS, bash-only.* ~70-LOC hand-rolled tokenizer in
   `plugins/highlight.js` covering comments, strings (single/double/
   backtick), `$VAR` / `${VAR}` / `$N`, keywords (if/for/case/...),
   common builtins (echo/cd/test/...), operator runs (`|`, `&&`,
   `>>`). Heredocs and `$(...)` not specially handled — keyword
   recolor inside heredoc body is the visible artifact, tolerable.
   Color map fixed (not theme-driven) so highlighting reads as
   highlighting under any theme: comment=dim, string=green,
   keyword=magenta, variable=cyan, operator=yellow, builtin=bold yellow.

2. *cli-highlight dep.* +1 npm dep (~1 MB transitively, pulls
   highlight.js). 180+ languages free. Returns ANSI escapes, so
   needs an ANSI→Rich shim (~30 LOC) because `panel.js#truncate`
   strips `[...]`-shaped tokens and would partially eat ANSI codes.
   Net code volume similar to path (1); the win is language coverage.

**Recommendation:** path (1) for v1 — action.script and entry.cmd are
100% bash so the dominant case is fully covered. Promote to (2) only
when arbitrary file contents need highlighting (copy-options File
contents, future log-tail panels).

**Wiring sites in core.js:**
- `actionsInfo`: replace `for (const sl of scriptLines) lines.push('  ' + esc(sl))`
  with `api.highlight(action.script, 'bash').split('\n').slice(0, 8).map(...)`.
- `historyInfo`: same treatment for `entry.cmd`.
- `historyInfo` output preview is command stdout, not code — leave
  unhighlighted.

**Future:** YAML `actions: { foo: { lang: python } }` field for non-
bash actions; auto-detect lang from `script` shebang; copy-options
File-contents lang inference from path extension.

## Lower Priority

### Action workflows/macros
Run a sequence of actions: "up → wait → status". Lazydocker has
`bulkCommands`. Could be YAML-defined:
```yaml
workflows:
  full-restart:
    steps: [down, up, status]
    confirm: "Full restart?"
```

### Dry-run mode
Show what script would execute without running it. Useful for
dangerous/confirm actions. Show resolved script in detail panel.

### Design mode mouse drag
Design mode (`--design`) currently keyboard-only. Add SGR mouse
reporting (`\x1b[?1006h`) to support drag-to-resize:
- Drag column border to resize left width
- Drag panel borders to resize heights
- Parse SGR sequences: `\x1b[<button;x;y M/m` (press/release/drag)
- ~100-150 lines in design.js

## Parity Gap (vs lazygit / lazydocker / k9s)

### Our positioning

We are a **generic plugin framework**, not a domain-specific tool.
lazygit/lazydocker/k9s each hardcode one resource type (git/docker/k8s).
We let anyone write a plugin in ~200 lines without forking. The plugin
API is uniform across core + third-party (corePlugin and dockerPlugin
register through the same interface).

### Daily-use feature parity

| Feature                              | lazygit | lazydocker | k9s | Us  |
|--------------------------------------|---------|------------|-----|-----|
| Multi-select / bulk operations       | ✓       | ✓          | ✓   | ✓   |
| CPU/mem history graphs               | —       | ✓ sparkline| —   | ✓ line graph (STATS.md) |
| Live event streaming (no polling)    | ✓       | ✓          | ✓   | ✓   |
| Resource drill-down (parent → child) | ✓       | ✓          | ✓   | ✗   |
| `:` command mode (quick jump)        | —       | —          | ✓   | ✗   |
| Keymap customization                 | ✓       | ✓          | ✓   | ✗   |
| In-app YAML/config edit              | —       | —          | ✓   | ✗   |
| Bulk commands (restart-all)          | —       | ✓          | ✓   | ✗   |
| Process list (`top`)                 | —       | ✓          | ✓   | ✗   |
| Custom commands w/ template vars     | ✓       | ✓          | —   | ✓ (plugin onKey) |
| Embedded interactive shells          | —       | partial    | —   | ✓   |
| YAML-configurable layout             | —       | —          | —   | ✓   |
| Plugin extensibility                 | —       | —          | partial | ✓ |

Estimate: **~75% of lazydocker's daily-use parity** — multi-select,
docker event streaming, line-graph stats panel, and `:` cmdline all
shipped. Remaining gaps: keymap customization, in-app config edit,
process list, drill-down navigation.

### Polish gaps

- **Visual density** — lazydocker packs status + name + image + stats +
  uptime in one row. We're sparser by design (left column is narrow).
- **Animation** — k9s pulses on changes. We just re-render.
- **Per-context help** — lazygit's `?` shows ALL keys for the focused
  panel. Ours is a single global help screen.
- **State persistence** — k9s remembers last view across sessions.
  We start fresh each launch.

### Closure candidates (with rough cost)

| Item                          | Lines | Why it pays                               |
|-------------------------------|-------|-------------------------------------------|
| Sparkline widget (decorator)  | ~30   | One-line `▁▂▃▄▅▆▇█` glyph fed by `hub.history()`. Valid only as (a) a column in a future table-style panel, or (b) a footer slot (`footer:left/right`) tracking one live signal. Narrow-panel-of-sparklines is explicitly an anti-pattern — see HUB.md §0 / §17. |
| Per-context help              | ~30   | Shows panel-specific keys (plugin keyHints) |

### Tried and rejected

#### Bundled sparklines + decorateRow + infoLines branch
Shipped a sparklines plugin coupled to a new `decorateRow` plugin hook
(later moved to `infoLines`) and to docker-plugin hub publishing — all in
one delivery. Reverted. Reason: three different layers (data foundation
vs. UI extension framework vs. one specific visualization) got fused
into "the sparklines branch" because the visualization was the only
visible feature. Each layer deserves its own design and its own branch.
Hub stayed; the rest came out. See **HUB.md §0** for the full
retrospective and the corrected three-layer decomposition.

#### Action status indicators (✓/✗/⟳ in actions panel)
Considered: track last-run result per action, show next to label.
Implemented and reverted. Reason: the **detail panel already shows
running state** (`Running...`, live streaming output, final
`Done.` / `Exit N`). That's where users actually look during/after
a run. A second indicator in the actions panel adds clutter without
adding signal. Skip unless we get a concrete request that the detail
panel feedback is insufficient.

### Patterns to steal (from earlier research)

| Source     | Pattern                                       | Applicability               |
|------------|-----------------------------------------------|-----------------------------|
| k9s        | `:` command mode to jump to any resource      | Quick action search         |
| lazygit    | `@` toggle command log panel                  | Toggle detail visibility    |
| go-task    | `deps` DAG for task ordering                  | Action dependency chains    |
| ctop       | Sort columns by CPU/mem/name                  | Sortable container list     |
| lazydocker | sparkline graphs                              | Inline stat history         |
| lazygit    | Per-context help (`?` shows panel-only keys)  | Replace global help screen  |
| k9s        | Pulse animation on resource state change      | Notify without disrupting   |

## Done

**Architecture:**
- Migrated from Python/Textual to Node.js (parser stays Python)
- Plugin system (plugins/api.js, docker as first plugin)
- **Plugin API facade** — `plugins/api.js` re-exports the full plugin-
  facing surface (esc / visibleLen / theme / renderPanel / getSel /
  getScroll / isMultiSel / getFilter / execAsync / decorate /
  streamCommand / addEphemeralTab / scheduleRender / hub / decorators).
  Plugins import from `./api` only. PLUGINS.md documents.
- **Framework default `:` commands** — `:quit`, `:refresh`, `:help`
  live in `plugins/api.js#FRAMEWORK_COMMANDS`, not in any plugin.
- **corePlugin split** — `plugins/core/` directory: groups.js,
  actions.js, file-manager.js, history.js, detail.js, index.js
  composer (each ~80–145 LOC; was a single 544-LOC file).
- **Mode buffers module-private** — design.js's pattern adopted by
  menu/copy/cmdline/filter. S keeps only the *Mode flag (so the
  conductor can detect overlay-active); transient buffers (typed
  text, selected idx, item lists) live inside the mode module.
  Adding a mode = drop a file + one entry in dispatch.modeChain.
- **Central frame-loop** — handleKey/handleMouse own the trailing
  paint; effect handlers mutate state only. ~40 explicit render()
  calls collapsed into one per input event. Diff-render makes
  per-key paint cheap; single emission point eliminates "forgot to
  render" bugs.
- **Cursor visibility derived from state** — single emission at
  end of layout.render(): show if S.terminalMode || S.cmdMode, else
  hide. No more scattered showCursor()/hideCursor() across modes.
- **Tabs module** — `tabs.js` owns tab arithmetic and ephemeral-tab
  lifecycle; `terminal.js` shrunk to PTY-session lifecycle. Tab
  click bounds published into S.panelBounds.detail.tabs (input.js
  reads off S, no plugin getter).
- Generic per-panel state (getSel/setSel/getScroll/setScroll)
- Layout-driven panels from YAML config
- Theme system (6 themes: monokai/dracula/solarized/gruvbox/nord/minimal)
- ~28 focused JS modules + plugins/core/ subdirectory.
- npm deps: node-pty + @xterm/headless (only for embedded terminals)
- Event hub (`hub.js`) — pub/sub data bus for cross-plugin streams.
  First consumer: `history.js` is hub-backed (`actions.lifecycle` topic,
  single-stream, window=100). See HUB.md.
- **Stats panel** — YAML-declarable `type: stats` panel rendering
  multi-row block-char line graphs for the focused row's history.
  Generic over hub topic via schema-typed columns. Docker plugin
  publishes `docker.stats` with `cpu` (percent) + `mem` (bytes) +
  `memLimit` (bytes, `meta: true` so it stays out of auto-graphed
  metrics). Cross-panel selection via `select_from:` reads existing
  per-panel state — no new framework hook. Live repaint via
  `onUpdate: scheduleRender` on the panel's hub subscription, so
  every new sample drives a paint regardless of whether the
  producer's `changed` flag flipped. PanelConfig.config dict in the
  parser plumbs plugin-specific YAML opts (`topic`, `select_from`,
  `metrics`, `window`) through to the panel def. See STATS.md.
- Action history — every operation through `streamCommand` (type:run,
  action-tabs, plugin shortcuts) plus `spawn`/`background` lifecycles is
  recorded with label/cmd/started/ended/exit/output (lines capped at
  200/4KB). New `history` panel type in core plugin: time | duration |
  exit | label, newest-first, Enter replays captured output into detail.
  Storage is the hub (`actions.lifecycle`).
- Single plugin init lifecycle — `registerPlugin(plugin, config)` calls
  `init()` once for both built-in and YAML-loaded plugins.
- Decorator framework (`decorators.js`) — slot-based plugin extension
  for any UI surface (rows, titles, tabs, footer halves). Zero overhead
  when no handlers register (~10 ns Map.get + branch). Slots:
  `row:left:*` / `row:right:*` (symmetric per-row), `title:*`, `tab:*`,
  `footer:left`, `footer:right`. Composition: per-slot separator,
  weight-based stable ordering, error isolation, outer truncation
  safety. Migrated existing inline status glyphs through the framework:
  container dot is now a `row:left:containers` decorator owned by docker
  plugin; group running-count + dot is a `row:right:groups` decorator
  owned by core plugin. Visuals unchanged; mechanism uniform.
  See DECORATORS.md.
- **Confirm overlay** — `action.confirm` is now a real y/N gate, not
  just the row annotation. `confirm.js` follows the copy.js pattern
  (one S flag, module-private callback + prompt). YAML `|` multi-line
  prompts render as multiple lines. test-confirm.js covers
  enter/exit/y/n/Esc/Enter and the runAction integration.
- **Action args plumbing** — `action.args` is no longer display-only.
  Two entry paths converge on the same `runAction(key, action, args)`
  signature:
    1. Cmdline (`:tail 50`) — `cmdline.js#splitQuery` splits the
       buffer at the first whitespace; tail becomes args, leading
       token fuzzy-matches a registry entry.
    2. Actions panel + Enter — when the focused action declares
       `args:`, dispatch.js opens a single-line `prompt.js` overlay
       (mirrors confirm.js: one S flag, module-private buffer +
       onSubmit, deferred via setImmediate). Submit forwards the
       parsed args; Esc cancels. Real terminal cursor lives inside
       the input row of the box.
  Shell delivery via `sh -c "$script" -- arg1 arg2 ...` (POSIX `--`
  delimiter so $0='--', $@=args) for `type: run` / `background`;
  `type: spawn` passes through both bare-spawn (argv) and tmux paths
  (POSIX single-quote escape into the new-window string).
  test-cmdline-args.js + test-prompt.js cover both paths.
- **Render races fixed** — (a) `showSelectedInfo()` skips when a
  stream is active, so cmdline-run actions don't paint info-text
  over the stream's reset detailLines; (b) `_wasOverlayActive`
  expression now includes `confirmMode` and `promptMode`, so
  event-driven renders (e.g. crashloop docker events) trigger a
  full repaint when the overlay closes — no more box residue.
- **Test harness** (`js/test/test-runner.js` + `js/run-tests.js`) —
  describe/it/section/assert/eq/report with exception isolation,
  per-section + per-test failure attribution. Discovery runner runs
  every `test-*.js` in its own node process. Six smoke tests
  retrofitted (151 checks across hub / decorators / multiselect /
  bulk-commands / docker-events / history). Zero npm deps.

**Features:**
- All panels navigable (↑↓ selection, info in detail)
- Mouse click to focus panel + select item (SGR mouse reporting)
- Detail panel tabs (`]`/`[`, click) — Info + action tabs + terminal tabs
- Normal/half/full view modes (`+`/`_`)
- `x` keybinding menu popup (overlay, ↑↓/Enter/Esc)
- `?` help in detail panel, vim keys (j/k/h/l)
- Design mode (`--design` + `d` — live layout editor)
- `desc` on all actions, `info()` on all dataclasses
- Config auto-reload (10s mtime check)
- Adaptive layout (shrinks on narrow terminals)
- Full-line reverse highlight (no inner markup)
- `/` search/filter for list panels (actions, file-manager, containers)
- Embedded terminal tabs (PTY + xterm-headless): SSH/SQL/REPL as detail tabs
  - YAML `terminals:` per group, sessions persist across group switches
  - `o` to focus, Enter to activate input mode, Ctrl+\ to exit
  - Auto-restart on Enter when shell exits (handles failed connects too)
  - Real cursor mirrors PTY position when typing
- Live output streaming for actions and action tabs (spawn + line buffer
  + 50ms debounced render, auto-scroll only when at bottom)
- Footer hints reorganized: Enter at end, only shown when bound
- Plugin onKey hook for per-item shortcuts; plugin keyHints in footer
- Docker plugin shortcuts on containers panel: `i` inspect, `t` tail logs,
  `s` shell (replaces planned `type: inspect` YAML approach — plugin-owned)
- Container shell `s`: ephemeral terminal tab via addEphemeralTerminal,
  per-container session keyed by name, persists across group switches
- Core panels (groups, actions, file-manager, detail) refactored into a
  single `corePlugin` registered via the plugin API. Framework now
  dogfoods its own API; adding new panel types is a plugin-only change
  (PRINCIPLES.md #5 fully satisfied)
- Plugin contract uniform across core + third-party:
  mode | render | getItems | getInfo | onKey | keyHints | filterable
- Container resource stats: full CPU+mem in detail panel; single batched
  docker inspect / docker stats per refresh
  (Inline CPU% next to the row was removed — too crowded; the detail
  panel is the right surface, and the decorator framework is the
  forward-looking way to put richer signal on rows when needed.)
- `:` command mode — vim/k9s-style modeline, fuzzy-resolves panels,
  current-group actions, theme/quit/refresh/help/focus commands.
  Plugins extend via `commands` array or `getCommands(S)`. See CMDMODE.md.
- Multi-select on list panels — Space marks the focused row, * marks
  all visible, Esc clears. Plugin contract addition: `idOf(item) → string`
  per panelType for stable identity. `selectedOrFocused(panelType, S)`
  is the operand resolver for bulk-capable plugin commands; same code
  path works for one or many.
- Docker bulk container commands — `:stop`, `:start`, `:restart`,
  `:inspect` (read-only). Each consumes `selectedOrFocused('containers',S)`.
- Docker live event streaming — long-running `docker events` subscription
  drives near-instant status updates instead of waiting up to 10s for
  the next poll. The 10s poll keeps running for stats refresh + safety
  net (events carry no cpu/mem). Idempotent stream startup, auto-reconnect
  on docker daemon restart.

**Bug fixes:**
- Panel renderer: truncation, border width, reverse bleed
- Rich markup escaping (`esc()` audit, 8 fixes)
- Shell injection in docker inspect (quoted names)
- Spawn action quoting (temp file approach)
- Footer literal `[` swallowed by markup parser — escape with `\[`,
  use visibleLen for padding
- Terminal overlay backspace: trimRight=false + pad to full width so
  shorter lines fully overwrite prior content
