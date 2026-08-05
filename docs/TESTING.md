# lazytui — Testing

Three test layers, each with a different purpose. Run them all from
the repo root.

| Layer | What it covers | Where | How to run |
|---|---|---|---|
| Unit | TUI runtime + parser: state, dispatch, Components, hub, render helpers, YAML schema, resolver | `js/test/test-*.js` | `node js/scripts/run-tests.js -q` |
| Smoke | End-to-end scenarios on the real dispatch / render path — routing, lifecycle, hit-zones, action-tab, drag. Pre-release gate. | `js/test/smoke/` | `node js/scripts/run-smoke.js -q` |
| Integration | Live TUI against a real Docker stack + event paths | `test/` (run.sh + stack.yml + test.yml) | `test/run.sh up` then `test/run.sh tui` |

The unit layer is CI-friendly and runs in seconds. The smoke layer
runs in under a second and is the last gate before a release tag —
it catches the bug class the unit suite misses (paneId/type
comparator drift, stale viewer content on close, mouse hit-zone
offset, producer-survives-switch). Integration is hands-on (Docker
required) and is for exercising panels / terminals / event streaming
against real containers.

## Unit tests

Each test file runs in its own Node process so module state (hub
subscribers, plugin registry, fake timers) can't leak between files.
The harness in `js/test/test-runner.js` provides
`describe / it / section / assert / eq / report`.

```
node js/scripts/run-tests.js               # run all
node js/scripts/run-tests.js hub           # filter by name substring
node js/scripts/run-tests.js -q            # quiet — only show failing files
```

Per-file isolation means imports, `require.cache` resets, and global
mocks are local to one file. The discovery runner spawns each
`test-*.js` as a child process; aggregation happens in `run-tests.js`.

**Parser tests** live alongside the runtime tests as `test-parser-*.js`:
`test-parser-errors.js` (error hierarchy), `test-parser-resolver.js`
(variable + helper expansion), `test-parser-schema.js` (YAML schema
validation), `test-parser-pipeline.js` (end-to-end `parse()`). YAML
fixtures under `js/test/fixtures/` are reused across the parser suite.

Add a new test by dropping a `test-<topic>.js` into `js/test/`. Imports
to TUI modules use `../<module>`; the harness import is `./test-runner`
(sibling).

## Smoke

`js/test/smoke/` houses end-to-end scenarios that drive the real
`dispatch` / `render` path. Each scenario boots the full app
(through the same `bootFresh` helper at `_helpers/smoke.js`), feeds
input via `handleKey` / `handleMouse` / `applyMsg`, and asserts on
the model state plus the captured rendered frame.

```
node js/scripts/run-smoke.js               # run all
node js/scripts/run-smoke.js routing       # filter by name substring
node js/scripts/run-smoke.js -q            # quiet — only show failing files
```

The scenarios target the bug class the unit suite misses:

- **`routing.js`** — `paneId` vs panel-type comparator invariants
  for every placed pane (covers post-Phase-B3 `getFocus()`-is-
  paneId discipline + the docker-style Component-name fallback).
- **`lifecycle.js`** — content-tab open → focus → switch → close
  with no stale content lingering on the fallback path.
- **`hit-zones.js`** — `[x]` close glyph painted column matches
  `tabBounds.closeX` (paint-vs-hittest cross-check), plus off-by-
  one brackets on both sides of `closeX`.
- **`drag.js`** — free-config in-grid drag driven through
  `dispatchMsg(wrap('layout', free_config_mouse_*))` end-to-end.
- **`boot.js`** — the deterministic first frame renders (guards the
  render-queue self-register boot order).
