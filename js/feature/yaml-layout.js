/**
 * Layout YAML serializer + write-back.
 *
 * Pure-function module — no module state, no side effects from
 * `serializeLayout`. `writeLayoutToFile` is the only thing that
 * touches disk. Split out of `design.js` so it can be called from
 * the `:save-layout` cmdline command (and any future caller) without
 * dragging design-mode state along.
 *
 * The hand-rolled YAML emitter (no third-party lib) is deliberate.
 * The output goes back through the Python parser at load time; the
 * serializer just needs to produce valid YAML 1.2 that round-trips
 * losslessly for the keys we care about. JSON is a valid YAML 1.2
 * flow-style subset, so anything we can't trivially emit as block
 * style is dumped as JSON and the parser accepts it unchanged.
 *
 * Design Mode used to drop every panel key except `type`, `title`,
 * and (for the detail panel) `height` — a silent data-loss footgun
 * on any config with plugin panel options (`topic`, `select_from`,
 * `decorators`, `refresh_interval_ms`, etc.). This serializer
 * preserves every key on the runtime panel object except:
 *   - hotkey   — derived per-load by state.js from position
 *   - column   — derived per-load from which array the panel is in
 *   - config   — already spread onto the panel object at parse time
 *                (state.js: `...(p.config || {})`), so re-emitting
 *                would double-nest
 *
 * For the detail panel, `height` is synthesized from the layout-level
 * `detailHeightPct` rather than the panel object (which doesn't carry
 * it).
 */
'use strict';

const fs = require('fs');
const mpool = require('../leaves/pool');

// Runtime-only keys derived from layout position / plugin spread;
// never written back to YAML. `id` is here so legacy inline cells
// don't leak it — in inline form the parser auto-derives id from
// type at load, so emitting it would (a) re-parse as a non-synth
// pool entry, breaking idempotency, and (b) is redundant noise.
// Explicit ids belong in the v0.6 `panels:` block, not on cells.
const RUNTIME_KEYS = new Set(['hotkey', 'column', 'config', 'id']);

// Keys that get emitted on their own line at the top of each panel
// block for diff-stable readability.
const PRIORITY_KEYS = ['type', 'title'];

// v0.6 pool entry keys. The pool serializer treats `type` + `title` as
// priority; `id` is the mapping key (not a body key); `_synthesized`
// is parser bookkeeping; placement-only keys never appear here.
const POOL_RUNTIME_KEYS = new Set(['id', '_synthesized']);

/**
 * Decide whether the v0.6 `panels:` block needs to be written. True iff
 * the pool has at least one entry the legacy inline form can't express:
 *   - a user-declared (non-synthesized) entry → must preserve
 *   - a hidden entry (in pool but not placed) → must write to survive reload
 * Otherwise (every entry is synthesized AND placed) the legacy form is
 * sufficient and we keep the file looking like v0.5.
 */
function shouldWritePool(arrange) {
  if (!arrange || !arrange.pool) return false;
  const placed = new Set(mpool.placedIds(arrange));
  for (const [id, entry] of Object.entries(arrange.pool)) {
    if (entry && entry._synthesized === false) return true;
    if (entry && !('_synthesized' in entry))   return true;   // defensive
    if (!placed.has(id)) return true;
  }
  return false;
}

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
    // gaining noisy quotes (v0.5 emitted `height` raw; preserve that).
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
 * Serialize one panel to YAML lines. Caller controls indentation
 * (passes `indent` = column where the keys live; the leading `-`
 * sits at `indent - 2`). Returns an array of lines.
 *
 * `opts.detailHeightPct` is required when emitting a detail panel —
 * it synthesizes `height: N%` since the panel object doesn't carry
 * height directly.
 */
function serializePanelYaml(panel, indent, opts = {}) {
  const lines = [];
  const pad = ' '.repeat(indent);
  const firstPad = pad.slice(0, -2) + '- ';
  const written = new Set(RUNTIME_KEYS);

  let first = true;
  const emit = (k, v) => {
    lines.push(`${first ? firstPad : pad}${k}: ${v}`);
    first = false;
    written.add(k);
  };

  for (const k of PRIORITY_KEYS) {
    if (panel[k] !== undefined) emit(k, yamlValue(panel[k]));
  }
  // Detail panel: synthesize height from layout-level detailHeightPct.
  if (panel.type === 'detail' && opts.detailHeightPct !== undefined) {
    emit('height', `${opts.detailHeightPct}%`);
    written.add('height');
  }
  // Every other key on the panel, in insertion order.
  for (const k of Object.keys(panel)) {
    if (written.has(k)) continue;
    emit(k, yamlValue(panel[k]));
  }
  return lines;
}

