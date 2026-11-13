/**
 * Mouse router — resolve a pointer gesture against the per-frame hit map and
 * realize the winning region's DATA handler (docs/mouse-hit-map.md).
 *
 * Precedence is z-order (panel/hit-map.resolve), not source order. Handler
 * forms, realized here and only here (realizeHandler):
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
 *   - STALE FRAME: the hit map is stamped with what the frame showed
 *     (hit-map.stampOf — chain modes + the popup state's identity). If the
 *     current model differs (a batched `n`+click or Enter+click chunk —
 *     render-queue defers paint inside a batch) the user aimed at a screen that
 *     no longer exists. If that stale frame drew a region under the pointer the
 *     click was meant for it → swallowed (resolving it against changed state,
 *     or handing it to the pane the popup covered, are both wrong). If the stale
 *     frame drew nothing there, the legacy cascade decides, as before.
 *   - PRESS→DOUBLE CONTINUATION: the parser emits a same-cell second click as
 *     `double`. When the FIRST click was a hit-map press (picking a popup item,
 *     which usually closes the popup), the double belongs to that press's owner:
 *     if the owner no longer holds the cell, the double is swallowed — without
 *     this it falls through to the pane beneath and fires the pane's
 *     double-click intent (`activate` → run the selected item). A REPEAT region
 *     (a hint chip) still under the pointer takes the second click as another
 *     press — the key twice, as typed; a different chip that slid under the
 *     pointer does not (e.g. [space] choices → [enter] pick). This guard runs
 *     BEFORE the stale check: in a batched chunk the popup may have closed
 *     without a repaint, and the double must still not leak.
 */
'use strict';

const hitMap = require('../../panel/hit-map');
const { paintNow: render } = require('../../leaves/infra/render-queue');
const { seqForKey } = require('../../leaves/render/hints');
// Module objects (not destructured): the dispatch seams are read at call time,
// which is also what lets tests spy on dispatch.handleKey / applyMsg.
const dispatch = require('./dispatch');
const loop = require('../runtime/loop');
const api = require('../../panel/api');
const intent = require('./intent');
const eventLog = require('../../io/event-log');

const DISCRETE = new Set(hitMap.DISCRETE_GESTURES);

// The last press the hit map handled: { mx, my, owner, id, repeat } | null.
let _lastPress = null;

function realizeHandler(h) {
  if (h == null || h === 'swallow') return;
  if (Array.isArray(h)) { for (const x of h) realizeHandler(x); return; }
  if (typeof h !== 'object') return;
  if (h.key != null) { dispatch.handleKey(h.key, h.seq != null ? h.seq : seqForKey(h.key)); return; }
  if (h.msg) {
    if (h.owner) loop.dispatchMsg(api.wrap(h.owner, h.msg));
    else dispatch.applyMsg(h.msg);
    return;
  }
  if (h.intent) intent.realize(h.intent);
}

// Does realizing `h` END with a keystroke? dispatch.handleKey paints at its own
// end, so the router's trailing paint would be a second full frame for nothing.
function _endsWithKey(h) {
  if (Array.isArray(h)) return h.length > 0 && _endsWithKey(h[h.length - 1]);
  return !!(h && typeof h === 'object' && h.key != null);
}

function _realizeAndPaint(hit, kind, mx, my) {
  // Recorded like a keystroke would be (event-log `input`), so a post-mortem
  // shows WHICH region a click resolved to — synthesized keys alone would look
  // like phantom keystrokes.
  eventLog.record('input', { kind: 'mouse', gesture: kind, owner: hit.region.owner, id: hit.region.id });
  try {
    realizeHandler(hit.handler);
    if (!_endsWithKey(hit.handler)) render();
    return;
  } catch (e) {
    // A throwing handler must not escape into the stdin pipeline. The event is
    // consumed (it did resolve to a region); the error is recorded.
    console.error('[mouse-router]', hit.region.owner, hit.region.id, e && e.message);
    try {
      eventLog.record('error', {
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
  const fresh = hitMap.stampsEqual(hitMap.frameStamp(), hitMap.stampOf(model, api.getInstanceSlice('layout')));

  if (kind === 'double' && _lastPress && _lastPress.mx === mx && _lastPress.my === my) {
    const last = _lastPress;
    _lastPress = null;
    if (!fresh) return true;                                // stale → swallow
    if (last.repeat) {
      const again = hitMap.resolve(mx, my, 'press');
      if (again && again.region.repeat && again.region.owner === last.owner && again.region.id === last.id) {
        _realizeAndPaint(again, 'press', mx, my);           // same chip → the key again
        return true;
      }
    }
    const hit = hitMap.resolve(mx, my, kind);
    if (!hit || hit.region.owner !== last.owner) return true;   // owner gone → swallow
    _realizeAndPaint(hit, kind, mx, my);
    return true;
  }
  if (kind === 'press' || kind === 'double') _lastPress = null;

  if (!fresh) return hitMap.claims(mx, my);   // stale: swallow what the old frame drew; else legacy
  const hit = hitMap.resolve(mx, my, kind);
  if (!hit) return false;
  if (kind === 'press') _lastPress = { mx, my, owner: hit.region.owner, id: hit.region.id, repeat: !!hit.region.repeat };
  _realizeAndPaint(hit, kind, mx, my);
  return true;
}

/** Test seam — forget the press→double continuation. */
function _reset() { _lastPress = null; }

module.exports = { route, realizeHandler, _reset };
