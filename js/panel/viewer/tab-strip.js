/**
 * Viewer tab-strip — flat tab-bar markup + click-bounds for the
 * detail pane's `[Info] [Transcript] [actions…] [terminals…]
 * [content…]` strip.
 *
 * Returned `tabBounds` feeds the input.js mouse hit-test cache;
 * `title` is the Rich-markup string renderPanel(title=…) stamps into
 * the top border. The detail render path (viewer.js `render()`) is
 * the sole caller in production; test-jobs.js exercises the markup
 * directly.
 *
 * v0.6.3 C1: split out of `render/panel-widgets.js`. The chrome-
 * glyph half (chromeFor + markup + hit-tests) moved to
 * `render/decor.js`.
 */
'use strict';

const { esc, visibleLen } = require('../../leaves/text/ansi');

/**
 * Build the panel title string + tab-bounds array for a pane that hosts
 * a flat tab strip (Info | Transcript | content). (U2c P2 — action tabs
 * retired: a tab:true action's output lives in its own text-view position-tab.
 * U2d P2b — embedded terminals became `terminal` panes, so the strip no longer
 * has a terminal segment; content follows Info+Transcript directly.)
 *
 * Inputs:
 *   tabInfo  — { contentTabs } (from
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
function buildTabStrip(tabInfo, activeTab, hotkey, hasTabTrigger) {
  const { contentTabs } = tabInfo;
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
  // U2c P2 — action tabs retired (output → its own text-view position-tab).
  // U2d P2b — terminals retired (they're `terminal` panes). Content follows
  // Info+Transcript directly, starting at idx 2.
  const contentOffset = 2;
  contentTabs.forEach(([key, info], i) => pushTab(info.label, activeTab === contentOffset + i, key));

  const tabBounds = [];
  // Title starts at col 2 (after `╭─`); hotkey display occupies
  // `(h)` (2 + hotkey.length cells) plus a `─` separator. When the
  // pane's chrome includes the `[≡]` tab-list trigger (3 cells:
  // `[`, `≡`, `]`), renderPanel injects it BETWEEN the hotkey and
  // the title — shifting every tab right by 3. Without accounting
  // for this, tabBounds.x is 3 cells left of the actual on-screen
  // position and clicks on the [x] close glyph hit empty space.
  let xOffset = 2 + (hotkey ? 2 + hotkey.length : 0) + (hasTabTrigger ? 3 : 0) + 1;
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

module.exports = { buildTabStrip };
