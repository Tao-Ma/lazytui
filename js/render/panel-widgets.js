/**
 * Panel-chrome widget glyphs — small interactive icons on each
 * placed panel's top border row:
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
 */
'use strict';

const { getInstanceSlice } = require('../panel/api');
const { theme } = require('./themes');
const { esc, visibleLen } = require('../io/ansi');
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
  const tabCount = isDetail
    ? (ctx && Number.isFinite(ctx.viewerTabCount) ? ctx.viewerTabCount : 0)
    : (pane && Array.isArray(pane.tabs) ? pane.tabs.length : 0);
  if (tabCount >= 2) {
    const state = (ctx && ctx.tabTriggerState) || 'available';
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
 *  `panelBounds[type]` attached. Both renderers + hit-tests walk this
 *  same set so the DRY helper avoids the slice-read fan-out that lived
 *  in v0.6 pre-cleanup. Returns [] when there's no layout slice yet
 *  (test/boot edge cases). */
function _placedWidgetTargets() {
  const slice = getInstanceSlice('layout');
  if (!slice || !slice.arrange) return null;
  const drag = slice.freeConfig && slice.freeConfig.drag;
  if (drag) return null;  // drag affordance owns the screen; suppress widgets
  const panels = mpool.allPanesInColumns(slice.arrange);
  // v0.6.3 P1.3: lazy require to dodge the layout ↔ panel-widgets
  // cycle (layout.js imports panel-widgets at top-level, so a top-
  // level require('./layout') would yield the partial module without
  // boundsFor; lazy resolves to the final exports).
  const { boundsFor } = require('./layout');
  return panels
    .filter(p => p.type !== 'detail')
    .map(p => ({ p, b: boundsFor(p.type) }))
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

// --- Tab-strip helper ------------------------------------------------------

/**
 * Build the panel title string + tab-bounds array for a pane that hosts
 * a flat tab strip (Info | actions | terminals | content).
 *
 * Inputs:
 *   tabInfo  — { actionTabs, termTabs, contentTabs } (from
 *              pt.flatTabInfo or panel/viewer/tabs.getTabInfo())
 *   activeTab — slice.tab (flat integer index)
 *   hotkey   — single-letter pane hotkey for x-offset math (the title
 *              starts after `╭─(hotkey)─`)
 *   runningActionKeys — optional Set<actionKey> for stream-routed jobs
 *              currently running in the active group. Prefixes those
 *              action tab labels with a `●` running glyph.
 *
 * Returns { title, tabBounds }:
 *   title     — rich-markup string ready for renderPanel(title=…). The
 *               active tab is wrapped in `\[label]`; content tabs grow
 *               a trailing ` \[x]` close glyph; tabs join with `─`.
 *               When the pane has zero tabs, returns null — caller
 *               falls back to a plain title.
 *   tabBounds — Array<{ tabIdx, x, w, closeKey?, closeX?, closeW? }>
 *               for the mouse hit-test cache (input.js consumes
 *               `b.tabs`). x is the column offset relative to the
 *               pane's left edge.
 */
function buildTabStrip(tabInfo, activeTab, hotkey, runningActionKeys) {
  const { actionTabs, termTabs, contentTabs, total } = tabInfo;
  // total includes the implicit Info (idx 0) AND Transcript (idx
  // total-1); we always render at least [Info] [Transcript]
  // regardless of how empty the middle section is.

  const parts = [];
  const partMeta = [];
  const pushTab = (label, isActive, closeKey) => {
    const close = closeKey ? ' \\[x]' : '';
    parts.push(isActive ? `\\[${label}${close}]` : `${label}${close}`);
    partMeta.push({ closeKey, activeWrap: isActive ? 1 : 0 });
  };
  pushTab(esc('Info'), activeTab === 0, null);
  // Transcript — implicit, at idx 1 right after Info. v0.6.2 —
  // hosts the unrouted accumulator (replaces the pre-fix
  // "Info doubles as transcript host" design). Placed next to Info
  // so the two globals stay adjacent regardless of how long the
  // per-group strip grows. Empty-buffer state still renders the
  // tab; tab_switch handler shows a placeholder.
  pushTab(esc('Transcript'), activeTab === 1, null);
  actionTabs.forEach(([key, action], i) => {
    const running = runningActionKeys && runningActionKeys.has(key);
    const prefix = running ? '[yellow]●[/]' : '';
    pushTab(prefix + esc(action.label), activeTab === i + 2, null);
  });
  const termOffset = 2 + actionTabs.length;
  termTabs.forEach(([, term], i) => pushTab(term.label, activeTab === termOffset + i, null));
  const contentOffset = 2 + actionTabs.length + termTabs.length;
  contentTabs.forEach(([key, info], i) => pushTab(info.label, activeTab === contentOffset + i, key));

  const tabBounds = [];
  // Title starts at col 2 (after `╭─`); hotkey display occupies
  // `(h)` (3 cells) plus a `─` separator when present.
  let xOffset = 2 + (hotkey ? 2 + hotkey.length : 0) + 1;
  parts.forEach((part, i) => {
    if (i > 0) xOffset += 1;  // `─` separator between tabs
    const visLen = visibleLen(part);
    const meta = partMeta[i];
    const bound = { tabIdx: i, x: xOffset, w: visLen };
    if (meta.closeKey) {
      // Close glyph "[x]" sits at the end of the tab's visible text.
      // For an active tab the trailing `]` of the `\[…]` wrapper sits
      // one cell after the glyph (activeWrap=1), so the close zone
      // shifts accordingly.
      bound.closeKey = meta.closeKey;
      bound.closeX = xOffset + visLen - meta.activeWrap - 3;
      bound.closeW = 3;
    }
    tabBounds.push(bound);
    xOffset += visLen;
  });
  return { title: parts.join('─'), tabBounds };
}

module.exports = {
  hitTestCollapseButton,
  hitTestCloseButton,
  buildTabStrip,
  // v0.6.3 P4.2 — pane chrome as structured data (replaces the
  // regex-based injectTopRowChrome that retired in P4.2c).
  chromeFor,
  _collapseGlyphMarkup,
  _closeGlyphMarkup,
  _tabTriggerMarkup,
};
