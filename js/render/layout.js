/**
 * Layout calculation and view mode rendering.
 *
 * Geometry as view-derived data (docs/v0.5-layering.md §5). Two
 * sources during the v0.6.3 P1 migration:
 *
 *   - `layoutSlice.paneBounds` — legacy per-panel `{x,y,w,h}` map
 *     written by renderNormal/Half/Full. Carries the viewer's tab-
 *     bar hit-test cache as `.tabs` on detail's entry. Retires when
 *     P1.4 lands (currently deferred — see docs/v0.6.3.md §Track A).
 *
 *   - `_currentLayout` — module-local Layout value `{rects, availH,
 *     viewMode, cols, rows}` published by calcLayout (P1.2). The
 *     `rects` array is the per-frame canonical geometry list.
 *
 * The `boundsFor(key)` accessor (P1.3) reads slice first, falls
 * through to `_currentLayout.rects` when slice is empty. Hit-test
 * consumers go through boundsFor; the per-panel height accessor
 * `getPanelViewportH(type)` is view-mode-aware (half/full view's
 * on-screen panel gets full availH, not its normal-view column-share)
 * — direct reads of the column-share height would silently under-
 * report in half/full view; the API hides that footgun (fix arc
 * 2026-06-03).
 *
 * This is the one pattern that sits outside the otherwise-uniform
 * "Component update is the single writer of its slice" rule. The
 * justification is layering: the geometry is a pure function of view
 * state (term size, arrange, viewMode) and would be wasteful to route
 * through a Msg every frame. The viewer Component does the same for
 * `paneBounds.detail.tabs` (the tab-bar hit-test cache, viewer.js
 * §detailTitle). Pure-TEA freeze tests on the layout slice must
 * whitelist these renderer-written fields.
 *
 * Zero npm dependencies (uses local modules).
 */
'use strict';

const { RESET, richToAnsi, esc, visibleLen, wrapColor } = require('../io/ansi');
const { refreshSize, cols, rows, stdout, showCursor, hideCursor } = require('../io/term');
const { allPanels, syncPanelScroll, multiSelCount } = require('../app/state');
const mpool = require('../leaves/pool');
const mpane = require('../leaves/pane');
const { theme } = require('./themes');
const { truncate } = require('./panel');
const painter = require('./painter');
const { isTerminalTab, activeTerminalId, activeTerminalConfig,
        getTabInfo, findEphemeralByid } = require('../panel/viewer/tabs');
const { ensureSession, getSession, resizeSession } = require('../io/terminal');
const {getPanelDef, getInstanceSlice, getFocus, getComponent, getComponentOwningPanel,
       dispatchMsg, wrap, instanceKind,
       collectViewContributions, filterCurrentText } = require('../panel/api');
const { renderCopyMenu } = require('../overlay/copy');
const { render: renderRegisterPopup } = require('../overlay/register-popup');
const { renderMenu } = require('../overlay/menu');
const { renderWhichKey } = require('../overlay/which-key');
const modes = require('../dispatch/modes');
const { getModel } = require('../app/runtime');
const { renderCmdline } = require('../overlay/cmdline');
const { renderConfirmOverlay } = require('../overlay/confirm');
const { renderPromptOverlay } = require('../overlay/prompt');
const { getFreeConfigFooter } = require('../panel/free-config-view');
const { renderPanelListOverlay } = require('../overlay/panel-list');
const { renderTabList } = require('../overlay/tab-list');
const { renderJobsOverlay } = require('../overlay/jobs');

/**
 * Look up the render function for a panel type. Contract:
 *   render(panel, width, height, state) → string
 * Height is passed explicitly by every caller (renderNormal/Half/Full).
 * Renderers should treat the height arg as authoritative; reaching
 * around for the column-share via the renderer's internal map would
 * be implicit coupling to the layout pass and breaks half/full view
 * modes that supply a different height.
 */
/**
 * Render a collapsed placement as a 1-row title bar. The panel's own
 * renderer is bypassed (it'd need to special-case h=1 everywhere);
 * layout owns this for-uniformity rendering of the minimized chrome.
 * Focus-aware color (matches renderPanel's top border).
 */
function _renderCollapsed(p, w, chrome) {
  const t = theme();
  const layoutSlice = getInstanceSlice('layout');
  const focused = !!(layoutSlice && mpane.paneMatchesFocus(p, layoutSlice.focus));
  const fc = focused ? t.focus : t.dim;
  const innerW = Math.max(0, w - 2);
  let titleText = '';
  if (p.hotkey) titleText += `(${p.hotkey})`;
  if (p.title)  titleText += `─${p.title}`;
  titleText = truncate(titleText, innerW - 2);

  // v0.6.3 P4.2 — chrome glyphs compose inline. For a collapsed pane,
  // chrome.collapse === 'expand' (the [+] glyph signals "click to
  // uncollapse"); close glyph still allowed in free-config. Width
  // budget: titleText + chrome + 2 corners must fit in w; on tight
  // widths, drop chrome and fall back to bare collapsed bar.
  const W = require('./decor');
  let rightPart = '';
  if (chrome) {
    if (chrome.close)    rightPart += W._closeGlyphMarkup(focused, fc);
    if (chrome.close && chrome.collapse) rightPart += '─';
    if (chrome.collapse) rightPart += W._collapseGlyphMarkup(chrome.collapse, focused, fc);
  }
  if (rightPart) {
    rightPart += '╮';
    const titleVis = visibleLen(titleText);
    const rightVis = visibleLen(rightPart);
    // leftPart is `╭─` + titleText = 2 + titleVis visible cells.
    const midFill = w - 2 - titleVis - rightVis;
    if (midFill >= 1) {
      return wrapColor(fc, `╭─${titleText}${'─'.repeat(midFill)}${rightPart}`);
    }
    // Doesn't fit — fall through to bare collapsed bar.
  }

  const fill = innerW - visibleLen(titleText);
  if (fill >= 2)      return wrapColor(fc, `╭─${titleText}${'─'.repeat(fill - 1)}╮`);
  else if (fill === 1) return wrapColor(fc, `╭${titleText}─╮`);
  else                 return wrapColor(fc, `╭${titleText}╮`);
}


// --- Layout calculation ---

/**
 * Distribute the column's `availH` rows across `panels`, returning a
 * `{ [type]: rows }` map. Three classes of panel share the column:
 *
 *   1. Detail (right column only). Reserved height = `availH *
 *      detailHeightPct / 100`. Detail never carries a per-panel
 *      heightPct — the layout-level knob is its sole control.
 *   2. Anchored panels — those with an explicit `heightPct: N`.
 *      Each gets `availH * N / 100` rows.
 *   3. Flex panels — no heightPct. Split whatever remains, equally.
 *
 * If anchored + reserved would leave less than minH for each flex
 * panel, anchored shrinks proportionally (largest first) until the
 * flex panels can fit at their minimum. minH floor applies to every
 * panel — a manually oversubscribed heightPct (sum > 100) gets
 * scaled down here rather than crashing the renderer.
 */
