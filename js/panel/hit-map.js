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
 *     `{ msg, owner? }`, `{ intent }`, `{ act, …args }`, `'swallow'`, or an
 *     array of those (realized by dispatch/control/mouse-router).
 *   - repeat: a fast 2nd click on the SAME region is another press (hint chips,
 *     border-control steppers); otherwise the router swallows it.
 *   - invisible: a policy region nobody sees (an in-grid popup's below-chrome
 *     backdrop) — handles gestures on a fresh frame, but `claims` ignores it.
 *   - opaque: the region stops the resolve walk even when it has no handler for
 *     the gesture (a popup box, a modal backdrop). Rows and chips are not opaque,
 *     so an unhandled gesture over them falls to the box beneath.
 *
 * Lifecycle: `clear(stamp)` at the top of every main-frame paint (render/paint
 * render(), beside the hover-region clear), repopulated in the same
 * synchronous pass. `stamp` is stampOf(model, layoutSlice) — WHAT the frame
 * showed: the active chain modes plus the identity of the state the popups paint
 * from. The router compares it with the current model (stampsEqual); a mismatch
 * means the user aimed at a screen that no longer matches state (a batched
 * Enter+click chunk — render-queue defers paint inside a batch) and the click
 * must not resolve against the stale regions (§Stale-frame rule). Before the
 * first paint the stamp is null — never equal to a live stamp.
 *
 * Ambient owner: the overlay compositor brackets each overlay's render with
 * `enterOwner(id, zBase)` / `exitOwner()`, so leaves that publish through the
 * draw.js hit sink (renderOverlay → publishBox) stamp `owner` + absolute `z`
 * without each overlay threading its id. Outside a bracket the sink drops
 * (a test calling an overlay's render directly publishes nothing).
 *
 * Ambient pane (Release 2): paint brackets each pane's render with
 * `enterPane(paneId, rect)` / `exitPane()`. Pane chrome and in-pane affordances
 * publish PANE-LOCAL rects through `publishLocal(region, z)`, which translates
 * them to the screen, clips them to the pane and stamps `owner = paneId` — a
 * pane renderer never needs its own screen origin.
 *
 * Panel layer (dispatch → panel and render → panel are legal edges).
 */
'use strict';

const { chainStamp } = require('../leaves/input/modes');
const geometry = require('../leaves/wm/geometry');
const mpool = require('../leaves/wm/pool');

// Absolute z bands (docs/mouse-hit-map.md §Z bands) — the one table. Overlay
// k sits at OVERLAY_BASE + 10·zIndex_k + draw.HIT_Z offsets (the compositor),
// so every popup covers every pane-anchored band.
const BANDS = Object.freeze({
  IN_PANE: 30,          // tree fold markers
  BELOW_CHROME: 35,     // in-grid overlay backdrops (jobs / pane-menu / which-key)
  CHROME: 40,           // [_]/[+]/[X]/[≡], border controls, tab strip, ✗ cancel
  OVERLAY_BASE: 1000,   // compositor-registered overlays
});

// The discrete pointer gestures the router resolves (R1) — the single list
// both the router (what it routes) and the compositor's backdrop (what it must
// own) read, so a new gesture can't be routed yet unhandled by a backdrop.
const DISCRETE_GESTURES = Object.freeze(['press', 'double', 'right', 'middle', 'wheel-up', 'wheel-down']);

const _regions = [];
let _seq = 0;
let _stamp = null;
let _sorted = null;      // memoized top-down order; invalidated by publish/clear
let _owner = null;       // { owner, zBase } while an overlay renders
let _pane = null;        // { owner: paneId, rect } while a pane renders

/** Drop every region and stamp the new frame. */
function clear(stamp) {
  _regions.length = 0;
  _seq = 0;
  _sorted = null;
  _stamp = stamp == null ? null : stamp;
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

/** Drop every region `owner` published this frame — a pane whose render threw
 *  after its chrome published paints an error block with no chrome. */
function retractOwner(owner) {
  for (let i = _regions.length - 1; i >= 0; i--) if (_regions[i].owner === owner) _regions.splice(i, 1);
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

/** Bracket a pane's render (paint). `rect` is the pane's screen rect. */
function enterPane(paneId, rect) { _pane = paneId && rect ? { owner: paneId, rect } : null; }
function exitPane() { _pane = null; }

/** Publish a PANE-LOCAL region for the ambient pane at absolute `z`: the rect
 *  is translated by the pane's screen origin and clipped to the pane (a glyph
 *  past the pane edge can't claim a neighbour's cells). No ambient pane →
 *  dropped (an overlay's renderPanel, a direct unit call). */
function publishLocal(region, z) {
  if (!_pane || !region || !region.rect) return;
  const P = _pane.rect, r = region.rect;
  const x0 = Math.max(P.x, P.x + r.x), y0 = Math.max(P.y, P.y + r.y);
  const x1 = Math.min(P.x + P.w, P.x + r.x + r.w), y1 = Math.min(P.y + P.h, P.y + r.y + r.h);
  if (!(x1 > x0) || !(y1 > y0)) return;
  publish({ ...region, rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, owner: _pane.owner, z });
}

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

// The frame's pane geometry as a string: dims + every VISIBLE pane rect, the
// same view-mode-aware derivation hit-tests use (visibleBoundsFor). Changes
// exactly when a visible pane moves / resizes / collapses / appears / vanishes.
// NOT the layout slice's identity: graph_hover writes that slice on every cell
// change over a graph, and motion + press often share a stdin chunk — identity
// would stale (and swallow) ordinary clicks.
// panel/route, resolved lazily (route's own load graph is heavy) and CACHED: a
// require() inside a per-frame / per-click function costs tens of µs each call
// (render/paint documents the same trap) — stampOf runs on both paths.
let _routeRef = null;
function _geomKey(layoutSlice) {
  if (!layoutSlice) return '';
  let viewer = null;
  try { viewer = (_routeRef || (_routeRef = require('./route'))).resolveViewerPaneId(); } catch (_) { /* boot edge */ }
  const m = geometry.visibleBoundsMap(layoutSlice, viewer);
  const d = layoutSlice.dims;
  let s = d ? `${d.cols}x${d.rows}|` : '|';
  if (!m) return s;
  // Each visible pane's ACTIVE TAB too: a slot that switched tabs shows another
  // renderer's chrome (border controls, fold markers) at the same rect, so a
  // click aimed at the old tab's control must not reach the new tab's instance.
  const tab = {};
  for (const p of mpool.allPanesInColumns(layoutSlice.arrange)) if (p && p.paneId) tab[p.paneId] = p.activeTabId || '';
  for (const k of Object.keys(m)) { const r = m[k]; if (r) s += `${k}:${r.x},${r.y},${r.w},${r.h}@${tab[k] || ''};`; }
  return s;
}

/** What a frame showed, for the stale-frame check. Mode flags alone miss a
 *  content change under an unchanged mode — Enter on a context-menu row that
 *  REPLACES the menu with a submenu, Space toggling fabric-form's choices list,
 *  typing that refilters the palette — so the stamp also carries the identity
 *  of the slices popups paint from. Every popup reducer replaces `model.modal`
 *  on a change and leaves it alone otherwise (clock_tick / focus_event keep it),
 *  so identity is exact. `jobs` / `diagLog` count only while their window is
 *  open: their async mirrors replace the list, which shifts the index-targeted
 *  rows; when closed they must not stale every frame. `geom` (Release 2) covers
 *  pane chrome: a batched key that moves a pane stales the frame (_geomKey).
 *  Pure of the model except the half-view viewer pane, which _geomKey reads
 *  from the route (the same read paint makes). */
function stampOf(model, layoutSlice) {
  const md = (model && model.modes) || {};
  return {
    chain: chainStamp(md),
    modal: model ? model.modal : undefined,
    prefixSeq: model ? model.prefixSeq : undefined,
    paneMenu: layoutSlice ? layoutSlice.paneMenu : undefined,
    jobs: md.jobsMode ? model.jobs : null,
    diagLog: md.diagLogMode ? model.diagLog : null,
    geom: _geomKey(layoutSlice),
  };
}

/** Field-wise identity comparison of two stamps (null never equals a stamp). */
function stampsEqual(a, b) {
  if (!a || !b) return false;
  for (const k of Object.keys(b)) if (a[k] !== b[k]) return false;
  return Object.keys(a).length === Object.keys(b).length;
}

/** The stamp the current regions were published under (null before a paint). */
function frameStamp() { return _stamp; }

/** Did the last frame publish ANY region containing (mx, my)? The stale-frame
 *  rule's question: was the user aiming at something this map drew there. An
 *  `invisible` region (an in-grid popup's below-chrome backdrop — a policy over
 *  panes that look live, not something the user sees) does not count. */
function claims(mx, my) {
  return _regions.some(r => !r.invisible && _contains(r.rect, mx, my));
}

/** Snapshot of the published regions, publish order — tests + diag. */
function all() { return _regions.map(({ _seq, ...r }) => r); }

module.exports = { clear, publish, publishOwned, enterOwner, exitOwner,
  enterPane, exitPane, publishLocal, retractOwner, resolve, claims,
  stampOf, stampsEqual, frameStamp, all, DISCRETE_GESTURES, BANDS };
