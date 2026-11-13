/**
 * Overlay compositor registry — the structural fix for Classes A + B
 * at the pattern level (overlay-compositor-migration Release 3 of 3,
 * docs/overlay-compositor-migration.md). Replaces paint.js's imperative
 * if-chain with a declarative list of descriptors. Each overlay
 * registers once at boot (via `registerSelf(compositor)` from
 * `app/tui.js`); each frame, `paintActive(model, newRows, cols)`
 * composites the subset whose `isActive(model)` returns true, in
 * zIndex order, with the flat-modal invariant enforced structurally.
 *
 * Descriptor shape:
 *   {
 *     id:       string,                        // unique
 *     isActive: (model) => bool,               // pure
 *     render:   (model, newRows, cols) => void,// mutates newRows
 *     modal:    bool,                          // enforces flat-modal
 *     zIndex:   int,                           // paint order (hi = on top)
 *     mouse:    { outside } | undefined,       // hit-map opt-in (below)
 *   }
 *
 * Hit map (docs/mouse-hit-map.md): each overlay's render is bracketed with
 * `hitMap.enterOwner(id, zBase)` so the regions its renderOverlay/publishBox
 * publishes carry the overlay id and an absolute z in the overlay's band
 * (`HIT_BAND_BASE + 10·zIndex + {0 backdrop, 1 box, 2 rows, 3 chips}`). A
 * descriptor with `mouse.outside` (a handler — `{ key: 'escape' }` or
 * `'swallow'`) also gets a full-screen OPAQUE backdrop under its box: an
 * outside click realizes that handler, and nothing beneath the popup can be
 * hit. No `mouse` → no backdrop (misses fall through to the legacy cascade).
 *
 * Pure for tests: `activeOverlayIds(model)` reports the ordered id
 * list this frame would paint, without doing any rendering. `_reset()`
 * exists for test isolation (production code never calls it; the
 * registry is boot-wired once per process).
 *
 * This commit introduces the module + wires `paintActive` into
 * paint.js AFTER the existing if-chain. With zero overlays registered,
 * paintActive is a no-op — no behavior change. Follow-up commits
 * migrate overlays one at a time: add their descriptor, delete their
 * if-check from paint.js. The if-chain goes to zero at the end of
 * Release 3.
 */
'use strict';

// Boot-wired registry. In production this is populated once at
// app/tui.js boot, before first paint. Each descriptor is a plain
// object; no closures over mutable scope beyond module require()s
// (keeps replay-fold deterministic — WAL re-execution hits the same
// descriptors because they live in a module cached at the same
// require() site).
const _descriptors = [];

/**
 * Register an overlay descriptor. Idempotent on `id` — a second
 * registration with the same id replaces the first (makes test
 * harness `_reset()` + re-register work; production never re-registers).
 */
function register(descriptor) {
  const i = _descriptors.findIndex(d => d.id === descriptor.id);
  if (i >= 0) _descriptors[i] = descriptor;
  else _descriptors.push(descriptor);
}

/**
 * Flat-modal invariant enforcement + zIndex sort. Returns the active
 * descriptor list in paint order (lowest zIndex first = painted first
 * = under; highest = painted last = on top). If two `modal: true`
 * descriptors are both active, keep the higher zIndex, drop the other,
 * log a dev-warn — a broken Msg has flipped two modal flags at the
 * reducer, which the reducer's own `isChainActive` guard should have
 * prevented. The compositor is the structural safety net.
 */
function _active(model) {
  const act = _descriptors.filter(d => d.isActive(model));
  const modals = act.filter(d => d.modal);
  let keep = act;
  if (modals.length > 1) {
    const sorted = modals.slice().sort((a, b) => (b.zIndex | 0) - (a.zIndex | 0));
    const kept = sorted[0];
    const dropped = sorted.slice(1).map(d => d.id);
    // Dev-warn only — goes to stderr in both production and tests. The
    // compositor is the structural safety net; the message names the
    // kept + dropped ids so a dev scanning stderr can trace back to the
    // broken reducer Msg that flipped two modal flags concurrently.
    // Tests can assert on this by stubbing console.warn (see
    // test-overlay-compositor.js's flat-modal pins).
    console.warn('[overlay-compositor] two modal overlays active — this is a bug',
      { kept: kept.id, dropped });
    keep = act.filter(d => !d.modal || d === kept);
  }
  return keep.slice().sort((a, b) => (a.zIndex | 0) - (b.zIndex | 0));
}

/**
 * Pure projection — the ordered id list this frame would paint. For
 * tests + future dev-tooling. No side effects; the compositor itself
 * doesn't call it (paintActive uses `_active` directly).
 */
function activeOverlayIds(model) {
  return _active(model).map(d => d.id);
}

/**
 * Paint the active overlay set into `newRows` at `cols` width. Called
 * from paint.js's render() AFTER the main-frame compose pass and
 * BEFORE `_paintMainFrame`'s cell-diff. Mutates `newRows` in place;
 * returns nothing.
 */
const HIT_BAND_BASE = 1000;
let _hitMapRef; const _hitMap = () => (_hitMapRef ||= require('../panel/hit-map'));
let _drawRef; const _screenRows = () => (_drawRef ||= require('../leaves/render/draw')).viewportDims().rows;

function _backdrop(outside, cols, rows) {
  return {
    id: 'backdrop',
    rect: { x: 0, y: 0, w: cols, h: rows },
    opaque: true,
    on: { press: outside, double: outside, right: outside, middle: outside,
          'wheel-up': 'swallow', 'wheel-down': 'swallow' },
  };
}

function paintActive(model, newRows, cols) {
  const hm = _hitMap();
  for (const d of _active(model)) {
    hm.enterOwner(d.id, HIT_BAND_BASE + 10 * (d.zIndex | 0));
    try {
      const outside = d.mouse && d.mouse.outside;
      // FULL screen: newRows is the main frame, which stops above the footer row
      // (painted separately) — sizing by it left the footer outside every
      // backdrop, so a click there slipped past the popup's outside policy.
      if (outside != null) hm.publishOwned(_backdrop(outside, cols, Math.max(newRows.length, _screenRows())), 0);
      d.render(model, newRows, cols);
    } finally {
      hm.exitOwner();
    }
  }
}

/** Clear the registry — tests only. Production never calls this. */
function _reset() { _descriptors.length = 0; }

/** Count — tests only. For the "zero overlays registered" assertion. */
function _count() { return _descriptors.length; }

module.exports = { register, paintActive, activeOverlayIds, HIT_BAND_BASE, _reset, _count };
