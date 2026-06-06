/**
 * Layout calculation and view mode rendering.
 *
 * Geometry as view-derived data (docs/v0.5-layering.md §5). Two
 * sources during the v0.6.3 P1 migration:
 *
 *   - `layoutSlice.panelBounds` — legacy per-panel `{x,y,w,h}` map
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
 * `panelBounds.detail.tabs` (the tab-bar hit-test cache, viewer.js
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
const { theme } = require('./themes');
const { truncate } = require('./panel');
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
const { getFreeConfigFooter } = require('./free-config-view');
const { injectTopRowChrome } = require('./panel-widgets');
const { renderPanelListOverlay } = require('../overlay/panel-list');
const { renderTabList, injectTabTrigger } = require('../overlay/tab-list');
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
function _renderCollapsed(p, w) {
  const t = theme();
  const layoutSlice = getInstanceSlice('layout');
  const focused = layoutSlice && layoutSlice.focus === p.type;
  const fc = focused ? t.focus : t.dim;
  const innerW = Math.max(0, w - 2);
  let titleText = '';
  if (p.hotkey) titleText += `(${p.hotkey})`;
  if (p.title)  titleText += `─${p.title}`;
  // Markup-aware truncation — same trap as renderPanel: a length-based
  // slice can cut mid-tag and let the next `[…]` match swallow the fill
  // and right corner. truncate() is a no-op when visibleLen fits.
  titleText = truncate(titleText, innerW - 2);
  const fill = innerW - visibleLen(titleText);
  // wrapColor() reopens fc after any nested `[/]` in titleText so
  // the trailing fill + corner stay in border color — same fix as
  // renderPanel's top border for the collapsed 1-row chrome bar.
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
// layoutSlice.panelBounds. The boundsFor() shim in P1.3 fronts both
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
 * column-share (`panelHeights[type]`). Border + bottom border = 2
 * rows are subtracted, so the return is the content-row count.
 *
 * Single source of truth for any scroll / page / wheel math that
 * needs "how many rows of content fit in this panel right now". The
 * `slice.panelHeights[type]` map is INTERNAL to the renderer's
 * normal-view column distribution — reading it directly from scroll
 * code is a bug class because it under-reports in half/full view
 * (see fix arc 2026-06-03 around the GPDATA scroll report).
 *
 * Pre-first-render (panelHeights empty), returns a 1-row fallback so
 * callers don't divide-by-zero.
 */
function getPanelViewportH(panelType) {
  const layoutSlice = getInstanceSlice('layout');
  if (!layoutSlice) return 1;
  refreshSize();
  const availH = Math.max(6, rows() - 1);
  // Half/full view: the on-screen panel takes the full availH — beats
  // any stored height (panelBounds may carry a previous frame's bounds
  // across the viewMode-transition tick).
  const { viewMode, focus, halfLeftPanel } = layoutSlice;
  let visiblePanel = null;
  if (viewMode === 'half') {
    visiblePanel = instanceKind(focus) === 'detail' ? halfLeftPanel : focus;
  } else if (viewMode === 'full') {
    visiblePanel = focus;
  }
  if (panelType === visiblePanel) return Math.max(1, availH - 2);
  // Off-screen / normal-view: read via boundsFor() — prefers the
  // slice during P1.3 transition (slice carries the viewer's tab
  // cache); falls through to _currentLayout.rects when slice is
  // empty (P1.5: _panelHeights module-local retired in favor of
  // rects; this fallback is the only reader path now).
  const b = boundsFor(panelType);
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
    syncPanelScroll(p.type, getPanelViewportH(p.type));
  }

  return {
    ranges, availH,
    rects, viewMode: layoutSlice.viewMode, cols: COLS, rows: ROWS,
  };
}

/**
 * v0.6.3 P1.2 — read the most-recent Layout. Null before the first
 * calcLayout pass (test fixtures that seed `layoutSlice.panelBounds`
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
 *   2. `layoutSlice.panelBounds[key]` — legacy slice write produced
 *      by renderNormal/Half/Full. Used as fallback when no Layout
 *      has been published yet (pre-first-render boot edge; tests
 *      that seed bounds without calling render).
 *
 * The viewer's tab-bar hit-test cache (`panelBounds.detail.tabs`,
 * viewer.js:1008) still lives on the slice in P1 — moving it onto
 * the viewer's own slice is N3, scheduled for P4 (decor). When a
 * caller asks for 'detail' (or any pane that has a tabs cache),
 * merge the slice's `tabs` field onto the rect so hit-test
 * consumers (input.js detail-press, tab-drag, tab-list overlay)
 * don't lose tab bounds during the P1 transition.
 */
