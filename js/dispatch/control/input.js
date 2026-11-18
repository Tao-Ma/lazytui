/**
 * Input layer — raw stdin → key events; SGR mouse parsing → click events.
 *
 * A chunk is first TOKENIZED into complete input events (leaves/input/
 * tokenize — network-lag fix, 2026-08-05: over SSH one chunk can batch
 * many events, and TCP can split one sequence across chunks). Each token
 * then dispatches through one ladder:
 *   - SGR mouse: \x1b[<button;x;yM (press) / m (release) — left/right/middle
 *     presses + left drag/release + wheel + button-less hover (_dispatchMouseEvent);
 *     handleMouse is the hit-map router call (docs/mouse-hit-map.md)
 *   - Arrow keys, PgUp/Dn, Esc, Enter, Ctrl+C — into named keys
 *   - Anything else — passed through as both `key` and `seq` to handleKey
 * A multi-token chunk paints ONCE (render-queue beginBatch/endBatch); a
 * single-token chunk keeps the synchronous per-key paint.
 *
 * Terminal mode tokenizes the same way but sends the events to the focused
 * terminal pane's program (§Terminal-mode input): keys re-encoded as xterm
 * sends them, mouse events made pane-relative for the program (or scrollback
 * when it has no mouse reporting), a paste verbatim — except Ctrl+\, which
 * exits terminal mode, and the Shift+Page/Home/End scrollback keys.
 */
'use strict';

const { paintNow: render, beginBatch, endBatch } = require('../../leaves/infra/render-queue');
const { getModel } = require('../../model/store');
const { enableMouse, enableFocusEvents, enableBracketedPaste } = require('../../io/term');
const { focusedTerminalId, surfaceOf } = require('../../panel/terminal-surfaces');
const terminal = require('../../io/terminal');
const { writeToSession, isSessionDead } = terminal;
const { tokenizeInput } = require('../../leaves/input/tokenize');
const { kkpToLegacy } = require('../../leaves/input/kkp-decode');
const { toXtermKey, decodeKey } = require('../../leaves/input/key-decode');
// v0.6.4 Theme F Phase 4 — the gesture→intent map + tunable double-click
// window. Dependency-free leaf, so this top-level require is cycle-safe.
const mouseBindings = require('./mouse-bindings');

const { handleKey, applyMsg, ctrlHKey } = require('./dispatch');
// Require-free at top level, so this edge can't cycle (see _terminalOwnsInput).
const replayControl = require('../runtime/replay-control');
// Hit-map router (docs/mouse-hit-map.md).
const mouseRouter = require('./mouse-router');
const { cleanup } = require('../runtime/cleanup');

// --- Mouse handling ---

/**
 * One pointer event (x, y 1-based SGR) → the hit-map router
 * (docs/mouse-hit-map.md). Everything the mouse can do is a region the last
 * frame published, z-ordered, with a DATA handler — popups (R1), pane chrome +
 * border controls + tab strip + ✗ cancel + tree markers + in-grid backdrops
 * (R2), pane bodies + the empty screen + hover, the drag in flight (pointer
 * capture — motion / release go to it wherever the pointer is), free-config and
 * the replay owner (R3). Precedence is z-order; modal gating is what paint
 * publishes (a popup's backdrop; no pane bodies while a chain mode is active).
 * A gesture nothing claims does nothing. The pane-body code lives in
 * ./pane-mouse, free-config's in ./free-config-capture.
 */
function handleMouse(kind, x, y) {
  // Phase 4 — runtime.update returns NEW model objects; read getModel() at
  // entry so post-Msg state is what the router reads.
  mouseRouter.route(kind, x - 1, y - 1, getModel());
}

// --- Terminal-mode input ---
//
// While a terminal pane has the keyboard (modes.terminalMode) stdin goes to its
// program — but a chunk is still split into input EVENTS first, with the same
// tokenizer and the same carry as normal mode (_makeDataHandler: a sequence
// split across chunks rejoins; one that never completes is flushed to the
// program after _CARRY_FLUSH_MS). Each event is classified on its own
// (_classifyTerminalToken), so nothing depends on how the host or the network
// happened to batch it:
//   exit    Ctrl+\ — leave terminal mode; the rest of the chunk goes to the
//           normal-mode pipeline (reemit)
//   scroll  Shift+PageUp/PageDown/Home/End, in any form the host sends —
//           framework scrollback, on the normal screen only (a full-screen
//           program on the alternate screen has no scrollback: they are its keys)
//   report  an SGR mouse event while the program has mouse reporting on —
//           made pane-relative and encoded for the program (_reportTerminalMouse)
//   wheel   a vertical wheel press while it hasn't — scrollback, 3 lines
//   drop    any other mouse event while it hasn't
//   focus   a host focus report (lazytui turns them on at the host) —
//           lazytui's focus (focus_event, as in normal mode); it reaches the
//           program only if the program asked for them (`CSI ? 1004 h`)
//   paste   the bracketed-paste open marker — what follows, up to the close
//           marker, goes to the program verbatim (_termPaste)
//   key     anything else — re-encoded as xterm sends it (toXtermKey)
// Keys reach the PTY in ONE write per run, in stream order with the mouse
// reports between them. Field report + pre-release review 2026-11-14: keys
// beside a mouse report went out raw (focus reports leaked, a focus-in batched
// with a click never reached lazytui, tmux's Home went untranslated), and a
// paste close marker split across chunks was never seen, so the paste never
// ended and Ctrl+\ went to the program.
//
// Every "is stdin the program's?" question asks _terminalOwnsInput, never the
// flag alone. While an interactive replay (`:record-load`) is up, the stores
// hold the RECORDING's model, and its terminalMode is the recorded user's
// keyboard, not this one; the replay controller takes every key and click
// (dispatch.handleKey). A frame recorded in terminal mode sent q / Esc to the
// recorded pane and the scrubber never saw them; only Ctrl+\ got out.
function _terminalOwnsInput() {
  return !!getModel().modes.terminalMode && !replayControl.active();
}

