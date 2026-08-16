/**
 * Metrics extractor — the pure half of the `metrics:` producer
 * (docs/metrics-producer.md §6). Turns a command's stdout into hub rows.
 *
 *   extract(stdout, spec, schemaColumns) -> [{ rowKey, sample }]
 *
 * PURE: no IO, no clock, no module state — the producer Sub kind
 * (app/state.js `metrics-poll`) runs the command off-tick and hands the
 * captured stdout here. Unit-testable without spawning anything.
 *
 * Two modes:
 *   regex   — single stream (rowKey '_'): each field's pattern captures a
 *             value from stdout.
 *   columns — multi-row: each non-skipped line is split on `delimiter`;
 *             each field reads a 0-based column; `row_key` names the field
 *             whose raw value identifies the row.
 *
 * Coercion is driven by the SCHEMA column type (single source of truth —
 * `extract.fields` says WHERE a value is; `schema.columns[f].type` says
 * HOW to coerce it). Generalizes docker.js's `parsePercent` / `parseBytes`.
 */
'use strict';

// Human byte sizes. Bare K/M/G (docker `MemUsage` style) are binary, matching
// docker.js's parser; the explicit *iB forms are binary, the *B forms decimal.
const _BYTE_UNITS = {
  b: 1,
  kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
  kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
  k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4,
};

function parseBytes(s) {
  if (s == null) return NaN;
  // Anchored at both ends: a grouped/garbage value ("1,258,291") must NOT match
  // and silently truncate to its first group (1) — it yields NaN (renders '—'),
  // a visible gap instead of a misleadingly-small number.
  const m = String(s).trim().match(/^([\d.]+)\s*([a-zA-Z]+)?$/);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return NaN;
  const unit = (m[2] || 'b').toLowerCase();
  const mult = _BYTE_UNITS[unit];
  return mult ? n * mult : NaN;
}

function parsePercent(s) {
  if (s == null) return NaN;
  const m = String(s).trim().match(/^([\d.]+)\s*%?$/);
  return m ? parseFloat(m[1]) : NaN;
}

function parseNumber(s) {
  if (s == null) return NaN;
  const t = String(s).trim();
  // Strict single numeric token. parseFloat would truncate "1,024"→1 or "1 2"→1
  // (a silent wrong number); prefer NaN → '—' over a misleadingly-small value.
  return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(t) ? parseFloat(t) : NaN;
}

/**
 * Coerce one raw captured string by its schema column type. `string` passes
 * through (labels / row keys); everything else yields a Number (NaN on a bad
 * parse — the stats panel renders NaN as '—' and drops it from peak/avg).
 * Unknown/advisory types (e.g. 'rate' before its producer-side derivation
 * ships) fall through to numeric.
 */
function coerce(raw, type) {
  if (type === 'string') return raw == null ? '' : String(raw).trim();
  if (type === 'percent') return parsePercent(raw);
  if (type === 'bytes') return parseBytes(raw);
  // `counter` parses as a plain number (a monotonic tally); the producer derives
  // its rate downstream. `rate`/`duration`/unknown also fall through to numeric.
  return parseNumber(raw);
}

function _typeOf(cols, field) {
  const c = cols && cols[field];
  return (c && c.type) || 'number';
}

// regex mode — one row keyed '_'. Patterns compile multiline ('m') by default
// so `^`/`$` anchor to lines (useful for /proc-style text); a caller may pass a
// RegExp object to control flags. A bad pattern yields NaN, never throws.
function _extractRegex(stdout, fields, cols) {
  const sample = {};
  for (const [field, pat] of Object.entries(fields || {})) {
    let re;
    try { re = pat instanceof RegExp ? pat : new RegExp(pat, 'm'); }
    catch (_) { sample[field] = coerce(null, _typeOf(cols, field)); continue; }
    const m = re.exec(stdout);
    const raw = m ? (m[1] != null ? m[1] : m[0]) : null;
    sample[field] = coerce(raw, _typeOf(cols, field));
  }
  return [{ rowKey: '_', sample }];
}

