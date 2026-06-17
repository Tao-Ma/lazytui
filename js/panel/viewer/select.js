/**
 * Detail-panel text selection state machine.
 *
 * The selection lives in *absolute* detail-line indices and *display
 * columns* (0-indexed). Storing absolute lines means the selection
 * stays anchored to its content as the user scrolls — extending it
 * outside the visible window doesn't lose the anchor.
 *
 * Coordinate system:
 *   - line: index into the detail slice's `lines` (markup-stripped
 *           projection used for slicing during commit; render path
 *           applies highlight on top of the markup).
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
 * Selection is transient: after commit() or cancel(), the slice's
 * `select.active` is false and the highlight disappears. The register
 * keeps the value.
 */
'use strict';

// Detail visual-mode/selection helper. Service module called from both
// dispatch-side and render-side; reads the detail Component slice via
// getInstanceSlice and the model via getModel rather than threading
// either through every call site. The detail-cluster fields all live in
// the detail slice (`lines` / `select` / `cursor` / `scroll` / `search`);
// the mode flags (visual / select) live in model.modes.
const { getModel } = require('../../model/store');
const { stripMarkup, charWidth, esc } = require('../../io/ansi');
const {getInstanceSlice, getFocus } = require('../api');

// All reads target the active viewer Component slice (lines / select /
// cursor / scroll / search). Routes via route.resolveTarget('viewer')
// (post-Phase B1) so multi-viewer setups land on the focused viewer's
// slice; falls back to the kind name for the legacy primary. Returns
// undefined if no viewer is registered (callers null-guard).
function _detail() {
  const route = require('../../panel/route');
  return getInstanceSlice(route.resolveTarget('viewer') || 'detail');
}

// P2 (viewer-lines selector) — the active-tab lines DERIVE via the
// pane-tabs projection (this module is dispatch-side; the model read is
// fine here). Replaces the stored slice.lines read; the field dies in P3.
function _lines() {
  const sl = _detail();
  if (!sl) return [];
  const m = getModel();
  return require('../../leaves/pane-tabs').viewerLines(sl, m, m.currentGroup);
}

// Selection writes fold onto the update spine (select_* Msgs). select.js
// can't be imported by the reducer (it requires runtime → cycle), so the
// writers resolve any ansi-dependent values here (plainLineWidth clamps)
// and dispatch via the Component fan-out (handled by detail.update). The
// text/column READS (selectedText, decorateLines, …) stay here — reads
// don't break single-writer.
// All Msgs from this module target the focused-or-sticky viewer
// (select_* mode lives on whichever viewer the user has). v0.6.1
// Phase 8 — resolveTarget so multi-viewer wires up correctly; null
// = no viewer, drop.
function _apply(msg) {
  const route = require('../../panel/route');
  const target = route.resolveTarget('viewer');
  if (!target) return;
  require('../../leaves/panel-host').dispatchMsg(route.wrap(target, msg));
}

// PURE projections — take the threaded `lines` array explicitly so the
// viewer's reducer arms (y / $) can call them without reaching for
// getModel()/resolveTarget. The impure wrappers below delegate to these for
// non-reducer callers (mouse path, commit/settle) that don't have `lines` in
// hand.
/** Plain text projection of line `i` from an explicit lines array (pure). */
function plainLineFrom(lines, i) {
  const ln = lines[i];
  return ln == null ? '' : stripMarkup(ln);
}
/** Display width of the plain projection of line `i` from explicit lines (pure). */
function plainLineWidthFrom(lines, i) {
  let w = 0;
  for (const ch of plainLineFrom(lines, i)) w += charWidth(ch.codePointAt(0));
  return w;
}

/** Plain text projection of detail line `i` (markup stripped). */
function plainLine(i) { return plainLineFrom(_lines(), i); }

/** Display width of the plain text projection of a line. */
function plainLineWidth(i) { return plainLineWidthFrom(_lines(), i); }

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

function beginAt(line, col, kind) {
  _apply({ type: 'select_begin', line, col, kind });
}

function extendTo(line, col) {
  _apply({ type: 'select_extend', line, col });
}

function cancel() {
  _apply({ type: 'select_cancel' });
}

/**
 * Normalize anchor/cursor so the returned range has start <= end.
 * For 'line' kind, cols are coerced to span the full line.
 */
