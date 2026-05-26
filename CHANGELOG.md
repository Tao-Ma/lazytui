# Changelog

All notable changes to lazytui are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning
follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **`LAZYTUI_PATH` version trampoline.** When set in the environment,
  every `bin/lazytui` re-exec's against the lazytui checkout at that
  path instead of the locally-installed one. Lets a consumer project
  (e.g. `~/exchange/pg-tui`) point at an in-development lazytui
  (`~/exchange/lazytui`) without npm install/publish churn, then
  `unset LAZYTUI_PATH` to fall back to whatever the consumer
  shipped with. Same-directory guard prevents infinite re-exec when
  the path resolves to the current install. Fails loud (exit 1, error
  on stderr) when set to a non-directory or a directory missing
  `js/tui.js`, so misconfiguration can't silently fall through to the
  wrong version.

## [0.3.0] — 2026-05-24

### Changed
- **`type: spawn` no longer depends on tmux for non-blocking
  execution.** Outside tmux, spawn now opens an ephemeral PTY tab
  in the detail panel (reusing the existing node-pty +
  @xterm/headless infrastructure that already backs `terminals:`
  blocks) and sets `S.viewMode = 'full'` so the child gets the
  whole terminal via the already-shipping full-screen view.
  Multiple concurrent spawns each get their own tab. The user can
  step back to the normal layout with `_` while the child keeps
  running; `+` re-zooms; clean exit auto-closes the tab and drops
  back to normal layout; non-zero exit keeps the tab so the error
  is readable but drops the zoom so the rest of the TUI is
  reachable. The tmux branch (`process.env.TMUX` set) is kept as
  an opt-in tier — a real OS-level new window is still preferred
  for long-lived interactive sessions, and existing users who
  already run lazytui under tmux see no change.
  - Replaces the prior `suspendTerminal` / `spawnSync(stdio:
    'inherit')` / `resumeTerminal` dance, which blocked Node's
    event loop for the child's entire lifetime — refresh ticks
    and hub publishers were frozen, and the user couldn't
    navigate to other panels until the spawned command exited.
  - `terminal.js#onExit` factored into a new exported
    `_onSessionExit(id, exitCode)` so the view-reset behavior is
    unit-testable without mocking node-pty. `tabs.handleSession
    CleanExit` is unchanged.
  - On session exit (clean, non-zero, or signal like SIGQUIT
    from Ctrl+\), `_onSessionExit` calls `forceFullRepaint()`
    when the exiting session was the user-visible one. Without
    it, the diff cache held the PTY-painted cells as "unchanged"
    and skipped them — chrome behind the dead PTY never redrew,
    leaving the last frame stuck on screen. Same diff-cache-
    reclaim pattern as the SIGCONT/suspend path.
  - **Ctrl+\ drops viewMode='full' along with terminal mode.**
    In `input.js`, Ctrl+\ is intercepted before reaching the
    PTY — it just toggles `S.terminalMode = false` so the user
    can navigate via lazytui keys while the child stays alive.
    Pre-v0.3.0, that was enough because PTY tabs lived in
    `viewMode='normal'`. With auto-zoom from `type: spawn`,
    keeping `viewMode='full'` after Ctrl+\ left the user in a
    chrome-less full-screen detail panel with no PTY input and
    no obvious way out. The handler now also drops the zoom and
    forces a repaint. Same fix applied to the sibling "session
    already dead" branch.
  - **Tab keys use a monotonic counter** —
    `spawn-<actionKey>-<ts>-<seq>` — so two spawns of the same
    action within a single millisecond produce distinct tabs.
    Without it, `addEphemeralTab` silently reused the existing
    tab and its dead PTY session.
  - **Child-lifecycle note (PTY-tab path only).** Because the
    embedded PTY session lives as a child of the lazytui Node
    process, the spawned child dies when lazytui quits — same
    contract as lazygit / lazydocker / k9s subprocesses. The
    tmux branch (`$TMUX` set) keeps its old detach-survival
    semantics: child runs in a sibling tmux window and outlives
    lazytui. If you need detach-survival without tmux, wrap the
    script in a session manager (`tmux new-session -d`,
    `dtach`, `abduco`). There's no in-process node-pty trick
    that gives both an embedded display and survive-quit —
    the PTY master fd in our process is the child's lifeline,
    so when it closes the slave gets SIGHUP.
  - Tests: replaces `test-spawn-bare.js` (which pinned the old
    blocking semantics) with `test-spawn-pty-tab.js` — 21
    assertions across 5 sections covering the new path, the
    tmux path still routing through `tmux new-window`, and the
    onExit view-reset for clean / non-zero / non-active-session
    cases.

