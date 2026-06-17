/**
 * Panel renderer — bordered panels with scrollbar + pure chrome-glyph
 * derivation. Produces Rich-markup strings (convert to ANSI before writing
 * to terminal). A pure leaf: depends only on io/ansi + io/term + sibling
 * leaves (scrollbar, themes). Terminal dims arrive via an injected provider
 * (setDimsProvider) so the leaf never reaches up into panel for the model —
 * see docs/v0.6.5-render-exit.md.
 */
'use strict';

const { visibleLen, stripMarkup, charWidth, richToAnsi, wrapColor, RESET } = require('../io/ansi');
const { scrollbar } = require('./scrollbar');
const { theme } = require('./themes');
const { cols, rows, stdout } = require('../io/term');

const BORDER = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };
const THUMB = '▐';
const CLOSE_GLYPH = '\\[X]';

/**
 * Truncate text to max visible width.
 *
 * Preserves leading style tags ([reverse], [bold], [dim], …) — they
 * wrap the entire row's content (selection highlight, dim notes,
 * etc.) and getting silently stripped during truncation made
 * cursor highlights vanish on long file paths. The panel renderer
 * adds a reset before the right border, so we leave the prefix
 * unclosed by convention (PRINCIPLES.md §8).
 */
function truncate(text, maxWidth) {
  if (visibleLen(text) <= maxWidth) return text;
  const m = text.match(/^((?:\[[^\/\]]+\])+)/);
  const prefix = m ? m[1] : '';
  const plain = stripMarkup(text);
  const result = [];
  let w = 0;
  for (const ch of plain) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > maxWidth - 1) break;
    result.push(ch);
    w += cw;
  }
  // Re-escape literal `[` in the truncated plain text — stripMarkup
  // converted any original `\[` escape into a literal `[`, and emitting
  // that un-escaped would let richToAnsi re-parse it as the START of
  // a markup tag (e.g. `\[Enter]` in a hint string → `[Enter]` after
  // stripMarkup → matched as `[Enter]` tag, looked up in CODES, missed,
  // emits RESET — the bracketed text silently disappears). v0.5 hadn't
  // hit this because no in-tree caller mixed `\[` escapes with content
  // long enough to truncate; the v0.6 panel-list overlay's hint row does.
  //
  // Only `[` needs escaping. richToAnsi doesn't have a `\]` handler —
  // a bare `]` doesn't trigger tag matching (the regex requires `[xxx]`)
  // and writing `\]` would emit the LITERAL TWO CHARS `\` + `]` in the
  // terminal, miscounting visible width.
  const safe = result.join('').replace(/\[/g, '\\[');
  return prefix + safe + '…';
}

/**
 * Render a bordered panel as Rich markup.
 *
 * @param {object} opts
 * @param {number} opts.width - total width including borders
 * @param {number} opts.height - total height including borders
 * @param {string[]} opts.lines - content lines (Rich markup)
 * @param {string} [opts.title] - panel title
 * @param {string} [opts.hotkey] - hotkey label
 * @param {boolean} [opts.focused] - focus state
 * @param {[number,number]} [opts.count] - [current, total] for bottom border
 * @param {number} [opts.scrollOffset] - first visible item index
 * @param {string} [opts.color] - focused border color
 * @returns {string} Rich markup string
 */