function boundsFor(key) {
  const layoutSlice = getInstanceSlice('layout');
  const sliceBounds = layoutSlice && layoutSlice.panelBounds && layoutSlice.panelBounds[key];
  // P1.3 priority: slice first. Both sources are written together
  // during the P1 migration (renderNormal still writes panelBounds);
  // the slice carries the viewer's `tabs` cache and is the source
  // tests seed directly. P1.4 stops the slice writes — sliceBounds
  // becomes null in production and the rect path below takes over
  // transparently. No caller change needed at P1.4.
  if (sliceBounds) return sliceBounds;
  if (_currentLayout && _currentLayout.rects) {
    const rect = _currentLayout.rects.find(r => r.paneId === key || r.type === key);
    if (rect) return rect;
  }
  return null;
}

// --- Render modes ---
// _prevRows holds the markup string written for each screen row so the next
// frame can write only rows that actually changed. clearScreen() on every
// frame caused a visible flash; lazygit/tcell avoid it by diffing — same
// trick the terminal overlay below already uses (session.prevFrame).
let _prevRows = [];
let _prevCols = 0;
let _forceFullRepaint = true;
// Set of overlay-flag names that were active on the previous frame.
// Used to detect close + transition (any flag dropping out → force a
// full repaint to wipe the closed overlay's pixels). Pure-open
// transitions (no overlay → some overlay) don't force a repaint —
// the new overlay paints cleanly on top of the existing frame.
let _prevOverlayFlags = new Set();

/**
 * Paint column outputs to the screen. `columnOutputs` is an array of
 * markup strings (one per column), each already rendered by the panel
 * renderers and possibly multi-line. Rows are concatenated left-to-right.
 * Single-column modes (half/full) pass a single-element array.
 */
