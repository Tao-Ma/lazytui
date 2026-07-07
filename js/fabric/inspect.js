/**
 * Component inspection — assemble a component's full port surface into the row
 * model the P1.5 component-ports pane renders (docs/ports-and-wires.md, "P1.5 —
 * Component-ports pane"). One pure composition over the existing primitives:
 * resolveInputs for the operate-half (each input's resolved value + source +
 * readiness) and portValue for the check-half (each output's current value).
 *
 * "Adds no new fabric semantics" — it's a VIEW over resolution + projection,
 * shaped for rendering. Pure: the caller injects current model state via `ctx`
 * (the injects map, the merged wire list, and a portValue reader), exactly the
 * ctx resolveInputs takes, so this module imports only the resolver.
 */
'use strict';

const { resolveInputs } = require('./resolve');

/**
 * inspectComponent(name, ports, ctx) →
 *   { name, ready, ranOutput, missing:[{port,reason}],
 *     inputs:  [{ port, type, required, value, source, wireFrom, reason }],
 *     outputs: [{ port, type, desc, value, present }] }
 *
 *   ports — the component's declared `{ in?, out? }` map (fabric.componentPorts).
 *   ctx   — { injects, wires, portValue, hasOutput? } (resolveInputs' shape +
 *           an optional hasOutput(name) so the check-half distinguishes a field
 *           that didn't match (ran, null) from one not produced yet (empty)).
 *
 * inputs mirror resolveInputs: `source` is 'inject' | 'wire' | 'default' | null
 * (unresolved), `wireFrom` the producer address when a wire is the source (so the
 * pane can render `← producer.port`), `reason` the readiness message for a missing
 * required input. outputs carry the current projected value + a `present` flag
 * (has a value) — the check-half's coarse ✓/— indicator (Slice F adds the
 * per-field match chain).
 */
function inspectComponent(name, ports, ctx) {
  const inDefs = (ports && ports.in) || {};
  const outDefs = (ports && ports.out) || {};
  const portValue = (ctx && ctx.portValue) || (() => undefined);
  const wires = (ctx && ctx.wires) || [];

  const res = resolveInputs(name, inDefs, ctx);
  const reasonByPort = {};
  for (const m of res.missing) reasonByPort[m.port] = m.reason;
  const wireFromFor = (port) => {
    const addr = `${name}.${port}`;
    const w = wires.find((x) => x && x.to === addr);
    return w ? w.from : null;
  };

  const inputs = Object.entries(inDefs).map(([port, def]) => ({
    port,
    type: (def && def.type) || null,
    required: !def || def.required !== false,
    value: res.values[port],
    source: res.sources[port] || null,
    wireFrom: res.sources[port] === 'wire' ? wireFromFor(port) : null,
    reason: reasonByPort[port] || null,
  }));

  const outputs = Object.entries(outDefs).map(([port, def]) => {
    const value = portValue(name, port);
    return {
      port,
      type: (def && def.type) || null,
      desc: (def && def.desc) || null,
      value,
      // null (a `fields`/extract no-match) counts as ABSENT, same as undefined —
      // the check-half shows ✗/— for both, ✓ only for a real value.
      present: value != null,
    };
  });

  const ranOutput = ctx && typeof ctx.hasOutput === 'function' ? !!ctx.hasOutput(name) : undefined;
  return { name, ready: res.ready, ranOutput, missing: res.missing, inputs, outputs };
}

/**
 * inspectWires(wires, portValue) → [{ from, to, source, value, present }]
 * The wire-list pane's row model: each edge annotated with the value currently on
 * it (the producer output's portValue) + a `present` flag (⚠ upstream unset when
 * false). `source` ('config' | 'runtime') rides through from mergeWires so the
 * list can show provenance + gate delete. Pure (portValue injected).
 */
function inspectWires(wires, portValue) {
  const pv = portValue || (() => undefined);
  return (wires || []).map((w) => {
    const dot = String(w.from).indexOf('.');
    const value = dot > 0 ? pv(w.from.slice(0, dot), w.from.slice(dot + 1)) : undefined;
    return { from: w.from, to: w.to, source: w.source || 'config', value, present: value !== undefined };
  });
}

module.exports = { inspectComponent, inspectWires };
