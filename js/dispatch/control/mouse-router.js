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
 *   { act, ...args }   a named input-time action (./mouse-acts) — the Msg is
 *                      computed at click time against current state (border
 *                      controls, the `[≡]` open), after re-checking the target.
 *                      It receives the event point; it may return a capture
 *                      request (a press that starts a drag).
 *   { capture, ...args } start pointer capture `capture` (./pointer-capture) —
 *                      the press starts a drag; motion / release then go to
 *                      that controller wherever the pointer is.
 *   'swallow'          consume, no-op.
 *   [h1, h2, …]        realize each in order (row double-click = nav + return).
 *
 * Scope: every pointer event (input.handleMouse is this call). DISCRETE
 * gestures (press / double / right / middle / wheel) resolve on the map.
 * motion / release never do — a drag that crosses a popup box must not be
 * swallowed by it: they go to the held pointer capture, if any, wherever the
 * pointer is; with none held they do nothing. A press while a capture is held
 * runs the controller's lost-release policy first. `hover` resolves to a body's
 * hover act, else clears (_hover). A gesture nothing claims does nothing (the
 * return value says whether anything did — tests).
 *
 * Two guards:
 *   - STALE FRAME: the hit map is stamped with what the frame showed
 *     (hit-map.stampOf — chain modes + the popup state's identity). If the
 *     current model differs (a batched `n`+click or Enter+click chunk —
 *     render-queue defers paint inside a batch) the user aimed at a screen that
 *     no longer exists. If that stale frame drew a region under the pointer the
 *     click was meant for it → swallowed (resolving it against changed state,
 *     or handing it to the pane the popup covered, are both wrong). If the stale
 *     frame drew nothing VISIBLE there (an in-grid mode publishes no bodies; a
 *     below-chrome backdrop is invisible), the router repaints at once and
 *     resolves against the fresh frame — taking only a pane body or the empty
 *     screen (what the pre-R3 legacy cascade did against live state); a popup
 *     the batched key opened keeps its outside policy dormant.
 *   - PRESS→DOUBLE CONTINUATION: the parser emits a same-cell second click as
 *     `double`. When the FIRST click was a hit-map press (picking a popup item,
 *     which usually closes the popup), the double belongs to that press's owner:
 *     if that region (owner + id) no longer holds the cell, the double is swallowed — without
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
const { paintNow: render, paintSync } = require('../../leaves/infra/render-queue');
const { seqForKey } = require('../../leaves/render/hints');
// Module objects (not destructured): the dispatch seams are read at call time,
// which is also what lets tests spy on dispatch.handleKey / applyMsg.
const dispatch = require('./dispatch');
const loop = require('../runtime/loop');
const api = require('../../panel/api');
const acts = require('./mouse-acts');
const capture = require('./pointer-capture');
const eventLog = require('../../io/event-log');
const { getModel } = require('../../model/store');
// The pane-body acts + the text-select / graph-zoom controllers, and the
// free-config ones, register themselves on load (Release 3) — loaded here so
// every router has them.
require('./pane-mouse');
require('./free-config-capture');

const DISCRETE = new Set(hitMap.DISCRETE_GESTURES);

// The last press the hit map handled: { mx, my, owner, id, repeat } | null.
let _lastPress = null;

// A capture's scope (pointer-capture SCOPE): the chain modes + the replay view
// a stamp records. A drag started under one scope is abandoned when it changes.
const _scopeOf = (stamp) => `${stamp.chain}|${stamp.replay == null ? '' : stamp.replay}`;

// Start a capture requested by a `{ capture }` handler or returned by an act —
// scoped to the state AFTER the press's other handlers ran (a press may focus /
// select, never change modes).
function _startCapture(req, ctx) {
  const { capture: name, ...args } = req;
  const scope = _scopeOf(hitMap.stampOf(getModel(), api.getInstanceSlice('layout')));
  capture.start(name, args, ctx && ctx.ev, ctx && ctx.owner, scope);
}

// Is the published frame current for a gesture? Its stamp equals the current
// one — or the frame showed the replay owner and the replay view is unchanged:
// replay's regions (the owner, the seek cells) depend on the replay view alone,
// not on the reconstructed model that moves under them (playback, seeks, Lock —
// replay repaints are debounced or, under Lock, skipped).
function _fresh(cur) {
  const fs = hitMap.frameStamp();
  if (hitMap.stampsEqual(fs, cur)) return true;
  return !!fs && fs.replay != null && fs.replay === cur.replay;
}

/** Realize one handler. `ctx` = { ev: { mx, my, x, y }, owner } — the event
 *  point (acts and captures need it) and the region owner (a capture records
 *  who started it). */
function realizeHandler(h, ctx) {
  if (h == null || h === 'swallow') return;
  if (Array.isArray(h)) { for (const x of h) realizeHandler(x, ctx); return; }
  if (typeof h !== 'object') return;
  if (h.key != null) { dispatch.handleKey(h.key, h.seq != null ? h.seq : seqForKey(h.key)); return; }
  if (h.msg) {
    if (h.owner) loop.dispatchMsg(api.wrap(h.owner, h.msg));
    else dispatch.applyMsg(h.msg);
    return;
  }
  if (h.capture) { _startCapture(h, ctx); return; }
  if (h.act) {
    const req = acts.realize(h, ctx && ctx.ev);
    if (req === false) { if (ctx) ctx.clean = true; return; }   // nothing changed → no paint
    if (req && typeof req === 'object' && req.capture) _startCapture(req, ctx);
  }
}

const _ev = (mx, my) => ({ mx, my, x: mx + 1, y: my + 1 });

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
    const ctx = { ev: _ev(mx, my), owner: hit.region.owner };
    realizeHandler(hit.handler, ctx);
    if (!_endsWithKey(hit.handler) && !ctx.clean) render();
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

/** Route one gesture. Returns true when something consumed it, false when
 *  nothing did (the event is dropped). `mx`/`my` are 0-based. */
function route(kind, mx, my, model) {
  const layoutSlice = api.getInstanceSlice('layout');
  if (kind === 'motion' || kind === 'release') {
    if (!capture.held()) return false;   // no drag in flight → nothing to do
    const scope = _scopeOf(hitMap.stampOf(model, layoutSlice));   // a modal opened mid-drag → abandoned
    const dirty = kind === 'motion' ? capture.motion(_ev(mx, my), scope) : capture.release(_ev(mx, my), scope);
    if (dirty) render();
    return true;
  }
  if (kind === 'hover') return _hover(mx, my, _fresh(hitMap.stampOf(model, layoutSlice)));
  if (!DISCRETE.has(kind)) return false;
  if (kind === 'press') {
    // A press while a drag is held = a lost release (the terminal never sent
    // it). The controller decides: keep the drag and eat the press, or drop
    // the drag and let the press route normally.
    const p = capture.press(_ev(mx, my));
    if (p.swallow) return true;
    if (p.dirty) render();
  }
  const fresh = _fresh(hitMap.stampOf(model, layoutSlice));
  // A tab-scoped region (a border control, a fold marker) whose pane switched
  // tabs since paint is stale on its own — the click is swallowed (hit-map
  // §Tab scope); every other pane's regions stay live.
  const moved = (h) => hitMap.tabMoved(h.region, layoutSlice);

  if (kind === 'double' && _lastPress && _lastPress.mx === mx && _lastPress.my === my) {
    const last = _lastPress;
    _lastPress = null;
    if (!fresh) return true;                                // stale → swallow
    if (last.repeat) {
      const again = hitMap.resolve(mx, my, 'press');
      if (again && again.region.repeat && again.region.owner === last.owner && again.region.id === last.id) {
        if (!moved(again)) _realizeAndPaint(again, 'press', mx, my);   // same chip → the key again
        return true;
      }
    }
    // The SAME region (owner + id): a pane's chrome, fold markers, tabs and body
    // share one owner, so owner alone let a fast 2nd click on `[_]` / a marker
    // fall through to the body's double-click (pre-release review).
    const hit = hitMap.resolve(mx, my, kind);
    if (!hit || hit.region.owner !== last.owner || hit.region.id !== last.id || moved(hit)) return true;   // region gone / tab switched → swallow
    _realizeAndPaint(hit, kind, mx, my);
    return true;
  }
  if (kind === 'press' || kind === 'double') _lastPress = null;

  let hit;
  if (!fresh) {
    // Stale frame (a batched chunk — the screen still shows the pre-key frame).
    // It drew something visible here → the click was aimed at it → swallow.
    if (hitMap.claims(mx, my)) return true;
    // It drew nothing visible here (an in-grid mode with no regions over the
    // panes — filter / search / agent, or an invisible below-chrome backdrop):
    // repaint now and resolve against the fresh frame, taking only what the
    // pre-R3 legacy cascade took against live state — a pane body or the
    // empty screen. A popup the batched key opened must not run its outside
    // policy on a click aimed at a screen without it (Release 3, decision A).
    paintSync();
    if (!hitMap.stampsEqual(hitMap.frameStamp(), hitMap.stampOf(model, layoutSlice))) return false;   // no renderer (unit tests)
    hit = hitMap.resolve(mx, my, kind);
    if (!hit || hit.region.z > hitMap.BANDS.BODY) return false;
  } else {
    hit = hitMap.resolve(mx, my, kind);
  }
  if (!hit) return false;
  if (moved(hit)) return true;                  // its pane switched tabs → swallow
  if (kind === 'press') _lastPress = { mx, my, owner: hit.region.owner, id: hit.region.id, repeat: !!hit.region.repeat };
  _realizeAndPaint(hit, kind, mx, my);
  return true;
}

// The hover gesture (mode 1003 button-less motion): the topmost region with a
// hover handler realizes it (a pane body's `pane-hover` act — coalesced per
// cell, it reports whether anything changed). Anything else — no region, a
// region without one, a popup box or backdrop — means the pointer is over no
// hoverable body: clear (HOVER_OUT), so a value box can't linger under an
// overlay. A region that DECLARES hover 'swallow' (the replay owner) is a true
// no-op. On a STALE frame hover does nothing at all — neither resolves (a
// batched key may have opened a popup over the graph) nor clears (replay may
// have just started: nothing may write into the reconstructed model); the next
// motion after the repaint resolves fresh. Never event-logged (it fires per cell).
const HOVER_OUT = Object.freeze({ act: 'pane-hover', paneId: null });
function _hover(mx, my, fresh) {
  if (!fresh) return true;
  const hit = hitMap.resolve(mx, my, 'hover');
  if (hit && hit.region.on && hit.region.on.hover === 'swallow') return true;
  const h = hit && hit.handler && typeof hit.handler === 'object' && hit.handler.act ? hit.handler : HOVER_OUT;
  try {
    if (acts.realize(h, _ev(mx, my))) render();
  } catch (e) {
    console.error('[mouse-router] hover', e && e.message);
    try { eventLog.record('error', { where: 'mouse_router', kind: 'hover', mx, my, message: e && e.message, stack: e && e.stack }); } catch (_) {}
  }
  return true;
}

/** Test seam — forget the press→double continuation, any held capture and the
 *  hover coalescing record (smoke's bootFresh calls it between scenarios). */
function _reset() { _lastPress = null; capture._reset(); require('./pane-mouse')._resetHover(); }

module.exports = { route, realizeHandler, _reset };
