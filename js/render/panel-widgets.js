/**
 * Panel-chrome widget glyphs — small interactive icons painted on each
 * placed panel's top border row. Split out of `overlay/free-config.js`
 * because they're not all design-specific:
 *
 *   [_]/[+]  collapse-toggle — ALWAYS visible in normal view mode
 *            (free-config + non-free-config). Click → panel_collapse_toggle.
 *   [X]      quick-hide — free-config ONLY (the caller is the gatekeeper;
 *            input.js fires this hit-test inside its freeConfigMode
 *            branch). Click → pool_hide.
 *
 * Glyph slots on each panel's top border row:
 *   ...─[X] [_]╮   ← when both painted (free-config)
 *   ...─    [_]╮   ← when only [_] painted (normal mode)
 *
 * Geometry, both glyphs are 3 cells wide:
 *   [_]/[+]  → cols [b.x+b.w-4, b.x+b.w-3, b.x+b.w-2]
 *   [X]      → cols [b.x+b.w-8, b.x+b.w-7, b.x+b.w-6]   (4-cell gap left of [_])
 *
 * Min top-border width to host the glyphs:
 *   normal       → 9  cols  (╭(hk)─[_]╮)
 *   free-config  → 13 cols  (╭(hk)─[X] [_]╮)
 *
 * Both renderers + hit-tests skip:
 *   - the detail panel (essential — neither hide nor collapse allowed)
 *   - panels too narrow for the glyph
 *   - any panel while a drag is in flight (the drag overlays take over)
 *
 * Baked into the panel's own top-border row markup (renderNormal calls
 * `injectTopRowChrome` before joining outputs). paintColumns then writes
 * the row WITH the glyph already in place — no second write, no cursor-
 * move back to overpaint. Pre-fix this module wrote each glyph in its
 * own stdout.write after paintColumns; even with both in one syscall the
 * terminal still saw "write `─` then write `[_]`" sequentially, so the
 * `[_]` cells visibly flickered as `─` whenever the row got repainted
 * (e.g. on every detail-scroll frame for lower-left panels). Hit-tests
 * are pure derivations over `slice.arrange` + `slice.panelBounds` (same
 * geometry the render pass wrote).
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
  const panels = (slice.arrange.leftPanels || []).concat(slice.arrange.rightPanels || []);
  return panels
    .filter(p => p.type !== 'detail')
    .map(p => ({ p, b: slice.panelBounds[p.type] }))
    .filter(({ b }) => b && b.h >= 1);
}

/** Inject the panel-chrome glyphs into the top border row of `panelOutput`
 *  (the markup string produced by renderPanel / _renderCollapsed) so the
 *  glyph rides atomically in paintColumns' write. Returns the modified
 *  output. No-op when:
 *    - the panel is detail (excluded — `[_]` and `[X]` not allowed there)
 *    - a drag is in flight (drag affordance owns the screen)
 *    - the top row is too narrow to host the glyph(s)
 *    - the trailing fill (`─`-run before `╮[/]`) is shorter than the
 *      chrome width
 *
 *  The injection rewrites the very end of the first line — `─{N}╮[/]` —
 *  by replacing `N` trailing fills with `(N - chromeW)` fills plus the
 *  chrome markup, then the corner + close tag. The lazy-match anchored
 *  to end-of-line locks onto the final `─*` run, not any `─` chars inside
 *  the title text. */
