/**
 * Shared text-view interaction reducer (U2c P0, docs/one-tab-system.md).
 *
 * The scroll / search / select / cursor state machine that drives a scrollable
 * text pane. Extracted verbatim from the viewer Component (`panel/viewer/viewer.js`)
 * so BOTH the viewer (tab-kind `'detail'`) and any minted `text-view` instance
 * (tab-kind `'text-view'`) share ONE implementation. Pure: a function of
 * `(msg, slice, lines, ownKind)` — no getModel(), no route reads. The caller
 * derives `lines` (the active-tab content) at the dispatch boundary and threads
 * it in; `slice.innerH` (the viewport height) is stamped by the caller's
 * `augmentMsg` before update, so the clamp helpers read it through `_innerH`.
 *
 * `reduce` returns `nextSlice` or `[nextSlice, effects]` for the interaction Msgs
 * (`viewer_scroll`, `viewer_search_*`, `select_*`, `key`); `null` for anything it
 * does not own, so a caller can fall through to its own arms. Effects preserved
 * from the viewer: `mode_set`/`mode_clear` on the `detailSearchMode` chrome flag
 * (kept global — one text pane searches at a time) and `register_push` on yank.
 * The `key` arm claims via the `{ type: '_claimed' }` sentinel exactly as before;
 * the focus gate is `ownKind` (the viewer passes 'detail', text-view 'text-view').
 */
'use strict';

const ms = require('./search');
const sc = require('./select-core');
const { stripMarkup, charWidth } = require('./ansi');

// Effective viewport rows; pre-first-render fallback is 1 (see viewer.js FIX-2).
function _innerH(slice) { return slice.innerH > 0 ? slice.innerH : 1; }

function _beginSelect(slice, line, col, kind, lines) {
  const n = lines.length;
  const l = n === 0 ? 0 : Math.max(0, Math.min(n - 1, line | 0));
  const c = Math.max(0, col | 0);
  return {
    ...slice,
    select: {
      active: true,
      kind: kind === 'line' ? 'line' : 'char',
      anchor: { line: l, col: c },
      cursor: { line: l, col: c },
    },
    cursor: { line: l, col: c },
  };
}

function _setCursor(slice, line, col, extend) {
  const cursor = { line: line | 0, col: col | 0 };
  const innerH = _innerH(slice);
  const top = slice.scroll || 0;
  let scroll = slice.scroll || 0;
  if (cursor.line < top)                       scroll = cursor.line;
  else if (cursor.line >= top + innerH)        scroll = cursor.line - innerH + 1;
  const next = { ...slice, cursor, scroll };
  if (extend && slice.select && slice.select.active) {
    next.select = { ...slice.select, cursor: { line: cursor.line, col: cursor.col } };
  }
  return next;
}

function _scrollView(slice, delta, lines) {
  const innerH = _innerH(slice);
  const maxScroll = Math.max(0, lines.length - innerH);
  const scroll = Math.max(0, Math.min(maxScroll, (slice.scroll || 0) + (delta || 0)));
  if (scroll === (slice.scroll || 0)) return slice;
  return { ...slice, scroll };
}

// Display width of a buffer line (markup-stripped, east-asian aware). Feeds the
// line-end ($/End) cursor jump + the h/l horizontal clamp.
function _lineWidth(lines, i) {
  const ln = lines[i];
  if (ln == null) return 0;
  const plain = stripMarkup(ln);
  let w = 0;
  for (const ch of plain) w += charWidth(ch.codePointAt(0));
  return w;
}

function _moveCursor(slice, dline, dcol, lines) {
  const cur = slice.cursor || { line: 0, col: 0 };
  const n = lines.length;
  if (n === 0) return slice;
  const newLine = Math.max(0, Math.min(n - 1, cur.line + dline));
  let newCol = (dcol === 0) ? cur.col : Math.max(0, cur.col + dcol);
  const w = _lineWidth(lines, newLine);
  newCol = (w === 0) ? 0 : Math.min(w - 1, newCol);
  const active = !!(slice.select && slice.select.active);
  return _setCursor(slice, newLine, newCol, active);
}

// Enter search-typing: step the slice into typing state + arm the detailSearchMode
// chrome flag when leaves/search says to. Returns [nextSlice, effects].
function _enterSearchReturn(slice) {
  const [next, info] = ms.enter(slice);
  return [next, info.enableSearchMode
    ? [{ type: 'msg', msg: { type: 'mode_set', flag: 'detailSearchMode' } }]
    : []];
}

/**
 * The shared interaction reducer. `ownKind` gates the `key` state machine (the
 * focused pane's kind must match). Returns `nextSlice | [nextSlice, effects]`
 * for owned Msgs, else `null`.
 */