function renderPanel({
  width, height, lines = [], title = '', hotkey = '',
  focused = false, count = null, scrollOffset = 0, color = null,
  panelType = null, chrome = null,
}) {
  const t = theme();
  const b = BORDER;
  const fc = focused ? (color || t.focus) : t.dim;
  const innerW = width - 2;
  const innerH = height - 2;

  // --- Top border ---
  // v0.6.3 P4.2 — chrome glyphs ([_]/[+], [X], [≡]) compose directly
  // into the top border via the `chrome` opt. Format:
  //
  //   ╭─(hk)[≡]─title──────[X] [_]╮
  //
  // [≡] sits after the hotkey display (3 visible cells); [X] and [_]
  // sit at the right edge (3 cells each + 1 gap cell when both are
  // present). The middle dashes fill whatever remains. Chrome that
  // doesn't fit (panel too narrow) is silently omitted by reverting
  // to the pre-P4 bare-border composition. Without `chrome` opt, the
  // pre-P4 path runs verbatim.
  // null (not undefined): a truthy chrome object whose glyphs are ALL
  // null (chromeFor's dragging shape) skips the chrome branch below,
  // and the bare-border fallback gates on `top === null` — an
  // undefined `top` slipped past BOTH and painted an empty row, so
  // every pane lost its top border during any free-config drag.
  let top = null;
  const wantLeftTrigger  = chrome && chrome.tabTrigger;
  const wantRightCollapse = chrome && chrome.collapse;
  const wantRightClose    = chrome && chrome.close;
  if (chrome && (wantLeftTrigger || wantRightCollapse || wantRightClose)) {
    let leftPart = `${b.tl}${b.h}`;
    if (hotkey) leftPart += `(${hotkey})`;
    if (wantLeftTrigger) {
      // Eat the title-separator dash so [≡] sits flush against `(hk)`,
      // matching the post-injection geometry: `╭─(o)[≡]─title…`. When
      // there's no hotkey, [≡] sits flush against the corner dash.
      leftPart += _tabTriggerMarkup(chrome.tabTrigger, focused, fc);
    }
    if (title) leftPart += `${b.h}${title}`;
    leftPart = truncate(leftPart, innerW + 2 - 2);  // leave space for ╮ on right

    let rightPart = '';
    if (wantRightClose) rightPart += _closeGlyphMarkup(focused, fc);
    if (wantRightClose && wantRightCollapse) rightPart += b.h;
    if (wantRightCollapse) rightPart += _collapseGlyphMarkup(chrome.collapse, focused, fc);
    rightPart += b.tr;

    const leftVis  = visibleLen(leftPart);
    const rightVis = visibleLen(rightPart);
    const midFill = (innerW + 2) - leftVis - rightVis;
    if (midFill >= 1) {
      top = wrapColor(fc, leftPart + b.h.repeat(midFill) + rightPart);
    } else {
      // Chrome + title doesn't fit. Drop chrome; fall back to plain
      // border so the title at least survives.
      top = null;
    }
  }
  if (top === null || (!chrome)) {
    // Pre-P4 path: bare top border. Used when no chrome is requested,
    // or chrome was requested but didn't fit (fallback).
    let titleText = '';
    if (hotkey) titleText += `(${hotkey})`;
    if (title) titleText += `─${title}`;
    // Markup-aware truncation: titles can carry markup (`[dim]`, `\[…\]`,
    // `[/]`) whose JS .length over-counts the visible width. truncate()
    // short-circuits when visibleLen ≤ maxWidth, so the common (fits)
    // case is a no-op.
    titleText = truncate(titleText, innerW - 2);
    const fill = innerW - visibleLen(titleText);
    if (fill >= 2) {
      top = wrapColor(fc, `${b.tl}${b.h}${titleText}${b.h.repeat(fill - 1)}${b.tr}`);
    } else if (fill === 1) {
      top = wrapColor(fc, `${b.tl}${titleText}${b.h}${b.tr}`);
    } else {
      top = wrapColor(fc, `${b.tl}${titleText}${b.tr}`);
    }
  }

  // --- Bottom border ---
  const countText = count ? `${count[0]} of ${count[1]}` : '';
  let bottom;
  if (countText) {
    const bfill = innerW - countText.length;
    if (bfill >= 2) {
      bottom = `[${fc}]${b.bl}${b.h.repeat(bfill - 1)}${countText}${b.h}${b.br}[/]`;
    } else if (bfill === 1) {
      bottom = `[${fc}]${b.bl}${countText}${b.h}${b.br}[/]`;
    } else {
      bottom = `[${fc}]${b.bl}${countText.slice(0, innerW)}${b.br}[/]`;
    }
  } else {
    bottom = `[${fc}]${b.bl}${b.h.repeat(innerW)}${b.br}[/]`;
  }

  // --- Scrollbar ---
  const totalItems = count ? count[1] : lines.length;
  const sb = scrollbar(innerH, totalItems, innerH, scrollOffset);

  // --- Content ---
  const visible = lines.slice(scrollOffset, scrollOffset + innerH);
  const rows = [];
  for (let i = 0; i < innerH; i++) {
    let line = i < visible.length ? visible[i] : '';
    let vl = visibleLen(line);
    if (vl > innerW) {
      line = truncate(line, innerW);
      vl = visibleLen(line);
    }
    const pad = Math.max(0, innerW - vl);
    const rightChar = (sb && i >= sb.pos && i < sb.pos + sb.size) ? THUMB : b.v;
    rows.push(`[${fc}]${b.v}[/]${line}${' '.repeat(pad)}[/][${fc}]${rightChar}[/]`);
  }

  return [top, ...rows, bottom].join('\n');
}

