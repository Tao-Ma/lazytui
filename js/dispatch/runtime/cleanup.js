/**
 * Process exit hygiene — kill children, restore the terminal.
 * Called on user-quit (q / Ctrl-C) and from process.on('exit').
 *
 * Order matters: kill the streamed action first (so its stdout doesn't
 * arrive after we've reset the screen), then agent sessions, then PTYs,
 * then mouse + cursor + full reset, finally clear and home cursor.
 */
'use strict';

const { RESET } = require('../../leaves/text/ansi');
const {
  showCursor, moveTo, stdout, clearScreen,
  disableMouse, disableFocusEvents, disableBracketedPaste, disableKKP,
} = require('../../io/term');
const { destroyAll } = require('../../io/terminal');
const { killAll } = require('./action-runner');

function cleanup() {
  killAll({ silent: true });
  // Live-agent sessions — same "children first" reasoning; each backend
  // tears its own subprocess down (a no-op for sessions already dead).
  require('../../io/agent').stopAll();
  destroyAll();
  // C5 — abort any in-flight keyed compute (e.g. an in-flight docker
  // inspect/stats subprocess) so it's SIGTERM'd rather than orphaned on quit.
  try { require('./effects')._clearInflight(); }
  catch { /* effects not initialized (CLI path) */ }
  // Fire each Component's cleanup() hook (e.g. docker's `docker events`
  // stream) so no timer or child fires after quit. Lazy-required and
  // guarded: CLI mode (--exec/--list) never loaded the Component API.
  try { require('../../panel/api').cleanupComponents(); }
  catch { /* Component API not initialized (CLI path) */ }
  disableMouse();
  disableFocusEvents();
  disableBracketedPaste();
  disableKKP();   // pop our kitty-keyboard flags — never leak them to the shell
  showCursor();
  stdout.write(RESET);
  clearScreen();
  moveTo(1, 1);
}

// The signals that terminate the process WITHOUT running its
// `process.on('exit')` handlers (Node's default disposition just
// kills it): a supervisor/`kill` (SIGTERM), the terminal window
// closing (SIGHUP), and an out-of-band `kill -INT` (SIGINT — the
// keyboard Ctrl-C is a raw byte, 0x03, handled by the input layer,
// NOT this signal, because raw mode disables ISIG). Left untrapped,
// every enabled terminal mode leaks into the shell — raw, mouse,
// bracketed paste, focus events, hidden cursor, kitty keyboard —
// e.g. Escape arriving as \x1b[27u until a `reset`. SIGKILL can't be
// trapped; that leak is only recoverable with a shell-side `reset`.
// See docs/kitty-keyboard.md "leak" note.
const _FATAL_SIGNALS = ['SIGTERM', 'SIGHUP', 'SIGINT'];

// Trap the terminating signals above → restore the terminal, then exit
// with the conventional 128+signum code (SIGTERM→143, SIGHUP→129,
// SIGINT→130). cleanup() also runs again via the `process.on('exit')`
// handler the exit triggers — harmless, it's idempotent by design.
// `exit` is injectable so the smoke suite can drive the handler in-
// process (a real process.exit would skip the test's report()).
function installTerminationHandlers(exit = process.exit) {
  const signals = require('os').constants.signals;
  for (const sig of _FATAL_SIGNALS) {
    process.on(sig, () => {
      try { cleanup(); }
      finally { exit(128 + (signals[sig] || 0)); }
    });
  }
}

module.exports = { cleanup, installTerminationHandlers, _FATAL_SIGNALS };
