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

const TYPES = ['port_inject', 'port_clear', 'fabric_output_set', 'wire_create', 'wire_delete'];

function _withInjects(model, injects) {
  return { ...model, fabric: { ...(model.fabric || {}), injects } };
}

function _withWires(model, wires) {
  return { ...model, fabric: { ...(model.fabric || {}), wires } };
}

function update(model, msg) {
  const injects = (model.fabric && model.fabric.injects) || {};
  switch (msg.type) {
    case 'fabric_output_set': {
      // Raw producer stdout (un-esc'd, no chrome) captured for parsing, keyed by
      // [group][component]. Set semantics — each run replaces (the memoized
      // parse re-runs once per run, on the new lines-array identity). Dispatched
      // by the fabric stream path (stream.js) on process close.
      if (typeof msg.group !== 'string' || typeof msg.name !== 'string') return [model, []];
      const fab = model.fabric || {};
      const output = fab.output || {};
      const g = { ...(output[msg.group] || {}), [msg.name]: Array.isArray(msg.lines) ? msg.lines : [] };
      return [{ ...model, fabric: { ...fab, output: { ...output, [msg.group]: g } } }, []];
    }
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
    case 'wire_create': {
      // { from, to } — a RUNTIME wire (the pane's "connect to…"). Transient-in-
      // model, WAL-replayable; the host merges it OVER config wires. One wire per
      // input `to` (an input resolves a single wire), so a new wire to the same
      // `to` REPLACES the prior runtime one — last-write-wins, like injects.
      // Shape-guarded here; type-equality is validated at the handler (where the
      // port types are in scope) so this stays a pure, dependency-light reducer.
      if (typeof msg.from !== 'string' || !msg.from) return [model, []];
      if (typeof msg.to !== 'string' || !msg.to) return [model, []];
      const wires = (model.fabric && model.fabric.wires) || [];
      const kept = wires.filter((w) => w && w.to !== msg.to);
      return [_withWires(model, [...kept, { from: msg.from, to: msg.to }]), []];
    }
    case 'wire_delete': {
      // { from, to } — remove a RUNTIME wire by exact endpoints; identity-preserve
      // when absent (a config-authored wire isn't in this store, so deleting one
      // is a no-op — config wires are user-authored on disk, not runtime-editable).
      if (typeof msg.from !== 'string' || typeof msg.to !== 'string') return [model, []];
      const wires = (model.fabric && model.fabric.wires) || [];
      const kept = wires.filter((w) => !(w && w.from === msg.from && w.to === msg.to));
      if (kept.length === wires.length) return [model, []];
      return [_withWires(model, kept), []];
    }
    default:
      return [model, []];
  }
}

module.exports = { TYPES, update };