function distributeColumnHeights(panels, availH, isLastCol, minH, detailHeightPct) {
  const out = {};
  if (panels.length === 0) return out;

  // Collapsed placements get a hard 1-row reservation each. Their share
  // is subtracted from availH BEFORE detail/anchored/flex math so the
  // remaining height splits across the visible panels. detail can't be
  // collapsed (reducer guard), so this never overlaps the detail branch.
  let collapsedTotal = 0;
  for (const p of panels) {
    if (p.collapsed && p.type !== 'detail') {
      out[p.type] = 1;
      collapsedTotal += 1;
    }
  }
  const innerAvail = Math.max(minH, availH - collapsedTotal);

  let reserved = 0;
  let detailPanel = null;
  if (isLastCol) {
    detailPanel = panels.find(mpool.isDetailPane) || null;
    if (detailPanel) {
      reserved = Math.max(minH, Math.floor(innerAvail * detailHeightPct / 100));
    }
  }

  const anchored = [];   // { p, h }
  const flex = [];       // panel
  let anchoredTotal = 0;
  for (const p of panels) {
    if (p === detailPanel) continue;
    if (p.collapsed) continue;  // already 1-row-reserved above
    if (typeof p.heightPct === 'number' && isFinite(p.heightPct)) {
      const h = Math.max(minH, Math.floor(innerAvail * p.heightPct / 100));
      anchored.push({ p, h });
      anchoredTotal += h;
    } else {
      flex.push(p);
    }
  }

  // If anchored + reserved + (flex × minH) > innerAvail, scale anchored
  // proportionally to the share they each claimed. Each panel still
  // floors at minH — if every anchored is at minH and the column
  // still overflows the terminal, the renderer truncates rather than
  // crashes.
  const flexMin = flex.length * minH;
  if (reserved + anchoredTotal + flexMin > innerAvail && anchoredTotal > 0) {
    const target = Math.max(0, innerAvail - reserved - flexMin);
    const scale = target / anchoredTotal;
    let allocated = 0;
    for (const a of anchored) {
      a.h = Math.max(minH, Math.floor(a.h * scale));
      allocated += a.h;
    }
    // Distribute slack rows (caused by flooring) to the largest panels
    // first so the visual ratios stay close to the requested split.
    let leftover = target - allocated;
    if (leftover > 0) {
      const sorted = anchored.slice().sort((a, b) => b.h - a.h);
      let i = 0;
      while (leftover > 0) { sorted[i % sorted.length].h++; leftover--; i++; }
    }
    anchoredTotal = anchored.reduce((s, a) => s + a.h, 0);
  }

  // Flex panels share whatever's left.
  const flexTotalH = Math.max(0, innerAvail - reserved - anchoredTotal);
  if (flex.length) {
    const baseH = Math.floor(flexTotalH / flex.length);
    flex.forEach((p, i) => {
      const h = i === flex.length - 1 ? flexTotalH - baseH * (flex.length - 1) : baseH;
      out[p.type] = Math.max(minH, h);
    });
  }
  for (const { p, h } of anchored) out[p.type] = h;
  if (detailPanel) out[detailPanel.type] = reserved;

  // Park rounding-leftover rows on the column's last non-collapsed
  // panel so the column exactly fills availH (matches the pre-heightPct
  // behavior and avoids a visually empty strip at the bottom). Collapsed
  // panels are locked at 1 row — never grow them with slack.
  let sum = 0;
  for (const p of panels) sum += out[p.type];
  if (sum < availH) {
    let lastVisible = null;
    for (let i = panels.length - 1; i >= 0; i--) {
      if (!panels[i].collapsed) { lastVisible = panels[i]; break; }
    }
    if (lastVisible) out[lastVisible.type] += availH - sum;
  }
  return out;
}

// v0.6.3 P1.2 — module-local Layout publication. calcLayout assigns
// at end of each pass; getCurrentLayout() exposes the most-recent
// Layout to hit-test consumers (mouse, drag math) that today read
// layoutSlice.paneBounds. The boundsFor() shim in P1.3 fronts both
// sources; P1.4 stops the slice write and this becomes the sole
// channel. Null pre-first-render — fallback callers must guard.
//
// v0.6.3 P1.5 — the module-local _panelHeights map (was the prior
// home for per-panel column-share heights) is retired in favor of
// _currentLayout.rects. Inside calcLayout the heights are now a
// function-local intermediate; getPanelViewportH and renderNormal
// read rects via boundsFor / the calcLayout return value.
let _currentLayout = null;

/**
 * Inner viewport rows for a panel's CURRENTLY-RENDERED height, view-
 * mode aware. The on-screen panel in half/full view occupies the full
 * `availH = max(6, rows - 1)` rows; otherwise the panel uses its
 * column-share read via `boundsFor(panelType)`. Border + bottom
 * border = 2 rows are subtracted, so the return is the content-row
 * count.
 *
 * Single source of truth for any scroll / page / wheel math that
 * needs "how many rows of content fit in this panel right now".
 * `boundsFor` prefers `slice.paneBounds[type]` then falls through
 * to `_currentLayout.rects` (post-P1.5 — the legacy `_panelHeights`
 * module-local was retired). Reading the column-share directly from
 * scroll code is a bug class because it under-reports in half/full
 * view (see fix arc 2026-06-03 around the GPDATA scroll report).
 *
 * Pre-first-render (layout slice empty + no `_currentLayout` yet),
 * returns a 1-row fallback so callers don't divide-by-zero.
 */
function getPanelViewportH(paneId) {
  const layoutSlice = getInstanceSlice('layout');
  if (!layoutSlice) return 1;
  refreshSize();
  const availH = Math.max(6, rows() - 1);
  // Half/full view: the on-screen panel takes the full availH — beats
  // any stored height (paneBounds may carry a previous frame's bounds
  // across the viewMode-transition tick).
  const { viewMode, focus, halfLeftPanel } = layoutSlice;
  let visiblePanel = null;
  if (viewMode === 'half') {
    visiblePanel = instanceKind(focus) === 'detail' ? halfLeftPanel : focus;
  } else if (viewMode === 'full') {
    visiblePanel = focus;
  }
  // v0.6.4 Phase 3b — paneId-keyed. focus / halfLeftPanel / visiblePanel
  // are all paneIds (post-_withFocus), so compare the queried paneId
  // directly: if it's the on-screen pane, it owns the full availH. Under
  // multi-viewer this picks the SPECIFIC pane (not any same-kind one).
  if (visiblePanel && visiblePanel === paneId) return Math.max(1, availH - 2);
  // Off-screen / normal-view: the pane's actual bounds, keyed by paneId
  // (boundsFor → slice.paneBounds[paneId], falling through to
  // _currentLayout.rects when the slice is empty).
  const b = boundsFor(paneId);
  const h = (b && b.h) || 4;
  return Math.max(1, h - 2);
}

function calcLayout(model = getModel()) {
  refreshSize();
  const COLS = cols(), ROWS = rows();
  const layoutSlice = getInstanceSlice('layout');

  const columns = layoutSlice.arrange.columns || [];
  const ranges = mpool.distributeColumnWidths(layoutSlice.arrange, COLS);
  const lastIdx = columns.length - 1;
  // Only the footer is reserved at the bottom; panels fill everything
  // else. The yank register surfaces via the `"` popup, not an
  // always-on chrome strip (retired v0.6).
  const availH = Math.max(6, ROWS - 1);
  // Minimum panel height: 3 rows (border + 1 content line)
  const minH = 3;

  // v0.6.3 P1.5 — heights map is now function-local (was module-local
  // `_panelHeights`). Single use: build the Rect list below; nobody
  // else reads it.
  const heights = {};
  const detailHeightPct = layoutSlice.arrange.detailHeightPct;
  for (let ci = 0; ci < columns.length; ci++) {
    const colHeights = distributeColumnHeights(
      columns[ci].panels || [], availH, ci === lastIdx, minH, detailHeightPct);
    Object.assign(heights, colHeights);
  }
  // Ensure detail has a height even when the column traversal didn't
  // populate one (test fixtures without a placed detail panel).
  // Synthesizes the height map entry only — no rect is pushed for an
  // unplaced detail.
  if (!('detail' in heights)) {
    heights.detail = Math.max(minH, Math.floor(availH * detailHeightPct / 100));
  }

  // v0.6.3 P1.1 — build the Layout value. Each Rect carries the
  // column-view geometry for one placed pane (x, y, w, h, paneId,
  // type, collapsed). Computed by walking each column's panels and
  // accumulating y per the per-panel heights just distributed.
  //
  // `viewMode` reflects the active mode for completeness, but in
  // half/full the Rect list still describes the normal column layout
  // — renderHalf/Full override with their own single-panel bounds.
  // Unification of the rect list across view modes lands in P3
  // (composeRects).
  const rects = [];
  for (let ci = 0; ci < columns.length; ci++) {
    const r = ranges[ci];
    if (!r) continue;
    const colPanels = mpool.columnPanels(layoutSlice.arrange, ci);
    let y = 0;
    for (const p of colPanels) {
      const h = heights[p.type] || 0;
      rects.push({
        paneId: p.paneId,
        type: p.type,
        x: r.x, y, w: r.w, h,
        collapsed: !!p.collapsed,
      });
      y += h;
    }
  }

  // P1.5 — publish _currentLayout BEFORE the scroll-clamp loop so
  // getPanelViewportH (which reads via boundsFor → _currentLayout
  // when no slice fallback) sees this frame's rects, not the prior
  // frame's. Pre-P1.5 the loop read _panelHeights directly from the
  // module-local; the reorder is a no-op for the slice-write fallback
  // path but plugs the hole once that fallback retires.
  _currentLayout = {
    rects, availH,
    viewMode: layoutSlice.viewMode, cols: COLS, rows: ROWS,
  };

  // Keep each panel's scroll offset such that the selected item is in
  // view. syncPanelScroll → setScroll → a wrapped `set_scroll` Msg
  // to the owning navigator's update (single writer for nav.scroll).
  // The Msg-from-layout-pass pattern is documented per v0.5-layering.md
  // §5; the `set_scroll` arm is pure + identity-preserving so re-
  // renders don't ping-pong. Heights flow through getPanelViewportH —
  // the view-mode-aware single source of truth.
  for (const p of mpool.allPanesInColumns(layoutSlice.arrange)) {
    if (mpool.isDetailPane(p)) continue;
    if (p.collapsed) continue;  // no content rows to scroll-clamp against
    // v0.6.4 Phase 3b — viewport height by paneId; syncPanelScroll still
    // addresses the nav slice by panel-type (nav-keying is Phase 5).
    syncPanelScroll(p.type, getPanelViewportH(p.paneId));
  }

  return {
    ranges, availH,
    rects, viewMode: layoutSlice.viewMode, cols: COLS, rows: ROWS,
  };
}