/**
 * Paint a centered popup overlay using renderPanel + ANSI positioning.
 * Both the menu (`x`) and copy (`y`) popups go through here so their
 * geometry stays consistent.
 *
 * @param {object} opts
 * @param {string[]} opts.lines - panel content lines (Rich markup)
 * @param {string} opts.title - panel title
 * @param {[number,number]} [opts.count] - [current, total] for footer
 * @param {number} [opts.maxWidth=44] - cap on overlay width
 * @param {{x:number,y:number}} [opts.anchor] - 1-based cursor cell to open
 *   at (v0.6.4 Theme F: right-click context menu); null/absent → centered.
 */
// Model-clock terminal dims. `layoutSlice.dims` (resize-as-Msg) is the single
// source of truth for terminal size; the panel grid reads it directly. The
// footer + overlays read it through here so they paint against the SAME dims
// as the grid — not the io/term singleton, which is the UPSTREAM terminal
// cache and can lead the model by a frame on resize (panels would paint the
// new size, overlays the old). io/term fallback covers boot before the first
// term_resized (the layout slice seeds 80x24, so this is belt-and-suspenders).
//
// Render-exit seam: this leaf can't read the model (panel layer). The dims
// source is injected at boot via setDimsProvider — panel/api wires it to read
// the layout slice — so the model-read stays in panel and the frame stays a
// pure function of the model. io/term remains the boot/no-provider fallback.
let _dimsProvider = null;
function setDimsProvider(fn) { _dimsProvider = fn; }
function viewportDims() {
  const d = _dimsProvider && _dimsProvider();
  return (d && d.cols > 0 && d.rows > 0) ? { cols: d.cols, rows: d.rows } : { cols: cols(), rows: rows() };
}

// --- Pure chrome-glyph derivation (moved from render/decor.js in the
// render-exit arc; the slice-reading hit-tests went to panel/chrome-hittest).
// chromeFor decides which glyphs a pane carries; the *Markup builders emit
// the Rich markup renderPanel composes into the top border. All pure. ---

/**
 * Pure derivation of which chrome glyphs a pane should carry. Returns a
 * structured spec the renderer consumes. See panel/chrome-hittest.js for
 * the geometry/hit-test half.
 *
 *   pane: arrange-entry — .type, .collapsed, .tabs.
 *   ctx:  { freeConfigMode, dragging, focused, paneMenuTriggerState }.
 * Returns { collapse: null|'collapse'|'expand', close: null|'close',
 *           tabTrigger: null|'available'|'open'|'disabled' }.
 */
function chromeFor(pane, ctx) {
  const isDetail = pane && pane.type === 'detail';
  if (ctx && ctx.dragging) return { collapse: null, close: null, tabTrigger: null };
  let collapse = null, close = null;
  if (!isDetail) {
    collapse = pane.collapsed ? 'expand' : 'collapse';
    if (ctx && ctx.freeConfigMode) close = 'close';
  }
  let tabTrigger = null;
  const state = (ctx && ctx.paneMenuTriggerState) || 'available';
  if (state !== 'hidden') tabTrigger = state;
  return { collapse, close, tabTrigger };
}

