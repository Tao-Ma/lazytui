/**
 * Plugin purity-contract enforcement (blessed-exceptions arc, Phase E).
 *
 * `groupActions(group, name, config, model)` (panel/api.js getGroupActions,
 * leaves/pane-tabs.js) MUST be a PURE PROJECTION: no IO, no mutation of the
 * group/config/model args, no Date/random, same inputs → same outputs. It
 * runs on read paths (tab strip, actions panel, per-render), so an impure
 * plugin corrupts reducer purity and/or blocks the event loop per call.
 *
 * Until now the contract was DOCUMENTED, not ENFORCED. This guard enforces
 * it in STRICT mode (dev/test, opt-in via LAZYTUI_STRICT_PLUGINS=1) and is a
 * thin pass-through otherwise — zero production overhead.
 *
 * Two checks, both surfaced to the diagnostics window (leader e), never
 * hard-failing production:
 *   - MUTATION — args are wrapped in a recursive read-only Proxy that throws
 *     on any write at any depth. The Proxy NEVER mutates the real object, so
 *     the legit render-side / finalizer writers of model/config are unaffected
 *     (Object.freeze on the real objects would break them). A violating plugin
 *     contributes nothing for that call (its actions are dropped) + a warn is
 *     recorded; the rest of the app behaves identically.
 *   - SLOWNESS — calls over SLOW_MS are flagged (a pure projection of in-memory
 *     data is sub-millisecond; slowness ≈ IO / shelling out).
 *
 * Warnings dedupe per (code, key) for the session so a per-frame call can't
 * flood the ring buffer. reset() re-arms (used by the test suite).
 */
'use strict';

const SLOW_MS = 2;

let _diag = null;
function diag() {
  if (_diag === null) {
    try { _diag = require('../dispatch/diag-log'); }
    catch (_) { _diag = false; } // unavailable in early boot / bare tests
  }
  return _diag || null;
}

function strictEnabled() {
  return process.env.LAZYTUI_STRICT_PLUGINS === '1';
}

const _warned = new Set();
function _warnOnce(code, key, message) {
  const k = `${code}:${key}`;
  if (_warned.has(k)) return;
  _warned.add(k);
  const d = diag();
  if (d) d.warn(code, message);
}

/** Clear the dedupe set (and reset for tests). */
function reset() { _warned.clear(); }

class PluginImpurityError extends Error {
  constructor(compName, propPath) {
    super(`[${compName}] groupActions mutated a read-only arg (${propPath}) — `
      + `groupActions must be a pure projection (no mutation of group/config/model)`);
    this.code = 'plugin-impure';
    this.dedupKey = `${compName}:${propPath}`;
  }
}

/**
 * Recursive read-only view of `obj`. Reads pass through (objects are wrapped
 * lazily on access); ANY write/define/delete at any depth throws
 * PluginImpurityError. The wrapped object is never mutated.
 */
function readonly(obj, label, compName) {
  if (obj === null || typeof obj !== 'object') return obj;
  return new Proxy(obj, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      return (v !== null && typeof v === 'object')
        ? readonly(v, `${label}.${String(prop)}`, compName)
        : v;
    },
    set(_t, prop)            { throw new PluginImpurityError(compName, `${label}.${String(prop)}`); },
    defineProperty(_t, prop) { throw new PluginImpurityError(compName, `${label}.${String(prop)}`); },
    deleteProperty(_t, prop) { throw new PluginImpurityError(compName, `${label}.${String(prop)}`); },
  });
}

/**
 * Invoke a Component's groupActions through the guard. In non-strict mode
 * this is a direct call. In strict mode the args are read-only-wrapped and
 * the call is timed; a purity violation records a warn and returns {} (the
 * plugin contributes nothing this call), while a genuine plugin bug (any
 * other throw) is re-thrown for api.js's existing catch to log.
 */
function callGroupActions(comp, group, groupName, config, model) {
  if (!strictEnabled()) {
    return comp.groupActions(group, groupName, config, model);
  }
  const start = Date.now();
  let out;
  try {
    out = comp.groupActions(
      readonly(group, 'group', comp.name),
      groupName,
      readonly(config, 'config', comp.name),
      readonly(model, 'model', comp.name),
    );
  } catch (e) {
    if (e && e.code === 'plugin-impure') {
      _warnOnce('plugin-impure', e.dedupKey, e.message);
      return {}; // contract violated — drop this plugin's contribution
    }
    throw e; // a real plugin bug — let the caller's catch handle it
  }
  const ms = Date.now() - start;
  if (ms > SLOW_MS) {
    _warnOnce('plugin-slow', comp.name,
      `[${comp.name}] groupActions took ${ms}ms (>${SLOW_MS}ms) — likely IO/blocking; `
      + `groupActions must be a pure projection`);
  }
  return out;
}

module.exports = {
  callGroupActions, readonly, strictEnabled, reset, PluginImpurityError, SLOW_MS,
};
