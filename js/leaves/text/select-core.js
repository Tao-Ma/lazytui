/**
 * Text-selection core — the PURE geometry of a rectangular-free, char/line
 * selection over an array of Rich-markup content lines. Shared bottom leaf: the
 * selection service (js/panel/select-view.js), the content panes' shared
 * reducer (leaves/text/text-view-update), and the loop's generic select_*
 * fallback all resolve display-column ↔ codepoint boundaries, extract the
 * selected text, and decorate the highlighted range through this one module.
 *
 * A selection is `{ anchor:{line,col}, cursor:{line,col}, kind:'char'|'line',
 * active }`, where `line` is an ABSOLUTE content-line index and `col` is a
 * DISPLAY column (so it stays anchored to content as a pane scrolls, and CJK /
 * wide glyphs map correctly). Everything here is pure — lines are threaded in,
 * no model/global reads — so it sits at the bottom of the layer graph
 * (depends only on leaves/text/ansi).
 */
'use strict';

const { stripMarkup, charWidth, esc } = require('./ansi');

/** Plain (markup-stripped) projection of content line `i`. */
function plainLineAt(lines, i) {
  const ln = lines[i];
  return ln == null ? '' : stripMarkup(ln);
}

/** Display width of a plain string (CJK/wide-aware). */
function displayWidth(plain) {
  let w = 0;
  for (const ch of plain) w += charWidth(ch.codePointAt(0));
  return w;
}

/**
 * START boundary: the codepoint index of the first character whose display
 * range contains or starts at `displayCol`. Clicking either cell of a 2-wide
 * glyph resolves to that char; past the end returns the past-the-end index.
 */
function displayColToCharIdx(plain, displayCol) {
  let dc = 0, ci = 0;
  for (const ch of plain) {
    const w = charWidth(ch.codePointAt(0));
    if (dc + w > displayCol) return ci;
    dc += w; ci += 1;
  }
  return ci;
}

/**
 * END boundary (exclusive): one past the codepoint index of the last char whose
 * cells overlap [..displayCol]. Paired with the start helper, [a,b) includes
 * every char whose cells fall within [startCol, endCol] — so a drag onto the
 * left cell of a wide glyph still grabs the whole glyph.
 */
function displayColToCharIdxEnd(plain, displayCol) {
  let dc = 0, ci = 0;
  for (const ch of plain) {
    if (dc > displayCol) return ci;
    dc += charWidth(ch.codePointAt(0));
    ci += 1;
  }
  return ci;
}

/** Codepoint-safe slice (String.slice splits surrogate pairs). */
function codepointSlice(s, startCp, endCp) {
  return [...s].slice(startCp, endCp).join('');
}

/**
 * Normalize anchor/cursor into a start<=end range. 'line' kind spans full lines.
 * Returns null when there is no active selection.
 */
function selectedRangeOf(sel) {
  if (!sel || !sel.active) return null;
  const { anchor, cursor, kind } = sel;
  let s = anchor, e = cursor;
  if (anchor.line > cursor.line ||
      (anchor.line === cursor.line && anchor.col > cursor.col)) {
    s = cursor; e = anchor;
  }
  if (kind === 'line') {
    return { kind, startLine: s.line, endLine: e.line, startCol: 0, endCol: Infinity };
  }
  return { kind, startLine: s.line, endLine: e.line, startCol: s.col, endCol: e.col };
}

/**
 * Resolve a selection to plain text. Char mode: startCol..endCol (endCol
 * inclusive-at-boundary). Line mode: whole lines joined with '\n'.
 */
function selectedTextFrom(lines, sel) {
  const r = selectedRangeOf(sel);
  if (!r) return '';
  const pl = (i) => plainLineAt(lines, i);
  if (r.kind === 'line') {
    const out = [];
    for (let i = r.startLine; i <= r.endLine; i++) out.push(pl(i));
    return out.join('\n');
  }
  if (r.startLine === r.endLine) {
    const plain = pl(r.startLine);
    const a = displayColToCharIdx(plain, r.startCol);
    const b = displayColToCharIdxEnd(plain, r.endCol);
    return codepointSlice(plain, a, b);
  }
  const out = [];
  const first = pl(r.startLine);
  out.push(codepointSlice(first, displayColToCharIdx(first, r.startCol), Infinity));
  for (let i = r.startLine + 1; i < r.endLine; i++) out.push(pl(i));
  const last = pl(r.endLine);
  out.push(codepointSlice(last, 0, displayColToCharIdxEnd(last, r.endCol)));
  return out.join('\n');
}

/**
 * Rich-markup for one content line with display columns [startCol, endCol]
 * reversed. Existing markup inside the range is dropped (Rich `[/]` is unstacked,
 * so weaving `[reverse]` into a styled span would force replaying outer state);
 * for a transient selection that fidelity loss is acceptable. Literal `[` in the
 * plain projection is re-escaped so stray brackets aren't read as markup.
 */
