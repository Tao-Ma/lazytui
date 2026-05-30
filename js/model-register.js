/**
 * Pure yank-register transforms — the reducer-owned half of register.js.
 *
 * Dependency-free leaf (model-groups precedent) so runtime.update can mutate
 * the register slice without importing register.js (which requires runtime →
 * cycle). Every function takes `model` and mutates model.register.history;
 * none touch the terminal. The OSC52 emit is the only effect — these return
 * the value to emit (or null) so the caller raises an emit_osc52 Cmd.
 *
 * register.js keeps thin wrappers over these for the test-facing API + the
 * OSC52 effect (same bridge shape as state.js's group-tree wrappers over
 * model-groups).
 */
'use strict';

/** Prepend `text` (dedup-on-top, capped). Returns the text to OSC52-emit, or
 *  null for a no-op. A dup-of-top still returns the text (re-emit, no prepend). */
function push(model, text) {
  const r = model.register;
  if (!r || typeof text !== 'string' || !text) return null;
  const h = r.history;
  if (h[0] === text) return text;        // dedup: skip prepend, still re-emit
  h.unshift(text);
  if (h.length > r.cap) h.length = r.cap;
  return text;
}

/** Move history[idx] to the top. Returns the promoted value (to emit) or null. */
function promote(model, idx) {
  const h = model.register && model.register.history;
  if (!h || !Number.isInteger(idx) || idx <= 0 || idx >= h.length) return null;
  const [v] = h.splice(idx, 1);
  h.unshift(v);
  return v;
}

/** Drop history[idx]. Returns true if removed. */
function drop(model, idx) {
  const h = model.register && model.register.history;
  if (!h || !Number.isInteger(idx) || idx < 0 || idx >= h.length) return false;
  h.splice(idx, 1);
  return true;
}

function clear(model) {
  if (model.register) model.register.history.length = 0;
}

module.exports = { push, promote, drop, clear };
