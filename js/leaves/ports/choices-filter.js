/**
 * Pure "narrow a choices list to the rows whose value OR label contains
 * `filter`" leaf for the type-to-filter popover (Brief 2 of v0.6.43).
 *
 * Shared between:
 *   - the fabric-form reducer (nav clamp + resolved-reply clamp read the
 *     FILTERED length so idx doesn't drift past the visible rows);
 *   - dispatch.js (Enter in the popover resolves the picked VALUE by
 *     looking up the filtered rows at `picking.idx`, not the raw list);
 *   - overlay/fabric-form.js (paints the filtered rows + a "no match"
 *     row + the `/<filter>` affordance line).
 *
 * One home prevents the drift class the TUI already paid for twice —
 * the choices-channels sibling drift (v0.6.37 cwd parity) and the
 * `[last]` chip drift (Brief 1 above). Three sites, one truth source.
 *
 * Match rules:
 *   - Case-insensitive (JS String#toLowerCase; Unicode case folding is
 *     good enough for the Latin / Greek / Cyrillic names a port name's
 *     popover tends to list — not full Unicode Default Case Folding,
 *     which would require a dependency).
 *   - Substring (indexOf !== -1), NOT prefix: a user filtering a long
 *     subdomain list for `prod` wants `api-prod-east`, `db-prod-west`
 *     and `prod-cache` all to match. Brief: "multi-word labels are
 *     reachable without typing spaces".
 *   - Matches the VALUE and (if labeled) the LABEL — a labeled list
 *     filters on what the user actually sees. A row survives if EITHER
 *     string contains the filter.
 *   - Empty filter is the identity.
 *
 * Pure leaf: data-in / data-out, no I/O. The caller is responsible for
 * passing items/labels arrays of equal length when `labels` is non-null
 * (the fabric-form reducer already enforces this via `_normalize` for
 * literal `choices:` and the choices-cmd runtime).
 */
'use strict';

/**
 * `items`: Array<string>, the raw candidate values; `labels`: Array<string>|null,
 * aligned with items when non-null; `filter`: string, the user-typed needle.
 * Returns { items, labels } where arrays are a filtered view of the inputs,
 * preserving relative order. Returns the inputs unmodified for an empty
 * filter so the caller can identity-check "did the view change?" cheaply.
 */
function filterChoices(items, labels, filter) {
  if (!Array.isArray(items)) return { items: [], labels: null };
  if (typeof filter !== 'string' || filter === '') {
    // Pre-release round-2 edge-case review — identity-passthrough preserves
    // the labels array even when empty (`[]`), so the shape round-trips
    // without `labels: []` becoming `labels: null`. Only coerce when the
    // caller actually passed a non-array null-ish.
    return { items, labels: Array.isArray(labels) ? labels : null };
  }
  const needle = filter.toLowerCase();
  const outItems = [];
  const outLabels = labels ? [] : null;
  for (let i = 0; i < items.length; i++) {
    const v = typeof items[i] === 'string' ? items[i] : '';
    const l = (labels && labels[i] != null) ? String(labels[i]) : '';
    if (v.toLowerCase().indexOf(needle) !== -1 || l.toLowerCase().indexOf(needle) !== -1) {
      outItems.push(items[i]);
      if (outLabels) outLabels.push(labels[i]);
    }
  }
  return { items: outItems, labels: outLabels };
}

module.exports = { filterChoices };