// One SGR mouse event — the tokenizer hands each one over as its own token.
// Shared with the normal-mode ladder (_dispatchToken).
const _SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

// One host SGR mouse report (lazytui runs the host terminal in SGR, 1006) →
// `{ x, y (host, 1-based), button, action, shift, alt, ctrl }` — the ONE decode
// of the button bits, for both modes: the normal-mode router's gestures
// (_dispatchMouseEvent) and the child's report in terminal mode (io/terminal
// reportMouse encodes it; field report 2026-11-14: the host bytes were
// forwarded RAW — whole-screen coordinates, always SGR — so a click in an nvim
// pane landed ~35 columns off). The `m` final is a release whatever the motion
// bit says (a release during a drag can carry both). null = nothing to send or
// route (buttons 8–11; a wheel "release").
function _decodeSgrMouse(btn, x, y, final) {
  if (btn & 128) return null;
  const mods = { shift: !!(btn & 4), alt: !!(btn & 8), ctrl: !!(btn & 16) };
  const low = btn & 3;
  if (btn & 64) {
    if (final === 'm') return null;
    return { x, y, button: 'wheel', action: ['wheel-up', 'wheel-down', 'wheel-left', 'wheel-right'][low], ...mods };
  }
  const button = ['left', 'middle', 'right', 'none'][low];
  const action = final === 'm' ? 'up' : (btn & 32) ? 'move' : 'down';
  return { x, y, button, action, ...mods };
}

// Shift + these keys scroll the pane's scrollback (on the normal screen).
const _SCROLL_KEYS = {
  pageup: { pages: -1 }, pagedown: { pages: +1 }, home: { toTop: true }, end: { toBottom: true },
};

/**
 * PURE: what one terminal-mode input event is, given the program's mouse
 * tracking mode (io/terminal sessionMouseMode — 'none' when off) and whether
 * it is on the alternate screen. Returns `{ kind }` (see the table above) plus
 * `pages | toTop | toBottom` (scroll), `mouse` (report — _decodeSgrMouse),
 * `lines` (wheel), `focused` (focus).
 */
function _classifyTerminalToken(tok, mouseMode, altScreen = false) {
  if (tok === '\x1c') return { kind: 'exit' };
  if (tok === _PASTE_OPEN) return { kind: 'paste' };
  if (tok === '\x1b[I' || tok === '\x1b[O') return { kind: 'focus', focused: tok === '\x1b[I' };
  const mm = _SGR_MOUSE_RE.exec(tok);
  if (mm) {
    const btn = parseInt(mm[1], 10);
    if (mouseMode !== 'none') {
      const mouse = _decodeSgrMouse(btn, parseInt(mm[2], 10), parseInt(mm[3], 10), mm[4]);
      return mouse ? { kind: 'report', mouse } : { kind: 'drop' };
    }
    // Vertical wheel press (bit 6 set, bit 1 clear; a release is no step):
    // bit 0 = down. Horizontal wheel and every other button: dropped.
    if ((btn & 0x42) === 0x40 && mm[4] !== 'm') return { kind: 'wheel', lines: (btn & 1) ? 3 : -3 };
    return { kind: 'drop' };
  }
  if (!altScreen) {
    const k = decodeKey(tok);
    if (k && k.shift && !k.alt && !k.ctrl && _SCROLL_KEYS[k.key]) return { kind: 'scroll', ..._SCROLL_KEYS[k.key] };
  }
  return { kind: 'key' };
}

// A bracketed paste from the host while a terminal pane has the keyboard. The
// pasted text goes to the program VERBATIM — never key-translated, never
// matched against Ctrl+\ or the scrollback keys — wrapped in the paste markers
// only if the program turned bracketed paste on (`CSI ? 2004 h`); a program
// that didn't would read the markers as typed text. `_termPaste` spans chunks
// (a long paste arrives in several); `marked` keeps the open/close markers
// paired even if the program flips its mode mid-paste. The stdin handler drops
// it whenever a chunk arrives outside terminal mode.
let _termPaste = null;   // null | { marked: bool }
function _pasteToChild(id, text) {
  if (!text) return;
  terminal.scrollSessionToBottom(id);
  writeToSession(id, text);
}
// How many trailing bytes of `s` could be the start of `marker` (a proper
// prefix) — held back so a marker split across chunks rejoins.
function _markerPrefixAtEnd(s, marker) {
  for (let n = Math.min(marker.length - 1, s.length); n > 0; n--) {
    if (s.endsWith(marker.slice(0, n))) return n;
  }
  return 0;
}