/**
 * Serialize one v0.6 pool entry as a YAML mapping under the top-level
 * `panels:` block. Returns an array of lines. Skips bookkeeping keys
 * (`id`, `_synthesized`) and placement-only fields.
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
 * Serialize the top-level `panels:` block. Returns the string OR null
 * when the pool block isn't needed (legacy inline form covers everything).
 * Entries emitted in pool insertion order so the file diff stays stable.
 */
function serializePanelsBlock(arrange) {
  if (!shouldWritePool(arrange)) return null;
  const out = ['panels:'];
  for (const [id, entry] of Object.entries(arrange.pool)) {
    out.push(`  ${id}:`);
    out.push(...serializePoolEntryYaml(entry, 4));
  }
  return out.join('\n');
}

/**
 * Serialize a layout CELL when the pool is being written separately.
 * Cells become string id-refs (no overrides) OR a mapping when
 * placement-level keys exist (heightPct for any panel; height for
 * detail). Caller picks `indent` for the bullet column.
 */
function serializeLayoutCellPoolForm(panel, indent, opts = {}) {
  const pad = ' '.repeat(indent);
  const firstPad = pad.slice(0, -2) + '- ';
  const placement = {};
  if (panel.heightPct !== undefined) placement.heightPct = panel.heightPct;
  if (panel.collapsed === true)      placement.collapsed = true;
  if (panel.type === 'detail' && opts.detailHeightPct !== undefined) {
    placement.height = `${opts.detailHeightPct}%`;
  }
  const placementKeys = Object.keys(placement);
  if (placementKeys.length === 0) {
    return [`${firstPad}${panel.id}`];
  }
  // Mapping form: { id: foo, ...overrides }
  const lines = [`${firstPad}id: ${yamlValue(panel.id)}`];
  for (const k of placementKeys) lines.push(`${pad}${k}: ${yamlValue(placement[k])}`);
  return lines;
}

/**
 * Serialize the full `layout:` block — legacy inline form (every cell
 * is `{ type, title, ...config }`) when the pool isn't being written,
 * v0.6 id-ref form (string id or `{id, ...placement}`) when it is.
 * Pure function — takes a layout struct, returns a string.
 */
function serializeLayout(layout) {
  const usePool = shouldWritePool(layout);
  const out = ['layout:'];
  out.push('  left:');
  out.push(`    width: ${layout.leftWidth}`);
  out.push('    panels:');
  for (const p of layout.leftPanels) {
    out.push(...(usePool
      ? serializeLayoutCellPoolForm(p, 8, { detailHeightPct: layout.detailHeightPct })
      : serializePanelYaml(p, 8, { detailHeightPct: layout.detailHeightPct })));
  }
  out.push('  right:');
  out.push('    panels:');
  for (const p of layout.rightPanels) {
    out.push(...(usePool
      ? serializeLayoutCellPoolForm(p, 8, { detailHeightPct: layout.detailHeightPct })
      : serializePanelYaml(p, 8, { detailHeightPct: layout.detailHeightPct })));
  }
  return out.join('\n');
}

/**
 * Write the current layout back to the YAML config file, replacing
 * just the `layout:` block (preserves comments and other top-level
 * blocks). Returns `{ error }` — error is null on success, an Error
 * on read/write failure. Caller decides what to do with errors
 * (typically: surface in the detail panel, leave dirty flag set).
 *
 * Detection of the existing `layout:` block uses the same line-based
 * approach as the prior design.js implementation: find `^layout:`,
 * find the next top-level key, splice. Works on flat YAML; doesn't
 * try to be a structural editor.
 */
/** Find the [start, end) line range for a top-level YAML block whose
 *  header line matches `^<name>:` (e.g. "layout:", "panels:"). End is
 *  the line of the next top-level key, with trailing blank lines
 *  trimmed off the range. Returns null when the block isn't found. */
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
  const newPoolYaml = serializePanelsBlock(arrange);  // null when not needed
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    let lines = content.split('\n');

    // 1) Splice/remove the `panels:` block (the v0.6 pool).
    const poolRange = _findBlockRange(lines, 'panels');
    if (newPoolYaml !== null) {
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
    } else if (poolRange) {
      // Pool no longer needed (all entries placed + synthesized) — drop
      // the block plus one trailing blank if it leaves one behind.
      let [s, e] = poolRange;
      if (e < lines.length && lines[e].trim() === '') e++;
      lines.splice(s, e - s);
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
  serializePanelYaml,
  serializePanelsBlock,
  serializePoolEntryYaml,
  serializeLayoutCellPoolForm,
  shouldWritePool,
  yamlValue,
  writeLayoutToFile,
};
