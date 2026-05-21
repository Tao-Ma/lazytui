# Changelog

All notable changes to lazytui are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning
follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
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

[Unreleased]: https://github.com/Tao-Ma/lazytui/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Tao-Ma/lazytui/releases/tag/v0.1.0
