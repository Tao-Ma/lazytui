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
 *   scrollScreen / scrollScreenPages / scrollScreenToTop / scrollScreenToBottom → moved?
 *   screenScrollInfo(screen) → {atBottom,linesBelow}   screenMouseMode(screen) → mode
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

function createScreen(cols, rows) {
  return new Terminal({ cols, rows, allowProposedApi: true });
}

function writeScreen(screen, data, cb) { screen.write(data, cb); }

function resizeScreen(screen, cols, rows) { screen.resize(cols, rows); }

function disposeScreen(screen) { screen.dispose(); }

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
  createScreen, writeScreen, resizeScreen, disposeScreen, screenSize,
  scrollScreen, scrollScreenPages, scrollScreenToTop, scrollScreenToBottom,
  screenScrollInfo, screenMouseMode, readViewport, screenCursor,
  serializeScreen, restoreScreen,
};
