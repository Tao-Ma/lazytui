/**
 * Port values & discovery — the derived, memoized selectors over a component's
 * output, plus listPorts/listWires. See docs/ports-and-wires.md, "Port values
 * are derived, not stored" + "Discovery".
 *
 * Fabric is a clean BOTTOM layer (dispatch/ imports it now; panel/ will in
 * P1.5), so it never imports panel/model upward. It reads a component's current
 * output lines + declared spec + the wire list through an INJECTED HOST SEAM
 * (the js/hosts/ pattern), wired at boot from a layer that legally holds config
 * + slice access. Host contract:
 *
 *   componentLines(name) -> string[] | null   current output lines (ref-stable
 *                                              until content changes — the memo key)
 *   componentSpec(name)  -> { parse?, ports? } | null   parsed config for the component
 *   listComponents()     -> string[]           component names that declare ports
 *   wires()              -> [{ from, to }]      config wires (already parsed)
 *
 * Port values are NOT materialized in the model (viewer-lines precedent): the
 * parse runs once per output change (WeakMap on the lines-array identity), never
 * per read, never per model turn.
 */
'use strict';

const { compileParse, projectFrom, compileExtract } = require('./parse');

let _host = null;
/** Wire the fabric host seam at boot (see contract above). */
function setFabricHost(host) { _host = host; }
function h() {
  if (!_host) throw new Error('fabric: host not wired — call setFabricHost at boot');
  return _host;
}

// Compiled parse/extract fns memoized per spec-object identity (config specs are
// stable per load). The parsed RECORD is memoized per output lines-array identity.
const _compiledParse = new WeakMap();    // parseSpec obj  -> (text) => record
const _compiledExtract = new WeakMap();  // extractSpec obj -> (text) => value|null
const _parseCache = new WeakMap();       // linesArray     -> { parseFn, record }

function _parseFnFor(spec) {
  let fn = _compiledParse.get(spec);
  if (!fn) { fn = compileParse(spec); _compiledParse.set(spec, fn); }
  return fn;
}
function _extractFnFor(spec) {
  let fn = _compiledExtract.get(spec);
  if (!fn) { fn = compileExtract(spec); _compiledExtract.set(spec, fn); }
  return fn;
}

/**
 * The memoized structured record for a component's current output (its "model").
 * null when the component has no output yet or declares no `parse`.
 */
function parsed(name) {
  const lines = h().componentLines(name);
  if (!lines) return null;
  const spec = h().componentSpec(name);
  if (!spec || !spec.parse) return null;
  const parseFn = _parseFnFor(spec.parse);
  const hit = _parseCache.get(lines);
  if (hit && hit.parseFn === parseFn) return hit.record;
  const record = parseFn(lines.join('\n'));
  _parseCache.set(lines, { parseFn, record });
  return record;
}

/**
 * The current value of an output port — project a field off `parsed`, or run the
 * per-port `extract` on raw output. `from` defaults to the port name. undefined
 * when the component/port is unknown or the source has no value yet.
 */
function portValue(name, port) {
  const spec = h().componentSpec(name);
  const pdef = spec && spec.ports && spec.ports.out && spec.ports.out[port];
  if (!pdef) return undefined;
  if (pdef.extract) {
    const lines = h().componentLines(name);
    if (!lines) return undefined;
    const val = _extractFnFor(pdef.extract)(lines.join('\n'));
    return val == null ? undefined : val;
  }
  const rec = parsed(name);
  // Explicit `from` → project that field. No `from`: a keyed object defaults to
  // the port-name field (kv/json object); an ARRAY or primitive record IS the
  // value — the whole-record port (a `{lines:true}` / whole-JSON producer). (M2)
  if (pdef.from != null) return projectFrom(rec, pdef.from);
  if (rec != null && typeof rec === 'object' && !Array.isArray(rec)) return projectFrom(rec, port);
  return rec == null ? undefined : rec;
}

/** Every declared port across all components — powers the pane, wire pickers, P2. */
function listPorts() {
  const out = [];
  for (const name of h().listComponents()) {
    const ports = (h().componentSpec(name) || {}).ports || {};
    for (const [port, d] of Object.entries(ports.out || {})) {
      out.push({ component: name, port, dir: 'out', type: d.type, desc: d.desc });
    }
    for (const [port, d] of Object.entries(ports.in || {})) {
      out.push({ component: name, port, dir: 'in', type: d.type, desc: d.desc, required: d.required !== false });
    }
  }
  return out;
}

/** The current wire list — config + runtime, merged by the host (each entry
 *  carries a `source` tag). */
function listWires() { return h().wires() || []; }

/** The declared ports map `{ in?, out? }` for one component — the raw port defs
 *  (type/required/default/desc/from/extract), for the P1.5 component-ports pane
 *  and its inspector. null when the component is unknown or declares no ports. */
function componentPorts(name) {
  const spec = h().componentSpec(name);
  return (spec && spec.ports) || null;
}

/** True when a component has produced output (its run captured lines) — lets the
 *  check-half tell "✗ regex no-match" (ran, field null) from "— no value" (not
 *  run yet). */
function hasOutput(name) { return h().componentLines(name) != null; }

module.exports = { setFabricHost, parsed, portValue, listPorts, listWires, componentPorts, hasOutput };