function injectTopRowChrome(panelOutput, p, b, freeConfigMode, fc, focused) {
  if (!panelOutput || mpool.isDetailPane(p)) return panelOutput;
  const slice = getInstanceSlice('layout');
  if (slice && slice.freeConfig && slice.freeConfig.drag) return panelOutput;
  if (!b || b.h < 1 || b.w < COLLAPSE_MIN_W) return panelOutput;

  // Build chrome markup + measure visible width. [X] sits 1 col left of
  // [_] (4-cell gap including the literal `─` left untouched between
  // them), matching the geometry the hit-tests assume. After each chrome
  // glyph's `[/]` we re-emit `[fc]` so the cells AFTER it stay in the
  // panel's border color — without this, richToAnsi's full-reset on
  // `[/]` would leave the gap `─` and the `╮` corner in the terminal's
  // default color (visibly black/uncolored on most terminals).
  // Styles come from the theme — see themes.js#chrome_collapse / chrome_close.
  // Fallbacks match the previous hardcoded defaults so a custom theme
  // missing a slot still renders something sensible.
  //
  // When unfocused, prepend `[dim]` and KEEP the theme color, so the
  // glyph reads as a darker shade of green/red rather than reverting
  // to terminal-default-fg-dimmed (visually gray, no color identity).
  // The composite is emitted as two adjacent markup tags `[dim][color]`
  // because richToAnsi looks each tag up in CODES separately — there's
  // no `[dim green]` entry. The terminal applies SGR sequentially, so
  // the result is `\x1b[2m\x1b[32m` = dim + green = darker green.
  // Two slots so the [_] (collapsible) and [+] (collapsed) glyphs can
  // have different colors — Mac convention: yellow minimize, green
  // zoom. The collapsed state's [+] uses chrome_expand; the not-yet-
  // collapsed [_] uses chrome_collapse.
  const t = theme();
  const closeBase    = t.chrome_close    || 'red';
  const collapseBase = p.collapsed
    ? (t.chrome_expand   || 'green')
    : (t.chrome_collapse || 'yellow');
  const closeOpen    = focused ? `[${closeBase}]`    : `[dim][${closeBase}]`;
  const collapseOpen = focused ? `[${collapseBase}]` : `[dim][${collapseBase}]`;
  const fcRestore     = fc ? `[${fc}]` : '';
  const collapseGlyph = p.collapsed ? '\\[+]' : '\\[_]';

  let chromeW = GLYPH_W;
  const wantClose = freeConfigMode && b.w >= CLOSE_PLUS_COLLAPSE_MIN_W;
  if (wantClose) chromeW += GLYPH_W + 1;  // [X] + gap cell

  const nlIdx = panelOutput.indexOf('\n');
  const topRow  = nlIdx >= 0 ? panelOutput.slice(0, nlIdx) : panelOutput;
  const restRows = nlIdx >= 0 ? panelOutput.slice(nlIdx) : '';

  // Anchor to end-of-line so the captured `─*` is the FINAL fill run
  // (not a `─` inside the title). The lazy `.*?` lets m[1] grow until
  // the suffix matches; ─* is greedy so it grabs the whole final run.
  const m = topRow.match(/^(.*?)(─*)╮\[\/\]$/);
  if (!m) return panelOutput;
  if (m[2].length < chromeW) return panelOutput;

  const colMarkup = `${collapseOpen}${collapseGlyph}[/]${fcRestore}`;
  let injected;
  const kept = m[2].length - chromeW;
  if (wantClose) {
    // …─[X]─[_]╮ — keep one fill cell BETWEEN [X] and [_]. fcRestore
    // after [X][/] keeps that gap `─` in fc color; fcRestore after
    // [_][/] keeps the `╮` in fc.
    const closeMarkup = `${closeOpen}${CLOSE_GLYPH}[/]${fcRestore}`;
    injected = '─'.repeat(kept) + closeMarkup + '─' + colMarkup;
  } else {
    injected = '─'.repeat(kept) + colMarkup;
  }
  return m[1] + injected + '╮[/]' + restRows;
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
function buildTabStrip(tabInfo, activeTab, hotkey) {
  const { actionTabs, termTabs, contentTabs } = tabInfo;
  if (!actionTabs.length && !termTabs.length && !contentTabs.length) return null;

  const parts = [];
  const partMeta = [];
  const pushTab = (label, isActive, closeKey) => {
    const text = esc(label);
    const close = closeKey ? ' \\[x]' : '';
    parts.push(isActive ? `\\[${text}${close}]` : `${text}${close}`);
    partMeta.push({ closeKey, activeWrap: isActive ? 1 : 0 });
  };
  pushTab('Info', activeTab === 0, null);
  actionTabs.forEach(([, action], i) => pushTab(action.label, activeTab === i + 1, null));
  const termOffset = 1 + actionTabs.length;
  termTabs.forEach(([, term], i) => pushTab(term.label, activeTab === termOffset + i, null));
  const contentOffset = 1 + actionTabs.length + termTabs.length;
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
  injectTopRowChrome,
  hitTestCollapseButton,
  hitTestCloseButton,
  buildTabStrip,
};
