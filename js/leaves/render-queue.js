/**
 * Render-debounce queue — coalesces rapid repaint requests into one paint.
 *
 * Exists to break the terminal ↔ layout module cycle. Both terminal.js
 * (PTY data callback) and actions.js (streamed stdout) want to ask "render
 * soon" without importing layout.js, while layout.js owns the actual paint
 * functions. layout.js registers its renderers here at startup; everyone
 * else just calls the schedulers.
 *
 *   scheduleRender — full repaint, ~50ms debounce (setTimeout). For
 *     burst-y producers like a streamed `docker logs -f`.
 *   scheduleOverlay — terminal overlay only, synchronous. PTY echo
 *     latency dominates user perception, so we render right after parse
 *     instead of waiting a setImmediate tick. The diff-render in
 *     renderTerminalOverlay makes repeat calls cheap (no-op rewrites
 *     for unchanged rows), so bursty `cat large_file` is handled fine.
 *
 * Zero dependencies.
 */
'use strict';

let _renderFn = null;
let _overlayFn = null;
let _renderPending = false;
let _overlayRendering = false;

/**
 * Register the actual paint callbacks. Called once during boot from
 * layout.js — must run before any plugin or PTY callback fires, otherwise
 * the early scheduleRender / scheduleOverlay calls are dropped.
 */
function setRenderers({ render, overlay } = {}) {
  if (render) _renderFn = render;
  if (overlay) _overlayFn = overlay;
}

function scheduleRender() {
  if (_renderPending || !_renderFn) return;
  _renderPending = true;
  setTimeout(() => { _renderPending = false; _renderFn(); }, 50);
}

function scheduleOverlay() {
  if (!_overlayFn || _overlayRendering) return;
  _overlayRendering = true;
  try { _overlayFn(); } finally { _overlayRendering = false; }
}

module.exports = { setRenderers, scheduleRender, scheduleOverlay };
