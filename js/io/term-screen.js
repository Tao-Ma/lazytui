/**
 * Terminal-emulator screen port — the ONE module that knows the emulator.
 *
 * lazytui embeds a terminal emulator to back its PTY panes (the #D14 foreign
 * component). This module is the **port**: a small, defined screen API that the
 * rest of the system uses, with the concrete emulator (`@xterm/headless`) as the
 * single implementation behind it. It is the ONLY module that imports the
 * emulator — `io/terminal.js` (sessions/lifecycle), `render/paint.js`, and
 * `dispatch/runtime/finalize.js` reach the screen exclusively through these
 * functions. Swapping the emulator = reimplement this one adapter.
 *
 * A `screen` handle is opaque to callers (here it is an xterm Terminal). The API:
 *   createScreen(cols,rows) → screen        writeScreen(screen,data,cb)
 *   resizeScreen / disposeScreen            screenSize(screen) → {cols,rows}
 *   onScreenReply(screen, fn) → disposable  (the emulator's replies to the program)
 *   scrollScreen / scrollScreenPages / scrollScreenToTop / scrollScreenToBottom → moved?
 *   screenScrollInfo(screen) → {atBottom,linesBelow}   screenMouseMode(screen) → mode
 *   screenMouseReport(screen, ev) → sent?   (encode a mouse event for the program)
 *   readViewport(screen,h,w) → {viewportY, rows:[text]}   (render)
 *   serializeScreen(screen) → snapshot       restoreScreen(snapshot) → screen
 *
 * Grid snapshot fidelity: lazytui renders the terminal as MONOCHROME TEXT —
 * `render/paint.js` reads each row via `translateToString` (characters only; no
 * attributes). So the snapshot captures the buffer's TEXT (scrollback + visible)
 * + viewport position — faithful to what is actually painted, with no SGR
 * serializer and no extra dependency. The recorded PTY byte stream (the WAL
 * diff log, io/terminal.js) remains the exact source for continued output.
 */
'use strict';

const { Terminal } = require('@xterm/headless');
const { charWidth } = require('../leaves/text/char-width');

// The emulator measures with the frame's width truth. A program's output is laid
// out by the emulator (where a wide glyph puts the cursor next), then painted by
// lazytui at the frame's widths and drawn by the host at its own; one function
// for both ends means a row the emulator fills is exactly the pane's width when
// painted. The emulator's built-in table is Unicode 6 (every emoji 1 column),
// which put each ⚡/💤 one column past the pane border on a full row.
// `charProperties` packs (width << 1 | join) the way @xterm/headless's own
// provider does: a zero-width codepoint joins the preceding cell and keeps its
// width; C0/C1 controls are 0, as in the built-in table.
const _WIDTH_PROVIDER = {
  version: 'lazytui',
  wcwidth(cp) {
    return (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) ? 0 : charWidth(cp);
  },
  charProperties(cp, preceding) {
    let width = _WIDTH_PROVIDER.wcwidth(cp);
    let join = width === 0 && preceding !== 0;
    if (join) {
      const prev = (preceding >> 1) & 3;
      if (prev === 0) join = false;
      else if (prev > width) width = prev;
    }
    return ((width & 3) << 1) | (join ? 1 : 0);
  },
};

function createScreen(cols, rows) {
  const screen = new Terminal({ cols, rows, allowProposedApi: true });
  screen.unicode.register(_WIDTH_PROVIDER);
  screen.unicode.activeVersion = _WIDTH_PROVIDER.version;
  return screen;
}

function writeScreen(screen, data, cb) { screen.write(data, cb); }

function resizeScreen(screen, cols, rows) { screen.resize(cols, rows); }

function disposeScreen(screen) { screen.dispose(); }

/** Subscribe to what the emulator sends BACK to the program: its answers to the
 *  program's terminal queries (device attributes `ESC [ c` / `ESC [ > c`, cursor
 *  position `ESC [ 6 n`, mode reports) and the mouse reports it encodes. A real
 *  terminal writes these to the program's stdin; `fn(data, binary)` is that
 *  write. `binary` marks a byte string (the legacy X10 mouse encoding) that must
 *  reach the PTY as raw bytes, not UTF-8. Returns a disposable. */
function onScreenReply(screen, fn) {
  const a = screen.onData((d) => fn(d, false));
  const b = screen.onBinary((d) => fn(d, true));
  return { dispose() { a.dispose(); b.dispose(); } };
}

function screenSize(screen) { return { cols: screen.cols, rows: screen.rows }; }

// Scrollback viewport moves. Each returns whether the viewport actually moved
// (so the caller can gate a repaint), mirroring the prior io/terminal behavior.
function scrollScreen(screen, amount) {
  const before = screen.buffer.active.viewportY;
  screen.scrollLines(amount | 0);
  return screen.buffer.active.viewportY !== before;
}
function scrollScreenPages(screen, n) {
  const before = screen.buffer.active.viewportY;
  screen.scrollPages(n | 0);
  return screen.buffer.active.viewportY !== before;
}
function scrollScreenToTop(screen) {
  const before = screen.buffer.active.viewportY;
  screen.scrollToTop();
  return screen.buffer.active.viewportY !== before;
}
function scrollScreenToBottom(screen) {
  const before = screen.buffer.active.viewportY;
  screen.scrollToBottom();
  return screen.buffer.active.viewportY !== before;
}