function reduce(msg, slice, lines, ownKind) {
  if (lines === undefined) lines = [];
  switch (msg.type) {
    case 'viewer_scroll': {
      const innerH = _innerH(slice);
      const maxScroll = Math.max(0, lines.length - innerH);
      let next;
      if (msg.to === 'top') next = 0;
      else if (msg.to === 'bottom') next = maxScroll;
      else next = slice.scroll + (msg.delta || 0);
      const scroll = Math.max(0, Math.min(maxScroll, next));
      if (scroll === slice.scroll) return slice;
      return { ...slice, scroll };
    }

    // --- search (typing phase). leaves/search returns [newSlice, info]; the
    // detailSearchMode chrome flag is set/cleared via a mode_set / mode_clear Msg.
    case 'viewer_search_enter':
      return _enterSearchReturn(slice);
    case 'viewer_search_key':
      return ms.keystroke(slice, msg.seq);
    case 'viewer_search_nav':
      return msg.dir > 0
        ? ms.next(slice, _innerH(slice), lines, slice.search.typing || '')
        : ms.prev(slice, _innerH(slice), lines, slice.search.typing || '');
    case 'viewer_search_commit': {
      const [next, info] = ms.commit(slice, _innerH(slice), lines);
      return [next, info.disableSearchMode
        ? [{ type: 'msg', msg: { type: 'mode_clear', flag: 'detailSearchMode' } }]
        : []];
    }
    case 'viewer_search_cancel': {
      const [next, info] = ms.cancel(slice);
      return [next, info.disableSearchMode
        ? [{ type: 'msg', msg: { type: 'mode_clear', flag: 'detailSearchMode' } }]
        : []];
    }
    case 'viewer_search_clear_committed':
      return ms.clearCommitted(slice);

    // --- visual-mode select. Mouse path dispatches select_* (viewer facade);
    // keyboard path lives in `case 'key'` below. Both flow through the same pure
    // transforms.
    case 'select_begin':
      return _beginSelect(slice, msg.line, msg.col, msg.kind, lines);
    case 'select_extend': {
      if (!slice.select || !slice.select.active) return slice;
      const n = lines.length;
      const l = n === 0 ? 0 : Math.max(0, Math.min(n - 1, msg.line | 0));
      return { ...slice, select: { ...slice.select, cursor: { line: l, col: Math.max(0, msg.col | 0) } } };
    }
    case 'select_cancel':
      if (!slice.select) return slice;
      return { ...slice, select: { ...slice.select, active: false } };
    case 'select_set_cursor':
      return _setCursor(slice, msg.line, msg.col, msg.extend);
    case 'select_scroll_view':
      return _scrollView(slice, msg.delta, lines);

    // --- keyboard: the visual-mode state machine. The `_claimed` sentinel gates
    // the framework default; the focus gate is the caller's `ownKind`.
    case 'key': {
      if (msg.focusKind !== ownKind || msg.terminalMode) return slice;

      const active = !!(slice.select && slice.select.active);
      const claim = [{ type: '_claimed' }];

      // `/` enters search (fires before the post-commit n/N block so it re-opens
      // typing from any search state).
      if (msg.seq === '/' || msg.key === '/') {
        const [next, fx] = _enterSearchReturn(slice);
        return [next, [{ type: '_claimed' }, ...fx]];
      }

      // Committed-search n/N nav; Esc clears.
      if (slice.search && slice.search.active) {
        if (msg.seq === 'n' || msg.key === 'n') return [ms.next(slice, _innerH(slice), lines, slice.search.term || ''), claim];
        if (msg.seq === 'N' || msg.key === 'N') return [ms.prev(slice, _innerH(slice), lines, slice.search.term || ''), claim];
        if (msg.key === 'escape' && !active)    return [ms.clearCommitted(slice), claim];
      }

      // v / V — toggle visual mode; anchor at the top of the current viewport.
      if (msg.seq === 'v' || msg.key === 'v') {
        const next = (active && slice.select.kind === 'char')
          ? { ...slice, select: { ...slice.select, active: false } }
          : _beginSelect(slice, slice.scroll || 0, 0, 'char', lines);
        return [next, claim];
      }
      if (msg.seq === 'V' || msg.key === 'V') {
        const next = (active && slice.select.kind === 'line')
          ? { ...slice, select: { ...slice.select, active: false } }
          : _beginSelect(slice, slice.scroll || 0, 0, 'line', lines);
        return [next, claim];
      }

      // y — commit + push to register (root reducer owns the register + OSC52).
      if ((msg.seq === 'y' || msg.key === 'y') && active) {
        const text = sc.selectedTextFrom(lines, slice.select);
        const next = { ...slice, select: { ...slice.select, active: false } };
        const effects = [{ type: '_claimed' }];
        if (text) effects.push({ type: 'msg', msg: { type: 'register_push', text } });
        return [next, effects];
      }
      if (msg.key === 'escape' && active) {
        return [{ ...slice, select: { ...slice.select, active: false } }, claim];
      }

      // Vertical: reading → scroll view, visual → cursor + extend.
      if (msg.key === 'down' || msg.seq === 'j' || msg.key === 'j') {
        const next = active ? _moveCursor(slice, +1, 0, lines) : _scrollView(slice, +1, lines);
        return [next, claim];
      }
      if (msg.key === 'up' || msg.seq === 'k' || msg.key === 'k') {
        const next = active ? _moveCursor(slice, -1, 0, lines) : _scrollView(slice, -1, lines);
        return [next, claim];
      }

      // Horizontal h/l — only claim in visual mode so reading-mode focus-shift works.
      if (active) {
        if (msg.key === 'left'  || msg.seq === 'h' || msg.key === 'h') return [_moveCursor(slice, 0, -1, lines), claim];
        if (msg.key === 'right' || msg.seq === 'l' || msg.key === 'l') return [_moveCursor(slice, 0, +1, lines), claim];
      }

      // 0 / $ — line-start / line-end jumps (visual mode only).
      if (active && (msg.seq === '0' || msg.key === 'home')) {
        return [_setCursor(slice, slice.cursor.line, 0, true), claim];
      }
      if (active && (msg.seq === '$' || msg.key === 'end')) {
        const w = sc.plainLineWidthFrom(lines, slice.cursor.line);
        return [_setCursor(slice, slice.cursor.line, Math.max(0, w - 1), true), claim];
      }
      return slice;
    }

    default:
      return null;
  }
}

module.exports = { reduce };
