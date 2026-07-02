/**
 * Fabric injects sub-reducer — the by-value, sticky one-shot pushes into an
 * input port (docs/ports-and-wires.md, decision 1). Delegated by the root
 * reducer via { TYPES, update }, the same mechanism as the modal sub-reducers
 * (#D12), though injects are fabric state, not a modal.
 *
 * Injects live at `model.fabric.injects`, keyed by the `component.port` address:
 *   - transient (never serialised to config) but IN-MODEL, so they ride the WAL
 *     and replay reproduces them (same discipline as model.modal.continuation);
 *   - STICKY: persist until overwritten by a newer inject to the same port
 *     (last-write-wins) or explicitly cleared — NOT auto-consumed on run.
 * Resolve-time precedence is inject > wire > default (the action-runner hook,
 * slice 5). The pane's source badge (P1.5) makes a shadowing inject visible.
 *
 * Pure: returns [nextModel, []]; identity-preserved on a no-op clear. `at` is
 * stamped from model.now (the frame clock) — replay-safe, never Date.now().
 */
'use strict';

const TYPES = ['port_inject', 'port_clear'];

function _withInjects(model, injects) {
  return { ...model, fabric: { ...(model.fabric || {}), injects } };
}

function update(model, msg) {
  const injects = (model.fabric && model.fabric.injects) || {};
  switch (msg.type) {
    case 'port_inject': {
      // { port: "xlogminer.start_lsn", value } — last-write-wins.
      if (typeof msg.port !== 'string' || !msg.port) return [model, []];
      const next = { ...injects, [msg.port]: { value: msg.value, at: model.now } };
      return [_withInjects(model, next), []];
    }
    case 'port_clear': {
      // { port } — remove one; identity-preserve when absent (no-op).
      if (typeof msg.port !== 'string' || !(msg.port in injects)) return [model, []];
      const next = { ...injects };
      delete next[msg.port];
      return [_withInjects(model, next), []];
    }
    default:
      return [model, []];
  }
}

module.exports = { TYPES, update };
