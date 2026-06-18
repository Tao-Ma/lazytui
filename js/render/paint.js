/**
 * View painting — the rendering half of the render module. (v0.6.4
 * Theme B: split out of the old `render/geometry.js` god-file; the
 * layout math lives in `leaves/geometry.js`. The thin facade that
 * re-exported both was deleted in wm-geo P2 — paint consumers import
 * this module directly.) Owns the per-frame paint:
 * the three view-mode dispatchers (renderNormal/Half/Full), the Rect
 * compositing + diff cache (`_frame` → painter.paintFrame), the panel
 * chrome glyphs, the terminal overlay, and `render()` itself.
 *
 * Paint depends on leaves/geometry (one direction only): renderNormal/
 * Half/Full call `geo.calcLayout(layoutSlice, dims)` to get the Rect
 * list; hit-test accessors (boundsFor / getPanelViewportH /
 * getCurrentLayout) live in leaves/geometry.
 *
 * The renderer-as-writer pattern (renderNormal/Half/Full populate
 * `layoutSlice.paneBounds` directly) is documented in
 * docs/v0.5-layering.md §5 — geometry is a pure function of view state
 * (term size, arrange, viewMode), so it's published from the paint
 * pass rather than routed through a Msg every frame. The viewer
 * Component does the same for `paneBounds.detail.tabs`. Pure-TEA freeze
 * tests on the layout slice must whitelist these renderer-written
 * fields.
 *
 * Zero npm dependencies (uses local modules).
 */
'use strict';

const { RESET, richToAnsi, esc, visibleLen, wrapColor } = require('../leaves/ansi');
const { cols, rows, stdout, showCursor, hideCursor } = require('../io/term');
const { allPanels } = require('../panel/nav-state');
const geo = require('../leaves/geometry');
const mpool = require('../leaves/pool');
const mpane = require('../leaves/pane');
const { theme } = require('../leaves/themes');
const { truncate, setWriter: _setDrawWriter } = require('../leaves/draw');
// Wire the overlay-paint write seam: draw.renderOverlay (a pure leaf) emits its
// composed buffer through this instead of importing io/term's stdout directly.
// Done here because paint.js is the render layer that legitimately owns stdout.
// (CLI/tests never load paint.js, so the leaf's writer stays unset there and
// renderOverlay no-ops its write — they assert overlay state, not pixels.)
_setDrawWriter((buf) => stdout.write(buf));
const painter = require('../leaves/painter');
const { isTerminalTab, activeTerminalId, activeTerminalConfig } = require('../panel/viewer/tabs');
const { getSession, sessionScrollInfo } = require('../io/terminal');
const { getInstanceSlice, sliceForPane, getComponent,
       getComponentOwningPanel } = require('../panel/api');
const { renderCopyMenu } = require('../overlay/copy');
const { render: renderRegisterPopup } = require('../overlay/register-popup');
const { renderMenu } = require('../overlay/menu');
const { renderWhichKey } = require('../overlay/which-key');
const modes = require('../leaves/modes');
const { getModel } = require('../model/store');
const { renderCmdline } = require('../overlay/cmdline');
const { renderConfirmOverlay } = require('../overlay/confirm');
const { renderPromptOverlay } = require('../overlay/prompt');
const { renderPanelListOverlay } = require('../overlay/panel-list');
const { renderJobsOverlay } = require('../overlay/jobs');
// v0.6.4 Theme B — the footer row (~180 LOC) lives in its own module;
// geometry only calls renderFooter() once per frame from render().
const { renderFooter } = require('./footer');

// v0.6.4 — memoized lazy module refs for the per-frame hot path. These
// were inline `require(...)` calls re-evaluated EVERY render: route ×6
// (resolveTarget for the viewer target), chrome ×4 (chromeFor). The
// relative-path require() resolution is ~70µs/call (see R1 / pane-tabs);
// at 6+4 calls/frame that was ~0.7ms/frame on require alone. Resolve
// once at runtime. `||=` caches the ref. (chromeFor + the glyph-markup
// builders are pure chrome derivation, now in leaves/draw — render→leaf,
// no cycle; the slice-reading hit-tests went to panel/chrome-hittest.)
let _routeRef; const _route = () => (_routeRef ||= require('../panel/route'));
let _decorRef; const _decor = () => (_decorRef ||= require('../leaves/draw'));
let _tabsRef; const _tabs = () => (_tabsRef ||= require('../panel/viewer/tabs'));
let _paneMenuRef; const _paneMenu = () => (_paneMenuRef ||= require('../overlay/pane-menu'));