- **Parser rewritten from Python to JS — lazytui is single-runtime now.**
  The Python parser (`parser/`, 1124 LOC) and its pytest suite (`tests/`,
  1101 LOC) are deleted. Replaced by an in-process JS parser at
  `js/parser/` (~700 LOC) backed by `js-yaml` for YAML loading; the
  ported test suite lives at `js/test/test-parser-*.js` (88 cases
  across 4 files). The runtime path swaps `python -m parser` for
  `require('./parser').parse()` — saves an out-of-process spawn on
  every TUI launch and removes the dual-runtime install story.
  - **`bin/lazytui`** drops the `.venv/bin` PATH shim — no Python
    needed at runtime.
  - **`package.json`** adds `js-yaml ^4.1.1` as a runtime dep
    (alongside `node-pty` and `@xterm/headless`), and flips
    `"private": true` → `false` now that the dual-runtime install
    story is gone. `npm publish` passes its CLI guard; the actual
    publish to npmjs.com is still a separate manual step (no
    `release.yml` automation yet — see RELEASING.md).
  - **CI** drops the "Set up Python / install pyyaml / run pytest"
    steps from both `.github/workflows/test.yml` and `release.yml`.
    `requirements.txt` and `pytest.ini` are removed.
  - **Output parity**: a differential harness (parse the same YAML
    through both parsers, deep-diff JSON output) ran on every
    fixture + both demos before deletion — 14/14 identical, including
    error-message strings for schema and resolution failures. State.js
    consumes the same JSON shape unchanged.
  - **Test fixtures** moved from `tests/fixtures/` to
    `js/test/fixtures/` so the JS suite owns them.
  - **Docs** updated: README, DEMO, CONTRIBUTING, RELEASING,
    docs/TESTING, docs/SPEC drop their Python-prereq references.
    History entries in CHANGELOG.md describing the prior dual-runtime
    state are left intact as a chronological record.

- **Design Mode v2 (Phase 3 follow-up): per-panel `heightPct` +
  corner drag + keyboard `[`/`]`.** Drag-to-resize extends from
  two single-axis seams (column separator + detail top) to every
  same-column horizontal boundary, plus a corner handle at the
  col-separator × column-boundary intersections that adjusts both
  axes in one gesture.
  - **Per-panel `heightPct` (YAML).** New optional key on any
    non-detail panel — fraction of the column's total height.
    Panels that set it are anchored; panels that don't are flex
    and share whatever's left in their column equally. Existing
    YAMLs without `heightPct` behave exactly as before
    (equal-share). Oversubscribed sums scale proportionally;
    every panel still meets `minH=3`. Detail keeps its own
    `detailHeightPct` knob (layout-level), unchanged.
  - **Every same-column boundary is draggable.** New
    `boundaryNear()` hit-test runs on press. Drags between two
    non-detail panels mutate both `heightPct` values; drags
    involving detail mutate `detailHeightPct` (clamped [20, 90])
    and the non-detail neighbor's `heightPct`. D1 semantics:
    `freezeColumnFlex` runs on press so siblings keep their
    displayed height instead of redistributing mid-drag and
    outrunning the cursor.
  - **Corner handle.** At intersections of col-separator × any
    column boundary (left or right), the press dispatches
    `resizing-corner`; motion fires both `applyColResize` and
    `applyBoundaryResize` per event. One diagonal gesture moves
    `leftWidth` + the column boundary together.
  - **Keyboard `]` / `[`.** Grow / shrink the focused non-detail
    panel's `heightPct` by 5 pp, stealing from the panel below
    (mirrors drag D1). Detail keeps `+`/`-`. No-op at the last
    position in a column. Footer learns the binding:
    `+/- col/detail · [/] panel h`.
  - **docs/LAYOUT.md** grows a "Resizing panels (design mode)"
    section with drag-target and keyboard tables; the YAML
    example shows `heightPct`.
  - **Tests:** new sections `[3a]`–`[3f]` in
    `js/test/test-design-phase3.js` cover within-col boundary
    drag, corner drag on both sides, freeze-on-press, `calcLayout`
    distribution math (anchored / flex / oversubscribed), and the
    `]` / `[` keys (grow, shrink, detail-skipped, last-position
    no-op, detail-clamp). 97 assertions across 41 cases.

