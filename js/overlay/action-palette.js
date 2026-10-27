/**
 * Fuzzy action palette overlay (v0.6.44 Brief 2) — the render + hit-test
 * half of `js/dispatch/update/modal/palette.js` + the dispatch wiring in
 * `js/dispatch/control/dispatch.js#handlePaletteKey`.
 *
 * Paints a centered list of every `group:action` discoverable through
 * `iterActions` (from `js/app/cli.js` — the SAME walker the CLI uses
 * for `--list` and `--complete`, so the palette and shell completion
 * can't drift). The user types to narrow via the SHARED
 * `js/leaves/ports/choices-filter.js` leaf, Up/Down nav, Enter picks
 * through the standard invoke path.
 *
 * Shape mirrors the v0.6.43 fabric-form choices popover:
 *   - `/<filter>` row above the list when the filter is non-empty.
 *   - `(no match)` row when the filter kills every candidate (Enter on
 *     that row no-ops; the palette_pick msg carries no groupPath so the
 *     reducer closes without emitting a run cmd).
 *   - Help line swaps `[esc] close` ↔ `[esc] clear filter` so the
 *     two-step escape is self-documenting.
 */
'use strict';

const { getModel } = require('../model/store');
const { renderOverlay, viewportDims } = require('../leaves/render/draw');
const { esc } = require('../leaves/text/ansi');
const { filterChoices } = require('../leaves/ports/choices-filter');
const { windowSlice } = require('../leaves/render/window-slice');

const PALETTE_MAX_WIDTH = 72;

// Injected-seam config accessors — the single walker shell completion uses
// (iterActions + resolveAction, exported from `js/app/cli.js:446`). Wired at
// boot via `setConfigAccessors` so the overlay layer never imports upward
// into `app/` (dep-layering gate `test-dep-layering.js` would catch an
// overlay → app require as a layer-cycle regression). The dispatch handler
// (`handlePaletteKey`) + the `palette_run_action` effect handler both read
// through this seam, so the palette and `--list` / `--complete` stay
// byte-identical on the row set — but the overlay module's require graph
// stays leaf-ward only.
let _iterActions = null;
let _resolveAction = null;
function setConfigAccessors(accessors) {
  if (!accessors || typeof accessors.iterActions !== 'function'
                 || typeof accessors.resolveAction !== 'function') {
    throw new Error('setConfigAccessors({iterActions, resolveAction}) requires both functions');
  }
  _iterActions = accessors.iterActions;
  _resolveAction = accessors.resolveAction;
}

/**
 * Walk `model.config` → the FULL (unfiltered) rows, in the same order
 * iterActions emits them. Returned shape per row:
 *   { path: 'group:action', groupPath, actionKey, label, desc }
 * `path` is the fuzzy-filter needle (user filters on path + label).
 * Returns `[]` when the walker hasn't been wired yet (pre-boot) OR
 * when the config is absent (safe default — paints an empty palette
 * instead of crashing).
 */
function _collectRows(config) {
  if (!_iterActions || !config) return [];
  const rows = [];
  for (const { path, action } of _iterActions(config)) {
    const colon = path.indexOf(':');
    const groupPath = colon > 0 ? path.slice(0, colon) : path;
    const actionKey = colon > 0 ? path.slice(colon + 1) : '';
    rows.push({
      path,
      groupPath,
      actionKey,
      label: (action && action.label) || '',
      desc:  (action && action.desc) || '',
    });
  }
  return rows;
}

/**
 * Re-resolve a (groupPath, actionKey) pair against the LIVE config via
 * the injected resolver — called by the `palette_run_action` effect
 * handler so a config_swap racing the Msg → Cmd window gracefully drops
 * the pick instead of running a stale action. Returns the same
 * `{ groupPath, actionKey, action }` shape resolveAction yields, or
 * `{ error }` on miss / unwired accessors.
 */
function resolve(config, groupPath, actionKey) {
  if (!_resolveAction) return { error: 'palette: config accessors not wired' };
  if (!config) return { error: 'palette: no config' };
  return _resolveAction(config, `${groupPath}:${actionKey}`);
}

/**
 * Filter rows through the shared choices-filter leaf. The leaf matches
 * on value AND label — we pass `path` as value + `label` as label, so
 * typing matches either side. Returns the filtered row objects (not just
 * strings), preserved from the input array.
 */
function filteredRows(rows, filter) {
  const items  = rows.map(r => r.path);
  const labels = rows.map(r => r.label);
  const view = filterChoices(items, labels, filter);
  // Reconstruct row objects by looking up each surviving item back into
  // the original array. Equal-length arrays; the leaf preserves order.
  const out = [];
  let j = 0;
  for (let i = 0; i < rows.length && j < view.items.length; i++) {
    if (rows[i].path === view.items[j]) { out.push(rows[i]); j++; }
  }
  return out;
}

/**
 * Expose the current filtered view + the resolved pick for the dispatch
 * handler. Returns `{ rows, idx, picked }` where `picked` is the row at
 * `palette.idx` (clamped) or null when the view is empty.
 */
function currentView() {
  const model = getModel();
  const { filter, idx } = model.modal.palette;
  const rows = filteredRows(_collectRows(model.config), filter);
  if (rows.length === 0) return { rows, idx: 0, picked: null };
  const clamped = Math.max(0, Math.min(idx | 0, rows.length - 1));
  return { rows, idx: clamped, picked: rows[clamped] };
}