// Shared chrome-glyph inputs for composeRects / renderHalf / renderFull.
// v0.6.4 Theme B — the scalar setup (chromeFor, viewer tab count, tab-
// trigger state, pane-select mode/target/has-swap) was triplicated
// nearly verbatim across all three render modes; this is the single
// source. The per-view pane-select TRIGGER fn is NOT shared — it
// legitimately differs (normal view has multiple panes and mirrors
// tab-list to disable peer triggers; half/full have a single trigger) —
// so each caller builds its own from these scalars.
function _chromeContext(model, layoutSlice) {
  const md = (model && model.modes) || {};
  const paneMenu = _paneMenu();
  const targetPaneId = (layoutSlice.paneMenu && layoutSlice.paneMenu.targetPaneId) || null;
  // v0.6.4 #1 Step 2 — ONE per-pane `[≡]` trigger-state resolver, shared
  // across normal / half / full (visibility is per-pane via the overlay's
  // triggerVisible — a viewer shows with ≥2 tabs, any other pane with ≥2
  // pane rows). Replaces the old split viewerTabCount + tabTriggerState
  // (viewer) vs paneSelectTriggerState (navigator) plumbing.
  const paneMenuTriggerStateFor = (paneId) => {
    let visible = true;
    try { visible = paneMenu.triggerVisible(paneId); } catch (_) { visible = false; }
    if (!visible) return 'hidden';
    if (md.paneMenuMode) return paneId === targetPaneId ? 'open' : 'disabled';
    let s = 'normal';
    try { s = paneMenu._triggerState(); } catch (_) {}
    return s === 'normal' ? 'available' : 'disabled';
  };
  return {
    chromeFor: _decor().chromeFor,
    freeConfigMode: !!md.freeConfigMode,
    dragging: !!(layoutSlice.freeConfig && layoutSlice.freeConfig.drag),
    paneMenuTriggerStateFor,
  };
}

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
  const W = _decor();
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
  // v0.6.5 §5 — last overlay's displayed inner dims. The PTY resize moved to
  // the dispatch finalizer, so render no longer sets forceOverlayFull off the
  // resize itself; instead it NOTICES a dim change here (like lastOverlayId
  // notices a session switch) to refresh the per-row diff cache.
  lastOverlayW:     0,
  lastOverlayH:     0,
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
    // v0.6.4 Theme A Phase 5 — read THIS pane's own slice (sliceForPane
    // resolves panel.paneId → its instance; falls back to compName's
    // primary for docker-style panes + singletons). Was
    // getInstanceSlice(compName), which painted every same-kind pane
    // from the primary's slice.
    raw = def.render(panel, w, h, sliceForPane(panel.paneId, compName), opts);
  } catch (e) {
    console.error(`[render:${panel && panel.type}] ${e && e.message}`);
    try {
      require('../io/event-log').record('error', {
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
  // v0.6.3 P4.2 — chrome state computed structurally via chromeFor()
  // and threaded into the panel renderer via opts. v0.6.4 Theme B —
  // shared scalars from _chromeContext (deduped across the 3 render
  // modes).
  const { chromeFor, freeConfigMode, dragging, paneMenuTriggerStateFor } = _chromeContext(model, layoutSlice);

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
      freeConfigMode, dragging, focused,
      paneMenuTriggerState: paneMenuTriggerStateFor(panel.paneId),
    });
    const raw = panel.collapsed
      ? _renderCollapsed(panel, rect.w, chrome)
      : _safeRender(panel, rect.w, rect.h, { chrome, focused });
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
// Why pre-populate paneBounds before composeRects: a panel's render can
// read its own bounds (getPanelViewportH → boundsFor) during _safeRender,
// so the entry must exist by the time the panel renders. Same order the
// pre-P3 renderOne used (write bounds, then render).
//
// v0.6.4 — keyed by paneId ONLY (the type-keyed write retired). The type
// key was the half/full visible-bounds channel for readers that queried
// by the viewer tab-id; those now resolve the container paneId via
// route.resolveViewerPaneId(), so the per-paneId write is sufficient.
// (The per-frame scroll-clamp that lived here — _syncScrollClamp —
// moved to the post-dispatch finalizer in dispatch/runtime/fanout.js (resize-as-Msg
// P3): every state change is a dispatch, so the clamp runs there, and
// render dispatches NOTHING. test-scroll-clamp.js pins render purity.)

function renderNormal(model, arrangeOverride) {
  const layoutSlice = getInstanceSlice('layout');
  // resize-as-Msg P1 — dims come from the model (written by the
  // term_resized arm), not a live io/term read: render is a function
  // of the model's clock. A resize landing mid-frame repaints when
  // its Msg arrives.
  const dims = layoutSlice.dims;
  // Phase B — drag preview is threaded as a param (arrangeOverride), so
  // the preview layout is computed without mutating layoutSlice.arrange.
  // Phase A.2 — render no longer WRITES layoutSlice.paneBounds; bounds are a
  // pure derived value (geometry.boundsFor/visibleBoundsFor compute via the
  // memoized selector). calcLayout still publishes _currentLayout for the
  // boot-edge fallback.
  const layout = geo.calcLayout(layoutSlice, dims, { arrangeOverride });
  const rectsWithLines = composeRects(layout, model);
  const COLS = dims.cols;
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
// Half view projects two panes side-by-side, resolved by the shared
// geo.halfProjection helper (see leaves/geometry): a left + right slot, each
// an ephemeral API-settable selection that defaults to the historical
// "focused non-detail pane + major viewer" derivation. Either slot may hold
// any pane (two viewers side-by-side is allowed); the right slot may be null
// (single-pane left-only). The same helper drives getPanelViewportH so the
// scroll/viewport math agrees with what's painted.
function renderHalf(model, arrangeOverride) {
  const layoutSlice = getInstanceSlice('layout');
  const dims = layoutSlice.dims;  // model clock (resize-as-Msg P1)
  geo.calcLayout(layoutSlice, dims, { arrangeOverride });
  const COLS = dims.cols, ROWS = dims.rows;
  const halfW = Math.floor(COLS / 2);
  const availH = ROWS - 1;
  const focusedPanel = allPanels().find(p => mpane.paneMatchesFocus(p, layoutSlice.focus));
  if (!focusedPanel) return renderNormal(model, arrangeOverride);
  // v0.6.4 — the two projected panes come from the shared halfProjection
  // (leaves/geometry): an ephemeral, API-settable selection (`view_place_pane`)
  // that falls back to the historical "focused non-detail + major viewer"
  // derivation when unset. Either slot may hold ANY pane — including a
  // viewer — so two viewers can sit side-by-side. getPanelViewportH reads
  // the same helper, so half-view geometry agrees everywhere.
  const all = allPanels();
  const proj = geo.halfProjection(layoutSlice, _route().resolveViewerPaneId());
  const leftPanel = (proj.left && all.find(p => p.paneId === proj.left)) || focusedPanel;
  const detailPanel = proj.right ? all.find(p => p.paneId === proj.right) || null : null;
  // Phase A.2 — bounds are derived (geometry._halfBoundsMap mirrors this
  // exact left/right projection); render no longer writes paneBounds.
  const rightW = COLS - halfW;
  // v0.6.3 P4.2 — chrome computed via chromeFor + threaded through
  // renderPanel. v0.6.4 Theme B — shared scalars from _chromeContext.
  // Half view shows one non-detail pane (left) + detail (right); only
  // the left is a pane-select candidate. Single trigger → no peer-
  // disable check (plain 'available').
  const { chromeFor, freeConfigMode, dragging, paneMenuTriggerStateFor } = _chromeContext(model, layoutSlice);
  const leftChrome = chromeFor(leftPanel, {
    freeConfigMode, dragging,
    focused: mpane.paneMatchesFocus(leftPanel, layoutSlice.focus),
    paneMenuTriggerState: paneMenuTriggerStateFor(leftPanel.paneId),
  });
  const detailChrome = detailPanel ? chromeFor(detailPanel, {
    freeConfigMode, dragging,
    focused: mpane.paneMatchesFocus(detailPanel, layoutSlice.focus),
    paneMenuTriggerState: paneMenuTriggerStateFor(detailPanel.paneId),
  }) : null;
  // v0.6.4 — thread opts.focused (Phase-5/Arc-1 moved focus styling there).
  // Without it neither half-view pane shows the focused border — the
  // "no pane focus" symptom, most visible when the focused pane is itself
  // the viewer on the right.
  const leftFocused = mpane.paneMatchesFocus(leftPanel, layoutSlice.focus);
  const detailFocused = detailPanel ? mpane.paneMatchesFocus(detailPanel, layoutSlice.focus) : false;
  let leftContent = _safeRender(leftPanel, halfW, availH, { chrome: leftChrome, focused: leftFocused });
  let rightContent = detailPanel ? _safeRender(detailPanel, rightW, availH, { chrome: detailChrome, focused: detailFocused }) : '';
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

function renderFull(model, arrangeOverride) {
  const layoutSlice = getInstanceSlice('layout');
  const dims = layoutSlice.dims;  // model clock (resize-as-Msg P1)
  geo.calcLayout(layoutSlice, dims, { arrangeOverride });
  const COLS = dims.cols, ROWS = dims.rows;
  const availH = ROWS - 1;
  const focusedPanel = allPanels().find(p => mpane.paneMatchesFocus(p, layoutSlice.focus));
  if (!focusedPanel) return renderNormal(model, arrangeOverride);
  // Phase A.2 — bounds derived (geometry._fullBoundsMap mirrors this);
  // render no longer writes paneBounds.
  // v0.6.3 P4.2 — chrome via chromeFor. v0.6.4 Theme B — shared scalars
  // from _chromeContext. Full view paints ONE pane (the focused one):
  // single trigger, no peer-disable.
  const { chromeFor, freeConfigMode, dragging, paneMenuTriggerStateFor } = _chromeContext(model, layoutSlice);
  const fullChrome = chromeFor(focusedPanel, {
    freeConfigMode, dragging,
    focused: true,
    paneMenuTriggerState: paneMenuTriggerStateFor(focusedPanel.paneId),
  });
  // v0.6.4 — thread opts.focused (full view always paints the focused
  // pane). Phase-5/Arc-1 moved focus styling onto opts.focused; without it
  // the full-screen pane renders unfocused (no border highlight).
  let content = _safeRender(focusedPanel, COLS, availH, { chrome: fullChrome, focused: true });
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


// #D6 — model is threaded in (no `= getModel()` default), same as render():
// pure-by-construction signature. The overlay seam thunk below fetches the
// current model (`overlay: () => renderTerminalOverlay(getModel())`); the
// 250ms safety-net timer (app/tui.js) threads getModel() at its call site.
function renderTerminalOverlay(model, arrangeOverride) {
  if (!isTerminalTab()) return;
  const id = activeTerminalId();
  const termConf = activeTerminalConfig();
  if (!id || !termConf) return;

  const layoutSlice = getInstanceSlice('layout');
  // v0.6.4 — position the terminal overlay against the FOCUSED viewer's
  // CONTAINER pane bounds. resolveViewerPaneId bridges the viewer tab-id
  // to its hosting paneId, the only key carrying half/full visible bounds.
  // visibleBoundsFor (not boundsFor): in half/full the resolved viewer may
  // be OFF-SCREEN (e.g. two non-viewer panes projected) — boundsFor would
  // fall through to a phantom normal-view rect and mis-place the overlay.
  // null → no-op. Single-viewer: the viewer is always on-screen, so this is
  // byte-identical.
  // Phase A.2 — bounds derive from the slice's arrange. During a drag the
  // overlay must follow the PREVIEW layout (its detail rect shifts to the
  // would-be-after-release position), so compute against the preview arrange
  // when one is threaded; otherwise the real slice.
  const boundsSlice = arrangeOverride ? { ...layoutSlice, arrange: arrangeOverride } : layoutSlice;
  const bounds = geo.visibleBoundsFor(boundsSlice, _route().resolveViewerPaneId(), _route().resolveViewerPaneId());
  if (!bounds) return;
  const innerW = bounds.w - 2;
  const innerH = bounds.h - 2;

  // v0.6.5 §5 — render is READ-ONLY for the PTY overlay. The session's
  // lifecycle (lazy spawn on first activation + resize to the committed pane
  // geometry) is reconciled by the dispatch finalizer
  // (dispatch/runtime/fanout.js), the same runtime step that mints pane
  // instances and derives the viewer's innerH. Here we just read the buffer.
  // A null session means the finalizer hasn't spawned it yet (no activation
  // dispatch has run) — skip this frame; the next render shows it.
  const session = getSession(id);
  if (!session) return;

  // Switching session OR the overlay's displayed inner dims changed → force a
  // full overlay repaint so the per-row diff cache is rebuilt at the new
  // shape. The PTY resize itself lives in the finalizer now; render only
  // NOTICES the change. During a free-config drag the displayed bounds are
  // preview-shifted while the PTY holds its committed dims (the finalizer
  // sizes off the committed arrange) — the dim-change force keeps the shifted
  // overlay region clean.
  if (id !== _frame.lastOverlayId || innerW !== _frame.lastOverlayW || innerH !== _frame.lastOverlayH) {
    _frame.forceOverlayFull = true;
    _frame.lastOverlayId = id;
    _frame.lastOverlayW = innerW;
    _frame.lastOverlayH = innerH;
  }

  // Diff-based render: only rewrite rows whose content changed since the
  // previous overlay write. trimRight=false + pad so shorter lines fully
  // overwrite prior content within the changed row.
  const buffer = session.xterm.buffer.active;
  if (!session.prevFrame) session.prevFrame = [];
  // v0.6.5 §5(a) — scrollback: the overlay reads `buffer.viewportY`, which
  // the scroll effects (terminal.scrollSession*) move. When the viewport
  // position changes, every visible row shifts, so the per-row diff cache
  // is stale — force a full inner repaint for that frame. This also clears
  // the scroll indicator drawn below when the user returns to the bottom.
  const scrolled = buffer.viewportY !== session.prevViewportY;
  session.prevViewportY = buffer.viewportY;
  const force = _frame.forceOverlayFull || scrolled;
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

  // v0.6.5 §5(a) Phase 4 — scrollback position indicator. When the viewport
  // sits above the live bottom, stamp a reverse-video `[↑N]` tag at the
  // top-right inner cell. It overlays one cell of content while scrolled;
  // any scroll change forces the inner rows to repaint (above), so the tag
  // is self-clearing the frame the user returns to the bottom.
  const scrollInfo = sessionScrollInfo(id);
  if (!scrollInfo.atBottom && innerW > 6) {
    const tag = `[↑${scrollInfo.linesBelow}]`;
    const tx = bounds.x + 2 + innerW - tag.length;
    out += `\x1b[${bounds.y + 2};${tx}H\x1b[7m${tag}\x1b[0m`;
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

// `now` is the frame clock for the age-displaying overlays (jobs/diag),
// read from `model.now` — NOT Date.now(). model.now is advanced by the
// gated `clock_tick` reducer arm (docs/model-now-tick.md), so render() is pure
// of the WALL CLOCK: the same Msg log replays to the same age values regardless
// of real time. (Previously a Date.now() default here — blessed exception D —
// made the frame depend on ambient wall-clock, the one read that blocked
// deterministic render replay.) Threaded into the overlay render fns so THEY
// stay pure of the clock too. NOTE this does NOT make the frame a pure function
// of the model — render still reads off-model live stores (jobs / diag / history
// / PTY sessions / theme cache); that is the #D5 replayability boundary, see
// model/store.js §Replayability boundary.
function render(model) {
  const now = model.now;
  // `model` is the TEA root model (js/model/store.js; reduced by
  // js/dispatch/update/reducer.js), threaded in by the owner (the program).
  // The view reads migrated slices (currently `viewMode`) from this param,
  // not a global fetch. #D6 — the signature is pure-by-construction (no
  // `= getModel()` default): `render(model)` cannot bind to ambient state.
  // The ONE place that fetches the current model is the render-queue seam
  // thunk below (`render: () => render(getModel())`) — the runtime boundary
  // where "repaint now" reads the latest model — plus the app shell
  // (suspend resume) and the test harness, all impure-shell by definition.
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
  // Drag preview: during an active drag with a valid target, paint the
  // would-be-after-release arrange so the user sees the actual outcome
  // rather than an insertion-bar hint.
  //
  // Phase B threaded the preview arrange as a PARAMETER into the render
  // functions (no `layoutSlice.arrange` mutation). Phase A.2 then dropped
  // render's `paneBounds` writes entirely — bounds are a pure derived value
  // keyed on the REAL `layoutSlice.arrange`, so a mouse hit-test mid-drag
  // already reads original-layout geometry (no ping-pong, nothing to
  // save/restore). The terminal overlay is the one consumer that wants the
  // PREVIEW coords (its detail rect follows the would-be-after-release
  // layout), so the preview arrange is passed to it explicitly.
  const drag = layoutSlice.freeConfig && layoutSlice.freeConfig.drag;
  const previewArrange = (drag && drag.previewArrange) || null;
  const viewMode = layoutSlice.viewMode;
  if (viewMode === 'half') mainDidFull = renderHalf(model, previewArrange);
  else if (viewMode === 'full') mainDidFull = renderFull(model, previewArrange);
  else mainDidFull = renderNormal(model, previewArrange);
  // Only force the terminal-overlay repaint when main paint actually
  // cleared the screen (resize, overlay-close, first frame). In the steady
  // state main paint is diff-based and leaves the PTY region untouched, so
  // the overlay's own diff cache is enough.
  if (mainDidFull) _frame.forceOverlayFull = true;
  renderTerminalOverlay(model, previewArrange);
  // blessed-exceptions Phase A — render produces NO slice writes: `innerH`
  // is computed in the post-dispatch finalizer (A.1), `paneBounds` is a pure
  // derived selector (A.2), and the former `tabBounds` render-write is gone
  // (`tabBoundsFor` is a pure projection; input.js recomputes on demand).
  // render() is now a pure `model -> output` view.
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
  if (md.paneMenuMode) _paneMenu().render();
  if (md.jobsMode)    renderJobsOverlay(now);
  if (md.diagLogMode) require('../overlay/diag-log').renderDiagLog(now);

  // Cursor visibility — derived from mode state, single emission site.
  // Cursor *position* is set inline by renderTerminalOverlay (when in
  // terminal mode), renderCmdline (cursor at typed-text end), and
  // renderPromptOverlay (cursor inside the prompt's input row); here
  // we only flip whether it's visible. Eliminates the bug class where
  // a mode forgets to call hideCursor() / showCursor() on exit.
  if (md.terminalMode || md.cmdMode || md.promptMode) showCursor();
  else hideCursor();
}

// v0.6.4 Phase F — `redraw()` (dispatch-then-paint: showSelectedInfo + render)
// moved to dispatch/control/dispatch.js. It dispatched a Msg, so it was a dispatch
// orchestration, not a render; paint.js is now a pure view (no dispatch edge).

// Debouncing primitives live in render-queue.js (both terminal.js and
// actions.js need scheduleOverlay / scheduleRender; render-queue.js has no
// dependencies, breaking what would otherwise be a cycle through layout).
// #D6 — the render-queue invokes its callbacks with no args (it's a pure
// leaf that can't import the model). Register model-fetching THUNKS so the
// view fns stay pure-by-construction (`render(model)`, no default) while the
// seam still reads the CURRENT model at paint time — the correct runtime
// boundary for a deferred/debounced repaint (latest state, not a snapshot
// captured when scheduleRender was called).
require('../leaves/render-queue').setRenderers({
  render: () => render(getModel()),
  overlay: () => renderTerminalOverlay(getModel()),
  forceFull: forceFullRepaint, invalidate: invalidateRows,
});

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
  render, renderTerminalOverlay,
  forceFullRepaint, invalidateRows,
  // v0.6.3 P2 test seam: _normalizeRender enforces the Rect contract
  // (exactly h lines of width w). Exposed so test-rect-contract.js
  // can exercise both check mode (env LAZYTUI_RENDER_CHECK=1 → throws
  // on violation) and release mode (pads to h × w).
  _normalizeRender,
};
