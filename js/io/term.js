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
// `_kkpActive` tracks whether WE currently have flags pushed, so disableKKP is
// a no-op when we never enabled (never pop a stack entry we didn't push), and
// suspend/exit teardown can pop exactly once. Detection (queryKKP) and the
// enableKKP call are driven from the boot handshake (P2), gated by config/env.
let _kkpActive = false;
function enableKKP()  { if (!_kkpActive) { stdout.write('\x1b[>1u'); _kkpActive = true; } }
function disableKKP() { if (_kkpActive)  { stdout.write('\x1b[<u');  _kkpActive = false; } }
function kkpActive()  { return _kkpActive; }
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
  enableKKP, disableKKP, kkpActive, queryKKP,
  emitOSC52,
  cols, rows, dims, stdout,
};
