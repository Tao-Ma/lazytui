/**
 * Input resolution & readiness — the pure core of the one new dispatch hook
 * (docs/ports-and-wires.md, "Resolution & readiness" + decision 5).
 *
 * For a consumer's declared input ports, resolve each by precedence:
 *
 *     inject  >  wire  >  default  >  (required ? ERROR : omit)
 *
 * as a FALLBACK CHAIN — a wire that resolves to no value falls through to a
 * default, then to a readiness error. "Unavailable upstream" is therefore not a
 * special path: it's just a required input that didn't resolve, and the error
 * names exactly why (unset vs. wired-but-upstream-empty).
 *
 * Pure: the caller injects the current model state via `ctx` (the injects map,
 * the wire list, and a portValue reader) so this module imports nothing but the
 * address grammar. The action-runner (slice 5c) supplies real `ctx` and turns
 * the result into the argv fill or the error-and-tell.
 */
'use strict';

const { parseFabricAddr, formatFabricAddr } = require('./address');

function _wireTo(wires, addr) {
  for (const w of wires) if (w && w.to === addr) return w.from;
  return null;
}

/**
 * Resolve a consumer's inputs.
 *   consumerName — the component name (for building `consumer.input` addresses)
 *   inputs       — the ports.in map: { name: { required?, default?, ... } }
 *   ctx          — { injects: {addr:{value}}, wires: [{from,to}], portValue(comp,port) }
 * → { ready, values: {name:value}, sources: {name:'inject'|'wire'|'default'},
 *     missing: [{ port, reason }] }
 */
function resolveInputs(consumerName, inputs, ctx) {
  const injects = (ctx && ctx.injects) || {};
  const wires = (ctx && ctx.wires) || [];
  const portValue = (ctx && ctx.portValue) || (() => undefined);

  const values = {};
  const sources = {};
  const missing = [];

  for (const [name, def] of Object.entries(inputs || {})) {
    const addr = formatFabricAddr(consumerName, name);
    const required = !def || def.required !== false;

    // 1. inject (by value) — highest precedence. An inject whose value is
    // undefined is treated as ABSENT, so it can't silently shadow a working
    // wire (L6). A falsy "" / 0 is a real value and is honoured.
    const inj = injects[addr];
    if (inj !== undefined && inj.value !== undefined) {
      values[name] = inj.value;
      sources[name] = 'inject';
      continue;
    }

    // 2. wire (by reference). A present-but-empty wire falls through to default.
    const from = _wireTo(wires, addr);
    if (from) {
      let fv, fromComp = from;
      try { const a = parseFabricAddr(from); fromComp = a.component; fv = portValue(a.component, a.port); }
      catch { fv = undefined; }
      if (fv !== undefined) {
        values[name] = fv;
        sources[name] = 'wire';
        continue;
      }
      // wired but upstream has no value yet — remember for a precise message.
      if (def && 'default' in def) { values[name] = def.default; sources[name] = 'default'; continue; }
      if (required) missing.push({ port: name, reason: `\`${name}\` ← ${from} has no value yet — run ${fromComp} first` });
      continue;
    }

    // 3. default.
    if (def && 'default' in def) {
      values[name] = def.default;
      sources[name] = 'default';
      continue;
    }

    // 4. required → error ; optional → omit.
    if (required) missing.push({ port: name, reason: `\`${name}\` unset — wire it or send a value` });
  }

  return { ready: missing.length === 0, values, sources, missing };
}

module.exports = { resolveInputs };
