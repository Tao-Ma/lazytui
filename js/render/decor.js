/**
 * Panel-chrome decor — glyphs, geometry, hit-tests.
 *
 *   [_]/[+]  collapse-toggle — ALWAYS visible in normal view mode
 *            (free-config + non-free-config). Click → panel_collapse_toggle.
 *   [X]      quick-hide — free-config ONLY (the caller is the gatekeeper;
 *            input.js fires this hit-test inside its freeConfigMode
 *            branch). Click → pool_hide.
 *   [≡]      tab-list trigger — visible on panes with ≥2 tabs. Click
 *            → tab_list_open. Lives in overlay/tab-list.js but
 *            shares this file's chrome geometry helpers.
 *
 * Glyph slots on each panel's top border row:
 *   ╭─(hk)[≡]─title──────[X]─[_]╮   ← all three painted (free-config)
 *   ╭─(hk)─title─────────────[_]╮   ← only [_] (normal mode)
 *   ╭─(hk)[≡]─title───────────╮    ← only [≡] (multi-tab non-free-config)
 *
 * Geometry, all glyphs are 3 cells wide:
 *   [_]/[+]  → cols [b.x+b.w-4, b.x+b.w-3, b.x+b.w-2]
 *   [X]      → cols [b.x+b.w-8, b.x+b.w-7, b.x+b.w-6]   (gap left of [_])
 *   [≡]      → cols [b.x+TRIGGER_X_OFFSET, …]            (5-cell offset)
 *
 * Min top-border width to host the glyphs:
 *   normal       → 9  cols  (╭(hk)─[_]╮)
 *   free-config  → 13 cols  (╭(hk)─[X] [_]╮)
 *
 * Both renderers + hit-tests skip:
 *   - the detail panel for [_]/[X] (essential — neither hide nor
 *     collapse allowed)
 *   - panels too narrow for the glyph
 *   - any panel while a drag is in flight
 *
 * v0.6.3 P4.2: chrome composes INLINE in renderPanel({chrome}) via
 * chromeFor's structured spec. Previously injectTopRowChrome /
 * injectTabTrigger regex-substituted glyphs into the rendered top
 * border post-render; P4.2c deleted both. The painter stamps the
 * row with glyphs already in place — no second write, no cursor-
 * move back to overpaint, no fragile regex anchor.
 *
 * v0.6.3 C1: split out of `panel-widgets.js`. The tab-strip
 * builder (buildTabStrip) moved to `panel/viewer/tab-strip.js`
 * since it's viewer-specific.
 */
'use strict';

const { getInstanceSlice } = require('../panel/api');
const { theme } = require('./themes');
const mpool = require('../leaves/pool');

const GLYPH_W = 3;
const COLLAPSE_MIN_W = 9;
const CLOSE_PLUS_COLLAPSE_MIN_W = 13;
const CLOSE_GLYPH = '\\[X]';

