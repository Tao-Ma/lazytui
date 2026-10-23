/**
 * Fabric state sub-reducer — the single writer of `model.fabric.*` (injects,
 * output, wires). Delegated by the root reducer via { TYPES, update }, the same
 * mechanism as the modal sub-reducers (#D12), though this is fabric state, not a
 * modal. See docs/ports-and-wires.md (decision 1 + "P1.5 — as shipped").
 *
 * TYPES: port_inject / port_clear · fabric_output_set · wire_create / wire_delete.
 * All of `model.fabric.*` is transient (never serialised to config) but IN-MODEL,
 * so it rides the WAL and replay reproduces it (same discipline as
 * model.modal.continuation):
 *   - injects — by-value pushes, keyed by the `component.port` address. STICKY:
 *     persist until overwritten by a newer inject to the same port (last-write-
 *     wins) or explicitly cleared — NOT auto-consumed on run. Resolve-time
 *     precedence is inject > wire > default (resolve.js, via the action-runner
 *     run hook); the pane's source badge (P1.5) makes a shadowing inject visible.
 *   - output — a producer's captured RAW stdout, keyed by [group][component];
 *     the parse source for output ports, replaced per run (fabric_output_set).
 *   - wires — RUNTIME wires (the pane's "connect to…" / wire-list edits), merged
 *     OVER config wires by the host; one wire per input `to` (last-write-wins).
 *
 * Pure: returns [nextModel, []]; identity-preserved on every no-op. `at` is
 * stamped from model.now (the frame clock) — replay-safe, never Date.now().
 */
'use strict';

const TYPES = ['port_inject', 'port_clear', 'port_consume_oneshot', 'fabric_output_set', 'wire_create', 'wire_delete'];

// Runtime injects and wires are GROUP-SCOPED — keyed by the current group, mirroring
// model.fabric.output[group][name]. A `component.port` name may be reused across groups
// (e.g. a `stats` component in two groups), so a GLOBAL store let an inject/wire made in one
// group silently bleed into an identically-named component in another (B3: prod resolving a
// staging inject value). The group is the reducer's model input (model.currentGroup) — pure,
// and reconstructed on replay before each fabric Msg (group switches ride the WAL too).
// Own-property / type guards: a group named like an Object.prototype member (`constructor`,
// `toString`, `__proto__`, …) — group names are unvalidated YAML keys — must NOT pick up the
// inherited member. Without this, `_wiresOf` returned a function and `.filter`/`.find` threw
// on the resolve/render path (and `_injectsOf` returned a function / Object.prototype).
function _injectsOf(model, group) {
  const all = (model.fabric && model.fabric.injects) || {};
  const g = Object.prototype.hasOwnProperty.call(all, group) ? all[group] : null;
  return (g && typeof g === 'object') ? g : {};
}
function _wiresOf(model, group) {
  const all = (model.fabric && model.fabric.wires) || {};
  const g = all[group];
  return Array.isArray(g) ? g : [];   // Array.isArray rejects every inherited member
}
function _withGroupInjects(model, group, groupInjects) {
  const fab = model.fabric || {};
  return { ...model, fabric: { ...fab, injects: { ...(fab.injects || {}), [group]: groupInjects } } };
}
function _withGroupWires(model, group, groupWires) {
  const fab = model.fabric || {};
  return { ...model, fabric: { ...fab, wires: { ...(fab.wires || {}), [group]: groupWires } } };
}

/**
 * Write a by-value inject for `port` in the current group, `at`-stamped from model.now
 * (replay-safe). The canonical inject write — shared by the `port_inject` arm
 * and the component-ports field editor's submit (modal/fabric-field.js) so both
 * paths land identical state. Last-write-wins on the same port.
 *
 * `opts.oneShot: true` marks the inject as consumed by the next run that resolves it —
 * the invoke-time popup path (fabric-field opened with a `pendingAction` from the
 * action-runner, docs/ports-and-wires.md P2) uses this so popup-collected values
 * don't persist like a ports-pane manual edit does. Default is sticky (opts absent).
 */