/**
 * v0.6.3 P1.2 — read the most-recent Layout. Null before the first
 * calcLayout pass (test fixtures that seed `layoutSlice.paneBounds`
 * directly without a render pass get null here; boundsFor() in P1.3
 * handles the fallback). Treat as read-only; the renderer is the
 * single writer.
 */
function getCurrentLayout() {
  return _currentLayout;
}

/**
 * v0.6.3 P1.3 — single accessor for "the rect at <key>", where <key>
 * is a paneId, a panel type, or 'detail'. Bridges the two geometry
 * sources during the P1 migration:
 *
 *   1. `_currentLayout.rects` — the per-frame Rect list produced by
 *      calcLayout (P1.1). Preferred source.
 *   2. `layoutSlice.paneBounds[key]` — legacy slice write produced
 *      by renderNormal/Half/Full. Used as fallback when no Layout
 *      has been published yet (pre-first-render boot edge; tests
 *      that seed bounds without calling render).
 *
 * v0.6.3 P4.1 — tabBounds cache moved off layoutSlice.paneBounds.detail.tabs
 * onto the viewer's own slice. Hit-test consumers read it directly
 * via `getInstanceSlice(require('../panel/route').resolveTarget('viewer') || 'detail').tabBounds`; boundsFor() no longer
 * surfaces tabs.
 */
function boundsFor(key) {
  const layoutSlice = getInstanceSlice('layout');
  const sliceBounds = layoutSlice && layoutSlice.paneBounds && layoutSlice.paneBounds[key];
  // P1.3 priority: slice first. Both sources are written together
  // during the P1 migration (renderNormal still writes paneBounds);
  // tests seed slice.paneBounds directly. P1.4 stops the slice
  // writes — sliceBounds becomes null in production and the rect
  // path below takes over transparently. No caller change needed
  // at P1.4.
  if (sliceBounds) return sliceBounds;
  if (_currentLayout && _currentLayout.rects) {
    const rect = _currentLayout.rects.find(r => r.paneId === key || r.type === key);
    if (rect) return rect;
  }
  return null;
}

/** Bounds for a CURRENTLY-VISIBLE pane only — half/full view drops
 *  off-screen panes from layoutSlice.paneBounds, so callers that
 *  need "where the user can actually click this pane" want this
 *  variant. boundsFor() in contrast also reports normal-view
 *  geometry for off-screen panes (used by getPanelViewportH for
 *  scroll-viewport clamping). The split prevents half-mode click
 *  hit-tests from firing on a non-visible pane's phantom rect. */
function visibleBoundsFor(key) {
  const layoutSlice = getInstanceSlice('layout');
  return (layoutSlice && layoutSlice.paneBounds && layoutSlice.paneBounds[key]) || null;
}

// --- Render modes ---
// v0.6.3 P6 — single-Frame cache. Six module-locals (was prevRows,
// prevCols, forceFull, prevOverlayFlags, forceOverlayFull,
// lastOverlayId — split across two `let` blocks) collapse to one
// struct so the diff invariants (width/rowcount delta → force,
// overlay drop → force, etc) all live in one shape that can be
// reset atomically.
//
// prevRows holds the markup string written for each screen row so the
// next frame writes only rows that actually changed. clearScreen()
// every frame caused visible flash; lazygit/tcell avoid it by
// diffing — same trick the terminal overlay's session.prevFrame does
// (per-session cache, NOT folded into Frame here — different lifecycle).
//
// prevOverlayFlags tracks the overlay-flag set active on the previous
// frame. Used to detect close + transition (any flag dropping out →
// force full repaint to wipe the closed overlay's pixels). Pure-open
// transitions don't force — the new overlay paints cleanly on the
// existing frame.
const _frame = {
  prevRows:         [],
  prevCols:         0,
  forceFull:        true,
  prevOverlayFlags: new Set(),
  // PTY-overlay sub-state (session.prevFrame lives per session).
  forceOverlayFull: true,
  lastOverlayId:    null,
};

/**
 * v0.6.3 P2 — Rect contract enforcement.
 *
 * Normalize a panel render's raw string output to exactly `h` lines,
 * each `w` cells wide (visibleLen). Two modes:
 *
 *   - **Check mode** (`LAZYTUI_RENDER_CHECK=1`): debug-mode assert. A
 *     wrong line count OR an off-width line throws — the failing
 *     panel name and the offending line index are stamped in the
 *     error message so the underlying renderer bug is locatable.
 *   - **Release mode** (default): pad-and-fill. Short lines get
 *     trailing spaces to reach `w`; missing trailing lines are
 *     replaced with blank rows. Extra lines beyond `h` are dropped.
 *     The column-pad in renderNormal (6d9ad31) used to do this only
 *     at the column boundary; P2 lifts it to the per-panel boundary
 *     so a single panel's contract violation doesn't shift the rest
 *     of the column.
 *
 * Returns `string[]` of length `h`. _safeRender callers join with
 * `\n` to preserve the existing string-return API; the array shape
 * is the eventual P3 painter input.
 */
function _normalizeRender(panel, raw, w, h) {
  if (h <= 0) return [];
  if (raw === '' || raw == null) {
    return Array(h).fill(' '.repeat(w));
  }
  const lines = raw.split('\n');
  if (process.env.LAZYTUI_RENDER_CHECK === '1') {
    if (lines.length !== h) {
      throw new Error(
        `[rect-contract] ${panel && panel.type}: expected ${h} lines, got ${lines.length}`,
      );
    }
    for (let i = 0; i < lines.length; i++) {
      const vl = visibleLen(lines[i]);
      if (vl !== w) {
        throw new Error(
          `[rect-contract] ${panel && panel.type} line ${i}: visibleLen=${vl}, expected ${w}`,
        );
      }
    }
    return lines;
  }
  // Release: pad to (h × w). Truncation is left alone — visibleLen >
  // w means the panel overflowed and the column-pad already lets the
  // next column's content win; trimming markup-aware is non-trivial,
  // so prefer overshoot-as-is (matches pre-P2 behavior).
  const fixed = new Array(h);
  for (let i = 0; i < h; i++) {
    let line = lines[i] != null ? lines[i] : '';
    const vl = visibleLen(line);
    if (vl < w) line += ' '.repeat(w - vl);
    fixed[i] = line;
  }
  return fixed;
}

