# Changelog

All notable changes to lazytui are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning
follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — v0.3.0 surface (terminal-citizen polish)
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
