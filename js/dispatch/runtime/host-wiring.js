/**
 * Boot wiring for the panel-host seam (hosts/panel-host.js).
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

const panelHost = require('../../hosts/panel-host');

function wirePanelHost() {
  const { dispatchMsg } = require('./loop');   // the relocated Component fan-out (B/S6)
  const { applyMsg } = require('../control/dispatch');
  const { registerEffect } = require('./effects');
  const { streamCommand } = require('./stream');
  panelHost.setPanelHost({ dispatchMsg, applyMsg, registerEffect, streamCommand });
}

// Boot wiring for the dataflow-fabric host seam (fabric/ports.js). Gives the
// fabric read access to a component's current output + declared spec + the wire
// list off the model/config, WITHOUT fabric importing panel/model upward
// (docs/ports-and-wires.md). Same call-time-require discipline as above.
// P1 resolves within the CURRENT group (wires are same-group; the pipe runs in
// the focused group).
function wireFabricHost() {
  const { setFabricHost } = require('../../fabric/ports');
  const { getModel } = require('../../model/store');
  const route = require('../../panel/route');
  const api = require('../../panel/api');

  const group = () => getModel().currentGroup;

  setFabricHost({
    // Current output lines of a producer routed to its tab buffer
    // (actionTabBuffers[group][name].lines) — ref-stable until it changes, so
    // fabric's parse memo keys on it correctly.
    componentLines(name) {
      const target = route.resolveTarget('viewer');
      if (target == null) return null;
      const slice = api.getInstanceSlice(target);
      const g = slice && slice.actionTabBuffers && slice.actionTabBuffers[group()];
      const buf = g && g[name];
      return buf ? buf.lines : null;
    },
    // Declared parse/ports off the merged action set (config + plugin actions).
    componentSpec(name) {
      const a = api.getMergedActions(group())[name];
      if (!a) return null;
      return { parse: a.parse || null, ports: a.ports || null };
    },
    listComponents() {
      const acts = api.getMergedActions(group());
      return Object.keys(acts).filter(k => acts[k] && acts[k].ports);
    },
    wires() {
      const cfg = getModel().config;
      const g = cfg && cfg.groups && cfg.groups[group()];
      return (g && g.wires) || [];
    },
  });
}

module.exports = { wirePanelHost, wireFabricHost };