// T28 — isolate render() throws to the failing panel. Pre-fix every
// fn(panel, w, h) call was bare; a throw bubbled up through renderNormal/
// Half/Full and killed the entire frame, not just the one panel. Now:
// the throw is caught, logged to console.error + event-log (T11 channel,
// so post-mortem inspectable from a recorded session), and the panel
// renders as an h-line block (error marker on row 0, blanks below) so
// the rest of the layout keeps painting AND the panel's vertical slot
// is preserved. Same pattern as panel/api.js's update/key catches.
// Resolve panel.type → its Component's render fn + slice, then call.
// Inlines what was rendererFor() (a per-frame closure-allocating
// helper) — P5.7. Returns '' for unregistered types / missing
// render(); on throw, renders an error block (P2 — was a 1-line
// marker that shifted everything below it within the same column).
function _safeRender(panel, w, h, opts) {
  if (!panel) return '';
  const compName = getComponentOwningPanel(panel.type);
  if (!compName) return '';
  const comp = getComponent(compName);
  const def = comp && comp.panelTypes && comp.panelTypes[panel.type];
  if (!def || typeof def.render !== 'function') return '';
  let raw;
  try {
    // v0.6.3 P4.2b — pass opts (carries chrome spec from composeRects)
    // as a 5th arg. Existing panel renderers ignore unknown args; the
    // ones updated in this commit pass opts.chrome to renderPanel.
    raw = def.render(panel, w, h, getInstanceSlice(compName), opts);
  } catch (e) {
    console.error(`[render:${panel && panel.type}] ${e && e.message}`);
    try {
      require('../dispatch/event-log').record('error', {
        where: 'component_render', component: panel && panel.type,
        message: e && e.message, stack: e && e.stack,
      });
    } catch (_) {}
    // esc() the interpolated values — a thrown error whose message
    // contained a literal `[` would otherwise become embedded markup
    // and confuse the panel renderer's parser. The OUTER brackets
    // around "render error: …" must also be escaped — without `\[`
    // and `\]`, richToAnsi treats the whole thing as a tag, looks it
    // up in CODES (miss), and emits RESET, swallowing the message.
    //
    // v0.6.3 P2 — expand from one-line marker to h-line block. The
    // error message stays on row 0; rows 1..h-1 are blank-of-width-w
    // so the panel's vertical slot is preserved.
    const errLine = `[red]\\[render error: ${esc(String(panel && panel.type))} — ${esc(String(e && e.message))}\\][/]`;
    const blank = ' '.repeat(w);
    const rows = [errLine];
    for (let i = 1; i < h; i++) rows.push(blank);
    return rows.join('\n');
  }
  return _normalizeRender(panel, raw, w, h).join('\n');
}

/**
 * v0.6.3 P3.2 — bridge layout.rects → rects-with-lines for the
 * new painter. For each rect in `layout.rects`:
 *
 *   1. Locate the panel in `layoutSlice.arrange` by paneId or type.
 *   2. Render its content via `_safeRender` (or `_renderCollapsed`
 *      for collapsed panels).
 *   3. Apply chrome injection (collapse/close glyphs + tab
 *      trigger) — same regex-on-top-border post-mutation
 *      renderNormal does today (P4 retires this onto decor).
 *   4. Split the resulting string on `\n` into `lines: string[]`
 *      and attach to the rect.
 *
 * Returns a fresh `[{paneId, type, x, y, w, h, collapsed, lines}]`
 * array — input shape for `painter.composeRows`.
 *
 * Pure projection: reads model + layout + arrange, does NOT mutate
 * slice. Live since the P3.6 migration — called by the render pass
 * below (the old paintColumns path + the LAZYTUI_RECT_PAINTER gate
 * are retired). Module-internal; not exported.
 */
function composeRects(layout, model) {
  const layoutSlice = getInstanceSlice('layout');
  if (!layoutSlice || !layout || !layout.rects) return [];
  const freeConfigMode = !!(model && model.modes && model.modes.freeConfigMode);
  const dragging = !!(layoutSlice.freeConfig && layoutSlice.freeConfig.drag);
  // v0.6.3 P4.2 — chrome state computed structurally via chromeFor()
  // and threaded into the panel renderer via opts. Was post-mutated
  // string injection via injectTopRowChrome / injectTabTrigger; now
  // renderPanel({chrome}) composes glyphs inline.
  const { chromeFor } = require('./decor');
  let viewerTabCount = 0;
  try {
    const tabInfo = require('../panel/viewer/tabs').getTabInfo();
    viewerTabCount = tabInfo && Number.isFinite(tabInfo.total) ? tabInfo.total : 0;
  } catch (_) {}
  let triggerStateRaw = 'normal';
  try {
    triggerStateRaw = require('../overlay/tab-list')._triggerState();
  } catch (_) {}
  const tabTriggerState = triggerStateRaw === 'normal' ? 'available' : triggerStateRaw;
  // v0.6.3 D1 — pane-select trigger state, computed PER pane (target
  // shows 'open', siblings show 'disabled' during paneSelectMode).
  const paneSelectMode = !!(model.modes && model.modes.paneSelectMode);
  const paneSelectTargetPaneId = (layoutSlice.paneSelect && layoutSlice.paneSelect.targetPaneId) || null;
  // Hide the [≡] trigger when there's nothing useful to swap — i.e.
  // paneSelectItems returns only the `here` row (length < 2 means no
  // other placed pane AND no hidden entry to REPLACE with). Avoids
  // painting an affordance whose click would be a no-op. Computed
  // once per render — items length is invariant of targetPaneId.
  const paneSelectHasSwap = mpool.paneSelectItems(layoutSlice.arrange, null).length >= 2;
  const paneSelectTriggerStateFor = (paneId) => {
    if (paneSelectMode) return paneId === paneSelectTargetPaneId ? 'open' : 'disabled';
    if (!paneSelectHasSwap) return 'hidden';
    // Mirror tab-list: any chain mode disables peer triggers so the
    // user's open overlay can't be re-triggered out from under them.
    return require('../overlay/tab-list')._triggerState() === 'normal' ? 'available' : 'disabled';
  };

  // Index rects for quick lookup by either key. paneId is preferred
  // (multi-instance forward-compat per v0.6.1 Phase 7); type is the
  // fallback that still works under singleton-Components.
  const rectByPaneId = {};
  const rectByType = {};
  for (const rect of layout.rects) {
    if (rect.paneId) rectByPaneId[rect.paneId] = rect;
    if (rect.type)   rectByType[rect.type]   = rect;
  }
  const out = [];
  for (const panel of mpool.allPanesInColumns(layoutSlice.arrange)) {
    const rect = rectByPaneId[panel.paneId] || rectByType[panel.type];
    if (!rect) continue;
    const focused = mpane.paneMatchesFocus(panel, layoutSlice.focus);
    const chrome = chromeFor(panel, {
      freeConfigMode, dragging, focused, viewerTabCount, tabTriggerState,
      paneSelectTriggerState: paneSelectTriggerStateFor(panel.paneId),
    });
    const raw = panel.collapsed
      ? _renderCollapsed(panel, rect.w, chrome)
      : _safeRender(panel, rect.w, rect.h, { chrome });
    const lines = raw === '' ? [] : raw.split('\n');
    out.push({
      paneId: rect.paneId, type: rect.type,
      x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      collapsed: !!panel.collapsed,
      lines,
    });
  }
  return out;
}

// renderNormal/Half/Full populate `layoutSlice.paneBounds` directly —
// the renderer-as-writer pattern documented in the file header (§5
// view-derived data). Reset on every entry so stale entries from a
// prior view-mode aren't hit-testable.
//
// v0.6.3 P3.6 — these used to row-concatenate per-column strings via
// paintColumns; that implicit "every column emits availH rows"
// invariant was the v0.6.2 column-shift bug class (6d9ad31). The
// new path stamps absolute-positioned rects via painter.composeRows,
// making the class structurally impossible. paintColumns deletes
// in this commit along with the renderOne closure + the column-pad
// safety net (no longer needed — rect compositing handles gaps).
//
// Why pre-populate paneBounds before composeRects: viewer.detailTitle
// (viewer.js:1008) writes layoutSlice.paneBounds.detail.tabs DURING
// _safeRender — needs the detail entry to exist by the time the
// viewer's render fires. Same order the pre-P3 renderOne used (write
// bounds, then render).
function renderNormal(model) {
  const layout = calcLayout(model);
  const layoutSlice = getInstanceSlice('layout');
  layoutSlice.paneBounds = {};
  for (const rect of layout.rects) {
    const b = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    layoutSlice.paneBounds[rect.type] = b;
    if (rect.paneId) layoutSlice.paneBounds[rect.paneId] = b;
  }
  const rectsWithLines = composeRects(layout, model);
  const COLS = cols();
  const newRows = painter.composeRows(rectsWithLines, COLS, layout.availH);
  if (COLS !== _frame.prevCols || newRows.length !== _frame.prevRows.length) _frame.forceFull = true;
  _frame.prevCols = COLS;
  const { ansi, didFull } = painter.paintFrame(_frame.prevRows, newRows, _frame.forceFull);
  if (didFull) _frame.forceFull = false;
  if (ansi) stdout.write(ansi);
  _frame.prevRows = newRows;
  return didFull;
}

