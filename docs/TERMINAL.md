# Terminal Subsystem

Embedded interactive PTY sessions (SSH, SQL REPL, a spawned long-running
command) shown as a tab in the viewer pane. Backed by `node-pty` (real PTY)
+ `@xterm/headless` (the emulator/screen buffer). No tmux knowledge required.

This is the **reference FOREIGN COMPONENT (`#D14`)** — an explicitly non-TEA
island. Two documents own the contract; this file is the subsystem map:

- `docs/foreign-components.md` — the foreign-component contract (terminal is its
  reference implementation).
- `js/io/terminal.js` header — the per-module statement of the mechanism.
- `docs/v0.6.6-replay-readiness.md` — why the screen contents are outside replay.

## The split: lifecycle in the model, contents in xterm

`js/io/terminal.js` is a **true leaf** — its only requires are `node-pty` +
`@xterm/headless`; it reaches nothing upward (no app model, no panel/api, no
render, no jobs). It owns a `sessions` map of `{ pty, xterm, cmd, cwd, exited,
exitCode, jobId }`.

- The **model** holds the PTY *lifecycle*: which tab is a terminal, its
  `cmd`/`cwd`, whether it's placed/active. Reconstructible by replay.
- The **`@xterm/headless` buffer** holds the *contents*. PTY `onData` writes
  that off-model buffer and triggers a repaint via the injected `_renderHook`,
  **bypassing the Msg loop** — funnelling every PTY byte through a Msg would be
  heavy and redundant (xterm.js *is* the emulator).
- Consequence (bounded, documented): replaying the Msg log reconstructs the
  model but NOT the terminal screen — the `#D5`/`#D14` replayability boundary.

## Injected hooks (boot wiring)

Everything `io/terminal.js` needs from higher layers is injected at boot from
`js/panel/viewer/pty-lifecycle.js#install(host)` (each hook unset = the effect is
skipped, so the leaf runs standalone in tests/scripts):

| Setter | Wired to | Purpose |
|--------|----------|---------|
| `setExitHandler(fn)` | `pty-lifecycle.handleExit` | PTY-exit fan-out |
| `setRenderHook(fn)` | `leaves/infra/render-queue.scheduleOverlay` | repaint after each xterm write |
| `setJobsHooks({register, close})` | `feature/jobs` | jobs-registry adapter |

The spawn cwd is **not** read from the model by the leaf — it rides in as an
`ensureSession(id, cmd, cols, rows, cwd)` argument (callers pass
`getModel().projectDir`).

## Session interface (`js/io/terminal.js` exports)

```
ensureSession(id, cmd, cols, rows, cwd)  lazy create-or-return; idempotent
getSession(id)                            → session | null
writeToSession(id, data)                  forward keystrokes to the PTY
resizeSession(id, cols, rows)             resize PTY + xterm
destroySession(id) / destroyAll()         kill + dispose (cleanup on quit)
restartSession(id, cols, rows)            kill old, respawn with same cmd/cwd
isSessionDead(id)                         → bool (process exited?)

scrollback (v0.6.5 §5(a)):
scrollSession(id, amount)                 ± lines (− = back into history)
scrollSessionPages(id, n)                 ± pages
scrollSessionToTop(id) / ...ToBottom(id)
sessionScrollInfo(id)                     → { atBottom, linesBelow }
sessionMouseMode(id)                      → child's DEC mouse mode ('none'|x10|…)
```

The scroll fns return whether the viewport actually moved (callers gate their
repaint on it). Writing PTY output while scrolled up is sticky in xterm (`baseY`
grows, `viewportY` holds), so the view stays put until the user returns to the
bottom.

## Lifecycle reconcile

The PTY's lifecycle is reconciled by the **dispatch finalizer**
(`js/dispatch/runtime/finalize.js`) — NOT by render. After each outermost
dispatch, if the active tab is a terminal it `ensureSession`s + `resizeSession`s
to the viewer pane's **committed** geometry (`geo.visibleBoundsFor`, so a
free-config drag-preview doesn't churn SIGWINCH per zone crossing). Lazy: only
the *active* terminal tab ever spawns; `ensureSession` is idempotent, so
re-running per dispatch is a no-op once the session exists.

PTY exit is **event-driven**, not polled:

```
node-pty onExit  →  _onSessionExit(id, exitCode)  →  _exitHandler
                                                       = pty-lifecycle.handleExit
```

`handleExit` (`js/panel/viewer/pty-lifecycle.js`):
- if the user was interacting with the just-exited session, dispatches
  `{type:'terminal_exit'}` (clears `model.modes.terminalMode`);
- if `viewMode` was `'full'` and this was the active terminal, dispatches a
  `view_set`/`view_drop_full_to_normal` so the user lands somewhere reachable
  (the reducer arm emits `force_full_repaint` on the full→normal transition);