// columns mode — one row per non-empty line. `delimiter`: 'whitespace' (default,
// splits on /\s+/), 'tab', or any literal string. `skip` drops leading (header)
// lines. `row_key` names the field whose raw column value is the rowKey; absent
// → single stream ('_').
function _extractColumns(stdout, spec, cols) {
  const delim = spec.delimiter === 'tab' ? '\t'
    : (spec.delimiter && spec.delimiter !== 'whitespace') ? spec.delimiter
    : null; // null → /\s+/
  const skip = spec.skip > 0 ? spec.skip : 0;
  const fields = spec.fields || {};
  const rowKeyField = spec.row_key;
  const out = [];
  const lines = String(stdout).split('\n').slice(skip);
  for (const rawLine of lines) {
    const raw = rawLine.replace(/\r$/, ''); // tolerate CRLF
    if (raw.trim() === '') continue;         // skip blank lines
    // Whitespace mode trims then splits on runs. An explicit delimiter splits the
    // RAW line — a whole-line trim would eat a leading/trailing empty field (e.g.
    // a leading tab), shifting every column left and corrupting the row key.
    const parts = delim === null
      ? raw.trim().split(/\s+/)
      : raw.split(delim).map(p => p.trim());
    let rowKey = '_';
    if (rowKeyField != null && fields[rowKeyField] != null) {
      const rk = parts[fields[rowKeyField]];
      if (rk == null || rk === '') continue; // no identity → skip the line
      rowKey = String(rk).trim();
    }
    const sample = {};
    for (const [field, idx] of Object.entries(fields)) {
      sample[field] = coerce(parts[idx], _typeOf(cols, field));
    }
    out.push({ rowKey, sample });
  }
  return out;
}

// Resolve a dotted/bracketed path against a parsed-JSON value. Accepts `$.a.b`,
// `a.b`, `a[0].b`, `a.0.b`, `a['k']`. A missing step yields undefined (→ coerce
// to NaN/'' → renders '—'), never throws. Dep-free — no jq / jsonpath lib.
function _getPath(obj, path) {
  if (obj == null || path == null) return undefined;
  const parts = String(path)
    .replace(/^\$\.?/, '')                        // strip a leading `$` / `$.`
    .replace(/\[(\d+)\]/g, '.$1')                 // a[0]      → a.0
    .replace(/\[['"]?([^\]'"]+)['"]?\]/g, '.$1')  // a['k']    → a.k
    .split('.').filter((s) => s !== '');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

// json mode — parse stdout as JSON, read each field by a dotted path. Single
// stream ('_') by default; with `row_key` set AND an array root (the parsed
// value, or `spec.root` pointing at an array), emit one row per element with
// each field path resolved WITHIN the element (mirrors columns mode's row_key).
// Bad JSON → no rows (a gap), never a throw.
function _extractJson(stdout, spec, cols) {
  let data;
  try { data = JSON.parse(stdout); } catch (_) { return []; }
  const fields = spec.fields || {};
  const root = spec.root != null ? _getPath(data, spec.root) : data;
  if (spec.row_key != null && Array.isArray(root)) {
    const out = [];
    for (const el of root) {
      const rk = _getPath(el, fields[spec.row_key]);
      if (rk == null || rk === '') continue;      // no identity → skip
      const sample = {};
      for (const [field, p] of Object.entries(fields)) sample[field] = coerce(_getPath(el, p), _typeOf(cols, field));
      out.push({ rowKey: String(rk).trim(), sample });
    }
    return out;
  }
  const sample = {};
  for (const [field, p] of Object.entries(fields)) sample[field] = coerce(_getPath(data, p), _typeOf(cols, field));
  return [{ rowKey: '_', sample }];
}

function extract(stdout, spec, schemaColumns) {
  if (!spec || stdout == null || stdout === '') return [];
  const cols = schemaColumns || {};
  if (spec.mode === 'columns') return _extractColumns(stdout, spec, cols);
  if (spec.mode === 'json') return _extractJson(stdout, spec, cols);
  return _extractRegex(stdout, spec.fields, cols); // default / 'regex'
}

module.exports = { extract, coerce, parseBytes, parsePercent, parseNumber };