// Deliver one mouse event to the program: made relative to the terminal's grid
// (the overlay paints cell (0,0) at host column bounds.x + 2, row bounds.y + 2
// — 1-based) and encoded by the pane's emulator for the protocol + encoding the
// program asked for (io/terminal reportMouse; it also drops what the program's
// protocol doesn't take, e.g. hover for a button-event program). A press, wheel
// or hover outside the grid is not the program's (the border, another pane); a
// drag motion or release outside clamps to the edge, as a terminal does at its
// window edge, so the program never keeps a stuck button.
function _reportTerminalMouse(id, surf, ev) {
  if (!surf) return;
  let col = ev.x - surf.bounds.x - 2, row = ev.y - surf.bounds.y - 2;
  const inside = col >= 0 && row >= 0 && col < surf.cols && row < surf.rows;
  if (!inside) {
    const dragging = ev.action === 'up' || (ev.action === 'move' && ev.button !== 'none');
    if (!dragging) return;
    col = Math.min(Math.max(col, 0), surf.cols - 1);
    row = Math.min(Math.max(row, 0), surf.rows - 1);
  }
  terminal.reportMouse(id, { col, row, button: ev.button, action: ev.action,
                             shift: ev.shift, alt: ev.alt, ctrl: ev.ctrl });
}

function _exitTerminalMode() {
  applyMsg({ type: 'terminal_exit' });
  render();
}

/**
 * One terminal-mode stdin chunk (the carry from the previous chunk already
 * joined on — _makeDataHandler). `reemit(rest)` hands the bytes after a mode
 * exit to the normal-mode pipeline. Paints batch: scroll repaints and the
 * exit's full repaint coalesce into one frame.
 *
 * Ctrl+\ (`\x1c`) → terminal_exit: clears the flag, drops a 'full' auto-zoom to
 * 'normal' and repaints in full; the program keeps running. A dead or missing
 * session (focus moved off the terminal pane while the mode lingered, or no
 * PTY support) exits
 * too, dropping the keys typed for it — the run up to the next exit or scroll
 * key or paste open marker; the rest re-emits.
 */
function _handleTerminalChunk(data, reemit) {
  beginBatch();
  try { _terminalWalk(data, reemit); } finally { endBatch(); }
}

function _terminalWalk(data, reemit) {
  const id = focusedTerminalId();
  // No program to type into: the focus left the terminal pane, its program
  // exited, or it has no session at all (none spawned yet, or no PTY support).
  if (!id || isSessionDead(id) || !terminal.getSession(id)) {
    _exitTerminalMode();
    // Mid-paste: the rest of the chunk is still pasted text — the normal-mode
    // pipeline finishes it as a paste (_makeDataHandler), never as keys.
    if (_termPaste) { reemit(data); return; }
    const { tokens, carry } = tokenizeInput(data);
    const kinds = tokens.map(t => _classifyTerminalToken(t, 'none').kind);
    let i = 0;
    while (i < tokens.length && kinds[i] !== 'exit' && kinds[i] !== 'scroll' && kinds[i] !== 'paste') i++;
    if (kinds[i] === 'exit') i++;             // a Ctrl+\ is spent on the exit
    // A paste opening here is still a paste: from its marker on, the rest goes
    // to the normal-mode accumulator (dropped as typed for the program, its
    // later chunks were typed as keys — round-3 review). Nor is the carry
    // typed yet (an incomplete sequence: a split marker's head, say) — it
    // rides along.
    const rest = tokens.slice(i).join('') + carry;
    if (rest) reemit(rest);
    return;
  }
  const mouseMode = terminal.sessionMouseMode(id);
  const modes = terminal.sessionInputModes(id);
  let surf;            // the pane's surface, looked up for the first mouse report
  let keys = '';       // key bytes not yet written (one write per run)
  let typed = false;   // a keystroke in the run → back to the live bottom first
  const flushKeys = () => {
    if (typed && terminal.scrollSessionToBottom(id)) render();
    if (keys) writeToSession(id, keys);
    keys = ''; typed = false;
  };
  while (data) {
    if (_termPaste) {
      const end = data.indexOf(_PASTE_CLOSE);
      if (end < 0) {
        // A trailing piece of the close marker waits for the next chunk —
        // with NO flush timer: the host always sends the close, and pasting
        // the piece after 50 ms left the rest (`1~`) unmatched, the paste
        // never ending (every later key pasted, Ctrl+\ included) whenever
        // the two halves arrived further apart (round-2 review 2026-11-14).
        const hold = _markerPrefixAtEnd(data, _PASTE_CLOSE);
        _pasteToChild(id, data.slice(0, data.length - hold));
        _holdCarry(data.slice(data.length - hold), { flush: false });
        return;
      }
      _pasteToChild(id, data.slice(0, end) + (_termPaste.marked ? _PASTE_CLOSE : ''));
      _termPaste = null;
      data = data.slice(end + _PASTE_CLOSE.length);
      continue;
    }
    const { tokens, carry } = tokenizeInput(data);
    data = '';
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const ev = _classifyTerminalToken(tok, mouseMode, modes.altScreen);
      switch (ev.kind) {
        case 'key':
          keys += toXtermKey(tok, { appCursor: modes.appCursor });
          typed = true;
          break;
        case 'focus':
          _hostFocus(ev.focused);
          if (modes.sendFocus) keys += tok;
          break;
        case 'report':
          flushKeys();
          if (surf === undefined) surf = surfaceOf(getModel(), id);
          _reportTerminalMouse(id, surf, ev.mouse);
          break;
        case 'wheel':
          flushKeys();
          if (terminal.scrollSession(id, ev.lines)) render();
          break;
        case 'scroll': {
          flushKeys();
          const moved = ev.toTop ? terminal.scrollSessionToTop(id)
                      : ev.toBottom ? terminal.scrollSessionToBottom(id)
                      : terminal.scrollSessionPages(id, ev.pages);
          if (moved) render();   // skip the repaint when already at the edge
          break;
        }
        case 'paste':
          flushKeys();
          _termPaste = { marked: !!modes.bracketedPaste };
          if (_termPaste.marked) _pasteToChild(id, _PASTE_OPEN);
          data = tokens.slice(i + 1).join('') + carry;
          break;
        case 'exit': {
          flushKeys();
          _exitTerminalMode();
          const rest = tokens.slice(i + 1).join('') + carry;
          if (rest) reemit(rest);
          return;
        }
        // 'drop': a mouse event the program didn't ask for
      }
      if (ev.kind === 'paste') break;
    }
    if (_termPaste) continue;          // the rest of the chunk is the paste
    flushKeys();
    _holdCarry(carry);
  }
  flushKeys();
}