function paintColumns(columnOutputs) {
  const COLS = cols();
  const splits = columnOutputs.map(s => s ? s.split('\n') : []);
  const maxRows = splits.reduce((m, s) => Math.max(m, s.length), 0);
  const newRows = new Array(maxRows);
  for (let i = 0; i < maxRows; i++) {
    let row = '';
    for (const s of splits) row += (s[i] || '');
    newRows[i] = row;
  }

  // Width or row-count change → layout reshapes, can't trust per-row diff.
  if (COLS !== _prevCols || maxRows !== _prevRows.length) _forceFullRepaint = true;
  _prevCols = COLS;

  let out = '';
  let didFull = false;
  if (_forceFullRepaint) {
    out += '\x1b[2J\x1b[H';
    for (let i = 0; i < maxRows; i++) {
      out += `\x1b[${i + 1};1H` + richToAnsi(newRows[i]) + RESET + '\x1b[K';
    }
    _forceFullRepaint = false;
    didFull = true;
  } else {
    for (let i = 0; i < maxRows; i++) {
      if (newRows[i] !== _prevRows[i]) {
        out += `\x1b[${i + 1};1H` + richToAnsi(newRows[i]) + RESET + '\x1b[K';
      }
    }
  }
  _prevRows = newRows;
  if (out) stdout.write(out);
  return didFull;
}

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
function _safeRender(panel, w, h) {
  if (!panel) return '';
  const compName = getComponentOwningPanel(panel.type);
  if (!compName) return '';
  const comp = getComponent(compName);
  const def = comp && comp.panelTypes && comp.panelTypes[panel.type];
  if (!def || typeof def.render !== 'function') return '';
  let raw;
  try {
    raw = def.render(panel, w, h, getInstanceSlice(compName));
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

// renderNormal/Half/Full populate `layoutSlice.panelBounds` directly —
// the renderer-as-writer pattern documented in the file header (§5
// view-derived data). Reset on every entry so stale entries from a
// prior view-mode aren't hit-testable.
function renderNormal(model) {
  const { ranges, availH, rects } = calcLayout(model);
  const layoutSlice = getInstanceSlice('layout');
  layoutSlice.panelBounds = {};
  const freeConfigMode = !!(model.modes && model.modes.freeConfigMode);
  // Hoist the drag check out of the per-panel injectTopRowChrome call
  // (P5.9) — one slice read here instead of N reads per frame.
  const dragging = !!(layoutSlice.freeConfig && layoutSlice.freeConfig.drag);
  // Helper to render one panel + bake the chrome glyphs into its top
  // border row. Baking (vs cursor-move overpaint) keeps paintColumns'
  // write atomic — no flicker on rows that get repainted while a glyph
  // sits over them. Two glyph classes:
  //   `[_]` / `[X]` collapse + close on non-detail panels (injectTopRowChrome)
  //   `[≡]` tab trigger on detail (injectTabTrigger)
  //
  // `fc` mirrors renderPanel's border-color rule — focused panel uses
  // theme.focus, unfocused uses theme.dim. injectTopRowChrome re-emits
  // it after each chrome `[/]` so the trailing `╮` stays in the panel's
  // border color instead of falling back to the terminal default.
  const t = theme();
  const renderOne = (p, w, h, x, y) => {
    // Bounds shape: { x, y, w, h, tabs? }. `tabs` is a hit-test cache
    // populated only on detail's bounds by the viewer Component's
    // detailTitle pass (viewer.js sets it; input.js consumers guard
    // on Array.isArray). Don't pre-allocate `[]` on every panel —
    // most panels never get a tab strip and the empty array is
    // dead weight per frame (P5.2).
    const b = { x, y, w, h };
    // Dual-key write (v0.6.1 Phase 1). Type-keyed access stays the
    // canonical read path; paneId-keyed write is forward-compat
    // scaffolding consumed by Phase 7's mass flip from type-keyed to
    // pane-keyed reads.
    layoutSlice.panelBounds[p.type] = b;
    if (p.paneId) layoutSlice.panelBounds[p.paneId] = b;
    let out = p.collapsed
      ? _renderCollapsed(p, w)
      : _safeRender(p, w, h);
    const focused = layoutSlice.focus === p.type;
    const fc = focused ? t.focus : t.dim;
    out = injectTopRowChrome(out, p, b, freeConfigMode, fc, focused, dragging);
    out = injectTabTrigger(out, p);
    return out;
  };
  // v0.6.3 P1.5 — pre-index rects by paneId AND type for the inner
  // per-panel lookup. Two-key index because rects carry paneId but the
  // lookup uses either; rebuilt every frame because rects is too.
  const rectByKey = {};
  for (const rc of rects) {
    if (rc.paneId) rectByKey[rc.paneId] = rc;
    if (rc.type)   rectByKey[rc.type]   = rc;
  }
  const columnsOut = ranges.map(r => {
    const panels = mpool.columnPanels(layoutSlice.arrange, r.columnIndex);
    let out = panels.map(p => {
      const rc = rectByKey[p.paneId] || rectByKey[p.type];
      if (!rc) return '';
      return renderOne(p, rc.w, rc.h, rc.x, rc.y);
    }).join('\n');
    // v0.6.2 — pad column output to `availH` rows. When a column's
    // panels (e.g. all collapsed) cover fewer rows than the column's
    // allocated height, the remaining vertical slots MUST still occupy
    // the column's horizontal span. Without this, paintColumns'
    // per-row concatenation sees `splits[ci][i] || ''` and the next
    // column's row shifts LEFT into the freed space — the right column
    // would render at x=0 instead of x=leftColumnWidth for those rows.
    // distributeColumnHeights' rounding-leftover-on-last-panel logic
    // covers the normal case; the all-collapsed-column case needs the
    // explicit pad here.
    const linesNow = out === '' ? 0 : out.split('\n').length;
    if (linesNow < availH) {
      const blank = ' '.repeat(r.w);
      const padding = Array(availH - linesNow).fill(blank).join('\n');
      out = out === '' ? padding : out + '\n' + padding;
    }
    return out;
  });
  return paintColumns(columnsOut);
}

function renderHalf(model) {
  calcLayout(model);
  const COLS = cols(), ROWS = rows();
  const layoutSlice = getInstanceSlice('layout');
  const halfW = Math.floor(COLS / 2);
  const availH = ROWS - 1;  // only the footer is reserved
  const focusedPanel = allPanels().find(p => p.type === layoutSlice.focus);
  if (!focusedPanel) return renderNormal(model);
  const detailPanel = mpool.findDetailPane(layoutSlice.arrange);
  // Half view is "non-detail panel + detail" side-by-side. When focus is
  // ON detail (e.g., after a tab-bar click or content-area click moves
  // focus there), the left side falls back to slice.halfLeftPanel — the
  // most recently focused non-detail panel. Without this fallback the
  // left would render detail again, duplicating it on both halves.
  // Stale-handle fallback: if halfLeftPanel was removed from the layout,
  // pick the first non-detail panel available; if none, just render
  // detail on the left as a last resort (matches old behavior).
  let leftPanel = focusedPanel;
  if (mpool.isDetailPane(focusedPanel)) {
    const all = allPanels();
    leftPanel = all.find(p => p.type === layoutSlice.halfLeftPanel)
             || all.find(p => !mpool.isDetailPane(p))
             || focusedPanel;
  }
  layoutSlice.panelBounds = {};
  const leftBounds = { x: 0, y: 0, w: halfW, h: availH };
  layoutSlice.panelBounds[leftPanel.type] = leftBounds;
  if (leftPanel.paneId) layoutSlice.panelBounds[leftPanel.paneId] = leftBounds;
  if (detailPanel) {
    const detailBounds = { x: halfW, y: 0, w: COLS - halfW, h: availH };
    layoutSlice.panelBounds.detail = detailBounds;
    if (detailPanel.paneId) layoutSlice.panelBounds[detailPanel.paneId] = detailBounds;
  }
  let leftContent = _safeRender(leftPanel, halfW, availH);
  let rightContent = detailPanel ? _safeRender(detailPanel, halfW, availH) : '';
  // Bake the [≡] trigger into the detail render — same chrome as normal
  // view so the user can open the tab list with the mouse in half view.
  // Hit-test math reads `panelBounds.detail` (right side), so inject
  // only on the right.
  if (rightContent) rightContent = injectTabTrigger(rightContent, detailPanel);
  return paintColumns([leftContent, rightContent]);
}

function renderFull(model) {
  calcLayout(model);
  const COLS = cols(), ROWS = rows();
  const layoutSlice = getInstanceSlice('layout');
  const availH = ROWS - 1;  // only the footer is reserved
  const focusedPanel = allPanels().find(p => p.type === layoutSlice.focus);
  if (!focusedPanel) return renderNormal(model);
  layoutSlice.panelBounds = {};
  const fullBounds = { x: 0, y: 0, w: COLS, h: availH };
  layoutSlice.panelBounds[focusedPanel.type] = fullBounds;
  if (focusedPanel.paneId) layoutSlice.panelBounds[focusedPanel.paneId] = fullBounds;
  let content = _safeRender(focusedPanel, COLS, availH);
  // Bake the [≡] trigger when the full-view focused panel is detail —
  // same parity with normal view.
  content = injectTabTrigger(content, focusedPanel);  // no-op if non-detail
  return paintColumns([content]);
}

let _forceOverlayFull = true;
let _lastOverlayId = null;

function renderTerminalOverlay(model = getModel()) {
  if (!isTerminalTab()) return;
  const id = activeTerminalId();
  const termConf = activeTerminalConfig();
  if (!id || !termConf) return;

  const layoutSlice = getInstanceSlice('layout');
  const bounds = layoutSlice && layoutSlice.panelBounds.detail;
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
    _forceOverlayFull = true;
  }
  // Switching to a different session — force full redraw
  if (id !== _lastOverlayId) {
    _forceOverlayFull = true;
    _lastOverlayId = id;
  }

  // Diff-based render: only rewrite rows whose content changed since the
  // previous overlay write. trimRight=false + pad so shorter lines fully
  // overwrite prior content within the changed row.
  const buffer = session.xterm.buffer.active;
  if (!session.prevFrame) session.prevFrame = [];
  const force = _forceOverlayFull;
  _forceOverlayFull = false;

  let out = '';
  for (let row = 0; row < innerH; row++) {
    const line = buffer.getLine(row + buffer.viewportY);
    let text = line ? line.translateToString(false, 0, innerW) : '';
    if (text.length < innerW) text += ' '.repeat(innerW - text.length);
    if (!force && session.prevFrame[row] === text) continue;
    out += `\x1b[${bounds.y + row + 2};${bounds.x + 2}H${text}${RESET}`;
    session.prevFrame[row] = text;
  }

  // Show exit prompt if process died (overlay on bottom content row)
  if (session.exited) {
    // T14 — defer the stale-flag cleanup to the next tick. Dispatching
    // applyMsg('terminal_exit') inline from a render path cascades
    // synchronously (setModel → view_drop_full_to_normal → force_full_
    // repaint Cmd → resets the layout-module-local _prevRows mid-paint
    // + leaves the captured `model` arg in the caller stale). The
    // setImmediate defer means the next render frame picks up the
    // post-Msg state cleanly; this frame just paints the "Process
    // exited" overlay on top of the still-terminalMode chrome — a
    // single-frame harmless lag, not a structural mid-render mutation.
    if (model.modes.terminalMode) {
      setImmediate(() => require('../dispatch/dispatch').applyMsg({ type: 'terminal_exit' }));
    }
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
  for (const flag of _prevOverlayFlags) {
    if (!curOverlayFlags.has(flag)) { _forceFullRepaint = true; break; }
  }
  _prevOverlayFlags = curOverlayFlags;

  let mainDidFull;
  // viewMode lives on the layout Component slice (Phase 1b).
  const layoutSlice = getInstanceSlice('layout') || { viewMode: 'normal' };
  // Drag preview: during an active drag with a valid target, swap
  // slice.arrange for the would-be-after-release arrange so the user
  // sees the actual outcome rather than an insertion-bar hint. The swap
  // stays in place through renderTerminalOverlay too — that overlay
  // reads panelBounds.detail to position the xterm session, and the
  // screen shows detail at preview coords, so the terminal must paint
  // at preview coords to match. After that we restore both arrange AND
  // panelBounds: the viewport dispatch + the next mouse hit-test read
  // original-layout bounds, which keeps drop-target detection stable
  // when the cursor sits near a zone boundary (preview-derived bounds
  // would feed back into the next hit-test and ping-pong the layout
  // under tiny cursor wobbles).
  const drag = layoutSlice.freeConfig && layoutSlice.freeConfig.drag;
  const previewArrange = drag && drag.previewArrange;
  let savedArrange = null, savedBounds = null;
  if (previewArrange) {
    savedArrange = layoutSlice.arrange;
    savedBounds = layoutSlice.panelBounds;
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
    if (mainDidFull) _forceOverlayFull = true;
    renderTerminalOverlay(model);
  } finally {
    // Restore the canonical slice unconditionally — _safeRender wraps
    // per-panel throws but renderTerminalOverlay + the inner dispatches
    // (syncPanelScroll → set_scroll) can throw past it. Without
    // try/finally the preview arrange would persist in the live slice
    // and every subsequent reducer write would build on top of it.
    if (previewArrange) {
      layoutSlice.arrange = savedArrange;
      layoutSlice.panelBounds = savedBounds;
    }
  }
  // Cache the detail panel's effective viewport on the viewer's own
  // slice so viewer.update can clamp scroll/cursor without reading
  // layout's render-time geometry across slices. Blessed render-side
  // write — same documented exception as panelBounds (frame-derived,
  // pure function of layout). Uses the original (non-preview) bounds:
  // the viewer's actual state hasn't committed to the drag yet, so its
  // viewport tracks the real layout. R4.9: direct setInstanceSlice
  // instead of a wrapped viewer_set_viewport Msg + 5-line reducer arm
  // — the Msg's only effect was this single-field write.
  const route = require('../leaves/route');
  const viewerTab = route.resolveTarget('viewer');
  const viewerBounds = viewerTab && layoutSlice.panelBounds && layoutSlice.panelBounds[viewerTab];
  if (viewerBounds) {
    const innerH = Math.max(0, viewerBounds.h - 2);
    const viewerSlice = getInstanceSlice(viewerTab);
    if (viewerSlice && viewerSlice.innerH !== innerH) {
      route.setInstanceSlice(viewerTab, { ...viewerSlice, innerH });
    }
  }
  renderFooter(model);
  // Panel-chrome glyphs (`[_]`/`[+]` collapse, `[X]` close in free-config)
  // are baked into each panel's top-border row by renderNormal — see
  // panel-widgets.js#injectTopRowChrome. paintColumns then writes the
  // row WITH the glyph in place, so there's no cursor-move-back-and-
  // overpaint. Earlier "paint-on-top" approaches flickered on every
  // detail-scroll frame because the row-paint momentarily restored `─`
  // at the glyph cells.
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
  // Tab list overlay (only when active). The `[≡]` trigger glyph used
  // to paint here too — it's now baked into detail's top-row markup by
  // injectTabTrigger inside renderNormal (sibling of injectTopRowChrome
  // for [_]/[X]), so paintColumns writes the glyph atomically.
  if (md.tabListMode) renderTabList();
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
  const target = require('../leaves/route').resolveTarget('viewer');
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
    const search = getInstanceSlice('detail')?.search || { matches: [], idx: 0 };
    const n = (search.matches || []).length;
    const idx = n ? search.idx + 1 : 0;
    return ` /${esc(term)}│ \\[${idx}/${n}] | ↑↓ step | Esc cancel | Enter commit`;
  }
  if (md.filterMode) return ` /${esc(filterCurrentText())}│ | Esc clear | Enter ok`;
  if (md.copyMode)   return ' ↑↓ select | Esc cancel | Enter copy';
  if (md.freeConfigTitleEditMode) {
    const { titleEditText } = require('./free-config-view');
    return ` rename: ${esc(titleEditText())}│ | Esc cancel | Enter ok`;
  }
  if (md.freeConfigMode) {
    const layoutSlice = getInstanceSlice('layout');
    const dirty = (layoutSlice && layoutSlice.dirty) ? ' | [yellow]• unsaved (:save-layout)[/]' : '';
    return ` Free Config | drag/resize | J/K reorder | ←→ swap col | +/- col/detail · [/] panel h | space collapse | t rename | w panel list | u undo | C-r redo | :save-layout | q exit${getFreeConfigFooter()}${dirty}`;
  }
  if (md.menuOpen)   return ' ↑↓ select | Esc close | Enter run';

  if (instanceKind(getFocus()) === 'detail') {
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
      const search = getInstanceSlice('detail')?.search;
      if (search && search.active) {
        const n = search.matches.length;
        const idx = search.idx + 1;
        segs.push(`n/N [${idx}/${n}]`, 'Esc clear');
      }
    }
    return ' ' + segs.join(' | ');
  }
  if (instanceKind(getFocus()) === 'actions') {
    return ' ↑↓ select | ←→ panel | / filter | +/_ view | x menu | q quit | Enter run';
  }
  if (instanceKind(getFocus()) === 'groups') {
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
  let keys = footerKeys(model);
  if (!inModal) {
    const def = getPanelDef(getFocus());
    if (def && def.keyHints) keys += ` | ${esc(def.keyHints)}`;
    const msCount = multiSelCount(getFocus());
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
  const focusDef = getPanelDef(getFocus());
  const selectActive = model.modes.listSelectMode && focusDef && typeof focusDef.getItems === 'function';
  const sel = getInstanceSlice('detail')?.select;
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
  _prevRows = [];
  _forceFullRepaint = true;
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
    if (y >= 0 && _prevRows[y] !== undefined) {
      _prevRows[y] = '';
    }
  }
}

module.exports = {
  calcLayout, render, redraw, renderFooter, renderTerminalOverlay,
  forceFullRepaint, invalidateRows,
  getPanelViewportH,
  // v0.6.3 P1.2 — most-recent Layout. Null pre-first-render. Will
  // become the sole hit-test channel after P1.4 stops the
  // layoutSlice.panelBounds writes.
  getCurrentLayout,
  // v0.6.3 P1.3 — single accessor that consumers use to read pane
  // bounds. Returns from _currentLayout when present, falls back to
  // layoutSlice.panelBounds[key] otherwise. Merges the viewer's tabs
  // cache (slice.panelBounds.detail.tabs, N3 — moves onto viewer's
  // slice in P4) onto the returned rect.
  boundsFor,
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