/**
 * Markup helpers — renderPanel composes these chrome glyphs into the top
 * border directly (no regex post-mutation). Each returns Rich markup whose
 * visible width equals the glyph's cell count (3 cells). `fc` is the panel
 * border color; markup re-opens it after each glyph's `[/]`.
 */
function _collapseGlyphMarkup(mode, focused, fc) {
  const t = theme();
  const base = mode === 'expand'
    ? (t.chrome_expand   || 'green')
    : (t.chrome_collapse || 'yellow');
  const open = focused ? `[${base}]` : `[dim][${base}]`;
  const glyph = mode === 'expand' ? '\\[+]' : '\\[_]';
  return `${open}${glyph}[/]${fc ? `[${fc}]` : ''}`;
}

function _closeGlyphMarkup(focused, fc) {
  const t = theme();
  const base = t.chrome_close || 'red';
  const open = focused ? `[${base}]` : `[dim][${base}]`;
  return `${open}${CLOSE_GLYPH}[/]${fc ? `[${fc}]` : ''}`;
}

function _tabTriggerMarkup(state, focused, fc) {
  const t = theme();
  const base = t.chrome_trigger || 'bold cyan';
  const colorOnly = base.replace(/^bold\s+/, '');
  let open;
  if      (state === 'disabled') open = '[dim]';
  else if (state === 'open')     open = '[reverse]';
  else if (focused)              open = `[${base}]`;
  else                           open = `[dim][${colorOnly}]`;
  return `${open}\\[≡][/]${fc ? `[${fc}]` : ''}`;
}

/**
 * Box geometry for an overlay popup — the single source the paint path
 * (renderOverlay) and the hit-test path (overlay/menu.hitTest) BOTH read,
 * so a click never lands on a cell the box didn't paint. Returns 0-based
 * top-left {offX, offY} + {menuW, menuH} (outer dims, borders included).
 *
 * v0.6.4 Theme F Phase 3 — anchored placement: open the box's top-left at
 * the cursor (1-based SGR cell → 0-based offset), clamped so the whole box
 * stays on-screen. No anchor → centered.
 */
function overlayBox({ linesLen, anchor = null, maxWidth = 44 }) {
  const { cols: COLS, rows: ROWS } = viewportDims();
  const menuW = Math.min(maxWidth, COLS - 2);
  const menuH = Math.min(linesLen + 2, ROWS - 2);
  let offY, offX;
  if (anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) {
    offX = Math.max(0, Math.min(anchor.x - 1, COLS - menuW));
    offY = Math.max(0, Math.min(anchor.y - 1, ROWS - menuH));
  } else {
    offY = Math.max(0, Math.floor((ROWS - menuH) / 2));
    offX = Math.max(0, Math.floor((COLS - menuW) / 2));
  }
  return { offX, offY, menuW, menuH };
}

function renderOverlay({ lines, title, count = null, maxWidth = 44, anchor = null }) {
  const { offX, offY, menuW, menuH } = overlayBox({ linesLen: lines.length, anchor, maxWidth });
  const content = renderPanel({
    width: menuW, height: menuH, lines, title, focused: true, count,
  });
  const out = content.split('\n');
  // Build one string with embedded cursor moves, write once. Per-line
  // moveTo + stdout.write was a syscall per row; on a slow TTY that
  // could tear under load.
  let buf = '';
  for (let i = 0; i < out.length; i++) {
    buf += `\x1b[${offY + i + 1};${offX + 1}H` + richToAnsi(out[i]) + RESET;
  }
  stdout.write(buf);
}

module.exports = {
  renderPanel, renderOverlay, overlayBox, truncate, viewportDims, setDimsProvider,
  chromeFor, _collapseGlyphMarkup, _closeGlyphMarkup, _tabTriggerMarkup,
};
