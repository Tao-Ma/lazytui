/**
 * Detail-panel text selection state machine.
 *
 * The selection lives in *absolute* detail-line indices and *display
 * columns* (0-indexed). Storing absolute lines means the selection
 * stays anchored to its content as the user scrolls — extending it
 * outside the visible window doesn't lose the anchor.
 *
 * Coordinate system:
 *   - line: index into S.detailLines (markup-stripped projection used
 *           for slicing during commit; render path applies highlight on
 *           top of the markup).
 *   - col:  display column 0-indexed within the plain-text projection
 *           of the line. East-asian width is honored: a 2-cell CJK char
 *           occupies cols [c, c+1] and clicking on either resolves to
 *           that character.
 *
 * Two selection kinds:
 *   - 'char': anchor..cursor span (mouse drag, vim `v`).
 *   - 'line': whole lines from min(anchor.line, cursor.line) to max
 *             (vim `V`). col is ignored.
 *
 * On commit, the resolved plain-text span is pushed onto the yank
 * register (which mirrors to OS clipboard via OSC52).
 *
 * Selection is transient: after commit() or cancel(), S.select.active
 * is false and the highlight disappears. The register keeps the value.
 */
'use strict';

const { S } = require('./state');
const { stripMarkup, charWidth, esc } = require('./ansi');
const register = require('./register');

function _init() {
  if (!S.select) {
    S.select = {
      active: false,
      kind: 'char',
      anchor: { line: 0, col: 0 },
      cursor: { line: 0, col: 0 },
    };
  }
}

/** Plain text projection of detail line `i` (markup stripped). */
function plainLine(i) {
  const ln = S.detailLines[i];
  return ln == null ? '' : stripMarkup(ln);
}

/** Display width of the plain text projection of a line. */
function plainLineWidth(i) {
  const s = plainLine(i);
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0));
  return w;
}

/**
 * START boundary: convert displayCol to the codepoint index of the
 * first character whose display range contains or starts at displayCol.
 * Clicking either cell of a 2-wide CJK char resolves to that char.
 * `displayCol` past the line width returns the past-the-end index.
 */
function _displayColToCharIdx(plain, displayCol) {
  let dc = 0;
  let ci = 0;
  for (const ch of plain) {
    const w = charWidth(ch.codePointAt(0));
    if (dc + w > displayCol) return ci;
    dc += w;
    ci += 1;
  }
  return ci;
}

/**
 * END boundary (exclusive): one past the codepoint index of the last
 * character whose display range overlaps [..displayCol]. Combined with
 * the start helper, the pair makes [a, b) a slice that INCLUDES every
 * char whose cells fall within [startCol, endCol]. Treating endCol as
 * "the rightmost cell the cursor visited" means a click on the LEFT
 * cell of a 2-wide CJK char still grabs that char's full glyph.
 */
function _displayColToCharIdxEnd(plain, displayCol) {
  let dc = 0;
  let ci = 0;
  for (const ch of plain) {
    if (dc > displayCol) return ci;
    dc += charWidth(ch.codePointAt(0));
    ci += 1;
  }
  return ci;
}

/**
 * Codepoint-safe slice — `String.prototype.slice` works on UTF-16
 * units, which splits surrogate pairs. The selection codepath does
 * everything in codepoint indices (from _displayColToCharIdx), so it
 * needs a slice that respects that.
 */
function _codepointSlice(s, startCp, endCp) {
  const chars = [...s];
  return chars.slice(startCp, endCp).join('');
}

function _clampLine(line) {
  const n = S.detailLines.length;
  if (n === 0) return 0;
  return Math.max(0, Math.min(n - 1, line));
}

function beginAt(line, col, kind) {
  _init();
  const l = _clampLine(line);
  const c = Math.max(0, col | 0);
  S.select.active = true;
  S.select.kind = (kind === 'line') ? 'line' : 'char';
  S.select.anchor = { line: l, col: c };
  S.select.cursor = { line: l, col: c };
}

function extendTo(line, col) {
  _init();
  if (!S.select.active) return;
  const l = _clampLine(line);
  const c = Math.max(0, col | 0);
  S.select.cursor = { line: l, col: c };
}

function cancel() {
  _init();
  S.select.active = false;
}

/**
 * Normalize anchor/cursor so the returned range has start <= end.
 * For 'line' kind, cols are coerced to span the full line.
 */
function selectedRange() {
  _init();
  if (!S.select.active) return null;
  const { anchor, cursor, kind } = S.select;
  let s = anchor, e = cursor;
  // Lexicographic compare on (line, col).
  if (anchor.line > cursor.line ||
      (anchor.line === cursor.line && anchor.col > cursor.col)) {
    s = cursor; e = anchor;
  }
  if (kind === 'line') {
    return {
      kind, startLine: s.line, endLine: e.line,
      startCol: 0, endCol: Infinity,
    };
  }
  return {
    kind, startLine: s.line, endLine: e.line,
    startCol: s.col, endCol: e.col,
  };
}