function applyInject(model, port, value, opts) {
  const group = model.currentGroup;
  const groupInjects = _injectsOf(model, group);
  const rec = { value, at: model.now };
  if (opts && opts.oneShot) rec.oneShot = true;
  return _withGroupInjects(model, group, { ...groupInjects, [port]: rec });
}

function update(model, msg) {
  const group = model.currentGroup;
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
      // { port: "xlogminer.start_lsn", value, oneShot? } — last-write-wins.
      // `oneShot: true` is the invoke-time-popup path (P2 — the fabric-field
      // modal opened with a pendingAction); the next port_consume_oneshot
      // referencing this port removes it. Default is sticky.
      if (typeof msg.port !== 'string' || !msg.port) return [model, []];
      return [applyInject(model, msg.port, msg.value, msg.oneShot ? { oneShot: true } : null), []];
    }
    case 'port_consume_oneshot': {
      // { ports: [addr, ...] } — remove each inject in the current group that
      // is BOTH oneShot AND listed. Sticky injects and non-listed oneShots stay.
      // Called by action-runner after a successful resolve/run, so a popup-
      // collected value lives for exactly one invocation. Identity-preserving
      // when nothing matches (no churn / render on a no-op consume).
      if (!Array.isArray(msg.ports) || msg.ports.length === 0) return [model, []];
      const groupInjects = _injectsOf(model, group);
      let changed = false;
      const next = { ...groupInjects };
      for (const addr of msg.ports) {
        const rec = groupInjects[addr];
        if (rec && rec.oneShot) { delete next[addr]; changed = true; }
      }
      if (!changed) return [model, []];
      return [_withGroupInjects(model, group, next), []];
    }
    case 'port_clear': {
      // { port } — remove one from the current group; identity-preserve when absent (no-op).
      const groupInjects = _injectsOf(model, group);
      if (typeof msg.port !== 'string' || !(msg.port in groupInjects)) return [model, []];
      const next = { ...groupInjects };
      delete next[msg.port];
      return [_withGroupInjects(model, group, next), []];
    }
    case 'wire_create': {
      // { from, to } — a RUNTIME wire (the pane's "connect to…") in the current group.
      // Transient-in-model, WAL-replayable; the host merges it OVER config wires. One wire per
      // input `to` (an input resolves a single wire), so a new wire to the same
      // `to` REPLACES the prior runtime one — last-write-wins, like injects.
      // Shape-guarded here; type-equality is validated at the handler (where the
      // port types are in scope) so this stays a pure, dependency-light reducer.
      if (typeof msg.from !== 'string' || !msg.from) return [model, []];
      if (typeof msg.to !== 'string' || !msg.to) return [model, []];
      const wires = _wiresOf(model, group);
      // Identity-preserve when re-creating the exact edge that's already the sole
      // wire for this input (no churn/re-render on a no-op re-wire).
      const forTo = wires.filter((w) => w && w.to === msg.to);
      if (forTo.length === 1 && forTo[0].from === msg.from) return [model, []];
      const kept = wires.filter((w) => w && w.to !== msg.to);
      return [_withGroupWires(model, group, [...kept, { from: msg.from, to: msg.to }]), []];
    }
    case 'wire_delete': {
      // { from, to } — remove a RUNTIME wire by exact endpoints from the current group;
      // identity-preserve when absent (a config-authored wire isn't in this store, so
      // deleting one is a no-op — config wires are user-authored on disk, not runtime-editable).
      if (typeof msg.from !== 'string' || typeof msg.to !== 'string') return [model, []];
      const wires = _wiresOf(model, group);
      const kept = wires.filter((w) => !(w && w.from === msg.from && w.to === msg.to));
      if (kept.length === wires.length) return [model, []];
      return [_withGroupWires(model, group, kept), []];
    }
    default:
      return [model, []];
  }
}

module.exports = { TYPES, update, applyInject };
