/**
 * Panel-chrome widget glyphs — small interactive icons painted on each
 * placed panel's top border row. Split out of `overlay/design.js`
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

const { getComponentSlice } = require('../panel/api');

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
  const slice = getComponentSlice('layout');
  if (!slice || !slice.arrange) return null;
  const drag = slice.design && slice.design.drag;
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
function injectTopRowChrome(panelOutput, p, b, freeConfigMode) {
  if (!panelOutput || p.type === 'detail') return panelOutput;
  const slice = getComponentSlice('layout');
  if (slice && slice.design && slice.design.drag) return panelOutput;
  if (!b || b.h < 1 || b.w < COLLAPSE_MIN_W) return panelOutput;

  // Build chrome markup + measure visible width. [X] sits 1 col left of
  // [_] (4-cell gap including the literal `─` left untouched between
  // them), matching the geometry the hit-tests assume.
  const closeStyle    = 'bold red';
  const collapseStyle = 'bold cyan';
  let chromeMarkup = '';
  let chromeW = 0;
  const wantClose = freeConfigMode && b.w >= CLOSE_PLUS_COLLAPSE_MIN_W;
  if (wantClose) {
    chromeMarkup += `[${closeStyle}]${CLOSE_GLYPH}[/]`;
    // The gap cell stays as a `─` from the existing fill (kept in the
    // trimmed run below) — visually `…─[X]─[_]╮`. Reserve only the 3
    // cells [X] occupies.
    chromeW += GLYPH_W;
  }
  const collapseGlyph = p.collapsed ? '\\[+]' : '\\[_]';
  // Always-on in normal view (renderNormal is only called when viewMode==='normal').
  chromeMarkup += `[${collapseStyle}]${collapseGlyph}[/]`;
  chromeW += GLYPH_W;
  // When both are painted we need an additional gap cell between [X] and
  // [_] — that cell stays as a `─` from the kept fill, but we have to
  // consume one more fill cell on injection so total width balances.
  if (wantClose) chromeW += 1;

  const nlIdx = panelOutput.indexOf('\n');
  const topRow  = nlIdx >= 0 ? panelOutput.slice(0, nlIdx) : panelOutput;
  const restRows = nlIdx >= 0 ? panelOutput.slice(nlIdx) : '';

  // Anchor to end-of-line so the captured `─*` is the FINAL fill run
  // (not a `─` inside the title). The lazy `.*?` lets m[1] grow until
  // the suffix matches; ─* is greedy so it grabs the whole final run.
  const m = topRow.match(/^(.*?)(─*)╮\[\/\]$/);
  if (!m) return panelOutput;
  if (m[2].length < chromeW) return panelOutput;

  const kept = m[2].length - chromeW;
  let injected;
  if (wantClose) {
    // …─[X]─[_]╮ — keep one fill cell BETWEEN [X] and [_].
    // chromeW above already reserved (3 + 1 + 3) = 7 cells, but our
    // chromeMarkup is `[X][_]` glued together. Split it: emit [X], one
    // `─`, then [_].
    const closeMarkup = `[${closeStyle}]${CLOSE_GLYPH}[/]`;
    const cgly = p.collapsed ? '\\[+]' : '\\[_]';
    const colMarkup = `[${collapseStyle}]${cgly}[/]`;
    injected = '─'.repeat(kept) + closeMarkup + '─' + colMarkup;
  } else {
    injected = '─'.repeat(kept) + chromeMarkup;
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

module.exports = {
  injectTopRowChrome,
  hitTestCollapseButton,
  hitTestCloseButton,
};