// The carry's flush in terminal mode: the bytes never completed a sequence,
// so they are the program's as they are. (Inside a paste nothing flushes: a
// piece of the close marker waits for the rest — _terminalWalk.)
function _flushTerminalCarry(bytes) {
  const id = focusedTerminalId();
  if (!id || isSessionDead(id)) return;
  writeToSession(id, bytes);
}

// --- Stdin setup ---

// T25 — bracketed paste accumulator (B13). A large paste can split
// across multiple stdin chunks (Node's 64KB highWaterMark). The
// pre-fix `startsWith(...200~) && endsWith(...201~)` check failed on
// multi-chunk pastes, falling through to the \x1b defensive fallback
// which fired Esc (closing any open modal); subsequent chunks
// silently dropped.
//
// The historical residual gap — the 6-byte OPEN marker itself splitting
// across chunks (chunk-1 ends `\x1b[20`, chunk-2 starts `0~content...`)
// — is closed by the tokenizer carry (2026-08-05): the trailing partial
// CSI is carried, rejoins the next chunk, and the completed paste-open
// token re-routes the rest of the chunk back through this accumulator
// (see the token loop's _PASTE_OPEN re-emit). A head of four bytes or more
// waits for the rest however long it takes (_holdCarry).
let _pasteBuffer = '';
const _PASTE_MAX = 256 * 1024;   // 256 KB cap (R16)
// null | the held piece of a close marker: a paste over the cap is being
// discarded up to its close (the stdin handler's first branch).
let _pasteDrop = null;
const _PASTE_OPEN = '\x1b[200~';
const _PASTE_CLOSE = '\x1b[201~';

// SGR mouse events: one per token (_SGR_MOUSE_RE, above). (T25/R15's
// multi-event-per-chunk handling — fast drags coalescing several events into
// one chunk — falls out of the tokenizer: each event is its own token, and
// keys interleaved with the mouse bytes dispatch too instead of being dropped
// by the old `if (sawMouse) return`.)

// v0.6.4 Theme F Phase 3 — double-click derivation lives HERE, in the
// parser: it is the only layer that sees raw press timing, and a
// self-contained {lastX,lastY,lastTime} triple keeps the derivation off
// the reducer hot path and out of the model. A fresh left press emits the
// `double` gesture when it lands on the SAME 1-based cell as the previous
// press within the window; otherwise `press` (and the triple advances).
// Right (2) → `right`, middle (1) → `middle`; any other button → null
// (dropped, as before).
// v0.6.4 Phase 4 — the window is the YAML-tunable `mouse.double-click-ms`
// (read from the mouse-bindings registry, required at the top of this file;
// defaults to 250 ms).
let _lastClickX = -1, _lastClickY = -1, _lastClickTime = -Infinity;

function _classifyPress(button, x, y, now) {
  if (button === 0) {
    const isDouble = x === _lastClickX && y === _lastClickY
      && (now - _lastClickTime) <= mouseBindings.doubleClickMs();
    if (isDouble) {
      // Reset the triple after a double so a 3rd rapid same-cell click
      // starts a fresh press — otherwise it re-satisfies the window and
      // emits a second `double` (a triple-click → two activations).
      _lastClickX = -1; _lastClickY = -1; _lastClickTime = -Infinity;
      return 'double';
    }
    _lastClickX = x; _lastClickY = y; _lastClickTime = now;
    return 'press';
  }
  if (button === 2) return 'right';
  if (button === 1) return 'middle';
  return null;  // other buttons stay dropped
}

function setupKeyListener() {
  // Phase 4 — the stdin closure used to capture `model` and thread it
  // into handleMouse / handleKey / render(model). Post-pure-TEA the
  // captured ref would freeze at boot state; every reader now re-reads
  // getModel() at the entry point that needs it. The function takes
  // no model arg.
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  enableMouse();             // SGR-mode mouse click reporting
  enableFocusEvents();       // \e[I on focus gain, \e[O on focus loss
  enableBracketedPaste();    // \e[200~ ... \e[201~ wraps pasted blocks

  stdin.on('data', _makeDataHandler(stdin));
}

