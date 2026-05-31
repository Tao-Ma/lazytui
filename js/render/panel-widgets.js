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
 * Pure paint-on-top after the main `paintColumns` pass. The hit-tests
 * are pure derivations over `slice.arrange` + `slice.panelBounds`
 * (same geometry the render pass wrote).
 */
'use strict';

const { RESET, richToAnsi } = require('../io/ansi');
const { stdout } = require('../io/term');
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

/** Paint `[_]`/`[+]` on every eligible panel. Always-on in normal view
 *  (the render() caller gates on viewMode). */
function renderCollapseButtons() {
  const targets = _placedWidgetTargets();
  if (!targets) return;
  for (const { p, b } of targets) {
    if (b.w < COLLAPSE_MIN_W) continue;
    const x0 = _collapseGlyphX0(b);
    const glyph = p.collapsed ? '\\[+]' : '\\[_]';
    stdout.write(`\x1b[${b.y + 1};${x0 + 1}H` + richToAnsi(`[bold cyan]${glyph}[/]`) + RESET);
  }
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

/** Paint `[X]` quick-hide on every eligible panel. Free-config only
 *  (the render() caller gates on `md.freeConfigMode`). */
function renderCloseButtons() {
  const targets = _placedWidgetTargets();
  if (!targets) return;
  for (const { p, b } of targets) {
    if (b.w < CLOSE_PLUS_COLLAPSE_MIN_W) continue;
    const x0 = _closeGlyphX0(b);
    stdout.write(`\x1b[${b.y + 1};${x0 + 1}H` + richToAnsi(`[bold red]${CLOSE_GLYPH}[/]`) + RESET);
  }
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
  renderCollapseButtons, hitTestCollapseButton,
  renderCloseButtons,    hitTestCloseButton,
};
