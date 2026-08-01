/**
 * Slot tab-strip geometry — tab-bar markup + click-bounds for a MULTI-tab slot
 * (panel/slot-strip.js). Each tab is a position-tab; the returned `tabBounds`
 * feeds the input.js mouse hit-test + the `[≡]` pane-menu, and `title` is the
 * Rich-markup string renderPanel(title=…) stamps into the top border.
 *
 * v0.6.3 C1: split out of `render/panel-widgets.js`. U2f: the old flat-strip
 * builder (buildTabStrip, for the retired viewer Component) is gone; the generic
 * entry-driven builder below is the sole survivor.
 */
'use strict';

const { esc, visibleLen } = require('../text/ansi');

/**
 * Build a strip from tagged ENTRIES — the geometry engine behind the multi-tab
 * slot strip (panel/slot-strip.js). Each entry is `{ label, ...meta }`;
 * `activeIdx` is bracketed. Returns `{ title, tabBounds }` where each bound is the
 * entry's `meta` plus `{ x, w }` (the click hit-zone), so the caller routes by the
 * entry's own tag (a position-tab poolId). The x-offset math accounts for the
 * `╭─(hotkey)─` prefix and the optional `[≡]` tab-list trigger (3 cells injected
 * between the hotkey and the title) so the hit-zones line up with the glyphs.
 */
function buildEntryStrip(entries, activeIdx, hotkey, hasTabTrigger) {
  const parts = entries.map((e, i) => {
    const label = esc(e.label);
    return i === activeIdx ? `\\[${label}]` : label;
  });
  const tabBounds = [];
  let xOffset = 2 + (hotkey ? 2 + hotkey.length : 0) + (hasTabTrigger ? 3 : 0) + 1;
  parts.forEach((part, i) => {
    if (i > 0) xOffset += 1;  // `─` separator between tabs
    const visLen = visibleLen(part);
    const { label, ...meta } = entries[i];
    tabBounds.push({ ...meta, x: xOffset, w: visLen });
    xOffset += visLen;
  });
  return { title: parts.join('─'), tabBounds };
}

module.exports = { buildEntryStrip };
