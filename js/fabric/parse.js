/**
 * Declarative output parsing — a producer's raw slice text → a structured
 * record ONCE (the caller memoizes on slice identity); output ports then
 * project cheap fields off it. See docs/ports-and-wires.md, "Output ports —
 * parse once, project many" + decision 3.
 *
 * P1 parse kinds: { kv: {sep} } | { json: true } | { lines: true }. Plus the
 * per-port helpers projectFrom (key lookup) and compileExtract (the per-port
 * { regex, group } escape hatch). The DRY regex-TABLE (parse:{fields}) is a
 * P1.5 addition and lives elsewhere.
 *
 * Pure, zero-dependency leaf (js/fabric/). Compile-time errors (unknown kind,
 * malformed extract) throw — a config error surfaced at load. RUNTIME parse
 * failures (bad JSON) yield null so downstream projection is `undefined` and
 * the port reads as "no value" (readiness handles it), never a crash.
 */
'use strict';

/** Compile a `parse:` spec to `(text) => record`. Throws on unknown kind. */
function compileParse(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new Error(`fabric parse spec must be a mapping, got ${typeof spec}`);
  }
  if ('kv' in spec) {
    const sep = (spec.kv && spec.kv.sep) || ':';
    return (text) => parseKv(text, sep);
  }
  if (spec.json === true) {
    return (text) => { try { return JSON.parse(String(text == null ? '' : text)); } catch { return null; } };
  }
  if (spec.lines === true) {
    return (text) => splitLines(text);
  }
  if (spec.fields && typeof spec.fields === 'object' && !Array.isArray(spec.fields)) {
    // The DRY regex TABLE (P1.5) — `fields: { name: {regex, group?} }` compiles to
    // a record `{ name: value|null }`, one extractor per field. null marks a field
    // whose regex didn't match, which the component-ports pane's check-half renders
    // as ✗ no-match (the reason this exists beyond DRY — decision 3). Each field's
    // regex is validated (compiled) here, so a bad pattern is a load error.
    const compiled = Object.entries(spec.fields).map(([name, fspec]) => [name, compileExtract(fspec)]);
    return (text) => {
      const s = String(text == null ? '' : text);
      const out = {};
      for (const [name, fn] of compiled) out[name] = fn(s);
      return out;
    };
  }
  throw new Error(
    `fabric parse: unknown kind (expected kv / json / lines / fields) in ${JSON.stringify(spec)}`);
}

/** Split text into lines, dropping a single trailing empty line from a
 *  terminal newline (so "a\nb\n" → ["a","b"], not ["a","b",""]). */
function splitLines(text) {
  const lines = String(text == null ? '' : text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** key:value lines → object. Split on the FIRST `sep` only (so a `sep` inside
 *  the value is preserved); trim both sides; lines without `sep` are skipped;
 *  later duplicate keys win. */
function parseKv(text, sep) {
  const out = {};
  for (const line of splitLines(text)) {
    const i = line.indexOf(sep);
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const val = line.slice(i + sep.length).trim();
    if (key) out[key] = val;
  }
  return out;
}

/** Select a field off a parsed record. record == null → undefined; a null/undef
 *  `key` yields the whole record (e.g. a `lines` array port with no `from`). */
function projectFrom(record, key) {
  if (record == null) return undefined;
  if (key == null) return record;
  if (typeof record !== 'object') return undefined;
  return record[key];
}

/** Compile a per-port `{ regex, group }` escape hatch to `(text) => value|null`.
 *  `group` defaults to 1 (the capture). No match, or missing group → null. */
function compileExtract(spec) {
  if (!spec || typeof spec.regex !== 'string') {
    throw new Error(`fabric extract must be { regex, group? }, got ${JSON.stringify(spec)}`);
  }
  const re = new RegExp(spec.regex);
  const group = spec.group == null ? 1 : spec.group;
  return (text) => {
    const m = re.exec(String(text == null ? '' : text));
    if (!m) return null;
    return m[group] != null ? m[group] : null;
  };
}

module.exports = { compileParse, projectFrom, compileExtract, parseKv, splitLines };
