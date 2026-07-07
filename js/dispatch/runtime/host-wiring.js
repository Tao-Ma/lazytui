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
  const { mergeWires } = require('../../fabric/wires');
  const { getModel } = require('../../model/store');
  const api = require('../../panel/api');

  const group = () => getModel().currentGroup;

  setFabricHost({
    // A producer's RAW output lines (model.fabric.output[group][name]) — un-esc'd
    // and free of stream chrome, captured on process close, so parse sees clean
    // text (H1). Distinct from the chrome/esc'd display buffer (actionTabBuffers).
    // Ref-stable between runs, so fabric's parse memo keys on it correctly.
    componentLines(name) {
      const out = (getModel().fabric && getModel().fabric.output) || {};
      const g = out[group()];
      const lines = g && g[name];
      return Array.isArray(lines) ? lines : null;
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
    // Config-authored wires MERGED with runtime wires (model.fabric.wires) — a
    // runtime wire overrides a config wire to the same input (P1.5 pane wiring).
    // Each result carries a `source` tag for the wire list. resolve.js reads only
    // from/to, so the tag is inert there.
    wires() {
      const cfg = getModel().config;
      const g = cfg && cfg.groups && cfg.groups[group()];
      const configWires = (g && g.wires) || [];
      const runtimeWires = (getModel().fabric && getModel().fabric.wires) || [];
      return mergeWires(configWires, runtimeWires);
    },
  });
}

module.exports = { wirePanelHost, wireFabricHost };
