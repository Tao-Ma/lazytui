/**
 * Layout YAML serializer + write-back (v0.6.2 shape).
 *
 * Pure-function module — no module state, no side effects from
 * `serializeLayout`. `writeLayoutToFile` is the only thing that
 * touches disk. Split out of `design.js` so it can be called from
 * the `:save-layout` cmdline command (and any future caller) without
 * dragging design-mode state along.
 *
 * The hand-rolled YAML emitter (no third-party lib) is deliberate.
 * The output goes back through the YAML parser at load time; the
 * serializer just needs to produce valid YAML 1.2 that round-trips
 * losslessly for the keys we care about. JSON is a valid YAML 1.2
 * flow-style subset, so anything we can't trivially emit as block
 * style is dumped as JSON and the parser accepts it unchanged.
 *
 * v0.6.2 layout file shape: the top-level `panels:` block is the pool
 * (id → {type, title, ...config}); the `layout:` block has an ordered
 * `columns:` list. Each column is `{ width?: int, panels: [...] }`;
 * the last column's `width:` is implicit (it takes the remainder), so
 * the serializer omits it. Each layout cell is either:
 *   - a bare pool-id string (single-tab pane shorthand), or
 *   - a `{ tabs: [pool-id, ...], activeTab?, height?, heightPct?,
 *     collapsed? }` mapping (multi-tab pane or placement overrides).
 * The serializer always writes the pool block — the v0.6 legacy inline
 * form is retired (parser rejects it; CHANGELOG calls it out).
 *
 * Hotkeys are derived per-load by `parser/index.js#assignHotkeys` from
 * cell position + per-column hotkey pools, so they're never emitted on
 * cells (matches the v0.6 contract — round-trip is by position, not by
 * explicit key).
 */
'use strict';

const fs = require('fs');
const mpool = require('../leaves/pool');

// Bookkeeping fields on pool entries that never round-trip.
const POOL_RUNTIME_KEYS = new Set(['id', '_synthesized']);

// Keys that lead each pool-entry block for diff-stable readability.
const PRIORITY_KEYS = ['type', 'title'];

/**
 * Emit a single YAML scalar/list value. Bare-identifier strings stay
 * bare (so `type: containers` doesn't gain ugly quotes); strings that
 * could be misinterpreted (whitespace, YAML reserved words, leading
 * digits) get JSON-quoted. JSON is a valid YAML 1.2 flow subset so
 * arrays / nested objects round-trip via `JSON.stringify`.
 */
function yamlValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') {
    // Identifier-shaped OR percentage scalar (`60%`, `7%`) — both YAML-
    // safe as plain scalars. The percent case keeps `height: 60%` from
    // gaining noisy quotes.
    const bareSafe = /^[A-Za-z_][\w./-]*$/.test(v) || /^\d+%$/.test(v);
    const reserved = /^(true|false|null|yes|no|on|off)$/i.test(v);
    if (bareSafe && !reserved) return v;
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    return '[' + v.map(yamlValue).join(', ') + ']';
  }
  return JSON.stringify(v);
}

/**
 * Serialize one v0.6 pool entry as a YAML mapping under the top-level
 * `panels:` block. Returns an array of lines. Skips bookkeeping keys
 * (`id`, `_synthesized`); placement-only fields don't live here so
 * there's nothing to filter for them at the pool layer.
 */
function serializePoolEntryYaml(entry, indent) {
  const lines = [];
  const pad = ' '.repeat(indent);
  const written = new Set(POOL_RUNTIME_KEYS);
  const flat = { type: entry.type, title: entry.title, ...(entry.config || {}) };
  for (const k of PRIORITY_KEYS) {
    if (flat[k] !== undefined) { lines.push(`${pad}${k}: ${yamlValue(flat[k])}`); written.add(k); }
  }
  for (const k of Object.keys(flat)) {
    if (written.has(k)) continue;
    lines.push(`${pad}${k}: ${yamlValue(flat[k])}`);
  }
  return lines;
}

/**
 * Serialize the top-level `panels:` block. v0.6.1 always emits this
 * block — there's no legacy inline-form fallback to skip to. Entries
 * emit in pool insertion order so the file diff stays stable across
 * parse → serialize round-trips.
 */
function serializePanelsBlock(arrange) {
  const out = ['panels:'];
  const pool = (arrange && arrange.pool) || {};
  for (const [id, entry] of Object.entries(pool)) {
    out.push(`  ${id}:`);
    out.push(...serializePoolEntryYaml(entry, 4));
  }
  return out.join('\n');
}

/**
 * Serialize one layout CELL — pane shape, pool-ref form.
 *
 * Bare-string single-tab shorthand when the pane has exactly one tab
 * and no placement overrides; mapping form otherwise. `activeTab` is
 * omitted when it equals `tabs[0]` (the parser's default). Detail
 * height piggybacks on the cell whose active tab kind is `detail` —
 * `arrange.detailHeightPct` is the source of truth.
 *
 * Hotkey is intentionally not emitted — the parser re-derives it from
 * cell position + per-side pool at load time.
 *
 * Caller picks `indent` for the bullet column.
 */