// renderHalf / renderFull — half/full view modes. Same v0.6.3 P3.6
// rect-painter migration as renderNormal: a 1- or 2-rect Layout for
// the on-screen panels, routed through painter.composeRows.
//
// Half view is "non-detail panel + detail" side-by-side. When focus
// is ON detail (e.g., after a tab-bar click or content-area click
// moves focus there), the left side falls back to slice.halfLeftPanel
// — the most recently focused non-detail panel. Stale-handle
// fallback: if halfLeftPanel was removed from the layout, pick the
// first non-detail panel; if none, just render detail on the left as
// a last resort.
function renderHalf(model) {
  calcLayout(model);
  const layoutSlice = getInstanceSlice('layout');
  const COLS = cols(), ROWS = rows();
  const halfW = Math.floor(COLS / 2);
  const availH = ROWS - 1;
  const focusedPanel = allPanels().find(p => mpane.paneMatchesFocus(p, layoutSlice.focus));
  if (!focusedPanel) return renderNormal(model);
  const detailPanel = mpool.findDetailPane(layoutSlice.arrange);
  let leftPanel = focusedPanel;
  if (mpool.isDetailPane(focusedPanel)) {
    const all = allPanels();
    leftPanel = all.find(p => mpane.paneMatchesFocus(p, layoutSlice.halfLeftPanel))
             || all.find(p => !mpool.isDetailPane(p))
             || focusedPanel;
  }
  layoutSlice.paneBounds = {};
  const leftBounds = { x: 0, y: 0, w: halfW, h: availH };
  layoutSlice.paneBounds[leftPanel.type] = leftBounds;
  if (leftPanel.paneId) layoutSlice.paneBounds[leftPanel.paneId] = leftBounds;
  const rightW = COLS - halfW;
  if (detailPanel) {
    const detailBounds = { x: halfW, y: 0, w: rightW, h: availH };
    layoutSlice.paneBounds.detail = detailBounds;
    if (detailPanel.paneId) layoutSlice.paneBounds[detailPanel.paneId] = detailBounds;
  }
  // v0.6.3 P4.2 — chrome computed via chromeFor + threaded through
  // renderPanel; half/full view paths don't need to inject post-render.
  const { chromeFor } = require('./decor');
  const freeConfigMode = !!(model.modes && model.modes.freeConfigMode);
  const dragging = !!(layoutSlice.freeConfig && layoutSlice.freeConfig.drag);
  let viewerTabCount = 0;
  try {
    const tabInfo = require('../panel/viewer/tabs').getTabInfo();
    viewerTabCount = tabInfo && Number.isFinite(tabInfo.total) ? tabInfo.total : 0;
  } catch (_) {}
  let triggerStateRaw = 'normal';
  try {
    triggerStateRaw = require('../overlay/tab-list')._triggerState();
  } catch (_) {}
  const tabTriggerState = triggerStateRaw === 'normal' ? 'available' : triggerStateRaw;
  // v0.6.3 D1 — half view also threads paneSelect state; only the left
  // pane is non-detail (detail is always rightmost), so it's the only
  // candidate for the pane-select trigger.
  const halfPaneSelectMode = !!(model.modes && model.modes.paneSelectMode);
  const halfPaneSelectTargetPaneId =
    (layoutSlice.paneSelect && layoutSlice.paneSelect.targetPaneId) || null;
  // Same hide-when-nothing-to-swap rule as renderNormal — half view
  // shows one non-detail pane + detail; hide the trigger when there's
  // nothing in the underlying arrange to swap to.
  const halfPaneSelectHasSwap = mpool.paneSelectItems(layoutSlice.arrange, null).length >= 2;
  const halfPaneSelectStateFor = (paneId) => {
    if (halfPaneSelectMode) return paneId === halfPaneSelectTargetPaneId ? 'open' : 'disabled';
    if (!halfPaneSelectHasSwap) return 'hidden';
    return 'available';
  };
  const leftChrome = chromeFor(leftPanel, {
    freeConfigMode, dragging,
    focused: mpane.paneMatchesFocus(leftPanel, layoutSlice.focus),
    viewerTabCount, tabTriggerState,
    paneSelectTriggerState: halfPaneSelectStateFor(leftPanel.paneId),
  });
  const detailChrome = detailPanel ? chromeFor(detailPanel, {
    freeConfigMode, dragging,
    focused: mpane.paneMatchesFocus(detailPanel, layoutSlice.focus),
    viewerTabCount, tabTriggerState,
  }) : null;
  let leftContent = _safeRender(leftPanel, halfW, availH, { chrome: leftChrome });
  let rightContent = detailPanel ? _safeRender(detailPanel, rightW, availH, { chrome: detailChrome }) : '';
  const rects = [
    { x: 0, y: 0, w: halfW, h: availH,
      lines: leftContent === '' ? [] : leftContent.split('\n') },
  ];
  if (detailPanel) {
    rects.push({
      x: halfW, y: 0, w: rightW, h: availH,
      lines: rightContent === '' ? [] : rightContent.split('\n'),
    });
  }
  const newRows = painter.composeRows(rects, COLS, availH);
  if (COLS !== _frame.prevCols || newRows.length !== _frame.prevRows.length) _frame.forceFull = true;
  _frame.prevCols = COLS;
  const { ansi, didFull } = painter.paintFrame(_frame.prevRows, newRows, _frame.forceFull);
  if (didFull) _frame.forceFull = false;
  if (ansi) stdout.write(ansi);
  _frame.prevRows = newRows;
  return didFull;
}

function renderFull(model) {
  calcLayout(model);
  const layoutSlice = getInstanceSlice('layout');
  const COLS = cols(), ROWS = rows();
  const availH = ROWS - 1;
  const focusedPanel = allPanels().find(p => mpane.paneMatchesFocus(p, layoutSlice.focus));
  if (!focusedPanel) return renderNormal(model);
  layoutSlice.paneBounds = {};
  const fullBounds = { x: 0, y: 0, w: COLS, h: availH };
  layoutSlice.paneBounds[focusedPanel.type] = fullBounds;
  if (focusedPanel.paneId) layoutSlice.paneBounds[focusedPanel.paneId] = fullBounds;
  // v0.6.3 P4.2 — chrome computed via chromeFor; full view also routes
  // [≡] through renderPanel inline when the focused panel is detail.
  const { chromeFor: chromeForFull } = require('./decor');
  const freeConfigModeF = !!(model.modes && model.modes.freeConfigMode);
  const draggingF = !!(layoutSlice.freeConfig && layoutSlice.freeConfig.drag);
  let viewerTabCountF = 0;
  try {
    const tabInfo = require('../panel/viewer/tabs').getTabInfo();
    viewerTabCountF = tabInfo && Number.isFinite(tabInfo.total) ? tabInfo.total : 0;
  } catch (_) {}
  let triggerStateRawF = 'normal';
  try {
    triggerStateRawF = require('../overlay/tab-list')._triggerState();
  } catch (_) {}
  // v0.6.3 D1 — full view threads paneSelect state for the focused pane
  // (only one pane is visible at full zoom; only relevant when it's
  // non-detail).
  const fullPaneSelectMode = !!(model.modes && model.modes.paneSelectMode);
  const fullPaneSelectTargetPaneId =
    (layoutSlice.paneSelect && layoutSlice.paneSelect.targetPaneId) || null;
  // Same hide-when-nothing-to-swap rule. Full view only paints the
  // focused pane; the trigger sits on it (non-detail only).
  const fullPaneSelectHasSwap = mpool.paneSelectItems(layoutSlice.arrange, null).length >= 2;
  const fullPaneSelectState = fullPaneSelectMode
    ? (focusedPanel.paneId === fullPaneSelectTargetPaneId ? 'open' : 'disabled')
    : (fullPaneSelectHasSwap ? 'available' : 'hidden');
  const fullChrome = chromeForFull(focusedPanel, {
    freeConfigMode: freeConfigModeF, dragging: draggingF,
    focused: true,
    viewerTabCount: viewerTabCountF,
    tabTriggerState: triggerStateRawF === 'normal' ? 'available' : triggerStateRawF,
    paneSelectTriggerState: fullPaneSelectState,
  });
  let content = _safeRender(focusedPanel, COLS, availH, { chrome: fullChrome });
  const rects = [
    { x: 0, y: 0, w: COLS, h: availH,
      lines: content === '' ? [] : content.split('\n') },
  ];
  const newRows = painter.composeRows(rects, COLS, availH);
  if (COLS !== _frame.prevCols || newRows.length !== _frame.prevRows.length) _frame.forceFull = true;
  _frame.prevCols = COLS;
  const { ansi, didFull } = painter.paintFrame(_frame.prevRows, newRows, _frame.forceFull);
  if (didFull) _frame.forceFull = false;
  if (ansi) stdout.write(ansi);
  _frame.prevRows = newRows;
  return didFull;
}


