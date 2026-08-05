/**
 * Terminal helpers — cursor, screen, ANSI output.
 * Zero dependencies.
 */
'use strict';

const stdout = process.stdout;
let COLS = stdout.columns || 80;
let ROWS = stdout.rows || 24;

function refreshSize() {
  COLS = stdout.columns || 80;
  ROWS = stdout.rows || 24;
}

function moveTo(row, col) { stdout.write(`\x1b[${row};${col}H`); }
function clearScreen() { stdout.write('\x1b[2J\x1b[H'); }
function hideCursor() { stdout.write('\x1b[?25l'); }
function showCursor() { stdout.write('\x1b[?25h'); }
// SGR mouse reporting:
//   1000 — button events (press/release)
//   1002 — button events + motion while a button is held (= drag)
//   1006 — SGR coordinate encoding (vs the legacy <0xff cap)
// 1002 is the drag protocol Design Mode v2 uses; it only reports
// motion while a button is held so the cost is bounded (no idle
// motion spam). Terminals that don't support 1002 ignore it.
function enableMouse() { stdout.write('\x1b[?1000h\x1b[?1002h\x1b[?1006h'); }
function disableMouse() { stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1006l'); }

// XTerm focus-tracking (DEC 1004). Terminal emits `\e[I` on gain,
// `\e[O` on loss. Used by the refresh loop to pause polling when
// the user has tabbed away.
function enableFocusEvents()  { stdout.write('\x1b[?1004h'); }
function disableFocusEvents() { stdout.write('\x1b[?1004l'); }

// Bracketed paste (DEC 2004). Multi-line pastes arrive bracketed by
// `\e[200~` ... `\e[201~`, letting the input parser treat the whole
// chunk as one block instead of dispatching every byte as a keystroke.
function enableBracketedPaste()  { stdout.write('\x1b[?2004h'); }
function disableBracketedPaste() { stdout.write('\x1b[?2004l'); }

// Kitty keyboard protocol (CSI-u). Spec:
// https://sw.kovidgoyal.net/kitty/keyboard-protocol/ — implemented from the
// spec (a protocol is a method of operation, not copyrightable); we never
// copy kitty's GPL source. v0.6.14 arc (docs/kitty-keyboard.md).
//
// We push only the "disambiguate escape codes" flag (bit 1) — enough to make
// Escape and the ambiguous ctrl/alt combos arrive as self-terminating CSI-u
// sequences (killing the legacy Esc-vs-sequence ambiguity), without opting
// into event-types/report-all-keys/associated-text (D1). The push/pop stack
// (`CSI > flags u` / `CSI < u`) restores whatever the outer program had.
//
// Two axes: `_kkpDesired` = should KKP be on (detected/forced), and
// `_kkpSuspend` = a depth count of temporary hand-offs where a child owns the
// terminal (an embedded PTY tab, or Ctrl+Z). Flags are pushed on the terminal
// iff desired AND not suspended. `_kkpPushed` mirrors the actual on-wire state
// so every entry point is idempotent — we never push twice or pop a stack
// entry we didn't push. The depth counter makes suspend/resume correctly
// nestable (no lost state), which a single was-active flag could not.
let _kkpDesired = false;
let _kkpSuspend = 0;
let _kkpPushed  = false;
function _applyKkp() {
  const want = _kkpDesired && _kkpSuspend === 0;
  if (want && !_kkpPushed)      { stdout.write('\x1b[>1u'); _kkpPushed = true; }
  else if (!want && _kkpPushed) { stdout.write('\x1b[<u');  _kkpPushed = false; }
}
function enableKKP()  { _kkpDesired = true;  _applyKkp(); }  // detection/force enable
function disableKKP() { _kkpDesired = false; _applyKkp(); }  // permanent (exit teardown)
function suspendKKP() { _kkpSuspend++; _applyKkp(); }        // child takes the keyboard
function resumeKKP()  { if (_kkpSuspend > 0) _kkpSuspend--; _applyKkp(); }
function kkpActive()  { return _kkpPushed; }                 // currently on the wire
// Detection: query current flags, then Primary Device Attributes as a fence.
// A KKP terminal answers `\x1b[?<flags>u` BEFORE the DA1 reply `\x1b[?...c`;
// a non-KKP terminal answers only DA1. The input layer's response arm reads
// both off the normal stdin path (they tokenize as ordinary CSI sequences).
function queryKKP() { stdout.write('\x1b[?u\x1b[c'); }

function cols() { return COLS; }
function rows() { return ROWS; }

/** Refresh + snapshot the terminal dimensions as one `{cols, rows}`
 *  value — what the pure geometry readers (leaves/wm/geometry) take
 *  as an explicit param now that they no longer read the terminal
 *  themselves (wm-geo P1.2). */
function dims() { refreshSize(); return { cols: COLS, rows: ROWS }; }

/** OSC52 clipboard escape — `ESC]52;c;<base64>BEL`. Tells terminals
 *  that support OSC52 (kitty, iTerm2, WezTerm, modern xterm, tmux/screen
 *  with pass-through configured) to put `text` on the system clipboard.
 *  Silent no-op on non-strings / empty input. Single home for the
 *  sequence; both the yank-register and the copy-menu commit path
 *  import from here. */
function emitOSC52(text) {
  if (typeof text !== 'string' || !text) return;
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  stdout.write(`\x1b]52;c;${b64}\x07`);
}

module.exports = {
  refreshSize, moveTo, clearScreen, hideCursor, showCursor,
  enableMouse, disableMouse,
  enableFocusEvents, disableFocusEvents,
  enableBracketedPaste, disableBracketedPaste,
  enableKKP, disableKKP, suspendKKP, resumeKKP, kkpActive, queryKKP,
  emitOSC52,
  cols, rows, dims, stdout,
};
