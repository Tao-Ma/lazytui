/**
 * Panel-host port — the injected seam through which the `panel/` layer
 * reaches its hosts (dispatch + overlay) WITHOUT importing upward.
 *
 * `panel/` holds the Components (the bottom of the domain layering). The
 * few calls a Component / framework-command needs to make back UP into
 * dispatch (emit a root Msg, run effects, register an effect, stream a
 * shell command, tear down on :quit) or overlay (show help) are injected
 * here and invoked through this leaf. Without it those calls are static
 * `panel→dispatch` / `panel→overlay` import edges that re-form the layer
 * cycle (the residual {dispatch, overlay, panel} SCC).
 *
 * Same mechanism as render-queue / feature-host: a zero-dep leaf holds
 * function slots; the host layer registers them once at boot. The wrappers
 * delegate at CALL time, so a wrapper may be imported (panel→leaves, legal)
 * before its slot is wired — only the eventual call must come after boot.
 *
 * Wired at boot by dispatch/host-wiring.js#wirePanelHost (before the first
 * dispatch). See docs/v0.6.5-render-exit.md ("Domain detangle").
 */
'use strict';

let _dispatchMsg = null;
let _applyMsg = null;
let _runEffects = null;
let _registerEffect = null;
let _streamCommand = null;
let _cleanup = null;
let _showHelp = null;

function setPanelHost({ dispatchMsg, applyMsg, runEffects, registerEffect, streamCommand, cleanup, showHelp } = {}) {
  if (dispatchMsg) _dispatchMsg = dispatchMsg;
  if (applyMsg) _applyMsg = applyMsg;
  if (runEffects) _runEffects = runEffects;
  if (registerEffect) _registerEffect = registerEffect;
  if (streamCommand) _streamCommand = streamCommand;
  if (cleanup) _cleanup = cleanup;
  if (showHelp) _showHelp = showHelp;
}

// dispatch capabilities (panel → dispatch, inverted)
// dispatchMsg = the Component fan-out (lives in panel/api today; relocates to
// dispatch/ in B/S6 — only host-wiring's source line changes, callers don't).
function dispatchMsg(...args) { return _dispatchMsg(...args); }
function applyMsg(...args) { return _applyMsg(...args); }
function runEffects(...args) { return _runEffects(...args); }
function registerEffect(...args) { return _registerEffect(...args); }
function streamCommand(...args) { return _streamCommand(...args); }
function cleanup(...args) { return _cleanup(...args); }
// overlay capability (panel → overlay, inverted)
function showHelp(...args) { return _showHelp(...args); }

module.exports = {
  setPanelHost,
  dispatchMsg, applyMsg, runEffects, registerEffect, streamCommand, cleanup, showHelp,
};