// PURE — resolve an explicit selection object (no global read).
function selectedRangeOf(sel) {
  if (!sel || !sel.active) return null;
  const { anchor, cursor, kind } = sel;
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
function selectedRange() { return selectedRangeOf(_detail()?.select); }

/**
 * Resolve the selection to a plain-text string. Char mode: from
 * startCol on startLine through endCol on endLine (endCol exclusive
 * by display-column, inclusive by character at the boundary — a drag
 * that lands ON a char includes that char). Line mode: full lines
 * joined with `\n`.
 */
// PURE — resolve from explicit lines + selection (the viewer y-arm path).
function selectedTextFrom(lines, sel) {
  const r = selectedRangeOf(sel);
  if (!r) return '';
  const pl = (i) => plainLineFrom(lines, i);
  if (r.kind === 'line') {
    const out = [];
    for (let i = r.startLine; i <= r.endLine; i++) out.push(pl(i));
    return out.join('\n');
  }
  // char mode
  if (r.startLine === r.endLine) {
    const plain = pl(r.startLine);
    const a = _displayColToCharIdx(plain, r.startCol);
    const b = _displayColToCharIdxEnd(plain, r.endCol);
    return _codepointSlice(plain, a, b);
  }
  const out = [];
  const first = pl(r.startLine);
  const a = _displayColToCharIdx(first, r.startCol);
  out.push(_codepointSlice(first, a, Infinity));
  for (let i = r.startLine + 1; i < r.endLine; i++) out.push(pl(i));
  const last = pl(r.endLine);
  const b = _displayColToCharIdxEnd(last, r.endCol);
  out.push(_codepointSlice(last, 0, b));
  return out.join('\n');
}
function selectedText() { return selectedTextFrom(_lines(), _detail()?.select); }

/**
 * Commit the current selection: push to register, clear active flag.
 * Returns the text (or '' if there was no active selection).
 */
function commit() {
  const sel = _detail()?.select;
  if (!sel || !sel.active) return '';
  const text = selectedText();
  _apply({ type: 'select_cancel' });
  // register_push is a ROOT-reducer Msg (model.register lives on the root
  // model), so route via applyMsg, not the Component fan-out.
  if (text) require('../../leaves/panel-host').applyMsg({ type: 'register_push', text });
  return text;
}

/**
 * Settle a mouse drag on release: push the selected text to the register
 * (auto-copy, like commit) but KEEP the selection active so it persists —
 * highlighted, and offered to the right-click "Copy selection" entry — until
 * the next press starts/cancels a selection (the same persistent state a
 * keyboard `v` selection has). A bare click (zero-width, no drag) has no text:
 * clear it, so a plain click in the viewer doesn't trap keyboard nav in
 * visual mode. Returns the text (or '').
 */
function settle() {
  const sel = _detail()?.select;
  if (!sel || !sel.active) return '';
  // A bare click (press→release, no motion) leaves anchor === cursor — a
  // zero-width char "selection". selectedText() would still return the one
  // character under the cursor (endCol is char-inclusive at the boundary),
  // so treating it as a real selection would yank a stray char to the
  // register AND leave the viewer stuck in visual mode. Cancel it instead:
  // a plain viewer click must never trap keyboard nav. (Line-kind clicks
  // still settle — a single line-mode click is a deliberate full-line pick.)
  const noDrag = sel.kind !== 'line'
    && sel.anchor.line === sel.cursor.line
    && sel.anchor.col === sel.cursor.col;
  const text = noDrag ? '' : selectedText();
  if (!text) { _apply({ type: 'select_cancel' }); return ''; }
  require('../../leaves/panel-host').applyMsg({ type: 'register_push', text });
  return text;  // active stays true → persistent selection (highlight + copyable)
}

function isActive() {
  const sel = _detail()?.select;
  return !!(sel && sel.active);
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
  const sel = _detail()?.select;
  if (!sel || !sel.active) return lines;
  const r = selectedRange();
  if (!r) return lines;
  return lines.map((line, i) => {
    if (i < r.startLine || i > r.endLine) return line;
    const s = (i === r.startLine) ? r.startCol : 0;
    const e = (i === r.endLine)   ? r.endCol   : Infinity;
    return highlightLine(line, s, e);
  });
}

// Note: the keyboard state machine that USED to live here (onDetailKey,
// _moveCursor, _scrollView) folded into the detail Component's `key` arm
// (panel/viewer/viewer.js). The claim is now signaled via the `_claimed`
// effect from update() — the framework gates on it inside
// `dispatchKeyToFocused`, so the dispatch layer no longer needs a hijack.
//
// The mouse path still uses this module's service API (beginAt/extendTo/
// cancel/commit) to start/extend/finish a drag selection, and the render
// path uses the pure reads (isActive, decorateLines, highlightLine,
// selectedText, plainLine, plainLineWidth, _displayCol* helpers).

module.exports = {
  beginAt, extendTo, cancel, commit, settle, isActive,
  selectedText, plainLineWidth,
  // PURE variants for the viewer reducer arms (lines threaded in, no global read):
  selectedTextFrom, plainLineWidthFrom,
  highlightLine, decorateLines,
};