function _formatRow(row, cols) {
  // "group:action — label" with a dim desc suffix when there's room.
  // `cols` is the overlay inner width (minus the 2-cell indent + cursor
  // marker); shortened at the right by renderOverlay's truncation if we
  // overshoot (the drawn width is a hard max).
  const pathStr = esc(row.path);
  const parts = [pathStr];
  if (row.label) parts.push(`[dim]— ${esc(row.label)}[/]`);
  // Rough budget: don't paint the desc when the label already dominates
  // the row. Rendered width check is approximate (esc leaves escape chars
  // in) — renderOverlay/truncate is the real guard.
  const budget = cols - row.path.length - (row.label ? row.label.length + 4 : 0);
  if (row.desc && budget > 10) {
    parts.push(`[dim]· ${esc(row.desc)}[/]`);
  }
  return parts.join(' ');
}

function renderActionPalette() {
  const model = getModel();
  if (!model.modes.paletteMode) return;
  const { filter, idx } = model.modal.palette;
  const rows = filteredRows(_collectRows(model.config), filter);
  const total = rows.length;
  const clamped = Math.max(0, Math.min(idx | 0, Math.max(0, total - 1)));

  const lines = [];
  // `/<filter>` row above the list — v0.6.43 Brief 2 precedent. Shown
  // only when the filter is non-empty so an empty palette doesn't gain
  // a bare `/` line that reads as a stray stroke.
  if (filter) {
    // Pre-release concern from v0.6.43 Brief 2 was cosmetic double-`/`
    // when the user TYPES `/` into the filter. Here the leading `/` is
    // the affordance prefix; `esc(filter)` renders a user-typed `/`
    // literally so the row shows `//foo` when the needle is `/foo`.
    // Accept the cosmetic — the alternative is swallowing `/` as a
    // special key, which breaks filtering a path like `net/foo`.
    lines.push(`[dim]/[/]${esc(filter)}`);
  }

  if (total === 0) {
    // Pre-release round-2 edge-cases review — distinguish "the filter
    // killed every candidate" from "there are no actions at all" so an
    // operator opening the palette on an empty config doesn't think
    // they typed a bad needle. The all-row count is the discriminant.
    const allRows = _collectRows(model.config);
    if (allRows.length === 0 && !filter) {
      lines.push('[dim](no actions configured)[/]');
    } else {
      lines.push('[dim](no match)[/]');
    }
  } else {
    // v0.6.47 — scroll window. Pre-fix, the paint loop walked every row;
    // `renderOverlay` truncates by KEEPING the top of the lines array, so
    // on a tall list the `[reverse]>` marker walked off the bottom edge
    // once idx exceeded the overlay body height — the operator could
    // Enter-invoke a row they couldn't see. Shared math with the choices
    // popover (overlay/fabric-form.js) via leaves/render/window-slice so
    // the two type-to-filter lists can't drift again.
    //
    // Budget derivation: viewport rows − overlay chrome (borders +
    // outer margin, overlayBox clamps to ROWS-2 then renderPanel loses
    // 2 for top/bottom border = -4 total) − palette's own chrome rows
    // (the /<filter> row when non-empty + the blank + the help line = 2
    // or 3 fixed). Floor at 3 so a tiny terminal still shows SOMETHING;
    // on terminals smaller than 7 rows the overlay viewport will clip,
    // which is unavoidable without hiding chrome.
    const { rows: vpRows } = viewportDims();
    const filterChromeRows = filter ? 1 : 0;
    const fixedChrome = 2 + filterChromeRows;   // blank + help + filter-when-shown
    const budget = Math.max(3, (vpRows || 24) - 4 - fixedChrome);
    const win = windowSlice({ idx: clamped, total, budget });
    const cols = PALETTE_MAX_WIDTH - 4; // minus borders (2) + indent (2)
    for (let i = win.start; i < win.end; i++) {
      const row = _formatRow(rows[i], cols);
      lines.push(i === clamped ? `[reverse]> ${row}` : `  ${row}`);
    }
    if (win.overflow) {
      // Same inline affordance shape the choices popover uses, so a
      // user who's seen one recognizes the other. The header counter
      // (passed as `count` to renderOverlay below) carries the live
      // 1-based position; this row carries the window-sized "N of M"
      // plus the "↑/↓ to scroll" affordance.
      const shown = win.end - win.start;
      lines.push(`[dim]\\[${shown} of ${total} — ↑/↓ to scroll][/]`);
    }
  }

  // Help line. Two-step Esc: when filter is non-empty, first Esc clears
  // it; otherwise Esc closes the palette.
  lines.push('');
  const escHint = filter ? 'clear filter' : 'close';
  lines.push(`[dim]\\[↑/↓] nav   \\[enter] invoke   \\[type] filter   \\[esc] ${escHint}[/]`);

  renderOverlay({
    lines,
    title: 'Action palette',
    maxWidth: PALETTE_MAX_WIDTH,
    count: total ? [clamped + 1, total] : undefined,
  });
}

module.exports = {
  renderActionPalette, currentView, _collectRows, filteredRows,
  setConfigAccessors, resolve,
};
