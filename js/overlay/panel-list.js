/**
 * Panel-list overlay (v0.6 Phase 4) — modal popup showing every panel in
 * the pool: placed panels (in grid order, greyed since picking them
 * means hide), the essential `detail` panel (no-op pick), and hidden
 * panels (highlighted; pick = show + place in grid).
 *
 * State + behavior live in the layout Component's slice (slice.panelList
 * + the `panel_list_*` Msgs). This module is render-only: reads the
 * slice and paints, no writes.
 *
 * Opens automatically on free-config entry when there are hidden entries
 * (the discoverability hint that more panels are available than the
 * current grid shows). Manual open: `w` key while inside free-config.
 */
'use strict';

const { esc } = require('../io/ansi');
const { renderOverlay } = require('../render/panel');
const { getComponentSlice } = require('../panel/api');
const mpool = require('../leaves/pool');

function _slice() { return getComponentSlice('layout'); }

function renderPanelListOverlay() {
  const slice = _slice();
  if (!slice || !slice.panelList || !slice.panelList.open) return;
  const items = mpool.panelListItems(slice.arrange);
  const cursor = slice.panelList.cursor || 0;

  // Two visual sections separated by a blank line: placed (incl
  // essential), then hidden. Cursor lands on a single contiguous index
  // over the combined item list; we render the separator between the
  // last placed/essential and the first hidden.
  const lines = [];
  const placedCount = items.filter(it => it.status !== 'hidden').length;

  // Header row.
  lines.push('[dim]  status     id         type          title[/]');

  for (let i = 0; i < items.length; i++) {
    if (i === placedCount && placedCount > 0 && placedCount < items.length) {
      lines.push('');
      lines.push('[dim]  ── hidden (pool only) ──────────────────────[/]');
    }
    const it = items[i];
    const marker = it.status === 'essential'
      ? '[dim]●[/]'
      : it.status === 'placed'
        ? '[green]●[/]'
        : '[yellow]○[/]';
    const idCol    = esc(it.id).padEnd(10);
    const typeCol  = esc(it.type).padEnd(13);
    const titleCol = esc(it.title);
    const label = `${marker}  ${idCol} ${typeCol} ${titleCol}`;
    if (i === cursor) lines.push(`[reverse]> ${label}`);
    else              lines.push(`  ${label}`);
  }

  if (items.length === 0) {
    lines.push('  [dim]\\(pool is empty — should never happen)[/]');
  }

  // Footer hint
  lines.push('');
  const item = items[cursor];
  let hint = '[dim]\\[↑/↓] nav   \\[Enter] ';
  if (!item)                          hint += 'pick';
  else if (item.status === 'placed')  hint += 'hide';
  else if (item.status === 'hidden')  hint += 'show';
  else                                hint += '(essential — no-op)';
  hint += '   \\[Esc / w] close[/]';
  lines.push(hint);

  renderOverlay({
    lines,
    title: 'Panels',
    maxWidth: 60,
    count: items.length ? [cursor + 1, items.length] : undefined,
  });
}

module.exports = { renderPanelListOverlay };