- **Design Mode v2 (Phase 3): undo/redo, drag-to-resize, title edit,
  and `:restore-layout`.** Four features stacked on top of Phase 2:
  - **Drag-to-resize separators.** Mouse press on the column boundary
    (`x ≈ leftWidth`, ±1 cell tolerance) drags `leftWidth` with the
    cursor. Press on the detail-panel top border (`y === panelBounds.detail.y`)
    drags `detailHeightPct`. Both clamp to the same ranges as the
    keyboard `+/-` keys (20–60 for `leftWidth`, 20–90 for
    `detailHeightPct`). Hit-test runs BEFORE the panel-drag arming
    so the separator (which visually sits on a panel border) is
    reachable.
  - **Edit panel title in place.** `t` in design mode enters a
    sub-mode that buffers keystrokes against the focused panel's
    title; Enter commits, Esc cancels. A new `S.designTitleEditMode`
    flag sits ABOVE `S.designMode` in the dispatch chain so design's
    main key handler is skipped while editing.
  - **`:restore-layout` cmdline.** Discards runtime layout changes
    and reloads the `layout:` block from the YAML config file.
    Clears `S.layoutDirty` and the design-mode undo history (the
    new layout is unrelated to anything in the stacks). Companion to
    `:save-layout`; both share the new pure-function
    `rebuildLayoutFromConfig(config)` extracted from `state.js#initState`.
  - **Multi-step undo / redo within a design-mode session.** Every
    layout mutation pushes a snapshot to an in-memory stack (cap 50).
    `u` pops to undo, `Ctrl+R` redoes. Drag gestures push exactly one
    snapshot per gesture (on press), not per motion event. Stack is
    session-scoped: cleared on `enterDesign` and on `:restore-layout`.
    A new mutation after an undo invalidates the redo stack (the
    branched-off timeline no longer applies).
  - Footer hints expanded inline: `Design Mode | drag move/resize |
    J/K reorder | ←→ swap col | +/- resize | t rename | u undo |
    C-r redo | :save-layout | q exit`.
  - Input layer: `\x12` (Ctrl+R) now translates to a named `'ctrl-r'`
    key event in `js/input.js`, alongside the existing `\x03 → exit`
    handling. Currently only design mode acts on it.
  - Tests: new `js/test/test-design-phase3.js` (57 assertions across
    6 describe blocks) covers hit-test math, drag-resize gestures,
    undo/redo round-trip across all mutation types, title-edit buffer
    handling, and `rebuildLayoutFromConfig` purity.

