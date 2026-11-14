/**
 * Pointer capture — ONE slot holding the drag in flight (docs/mouse-hit-map.md
 * §Pointer capture, Release 3).
 *
 * A press handler starts a capture — the `{ capture: name, ...args }` handler
 * form, or an act that returns such a request. From then on every `motion` /
 * `release` goes to the capturing controller wherever the pointer is (a drag
 * that crosses a popup box or another pane stays with the drag); `release`
 * ends it. Mutual exclusion is structural: one slot, and the press's winning
 * region picked the controller.
 *
 * Controllers are code, registered by name (the mouse-acts shape):
 *
 *   {
 *     start(args, ev)    → state | null   null declines (e.g. the press is not
 *                                         on selectable content) — no capture
 *     motion(state, ev)  → dirty?         ev = { mx, my, x, y }
 *     release(state, ev) → dirty?         the slot is already empty
 *     pressWhileHeld:    'drop' | 'swallow' | (state) → 'drop' | 'swallow'
 *                        a press arriving while the capture is held (a lost
 *                        release): 'drop' ends the capture (cancel runs) and the
 *                        press routes normally; 'swallow' consumes the press and
 *                        keeps the capture. Default 'drop'.
 *     cancel(state)      → dirty?         optional — run when the capture is
 *                                         dropped without a release
 *   }
 *
 * Capture state is input-shell (like the router's press→double record), not
 * model: the visible effects ride the Msgs each controller dispatches. A
 * controller that throws loses its capture; the error is recorded and never
 * escapes into the stdin pipeline. The router paints when a controller reports
 * dirty.
 */
'use strict';

const eventLog = require('../../io/event-log');

const _controllers = Object.create(null);
let _slot = null;   // { name, ctl, state, owner } | null

/** Register a named controller. Names are unique. */
function register(name, ctl) {
  if (_controllers[name]) throw new Error(`pointer-capture controller '${name}' already registered`);
  if (!ctl || typeof ctl.start !== 'function') throw new TypeError(`pointer-capture controller '${name}' needs start()`);
  _controllers[name] = ctl;
}

function _record(name, phase, e) {
  console.error('[pointer-capture]', name, phase, e && e.message);
  try {
    eventLog.record('error', { where: 'pointer_capture', controller: name, phase, message: e && e.message, stack: e && e.stack });
  } catch (_) { /* event-log unavailable */ }
}

/** Start capture `name` for a press at `ev`, on behalf of region `owner`.
 *  Replaces nothing — the router resolved any held capture before the press.
 *  Returns true when the controller took the capture. Unknown name → false. */
function start(name, args, ev, owner) {
  const ctl = _controllers[name];
  if (!ctl) return false;
  let state;
  try { state = ctl.start(args || {}, ev || {}); } catch (e) { _record(name, 'start', e); return false; }
  if (state == null) return false;
  _slot = { name, ctl, state, owner: owner == null ? null : owner };
  return true;
}

/** The held capture `{ name, owner }`, or null. */
function held() { return _slot ? { name: _slot.name, owner: _slot.owner } : null; }

function _call(phase, ev) {
  const s = _slot;
  if (!s) return false;
  if (phase === 'release') _slot = null;
  const fn = s.ctl[phase];
  if (typeof fn !== 'function') return false;
  try { return !!fn.call(s.ctl, s.state, ev || {}); } catch (e) {
    if (_slot === s) _slot = null;
    _record(s.name, phase, e);
    return true;   // repaint — the controller may have dispatched before throwing
  }
}

/** Route a motion to the holder. Returns dirty (false when nothing is held). */
function motion(ev) { return _call('motion', ev); }

/** Route a release to the holder and end the capture. Returns dirty. */
function release(ev) { return _call('release', ev); }

/** A press while a capture is held. Returns `{ swallow, dirty }`: swallow →
 *  the press is consumed and the capture stays; otherwise the capture was
 *  dropped (cancel ran) and the press routes normally. Nothing held →
 *  `{ swallow: false, dirty: false }`. */
function press(ev) {
  const s = _slot;
  if (!s) return { swallow: false, dirty: false };
  let policy = s.ctl.pressWhileHeld;
  if (typeof policy === 'function') {
    try { policy = policy.call(s.ctl, s.state); } catch (e) { _record(s.name, 'pressWhileHeld', e); policy = 'drop'; }
  }
  if (policy === 'swallow') return { swallow: true, dirty: false };
  _slot = null;
  let dirty = false;
  if (typeof s.ctl.cancel === 'function') {
    try { dirty = !!s.ctl.cancel(s.state, ev || {}); } catch (e) { _record(s.name, 'cancel', e); dirty = true; }
  }
  return { swallow: false, dirty };
}

/** Test seam — drop any held capture without running a hook. */
function _reset() { _slot = null; }

module.exports = { register, start, held, motion, release, press, _reset };
