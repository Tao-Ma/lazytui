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
 * Purity is a STATIC property of the plugin's code, so the guard checks the
 * contract DIRECTLY and at most ONCE per (group, Component) — never by reading
 * the wall clock on the render path (the guard must not itself be impure). An
 * earlier version timed each call with Date.now as a "slow ≈ IO" proxy; that
 * both read the clock on an otherwise-pure path AND was imprecise (it missed a
 * fast `Date.now()`-reading plugin — the exact "no Date/random" violation — and
 * false-alarmed on a heavy-but-pure projection). Checks, all surfaced to the
 * diagnostics window (leader e), never hard-failing production:
 *   - MUTATION (always-on, every call) — args are wrapped in a recursive
 *     read-only Proxy that throws on any write at any depth. The Proxy NEVER
 *     mutates the real object, so the legit render-side / finalizer writers of
 *     model/config are unaffected (Object.freeze on the real objects would break
 *     them). A violating Component contributes nothing for that call (its actions
 *     dropped) + a warn is recorded; the rest of the app behaves identically.
 *   - DETERMINISM (always-on, clock-free, once per group+Component) — on first
 *     use the projection is run a SECOND time with the SAME args and the two
 *     outputs compared (`model` is an input, so the two calls must be back-to-
 *     back on the same snapshot — comparing across renders would false-flag a
 *     legitimately model-dependent projection). Differing output ⇒ it read
 *     Date/random or did varying IO. One extra call on first use only; zero
 *     steady-state cost (the pair is marked verified and never re-checked).
 *   - IO (opt-in: LAZYTUI_VERIFY_PLUGINS=1, once per group+Component) — the
 *     projection is run once more with fs/child_process intercepted, flagging
 *     blocking/constant IO the determinism compare can't see. It patches globals,
 *     so it is off by default — for plugin authors / CI.
 *
 * Fast path: a Component that sets `groupActionsMemo: true` is run ONCE per
 * group (still guarded + verified on that call), then its result is cached
 * (keyed on the boot-static group object) — so a careful, pure Component pays
 * the cost once; a non-memoized one is guarded every call (verified only once).
 * See callGroupActions.
 *
 * Warnings dedupe per (code, key) for the session so a per-frame call can't
 * flood the ring buffer. reset() re-arms + clears the memo + verify state
 * (test suite).
 */
'use strict';

let _diag = null;
function diag() {
  if (_diag === null) {
    try { _diag = require('../io/diag-log'); }
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
  // DEFERRED, not warn(): callGroupActions runs on render paths (tab strip,
  // actions panel), where a synchronous warn() fires the diag store-mirror → a
  // re-entrant applyMsg from inside render. The dispatch finalizer drains the
  // queue (docs/v0.6.6.md §9 follow-up — render-path purity).
  if (d) d.warnDeferred(code, message);
}

// Per-Component memo of the groupActions contribution, keyed on the
// (boot-static) `group` object. A Component opts in with
// `groupActionsMemo: true` — see callGroupActions.
let _memo = new WeakMap(); // group(object) -> Map<compName, result>
// Which (group, Component) pairs have had their contract verified (determinism
// + opt-in IO) — verify once, since purity is static. group -> Set<compName>.
let _verified = new WeakMap();

/** Clear the dedupe set + memo + verify state (reset for tests). */
function reset() { _warned.clear(); _memo = new WeakMap(); _verified = new WeakMap(); }

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

function _safeJson(x) { try { return JSON.stringify(x); } catch (_) { return null; } }
function _sameResult(a, b) {
  if (a === b) return true;
  const ja = _safeJson(a), jb = _safeJson(b);
  if (ja == null || jb == null) return true; // unserializable (fn/cycle) — can't compare, don't false-warn
  return ja === jb;
}

/**
 * One read-only-wrapped invocation (the MUTATION guard). A mutation records a
 * warn and returns {} (the Component contributes nothing this call); a genuine
 * bug (any other throw) is re-thrown for api.js's catch to log. This ALWAYS
 * runs — the mutation contract is enforced in production, not just dev.
 */
function _call(comp, group, groupName, config, model) {
  try {
    return comp.groupActions(
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
}

// IO detection (opt-in). Run the projection once more with fs/child_process
// intercepted; warn if it touches either. groupActions is synchronous, so the
// patch window contains nothing but this call; restored in `finally`.
const _FS_IO = ['readFileSync','writeFileSync','appendFileSync','openSync','existsSync','statSync','lstatSync','readdirSync','mkdirSync','createReadStream','createWriteStream','readFile','writeFile','appendFile'];
const _CP_IO = ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'];
function _assertNoIO(comp, group, groupName, config, model) {
  const fs = require('fs'), cp = require('child_process');
  const saved = [];
  let touched = null;
  const patch = (obj, names, tag) => {
    for (const m of names) if (typeof obj[m] === 'function') {
      const real = obj[m]; saved.push([obj, m, real]);
      obj[m] = (...a) => { if (!touched) touched = `${tag}.${m}`; return real.apply(obj, a); };
    }
  };
  patch(fs, _FS_IO, 'fs'); patch(cp, _CP_IO, 'child_process');
  try { _call(comp, group, groupName, config, model); }
  catch (_) { /* mutation/throw already surfaced on the primary call */ }
  finally { for (const [obj, m, real] of saved) obj[m] = real; }
  if (touched) {
    _warnOnce('plugin-io', comp.name,
      `[${comp.name}] groupActions performs IO (${touched}) — it must be a pure projection `
      + `(no fs / child_process)`);
  }
}

/**
 * One guarded invocation: the always-on MUTATION guard, then — once per
 * (group, Component) — the DETERMINISM check (clock-free) and, opt-in, the IO
 * check. Verifying once is sufficient because purity is a static property.
 */
function _guardedCall(comp, group, groupName, config, model) {
  const out = _call(comp, group, groupName, config, model);
  if (group !== null && typeof group === 'object') {
    let names = _verified.get(group);
    if (!names) { names = new Set(); _verified.set(group, names); }
    if (!names.has(comp.name)) {
      names.add(comp.name);
      // DETERMINISM — a second call with the SAME args must give the same output
      // (a difference ⇒ reads Date/random or does varying IO). Back-to-back on
      // the same snapshot: `model` is an input, so cross-render comparison would
      // false-flag a legitimately model-dependent projection. Clock-free; one
      // extra call on first use only.
      if (!_sameResult(out, _call(comp, group, groupName, config, model))) {
        _warnOnce('plugin-nondeterministic', comp.name,
          `[${comp.name}] groupActions is not a pure projection — same inputs gave different `
          + `outputs (reads Date/random or does varying IO); it must be deterministic`);
      }
      // IO — opt-in (patches globals), one-shot; catches blocking/constant IO.
      if (process.env.LAZYTUI_VERIFY_PLUGINS === '1') _assertNoIO(comp, group, groupName, config, model);
    }
  }
  return out;
}

/**
 * Invoke a Component's `groupActions` through the purity guard. The contract
 * (a PURE PROJECTION: no IO, no mutation of group/config/model, no Date/random,
 * same inputs → same outputs) is ALWAYS enforced — args are read-only-wrapped on
 * every call and the projection is verified once per (group, Component).
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
  callGroupActions, readonly, reset, PluginImpurityError,
};
