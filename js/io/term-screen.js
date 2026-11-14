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
 *   screenInputModes(screen) → {appCursor,sendFocus,bracketedPaste,altScreen}
 *   screenMouseReport(screen, ev) → sent?   (encode a mouse event for the program)
 *   readViewport(screen,h,w) → {viewportY, rows:[text], runs:[[{sgr,text}]]}   (render)
 *   serializeScreen(screen) → snapshot       restoreScreen(snapshot) → screen
 *
 * Styled reads: a row is read cell by cell into RUNS of `{ sgr, text }` — `sgr`
 * is the run's SGR parameter list ('' = every attribute at its default), the
 * terminal lingua franca, so callers stay emulator-agnostic. The render resolves
 * the default colours against the theme (ansi.sgrRun); the snapshot writes the
 * same runs back as SGR. A read row is EXACTLY the requested width in columns
 * (charWidth): it pads, and it stops before a glyph that would cross the edge,
 * so a painted row can never run past its pane's border.
 *
 * Grid snapshot fidelity: the snapshot captures the buffer's text AND
 * attributes (scrollback + visible) as SGR-encoded lines + the viewport
 * position — faithful to what is painted. The recorded PTY byte stream (the WAL
 * diff log, io/terminal.js) remains the exact source for continued output.
 */
'use strict';

const { Terminal } = require('@xterm/headless');
const { charWidth, stringWidth } = require('../leaves/text/char-width');
const { screenColors } = require('../leaves/text/ansi');

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

// A program asks its terminal for the default foreground / background colour
// (OSC 10 / OSC 11 with `?`) — nvim picks 'background' light/dark from the
// answer. The emulator has no colours of its own to report; the cells a
// program leaves at the default colour are painted with the theme's screen
// colours (ansi.sgrRun), so those are the answer, in xterm's `rgb:RRRR/GGGG/
// BBBB` form, sent back like any other reply (onScreenReply). Unknown (screen
// colours off: the host's own colours show) = unanswered, as before; a SET
// (`OSC 11 ; <colour>`) is not a query and is left alone. As in xterm, one OSC
// can carry several slots, each the next dynamic colour: `OSC 10 ; ? ; ?` asks
// for the foreground AND the background — each `?` gets its own answer (slots
// past 11 — cursor colour, … — have no theme colour: unanswered). The reply
// ends in ST: xterm.js's OSC handler doesn't say whether the query ended in
// BEL, and programs (nvim, vim, fzf) take ST either way.
function _hex4(n) { const h = n.toString(16).padStart(2, '0'); return h + h; }
const _DYNAMIC = { 10: 'fg', 11: 'bg' };
function _answerColorQuery(screen, ident, data) {
  const c = screenColors();
  if (!c) return false;
  const slots = data.split(';');
  let answered = false;
  slots.forEach((v, i) => {
    const key = _DYNAMIC[ident + i];
    if (v !== '?' || !key) return;
    const [r, g, b] = c[key];
    screen.input(`\x1b]${ident + i};rgb:${_hex4(r)}/${_hex4(g)}/${_hex4(b)}\x1b\\`, false);
    answered = true;
  });
  return answered;
}

