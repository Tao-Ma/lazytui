/**
 * sort-control — the SORT SELECTOR border-control kind (`‹ cpu↓ ›`): a second
 * consumer of the top-border control strip (leaves/render/border-controls),
 * alongside the refresh control. Picks which column a sortable pane orders by,
 * and its direction.
 *
 * Like refresh-control this leaf owns the control's DATA + GEOMETRY (no state,
 * no I/O): the label composition, the markup + visible width, and the three
 * click regions — `‹` (prev column), the label (reverse direction), `›` (next
 * column). Both the painter (draw.js via renderPanel's `topControls`) and the
 * hit-test (panel/chrome-hittest) derive positions from HERE so they can't drift.
 *
 * The per-pane sort STATE lives in the nav leaf (`nav.sort {key,dir}`, the twin
 * of `nav.filter`) and is applied centrally in api.getItems — so render, the
 * reducer's item list, and hit-testing all see one ordered list.
 */
'use strict';

const { visibleLen } = require('../text/ansi');

// Label shown when a pane is in its native (config / insertion) order — nothing
// sorted yet. Deliberately compact + neutral. Direction glyphs for a live sort.
const NONE_LABEL = '·';
const ASC = '↑';
const DESC = '↓';

// Cell padding around the label: `‹ ` on the left, ` ›` on the right.
const _PAD_CELLS = 4;

/** The control markup + its visible cell width. `‹`/`›` dimmed; `label` is the
 *  current column (+ a direction glyph) or NONE_LABEL when unsorted. Width =
 *  label + the `‹ ` / ` ›` padding (same shape as the refresh control). */
function sortControlText(label) {
  return { text: `[dim]‹[/] ${label} [dim]›[/]`, visibleW: visibleLen(label) + _PAD_CELLS };
}

/** The three click regions given the control's leftmost cell (x0) + row (y):
 *  `‹` prev (2 cells), the label span (reverse), `›` next (2 cells). Mirrors the
 *  refresh control's 2-cell end buttons; the label fills the middle. Inclusive
 *  ranges, tagged with an opaque `action` the spec's dispatch interprets. */
function sortControlHits(x0, y, visibleW) {
  return [
    { x0, x1: x0 + 1, y, action: 'prev' },
    { x0: x0 + 2, x1: x0 + visibleW - 3, y, action: 'reverse' },
    { x0: x0 + visibleW - 2, x1: x0 + visibleW - 1, y, action: 'next' },
  ];
}

/**
 * A BORDER-CONTROL SPEC for the sort selector — the sort KIND packaged for the
 * generic strip. A pane registers this in `panelTypes[type].borderControls`;
 * the framework renders + hit-tests it without knowing it's "the sort control".
 * PER-PANE (unlike the host-global refresh control): render + dispatch key off
 * the specific pane (`pane.paneId`), so two panes sort independently.
 *
 * @param {{key:string,label:string}[]} keys - the pane's sortable columns, order = cycle order
 * @param {(paneId:string)=>{key,dir}} getSort - reads a pane's committed sort
 * @returns {{ id, render, regions, dispatch }}
 *   - render(model, pane) → { text, visibleW } | null   (null in free-config)
 *   - regions(x0, y, visibleW) → [{ x0, x1, y, action }]  action ∈ prev|reverse|next
 *   - dispatch(action, pane) → { owner, msg }            owner = pane.paneId
 */
function sortControlSpec({ keys, getSort }) {
  // Cycle: native order first (key=null), then each declared column. `‹`/`›`
  // walk this ring; `reverse` flips direction (a no-op while unsorted).
  const cycle = [null, ...keys.map(k => k.key)];
  const labelOf = (sort) => {
    if (!sort || !sort.key) return NONE_LABEL;
    const k = keys.find(x => x.key === sort.key);
    return `${(k && k.label) || sort.key}${sort.dir < 0 ? DESC : ASC}`;
  };
  return {
    id: 'sort',
    render(model, pane) {
      if (model && model.modes && model.modes.freeConfigMode) return null;
      return sortControlText(labelOf(getSort(pane.paneId)));
    },
    regions(x0, y, visibleW) {
      return sortControlHits(x0, y, visibleW);
    },
    dispatch(action, pane) {
      if (action === 'reverse') {
        return { owner: pane.paneId, msg: { type: 'sort_reverse', panel: pane.type } };
      }
      const cur = getSort(pane.paneId) || { key: null, dir: 1 };
      const i = Math.max(0, cycle.indexOf(cur.key));
      const d = action === 'next' ? 1 : -1;
      const key = cycle[(i + d + cycle.length) % cycle.length];
      return { owner: pane.paneId, msg: { type: 'set_sort', panel: pane.type, key } };
    },
  };
}

module.exports = { sortControlText, sortControlHits, sortControlSpec, NONE_LABEL, ASC, DESC };