/**
 * Resolve the selection to a plain-text string. Char mode: from
 * startCol on startLine through endCol on endLine (endCol exclusive
 * by display-column, inclusive by character at the boundary — a drag
 * that lands ON a char includes that char). Line mode: full lines
 * joined with `\n`.
 */
function selectedText() {
  const r = selectedRange();
  if (!r) return '';
  if (r.kind === 'line') {
    const out = [];
    for (let i = r.startLine; i <= r.endLine; i++) out.push(plainLine(i));
    return out.join('\n');
  }
  // char mode
  if (r.startLine === r.endLine) {
    const plain = plainLine(r.startLine);
    const a = _displayColToCharIdx(plain, r.startCol);
    const b = _displayColToCharIdxEnd(plain, r.endCol);
    return _codepointSlice(plain, a, b);
  }
  const out = [];
  const first = plainLine(r.startLine);
  const a = _displayColToCharIdx(first, r.startCol);
  out.push(_codepointSlice(first, a, Infinity));
  for (let i = r.startLine + 1; i < r.endLine; i++) out.push(plainLine(i));
  const last = plainLine(r.endLine);
  const b = _displayColToCharIdxEnd(last, r.endCol);
  out.push(_codepointSlice(last, 0, b));
  return out.join('\n');
}

/**
 * Commit the current selection: push to register, clear active flag.
 * Returns the text (or '' if there was no active selection).
 */
function commit() {
  if (!S.select || !S.select.active) return '';
  const text = selectedText();
  S.select.active = false;
  if (text) register.push(text);
  return text;
}

function isActive() {
  return !!(S.select && S.select.active);
}

/**
 * Build a Rich-markup string for one detail line with display columns
 * [startCol, endCol] highlighted in reverse. Strategy: drop the line's
 * existing markup inside the highlighted range and replace with plain
 * text + `[reverse]…[/]`. Lines NOT intersecting the selection are
 * passed through unchanged (caller decides which lines to transform).
 *
 * Dropping existing markup inside the range avoids the [/] reset
 * problem — Rich's `[/]` is unstacked (every close resets *all* SGR
 * attrs), so weaving `[reverse]` into a `[bold]X[/]` span would force
 * us to replay the outer state. For selection (transient, mainly used
 * on plain text or dim notes) this fidelity loss is acceptable.
 *
 * literal `[` characters in the plain projection are re-escaped to
 * `\[` so richToAnsi doesn't interpret stray brackets as markup.
 */
function highlightLine(line, startCol, endCol) {
  const plain = stripMarkup(line);
  let lineW = 0;
  for (const ch of plain) lineW += charWidth(ch.codePointAt(0));
  if (lineW === 0) return line;
  if (startCol >= lineW) return line;            // selection past end
  const clampedEnd = Math.min(endCol, lineW - 1);
  if (clampedEnd < startCol) return line;
  const a = _displayColToCharIdx(plain, startCol);
  const b = _displayColToCharIdxEnd(plain, clampedEnd);
  if (a >= b) return line;
  const chars = [...plain];
  const before = chars.slice(0, a).join('');
  const sel    = chars.slice(a, b).join('');
  const after  = chars.slice(b).join('');
  return `${esc(before)}[reverse]${esc(sel)}[/]${esc(after)}`;
}

/**
 * Apply the active selection's highlight to a copy of `lines`. Lines
 * outside the selection range are returned as-is; intersected lines
 * get highlightLine applied. Returns `lines` unchanged when there is
 * no active selection — reading mode has no visible cursor, only
 * visual mode does.
 */
function decorateLines(lines) {
  if (!S.select || !S.select.active) return lines;
  const r = selectedRange();
  if (!r) return lines;
  return lines.map((line, i) => {
    if (i < r.startLine || i > r.endLine) return line;
    const s = (i === r.startLine) ? r.startCol : 0;
    const e = (i === r.endLine)   ? r.endCol   : Infinity;
    return highlightLine(line, s, e);
  });
}

// --- Keyboard visual-mode for the detail panel ---
//
// Wired from dispatch.handleNormalKey: when focus=detail (and no
// higher-priority mode owns the key), calls onDetailKey first.
// Returns true to claim the key — the dispatch switch is then skipped.
//
// Two modes:
//
// Reading mode (no selection active):
//   j/down  scroll detail view +1 line
//   k/up    scroll detail view -1 line
//   h/l     fall through to global focus-shift (panel navigation)
//   v       enter char-select at top of current viewport
//   V       enter line-select at top of current viewport
//
// Visual mode (selection active):
//   j/down  cursor down (extends selection + autoscrolls)
//   k/up    cursor up
//   h/left  cursor left
//   l/right cursor right
//   0/Home  cursor to col 0
//   $/End   cursor to end-of-line
//   y       commit + push to register
//   v / V   exit visual mode (cancel)
//   Esc     cancel
//
// Cursor is rendered as a one-cell [reverse] glyph only while a
// selection is active — reading mode has no visible cursor, matching
// pager/lazygit-style expectations where j/k means "move the view".

