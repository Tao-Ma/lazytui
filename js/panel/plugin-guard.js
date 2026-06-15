/**
 * groupActions purity-contract enforcement (Component contract; see
 * docs/PLUGINS.md §"The groupActions contract").
 *
 * Every Component MAY expose `groupActions(group, name, config, model)` to
 * synthesize actions for a group (panel/api.js getGroupActions). It MUST be a
 * PURE PROJECTION: no IO, no mutation of the group/config/model args, no
 * Date/random, same inputs → same outputs. It runs on read paths (tab strip,
 * actions panel, per-render), so an impure one corrupts reducer purity and/or
 * blocks the event loop per call.
 *
 * The contract is ALWAYS ENFORCED — in production, not just dev (this replaces
 * the old opt-in LAZYTUI_STRICT_PLUGINS gate). Two checks, both surfaced to the
 * diagnostics window (leader e), never hard-failing production:
 *   - MUTATION — args are wrapped in a recursive read-only Proxy that throws
 *     on any write at any depth. The Proxy NEVER mutates the real object, so
 *     the legit render-side / finalizer writers of model/config are unaffected
 *     (Object.freeze on the real objects would break them). A violating
 *     Component contributes nothing for that call (its actions are dropped) +
 *     a warn is recorded; the rest of the app behaves identically.
 *   - SLOWNESS — calls over SLOW_MS are flagged (a pure projection of in-memory
 *     data is sub-millisecond; slowness ≈ IO / shelling out).
 *
 * Fast path: a Component that sets `groupActionsMemo: true` is run ONCE per
 * group (still guarded), then its result is cached (keyed on the boot-static
 * group object) — so a careful, pure Component pays the Proxy cost once;
 * a non-memoized one pays it every call. See callGroupActions.
 *
 * Warnings dedupe per (code, key) for the session so a per-frame call can't
 * flood the ring buffer. reset() re-arms + clears the memo (test suite).
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

const _warned = new Set();
function _warnOnce(code, key, message) {
  const k = `${code}:${key}`;
  if (_warned.has(k)) return;
  _warned.add(k);
  const d = diag();
  if (d) d.warn(code, message);
}

// Per-Component memo of the groupActions contribution, keyed on the
// (boot-static) `group` object. A Component opts in with
// `groupActionsMemo: true` — see callGroupActions.
let _memo = new WeakMap(); // group(object) -> Map<compName, result>

/** Clear the dedupe set + memo (reset for tests). */
function reset() { _warned.clear(); _memo = new WeakMap(); }

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
 * One guarded invocation: read-only-wrap the args, time the call. A purity
 * violation (mutation) records a warn and returns {} (the Component
 * contributes nothing this call); a slow call (likely IO) records a warn; a
 * genuine bug (any other throw) is re-thrown for api.js's catch to log.
 * This ALWAYS runs — the contract is enforced in production, not just dev.
 */
function _guardedCall(comp, group, groupName, config, model) {
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
      return {}; // contract violated — drop this Component's contribution
    }
    throw e; // a real bug — let the caller's catch handle it
  }
  const ms = Date.now() - start;
  if (ms > SLOW_MS) {
    _warnOnce('plugin-slow', comp.name,
      `[${comp.name}] groupActions took ${ms}ms (>${SLOW_MS}ms) — likely IO/blocking; `
      + `groupActions must be a pure projection`);
  }
  return out;
}

/**
 * Invoke a Component's `groupActions` through the purity guard. The contract
 * (a PURE PROJECTION: no IO, no mutation of group/config/model, no Date/random,
 * same inputs → same outputs) is ALWAYS enforced — the args are read-only-
 * wrapped on every call, in production too.
 *
 * Fast path (opt-in): a Component that sets `groupActionsMemo: true` declares
 * its groupActions a pure function of `group`. We then run it exactly ONCE per
 * group — under the guard, so purity is still verified — and cache the result
 * keyed on the (boot-static) `group` object; later calls reuse it, skipping
 * both the call and the Proxy. A config reload mints new group objects, so the
 * WeakMap auto-invalidates. A Component that does NOT opt in is guarded on
 * every call (the Proxy cost is the natural nudge to be pure + memoize).
 * Opting in IS a purity promise; the one guarded call is its check.
 */
function callGroupActions(comp, group, groupName, config, model) {
  if (comp.groupActionsMemo && group !== null && typeof group === 'object') {
    let byComp = _memo.get(group);
    if (byComp && byComp.has(comp.name)) return byComp.get(comp.name);
    const out = _guardedCall(comp, group, groupName, config, model);
    if (!byComp) { byComp = new Map(); _memo.set(group, byComp); }
    byComp.set(comp.name, out);
    return out;
  }
  return _guardedCall(comp, group, groupName, config, model);
}

module.exports = {
  callGroupActions, readonly, reset, PluginImpurityError, SLOW_MS,
};