function createScreen(cols, rows) {
  const screen = new Terminal({ cols, rows, allowProposedApi: true });
  screen.unicode.register(_WIDTH_PROVIDER);
  screen.unicode.activeVersion = _WIDTH_PROVIDER.version;
  screen.parser.registerOscHandler(10, (d) => _answerColorQuery(screen, 10, d));
  screen.parser.registerOscHandler(11, (d) => _answerColorQuery(screen, 11, d));
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

/** What the program asked of its terminal's INPUT side — how keys and events
 *  must reach it: `appCursor` (DECCKM `CSI ? 1 h`: arrows / Home / End in SS3
 *  form), `sendFocus` (`CSI ? 1004 h`: focus in/out reports), `bracketedPaste`
 *  (`CSI ? 2004 h`: pastes wrapped in `CSI 200 ~` … `CSI 201 ~`), `altScreen`
 *  (on the alternate buffer — a full-screen program, no scrollback to show). */
function screenInputModes(screen) {
  const m = screen.modes;
  return { appCursor: !!m.applicationCursorKeysMode, sendFocus: !!m.sendFocusMode,
           bracketedPaste: !!m.bracketedPasteMode, altScreen: screen.buffer.active.type === 'alternate' };
}

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

// --- Styled reads -----------------------------------------------------------

// A palette colour 0–15 is one of the 16 ANSI colours whichever way the program
// set it (`31` or `38;5;1`): emit the 16-colour form, which a 16-colour host
// draws in ITS palette. 16–255 and RGB keep their exact form; the write boundary
// downgrades them to the host's depth (render/paint.js → color-depth).
function _colorParams(palette, rgb, v, base) {
  if (palette) {
    if (v < 8) return String(base + v);
    if (v < 16) return String(base + 60 + v - 8);
    return `${base + 8};5;${v}`;
  }
  if (rgb) return `${base + 8};2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`;
  return '';
}

function _cellSgr(c) {
  const p = [];
  if (c.isBold()) p.push('1');
  if (c.isDim()) p.push('2');
  if (c.isItalic()) p.push('3');
  if (c.isUnderline()) p.push('4');
  if (c.isBlink()) p.push('5');
  if (c.isInverse()) p.push('7');
  if (c.isInvisible()) p.push('8');
  if (c.isStrikethrough()) p.push('9');
  if (c.isOverline()) p.push('53');
  const fg = _colorParams(c.isFgPalette(), c.isFgRGB(), c.getFgColor(), 30);
  if (fg) p.push(fg);
  const bg = _colorParams(c.isBgPalette(), c.isBgRGB(), c.getBgColor(), 40);
  if (bg) p.push(bg);
  return p.join(';');
}

// Attribute bits for run-change detection (numbers, not the SGR string: the
// string is built only when a run starts).
function _attrBits(c) {
  return (c.isBold() ? 1 : 0) | (c.isDim() ? 2 : 0) | (c.isItalic() ? 4 : 0) |
    (c.isUnderline() ? 8 : 0) | (c.isBlink() ? 16 : 0) | (c.isInverse() ? 32 : 0) |
    (c.isInvisible() ? 64 : 0) | (c.isStrikethrough() ? 128 : 0) | (c.isOverline() ? 256 : 0);
}

const _textWidth = stringWidth;

/** One buffer line → runs `[{ sgr, text }]` exactly `width` columns wide. */
function _readRow(line, width, cell) {
  const runs = [];
  let col = 0, run = null, pf = NaN, pb = NaN, pa = NaN;
  const n = line ? Math.min(width, line.length) : 0;
  for (let x = 0; x < n; x++) {
    line.getCell(x, cell);
    let text = cell.getChars();
    if (cell.getWidth() === 0 && text === '') continue; // right half of a wide glyph
    let w = text === '' ? 1 : _textWidth(text);
    if (text === '') text = ' ';                        // never-written / erased cell
    // A zero-width character with nothing to join (a ZWSP, a combining mark or
    // VS16 at the start of a row) gets a cell of its own in the emulator (width
    // 0, but the cursor moved past it): skipped like a wide glyph's right half,
    // the rest of the row landed one column left of where the program put it.
    // It paints as a space carrying the mark — the column the emulator gave it.
    if (w === 0) { text = ' ' + text; w = 1; }
    if (col + w > width) break;                         // never past the edge
    const f = cell.getFgColorMode() + cell.getFgColor();
    const b = cell.getBgColorMode() + cell.getBgColor();
    const a = _attrBits(cell);
    if (!run || f !== pf || b !== pb || a !== pa) {
      run = { sgr: _cellSgr(cell), text: '' };
      runs.push(run);
      pf = f; pb = b; pa = a;
    }
    run.text += text;
    col += w;
  }
  if (col < width) {
    const pad = ' '.repeat(width - col);
    if (run && run.sgr === '') run.text += pad;
    else runs.push({ sgr: '', text: pad });
  }
  return runs;
}

/** The visible viewport (the render read): `runs[i]` is the i-th visible line as
 *  styled runs, exactly `width` columns; `rows[i]` is its text. */
function readViewport(screen, height, width) {
  const buf = screen.buffer.active;
  const cell = buf.getNullCell();
  const rows = [], runs = [];
  for (let r = 0; r < height; r++) {
    const rr = _readRow(buf.getLine(r + buf.viewportY), width, cell);
    runs.push(rr);
    let text = '';
    for (const x of rr) text += x.text;
    rows.push(text);
  }
  return { viewportY: buf.viewportY, rows, runs };
}

/** Snapshot the screen (scrollback + visible) + geometry + scroll pos — the grid
 *  snapshot for checkpoints. Each line is its styled runs written as SGR, with
 *  trailing default blanks trimmed; a plain line is just its text. */
function serializeScreen(screen) {
  const buf = screen.buffer.active;
  const cell = buf.getNullCell();
  const lines = [];
  for (let y = 0; y < buf.length; y++) {
    const runs = _readRow(buf.getLine(y), screen.cols, cell);
    const last = runs[runs.length - 1];
    if (last && last.sgr === '') {
      last.text = last.text.replace(/ +$/, '');
      if (!last.text) runs.pop();
    }
    let out = '', state = '';
    for (const r of runs) {
      if (r.sgr !== state) { out += r.sgr ? `\x1b[0;${r.sgr}m` : '\x1b[0m'; state = r.sgr; }
      out += r.text;
    }
    if (state) out += '\x1b[0m';
    lines.push(out);
  }
  return { cols: screen.cols, rows: screen.rows, lines, baseY: buf.baseY, viewportY: buf.viewportY };
}

/** Rebuild a screen from a snapshot: write the captured lines back (SGR and all;
 *  it fills the screen then scrolls into scrollback), then restore the scroll
 *  position. Write is async (parsed on a callback); callers flush before reading. */
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
  screenScrollInfo, screenMouseMode, screenInputModes, screenMouseReport, readViewport, screenCursor,
  serializeScreen, restoreScreen,
};