- **`pty-overlay.js`** — the embedded-terminal overlay repaints under
  the async PTY race (the #D15 model-conditional poll backstop).
- **`dual-viewer.js`** — multi-viewer layouts (≥2 content slots) render
  + route to the right pane.
- **`multi-instance.js`** — same-kind multi-pane slice isolation (the
  strict-miss / `_primaryByKind` class).
- **`mouse-raw-sgr.js`** / **`mouse-gestures.js`** — SGR mouse parsing
  and the gesture→intent mapping (press / double / right / wheel).
- **`pane-select.js`** — mouse drag-selection end-to-end: register +
  clipboard push, the selected span carrying the theme's `selected`
  style in the real frame.
- **`agent-pane.js`** — `:agent` mint → chrome/status/draft-ghost →
  a full mock-backend turn streamed into the transcript.
- **`fabric-panes.js`** — ports/wires panes over a demo fabric:
  retarget-follows-focus, wire list, not-ready guards.
- **`replay.js`** — record → fold-the-WAL → reconstructed model
  equivalence (the replay determinism gate).
- **`stats-graph.js`** — stats pane end-to-end (truecolor arc): braille
  graph + gradient color + meter reach the real frame; canonical `38;2`
  bytes at truecolor depth and ZERO at depth 16 (the write-boundary
  downgrade proven on real output — this assertion caught two real
  funnel bypasses, footer and cmdline/pane-menu).
- **`nav-follow.js`** — keep-in-view scroll follows the cursor WITHIN
  one gesture: single steps down past the fold and back up, plus
  bottom/top jumps, each asserting the frame shows exactly the cursor's
  row highlighted (the applyMsg nav-gate regression class).
- **`input-burst.js`** — batched stdin chunks through the REAL data
  handler: an autorepeat burst dispatches every key and paints ONCE
  (the network-lag class), batched arrow-key chunks dispatch instead
  of dropping whole, and a sequence split across chunks rejoins via
  the tokenizer carry; the single-key chunk still paints synchronously.
  Review hardening (2026-08-05): an ESC flood is inert instead of
  crashing, an orphaned escape prefix can't eat the following arrow,
  X10 mouse coordinates never reach the key ladder, a terminal-mode
  flip forwards its pending carry to the PTY, and batched terminal-mode
  chunks match `Ctrl+\` / scrollback keys per-event (with the rest of
  the chunk re-entering the normal ladder after an exit).

- **`terminal-exit-repaint.js`** — the shell-in-a-tab lifecycle with a
  REAL PTY: while the shell runs, the content slot keeps its unified
  tab strip (Info/Transcript stay visible); a typed `exit` triggers the
  pty-lifecycle fan-out (mode exit + tab auto-close + repaint); and a
  BATCHED press+release click on a dead full-zoom terminal exits the
  mode AND paints a frame (the swallowed-trailing-paint regression
  class — a force-full inside the batch window must not replace the
  trailing paint).

Add a new scenario by dropping a `<name>.js` into `js/test/smoke/`;
the aggregator at `js/scripts/run-smoke.js` discovers it. Each
scenario imports the helper as `./_helpers/smoke` and uses
`sm.bootFresh()` / `sm.capture()` / `sm.step()` etc.

The smoke harness is **opt-in**, not part of CI's default unit pass.
Run it before tagging a release; a failure is a release-blocker.

## Integration / live stack

`test/` ships a synthetic Docker compose stack purpose-built to exercise
the TUI: a long-running healthy container, a flood of log output, an
exited container ready to be re-started, and (with `--profile chaos`) a
crashloop generator.

```
test/run.sh up               # base stack
test/run.sh up all           # base + chaos profile
test/run.sh ps               # check status
test/run.sh tui              # launch TUI against test.yml
test/run.sh tui --list       # any TUI flag forwards through
test/run.sh down             # tear everything down
```

Run docker commands from another shell to exercise event paths:

```
docker kill   tui-test-running
docker pause  tui-test-running && docker unpause tui-test-running
docker stop   tui-test-flood
docker start  tui-test-exited
```

This layer is not run in CI — it requires a Docker daemon and is for
verifying that real PTY / event-stream / decorator behavior matches
what the unit tests stub.

## Naming

- `js/scripts/run-tests.js` — discovery + sequencer (entry point you invoke).
- `js/test/test-runner.js` — assertion harness imported by each test.

The two never get confused at runtime: the runner is the orchestrator,
the harness is the framework.
