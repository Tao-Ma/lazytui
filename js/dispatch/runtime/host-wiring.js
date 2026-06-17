/**
 * Boot wiring for the panel-host seam (leaves/panel-host.js).
 *
 * The `panel/` layer invokes a few dispatch capabilities (the relocated
 * Component fan-out `dispatchMsg`, the root `applyMsg`, `registerEffect`, and
 * `streamCommand`) through that seam instead of importing upward. This dispatch-
 * layer module imports its dispatch siblings + the relocated fan-out and
 * registers the real functions into the seam once, at boot.
 *
 * Must run before the first dispatch (called from app/tui.js#main, ahead of
 * installBuiltins / component registration). The requires are resolved here,
 * at call time, so loading this module never eagerly drags the dispatch graph
 * in through an import.
 */
'use strict';

const panelHost = require('../../leaves/panel-host');

function wirePanelHost() {
  const { dispatchMsg } = require('./fanout');   // the relocated Component fan-out (B/S6)
  const { applyMsg } = require('../control/dispatch');
  const { registerEffect } = require('./effects');
  const { streamCommand } = require('./stream');
  panelHost.setPanelHost({ dispatchMsg, applyMsg, registerEffect, streamCommand });
}

module.exports = { wirePanelHost };