/**
 * v0.6.3 P4.2 — pure derivation of which chrome glyphs a pane should
 * carry. Returns a structured spec the renderer consumes (instead of
 * computing the same info inline at three different injection sites).
 *
 *   pane:  arrange-entry — needs .type, .collapsed, .tabs (v0.6.1 panes-
 *          as-containers shape).
 *   ctx: {
 *     freeConfigMode: bool,
 *     dragging:       bool,
 *     focused:        bool,
 *     viewerTabCount: number — for the viewer-hosting pane only, the
 *                              tab count from getTabInfo(). Allows the
 *                              [≡]-on-multi-tab rule to apply uniformly
 *                              across the detail viewer (with implicit
 *                              Info + Transcript) and future multi-tab
 *                              non-viewer panes (which use pane.tabs).
 *     tabTriggerState: 'available' | 'open' | 'disabled' | 'hidden' —
 *                              tab-list overlay state.
 *   }
 *
 * Returns { collapse, close, tabTrigger }:
 *   collapse:   null | 'collapse' (panel can be collapsed; renders [_]) |
 *                'expand'   (panel is collapsed; renders [+])
 *   close:      null | 'close'    (free-config quick-hide; renders [X])
 *   tabTrigger: null | 'available' | 'open' | 'disabled' — feeds the
 *               [≡] markup choice in renderPanel.
 *
 * Rules:
 *   - detail is essential; no collapse/close.
 *   - drag in flight suppresses ALL pane chrome.
 *   - [≡] appears when the pane has ≥2 switchable tabs. For the
 *     viewer-hosting pane (kind detail), viewerTabCount in ctx counts
 *     Info + Transcript + actions/terminals/contents. For other panes,
 *     pane.tabs.length is used (multi-tab panes have ≥2).
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
  if (isDetail) {
    // Detail's [≡] = tab-list trigger; visible when the viewer has ≥2
    // tabs (Info + Transcript + actions/terminals/content).
    const tabCount = (ctx && Number.isFinite(ctx.viewerTabCount) ? ctx.viewerTabCount : 0);
    if (tabCount >= 2) {
      const state = (ctx && ctx.tabTriggerState) || 'available';
      if (state !== 'hidden') tabTrigger = state;
    }
  } else {
    // v0.6.3 D1 — non-detail [≡] = pane-select trigger (per-cell pool
    // picker). The glyph is ALWAYS painted (user's "like tabs, always
    // there" choice) — same position as detail's tab trigger, different
    // click semantic (input.js routes by pane.type). 'open' is set only
    // for the target pane during paneSelectMode; the others see
    // 'disabled' so only the originating click can re-toggle.
    const state = (ctx && ctx.paneSelectTriggerState) || 'available';
    if (state !== 'hidden') tabTrigger = state;
  }
  return { collapse, close, tabTrigger };
}

/**
 * Markup helpers — chosen so renderPanel can compose chrome glyphs
 * into the top border directly (no regex post-mutation). Each returns
 * a Rich-markup string with visible width equal to the glyph's cell
 * count (3 cells for [_] / [+] / [X] / [≡]).
 *
 * `fc` is the panel border color; markup re-opens it after each
 * chrome glyph's `[/]` so trailing border chars stay in fc.
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
  // `\\[≡]` — escape only the opening `[` (only `[` triggers markup
  // matching; richToAnsi has no `\]` handler). stripMarkup replaces
  // `\[` with a sentinel, then strips real tags, then restores —
  // leaving `[≡]` as visible cells. Matches the pattern overlay/
  // tab-list.js#TRIGGER_GLYPH uses.
  return `${open}\\[≡][/]${fc ? `[${fc}]` : ''}`;
}

function _collapseGlyphX0(b) { return b.x + b.w - 1 - GLYPH_W; }
function _closeGlyphX0(b)    { return b.x + b.w - 1 - GLYPH_W - 1 - GLYPH_W; }

/** Non-detail placed panels in current layout order, with the live
 *  `paneBounds[type]` attached. Both renderers + hit-tests walk this
 *  same set so the DRY helper avoids the slice-read fan-out that lived
 *  in v0.6 pre-cleanup. Returns [] when there's no layout slice yet
 *  (test/boot edge cases). */
function _placedWidgetTargets() {
  const slice = getInstanceSlice('layout');
  if (!slice || !slice.arrange) return null;
  const drag = slice.freeConfig && slice.freeConfig.drag;
  if (drag) return null;  // drag affordance owns the screen; suppress widgets
  const panels = mpool.allPanesInColumns(slice.arrange);
  // v0.6.3 P1.3: lazy require to dodge the layout ↔ decor cycle
  // (layout.js imports decor at top-level, so a top-level
  // require('./geometry') would yield the partial module without
  // visibleBoundsFor; lazy resolves to the final exports).
  //
  // visibleBoundsFor — NOT boundsFor — so off-screen panes in half/
  // full view don't show up here. The boundsFor fallback to
  // _currentLayout.rects would return phantom normal-view rects for
  // off-screen panes, letting a click on the visible left half fire
  // panel_collapse_toggle on an off-screen pane (user returns to
  // normal view → that pane is silently collapsed). Same bug class
  // as the half-mode focus-revert fix in `visibleBoundsFor`'s intro
  // commit — chrome-glyph hit-tests share the symptom.
  const { visibleBoundsFor } = require('./geometry');
  return panels
    .filter(p => p.type !== 'detail')
    // v0.6.4 Phase 2 — hit-test by paneId, not type: two same-kind panes
    // share a type key in paneBounds, so the type lookup would collide.
    .map(p => ({ p, b: visibleBoundsFor(p.paneId) }))
    .filter(({ b }) => b && b.h >= 1);
}

/** Hit-test the `[_]`/`[+]` glyphs. Returns the panel id under (mx, my)
 *  or null. */
function hitTestCollapseButton(mx, my) {
  const targets = _placedWidgetTargets();
  if (!targets) return null;
  for (const { p, b } of targets) {
    if (b.w < COLLAPSE_MIN_W) continue;
    const x0 = _collapseGlyphX0(b);
    if (my === b.y && mx >= x0 && mx < x0 + GLYPH_W) return p.id;
  }
  return null;
}

/** Hit-test the `[X]` glyphs. Returns the panel id under (mx, my)
 *  or null. */
function hitTestCloseButton(mx, my) {
  const targets = _placedWidgetTargets();
  if (!targets) return null;
  for (const { p, b } of targets) {
    if (b.w < CLOSE_PLUS_COLLAPSE_MIN_W) continue;
    const x0 = _closeGlyphX0(b);
    if (my === b.y && mx >= x0 && mx < x0 + GLYPH_W) return p.id;
  }
  return null;
}

module.exports = {
  hitTestCollapseButton,
  hitTestCloseButton,
  chromeFor,
  _collapseGlyphMarkup,
  _closeGlyphMarkup,
  _tabTriggerMarkup,
};
