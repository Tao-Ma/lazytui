# Terminal Subsystem

Embedded interactive PTY sessions (SSH, SQL REPL, a spawned long-running
command) hosted as a first-class **`terminal` pane** — a minted position-tab
instance, not a viewer content-tab (U2d, docs/one-tab-system.md). Backed by
`node-pty` (real PTY) + `@xterm/headless` (the emulator/screen buffer). No tmux
knowledge required.

This is the **reference FOREIGN COMPONENT (`#D14`)** — an explicitly non-TEA
island. Two documents own the contract; this file is the subsystem map:

- `docs/foreign-components.md` — the foreign-component contract (terminal is its
  reference implementation).
- `js/io/terminal.js` header — the per-module statement of the mechanism.
- `docs/v0.6.6-replay-readiness.md` — why the screen contents are outside replay.

## The split: lifecycle in the model, contents in xterm

`js/io/terminal.js` is a **true leaf** — its only requires are `node-pty` +
the emulator port `js/io/term-screen.js` (the one importer of `@xterm/headless`,
plus the pure leaves `leaves/text/char-width` — widths — and `leaves/text/ansi` —
the theme's screen colours); it reaches nothing upward (no app model, no
panel/api, no render, no jobs). It owns a `sessions` map of `{ pty, screen, cmd,
cwd, exited, exitCode, jobId, _onDataSub, _replySub }` (`screen` = the emulator
behind the port; `_replySub` sends its answers back to the child) — or, during
replay, PTY-less `{ pty: null, screen, replay: true, … }` sessions.

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
`js/panel/content/pty-lifecycle.js#install(host)` (each hook unset = the effect is
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
sessionInputModes(id)                     → { appCursor, sendFocus, bracketedPaste,
                                            altScreen } — how input must reach it
reportMouse(id, ev)                       encode a mouse event for the child (its
                                          protocol + encoding) → sent?
```

The emulator's **replies** to the child — answers to its terminal queries
(device attributes `ESC [ c` / `ESC [ > c`, cursor position `ESC [ 6 n`, mode
reports) and the mouse reports `reportMouse` encodes — go back to the PTY
(`term-screen.onScreenReply`, wired in `ensureSession`), as a real terminal's
would. vim chooses its mouse encoding from the `ESC [ > c` answer; nvim and fzf
wait on theirs.

The default-colour queries (`OSC 10 ; ?` / `OSC 11 ; ?` — nvim picks
`background` light/dark from the answer) are answered by the port itself
(`term-screen` OSC handlers) with the theme's screen colours
(`ansi.screenColors`), which are what the pane paints default cells with — when
the theme's screen pair is RGB (every built-in theme but `minimal`, whose named
colours have no exact value to report). While screen colours are off
(`theme_background: false`), or under `minimal`, default cells show the host's
own colours, which lazytui doesn't know, so the query stays unanswered. One OSC
may carry several slots, each the next dynamic colour (xterm): `OSC 10 ; ? ; ?`
asks for the foreground and the background, and gets both answers.

The scroll fns return whether the viewport actually moved (callers gate their
repaint on it). Writing PTY output while scrolled up is sticky in xterm (`baseY`
grows, `viewportY` holds), so the view stays put until the user returns to the
bottom.

## Lifecycle reconcile

The PTY's lifecycle is reconciled by the **dispatch finalizer**
(`js/dispatch/runtime/finalize.js`) — NOT by render. After each outermost
dispatch, for every visible terminal surface (`panel/terminal-surfaces`
`visibleTerminalSurfaces` — a pane whose active tab is a terminal and that has
an interior) it `ensureSession`s + `resizeSession`s to that surface's
**committed** interior (the committed arrange, so a free-config drag-preview
doesn't churn SIGWINCH per zone crossing). A minimized pane (a 1-row bar, no
interior) is not a surface: its PTY keeps its last size. Lazy: only
the *active* terminal tab ever spawns; `ensureSession` is idempotent, so
re-running per dispatch is a no-op once the session exists.

PTY exit is **event-driven**, not polled:

```
node-pty onExit  →  _onSessionExit(id, exitCode)  →  _exitHandler
                                                       = pty-lifecycle.handleExit
```

`handleExit` (`js/panel/content/pty-lifecycle.js`) resolves the exited session's
`terminal` pane via the route registry (`ptyId == the instance id`) and runs
`_handlePaneExit`:
- if the user was interacting with this (focused, active) terminal, dispatches
  `{type:'terminal_exit'}` (clears `model.modes.terminalMode`);
- if `viewMode` was `'full'` and the terminal's slot is focused, dispatches a
  `view_set` to `'normal'` so the user lands somewhere reachable (the reducer arm
  emits `force_full_repaint` on the full→normal transition);
- on a clean exit (`exitCode === 0`), auto-closes the tab via a `remove_tab` Msg
  (a non-zero exit stays so the user can read the code; `x` closes it). The
  instance + PTY teardown then flows through reconcile's orphan-dispose
  (`destroySession` in `app/state.js`).

The jobs registry is updated through the injected `_jobs` adapter: a session
registers a `kind:'pty'` job on spawn and closes it on exit/kill.

## Rendering

`renderTerminalOverlay` in `js/render/paint.js` reads `getSession()` /
`sessionScrollInfo()` **live** and does a per-row diff against the session's
`prevFrame` cache; the footer's terminal line lives in `js/render/footer.js`.

**Colours.** The port reads each row cell by cell into styled runs
(`readViewport` → `runs: [[{ sgr, text }]]`, `sgr` = the run's SGR parameters,
'' = all defaults) exactly the interior's width — padded, and cut before a glyph
that would cross the border. The 16 ANSI colours are emitted in their 16-colour
form (the host draws them in its own palette); 256-colour and RGB stay exact and
the write boundary downgrades them to the host's depth. `ansi.sgrRun` starts each
run: a colour the program left at its default takes the theme's screen colour
(when `theme_background` is on), the same top-up a reset inside streamed output
gets. The row cache compares the composed row, so a colour-only change (vim's
visual selection) repaints; `:theme` forces every surface to repaint. The
checkpoint snapshot writes the same runs as SGR lines. Not drawn: underline
styles (curly/dotted) and underline colour, which the emulator keeps internal —
those cells get a plain underline.

**Popups stay on top.** The grid is painted after the main frame, outside its
cell-diff, while every popup (palette, menus, which-key, confirm, tooltip, …)
composites into the frame through `row-compositor.compositeRow`, which records
the columns each one covers (`newRows.covered`). render() keeps that coverage
(`_covered`, also used by the PTY fast path between frames), and the grid is
drawn only in each row's uncovered spans (`leaves/render/occlusion`), with the
spans in the row-cache key. Where a row's coverage changes INSIDE the grid's
columns (a popup over it opens, moves, closes) render() also invalidates that
frame row before the diff: the diff's record of the interior is the blank pane
body, not the grid on screen, so a blank popup cell would otherwise be skipped
and the grid would show through. A popup beside the pane (same rows, other
columns) changes nothing there and invalidates nothing.

**The frame says what it wrote over.** An invalidated row is rewritten WHOLE by
the frame's diff — across every terminal interior on that row, with the blank
pane body. That happens on more than coverage: the vanish reclaim of a surface
that stopped painting (minimized, its slot switched tab, its tab closed), an
`invalidate` from elsewhere, a replay frame with change highlighting (which
rewrites each changed row) — and a surface that MOVED or was RESIZED reclaims the
rows it occupied the same way, so the cells it gave up (a terminal
shrinking as the pane above it is restored) don't keep its text. The reclaim
reads every rect a grid was painted on since the last frame (`_gridRects`), not
just the last one: the PTY fast path and the backstop poll paint between frames
at the rect the model has now, and a closed tab's deferred frame must still
reclaim the rows its grid was on. A surface that moved repaints its whole grid
at the new place (its row cache describes the old one). The row's cache key sees none of them, so
`painter.paintFrame` returns `wrote` (row → the `[x0, x1)` column runs it
wrote) and the terminal painter repaints every grid row whose interior the frame
wrote over — a terminal beside the one that vanished, or beside the popup's
pane, keeps its grid. The scrollback tag and the exit prompt are spliced into the grid rows
(`spliceRuns`), so they are cached and clipped like the grid.
Render is **read-only** for the PTY (the spawn/resize moved to the finalizer);
it positions each surface's overlay against its pane's committed (or, mid-drag,
preview) bounds — on every pass: the PTY fast path and the 250 ms poll paint at
the drag preview too (`_dragPreviewArrange`), where the frame on screen put it.

**Widths.** The emulator measures with the frame's width function:
`term-screen.createScreen` registers `charWidth` (`leaves/text/char-width`) as
the emulator's Unicode provider, replacing its built-in Unicode 6 table (every
emoji 1 column). A row the program fills is then exactly the pane's width when
painted — with the built-in table, each ⚡/💤 in a full row (LazyVim's dashboard)
put the row one column past the pane border. `test-char-width.js` [3] pins the
two as identical for every codepoint.

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
(`Process stopped` when lazytui stopped it — a replay took its session over)
prompt on the bottom content row (`x close` only when the slot keeps another tab:
`remove_tab` refuses a slot's last tab, so on a terminal alone in its slot `x` is
the menu).

A focused terminal pane's footer comes from the `terminal` context in
`leaves/input/bindings.js`, fed by `focusedTerminalState` (`panel/terminal-surfaces`):
`][ tabs` when it is a tab of the content slot (`]` / `[` cycle that slot's strip —
not another slot's), `Enter type here` while it is on screen and alive, `Enter restart` once it exited,
no Enter hint while it is minimized or no PTY can run (node-pty absent — Enter
does nothing there; and terminal mode with no session behind it ends at the first
key), and `x close` vs
`x menu` by the same closable rule as the banner and the `x` key. In terminal
mode the footer names the terminal by the title its border / tab strip shows
(`[terminal: Dev]` for a `panels: { dev: { type: terminal, title: Dev } }` pane;
`focusedTerminalTitle`, via `leaves/wm/pane#titleOf`). A terminal has that one
name: its slice holds only its column `paneId` and the exit continuation
(`onExit`), and the command it
runs is the pool entry's `config.cmd`, which the finalizer spawns.

## Input (`js/dispatch/control/input.js`)

When `model.modes.terminalMode` is true, the stdin closure routes each chunk to
`_handleTerminalChunk`, bypassing the normal key ladder. The chunk is still split
into input events by the same tokenizer and carry as normal mode — a sequence
split across chunks (by the host's read or the network) rejoins, and one that
never completes reaches the child after the 50 ms carry window — and each event is
classified on its own (`_classifyTerminalToken`, pure, unit-tested), so nothing
depends on how input was batched — with one deliberate exception, shared with
normal mode (`leaves/input/tokenize`): a bare trailing ESC is never held, so a
sequence cut right after its ESC byte does not rejoin. Holding it would delay
every Esc keypress (vim's most-typed key) by the carry window; a cut exactly
there is rare. The other way round, the head of a paste OPEN marker (`ESC [ 2 0`,
`ESC [ 2 0 0`) is held past the window, however long the rest takes, in both
modes: flushed, the pasted text after it was typed as keys. The host always
completes a marker it started (and F9, `ESC [ 2 0 ~`, completes the same way);
the shorter `ESC [` and `ESC [ 2` — what Alt+[ (then 2) send — still flush in
the window. Keys reach the PTY in one write per run, in
stream order with the mouse reports between them. Outside terminal mode a
focused terminal pane gets nothing: its keys are lazytui's (`Enter type here`).
The kitty keyboard protocol is popped on entry (`kkp_suspend`), so the host
sends legacy key bytes while the child has the keyboard.

- **Exit key** — `Ctrl+\` (`0x1c`) dispatches `{type:'terminal_exit'}`; the rest
  of the chunk goes to the normal-mode pipeline. A dead/missing session also
  exits, dropping the keys typed for it (a paste that opens among them is still
  a paste: the normal-mode pipeline finishes it). The PTY child keeps running.
- **Scrollback keys** — `Shift+PageUp`/`PageDown`, `Shift+Home`/`End` (in the
  forms `leaves/input/key-decode` names: xterm's `\x1b[5;2~`, `\x1b[1;2H`, the
  `\x1b[1;2~` tmux / screen send — not rxvt's `\x1b[5$` …) — at a
  prompt (the main screen). On the alternate screen (a full-screen child: vim, less, htop) there
  is no scrollback to show, so they are the child's keys and forward. Plain
  Page/Home/End always go to the child.
- **Keys as xterm sends them** — the child is told `TERM=xterm-256color`, so a
  key reaches it in xterm's form, not the host's (`toXtermKey`,
  `leaves/input/key-decode`) — beside a mouse event too: arrows, Home/End, Insert/Delete, Page keys and
  F1–F12 (with modifiers) are decoded from any common host form (xterm, VT220 —
  what tmux/screen send — rxvt, linux console) and re-encoded as xterm would for
  the child's cursor mode (`sessionInputModes(id).appCursor`: SS3 for unmodified
  arrows/Home/End under DECCKM). Everything else — text, control bytes, Alt
  chords, unknown sequences — passes byte-for-byte. (Under tmux, Home/End arrive
  as `CSI 1 ~`/`CSI 4 ~`, which nvim ignores for an xterm.)
- **Focus reports** (`CSI I`/`CSI O`, turned on at the host) are lazytui's
  `focus_event` as in normal mode — batched with a click too, so the
  focus-gated polls resume — and reach the child only if it asked
  (`CSI ? 1004 h`).
- **Bracketed paste** — a host paste goes to the child verbatim (no key
  translation, no Ctrl+\ or scrollback matching inside it, across chunks — its
  markers too may split across chunks: a trailing piece of the close marker
  waits for the next chunk however long it takes, with no flush window), wrapped
  in `CSI 200 ~`/`CSI 201 ~` only if the child turned bracketed paste on
  (`CSI ? 2004 h`); a child that didn't would read the markers as typed text. If
  terminal mode ends mid-paste (the program exited, its session died), the rest
  of the paste is finished as a normal-mode paste — never typed as keys. (A
  normal-mode paste over 256 KB is dropped whole: the rest of it, up to its
  close marker, is discarded in whatever mode lazytui is in by then.)
- **Smart mouse forwarding** — per event, by `sessionMouseMode(id)`. When the child enabled DEC
  mouse reporting (vim, htop, `less --mouse`), each host mouse event is decoded,
  made relative to the terminal's grid, and re-encoded by the pane's emulator for
  the protocol + encoding the child asked for (`reportMouse`; e.g. no hover for a
  button-event child, the legacy X10 bytes when it didn't ask for SGR). A press, wheel or hover outside the grid is not
  the child's; a drag motion or release outside clamps to the edge (no stuck
  button). When it hasn't (`'none'`), the wheel is the framework's scrollback
  control (3 lines / notch); non-wheel mouse is dropped.
- **Snap to bottom** — a keystroke (or a paste) first `scrollSessionToBottom`s,
  so typing always leaves scrollback — whether or not the child reports the
  mouse.

Wheel-on-a-terminal-pane while *not* in terminal mode also scrolls the PTY
scrollback (`pane-mouse.handleWheel` keys on `instanceKind(paneId) === 'terminal'` →
`scrollSession`), not any viewer slice.

`Enter` on a (focused) `terminal` pane calls `dispatch/control/actions.js#
activateTerminal`: nothing when the pane has no interior (minimized — Enter
would hand the keyboard to a child you can't see) or no PTY can run (node-pty
absent); else, if the session is dead it `restartSession`s sized to the pane's
interior (with the pane's command, `surf.cmd`, when the session knows none),
then dispatches `terminal_enter`. Every other way into terminal mode (`:edit`,
a `type: spawn` action, a group terminal, a docker shell) dispatches
`terminal_enter` too, and the reducer refuses it when boot found no PTY support
(`caps.pty === false`), undoing the caller's auto-zoom. What the frame shows
asks the model too (`terminal-surfaces.ptyRuns`: `caps.pty`, this host only
before boot has said): the pane's `Terminal unavailable` notice and the footer's
`Enter type here` — so a replayed frame shows what the recording's host showed.

## YAML configuration

A terminal pane declared in the `panels:` pool — always there, placed like any
pane — runs the `cmd:` on its entry (through `$SHELL -c`; no `cmd:` runs the
shell itself):

```yaml
panels:
  dev: { type: terminal, title: Dev, cmd: ./dev.sh }
```

The command sits on the entry, beside `type` and `title`, like every pane
setting; a nested `config: { cmd: … }` is not read (the pane runs `$SHELL`) and
the parser warns (`panels.nested_config`).

A `type: spawn` action's tab (outside tmux) runs the action's body under
`/bin/sh` in the project directory, its args as `$1…` — as an argv
(`['/bin/sh', '-c', body, 'sh', …args]`), so your `$SHELL` never parses the body
(fish reads `\\` and `\'` inside single quotes as escapes). The tab's command is
that whole run: Enter restarts it.

Per-group `terminals:` entries (parser normalizes to `{ cmd, label }`):

```yaml
groups:
  database:
    terminals:
      sql:   { cmd: "psql -h localhost -U admin mydb", label: "SQL Editor" }
      redis: { cmd: "redis-cli -h localhost",          label: "Redis CLI" }
```

Since U2d P2a these are **open-on-demand**, not auto-shown: `getMergedActions`
surfaces each as an auto-generated `type:'terminal'` action (before user
`g.actions`, which can override), the same way docker exposes its `compose`
verbs. Invoking one opens a reused `terminal` pane (stable poolId
`term-yaml-<group>-<name>`) — so it persists across group switches (position-tab
persistence) and a second invocation reuses the live session rather than
spawning a fresh one.

The viewer's own flat strip is now just:

```
[Info] [Transcript] [contentTabs…]
   0        1          2..
```

Info + Transcript are implicit globals; the terminal + action segments that used
to sit between Transcript and content are gone (terminals are `terminal` panes,
action output is a `text-view` pane). PTY sessions are lazy (spawned by the
finalizer once the terminal is the slot's active tab) and keyed by the pane
instance id (`pane-<poolId>`).

## Spawn / TTY handoff (`js/dispatch/runtime/action-runner.js`)

A `type: spawn` action:
- **outside tmux** — mints a `terminal` pane into the viewer's slot (a fresh
  transient poolId) and explicitly focuses it + auto-zooms to `viewMode: 'full'`
  so the child owns the screen. The child dies with the TUI (by design —
  in-process node-pty, not a survivable session). `Ctrl+\` drops the zoom
  (`terminal_exit` → full→normal) but the child keeps running; a clean exit
  (`exitCode === 0`) auto-closes the tab (`remove_tab`).
- **inside tmux** (`$TMUX` set) — `tmux new-window` instead; a real OS-level
  window beats an in-process tab for long-lived interactive sessions.
