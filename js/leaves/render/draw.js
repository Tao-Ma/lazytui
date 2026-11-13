/**
 * Panel renderer — bordered panels with scrollbar + pure chrome-glyph
 * derivation. Produces Rich-markup strings (convert to ANSI before writing
 * to terminal). A pure leaf: depends only on sibling leaves (ansi, scrollbar,
 * themes) — no io. Terminal dims + the overlay paint-write arrive via injected
 * seams (setDimsProvider / setWriter) so the leaf never reaches up into panel
 * for the model nor into io for stdout — see docs/v0.6.5-render-exit.md.
 */
'use strict';

const { visibleLen, charWidth, richToAnsi, wrapColor, RESET } = require('../text/ansi');
const { scrollbar } = require('./scrollbar');
const { theme } = require('../infra/themes');
const bctl = require('./border-controls');
// No io import: terminal dims arrive via the injected _dimsProvider (below)
// and the overlay paint write via the injected _writer (setWriter), both wired
// at boot. Keeping this leaf free of io is what lets io/file-loader depend DOWN
// on the pure leaves/ansi without forming an io↔leaves cycle.

const { compositeRow } = require('./row-compositor');
const { chipSurvives } = require('./hints');

const BORDER = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };
const THUMB = '▐';
const CLOSE_GLYPH = '\\[X]';

// The painted left border UP TO the `[≡]` trigger: `╭─` + the optional
// `(hotkey)` display. This is the SINGLE source of truth for where `[≡]` sits —
// `renderPanel` builds its top border from `.prefix`, and the trigger hit-test
// (overlay/pane-menu.js) probes `.triggerCol`. Sharing one function is
// deliberate: the two once computed this independently and drifted — the
// hit-test hardcoded col 5 (assuming a 1-char hotkey), so on a hotkey-less pane
// (`╭─[≡]`, col 2) the clickable zone sat 3 cells right of the painted glyph.
// PURE — a function of the hotkey label only.
function leftBorderPrefix(hotkey) {
  const prefix = `${BORDER.tl}${BORDER.h}` + (hotkey ? `(${hotkey})` : '');
  return { prefix, triggerCol: visibleLen(prefix) };
}

/**
 * Truncate text to max visible width — MARKUP-AWARE.
 *
 * Walks the Rich string keeping EVERY tag verbatim at zero visible width —
 * leading AND inner ([reverse], [/], per-span colors, search-match / selection
 * highlights) — counting only real glyphs. Whatever style is open at the cut
 * runs into the `…`; the panel renderer adds a reset before the right border,
 * so we leave it unclosed by convention (PRINCIPLES.md §8).
 *
 * The prior version kept only the LEADING style prefix and stripMarkup'd the
 * rest, which silently dropped inner styling on any truncated line — e.g. a
 * drag-selection over a long reversed row (its `[/]…[reverse]` XOR break was
 * discarded, so the whole row painted as one solid reverse bar). A `\[` escape
 * is preserved as-is (a literal `[`, 1 col) so richToAnsi re-emits a literal,
 * not a tag start.
 */
