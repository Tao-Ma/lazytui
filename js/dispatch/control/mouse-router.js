/**
 * Mouse router — resolve a pointer gesture against the per-frame hit map and
 * realize the winning region's DATA handler (docs/mouse-hit-map.md).
 *
 * Precedence is z-order (panel/hit-map.resolve), not source order. Handler
 * forms, realized here and only here:
 *
 *   { key, seq? }      dispatch.handleKey(key, seq ?? seqForKey(key)) — the keyboard path
 *                      itself, so a clicked hint chip / a wheel notch over a
 *                      list / an outside-click is exactly the key the user could
 *                      have typed (no mouse-only reducer arms, no drift).
 *   { msg, owner? }    applyMsg(msg), or dispatchMsg(wrap(owner, msg)).
 *   { intent }         intent.realize(intent) — the v0.6.4 shared vocabulary.
 *   'swallow'          consume, no-op.
 *   [h1, h2, …]        realize each in order (row double-click = nav + return).
 *
 * Release 1 scope: DISCRETE gestures only (press / double / right / middle /
 * wheel). motion / release keep the legacy path until pointer capture lands
 * (Release 3) — a drag that crosses a popup box must not be swallowed by it.
 * A miss (no region, or a stale frame) returns false and handleMouse falls
 * through to the legacy cascade, unchanged.
 *
 * Two guards:
 *   - STALE FRAME: the hit map is stamped with the chain modes active when it
 *     was painted; if the current modes differ (a batched Enter+click chunk —
 *     render-queue defers paint inside a batch) the router abstains rather than
 *     resolve against regions the model no longer matches.
 *   - PRESS→DOUBLE CONTINUATION: the parser emits a same-cell second click as
 *     `double`. When the FIRST click was a hit-map press (picking a popup item,
 *     which usually closes the popup), the double belongs to that press's owner:
 *     if the owner no longer holds the cell, the double is swallowed — without
 *     this it falls through to the pane beneath and fires the pane's
 *     double-click intent (`activate` → run the selected item). This guard runs
 *     BEFORE the stale check: in a batched chunk the popup may have closed
 *     without a repaint, and the double must still not leak.
 */
'use strict';

const hitMap = require('../../panel/hit-map');
const { chainStamp } = require('../../leaves/input/modes');
const { paintNow: render } = require('../../leaves/infra/render-queue');
const { seqForKey } = require('../../leaves/render/hints');

const DISCRETE = new Set(['press', 'double', 'right', 'middle', 'wheel-up', 'wheel-down']);

// Lazy, memoized: dispatch.js / loop / intent sit above this module in the
// load graph (input.js → dispatch.js), so resolve them at gesture time.
let _dispatchRef, _loopRef, _apiRef, _intentRef;
const _dispatch = () => (_dispatchRef ||= require('./dispatch'));
const _loop = () => (_loopRef ||= require('../runtime/loop'));
const _api = () => (_apiRef ||= require('../../panel/api'));
const _intent = () => (_intentRef ||= require('./intent'));

// The last press the hit map handled: { mx, my, owner } | null.
let _lastPress = null;

function realize(h) {
  if (h == null || h === 'swallow') return;
  if (Array.isArray(h)) { for (const x of h) realize(x); return; }
  if (typeof h !== 'object') return;
  if (h.key != null) { _dispatch().handleKey(h.key, h.seq != null ? h.seq : seqForKey(h.key)); return; }
  if (h.msg) {
    if (h.owner) _loop().dispatchMsg(_api().wrap(h.owner, h.msg));
    else _dispatch().applyMsg(h.msg);
    return;
  }
  if (h.intent) _intent().realize(h.intent);
}

function _realizeAndPaint(hit, kind, mx, my) {
  try {
    realize(hit.handler);
  } catch (e) {
    // A throwing handler must not escape into the stdin pipeline. The event is
    // consumed (it did resolve to a region); the error is recorded.
    console.error('[mouse-router]', hit.region.owner, hit.region.id, e && e.message);
    try {
      require('../../io/event-log').record('error', {
        where: 'mouse_router', owner: hit.region.owner, id: hit.region.id, kind, mx, my,
        message: e && e.message, stack: e && e.stack,
      });
    } catch (_) { /* event-log unavailable */ }
  }
  render();
}

/** Route one gesture. Returns true when the hit map consumed it (the caller
 *  stops), false to fall through to the legacy cascade. `mx`/`my` are 0-based. */
function route(kind, mx, my, model) {
  if (!DISCRETE.has(kind)) return false;
  const fresh = hitMap.frameStamp() === chainStamp(model && model.modes);

  if (kind === 'double' && _lastPress && _lastPress.mx === mx && _lastPress.my === my) {
    const owner = _lastPress.owner;
    _lastPress = null;
    const hit = fresh ? hitMap.resolve(mx, my, kind) : null;
    if (!hit || hit.region.owner !== owner) return true;   // owner gone → swallow
    _realizeAndPaint(hit, kind, mx, my);
    return true;
  }
  if (kind === 'press' || kind === 'double') _lastPress = null;

  if (!fresh) return false;
  const hit = hitMap.resolve(mx, my, kind);
  if (!hit) return false;
  if (kind === 'press') _lastPress = { mx, my, owner: hit.region.owner };
  _realizeAndPaint(hit, kind, mx, my);
  return true;
}

/** Test seam — forget the press→double continuation. */
function _reset() { _lastPress = null; }

module.exports = { route, realize, DISCRETE, _reset };
