/**
 * Shared paint-capture harness for overlay tests.
 *
 * Factored from test-fabric-field-overlay.js — the pattern [[feedback_render_test_new_overlays]]
 * says every new overlay must ship with. Hands the renderer a newRows
 * buffer, lets it composite, strips markup/SGR, returns the visible text.
 *
 * Why this exists: a reducer-only test on an overlay misses the entire
 * class of "mode flag flipped but nothing paints" bugs (v0.6.32
 * fabric-field invisible, v0.6.33 fabricFieldMode registry stale). Every
 * overlay with a render entry should get one of these.
 *
 * Usage (overlay-compositor Release 2 and beyond — overlay fns take
 * `(..., newRows, cols)`):
 *   const { freshOverlayModel, captureOverlay } = require('./_helpers/overlay-capture');
 *   const m = freshOverlayModel({ cols: 120, rows: 30 });
 *   // ...drive reducer...
 *   const out = captureOverlay(m, (nr, c) => renderXxxOverlay(nr, c));
 *   assert(out.includes('expected text'));
 *
 * NOTE: this is for pure-overlay-render tests (one render fn, one model
 * state). For a full paint test see smoke/_helpers/smoke.js createSession.
 */
'use strict';

const runtime = require('../../app/runtime');
const store = require('../../model/store');
const term = require('../../io/term');
const draw = require('../../leaves/render/draw');
const { stripMarkup } = require('../../leaves/text/ansi');

// --- One-time install: mute OSC-52 noise, point draw.setWriter at
// term.stdout.write so overlays that still write to stdout directly
// (pane-menu, cmdline — their non-compositor cell-boundary writes) find
// their writer at boot (same path production uses). ---
let _installed = false;
function _install() {
  if (_installed) return;
  _installed = true;
  const _origWrite = term.stdout.write.bind(term.stdout);
  term.stdout.write = (chunk, ...rest) => {
    const s = typeof chunk === 'string' ? chunk : '';
    if (s.startsWith('\x1b]52;')) return true;        // OSC-52 clipboard noise
    return _origWrite(chunk, ...rest);
  };
  draw.setWriter((s) => term.stdout.write(s));
}

/**
 * Fresh model sized for overlay tests. Default 120x30 — wide enough for
 * most overlays' chrome without going into scroll edge cases. Pass
 * cols/rows to override.
 *
 * Also sets a sane `currentGroup` and an empty register so overlay code
 * reading those doesn't trip on `undefined`.
 */
function freshOverlayModel(opts) {
  opts = opts || {};
  _install();
  const m = runtime.init();
  m.currentGroup = opts.currentGroup || 'g';
  m.register = m.register || { history: [], cap: 10 };
  const cols = opts.cols || 120;
  const rows = opts.rows || 30;
  process.stdout.columns = cols;
  process.stdout.rows = rows;
  term.refreshSize();
  return m;
}

/**
 * Install `m` as the live model and run `fn(newRows, cols)`, giving the
 * fn a blank newRows buffer sized to the model's dims. Returns the
 * composited rows joined with `\n`, with Rich markup + SGR stripped so
 * assertions match plain visible text.
 *
 * Overlay-compositor Release 2 shape — `renderOverlay`'s stdout fallback
 * is gone; every overlay fn needs the buffer to paint anything.
 */
function captureOverlay(m, fn, opts) {
  _install();
  store.setModel(m);
  opts = opts || {};
  // Match the overlay's view of dims — `viewportDims()` reads from the
  // injected provider (model's layout slice), which freshOverlayModel
  // doesn't update. So size the buffer to viewportDims so the overlay
  // paints into cells the buffer actually has.
  const vp = draw.viewportDims();
  const cols = opts.cols || vp.cols;
  const availH = Math.max(1, (opts.rows || vp.rows) - 1);
  const newRows = new Array(availH).fill(' '.repeat(cols));
  fn(newRows, cols);
  // Strip Rich markup + SGR via the shared `stripMarkup` leaf — it
  // handles the `\[` → literal `[` round-trip correctly (via its own
  // sentinel pass). Keep every row the overlay touched; filter blank
  // rows so the "nothing painted" case returns an empty string the way
  // the pre-migration captureOverlay (stdout-based) did.
  const stripped = newRows
    .map(r => stripMarkup(r).replace(/\s+$/, ''))
    .filter(r => r.length > 0)
    .join('\n');
  return stripped;
}

module.exports = { freshOverlayModel, captureOverlay };
