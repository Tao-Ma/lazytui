/**
 * Per-frame HIT MAP — every clickable thing the last frame actually drew, as
 * z-ordered regions with DATA handlers (docs/mouse-hit-map.md).
 *
 * The paint↔hit-test agreement (reference_paint_hittest_agreement) as the one
 * mechanism for the mouse: paint publishes a region only where it drew the
 * thing, so a click can't land on a phantom (a truncated hint chip, a scrolled-
 * off row, a dropped glyph publishes nothing). The router
 * (dispatch/control/mouse-router) resolves the topmost region under the pointer
 * and realizes its handler; precedence is z-order, not source order.
 *
 * Region shape:
 *   { id, rect: {x, y, w, h}, z, owner, opaque?, on: { [gesture]: handler } }
 *   - rect: screen cells, 0-based, [x, x+w) × [y, y+h).
 *   - on: gesture → handler, where gesture is a handleMouse kind (press, double,
 *     right, middle, wheel-up, wheel-down, …) and handler is DATA — `{ key }`,
 *     `{ msg, owner? }`, `{ intent }`, `'swallow'`, or an array of those.
 *   - opaque: the region stops the resolve walk even when it has no handler for
 *     the gesture (a popup box, a modal backdrop). Rows and chips are not opaque,
 *     so an unhandled gesture over them falls to the box beneath.
 *
 * Lifecycle: `clear(stamp)` at the top of every main-frame paint (render/paint
 * render(), beside the chrome/tree/hover registries), repopulated in the same
 * synchronous pass. `stamp` is modes.chainStamp(model.modes) — the router
 * abstains when the CURRENT modes no longer match it (§Stale-frame rule). Before
 * the first paint the stamp is null, so every resolve abstains.
 *
 * Ambient owner: the overlay compositor brackets each overlay's render with
 * `enterOwner(id, zBase)` / `exitOwner()`, so leaves that publish through the
 * draw.js hit sink (renderOverlay → publishBox) stamp `owner` + absolute `z`
 * without each overlay threading its id. Outside a bracket the sink drops
 * (a test calling an overlay's render directly publishes nothing).
 *
 * Panel layer, beside chrome-regions (dispatch → panel is a legal edge; the
 * render layer writes here the same way it writes chrome-regions).
 */
'use strict';

const _regions = [];
let _seq = 0;
let _stamp = null;
let _sorted = null;      // memoized top-down order; invalidated by publish/clear
let _owner = null;       // { owner, zBase } while an overlay renders

/** Drop every region and stamp the new frame. */
function clear(stamp) {
  _regions.length = 0;
  _seq = 0;
  _sorted = null;
  _stamp = stamp == null ? null : String(stamp);
}

/** Record one region. Malformed regions (no rect / non-finite / empty) are
 *  ignored rather than thrown — a paint-side bug must not crash the frame. */
function publish(region) {
  if (!region || !region.rect) return;
  const { x, y, w, h } = region.rect;
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return;
  _regions.push({ ...region, _seq: _seq++ });
  _sorted = null;
}

/** Publish a region relative to the ambient owner: `zOff` is added to the
 *  owner's zBase and `owner` is stamped. No ambient owner → dropped. */
function publishOwned(region, zOff) {
  if (!_owner) return;
  publish({ ...region, owner: _owner.owner, z: _owner.zBase + (zOff | 0) });
}

function enterOwner(owner, zBase) { _owner = { owner, zBase: zBase | 0 }; }
function exitOwner() { _owner = null; }

function _order() {
  if (!_sorted) {
    // Top-down: higher z first; equal z → later-published (painted on top) first.
    _sorted = _regions.slice().sort((a, b) => ((b.z | 0) - (a.z | 0)) || (b._seq - a._seq));
  }
  return _sorted;
}

function _contains(r, mx, my) {
  return mx >= r.x && mx < r.x + r.w && my >= r.y && my < r.y + r.h;
}

/** Resolve the region that owns `gesture` at (mx, my): the topmost containing
 *  region with a handler for it, or the topmost OPAQUE containing region (which
 *  consumes the event as 'swallow'). null when nothing claims the point. */
function resolve(mx, my, gesture) {
  for (const r of _order()) {
    if (!_contains(r.rect, mx, my)) continue;
    const h = r.on && r.on[gesture];
    if (h != null) return { region: r, handler: h };
    if (r.opaque) return { region: r, handler: 'swallow' };
  }
  return null;
}

/** The stamp the current regions were published under (null before a paint). */
function frameStamp() { return _stamp; }

/** Snapshot of the published regions, publish order — tests + diag. */
function all() { return _regions.map(({ _seq, ...r }) => r); }

module.exports = { clear, publish, publishOwned, enterOwner, exitOwner, resolve, frameStamp, all };