// --- Chunk → token pipeline (network-lag fix, 2026-08-05) -----------------
//
// Locally raw mode fires one 'data' event per keystroke, so the historical
// whole-chunk exact matches (`data === '\x1b[B'`) worked. Over SSH they
// broke two ways:
//   1. Autorepeat BATCHES — one chunk carries `'jjjjj'` or
//      `'\x1b[B\x1b[B\x1b[B'`. The plain-char burst split per char but
//      PAINTED per key (N queued frames per chunk → the crawling-highlight
//      lag over a slow link), and a batched escape-prefixed chunk matched
//      nothing exact and was dropped WHOLE (held arrow-down over a laggy
//      link ate keystrokes).
//   2. TCP splits one sequence ACROSS chunks (`\x1b[` + `B`): the head
//      dropped as unknown-escape, the tail typed a stray plain 'B'.
// The tokenizer leaf splits a chunk into complete events; _dispatchToken
// runs the SAME per-event ladder the whole-chunk matches encoded. A
// multi-token chunk paints ONCE via render-queue beginBatch/endBatch
// (measured: a 5-key burst was 5 frames / 2,963 B per-key, 1 frame /
// 586 B batched); a single-token chunk keeps the synchronous paint, so
// local per-keystroke latency is untouched. An incomplete trailing
// sequence is CARRIED into the next chunk; a short flush timer logs +
// drops it if no continuation arrives (a deliberate Esc-then-`[` can't
// wedge the pipeline — flush equals the old incomplete-chunk treatment).
// Terminal mode shares the carry (a mouse report, a key to re-encode or a
// paste marker split across chunks rejoins there too); its flush hands the
// bytes to the program instead (_flushTerminalCarry).
const _CARRY_FLUSH_MS = 50;
let _carry = '';
let _carryTimer = null;

function _clearCarryTimer() {
  if (_carryTimer) { clearTimeout(_carryTimer); _carryTimer = null; }
}

// Hold `c` for the next chunk (it replaces any carry), flushing it after
// _CARRY_FLUSH_MS if nothing continues it — in whichever mode is current then.
// A paste OPEN marker cut after `ESC [ 2 0` or `ESC [ 2 0 0` is held with no
// flush timer, like a piece of the close inside a paste: when its halves came
// more than 50 ms apart, the head was flushed (dropped, or sent to the program)
// and the rest — `0~` and the pasted text — was typed as keys (a pasted
// `:theme nord\r` ran — round-3 review). The host always completes a marker it
// started, and F9 (`ESC [ 2 0 ~`) completes the same way. The shorter `ESC [`
// and `ESC [ 2` (Alt+[, Alt+[ then 2) still flush in the window.
function _isPasteOpenPiece(c) {
  return c.length >= 4 && c.length < _PASTE_OPEN.length && _PASTE_OPEN.startsWith(c);
}
function _holdCarry(c, { flush = true } = {}) {
  _clearCarryTimer();
  _carry = c;
  if (!c || !flush || _isPasteOpenPiece(c)) return;
  _carryTimer = setTimeout(() => {
    const held = _carry;
    _carry = '';
    _carryTimer = null;
    if (_terminalOwnsInput()) { _flushTerminalCarry(held); return; }
    // No continuation arrived — the "incomplete sequence" was a deliberate
    // Esc-prefix keyboard chord after all. Log + drop, exactly the
    // pre-tokenizer treatment of an incomplete chunk.
    require('../../io/event-log').record('input', {
      kind: 'unknown_escape',
      bytes: held.length > 64 ? held.slice(0, 64) + '...' : held,
    });
  }, _CARRY_FLUSH_MS);
  if (_carryTimer.unref) _carryTimer.unref();
}

