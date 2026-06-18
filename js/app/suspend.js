/**
 * Suspend / resume — graceful Ctrl+Z handling.
 *
 * Without intervention, hitting Ctrl+Z in a lazytui session corrupts
 * the terminal: stdin is still in raw mode, mouse reporting is still
 * on, the cursor is hidden, focus events are still wrapping in
 * \e[?1004h. The user is dropped to a shell that doesn't echo
 * typed characters and treats every keystroke as a TUI mouse byte.
 *
 * The fix is the standard Unix dance:
 *
 *   1. On SIGTSTP: restore the terminal (disable mouse/focus/paste,
 *      show cursor, exit raw mode), then detach our handler and
 *      re-raise SIGTSTP so the kernel actually stops the process.
 *   2. On SIGCONT: re-enter raw mode, re-enable mouse/focus/paste,
 *      hide cursor, invalidate the render diff cache, paint a fresh
 *      frame. Reinstall the SIGTSTP handler for the next Ctrl+Z.
 *
 * Embedded PTY children (terminal.js sessions) receive SIGCONT
 * automatically when our process resumes, so a shell open in a
 * detail-panel terminal tab continues running through the suspend.
 */
'use strict';

const {
  showCursor, hideCursor,
  enableMouse, disableMouse,
  enableFocusEvents, disableFocusEvents,
  enableBracketedPaste, disableBracketedPaste,
  stdout,
} = require('../io/term');
const { RESET } = require('../leaves/ansi');

let _suspendHandler;
let _resumeHandler;

// Save/restore the terminal modes lazytui owns (raw-mode, cursor,
// mouse, focus, bracketed paste). Used both by SIGTSTP/SIGCONT (the
// kernel-stop case) and by actions.js when type: spawn hands the
// terminal to a child synchronously outside tmux. Exporting these so
// both call sites stay in sync — adding a new mode happens once.
function suspendTerminal() {
  disableMouse();
  disableFocusEvents();
  disableBracketedPaste();
  showCursor();
  stdout.write(RESET);
  try { process.stdin.setRawMode(false); } catch (e) { /* not a TTY */ }
}

function resumeTerminal() {
  try { process.stdin.setRawMode(true); } catch (e) { /* not a TTY */ }
  enableMouse();
  enableFocusEvents();
  enableBracketedPaste();
  hideCursor();
}

function installSuspendHandlers() {
  // SIGTSTP and SIGCONT don't exist on Windows. The signal listeners
  // simply never fire there; no harm in registering, but skip to
  // avoid noisy "unsupported signal" warnings.
  if (process.platform === 'win32') return;

  _suspendHandler = () => {
    suspendTerminal();
    // Detach this handler so the next SIGTSTP triggers the kernel
    // default (actually stop the process). Then re-raise.
    process.removeListener('SIGTSTP', _suspendHandler);
    process.kill(process.pid, 'SIGTSTP');
  };

  _resumeHandler = () => {
    resumeTerminal();
    // Reinstall the suspend handler for the next Ctrl+Z (it was
    // detached above so the kernel could honour the previous one).
    process.on('SIGTSTP', _suspendHandler);
    // The shell that ran during the suspend probably scrolled or
    // overwrote the screen — invalidate the diff cache so the next
    // paint is a full clear + redraw. #D6 — go through the render-queue
    // seam (paintNow → the model-fetching render thunk) rather than calling
    // paint's render() directly, so this shell never reaches the pure view
    // with a missing model arg.
    const { forceFullRepaint, paintNow } = require('../leaves/infra/render-queue');
    forceFullRepaint();
    paintNow();
  };

  process.on('SIGTSTP', _suspendHandler);
  process.on('SIGCONT', _resumeHandler);
}

module.exports = { installSuspendHandlers, suspendTerminal, resumeTerminal };
