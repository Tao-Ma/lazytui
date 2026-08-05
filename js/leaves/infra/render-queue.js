/**
 * Render-debounce queue — coalesces rapid repaint requests into one paint.
 *
 * Lives in `leaves/infra/` (#D1 2026-06-18): bottom-of-import-graph but
 * STATEFUL (latched render fns + pending flags) and effectful (setTimeout,
 * invokes the paint callback → terminal I/O), so it sits in the stateful-infra
 * sub-tier, not `leaves/` proper (pure transforms). See infra/hub.js for the
 * tier contract.
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
 * It also doubles as the render-exit seam: paintNow / forceFullRepaint /
 * invalidateRows let dispatch + overlay drive the compositor WITHOUT a
 * static import of render/paint (the edge that kept render in the layer
 * SCC). paintNow is SYNCHRONOUS — it is a re-route of the old direct
 * render() call, not the debounced scheduleRender, so paint timing is
 * unchanged. See docs/v0.6.5-render-exit.md.
 *
 * Zero dependencies.
 */
'use strict';

let _renderFn = null;
let _overlayFn = null;
let _forceFn = null;
let _invalidateFn = null;
let _renderPending = false;
let _overlayRendering = false;
let _batchDepth = 0;
let _batchDirty = false;

/**
 * Register the actual paint callbacks. Called once during boot from
 * render/paint.js — must run before any plugin or PTY callback fires,
 * otherwise the early scheduleRender / scheduleOverlay calls are dropped.
 */
function setRenderers({ render, overlay, forceFull, invalidate } = {}) {
  if (render) _renderFn = render;
  if (overlay) _overlayFn = overlay;
  if (forceFull) _forceFn = forceFull;
  if (invalidate) _invalidateFn = invalidate;
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

/** Synchronous immediate repaint — the seam form of the old direct
 *  render() call (same timing). No-op until renderers are registered.
 *  Inside a beginBatch/endBatch window the paint is DEFERRED: the call
 *  marks the batch dirty and endBatch runs ONE trailing paint. */
function paintNow() {
  if (_batchDepth > 0) { _batchDirty = true; return; }
  if (_renderFn) _renderFn();
}

/**
 * Paint batching — coalesce a multi-event input chunk's paints into one
 * trailing paint (network-lag fix, 2026-08-05). Over a slow link,
 * autorepeat keystrokes arrive BATCHED in a single stdin chunk; painting
 * once per key queued N intermediate frames into the congested socket and
 * the client terminal replayed them all — the highlight visibly crawled
 * behind the key. Measured on an Actions-pane descent: a 5-key chunk
 * emitted 5 frames / 2,963 B per-key vs 1 frame / 586 B batched.
 *
 * Depth-counted (nestable — a batched token can re-enter the stdin
 * handler via `stdin.emit`), dirty-flagged (a chunk whose tokens all
 * dropped paints nothing). Only paintNow defers: scheduleRender already
 * debounces, and scheduleOverlay stays synchronous (PTY echo latency
 * dominates perception there).
 */
function beginBatch() { _batchDepth++; }
function endBatch() {
  if (_batchDepth > 0 && --_batchDepth === 0 && _batchDirty) {
    _batchDirty = false;
    if (_renderFn) _renderFn();
  }
}

/** Force a full (non-diff) repaint — chrome reclaims the screen. */
function forceFullRepaint() { if (_forceFn) _forceFn(); }

/** Mark screen rows [startY,endY) dirty so the next frame repaints them. */
function invalidateRows(startY, endY) { if (_invalidateFn) _invalidateFn(startY, endY); }

module.exports = {
  setRenderers, scheduleRender, scheduleOverlay,
  paintNow, beginBatch, endBatch, forceFullRepaint, invalidateRows,
};
