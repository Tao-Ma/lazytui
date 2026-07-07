/**
 * Wire merge — combine config-authored wires with RUNTIME wires created
 * interactively (the pane's "connect to…" + wire-list edits). See
 * docs/ports-and-wires.md, "Wires — standing connections" + the P1.5 pane.
 *
 * An input port resolves exactly ONE wire (resolve.js `_wireTo` takes the first
 * `to` match), so the merge is keyed by `to`: last write wins, and a runtime
 * wire OVERRIDES a config wire to the same input (the user explicitly rewired).
 * Each result carries a `source` tag ('config' | 'runtime') so the wire list can
 * show provenance and gate delete (only runtime wires are removable at runtime;
 * config wires are user-authored on disk).
 *
 * Pure, zero-dependency leaf (js/fabric/). Malformed entries (missing string
 * from/to) are dropped rather than throwing — config wires are schema-validated
 * at load, runtime wires are shape-guarded in the reducer.
 */
'use strict';

function _ok(w) {
  return w && typeof w.from === 'string' && typeof w.to === 'string';
}

/**
 * mergeWires(configWires, runtimeWires) → [{ from, to, source }]
 * Config first, runtime overrides by `to`. Insertion order of first-seen `to`
 * is preserved so the wire list is stable.
 */
function mergeWires(configWires, runtimeWires) {
  const byTo = new Map();
  const order = [];
  const add = (w, source) => {
    if (!_ok(w)) return;
    if (!byTo.has(w.to)) order.push(w.to);
    byTo.set(w.to, { from: w.from, to: w.to, source });
  };
  for (const w of (configWires || [])) add(w, 'config');
  for (const w of (runtimeWires || [])) add(w, 'runtime');
  return order.map((to) => byTo.get(to));
}

module.exports = { mergeWires };