function serializeLayoutCell(pane, indent, opts = {}) {
  const pad = ' '.repeat(indent);
  const firstPad = pad.slice(0, -2) + '- ';

  // Tab pool-ids. Wide-intermediate-form panes carry `tabs: [{id, poolId}]`;
  // fall back to the legacy single-tab pane id for fixtures that bypass
  // wrapAsPane.
  let tabIds = (pane.tabs || []).map(t => t.poolId);
  if (tabIds.length === 0 && pane.id) tabIds = [pane.id];
  const activeTabId = pane.activeTabId || tabIds[0];

  // Placement overrides — pane-level fields lifted onto the cell.
  const overrides = {};
  if (pane.heightPct !== undefined) overrides.heightPct = pane.heightPct;
  if (pane.collapsed === true)      overrides.collapsed = true;
  // Detail height: source from arrange.detailHeightPct, attach to the
  // pane whose active tab kind is detail. Mirrors the parser, which
  // only honors `height:` when the active tab is detail.
  if (mpool.isDetailPane(pane) && opts.detailHeightPct !== undefined) {
    overrides.height = `${opts.detailHeightPct}%`;
  }

  const isMulti = tabIds.length > 1;
  const emitActive = isMulti && activeTabId !== tabIds[0];
  const overrideKeys = Object.keys(overrides);
  const hasOverrides = overrideKeys.length > 0;

  // Bare-string shorthand: single-tab pane, no overrides.
  if (!isMulti && !hasOverrides) {
    return [`${firstPad}${tabIds[0]}`];
  }

  // Mapping form. `tabs:` always present — it's the disambiguator from
  // the bare-string shorthand.
  const tabsList = '[' + tabIds.map(yamlValue).join(', ') + ']';
  const lines = [`${firstPad}tabs: ${tabsList}`];
  if (emitActive) lines.push(`${pad}activeTab: ${yamlValue(activeTabId)}`);
  for (const k of overrideKeys) {
    lines.push(`${pad}${k}: ${yamlValue(overrides[k])}`);
  }
  return lines;
}

/**
 * Serialize the full `layout:` block — ordered `columns:` list of
 * `{width?, panels: [...]}` entries. The last column's `width:` is
 * omitted (it takes the remainder). Pool-ref cells throughout (string
 * id or `{ tabs: [...], ...overrides }`). Pure function — takes a
 * layout struct, returns a string.
 */
function serializeLayout(layout) {
  const out = ['layout:'];
  out.push('  columns:');
  const columns = layout.columns || [];
  const lastIdx = columns.length - 1;
  for (let ci = 0; ci < columns.length; ci++) {
    const col = columns[ci];
    const isLast = ci === lastIdx;
    out.push('    -');
    if (!isLast && col.width != null) {
      out.push(`      width: ${col.width}`);
    }
    out.push('      panels:');
    for (const p of (col.panels || [])) {
      out.push(...serializeLayoutCell(p, 10, { detailHeightPct: layout.detailHeightPct }));
    }
  }
  return out.join('\n');
}

/**
 * Write the current layout back to the YAML config file, replacing
 * just the `panels:` and `layout:` blocks (preserves comments and
 * other top-level blocks). Returns `{ error }` — error is null on
 * success, an Error on read/write failure. Caller decides what to do
 * with errors (typically: surface in the detail panel, leave dirty
 * flag set).
 *
 * Detection of the existing blocks uses a line-based approach: find
 * `^panels:` / `^layout:`, find the next top-level key, splice. Works
 * on flat YAML; doesn't try to be a structural editor.
 */
function _findBlockRange(lines, name) {
  const headerRe = new RegExp(`^${name}:`);
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i])) { start = i; }
    else if (start >= 0 && end < 0 && /^\S/.test(lines[i]) && i > start) { end = i; }
  }
  if (start < 0) return null;
  if (end < 0) end = lines.length;
  while (end > start && lines[end - 1].trim() === '') end--;
  return [start, end];
}

function writeLayoutToFile(arrange, configPath) {
  const newLayoutYaml = serializeLayout(arrange);
  const newPoolYaml = serializePanelsBlock(arrange);
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    let lines = content.split('\n');

    // 1) Splice/insert the `panels:` block (the v0.6.1 pool).
    const poolRange = _findBlockRange(lines, 'panels');
    if (poolRange) {
      lines.splice(poolRange[0], poolRange[1] - poolRange[0], newPoolYaml);
    } else {
      // Insert before `layout:` if present, else before `groups:`,
      // else append. Keeps file order: panels → layout → groups.
      const layoutIdx = lines.findIndex(l => /^layout:/.test(l));
      const groupsIdx = lines.findIndex(l => /^groups:/.test(l));
      const insertAt = layoutIdx >= 0 ? layoutIdx
                      : groupsIdx >= 0 ? groupsIdx
                      : lines.length;
      if (insertAt < lines.length) lines.splice(insertAt, 0, newPoolYaml, '');
      else                          lines.push('', newPoolYaml);
    }

    // 2) Splice/insert the `layout:` block. Re-find since line indices
    // shifted after the panels splice.
    const layoutRange = _findBlockRange(lines, 'layout');
    if (layoutRange) {
      lines.splice(layoutRange[0], layoutRange[1] - layoutRange[0], newLayoutYaml);
    } else {
      const groupsIdx = lines.findIndex(l => /^groups:/.test(l));
      if (groupsIdx >= 0) {
        lines.splice(groupsIdx, 0, newLayoutYaml, '');
      } else {
        lines.push('', newLayoutYaml);
      }
    }

    fs.writeFileSync(configPath, lines.join('\n'));
    return { error: null };
  } catch (e) {
    return { error: e };
  }
}

module.exports = {
  serializeLayout,
  serializeLayoutCell,
  serializePanelsBlock,
  serializePoolEntryYaml,
  yamlValue,
  writeLayoutToFile,
};
