/**
 * Boot wiring for the panel-host seam (leaves/panel-host.js).
 *
 * The `panel/` layer invokes a handful of dispatch + overlay capabilities
 * through that seam instead of importing upward. This module — a dispatch-
 * layer module that legitimately imports its dispatch siblings and reaches
 * DOWN-to-up into overlay/help (dispatch→overlay, legal) — registers the
 * real functions into the seam once, at boot.
 *
 * Must run before the first dispatch (called from app/tui.js#main, ahead of
 * installBuiltins / component registration). The requires are resolved here,
 * at call time, so loading this module never eagerly drags the dispatch graph
 * in through an import.
 */
'use strict';

const panelHost = require('../leaves/panel-host');

function wirePanelHost() {
  const api = require('../panel/api');
  const { applyMsg } = require('./dispatch');
  const { runEffects, registerEffect } = require('./effects');
  const { streamCommand } = require('./stream');
  const { cleanup } = require('./cleanup');
  const { showHelp } = require('../overlay/help');
  panelHost.setPanelHost({
    // dispatchMsg lives in panel/api today; B/S6 relocates it to dispatch/fanout
    // — only this source line changes then, never the panel callers.
    dispatchMsg: api.dispatchMsg,
    applyMsg, runEffects, registerEffect, streamCommand, cleanup, showHelp,
  });
}

module.exports = { wirePanelHost };