// SGR color/style run — zero visible width; kept verbatim through truncation so the color
// survives the cut, exactly like a Rich `[...]` tag. Matches BOTH the raw form (\x1b[…m) and
// the esc()'d content form (\x1b\[…m — esc escapes the SGR's `[`). Sticky to avoid slicing
// per step.
const _SGR_RUN = /\x1b\\?\[[0-9;]*m/y;
function truncate(text, maxWidth) {
  // Non-positive budget → nothing fits (not even the ellipsis). Return empty so
  // `visibleLen(out) <= max(0, maxWidth)` holds unconditionally — the cell-diff
  // emits absolute per-cell column moves and cannot tolerate a 1-col overrun into
  // a degenerate sub-2-col panel (title truncation, a 0-width preview column).
  if (maxWidth <= 0) return '';
  if (visibleLen(text) <= maxWidth) return text;
  const limit = maxWidth - 1;   // leave 1 col for the ellipsis
  let out = '';
  let w = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    // Escaped bracket `\[` → one literal `[` glyph. Keep the escape.
    if (text[i] === '\\' && text[i + 1] === '[') {
      if (w + 1 > limit) break;
      out += '\\[';
      w += 1;
      i += 2;
      continue;
    }
    // SGR color/style sequence `\x1b[…m` — zero visible width, kept verbatim so the
    // color survives the cut, like a Rich tag. (A non-SGR escape falls through and is
    // treated as a visible char, matching charWidth's cp<0x300 → 1.)
    if (text[i] === '\x1b') {
      _SGR_RUN.lastIndex = i;
      const m = _SGR_RUN.exec(text);
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    // Rich tag `[...]` — zero visible width, kept verbatim (incl. `[/]`).
    if (text[i] === '[') {
      const close = text.indexOf(']', i);
      if (close !== -1) { out += text.slice(i, close + 1); i = close + 1; continue; }
      // unmatched `[` → fall through and treat it as a visible char
    }
    const cp = text.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw > limit) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out + '…';
}

/**
 * Fit a markup/SGR string to EXACTLY `width` visible columns: SGR/wide-char-aware
 * truncate (adds `…`) when over, pad-right with spaces when under. THE shared
 * fixed-width cell helper — use it instead of `.slice()`/`.padEnd()` on CHARACTER
 * counts, which miscount SGR runs, `\[` escapes, and wide (CJK/emoji) chars and so
 * break column alignment (or leave a stray `\`). For a PLAIN string that may hold a
 * literal `[`, esc() it first so the bracket is a 1-col literal, not a tag start.
 */
function fitCell(s, width) {
  const str = s == null ? '' : String(s);
  if (width <= 0) return '';
  const vis = visibleLen(str);
  if (vis <= width) return str + ' '.repeat(width - vis);
  // Over width: truncate (adds `…`), then RE-PAD the shortfall. truncate() never
  // splits a wide (2-col) glyph, so when the last glyph that fits is wide it can
  // stop 1 column short of `width`; without the re-pad the cell renders width-1
  // cols and every column after it misaligns (the exact class fitCell exists to
  // prevent). Mirrors table.js's inline fitter.
  const cut = truncate(str, width);
  const cvis = visibleLen(cut);
  return cvis < width ? cut + ' '.repeat(width - cvis) : cut;
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
 * @param {number} [opts.scrollOffset] - first visible item index (drives the
 *   scrollbar thumb; ALSO slices `lines` to the viewport unless `windowed`)
 * @param {boolean} [opts.windowed] - A3 (v0.6.7): `lines` is ALREADY the visible
 *   window (caller pre-sliced + decorated only the window, O(innerH) not O(total)).
 *   Then `scrollOffset` positions the scrollbar thumb but does NOT re-slice, and
 *   `count[1]` carries the true total. Default false (navigators pass the full
 *   list + scrollOffset and let renderPanel slice).
 * @param {string} [opts.color] - focused border color
 * @param {Array<string|{text}>} [opts.topControls] - opt-in interactive controls (top border):
 *   markup strings, or api.borderControlsFor entries `{ text, visibleW, spec, pane }` —
 *   an entry object is echoed back through the chrome sink with the pane-local x
 *   where it drew (`controls` / `bottomControl`), so the paint layer publishes its
 *   hit regions exactly there (docs/mouse-hit-map.md Release 2).
 *   embedded in the top border, right-anchored one gap-dash left of the chrome
 *   glyphs. An ordered STRIP: the first entry paints leftmost, the last nearest
 *   the glyphs (the monitor refresh control `- Ns +` was the first consumer).
 *   Presence is title-INDEPENDENT (the title truncates to reserve the whole
 *   strip). Where each control drew is reported through the chrome sink, so
 *   its hit regions sit exactly on it.
 * @returns {string} Rich markup string
 */
function renderPanel({
  width, height, lines = [], title = '', hotkey = '',
  focused = false, count = null, scrollOffset = 0, color = null,
  panelType = null, chrome = null, windowed = false, topControls = [], bottomControls = [],
  titleTargets = null,
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
  let chromeDrew = false;   // did the [≡]/[X]/[_] cluster actually paint (fits)?
  let triggerReg = null;    // the [≡] pane-local x-range IFF it survived leftPart truncation
  let tabsDrawn = null;     // [{ x0, x1, ref }] pane-local — titleTargets that survived truncation
  let titleClip = null;     // pane-local exclusive column past which no intact title glyph drew
                            // (the tab-strip hit-test clips its tabBounds to this — a slot strip
                            // truncated on a narrow pane must not report a clipped tab as clickable)
  const wantLeftTrigger  = chrome && chrome.tabTrigger;
  const wantRightCollapse = chrome && chrome.collapse;
  const wantRightClose    = chrome && chrome.close;
  const hasControls = Array.isArray(topControls) && topControls.length > 0;
  const _ctlText = (c) => (c && typeof c === 'object') ? c.text : c;
  let controlsDrawn = null;   // [{ x0, visibleW, ref }] pane-local, iff the strip drew
  if (chrome && (wantLeftTrigger || wantRightCollapse || wantRightClose)) {
    // Right cluster first. The opt-in border-control strip (e.g. the monitor
    // refresh control `- Ns +`) sits one gap-dash LEFT of the glyphs (right-
    // anchored). Prepend controls right-to-left so the FIRST registered paints
    // leftmost and the LAST nearest the glyphs (controlsDrawn records each x).
    let rightPart = '';
    if (wantRightClose) rightPart += _closeGlyphMarkup(focused, fc);
    if (wantRightClose && wantRightCollapse) rightPart += b.h;
    if (wantRightCollapse) rightPart += _collapseGlyphMarkup(chrome.collapse, focused, fc);
    if (hasControls) {
      for (let i = topControls.length - 1; i >= 0; i--) rightPart = `${_ctlText(topControls[i])}${b.h}${rightPart}`;
    }
    rightPart += b.tr;
    const rightVis = visibleLen(rightPart);

    // `leftBorderPrefix` owns the `╭─` + `(hotkey)` geometry (shared with the
    // trigger hit-test — see its definition). [≡] then sits flush against it (no
    // separator dash), so its column IS `leftBorderPrefix(hotkey).triggerCol`.
    const lbp = leftBorderPrefix(hotkey);
    let leftPart = lbp.prefix;
    if (wantLeftTrigger) {
      leftPart += _tabTriggerMarkup(chrome.tabTrigger, focused, fc);
    }
    if (title) leftPart += `${b.h}${title}`;
    // With a border-control strip, reserve the WHOLE right cluster (+ one
    // separator dash) so the TITLE truncates to fit it — the strip's presence is
    // then title-INDEPENDENT (renders iff `╭─` + a dash + the cluster fit), which
    // border-controls.fits mirrors for the hit-test so a click can never land
    // where no control drew. Without controls, the pre-P4 behavior: the title
    // may use the full width and the whole chrome row drops if it and the glyphs
    // don't fit.
    const leftCap = hasControls ? (innerW + 2 - rightVis - 1) : (innerW + 2 - 2);
    const leftVisFull = visibleLen(leftPart);   // BEFORE truncation — for [≡] survival
    leftPart = truncate(leftPart, Math.max(0, leftCap));

    const leftVis  = visibleLen(leftPart);
    const midFill = (innerW + 2) - leftVis - rightVis;
    // Border-control strip: presence gates on `leftCap >= 2` (room for `╭─`),
    // which guarantees midFill >= 1. Otherwise the pre-P4 `midFill >= 1` gate.
    const fits = hasControls ? (leftCap >= 2) : (midFill >= 1);
    if (fits) {
      chromeDrew = true;
      // Drawn title extent for the tab-strip hit-test: leftPart is composed
      // (prefix + [≡] + dash + title) THEN truncated at its tail, so surviving
      // tabs keep their pane-local x — only the tail is cut. A truncated leftPart
      // ends in `…` (1 cell), so intact glyphs stop one col short of leftCap.
      titleClip = (leftVisFull <= leftCap) ? leftVisFull : (leftCap - 1);
      // Title click targets (a slot's tab strip): the title starts after the
      // prefix, the [≡] (when drawn) and one dash; a target is reported only if
      // every cell of it is left of titleClip (a tab cut by truncation isn't
      // clickable — it isn't drawn).
      if (title && Array.isArray(titleTargets) && titleTargets.length) {
        const tx0 = visibleLen(lbp.prefix) + (wantLeftTrigger ? 3 : 0) + 1;
        tabsDrawn = [];
        for (const t of titleTargets) {
          const x0 = tx0 + t.x, x1 = x0 + t.w - 1;
          if (t.w > 0 && x1 < titleClip) tabsDrawn.push({ x0, x1, ref: t });
        }
      }
      // The [≡] lives INSIDE leftPart, which `truncate` cuts INDEPENDENTLY of
      // `fits` (a border-control strip or a long title shrinks leftCap and can
      // clip the glyph while the row still composites). So the trigger is painted
      // — hence clickable — only when it actually survived that truncation: either
      // leftPart wasn't truncated, or the cut kept through the glyph's last cell
      // (its end column tcol+3 ≤ the kept width `leftCap-1`). Right-anchored
      // close/collapse are never truncated, so they stay gated on `chromeDrew`.
      if (wantLeftTrigger &&
          (leftVisFull <= leftCap || (leftCap - 1) >= lbp.triggerCol + 3)) {
        triggerReg = { x0: lbp.triggerCol, x1: lbp.triggerCol + 2 };
      }
      if (hasControls) {
        // The strip opens rightPart, which ends at the corner: its first cell is
        // pane-local `width - rightVis`; each control is followed by one dash.
        controlsDrawn = [];
        let cx = width - rightVis;
        for (const c of topControls) {
          const vw = visibleLen(_ctlText(c));
          controlsDrawn.push({ x0: cx, visibleW: vw, ref: (c && typeof c === 'object') ? c : null });
          cx += vw + 1;
        }
      }
      top = wrapColor(fc, leftPart + b.h.repeat(Math.max(1, midFill)) + rightPart);
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

  // Bottom legend placement (drawn below iff bctl.bottomFits — count-independent),
  // decided here so the chrome emit can report it: pane-local x0 = 2 (corner +
  // lead dash), row = the pane's last.
  const legendRef = (Array.isArray(bottomControls) && bottomControls[0]) || null;
  const legendText = (legendRef && typeof legendRef === 'object' ? legendRef.text : legendRef) || '';
  const legendW = legendText ? visibleLen(legendText) : 0;
  const bottomDrawn = (legendW && bctl.bottomFits(innerW, legendW) && height >= 2)
    ? { x0: 2, y: height - 1, visibleW: legendW, ref: (legendRef && typeof legendRef === 'object') ? legendRef : null }
    : null;

  // Publish the ACTUALLY-DRAWN clickable chrome (pane-local x-ranges; a null
  // glyph = not painted) — render/paint turns it into hit-map regions.
  // close/collapse are right-anchored (`─[X] [_]╮`) and never truncated, so
  // they follow `chromeDrew` (the whole-cluster `fits`). The `[≡]` trigger is
  // left-anchored INSIDE the independently-truncated leftPart, so it carries its
  // own survival check (`triggerReg`, set above) — `fits` alone would over-report
  // it (the residual narrow-pane phantom the registry-read must not fire on).
  // Emitted through the injected sink; a null ambient paneId (overlays / direct
  // callers) is dropped by the registry.
  if (_chromeSink) {
    _chromeSink({
      trigger:  triggerReg,
      close:    chromeDrew && wantRightClose    ? { x0: width - 8, x1: width - 6 } : null,
      collapse: chromeDrew && wantRightCollapse ? { x0: width - 4, x1: width - 2 } : null,
      titleClip,
      controls: controlsDrawn,
      tabs: tabsDrawn,
      bottomControl: bottomDrawn,
    });
  }

  // --- Bottom border ---
  // Left-anchored item-action legend (the `bottomControls` strip — one control
  // today) + the right-anchored `N of M` count. The legend is COUNT-INDEPENDENT
  // (shown iff the pane is wide enough for it alone — border-controls.bottomFits,
  // decided above as `bottomDrawn` and reported through the chrome sink); the
  // count drops when it can't share the row.
  const countText = count ? `${count[0]} of ${count[1]}` : '';
  const legend = legendText;
  const legendVis = legendW;
  let bottom;
  if (legendVis && bctl.bottomFits(innerW, legendVis)) {
    // ╰─{legend}{mid dashes}[{count}─]╯ — inner cells = 1 lead + legend + mid + right
    const leadAndLegend = 1 + legendVis;
    const showCount = countText && (innerW - leadAndLegend - (countText.length + 1) >= 1);
    const rightCore = showCount ? `${countText}${b.h}` : '';
    const rightVis = showCount ? countText.length + 1 : 0;
    const mid = innerW - leadAndLegend - rightVis;   // ≥1 (bottomFits guarantees it when no count)
    // wrapColor (NOT a raw `[fc]…[/]`): the legend embeds `[key_hint]X[/]` per
    // action, and `[/]` compiles to a HARD reset — a raw wrap would leave the
    // rest of the border (dashes, count, corner) in the terminal default. wrapColor
    // re-opens `fc` after each internal reset, exactly like the top border does.
    bottom = wrapColor(fc, `${b.bl}${b.h}${legend}${b.h.repeat(Math.max(1, mid))}${rightCore}${b.br}`);
  } else if (countText) {
    const bfill = innerW - countText.length;
    if (bfill >= 2) {
      bottom = `[${fc}]${b.bl}${b.h.repeat(bfill - 1)}${countText}${b.h}${b.br}[/]`;
    } else if (bfill === 1) {
      bottom = `[${fc}]${b.bl}${countText}${b.h}${b.br}[/]`;
    } else {
      // Math.max(0,…): on a degenerate box (innerW < 0, e.g. full-view on a ~1-col
      // terminal) slice(0, <negative>) counts from the END and would keep a trailing
      // fragment of the count text; clamp to 0 so it degrades to an empty middle.
      bottom = `[${fc}]${b.bl}${countText.slice(0, Math.max(0, innerW))}${b.br}[/]`;
    }
  } else {
    // clamp: a sub-2-col pane (innerW < 0, e.g. a full-viewed box on a 1-col
    // terminal) with no count reaches here — repeat(<negative>) throws RangeError.
    bottom = `[${fc}]${b.bl}${b.h.repeat(Math.max(0, innerW))}${b.br}[/]`;
  }

  // --- Scrollbar ---
  const totalItems = count ? count[1] : lines.length;
  const sb = scrollbar(innerH, totalItems, innerH, scrollOffset);

  // --- Content ---
  // A3 — when `windowed`, the caller already sliced `lines` to the viewport
  // (and decorated only those rows); scrollOffset is for the scrollbar only.
  const visible = windowed ? lines : lines.slice(scrollOffset, scrollOffset + innerH);
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
// Render-exit seam: this leaf can't read the model (panel layer) nor import
// io. The dims source is injected via setDimsProvider — panel/api wires it to
// resolve the layout slice's model dims first, then io/term as the boot
// fallback — so both the model-read and the io-read stay in panel and the leaf
// only consumes resolved {cols,rows} (the dims source is unified on the model).
// The 80x24 here is only the last-resort when NO provider is wired at all
// (e.g. a unit test that calls this leaf without booting); it matches the
// layout slice's own seed.
let _dimsProvider = null;
function setDimsProvider(fn) { _dimsProvider = fn; }
function viewportDims() {
  const d = _dimsProvider && _dimsProvider();
  return (d && d.cols > 0 && d.rows > 0) ? { cols: d.cols, rows: d.rows } : { cols: 80, rows: 24 };
}

// Overlay-paint write seam. renderOverlay (below) emits the composed buffer
// through this injected writer instead of importing io/term's stdout — same
// reason as the dims seam: keep the leaf free of io. Wired at boot by
// render/paint.js to `buf => stdout.write(buf)`. Unset in CLI/tests (no paint
// path loaded) → renderOverlay no-ops the write, which is what those callers
// want (they assert overlay geometry/state, never pixels).
let _writer = null;
function setWriter(fn) { _writer = fn; }

// Chrome-region publish seam. renderPanel emits the pane-local x-ranges of the
// clickable border glyphs it ACTUALLY drew (or null per glyph when the narrow-pane
// `fits` fallback dropped the whole cluster) so the hit-tests read real geometry
// instead of a width proxy — the paint↔hit-test agreement fix for the narrow-pane
// phantom hit. This bottom leaf can't import the panel-layer registry, so paint
// wires this sink to panel/chrome-regions.publish(<ambient paneId>, …). Unset in
// CLI/tests / for overlays with no ambient pane → renderPanel skips the emit.
let _chromeSink = null;
function setChromeSink(fn) { _chromeSink = fn; }

// Hit-map publish seam (docs/mouse-hit-map.md). publishBox emits each clickable
// region an overlay ACTUALLY drew — its box, visible rows, surviving hint chips —
// as `(region, zOff)`. This leaf can't import the panel-layer hit map, so paint
// wires the sink to panel/hit-map.publishOwned, which stamps the ambient overlay
// owner + absolute z (the compositor brackets each overlay's render). Unset in
// CLI/tests that never load paint → publishBox no-ops.
let _hitSink = null;
function setHitSink(fn) { _hitSink = fn; }

// z offsets within one overlay's band (the compositor adds the band base).
// 0 is the backdrop, published by the compositor itself.
const HIT_Z = Object.freeze({ backdrop: 0, box: 1, row: 2, chip: 3 });

/**
 * Publish an overlay box's clickable regions, clipped to the viewport — the ONE
 * place popup geometry turns into hit regions, shared by renderOverlay and the
 * overlays that compose their own box (pane-menu, cmdline). Agreement by
 * construction: a row publishes only if it is inside the visible window, a chip
 * only if renderPanel's truncation kept it.
 *
 *   { x, y, w, h }        box rect (screen cells, incl. borders)
 *   scrollOffset           first visible line index (0 for pre-sliced callers)
 *   lines                  the content lines handed to renderPanel (chip truncation)
 *   lineTargets            handler maps index-aligned with `lines` (null = inert)
 *   lineChips              { [lineIdx]: chips } from leaves/render/hints.formatHints
 *   box                    handler map for the box itself (e.g. wheel → up/down)
 */
function publishBox({ x, y, w, h, scrollOffset = 0, lines = [],
                      lineTargets = null, lineChips = null, box = null }) {
  if (!_hitSink || !(w > 0) || !(h > 0)) return;
  const { cols: COLS, rows: ROWS } = viewportDims();
  // Clip a rect to the screen; null when nothing is left on-screen.
  const clip = (rx, ry, rw, rh) => {
    const x0 = Math.max(0, rx), y0 = Math.max(0, ry);
    const x1 = Math.min(COLS, rx + rw), y1 = Math.min(ROWS, ry + rh);
    return (x1 > x0 && y1 > y0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  };
  const boxRect = clip(x, y, w, h);
  if (!boxRect) return;
  _hitSink({ id: 'box', rect: boxRect, opaque: true, on: box || {} }, HIT_Z.box);
  const innerW = w - 2;
  const innerH = h - 2;
  const offset = Math.max(0, scrollOffset | 0);
  for (let i = 0; i < innerH; i++) {
    const li = offset + i;
    if (li >= lines.length) break;
    const sy = y + 1 + i;
    const target = lineTargets && lineTargets[li];
    if (target) {
      const r = clip(x + 1, sy, innerW, 1);
      if (r) _hitSink({ id: `row:${li}`, rect: r, on: target }, HIT_Z.row);
    }
    const chips = lineChips && lineChips[li];
    if (chips && chips.length) {
      const lineW = visibleLen(lines[li]);
      for (const c of chips) {
        if (!chipSurvives(c, lineW, innerW)) continue;
        const r = clip(x + 1 + c.x0, sy, c.x1 - c.x0 + 1, 1);
        // repeat: a fast second click on the same chip is another press of
        // its key (typing it twice) — see mouse-router's continuation rule.
        if (r) _hitSink({ id: `chip:${c.key}`, rect: r, repeat: true, on: { press: { key: c.key, seq: c.seq } } }, HIT_Z.chip);
      }
    }
  }
}
// Direct write-through for overlays that compose their OWN screen bytes
// (cmdline, pane-menu) instead of going through renderOverlay. Review Track
// 1/2 HIGH (truecolor arc): those overlays wrote io/term stdout directly,
// bypassing paint's depth-adapting _emit funnel — raw 38;2 leaked on 16/256
// devices the moment their slots went hex (the footer-bug class, P3). Every
// frame byte must leave through the injected writer. No-op when unset
// (CLI/tests without the paint path), same contract as renderOverlay.
function writeOut(buf) { if (_writer) _writer(buf); }

// --- Pure chrome-glyph derivation (moved from render/decor.js in the
// render-exit arc; clicks resolve on the per-frame hit map, panel/hit-map).
// chromeFor decides which glyphs a pane carries; the *Markup builders emit
// the Rich markup renderPanel composes into the top border. All pure. ---

/**
 * Pure derivation of which chrome glyphs a pane should carry. Returns a
 * structured spec the renderer consumes. renderPanel reports what actually drew
 * through the chrome sink; render/paint publishes the hit regions.
 *
 *   pane: arrange-entry — .type, .collapsed, .tabs.
 *   ctx:  { freeConfigMode, dragging, focused, paneMenuTriggerState }.
 * Returns { collapse: null|'collapse'|'expand', close: null|'close',
 *           tabTrigger: null|'available'|'open'|'disabled' }.
 */
function chromeFor(pane, ctx) {
  // U2e P1b — the content/viewer slot (no collapse/close glyphs) is identified by
  // its stable `role`, not the active tab's kind (post-seed `pane.type` is 'info').
  const isDetail = pane && (pane.role === 'content' || pane.type === 'detail');
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
 * Box geometry for an overlay popup — the single source renderOverlay paints
 * from AND hands to publishBox for the hit map (renderMenu sizes its scroll
 * window from it too; replay-scrubber's hitTestSeek reads it), so a click
 * never lands on a cell the box didn't paint. Returns 0-based
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

// Overlay-compositor migration (Release 2, docs/overlay-compositor-migration.md).
// Composites each overlay row into the main-frame row buffer the paint
// pass is about to diff, via `row-compositor.compositeRow`. The cell-diff
// then handles both the overlay's leading paint AND the clean-up on
// close/shrink from the natural per-cell delta — no sig tracker required.
//
// `targetRows` + `targetCols` are required (end-of-Release-2 cleanup
// retired the stdout fallback). Call sites that invoke `renderOverlay`
// without them (future bugs) crash loudly on the compositeRow call rather
// than silently painting nothing — the right failure mode for a
// production code path.
// `hit` (optional, docs/mouse-hit-map.md) opts the overlay into the hit map:
// `{ lineTargets, lineChips, box }` as publishBox takes them. ABSENT → nothing
// is published, so an overlay that hasn't migrated keeps its legacy mouse path
// (an always-published opaque box would swallow clicks its legacy handler owns).
function renderOverlay({ lines, title, count = null, maxWidth = 44, anchor = null, scrollOffset = 0,
                         targetRows, targetCols, hit = null }) {
  const { offX, offY, menuW, menuH } = overlayBox({ linesLen: lines.length, anchor, maxWidth });
  const content = renderPanel({
    width: menuW, height: menuH, lines, title, focused: true, count, scrollOffset,
  });
  const out = content.split('\n');
  for (let i = 0; i < out.length; i++) {
    compositeRow(targetRows, targetCols, out[i], offX, offY + i, menuW);
  }
  if (hit) {
    publishBox({ x: offX, y: offY, w: menuW, h: menuH, scrollOffset, lines,
                 lineTargets: hit.lineTargets, lineChips: hit.lineChips, box: hit.box });
  }
}

module.exports = {
  renderPanel, renderOverlay, overlayBox, truncate, fitCell, viewportDims, setDimsProvider,
  setWriter, setChromeSink, setHitSink, publishBox, HIT_Z, writeOut,
  chromeFor, leftBorderPrefix, _collapseGlyphMarkup, _closeGlyphMarkup,
};
