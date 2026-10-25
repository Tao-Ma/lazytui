/**
 * Pure leaf — parse a `choices_cmd:` stdout buffer into {items, labels}.
 *
 * Called from `feature/choices-cmd-runtime.js` after the child's stdout has
 * been collected. Kept purely data-in-data-out so a parser test can drive it
 * without a process spawn.
 *
 * Rules (brief §3.2):
 *   - Normalize CRLF → LF; split on LF.
 *   - Drop fully empty lines (any position — leading, interior, trailing).
 *     An empty line would render as a blank unselectable row.
 *   - When `labeled: false`: each surviving line is a value; label = value.
 *   - When `labeled: true`: split each line on the FIRST \t.
 *       - `value\tlabel` → { value, label }
 *       - no \t on the line → label falls back to value (whole line is the value).
 *       - subsequent \t characters are KEPT in the label but replaced with a
 *         single space on render-side normalization (a literal \t in a row
 *         would emit a horizontal-tab escape that re-anchors paint columns,
 *         same hazard choices-fn-runtime's _stripRowBreaks defends against).
 *   - Any \r / \n that survives inside a label (shouldn't happen after the
 *     LF split, but defensive) is replaced with a space.
 *
 * Return shape MATCHES `fabric_form_choices_resolved` payload: `{items,
 * labels, truncated}`. `error` is set by the caller (the runtime) when the
 * child exited non-zero / timed out / was aborted. `labels` is null when
 * `labeled: false` so the reducer arm treats the field like a `choices_fn:`
 * string[] return.
 */
'use strict';

// Replace any \r / \n / \t with a single space. The LF split above has
// already consumed line-terminators, but a label may legitimately contain
// a tab (opt-in splitting consumes only the FIRST tab) — the paint path
// would misalign on a literal \t, so we flatten before storing.
function _flatten(s) {
  return typeof s === 'string' ? s.replace(/[\r\n\t]+/g, ' ') : s;
}

/**
 * @param {string} stdout   The child's stdout buffer, utf-8 decoded.
 * @param {object} opts     { labeled: boolean }
 * @returns {{items: string[], labels: string[]|null}}
 */
function parseChoicesStdout(stdout, opts) {
  const labeled = !!(opts && opts.labeled);
  if (typeof stdout !== 'string') return { items: [], labels: null };
  // Shape-asymmetry defense: a labeled fetch whose command produced no output
  // (e.g. `grep` matching nothing) would otherwise return `labels: []`, while
  // the fn-channel's empty-return produces `labels: null`. One state (no
  // labels) should hash to one shape in the WAL. Normalize at the exit.
  // Falls through to the normal path for labeled stdout with content.
  // Normalize line terminators THEN split. A lone \r (classic-Mac style) is
  // not expected from any modern shell, but CRLF from a Windows-side jq /
  // from a user who piped through `unix2dos | ...` by mistake is realistic
  // enough to normalize.
  const normalized = stdout.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const items = [];
  const labels = labeled ? [] : null;
  for (const raw of lines) {
    if (raw === '') continue;                            // drop empty rows
    if (!labeled) {
      // _flatten here collapses an interior \t to space (unlikely but
      // defensive — the item would otherwise paint a stray HT escape).
      items.push(_flatten(raw));
      continue;
    }
    const tabIdx = raw.indexOf('\t');
    if (tabIdx < 0) {
      // Labeled line without a tab — label falls back to value. Authors
      // building mixed lists aren't punished for occasionally skipping
      // the label.
      const v = _flatten(raw);
      items.push(v);
      labels.push(v);
      continue;
    }
    const value = raw.slice(0, tabIdx);
    const label = raw.slice(tabIdx + 1);
    items.push(_flatten(value));
    labels.push(_flatten(label));
  }
  // Normalize labeled-but-empty → labels:null so the WAL/replay shape matches
  // the fn-channel's empty-return convention (one state → one shape).
  if (labeled && items.length === 0) return { items, labels: null };
  return { items, labels };
}

module.exports = { parseChoicesStdout };