function renderTerminalOverlay(model = getModel()) {
  if (!isTerminalTab()) return;
  const id = activeTerminalId();
  const termConf = activeTerminalConfig();
  if (!id || !termConf) return;

  const layoutSlice = getInstanceSlice('layout');
  // v0.6.4 Phase 3 — position the terminal overlay against the FOCUSED
  // viewer's bounds (paneId-keyed), not the type-collided 'detail' key.
  const bounds = layoutSlice && layoutSlice.paneBounds[require('../panel/route').resolveTarget('viewer') || 'detail'];
  if (!bounds) return;
  const innerW = bounds.w - 2;
  const innerH = bounds.h - 2;

  // Lazy-create session on first render
  const session = ensureSession(id, termConf.cmd, innerW, innerH);

  // Resize if dimensions changed (also invalidates diff cache). Skipped
  // during a drag preview: the bounds here are preview-shifted (detail's
  // y/h follow the would-be-after-release arrangement), but the user
  // hasn't committed the layout change yet. Resizing the PTY child on
  // every zone crossing would fire SIGWINCH repeatedly and churn the
  // child's rendering. Pixels still paint at preview coords (the screen
  // matches), but the session keeps its committed dimensions until
  // release. Bottom rows of a taller-preview detail show as blank;
  // a shorter-preview detail clips the bottom of the xterm buffer
  // visually but the layout's borders cover the overflow. After
  // release/cancel the next render fires a single resize to the real
  // (committed) detail size.
  const isDragPreview = !!(layoutSlice && layoutSlice.freeConfig && layoutSlice.freeConfig.drag && layoutSlice.freeConfig.drag.previewArrange);
  if (!isDragPreview && (session.xterm.cols !== innerW || session.xterm.rows !== innerH)) {
    resizeSession(id, innerW, innerH);
    _frame.forceOverlayFull = true;
  }
  // Switching to a different session — force full redraw
  if (id !== _frame.lastOverlayId) {
    _frame.forceOverlayFull = true;
    _frame.lastOverlayId = id;
  }

  // Diff-based render: only rewrite rows whose content changed since the
  // previous overlay write. trimRight=false + pad so shorter lines fully
  // overwrite prior content within the changed row.
  const buffer = session.xterm.buffer.active;
  if (!session.prevFrame) session.prevFrame = [];
  const force = _frame.forceOverlayFull;
  _frame.forceOverlayFull = false;

  let out = '';
  for (let row = 0; row < innerH; row++) {
    const line = buffer.getLine(row + buffer.viewportY);
    let text = line ? line.translateToString(false, 0, innerW) : '';
    if (text.length < innerW) text += ' '.repeat(innerW - text.length);
    if (!force && session.prevFrame[row] === text) continue;
    out += `\x1b[${bounds.y + row + 2};${bounds.x + 2}H${text}${RESET}`;
    session.prevFrame[row] = text;
  }

  // Show exit prompt if process died (overlay on bottom content row).
  // v0.6.3 P5.1 — the setImmediate terminal_exit dispatch that used to
  // live here retired in favor of an event-driven dispatch from
  // pty-lifecycle.handleExit (event-source = PTY's onExit, not render
  // poll). One fewer render-side reducer dispatch.
  if (session.exited) {
    const msg = ` Process exited: ${session.exitCode} — Enter restart, x close `;
    const text = msg.length > innerW ? msg.slice(0, innerW) : msg;
    const padding = Math.max(0, Math.floor((innerW - text.length) / 2));
    out += `\x1b[${bounds.y + innerH + 1};${bounds.x + 2 + padding}H\x1b[7m${text}\x1b[0m`;
  }

  // Position screen cursor at PTY cursor when in terminal mode.
  // Visibility (show/hide) is derived once at the end of render() from
  // model.modes.terminalMode || model.modes.cmdMode.
  if (model.modes.terminalMode && !session.exited) {
    const cx = bounds.x + 2 + buffer.cursorX;
    const cy = bounds.y + 2 + buffer.cursorY;
    out += `\x1b[${cy};${cx}H`;
  }
  stdout.write(out);
}

function render(model = getModel()) {
  // `model` is the TEA root model (js/app/runtime.js), threaded in by the
  // owner (the program). The view reads migrated slices (currently
  // `viewMode`) from this param, not a global fetch. The `= getModel()`
  // default keeps every existing `render()` call site working during
  // the v0.5 migration; it'll be removed once all callers thread it.
  // Force-full-repaint when any overlay drops out — close OR transition.
  // Pure opens (no overlay → some overlay) don't trigger: the new overlay
  // paints cleanly on top of the still-valid frame, no flash. A transition
  // overlay-A → overlay-B drops A AND adds B in the same dispatch cycle;
  // the old logic only caught "all overlays gone", so A's pixels lingered
  // beneath B (visible as e.g. cmdline residue under the free-config footer
  // when :free-config typed from cmdMode). Computing the active-overlay
  // SET (not just a single bool) catches every drop including nested
  // closes (A,B → A) and same-cycle swaps.
  const md = model.modes;
  const curOverlayFlags = new Set();
  for (const m of modes.MODES) if (m.overlay && md[m.flag]) curOverlayFlags.add(m.flag);
  for (const flag of _frame.prevOverlayFlags) {
    if (!curOverlayFlags.has(flag)) { _frame.forceFull = true; break; }
  }
  _frame.prevOverlayFlags = curOverlayFlags;

  let mainDidFull;
  // viewMode lives on the layout Component slice (Phase 1b).
  const layoutSlice = getInstanceSlice('layout') || { viewMode: 'normal' };
  // Drag preview: during an active drag with a valid target, swap
  // slice.arrange for the would-be-after-release arrange so the user
  // sees the actual outcome rather than an insertion-bar hint. The swap
  // stays in place through renderTerminalOverlay too — that overlay
  // reads paneBounds.detail to position the xterm session, and the
  // screen shows detail at preview coords, so the terminal must paint
  // at preview coords to match. After that we restore both arrange AND
  // paneBounds: the viewport dispatch + the next mouse hit-test read
  // original-layout bounds, which keeps drop-target detection stable
  // when the cursor sits near a zone boundary (preview-derived bounds
  // would feed back into the next hit-test and ping-pong the layout
  // under tiny cursor wobbles).
  const drag = layoutSlice.freeConfig && layoutSlice.freeConfig.drag;
  const previewArrange = drag && drag.previewArrange;
  let savedArrange = null, savedBounds = null;
  if (previewArrange) {
    savedArrange = layoutSlice.arrange;
    savedBounds = layoutSlice.paneBounds;
    layoutSlice.arrange = previewArrange;
  }
  const viewMode = layoutSlice.viewMode;
  try {
    if (viewMode === 'half') mainDidFull = renderHalf(model);
    else if (viewMode === 'full') mainDidFull = renderFull(model);
    else mainDidFull = renderNormal(model);
    // Only force the terminal-overlay repaint when main paint actually
    // cleared the screen (resize, overlay-close, first frame). In the
    // steady state main paint is diff-based and leaves the PTY region
    // untouched, so the overlay's own diff cache is enough.
    if (mainDidFull) _frame.forceOverlayFull = true;
    renderTerminalOverlay(model);
  } finally {
    // Restore the canonical slice unconditionally — _safeRender wraps
    // per-panel throws but renderTerminalOverlay + the inner dispatches
    // (syncPanelScroll → set_scroll) can throw past it. Without
    // try/finally the preview arrange would persist in the live slice
    // and every subsequent reducer write would build on top of it.
    //
    // v0.6.3 Phase D5 retired most render-side in-place writes in
    // favor of `setInstanceSlice` (immutable spread). This pair is
    // the surviving exception: it's a save/swap/restore around a
    // single render call. Routing the restore through setInstanceSlice
    // would emit a new model snapshot mid-render and trip the
    // reactivity boundary (next frame would observe two diffs for
    // one paint). Save the canonical refs above, paint with the
    // preview, restore the refs here — no observer sees the swap.
    if (previewArrange) {
      layoutSlice.arrange = savedArrange;
      layoutSlice.paneBounds = savedBounds;
    }
  }
  // Cache the detail panel's effective viewport on the viewer's own
  // slice so viewer.update can clamp scroll/cursor without reading
  // layout's render-time geometry across slices. Blessed render-side
  // write — same documented exception as paneBounds (frame-derived,
  // pure function of layout). Uses the original (non-preview) bounds:
  // the viewer's actual state hasn't committed to the drag yet, so its
  // viewport tracks the real layout. R4.9: direct setInstanceSlice
  // instead of a wrapped viewer_set_viewport Msg + 5-line reducer arm
  // — the Msg's only effect was this single-field write.
  const route = require('../panel/route');
  const viewerTab = route.resolveTarget('viewer');
  const viewerBounds = viewerTab && layoutSlice.paneBounds && layoutSlice.paneBounds[viewerTab];
  if (viewerBounds) {
    const innerH = Math.max(0, viewerBounds.h - 2);
    const viewerSlice = getInstanceSlice(viewerTab);
    if (viewerSlice && viewerSlice.innerH !== innerH) {
      route.setInstanceSlice(viewerTab, { ...viewerSlice, innerH });
    }
  }
  renderFooter(model);
  // Panel-chrome glyphs (`[_]`/`[+]` collapse, `[X]` close in free-config,
  // `[≡]` tab trigger) are composed INLINE in the panel's top border
  // by renderPanel({chrome}) — v0.6.3 P4.2 retired the post-render
  // regex injection (injectTopRowChrome / injectTabTrigger). The
  // painter stamps the row with the glyphs already in place, so no
  // second write and no cursor-move-back-and-overpaint flicker.
  // Overlays are mutually exclusive in practice (modeChain enforces it).
  // Order matches dispatch.js's modeChain: free-config > menu > copy.
  if (md.copyMode)    renderCopyMenu();
  if (md.menuOpen)    renderMenu();
  if (md.freeConfigMode)  { renderPanelListOverlay(); }
  if (md.cmdMode)     renderCmdline();
  if (md.confirmMode) renderConfirmOverlay();
  if (md.promptMode)  renderPromptOverlay();
  if (md.registerPopupMode) renderRegisterPopup();
  if (md.prefixMode)  renderWhichKey();
  // Tab list overlay (only when active). The `[≡]` trigger glyph is
  // composed inline by renderPanel({chrome}) per P4.2; the painter
  // stamps it atomically alongside the rest of the top border.
  if (md.tabListMode) renderTabList();
  if (md.paneSelectMode) require('../overlay/pane-select').render();
  if (md.jobsMode)    renderJobsOverlay();

  // Cursor visibility — derived from mode state, single emission site.
  // Cursor *position* is set inline by renderTerminalOverlay (when in
  // terminal mode), renderCmdline (cursor at typed-text end), and
  // renderPromptOverlay (cursor inside the prompt's input row); here
  // we only flip whether it's visible. Eliminates the bug class where
  // a mode forgets to call hideCursor() / showCursor() on exit.
  if (md.terminalMode || md.cmdMode || md.promptMode) showCursor();
  else hideCursor();
}

