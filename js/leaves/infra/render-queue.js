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
 *  render() call (same timing). No-op until renderers are registered. */
function paintNow() { if (_renderFn) _renderFn(); }

/** Force a full (non-diff) repaint — chrome reclaims the screen. */
function forceFullRepaint() { if (_forceFn) _forceFn(); }

/** Mark screen rows [startY,endY) dirty so the next frame repaints them. */
function invalidateRows(startY, endY) { if (_invalidateFn) _invalidateFn(startY, endY); }

module.exports = {
  setRenderers, scheduleRender, scheduleOverlay,
  paintNow, forceFullRepaint, invalidateRows,
};
