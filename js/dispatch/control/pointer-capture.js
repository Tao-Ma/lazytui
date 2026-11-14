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
 *                        release): 'drop' ends the capture (cancel 'lost' runs)
 *                        and the press routes normally; 'swallow' consumes the
 *                        press and keeps the capture. Default 'drop'.
 *     cancel(state, ev, reason) → dirty?  optional — run when the capture is
 *                                         dropped without a release; reason:
 *                                         'lost' — the release never came (a
 *                                         press arrived first, or replay is
 *                                         starting): discard the unreleased
 *                                         drag, commit nothing; 'scope' — the
 *                                         modes changed while the button is
 *                                         still held (SCOPE)
 *   }
 *
 * SCOPE: a capture lives only within the scope it started in — the router
 * passes `{ chain, replay }` (the active chain modes + the replay view). If a
 * popup / an in-grid mode opens mid-drag, the next motion / release ABANDONS
 * the capture: its `cancel(…, 'scope')` runs and nothing else, so a drag can't
 * keep selecting / zooming / copying behind a modal (before R3 the T13 gate
 * dropped those gestures). A PRESS in a changed scope is still a lost release:
 * `cancel(…, 'lost')`, without asking the controller's policy (the press
 * belongs to what the new scope shows).
 *
 * REPLAY swaps the whole model, so a capture must never cross it:
 * replay-control's enter ends a held capture (`abandon('lost')`) BEFORE it
 * snapshots the live model — the snapshot restored on exit must hold no
 * half-finished drag. A capture that still sees the replay view change (replay
 * entered some other way) is dropped with NO cancel ('swap'): nothing may write
 * into a reconstructed model.
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
let _slot = null;   // { name, ctl, state, owner, scope } | null

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

/** Start capture `name` for a press at `ev`, on behalf of region `owner`,
 *  within `scope` (see SCOPE). Replaces nothing — the router resolved any held
 *  capture before the press. Returns true when the controller took the
 *  capture. Unknown name → false. */
function start(name, args, ev, owner, scope) {
  const ctl = _controllers[name];
  if (!ctl) return false;
  let state;
  try { state = ctl.start(args || {}, ev || {}); } catch (e) { _record(name, 'start', e); return false; }
  if (state == null) return false;
  _slot = { name, ctl, state, owner: owner == null ? null : owner, scope: scope == null ? null : scope };
  return true;
}

// Drop the held capture without a release. `reason` 'lost' / 'scope' runs the
// controller's cancel; 'swap' (the replay view changed) runs none. Returns dirty.
function _abandon(ev, reason) {
  const s = _slot;
  _slot = null;
  if (!s || reason === 'swap' || typeof s.ctl.cancel !== 'function') return false;
  try { return !!s.ctl.cancel(s.state, ev || {}, reason); } catch (e) { _record(s.name, 'cancel', e); return true; }
}
// Has the scope changed since the capture started? → 'swap' | 'scope' | null.
function _scopeChange(scope) {
  const s = _slot;
  if (!s || !s.scope || !scope) return null;
  if ((s.scope.replay || null) !== (scope.replay || null)) return 'swap';
  return s.scope.chain !== scope.chain ? 'scope' : null;
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

/** Route a motion to the holder (or abandon it — `scope` changed). Returns
 *  dirty (false when nothing is held). */
function motion(ev, scope) { const c = _scopeChange(scope); return c ? _abandon(ev, c) : _call('motion', ev); }

/** Route a release to the holder and end the capture (or abandon it — `scope`
 *  changed). Returns dirty. */
function release(ev, scope) { const c = _scopeChange(scope); return c ? _abandon(ev, c) : _call('release', ev); }

/** A press while a capture is held — a lost release. Returns `{ swallow,
 *  dirty }`: swallow → the press is consumed and the capture stays; otherwise
 *  the capture was dropped (cancel 'lost') and the press routes normally. A
 *  scope change skips the controller's policy — the press belongs to what the
 *  new scope shows — but is still a lost release (a replay swap: no cancel).
 *  Nothing held → `{ swallow: false, dirty: false }`. */
function press(ev, scope) {
  const s = _slot;
  if (!s) return { swallow: false, dirty: false };
  const c = _scopeChange(scope);
  if (c) return { swallow: false, dirty: _abandon(ev, c === 'swap' ? 'swap' : 'lost') };
  let policy = s.ctl.pressWhileHeld;
  if (typeof policy === 'function') {
    try { policy = policy.call(s.ctl, s.state); } catch (e) { _record(s.name, 'pressWhileHeld', e); policy = 'drop'; }
  }
  if (policy === 'swallow') return { swallow: true, dirty: false };
  return { swallow: false, dirty: _abandon(ev, 'lost') };
}

/** End the held capture from outside a pointer event — replay-control's enter,
 *  before it snapshots the live model (REPLAY). Runs the controller's
 *  `cancel(…, reason)`; default 'lost'. Returns dirty (false when nothing is
 *  held). */
function abandon(reason) { return _slot ? _abandon({}, reason || 'lost') : false; }

/** Test seam — drop any held capture without running a hook. */
function _reset() { _slot = null; }

module.exports = { register, start, held, motion, release, press, abandon, _reset };