function _innerHeight() {
  const h = S.panelHeights.detail || 0;
  return Math.max(1, h - 2);
}

function _scrollIntoView() {
  const c = S.detailCursor;
  if (!c) return;
  const innerH = _innerHeight();
  const top = S.detailScroll || 0;
  if (c.line < top) S.detailScroll = c.line;
  else if (c.line >= top + innerH) S.detailScroll = c.line - innerH + 1;
}

function _moveCursor(dline, dcol) {
  if (!S.detailCursor) S.detailCursor = { line: 0, col: 0 };
  const c = S.detailCursor;
  const n = S.detailLines.length;
  if (n === 0) return false;
  const newLine = Math.max(0, Math.min(n - 1, c.line + dline));
  let newCol = (dcol === 0) ? c.col : Math.max(0, c.col + dcol);
  const w = plainLineWidth(newLine);
  newCol = (w === 0) ? 0 : Math.min(w - 1, newCol);
  c.line = newLine;
  c.col = newCol;
  if (S.select && S.select.active) extendTo(newLine, newCol);
  _scrollIntoView();
  return true;
}

function _scrollView(delta) {
  const innerH = _innerHeight();
  const maxScroll = Math.max(0, S.detailLines.length - innerH);
  const next = Math.max(0, Math.min(maxScroll, (S.detailScroll || 0) + delta));
  S.detailScroll = next;
}

function onDetailKey(key, seq) {
  if (S.focus !== 'detail' || S.terminalMode) return false;
  // Higher-priority modes (menu/cmd/etc.) are filtered upstream in
  // modeChain; this guard is belt-and-suspenders for any future caller.
  if (S.menuOpen || S.cmdMode || S.confirmMode || S.promptMode || S.copyMode) return false;
  if (!S.detailCursor) S.detailCursor = { line: 0, col: 0 };
  const active = !!(S.select && S.select.active);

  // Mode toggles. Entering visual mode plants the cursor at the top
  // of the current viewport rather than at the last known position —
  // matches what mouse-drag effectively does (cursor where the click
  // landed) and avoids "where did v take me?" surprises after the
  // user has been scrolling around.
  if (seq === 'v' || key === 'v') {
    if (active && S.select.kind === 'char') cancel();
    else {
      const start = S.detailScroll || 0;
      S.detailCursor = { line: start, col: 0 };
      beginAt(start, 0, 'char');
    }
    return true;
  }
  if (seq === 'V' || key === 'V') {
    if (active && S.select.kind === 'line') cancel();
    else {
      const start = S.detailScroll || 0;
      S.detailCursor = { line: start, col: 0 };
      beginAt(start, 0, 'line');
    }
    return true;
  }
  if ((seq === 'y' || key === 'y') && active) { commit(); return true; }
  if (key === 'escape' && active) { cancel(); return true; }

  // Vertical movement is mode-dependent:
  //   reading mode → scroll the view ±1 line
  //   visual mode  → move cursor + extend selection + autoscroll
  if (key === 'down' || seq === 'j' || key === 'j') {
    if (active) _moveCursor(+1, 0); else _scrollView(+1);
    return true;
  }
  if (key === 'up' || seq === 'k' || key === 'k') {
    if (active) _moveCursor(-1, 0); else _scrollView(-1);
    return true;
  }

  // Horizontal movement — only claim h/l while a selection is active,
  // so the panel-focus-shift behavior is preserved in the normal case.
  if (active) {
    if (key === 'left'  || seq === 'h' || key === 'h') { _moveCursor(0, -1); return true; }
    if (key === 'right' || seq === 'l' || key === 'l') { _moveCursor(0, +1); return true; }
  }

  // Line-start / line-end jumps — only meaningful with a cursor, i.e.
  // when a selection is active. In reading mode 0/$ fall through.
  if (active && (seq === '0' || key === 'home')) {
    S.detailCursor.col = 0;
    extendTo(S.detailCursor.line, 0);
    return true;
  }
  if (active && (seq === '$' || key === 'end')) {
    const w = plainLineWidth(S.detailCursor.line);
    S.detailCursor.col = Math.max(0, w - 1);
    extendTo(S.detailCursor.line, S.detailCursor.col);
    return true;
  }
  return false;
}

module.exports = {
  beginAt, extendTo, cancel, commit, isActive,
  selectedRange, selectedText, plainLine, plainLineWidth,
  highlightLine, decorateLines, onDetailKey,
  // exposed for testing only
  _displayColToCharIdx, _displayColToCharIdxEnd, _codepointSlice,
  _moveCursor,
};