- **Design Mode v2 (Phase 2): drag-and-drop in the real layout.**
  The centered modal overlay is gone. Mouse press on any panel
  inside design mode arms a drag; ≥1 cell of motion enters dragging
  state and paints a green/red insertion line across the target
  column where the panel will land. Release commits the move
  (sets `S.layoutDirty`) or snaps back (invalid target — detail or
  actions into the left column). Keyboard bindings stay (`↑↓ J/K
  ←→ +/-`) — mouse is additive, not replacing.
  - SGR mouse mode 1002 is now enabled at startup (motion-while-held).
    Cost is bounded: terminal only reports motion when a button is
    down. Press → motion+ → release events now fan out through
    `input.js#handleMouse`; non-design code paths still only act on
    press (existing focus+select behavior unchanged).
  - Drop-target math: top half of a panel = insert before, bottom half
    = insert after, below the last panel in a column = append. Empty
    column drops at index 0. Detail and Actions panels are blocked
    from the left column with a footer reason; the insertion line
    paints red instead of green over the blocked target.
  - Design-mode footer now surfaces the affordance hints inline
    (`drag move | J/K reorder | ←→ swap col | +/- resize |
    :save-layout | q exit`) so the discovery path doesn't need
    external docs.
  - Tests: new `js/test/test-design-drag.js` (44 assertions) pins
    state machine transitions (press → armed → dragging → release),
    drop-position math (top/bottom half, append, empty column,
    invalid column), and cross-column splice/insert math with
    same-column-index adjustment.

- **Design Mode v2 (Phase 1): save is decoupled from mode exit.**
  Hitting Enter inside design mode no longer writes to YAML; neither
  does `q`/`Esc`. Mutations apply to `S.layout` at runtime and the
  footer shows `• unsaved (:save-layout)` while they differ from the
  on-disk config. To persist, run the new `:save-layout` cmdline
  command. Rationale: makes the editing surface a free-form
  experiment-and-tweak space (live tweaker UX) without conflating
  exit with commit. A future `:restore-layout` will revert runtime
  state to the YAML's contents; for now, restart the TUI to re-read
  from disk.
  - Lossy save is fixed in passing. `:save-layout` writes through a
    new `js/yaml-layout.js` module whose `serializeLayout()` walks
    every key on each panel object except runtime-derived ones
    (`hotkey`, `column`, `config`) and the detail panel's synthesized
    `height`. Plugin panel keys (`topic`, `select_from`, `decorators`,
    `refresh_interval_ms`, custom plugin options) survive the round
    trip — previously they were silently dropped, breaking the stats
    panel's hub subscription on any save.
  - `S.layoutDirty` tracks divergence from disk; set by every
    layout-mutating handler in `design.js`, cleared by
    `:save-layout` on success.
  - Phase 2 (drag-and-drop in the real layout, replacing the centered
    modal overlay) is planned but not in this commit.
  - Tests: `js/test/test-yaml-layout.js` covers scalar emission,
    per-panel key preservation, full emit→write→reparse round-trip
    through the Python parser, and the existing-block splicer.

