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

// Runtime-only keys derived from layout position / plugin spread;
// never written back to YAML.
const RUNTIME_KEYS = new Set(['hotkey', 'column', 'config']);

// Keys that get emitted on their own line at the top of each panel
// block for diff-stable readability.
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
    const bareSafe = /^[A-Za-z_][\w./-]*$/.test(v);
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
 * Serialize the full `layout:` block. Pure function — takes a layout
 * struct, returns a string. Test-friendly (no fs, no module state).
 */
function serializeLayout(layout) {
  const out = ['layout:'];
  out.push('  left:');
  out.push(`    width: ${layout.leftWidth}`);
  out.push('    panels:');
  for (const p of layout.leftPanels) {
    out.push(...serializePanelYaml(p, 8, { detailHeightPct: layout.detailHeightPct }));
  }
  out.push('  right:');
  out.push('    panels:');
  for (const p of layout.rightPanels) {
    out.push(...serializePanelYaml(p, 8, { detailHeightPct: layout.detailHeightPct }));
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
function writeLayoutToFile(layout, configPath) {
  const newLayoutYaml = serializeLayout(layout);
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const lines = content.split('\n');

    let layoutStart = -1;
    let layoutEnd = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^layout:/.test(lines[i])) {
        layoutStart = i;
      } else if (layoutStart >= 0 && layoutEnd < 0 && /^\S/.test(lines[i]) && i > layoutStart) {
        layoutEnd = i;
      }
    }

    if (layoutStart >= 0) {
      if (layoutEnd < 0) layoutEnd = lines.length;
      while (layoutEnd > layoutStart && lines[layoutEnd - 1].trim() === '') layoutEnd--;
      lines.splice(layoutStart, layoutEnd - layoutStart, newLayoutYaml);
    } else {
      // No existing layout block — insert one before `groups:` if
      // present, otherwise append.
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
  yamlValue,
  writeLayoutToFile,
};