function _makeDataHandler(stdin) {
  // Re-emit raw bytes as a fresh 'data' event — used when a token flips
  // the input mode mid-chunk (terminal-mode entry routes the rest of the
  // chunk to the PTY; a paste-open routes it into the accumulator). The
  // pending carry belongs after `rest` in stream order, so it rides along.
  const reemit = (rest) => {
    const tail = rest + _carry;
    _carry = '';
    _clearCarryTimer();
    stdin.emit('data', tail);
  };

  return (data) => {
    // The rest of a paste over the size cap, up to its close marker: discarded,
    // in whatever mode lazytui is in by now — it is still the host's paste.
    // (Dropping only the buffer forgot a paste was in progress: its later
    // chunks were typed as keys, a pasted `:theme nord\r` ran the command —
    // round-3 review.) A piece of the close marker at a chunk's end waits for
    // the next chunk; the bytes after the close go back to the pipeline.
    if (_pasteDrop !== null) {
      const joined = _pasteDrop + data;
      const end = joined.indexOf(_PASTE_CLOSE);
      if (end < 0) {
        _pasteDrop = joined.slice(joined.length - _markerPrefixAtEnd(joined, _PASTE_CLOSE));
        return;
      }
      _pasteDrop = null;
      const tail = joined.slice(end + _PASTE_CLOSE.length);
      if (tail) stdin.emit('data', tail);
      return;
    }
    // Terminal mode: to the program, event by event (_handleTerminalChunk),
    // with the carry from the previous chunk joined on.
    if (_terminalOwnsInput()) {
      const joined = _carry + data;
      _holdCarry('');
      _handleTerminalChunk(joined, reemit);
      return;
    }
    // A terminal-mode paste that its mode ended under (the program exited
    // mid-paste, its session died): the rest of it, up to its close marker, is
    // still pasted text — finish it in the normal-mode paste accumulator, not
    // as keys (a pasted `:theme nord\r` ran the command — round-2 review).
    if (_termPaste) {
      _termPaste = null;
      _pasteBuffer = _PASTE_OPEN;
      data = _carry + data;
      _holdCarry('');
    }

    // T25 — bracketed paste accumulator (B13). If we're mid-paste OR
    // this chunk starts with the open marker, route to the accumulator
    // until we see the close marker (or hit the size cap).
    if (_pasteBuffer || data.startsWith(_PASTE_OPEN)) {
      _pasteBuffer += data;
      // The close marker doesn't have to be at the END of the chunk —
      // a fast sender can fire the next event in the same chunk as the
      // paste close. Look for the FIRST close marker after the OPEN
      // and dispatch what's between; stash any trailing bytes back for
      // the next iteration.
      const closeIdx = _pasteBuffer.indexOf(_PASTE_CLOSE);
      // Over the cap, the paste is dropped WHOLE: what arrived is discarded,
      // the rest (still to come) goes to _pasteDrop, the bytes after a close
      // in this chunk go on.
      if ((closeIdx >= 0 ? closeIdx : _pasteBuffer.length) > _PASTE_MAX) {
        console.error(`[input] bracketed paste exceeded ${_PASTE_MAX} bytes — dropped`);
        require('../../io/event-log').record('input', { kind: 'paste_oversize', size: _pasteBuffer.length });
        const buf = _pasteBuffer;
        _pasteBuffer = '';
        if (closeIdx < 0) {
          _pasteDrop = buf.slice(buf.length - _markerPrefixAtEnd(buf, _PASTE_CLOSE));
          return;
        }
        const tail = buf.slice(closeIdx + _PASTE_CLOSE.length);
        if (tail) stdin.emit('data', tail);
        return;
      }
      if (closeIdx >= 0) {
        const text = _pasteBuffer.slice(_PASTE_OPEN.length, closeIdx);
        const tail = _pasteBuffer.slice(closeIdx + _PASTE_CLOSE.length);
        _pasteBuffer = '';
        handleKey('paste', text);
        if (tail) { _pasteBuffer = ''; stdin.emit('data', tail); }
      }
      return;
    }

    // Tokenize, joining any partial sequence carried from the previous
    // chunk. A fresh chunk supersedes the pending carry flush.
    const { tokens, carry } = tokenizeInput(_carry + data);
    _holdCarry(carry);
    if (!tokens.length) return;

    // Multi-token chunk → one trailing paint (render-queue.beginBatch).
    const batch = tokens.length > 1;
    if (batch) beginBatch();
    try {
      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        // A token can flip the input mode mid-chunk; the REST of the
        // chunk then belongs to the new mode's parser, not this ladder.
        if (i > 0 && _terminalOwnsInput()) { reemit(tokens.slice(i).join('')); return; }
        // A paste-open reaching here came from a chunk-split OPEN marker
        // rejoined by the carry (a whole-chunk open hits the accumulator
        // branch above) — hand the rest back so the accumulator owns it.
        if (tok === _PASTE_OPEN) { reemit(tokens.slice(i).join('')); return; }
        _dispatchToken(tok);
      }
      // A terminal-mode flip on the FINAL token leaves no next iteration
      // to hand off through — but the pending carry belongs to the PTY
      // stream now, not the keyboard parser: hand it to the terminal path
      // (which holds it again for the next chunk, or exits the mode at once
      // when the session is already dead).
      if (_carry && _terminalOwnsInput()) reemit('');
    } finally { if (batch) endBatch(); }
  };
}