/**
 * Refresh the focused panel's info into detail, then render. The previous
 * pattern was render(); refresh-info; render(); — two paints with an
 * info-update sandwiched. The viewer_show_info Msg writes the detail
 * slice's `lines`, so the leading render painted stale info. redraw()
 * collapses to a single paint with up-to-date info.
 */
function redraw() {
  // v0.6.1 Phase 6 — resolveTarget picks the destination viewer; null
  // result (no viewer registered) just skips the info refresh and paints.
  const target = require('../panel/route').resolveTarget('viewer');
  if (target) dispatchMsg(wrap(target, { type: 'viewer_show_info' }));
  render();
}

// Debouncing primitives live in render-queue.js (both terminal.js and
// actions.js need scheduleOverlay / scheduleRender; render-queue.js has no
// dependencies, breaking what would otherwise be a cycle through layout).
require('./render-queue').setRenderers({ render, overlay: renderTerminalOverlay });

/**
 * Build the keys-string for the footer's left half. Modal footers
 * (terminal / filter / copy / free-config / menu) own the message; the
 * standard non-modal footer is built from segments. Returns the
 * leading-space-prefixed concatenation ready for assembly.
 */
function footerKeys(model) {
  const md = model.modes;
  if (md.prefixMode) {
    const pending = (model.prefixSeq && model.prefixSeq.length)
      ? ' ' + model.prefixSeq.join(' ')
      : '';
    return ` \\[leader]${esc(pending)}… | <key> select | Esc cancel`;
  }
  if (md.terminalMode) {
    const tconf = activeTerminalConfig();
    const label = tconf ? tconf.label : 'terminal';
    return ` \\[terminal: ${esc(label)}] | Ctrl+\\ return to TUI`;
  }
  if (md.detailSearchMode) {
    const ds = require('../panel/viewer/search');
    const term = ds.typingText();
    const search = getInstanceSlice(require('../panel/route').resolveTarget('viewer') || 'detail')?.search || { matches: [], idx: 0 };
    const n = (search.matches || []).length;
    const idx = n ? search.idx + 1 : 0;
    return ` /${esc(term)}│ \\[${idx}/${n}] | ↑↓ step | Esc cancel | Enter commit`;
  }
  if (md.filterMode) return ` /${esc(filterCurrentText())}│ | Esc clear | Enter ok`;
  if (md.copyMode)   return ' ↑↓ select | Esc cancel | Enter copy';
  if (md.freeConfigTitleEditMode) {
    const { titleEditText } = require('../panel/free-config-view');
    return ` rename: ${esc(titleEditText())}│ | Esc cancel | Enter ok`;
  }
  if (md.freeConfigMode) {
    const layoutSlice = getInstanceSlice('layout');
    const dirty = (layoutSlice && layoutSlice.dirty) ? ' | [yellow]• unsaved (:save-layout)[/]' : '';
    return ` Free Config | drag/resize | J/K reorder | ←→ swap col | +/- col/detail · [/] panel h | space collapse | t rename | w panel list | u undo | C-r redo | :save-layout | q exit${getFreeConfigFooter()}${dirty}`;
  }
  if (md.menuOpen)   return ' ↑↓ select | Esc close | Enter run';

  // Hoist the resolver once — each instanceKind() can walk arrange for
  // docker-style focus. Was called 3× sequentially below.
  const focusKind = instanceKind(getFocus());
  if (focusKind === 'detail') {
    const { total } = getTabInfo();
    const segs = ['←→ panel'];
    if (total > 1) segs.push(']\\[ tabs');
    segs.push('+/_ view');
    if (isTerminalTab()) {
      const id = activeTerminalId();
      const dead = id && getSession(id) && getSession(id).exited;
      // x closes a dead ephemeral terminal (otherwise it opens the menu).
      const xLabel = dead && findEphemeralByid(id) ? 'x close' : 'x menu';
      segs.push(xLabel, 'q quit', dead ? 'Enter restart' : 'Enter activate');
    } else {
      segs.push('x menu', 'q quit');
      segs.push('/ search');
      const search = getInstanceSlice(require('../panel/route').resolveTarget('viewer') || 'detail')?.search;
      if (search && search.active) {
        const n = search.matches.length;
        const idx = search.idx + 1;
        segs.push(`n/N [${idx}/${n}]`, 'Esc clear');
      }
    }
    return ' ' + segs.join(' | ');
  }
  if (focusKind === 'actions') {
    return ' ↑↓ select | ←→ panel | / filter | +/_ view | x menu | q quit | Enter run';
  }
  if (focusKind === 'groups') {
    return ' ↑↓ select | ←→ panel | / filter | +/_ view | x menu | q quit | Enter actions';
  }
  return ' ↑↓ select | ←→ panel | / filter | +/_ view | x menu | q quit';
}