/** Scroll position: { atBottom, linesBelow } — linesBelow = rows above the live bottom. */
function screenScrollInfo(screen) {
  const buf = screen.buffer.active;
  const linesBelow = Math.max(0, buf.baseY - buf.viewportY);
  return { atBottom: linesBelow === 0, linesBelow };
}

/** The child's DEC mouse-tracking mode ('none' | x10 | vt200 | drag | any). */
function screenMouseMode(screen) { return screen.modes.mouseTrackingMode; }

// The emulator's mouse encoder: given a grid cell + button + action it applies
// the program's DEC protocol (x10 / vt200 / drag / any — e.g. no hover motion
// for a button-event program, no repeat of an unchanged cell) and its encoding
// (SGR, or the legacy X10 bytes vim picks for a `> 0;276;0 c` terminal), and
// emits the report through onScreenReply. `coreMouseService` is xterm's internal
// service — the public headless API exposes the mode but no way to encode; this
// port is the one module that knows the emulator, and a test pins the service
// (test-terminal-mouse-forward), so an upgrade that moves it fails loudly.
const _MOUSE_BUTTON = { left: 0, middle: 1, right: 2, none: 3, wheel: 4 };
const _MOUSE_ACTION = { up: 0, down: 1, move: 32,
  'wheel-up': 0, 'wheel-down': 1, 'wheel-left': 2, 'wheel-right': 3 };

/** Encode one mouse event for the program: `ev` = { col, row (0-based grid
 *  cell), button: left|middle|right|none|wheel, action: down|up|move|
 *  wheel-up|wheel-down|wheel-left|wheel-right, shift, alt, ctrl }. Returns
 *  whether a report was emitted (false: the protocol doesn't take it, or the
 *  encoder is unavailable). */
function screenMouseReport(screen, ev) {
  const ms = screen._core && screen._core.coreMouseService;
  if (!ms || typeof ms.triggerMouseEvent !== 'function') return false;
  const button = _MOUSE_BUTTON[ev.button], action = _MOUSE_ACTION[ev.action];
  if (button === undefined || action === undefined) return false;
  return !!ms.triggerMouseEvent({ col: ev.col, row: ev.row, x: 0, y: 0, button, action,
                                  ctrl: !!ev.ctrl, alt: !!ev.alt, shift: !!ev.shift });
}

/** The cursor position within the viewport ({x, y}, 0-based) — for placing the
 *  real screen cursor over the embedded terminal in terminal mode. */
function screenCursor(screen) {
  const buf = screen.buffer.active;
  return { x: buf.cursorX, y: buf.cursorY };
}

/** The visible viewport as plain-text rows (the render read). `rows[i]` is the
 *  i-th visible line via translateToString (caller pads to width). */
function readViewport(screen, height, width) {
  const buf = screen.buffer.active;
  const rows = [];
  for (let r = 0; r < height; r++) {
    const line = buf.getLine(r + buf.viewportY);
    rows.push(line ? line.translateToString(false, 0, width) : '');
  }
  return { viewportY: buf.viewportY, rows };
}

/** Snapshot the screen's TEXT (scrollback + visible) + geometry + scroll pos —
 *  the grid snapshot for checkpoints. Faithful to the monochrome-text render. */
function serializeScreen(screen) {
  const buf = screen.buffer.active;
  const lines = [];
  for (let y = 0; y < buf.length; y++) {
    const ln = buf.getLine(y);
    lines.push(ln ? ln.translateToString(true) : '');
  }
  return { cols: screen.cols, rows: screen.rows, lines, baseY: buf.baseY, viewportY: buf.viewportY };
}

/** Rebuild a screen from a snapshot: write the captured text back (it fills the
 *  screen then scrolls into scrollback), then restore the scroll position.
 *  Write is async (parsed on a callback); callers flush before reading. */
function restoreScreen(snap, cb) {
  const screen = createScreen(snap.cols, snap.rows);
  screen.write((snap.lines || []).join('\r\n'), () => {
    const linesBelow = Math.max(0, (snap.baseY || 0) - (snap.viewportY || 0));
    if (linesBelow > 0) screen.scrollLines(-linesBelow);
    if (cb) cb();
  });
  return screen;
}

module.exports = {
  createScreen, writeScreen, resizeScreen, disposeScreen, screenSize, onScreenReply,
  scrollScreen, scrollScreenPages, scrollScreenToTop, scrollScreenToBottom,
  screenScrollInfo, screenMouseMode, screenMouseReport, readViewport, screenCursor,
  serializeScreen, restoreScreen,
};
