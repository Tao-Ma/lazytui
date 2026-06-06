/**
 * Pane-select overlay — per-cell pool picker.
 *
 * Click the [≡] glyph on any non-detail panel → centered overlay opens
 * listing every pool entry tagged by status:
 *   [here]      current cell's occupant (pick = no-op)
 *   [hidden]    pool entry not currently placed (pick = replace)
 *   [in col N]  placed elsewhere (pick = SWAP — the two slots trade)
 *
 * Invariants enforced at pick time (D3):
 *   - detail can't be picked anywhere (must stay at end)
 *   - actions can't end up in the leftmost column (Code-1 rule)
 *   - detail / actions can't be replaced (existing rule)
 *
 * D1 — this file: glyph hit-test + render skeleton (no body yet).
 *      The overlay paints a placeholder until D2 wires the list +
 *      cursor.
 * D2 — list rendering + cursor navigation + close-on-pick.
 * D3 — pick logic: replace / swap / validity guard + pool_swap_by_id
 *      reducer Msg.
 *
 * Co-exists with `w` (the panel-list overlay): `w` is "global pool
 * browser, toggle hide/show." Pane-select is "what should occupy THIS
 * slot specifically." Different intents, different glyphs (`w` opens
 * a centered overlay via key; pane-select opens via [≡] click).
 */
'use strict';

const { getModel } = require('../app/runtime');
const { getInstanceSlice } = require('../panel/api');
const { renderOverlay } = require('../render/panel');
const { esc, visibleLen } = require('../io/ansi');
const mpool = require('../leaves/pool');

const MAX_W = 50;
const VIEWPORT = 12;

// [≡] glyph geometry — matches the tab-list trigger (same position,
// same width). Kept duplicated rather than imported because the two
// triggers are semantically distinct (tab-list = detail; pane-select
// = non-detail) and may diverge in v0.7 (multi-tab non-detail panes
// could grow a separate paneSelect glyph at a different column).
const TRIGGER_X_OFFSET = 5;  // after the pane's `╭─(o)`
const TRIGGER_VIS_W = 3;     // [≡] occupies 3 visible cells

/** Pane bounds via the layout-derived accessor. Null when layout
 *  hasn't rendered yet (boot edge). Lazy require to dodge the
 *  layout ↔ overlay cycle. */
function _paneBounds(paneId) {
  return require('../render/layout').boundsFor(paneId);
}

/** Mouse hit-test for any non-detail pane's [≡] trigger. Returns the
 *  paneId under (mx, my) or null. Suppression rules:
 *    - detail's [≡] is tab-list, not pane-select — skipped here.
 *    - drag in flight suppresses ALL pane chrome (caller-side gate
 *      via decor's chromeFor; we just re-check defensively).
 *    - any chain mode other than paneSelectMode disables peer
 *      triggers (matches tab-list's _triggerState rule).
 */
function hitTestTrigger(mx, my) {
  const layoutSlice = getInstanceSlice('layout');
  if (!layoutSlice || !layoutSlice.arrange) return null;
  const drag = layoutSlice.freeConfig && layoutSlice.freeConfig.drag;
  if (drag) return null;
  // While paneSelectMode is active the only legal click is on the
  // open target's own [≡] (toggles close). Siblings show 'disabled'
  // chrome and must not re-arm.
  const modes = getModel().modes;
  const openTargetId = (layoutSlice.paneSelect && layoutSlice.paneSelect.targetPaneId) || null;
  for (const p of mpool.allPanesInColumns(layoutSlice.arrange)) {
    if (p.type === 'detail') continue;
    const b = _paneBounds(p.paneId) || _paneBounds(p.type);
    if (!b) continue;
    if (b.w < TRIGGER_X_OFFSET + TRIGGER_VIS_W + 2) continue;
    if (my !== b.y) continue;
    if (mx < b.x + TRIGGER_X_OFFSET) continue;
    if (mx >= b.x + TRIGGER_X_OFFSET + TRIGGER_VIS_W) continue;
    // Hit. Allow the click ONLY if either no chain mode is active OR
    // the click is on the currently-open pane's own trigger.
    if (modes.paneSelectMode && p.paneId !== openTargetId) return null;
    // Other chain modes (cmd, menu, prompt, …) — caller's
    // _suppressesChromeClicks already gates these; we don't re-check.
    return p.paneId;
  }
  return null;
}

/** v0.6.3 D2 — pure item list for the overlay. Shape:
 *    [{ id, type, title, status: 'here'|'placed'|'hidden',
 *       columnIndex: number | null }, …]
 *  Returns []  when no layout yet. Exposed for tests + the handler
 *  side (handlePaneSelectKey needs item count for clamp math). */
function items() {
  const layoutSlice = getInstanceSlice('layout');
  if (!layoutSlice || !layoutSlice.paneSelect) return [];
  const arrange = layoutSlice.arrange;
  if (!arrange) return [];
  return mpool.paneSelectItems(arrange, layoutSlice.paneSelect.targetPaneId);
}

/** Effective viewport row count — capped by terminal height. Exported
 *  so the dispatch nav handler can fold it into pane_select_nav Msgs
 *  (the reducer stays free of the terminal-size read). */
function viewportRows() {
  const { rows } = require('../io/term');
  // Reserve room for the centered overlay border + footer line.
  return Math.max(3, Math.min(VIEWPORT, rows() - 6));
}

function _statusLabel(it) {
  if (it.status === 'here')   return '[dim][here][/]';
  if (it.status === 'hidden') return '[yellow][hidden][/]';
  return `[cyan][in col ${it.columnIndex + 1}][/]`;
}

/** v0.6.3 D2 — list-body render. Item rows show:
 *    `▸ <type>  <status>`   (active row reverse-decorated)
 *  Empty state when the layout's pool has no non-detail entries. */
function render() {
  if (!getModel().modes.paneSelectMode) return;
  const layoutSlice = getInstanceSlice('layout');
  const ps = layoutSlice && layoutSlice.paneSelect;
  if (!ps) return;
  const all = items();
  const vh = viewportRows();
  const cursor = Math.max(0, Math.min(all.length - 1, ps.cursor || 0));
  const scroll = Math.max(0, Math.min(Math.max(0, all.length - vh), ps.scroll || 0));
  const lines = [];
  if (all.length === 0) {
    lines.push('[dim](no panes — pool is empty)[/]');
  } else {
    const end = Math.min(all.length, scroll + vh);
    for (let i = scroll; i < end; i++) {
      const it = all[i];
      const marker = (i === cursor) ? '▸' : ' ';
      const left = `${marker} ${esc(it.type)}`;
      const right = _statusLabel(it);
      const leftVis = visibleLen(left);
      const rightVis = visibleLen(right);
      // Budget = MAX_W - borders(2) - padding(2) = MAX_W - 4
      const inner = MAX_W - 4;
      const padLen = Math.max(1, inner - leftVis - rightVis);
      const row = `${left}${' '.repeat(padLen)}${right}`;
      lines.push((i === cursor) ? `[reverse]${row}[/]` : row);
    }
  }
  renderOverlay({
    lines,
    title: 'Pane select',
    count: all.length > 0 ? [cursor + 1, all.length] : null,
    maxWidth: MAX_W,
  });
}

module.exports = { hitTestTrigger, render, items, viewportRows };