function renderFooter(model = getModel()) {
  // cmdline mode replaces the footer with its own prompt — drawing the
  // footer first would flicker on every keystroke as renderCmdline() then
  // overwrites it.
  if (model.modes.cmdMode) return;
  const COLS = cols(), ROWS = rows();
  const inModal = modes.isModal();
  const layoutSlice = getInstanceSlice('layout') || { viewMode: 'normal', dirty: false };

  // Left side: mode message OR (panel hints + plugin keyHints +
  // multi-select indicator + footer:left decorator). Modal footers
  // own the row — no plugin contributions appended.
  // Hoist focus + def once — used here and again at the list-select tag
  // below. Each getPanelDef() can walk arrange for docker-style focus.
  const focus = getFocus();
  const focusDef = getPanelDef(focus);
  let keys = footerKeys(model);
  if (!inModal) {
    if (focusDef && focusDef.keyHints) keys += ` | ${esc(focusDef.keyHints)}`;
    const msCount = multiSelCount(focus);
    if (msCount > 0) keys += ` | ${esc(`[${msCount} sel]`)}`;
    // Surface layout-dirty state to non-modal users too. They might
    // have left free-config mode with pending changes; the indicator
    // reminds them `:save-layout` exists. Free-config footer adds
    // its own dirty marker in footerKeys() to keep modal layout
    // self-contained.
    if (layoutSlice.dirty) keys += ` | [yellow]• unsaved (:save-layout)[/]`;
  }

  // Component footer contributions (Phase 5 — viewContributions slots
  // `footerLeft` / `footerRight`). Suppressed in modal footers (the
  // message owns the row). Note the separator is the heavy pipe `│`,
  // distinguishing contributor output from the regular `|`-separated
  // key hints. Each contributor receives its own Component slice as the
  // first arg + this `ctx` as the second.
  let footerLeftExtra = '', footerRightExtra = '';
  if (!inModal) {
    const ctxBase = { focus: getFocus(), view: layoutSlice.viewMode };
    const halfBudget = Math.max(0, Math.floor(COLS / 2) - 4);
    footerLeftExtra  = collectViewContributions('footerLeft',  { ...ctxBase, width: halfBudget });
    footerRightExtra = collectViewContributions('footerRight', { ...ctxBase, width: halfBudget });
    if (footerLeftExtra) keys += ` │ ${footerLeftExtra}`;
  }

  // Layout notice — a transient hint set by layout.update when a free-
  // config / view-mode transition is refused (kind: 'error', red) OR a
  // successful column-edit action (kind: 'info', green). noticeKind
  // defaults to 'error' when omitted so legacy refusal sites keep their
  // red color without explicit annotation. Cleared by layout.update on
  // the next state change that resolves the block.
  const layoutNotice = layoutSlice.freeConfig && layoutSlice.freeConfig.notice;
  if (layoutNotice) {
    const kind = (layoutSlice.freeConfig && layoutSlice.freeConfig.noticeKind) || 'error';
    const color = kind === 'info' ? 'bold green' : 'bold red';
    keys += ` | [${color}]${esc(layoutNotice)}[/]`;
  }

  // Boot warnings — soft diagnostics surfaced by parse (today: column
  // over soft cap). Yellow so it reads as advisory, not an error.
  // Cleared by `:dismiss-warnings` or next config reload.
  const bw = layoutSlice.bootWarnings;
  if (bw && bw.length > 0) {
    keys += ` | [yellow]⚠ ${bw.length} config warning(s) (:dismiss-warnings)[/]`;
  }

  // Right tail: footer:right + visual-select tag + view-mode tag.
  // The visual-select tag (`[v-char]` / `[v-line]`) is a precursor to
  // the configurable status-bar segments planned for v0.5/v0.6 — when
  // that lands, this becomes one of several registered widgets, but
  // for now it's hardcoded next to the existing [half]/[full] tag.
  const rightTail = footerRightExtra ? `${footerRightExtra} │ ` : '';
  // List-select tag only when the armed mode actually applies — i.e.
  // focus is on a list panel. (The flag can stay armed while focus is
  // on a non-list panel, where space falls back to the leader.)
  // focusDef hoisted at the top of this function.
  const selectActive = model.modes.listSelectMode && focusDef && typeof focusDef.getItems === 'function';
  const sel = getInstanceSlice(require('../panel/route').resolveTarget('viewer') || 'detail')?.select;
  const selectTag = (sel && sel.active)
    ? ` \\[${sel.kind === 'line' ? 'v-line' : 'v-char'}]`
    : (selectActive ? ' \\[select]' : '');
  const vm = layoutSlice.viewMode;
  const modeTag = vm !== 'normal' ? ` \\[${vm}]` : '';

  // Pad left → right tail → tags, using visible width math (esc'd
  // [ characters and double-width chars must not throw the alignment).
  // Truncate `keys` first when the combined visible length would
  // overflow the terminal width — otherwise the footer wraps onto a
  // new row, scrolls the screen up, and looks like the entire frame
  // is shrinking each render. Surfaced under v0.6 free-config when
  // the free-config footer + pool-drag status string grew past common
  // terminal widths.
  const tailLen = visibleLen(rightTail) + visibleLen(selectTag) + visibleLen(modeTag);
  const maxKeysLen = Math.max(0, COLS - tailLen);
  if (visibleLen(keys) > maxKeysLen) keys = truncate(keys, maxKeysLen);
  const visLen = visibleLen(keys) + tailLen;
  const padding = ' '.repeat(Math.max(0, COLS - visLen));
  // wrapColor() reopens the footer color after any nested `[/]` in
  // `keys` (layout notice, dirty marker, boot-warning chip), so the
  // trailing padding + tags stay in footer color instead of dropping
  // to terminal default. Same `[/]`-is-hard-reset class of bug as
  // renderPanel's title fix.
  const footerMarkup = wrapColor(theme().footer,
    `${keys}${padding}${rightTail}${selectTag}${modeTag}`);
  stdout.write(`\x1b[${ROWS};1H` + richToAnsi(footerMarkup) + RESET);
}

/**
 * Invalidate the per-row diff cache so the next render() does a
 * full-screen clear + repaint. Used after the terminal has been
 * touched by something outside our control: a suspended shell
 * (SIGCONT path), an external subprocess, a docker compose spawn
 * that returned.
 */
function forceFullRepaint() {
  _frame.prevRows = [];
  _frame.forceFull = true;
}

/**
 * Invalidate the diff cache for a specific row range (0-based, half-open
 * — [startY, endY)). Used when an overlay shrinks and the cells it
 * previously covered need to be repainted from the underlying panels
 * on the next render. Cheaper than a full repaint when only a few rows
 * are affected.
 */
function invalidateRows(startY, endY) {
  for (let y = startY; y < endY; y++) {
    if (y >= 0 && _frame.prevRows[y] !== undefined) {
      _frame.prevRows[y] = '';
    }
  }
}

module.exports = {
  calcLayout, render, redraw, renderFooter, renderTerminalOverlay,
  forceFullRepaint, invalidateRows,
  getPanelViewportH,
  // v0.6.3 P1.2 — most-recent Layout. Null pre-first-render. Will
  // become the sole hit-test channel after P1.4 stops the
  // layoutSlice.paneBounds writes.
  getCurrentLayout,
  // v0.6.3 P1.3 — single accessor that consumers use to read pane
  // bounds. Returns from _currentLayout when present, falls back to
  // layoutSlice.paneBounds[key] otherwise. Merges the viewer's tabs
  // cache (slice.paneBounds.detail.tabs, N3 — moves onto viewer's
  // slice in P4) onto the returned rect.
  boundsFor, visibleBoundsFor,
  // Test seam: distributeColumnHeights is a pure function that returns
  // a { [type]: rows } map. Exposed so collapsed-honor + heightPct
  // math can be unit-tested without bringing up the whole runtime.
  _distributeColumnHeights: distributeColumnHeights,
  // v0.6.3 P2 test seam: _normalizeRender enforces the Rect contract
  // (exactly h lines of width w). Exposed so test-rect-contract.js
  // can exercise both check mode (env LAZYTUI_RENDER_CHECK=1 → throws
  // on violation) and release mode (pads to h × w).
  _normalizeRender,
  // Test seam: a {[type]: rows} map derived from _currentLayout.rects
  // (the column-share heights calcLayout last produced). NOT for
  // production use — production callers go through
  // `getPanelViewportH(type)` which is view-mode-aware. Exists so
  // tests can assert calcLayout's column distribution math directly.
  //
  // v0.6.3 P1.5 — was a copy of the now-retired _panelHeights module-
  // local; rebuilt per-call from rects to preserve the same shape.
  _getPanelHeights: () => {
    if (!_currentLayout || !_currentLayout.rects) return {};
    const m = {};
    for (const r of _currentLayout.rects) m[r.type] = r.h;
    return m;
  },
};