// --- Kitty-keyboard detection handshake (docs/kitty-keyboard.md P2) --------
// beginKeyboardDetection() writes the query + DA1 fence (term.queryKKP) and
// arms the response arm below. A kitty-keyboard terminal answers the flags
// report `\x1b[?<flags>u` BEFORE the Primary-DA reply `\x1b[?...c`; a terminal
// without the protocol answers only DA1. On the DA1 fence we finalize: record
// the capability (kkp_detected Msg → model.caps.keyboard) and, on support,
// push our flags via enableKKP(). Both replies tokenize as ordinary CSI
// sequences, so they arrive here through the normal pipeline. The arm is armed
// only during the handshake window, so a stray private-mode CSI can't be
// mistaken for a response afterward.
let _kkpDetecting = false;
let _kkpSawReply = false;
const _KKP_REPLY_RE = /^\x1b\[\?[\d;:]*u$/;   // CSI ? flags u  (kitty flags report)
const _DA1_REPLY_RE = /^\x1b\[\?[\d;]*c$/;    // CSI ? ... c     (Primary DA — the fence)

// Generous safety-net window: a real terminal answers the query near-instantly
// (locally, or one SSH round-trip away). This only fires when a terminal
// answers NEITHER the flags query NOR the DA1 fence — rare — so erring long
// costs nothing but avoids a false "unsupported" on a laggy link.
const _KKP_DETECT_MS = 2000;
let _kkpDetectTimer = null;

function beginKeyboardDetection() {
  _kkpDetecting = true;
  _kkpSawReply = false;
  require('../../io/term').queryKKP();
  // Safety net: if the DA1 fence never comes back (a terminal that ignores the
  // query, or a lost reply), finalize after a short window so caps still
  // resolves and the leader-e hint is still written — rather than staying
  // armed for the session. Unref'd so it never holds the process open; cleared
  // the moment the fence arrives.
  if (_kkpDetectTimer) clearTimeout(_kkpDetectTimer);
  _kkpDetectTimer = setTimeout(_finalizeDetection, _KKP_DETECT_MS);
  if (_kkpDetectTimer.unref) _kkpDetectTimer.unref();
}

// Resolve the auto handshake: record caps ('kitty' iff we saw the flags report
// before the fence), push the flags on support, write the hint. Idempotent via
// the _kkpDetecting guard — the DA1 fence token and the timeout race to call
// this; first wins, the other becomes a no-op.
function _finalizeDetection() {
  if (_kkpDetectTimer) { clearTimeout(_kkpDetectTimer); _kkpDetectTimer = null; }
  if (!_kkpDetecting) return;
  _kkpDetecting = false;
  const supported = _kkpSawReply;
  applyMsg({ type: 'kkp_detected', supported });
  if (supported) require('../../io/term').enableKKP();
  _recordKbdDiag(null);
}

// The diagnostics hint for a failed detection. A multiplexer (tmux/screen/
// zellij) is the common reason a kitty-capable terminal reports "unsupported":
// it answers the DA1 fence itself but doesn't negotiate the protocol for the
// inner app. Name it so the user isn't left blaming their real terminal.
function _kkpUnsupportedMsg() {
  const mux = process.env.TMUX ? 'tmux'
    : process.env.STY ? 'screen'
    : process.env.ZELLIJ ? 'zellij'
    : null;
  return mux
    ? `legacy — kitty keyboard protocol not negotiated (running inside ${mux}; run outside it to enable)`
    : 'legacy — kitty keyboard protocol not supported by this terminal';
}

// Write the leader-e session fact, reading the EFFECTIVE protocol from
// model.caps.keyboard — the single source of truth just set by kkp_detected
// (so caps has a genuine reader, not just a writer). `ctx.forced`/`ctx.disabled`
// pick the explicit-config wording; a null ctx is the auto-detected path.
function _recordKbdDiag(ctx) {
  const diag = require('../../io/diag-log');
  if (getModel().caps.keyboard === 'kitty') {
    diag.info('keyboard', ctx && ctx.forced
      ? 'kitty keyboard protocol force-enabled (keyboard_protocol: kitty)'
      : 'kitty keyboard protocol enabled (CSI-u disambiguate)');
  } else {
    diag.info('keyboard', ctx && ctx.disabled
      ? 'legacy keyboard mode (kitty keyboard protocol disabled)'
      : _kkpUnsupportedMsg());
  }
}

// Apply the boot-resolved keyboard mode (tui.js, after the env/config gate).
// 'auto' runs the detection handshake; 'kitty' force-enables without it;
// 'legacy' stays on the tokenizer path. All three record caps + the hint.
function applyKeyboardMode(mode) {
  if (mode === 'kitty') {
    require('../../io/term').enableKKP();
    applyMsg({ type: 'kkp_detected', supported: true });
    _recordKbdDiag({ forced: true });
  } else if (mode === 'legacy') {
    require('../../io/term').disableKKP();   // authoritative off (a no-op at boot)
    applyMsg({ type: 'kkp_detected', supported: false });
    _recordKbdDiag({ disabled: true });
  } else {
    beginKeyboardDetection();
  }
}

// Consume a handshake response token. Returns true if `tok` was a response
// (so the ladder must not treat it as a key), false otherwise.
function _maybeKkpResponse(tok) {
  if (!_kkpDetecting) return false;
  if (_KKP_REPLY_RE.test(tok)) { _kkpSawReply = true; return true; }
  if (_DA1_REPLY_RE.test(tok)) { _finalizeDetection(); return true; }
  return false;
}

/**
 * One complete input event → the same ladder the whole-chunk handler used
 * to exact-match. Behavior is preserved event-for-event; the ladder now
 * also applies to events that arrive batched, which the exact matches
 * missed (a batched `\r` used to dispatch as a raw char instead of
 * `return`; a batched `\x03` didn't quit).
 */
// The host window gained / lost focus (DEC 1004 reports). On blur, the periodic
// refresh loop in tui.js pauses; on focus return, one catch-up refresh fires
// immediately so stale data doesn't show. Shared by the normal-mode ladder and
// terminal mode (where the report also reaches a program that asked for it).
function _hostFocus(focused) {
  const wasUnfocused = !getModel().focused;
  applyMsg({ type: 'focus_event', focused });
  if (focused && wasUnfocused) require('../../leaves/infra/render-queue').scheduleRender();
}

function _dispatchToken(tok) {
  // Kitty-keyboard handshake replies (only while a detection is in flight).
  if (_maybeKkpResponse(tok)) return;

  // Terminal focus events (DEC 1004) — see _hostFocus.
  if (tok === '\x1b[I' || tok === '\x1b[O') return _hostFocus(tok === '\x1b[I');

  // SGR mouse event: \x1b[<button;x;yM (press / motion) or m (release).
  const mm = _SGR_MOUSE_RE.exec(tok);
  if (mm) return _dispatchMouseEvent(mm);

  // Arrows, Page keys, Shift-Tab (CSI Z — the fabric-form's focus-prev,
  // deep-review round 4 Finding 1) and the other special keys: decodeKey,
  // below, in whichever form the host sends them.
  if (tok === '\x1b' || tok === '\x1b\x1b') return handleKey('escape');
  if (tok === '\r' || tok === '\n' || tok === '\r\n') return handleKey('return');
  if (tok === '\x03') { cleanup(); process.exit(0); }
  if (tok === '\x12') return handleKey('ctrl-r');  // Ctrl+R → free-config redo
  // ^H (BS) is Backspace: terminals set to send it (PuTTY, `stty erase ^H`,
  // some Windows consoles) and readline's Ctrl+H. Normalized ONCE here, so every
  // handler that reads Backspace as `seq === '\x7f'` (each text field, menu
  // back) takes it — only the free-config rename knew it before. A user's
  // `keymap: normal:` binding on "\b" still fires in normal mode (dispatch
  // ctrlHKey). A KKP Ctrl+H / BS event decodes to \x08 and re-enters this
  // ladder. (Terminal mode never gets here: an embedded program gets its bytes raw.)
  if (tok === '\b') { const k = ctrlHKey(); return handleKey(k, k); }

  // Kitty-keyboard CSI-u key event (`\x1b[<code>;<mods>u`, only arrives once
  // the protocol is enabled). Normalize back to the legacy byte and re-run the
  // ladder (D4) — so Esc→\x1b, Ctrl+C→\x03 (quit), Ctrl+R→\x12 (redo). An event
  // with no legacy equivalent lazytui binds returns null and falls through to
  // the unknown-escape drop below, matching legacy mode.
  if (tok.charCodeAt(0) === 0x1b && tok.charCodeAt(tok.length - 1) === 0x75 /* 'u' */) {
    const legacy = kkpToLegacy(tok);
    if (legacy != null) return _dispatchToken(legacy);
  }

  // The special keys, in whichever form the host terminal sends them
  // (leaves/input/key-decode — the decoder terminal mode uses too): the arrows
  // and Page keys (`CSI A`, SS3 `O A`, VT220 `CSI 5 ~`), Shift-Tab, Home / End
  // (`CSI H`, tmux's `CSI 1 ~`, rxvt's `CSI 7 ~`, SS3 …), Insert / Delete,
  // F1–F12. Home/End/Insert/Delete/F-keys were dropped as unknown escapes, so
  // a `<home>` / `<end>` / `<delete>` / `<f1>` leader binding could never
  // fire, and the handlers already written for them (the agent prompt's
  // Home/End/Delete, the text view's Home/End) never ran. Unmodified only:
  // nothing binds a modified one, so those still drop below. Named keys carry
  // no `seq`, so no text input inserts them.
  const named = decodeKey(tok);
  if (named && !named.shift && !named.alt && !named.ctrl) return handleKey(named.key);

  // T25 / B14 — never fire Esc for an escape-PREFIXED event: what reaches
  // here is a sequence nothing above named — an Alt chord (\x1bj), a modified
  // key (\x1b[1;3A, Ctrl+Home), F13+ — and firing Esc for it would silently
  // cancel any open modal. Esc fires only for the exact forms caught above;
  // other escape-initiated tokens log + drop (event-log, so a maintainer
  // reading a recorded session can see what unknown sequences fired).
  if (tok.charCodeAt(0) === 0x1b) {
    require('../../io/event-log').record('input', {
      kind: 'unknown_escape',
      bytes: tok.length > 64 ? tok.slice(0, 64) + '...' : tok,
    });
    return;
  }

  handleKey(tok, tok);
}

/** One SGR mouse event (an _SGR_MOUSE_RE match). */
const _BUTTON_NUM = { left: 0, middle: 1, right: 2 };
function _dispatchMouseEvent(mm) {
  const ev = _decodeSgrMouse(parseInt(mm[1], 10), parseInt(mm[2], 10), parseInt(mm[3], 10), mm[4]);
  if (!ev) return;                                   // buttons 8–11, a wheel release
  const { x, y } = ev;
  if (ev.button === 'wheel') {
    // Vertical only: lazytui has no horizontal axis, so wheel-left/-right
    // (66/67, tilt wheel / trackpad side-scroll) drop. Reading only bit 0 once
    // misread them as vertical steps — the list cursor jittered during a slow
    // scroll.
    if (ev.action === 'wheel-up' || ev.action === 'wheel-down') handleMouse(ev.action, x, y);
    return;
  }
  // Motion + release stay left-only — text-select extend/commit have no
  // right/middle analog, so a right/middle drag or release is dropped.
  if (ev.action === 'up') return ev.button === 'left' ? handleMouse('release', x, y) : undefined;
  if (ev.action === 'move') {
    if (ev.button === 'left') return handleMouse('motion', x, y);   // left-drag: text-select / pool drag
    if (ev.button === 'none') return handleMouse('hover', x, y);    // button-less move (mode 1003): graph hover
    return;                                                         // right/middle drag: dropped
  }
  // Fresh press — classify into press/double (left) or right/middle.
  // v0.6.4 Theme F Phase 3 — was `if (button !== 0) return`, which
  // dropped every non-left button at the door.
  const gesture = _classifyPress(_BUTTON_NUM[ev.button], x, y, Date.now());
  if (gesture) handleMouse(gesture, x, y);
}

module.exports = {
  setupKeyListener,
  applyKeyboardMode,        // boot: apply the resolved keyboard mode (tui.js)
  beginKeyboardDetection,   // exported for tests (in-process handshake driving)
  _handleTerminalChunk,     // exported for tests (terminal-mode chunk: paste, controls, keys, mouse)
  _classifyTerminalToken,   // exported for tests (pure: one terminal-mode input event)
  _handleWheel: (...a) => require('./pane-mouse').handleWheel(...a),   // exported for tests (moved to pane-mouse, R3)
  handleMouse,              // exported for tests
  _classifyPress,           // exported for tests (Theme F Phase 3 double-click derivation)
  _makeDataHandler,         // exported for tests (input-burst smoke drives the real handler)
  _dispatchToken,           // exported for tests (round-4 Fork 2 — key-path integration for fabric-form Tab)
};