function highlightLine(line, startCol, endCol, baseTag = 'reverse') {
  // A selected/cursor row is emitted as a LEADING selected tag running to end
  // of line (`[${theme().selected}]` — 'reverse' on minimal, a fg/bg hex pair
  // on the hex themes since the truecolor arc 3b; no inner markup, PRINCIPLES
  // §8). The panel layer threads the active tag in as `baseTag` — this leaf
  // stays theme-free (purity wall), and the 'reverse' default preserves the
  // historical behavior for direct callers. Naively stripping the base and
  // re-styling only the selected span would (a) wipe the row's highlight
  // everywhere outside the span and (b) leave the span base-on-base = no
  // contrast. So detect that base and XOR: keep the base style OUTSIDE the
  // selection, drop it INSIDE — the selected span reads as normal video,
  // standing out against the highlighted row. (Other markup is still
  // dropped; for a transient selection that fidelity loss is acceptable.)
  //
  // CONTRACT: `baseSelected` treats a leading base tag as "this whole row is
  // highlighted", which is EXACT for every selected-row producer (all
  // navigator + fabric selected rows: leading `[${theme().selected}]`,
  // UNCLOSED, to EOL, content `esc()`'d so no inner `[/]`). A precise "no
  // inner close tag" test is deliberately NOT used: esc()'d content may
  // contain a literal `\[/]` whose substring is `[/]`, which would
  // false-negative a genuine highlighted row. If a future caller emits a row
  // that OPENS then CLOSES the base before EOL, this proxy would XOR the
  // wrong region — keep such rows out, or revisit here.
  //
  // Note: XOR is RELATIVE to each row's own base, so a multi-row drag shows
  // the selected span highlighted on normal rows but normal-video on the
  // (highlighted) cursor row — intentional (the span always contrasts its
  // row), not a uniformity bug.
  const baseSelected = line.startsWith(`[${baseTag}]`);
  const plain = stripMarkup(line);
  const lineW = displayWidth(plain);
  if (lineW === 0) return line;
  if (startCol >= lineW) return line;
  const clampedEnd = Math.min(endCol, lineW - 1);
  if (clampedEnd < startCol) return line;
  const a = displayColToCharIdx(plain, startCol);
  const b = displayColToCharIdxEnd(plain, clampedEnd);
  if (a >= b) return line;
  const chars = [...plain];
  const before = chars.slice(0, a).join('');
  const sel    = chars.slice(a, b).join('');
  const after  = chars.slice(b).join('');
  if (baseSelected) {
    // XOR the base style across the selected span. The trailing base tag is
    // left open (no `[/]`) so it runs through the panel's end-of-line
    // padding, matching the row's original full-width highlight bar.
    const bwrap = before ? `[${baseTag}]${esc(before)}[/]` : '';
    const awrap = after  ? `[${baseTag}]${esc(after)}`     : '';
    return `${bwrap}${esc(sel)}${awrap}`;
  }
  return `${esc(before)}[${baseTag}]${esc(sel)}[/]${esc(after)}`;
}

/**
 * Decorate a VISIBLE WINDOW of content lines. `lines` is the window; `offset` is
 * its absolute start (selection ranges are absolute, so window row i maps to
 * i+offset). Lines outside the range pass through unchanged. Returns `lines`
 * as-is when there is no active selection.
 */
function decorateWindow(lines, sel, offset = 0, baseTag = 'reverse') {
  const r = selectedRangeOf(sel);
  if (!r) return lines;
  return lines.map((line, i) => {
    const abs = i + offset;
    if (abs < r.startLine || abs > r.endLine) return line;
    const s = (abs === r.startLine) ? r.startCol : 0;
    const e = (abs === r.endLine)   ? r.endCol   : Infinity;
    return highlightLine(line, s, e, baseTag);
  });
}

/** Display width of the plain projection of content line `i` (CJK-aware) — the
 *  viewer's horizontal cursor clamp reads this. */
function plainLineWidthFrom(lines, i) {
  return displayWidth(plainLineAt(lines, i));
}

/**
 * The pure selection-STATE arms — sel-in/sel-out for the three Msgs every
 * selection backend shares (`select_begin` / `select_extend` / `select_cancel`).
 * One home for the state transitions, so the content panes' reducer
 * (leaves/text/text-view-update) and the generic per-pane fallback drive the
 * exact same machine; callers wrap the result back onto their slice.
 *
 * `linesLen` is the clamp bound: content panes pass their buffer length (line
 * clamped to [0, linesLen-1]); callers without a buffer omit it (col/line only
 * floored at 0 — the geometry above tolerates past-the-end coords). Identity-
 * preserving: an arm that changes nothing returns `sel` unchanged, so callers
 * can skip the slice write. Returns `undefined` for any other Msg type.
 */
function reduceSelect(msg, sel, linesLen) {
  const clampLine = (line) => {
    const l = Math.max(0, line | 0);
    if (linesLen === undefined) return l;
    return linesLen === 0 ? 0 : Math.min(linesLen - 1, l);
  };
  switch (msg.type) {
    case 'select_begin': {
      const at = { line: clampLine(msg.line), col: Math.max(0, msg.col | 0) };
      return {
        active: true,
        kind: msg.kind === 'line' ? 'line' : 'char',
        anchor: at,
        cursor: { ...at },
      };
    }
    case 'select_extend': {
      if (!sel || !sel.active) return sel;
      return { ...sel, cursor: { line: clampLine(msg.line), col: Math.max(0, msg.col | 0) } };
    }
    case 'select_cancel':
      if (!sel || !sel.active) return sel;
      return { ...sel, active: false };
  }
  return undefined;
}

// Public surface: the composed entry points, the helpers the content panes'
// selection layer delegates to, and the shared state arms (reduceSelect) —
// both selection drivers (content-pane reducer + generic per-pane fallback)
// share this one geometry + state core. The column-mapping / range internals
// stay private (exercised transitively).
module.exports = { selectedTextFrom, decorateWindow, highlightLine, plainLineWidthFrom, reduceSelect };
