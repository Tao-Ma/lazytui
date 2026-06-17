/**
 * Panel-host port — the injected seam through which the `panel/` layer reaches
 * its hosts (dispatch + overlay) WITHOUT importing upward.
 *
 * `panel/` holds the Components (the bottom of the domain layering). The few
 * synchronous up-calls panel write-helpers / framework commands make — dispatch
 * a Component Msg, emit a root Msg, register an effect, stream a shell command —
 * are injected here and invoked through this leaf. Without it those would be
 * static `panel→dispatch` import edges.
 *
 * This is the formalized-injection seam for the SCATTERED synchronous panel
 * writers (viewer/select, viewer/search, viewer/tabs, free-config, files cmd) +
 * api's own refreshAll/setActiveTab. Effect handlers (per-call host) and the big
 * dispatch facades (nav-state, commands — per-module injected host) get dispatch
 * a different way; see docs/v0.6.5-dispatch-loop.md "formalize injection".
 *
 * Same mechanism as render-queue / feature-host: a zero-dep leaf holds function
 * slots; the host layer registers them once at boot. The wrappers delegate at
 * CALL time, so a wrapper may be imported (panel→leaves, legal) before its slot
 * is wired — only the eventual call must come after boot.
 *
 * `dispatchMsg`'s implementation lives in dispatch/runtime/fanout.js (B/S6 relocated the
 * Component fan-out to the dispatch layer); the seam just points at it.
 *
 * Wired at boot by dispatch/runtime/host-wiring.js#wirePanelHost (before the first
 * dispatch). See docs/v0.6.5-dispatch-loop.md + render-exit.md.
 */
'use strict';

let _dispatchMsg = null;
let _applyMsg = null;
let _registerEffect = null;
let _streamCommand = null;

function setPanelHost({ dispatchMsg, applyMsg, registerEffect, streamCommand } = {}) {
  if (dispatchMsg) _dispatchMsg = dispatchMsg;
  if (applyMsg) _applyMsg = applyMsg;
  if (registerEffect) _registerEffect = registerEffect;
  if (streamCommand) _streamCommand = streamCommand;
}

function dispatchMsg(...args) { return _dispatchMsg(...args); }
function applyMsg(...args) { return _applyMsg(...args); }
function registerEffect(...args) { return _registerEffect(...args); }
function streamCommand(...args) { return _streamCommand(...args); }

module.exports = {
  setPanelHost,
  dispatchMsg, applyMsg, registerEffect, streamCommand,
};