### Fixed
- **JS-plugin loading was a silent no-op (parser-port regression).**
  The JS parser-port from earlier in v0.3.0 dropped the `plugins:`
  block from `parse()`'s returned config — `loadPlugins(S.config.plugins,
  ...)` received `undefined` and iterated zero entries, so JS plugins
  (`path: ./foo.js` style) never `require()`d and never registered
  their panel types. Layouts that referenced a JS-plugin-provided
  panel type rendered the slot as an empty string; in `paintColumns`
  the short-left-output then concatenated the right column's bottom
  rows into the empty left rows, painting the detail panel under the
  groups panel at column 0 with right-column width. YAML plugins
  (`.yml`/`.yaml` paths) were unaffected because `mergeYamlPlugins`
  inlines their content into groups/vars/files before validation.
  The differential parser test that gated the JS port passed only
  because neither postgres nor cloudberrydb demo uses a `.js` plugin
  path — the codepath had no fixture coverage. Fix: include
  `data.plugins || {}` in `parse()`'s return; two regression tests
  pin the round-trip and the no-plugins-block → `{}` contract.
  Surfaced by the ssh-fleet demo, which is lazytui's first JS-plugin
  user.

- **Cmdline (`:`) polish from manual testing.** A cluster of
  user-reported glitches in the cmdline dropdown and bare-Esc
  dispatch, fixed in sequence as they surfaced:
  - **Bordered dropdown panel + theme integration.** The match
    list used to paint raw `\x1b[7m` / `\x1b[2m` rows directly
    onto the cells beneath, with no border or separator — read
    as visual bleed-through against whatever panels happened to
    sit at the bottom of the screen. Now renders through
    `renderPanel` (same helper menu / design overlays use):
    bordered box, themed chrome, count badge (`<sel>/<total>`),
    centered horizontally just above the prompt row. Selection
    follows PRINCIPLES.md §8 — outer `[reverse]` wraps the
    whole row, no inner style nesting.
  - **Width scales with the terminal.** The previous 80-col cap
    left a small box hovering in unused space on wide
    terminals. New formula `panelW = max(40, COLS - 4)` bottoms
    out at 40 on narrow terminals and grows with everything
    else.
  - **Clean shrink residue.** When the match set shrunk
    (additional chars narrowed matches), the previous frame's
    taller panel left ANSI residue on rows the new panel no
    longer covered — the underlying panels' diff cache had no
    reason to think they'd been touched. New
    `layout.invalidateRows(startY, endY)` empties the per-row
    diff cache for the affected range so the next render
    repaints from the panels below; `cmdline.js` also blanks
    those rows synchronously so the current frame stays clean.
    `invalidateRows` is reusable by any future overlay with a
    similar incremental-shrink pattern.
  - **Collapse newlines in match desc.** YAML `desc: |` block
    scalars carry literal `\n`. The dropdown formatter passed
    them through to `renderPanel`; `truncate()` counted `\n` as
    width 1 but the terminal honored it as a real line break,
    so the right border dropped onto its own row. Whitespace
    runs in both `display` and `desc` are now collapsed to
    single spaces in `formatMatchLine` — the single-line
    guarantee is enforced at the formatter, not relied on from
    the data source. Full multi-line desc still renders
    untouched in the Info panel.
  - **Bare Esc dispatch (input layer).** Pressing Esc inside
    cmdline sometimes didn't exit. Some terminals + Node
    stdin buffering states deliver bare Esc as `\x1b\x1b`
    (the legacy literal-Esc trick) or `\x1b<followup>` (Esc
    plus a buffered keypress in one chunk); the strict
    `data === '\x1b'` check on `input.js` only matched a clean
    single-byte chunk. Defensive fallthrough now treats any
    chunk that starts with `\x1b` and survived all the
    specific-sequence checks (focus events, paste, SGR mouse,
    arrow keys, PgUp/PgDn, Ctrl+R) as `'escape'`. Trailing
    bytes are discarded — lazytui has no Alt/Meta bindings.

- **`type: spawn` actually works outside tmux now.** Previously, the
  no-tmux branch ran the script *detached* with `stdio: 'ignore'`, so
  interactive subprocesses (`psql`, `less`, `$EDITOR`) got `/dev/null`
  for stdin/stdout and silently exited — making the action feel like
  it "had no effect". The fix mirrors the SIGTSTP dance from
  `suspend.js`: suspend the TUI's terminal modes, hand the child our
  TTY synchronously (`spawnSync` with `stdio: 'inherit'`), then
  restore. Suspend/resume primitives are factored into
  `suspend.js#suspendTerminal/resumeTerminal` so both call sites stay
  in sync. The detail panel now also reports the child's exit status
  (clean, non-zero, signal, or spawn-error), so a quick failure is
  no longer indistinguishable from a no-op. Regression test in
  `js/test/test-spawn-bare.js`.

### Considered but not shipped for v0.3.0
- **Printf-above-program output.** Persistent messages printed above
  a TUI's main render area need altscreen — lazytui doesn't use it
  (deliberate — leaves prior shell content visible after quit) so
  the "above" concept doesn't translate. The detail panel +
  `streamCommand` already cover the underlying use case (streamed
  action output landing somewhere visible and persistent).
- **External event injection.** Useful for IPC and test harnesses,
  but every implementation (HTTP server, Unix socket, named pipe)
  adds attack surface for a feature with no concrete user demand
  yet. The key-filter middleware (above) already covers the
  in-process injection case for tests. Defer until a real use case
  surfaces.
- **Embeddable widget library + declarative styling DSL.** Big
  architectural moves from the earlier feature audit. Each is a
  v1.0-scale undertaking; deferred deliberately.

### Added — v0.3.0 surface (terminal-citizen polish)
- **Component API — strict TEA-shaped alternative to Plugin.** New
  `api.registerComponent(component)` registers a plugin whose state
  is framework-owned (slice per Component), messages flow through
  `update(msg, slice) → newSlice`, and render functions receive the
  slice (not the global `S`). Coexists with `registerPlugin` —
  every existing plugin keeps working unchanged. Plugin authors
  pick per-plugin: Plugin for the fast-path (mutate-S, simple) or
  Component for the discipline (replay, snapshot tests, isolation).
  See PRINCIPLES.md §12 for the contract.
  - Framework wiring: registration validates `init` + `update`,
    init runs at register time, panel types tracked separately
    from Plugin panel types, decorators / statusFor reused as-is.
  - Msg dispatch: every key (via `dispatch.handleKey`), refresh
    tick (via `refreshAll`), hub publish (via `hub.publish`), and
    action invocation (via `actions.runAction`) fans out to every
    Component's `update()`. Msg shape mirrors event-log entries.
  - Update isolation: a Component's update() throw is logged and
    that Component's slice stays put; other Components keep
    processing the same Msg.
  - Render integration: `layout.rendererFor(type)` checks the
    Component-owned panel map first; falls through to the
    Plugin-owned path if no Component claimed the panelType.
  - Tests: `js/test/test-component.js` (15 assertions) covers
    registration validation, init-at-register, Msg fan-out, return
    shapes (new slice / undefined / throw), and component-panel
    render wiring. JS suite now 21/21 (was 20).
- **Key-filter middleware.** `dispatch.registerKeyFilter(fn)` adds a
  pre-dispatch hook. Each filter receives `{key, seq}` and may
  return the (possibly modified) event, the event unchanged, or
  null to suppress. Filters run in registration order; the dispatch
  layer logs + dispatches whatever survives the chain. Use cases:
  keyboard remapping (vim-mode hjkl → arrows), key throttling /
  debouncing, pre-dispatch analytics, test instrumentation. New
  test file `js/test/test-key-filters.js` (13 assertions).
- **Per-plugin refresh cadence.** Plugins gain optional
  `refreshIntervalMs` (default 10000). New
  `plugins/api.startRefreshLoops(config, opts)` starts a self-scheduling
  setTimeout *per plugin*, with overlap-skip (if a previous tick is
  still running, skip the new one) and focus-gating (via the
  `isFocused` callback the caller passes — keeps api.js
  state.js-agnostic). Stats plugins that want ~1s ticks can declare
  it; rare-poll plugins (image archives, config branch) can declare
  5min and stop wasting CPU. Replaces the previous single 10s
  refresh-everything loop in tui.js. `refreshAll()` is preserved for
  one-shot use (initial paint + `:refresh` cmdline).
- **Suspend / resume (SIGTSTP / SIGCONT).** Ctrl+Z used to corrupt
  the terminal (raw mode + mouse + focus reporting all stayed on
  for the shell). New `js/suspend.js` installs the standard Unix
  dance: on SIGTSTP, restore the terminal then re-raise the signal
  so the kernel actually stops the process; on SIGCONT, re-enter
  raw mode, re-enable mouse/focus/paste, hide cursor, invalidate
  the render diff cache, repaint. Embedded PTY children get SIGCONT
  automatically. No-op on Windows.
- **Live debug log stream (`LAZYTUI_LOG=path`).** Event log gains
  `attachStream(path)` / `detachStream()` and an auto-attach from
  the `LAZYTUI_LOG` env var at module load. Every recorded event
  also gets a JSON line appended to the file via `appendFileSync`
  (sync writes at TUI event rates are ~3 kB/s — negligible vs
  stream complexity). Tail with `tail -F` in another window for
  live diagnostics.
- `layout.js` exports `forceFullRepaint()` — resets the diff cache
  so the next `render()` does a full clear + redraw. Used by the
  SIGCONT handler; future use cases include returning from any
  external subprocess that scribbled on the screen.
- **Focus / blur events (DEC 1004).** `\e[?1004h` enabled at startup;
  `\e[I` and `\e[O` parsed in `input.js`. `S.focused` defaults to
  true (so terminals without focus reporting still refresh). The
  `refreshLoop` in `tui.js` skips its `refreshAll()` call while
  blurred — saves CPU + docker API calls while the user has tabbed
  away. On focus return, `scheduleRender()` paints the cached frame
  immediately; the next loop iteration runs the real refresh.
- **Bracketed paste (DEC 2004).** `\e[?2004h` enabled at startup.
  Pasted multi-line blocks arrive wrapped in `\e[200~ ... \e[201~`;
  `input.js` collapses each into a single `paste` key event with
  the inner text in `seq`, instead of dispatching per-byte. Mode
  handlers that want the multi-line content (prompt, cmdline) read
  the seq arg; other modes ignore.
- `js/term.js` gains `enableFocusEvents` / `disableFocusEvents` and
  `enableBracketedPaste` / `disableBracketedPaste`. Both disabled
  in `cleanup.js` for clean terminal restore on exit.

### Added — v0.2.0 surface (TEA-inspired discipline)
- **Event log recorder (`js/event-log.js`).** In-memory ring buffer
  capturing input events: key presses (via `dispatch.handleKey`),
  hub publishes (via `hub.publish`), refresh ticks (via
  `plugins/api.refreshAll`), and action invocations (via
  `actions.runAction`). Default cap 500 events (~50 kB). Exposes
  `record / enable / setCap / clear / snapshot / size / save`. The
  `save(path)` helper serializes to JSON with a version header,
  suitable for attaching to bug reports. Foundation for the planned
  replay path; deliberately producer-only in v0.2.0 — see "Pending
  for v0.2.x" below.
- **Render idempotence principle (PRINCIPLES.md §11).** A panel's
  `render(panel, w, h, S)` called twice with the same inputs produces
  the same output. Articulates the actual discipline lazytui follows
  (weaker than strict purity — layout writes derived state, stats
  panel lazy-subscribes to the hub on first render — but stronger
  than "anything goes"). New checklist bullet in §12.
- **`js/test/test-event-log.js`** — covers the ring buffer, enable
  / disable gate, JSON save round-trip, and the wired hub +
  refreshAll hooks (key + action hooks are exercised indirectly by
  the existing dispatch + cli test suites). 22 new assertions; JS
  suite now 19/19 (was 18/18).
- **`js/test/test-render-idempotent.js`.** Exercises representative
  core plugin renders (groups, actions, detail, file-manager,
  history) twice per panel under two focus configurations. 15 new
  assertions; total JS suite now 18/18 (was 17/17). Docker, stats,
  config-status skipped: docker needs runtime status setup; stats +
  config-status have known idempotent-but-impure lazy-init that is
  covered separately by their existing tests.

### Removed
- **tidb demo (parseable-only) dropped from advertised support.** The
  in-flight `dev-demo-tidb` branch is removed from `origin`. v0.1.0's
  CHANGELOG entry referenced "tidb on `dev-demo-tidb` branch awaiting
  live-test merge"; that was overpromising for a release that hadn't
  verified the demo on Docker. Restored as a future demo once a real
  use-case drives it (and once a live test actually runs).

### Changed
- README's demos table column renamed `Notes` → `Status`, and the
  cloudberrydb row now reads "YAML parses; live build not yet
  verified" instead of "live build deferred." More upfront for a
  first-time visitor.

## [0.1.0] — 2026-05-18

First public tagged release.

### Framework
- Renderer (Node.js, zero npm runtime deps except `node-pty` and
  `@xterm/headless` for embedded PTY tabs).
- Parser (Python, validates and resolves the YAML config).
- 17 JS smoke suites + 6 pytest files. Live integration harness
  under `test/`.
- Built-in panel types: `groups`, `actions`, `file-manager`,
  `history`, `detail`, plus `containers` and `stats` from the
  docker plugin.
- Subsystems: hub (pub/sub), decorators (UI slot framework),
  cmdline (`:`) verbs, embedded PTY terminals, 6 themes, design
  mode, CLI mode (`--exec`, `--list`), `--spec` bundle for AI
  agents.

### Demos
- `demo/postgres` — Shape A (build from source). Verified end-to-end
  on Docker. Includes a `POSTMORTEM.md` documenting the DinD
  bind-mount discovery and the "fix the prompt, not the artifact"
  two-layer fix that resulted.
- `demo/cloudberrydb` — Shape B (wrap upstream's `devops/sandbox/`).
  YAML parses; live build deferred. `POSTMORTEM_v1.md` captures the
  drop-and-rewrite decision when the first producing pass diverged
  from upstream's actual conventions.
- `demo/tidb` — Shape A variant (orchestrate pre-built `pingcap/*`
  images). Lives on the `dev-demo-tidb` branch pending a live-test
  merge.

### Docs
- `README.md` — positioning, ASCII TUI mockup, quickstart, comparison
  table against Make / shell / Taskfile, three-demo table, "Read next"
  with split for using vs contributing.
- `DEMO.md` codifies the two demo shapes and the loop discipline.
- `docs/` subtree: framework + plugin authoring (SPEC, PRINCIPLES,
  PLUGINS, PROJECT, LAYOUT, HUB, DECORATORS, CMDMODE, TERMINAL,
  STATS, TESTING). `docs/history/` for the dev9-era retrospective and
  FUTURE backlog.
- Standard OSS files: `CONTRIBUTING.md`, `CHANGELOG.md`,
  `SECURITY.md`, `CODE_OF_CONDUCT.md`, `LICENSE` (MIT).

### Release plumbing
- `.github/workflows/test.yml` — JS + pytest CI on push / PR.
- `.github/workflows/release.yml` — on `v*.*.*` tag push, runs
  tests, builds `lazytui-X.Y.Z.tgz` (npm-style) +
  `lazytui-X.Y.Z-source.tar.gz` (full git-archive), creates a
  GitHub Release with both tarballs attached.
- `RELEASING.md` documents the maintainer flow.
- `package.json` ready for publish; `private: true` retained until
  the dual-runtime npm-install question is resolved.

### Pre-tag history
The single-commit public state at `b384d19` (2026-05-15) was the
first form of lazytui visible on GitHub. v0.1.0 is the first state
with a semantic version, a CHANGELOG entry, and downloadable
release tarballs. Full pre-squash development history is preserved
on the internal gitea mirror under the `backup/main-history` branch
and the `v0.1.0-pre-squash` tag.

[Unreleased]: https://github.com/Tao-Ma/lazytui/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Tao-Ma/lazytui/releases/tag/v0.3.0
[0.1.0]: https://github.com/Tao-Ma/lazytui/releases/tag/v0.1.0