- on a clean exit (`exitCode === 0`), auto-removes the ephemeral tab via
  `tabs.handleSessionCleanExit` (a non-zero exit stays so the user can read the
  code; `x` closes it). Configured `terminals:` tabs never auto-remove.

The jobs registry is updated through the injected `_jobs` adapter: a session
registers a `kind:'pty'` job on spawn and closes it on exit/kill.

## Rendering

`renderTerminalOverlay` in `js/render/paint.js` reads `getSession()` /
`sessionScrollInfo()` **live** and does a per-row diff against the session's
`prevFrame` cache; the footer's terminal line lives in `js/render/footer.js`.
Render is **read-only** for the PTY (the spawn/resize moved to the finalizer);
it positions the overlay against the focused viewer's committed (or, mid-drag,
preview) bounds.

Two repaint paths drive the overlay:
- **primary** — the `_renderHook` (`scheduleOverlay`) fired on each xterm write,
  so keystroke echo lands within ~16ms.
- **backstop** — the `#D15` model-conditional `interval` Sub
  (`js/app/state.js#_appSubscriptions`, 250ms), declared *only while a terminal
  tab is on-screen* (`_termTabOnScreen()`) and torn down when it leaves. It
  exists to cover async PTY race windows the event-driven paths can miss; it is
  NOT an always-on `setInterval` and NOT 100ms.

When the viewport sits above the live bottom, a reverse-video `[↑N]` indicator
(N = `linesBelow`) is stamped at the top-right inner cell; any scroll change
forces an inner repaint so the tag self-clears on return to the bottom. A dead
session shows a centered `Process exited: <code> — Enter restart, x close`
prompt on the bottom content row.

## Input (`js/dispatch/control/input.js`)

When `model.modes.terminalMode` is true, the stdin closure routes the raw chunk
to `_handleTerminalModeData`, bypassing normal key parsing.

- **Exit key** — `Ctrl+\` (`0x1c`) dispatches `{type:'terminal_exit'}`; a
  dead/missing session also exits (and drops the keystroke). The PTY child keeps
  running.
- **Scrollback keys** — `Shift+PageUp`/`PageDown` (`\x1b[5;2~` / `\x1b[6;2~`),
  `Shift+Home`/`End` (`\x1b[1;2H` / `\x1b[1;2F`). Plain Page/Home/End fall
  through to the child (less, vim).
- **Smart mouse forwarding** — `_classifyTerminalChunk` (pure, unit-tested)
  decides per chunk using `sessionMouseMode(id)`. When the child enabled DEC
  mouse reporting (vim, htop, `less --mouse`), mouse bytes forward raw. When it
  hasn't (`'none'`), the wheel is the framework's scrollback control (3 lines /
  notch); non-wheel mouse is dropped; any non-mouse residue forwards.
- **Snap to bottom** — an ordinary keystroke at the prompt first
  `scrollSessionToBottom`s, so typing always leaves scrollback.

Wheel-on-a-terminal-tab while *not* in terminal mode also scrolls the PTY
scrollback (`_handleWheel` → `scrollSession`), not the viewer slice.

`Enter` on a (focused) terminal tab calls `dispatch/control/actions.js#
activateTerminal`: if the session is dead it `restartSession`s sized to the
viewer's bounds, then dispatches `terminal_enter`.

## YAML configuration

Per-group `terminals:` entries (parser normalizes to `{ cmd, label }`):

```yaml
groups:
  database:
    terminals:
      sql:   { cmd: "psql -h localhost -U admin mydb", label: "SQL Editor" }
      redis: { cmd: "redis-cli -h localhost",          label: "Redis CLI" }
```

Tab strip order (flat `slice.tab` index; see
`js/leaves/wm/pane-tabs.js#flatTabInfo`):

```
[Info] [Transcript] [actionTabs…] [termTabs…] [contentTabs…]
   0        1          2..             …            …
```

Info + Transcript are implicit globals; `terminals:` entries and runtime
ephemeral terminals share the term-tab band. Sessions are lazy (first
activation), persist across group switches, and are keyed `${group}_${key}`.

## Spawn / TTY handoff (`js/dispatch/runtime/action-runner.js`)

A `type: spawn` action:
- **outside tmux** — opens an embedded PTY *ephemeral* tab (`tabs.addEphemeralTab`)
  and auto-zooms to `viewMode: 'full'` so the child owns the screen. The child
  dies with the TUI (by design — in-process node-pty, not a survivable session).
  `Ctrl+\` drops the zoom (`terminal_exit` → full→normal) but the child keeps
  running; a clean exit (`exitCode === 0`) auto-closes the tab.
- **inside tmux** (`$TMUX` set) — `tmux new-window` instead; a real OS-level
  window beats an in-process tab for long-lived interactive sessions.
