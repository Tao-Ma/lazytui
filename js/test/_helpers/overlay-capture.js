/**
 * Shared paint-capture harness for overlay tests.
 *
 * Factored from test-fabric-field-overlay.js — the pattern [[feedback_render_test_new_overlays]]
 * says every new overlay must ship with. Captures the stdout bytes written
 * by a renderer, strips ANSI, returns the visible text.
 *
 * Why this exists: a reducer-only test on an overlay misses the entire
 * class of "mode flag flipped but nothing paints" bugs (v0.6.32
 * fabric-field invisible, v0.6.33 fabricFieldMode registry stale). Every
 * overlay with a render entry should get one of these.
 *
 * Usage:
 *   const { freshOverlayModel, captureOverlay } = require('./_helpers/overlay-capture');
 *   const m = freshOverlayModel({ cols: 120, rows: 30 });
 *   // ...drive reducer...
 *   const out = captureOverlay(m, () => renderXxxOverlay());
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

// --- One-time install: mute OSC-52 noise, point draw.setWriter at
// term.stdout.write so overlay renderers find their writer at boot (same
// path production uses). captureOverlay below patches .write per call. ---
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
 * Install `m` as the live model and run `fn()`, capturing everything
 * written to term.stdout. Returns the output with ANSI stripped (CSI +
 * OSC) so assertions match plain visible text.
 */
function captureOverlay(m, fn) {
  _install();
  store.setModel(m);
  const chunks = [];
  const orig = term.stdout.write;
  term.stdout.write = (s) => { chunks.push(String(s)); return true; };
  try { fn(); } finally { term.stdout.write = orig; }
  return chunks.join('')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '');
}

module.exports = { freshOverlayModel, captureOverlay };
