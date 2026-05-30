/**
 * Pure yank-register transforms — the reducer-owned half of register.js.
 *
 * Dependency-free leaf (same shape as leaves/search / leaves/menu) so
 * runtime.update can update the register slice without importing
 * register.js (which requires runtime → cycle).
 *
 * **Pure-TEA shape:** every function takes the `register` SUB-SLICE
 * ({ history, cap }) and returns either a new `register` or a tuple
 * `[newRegister, value]`. The `value` is the string to OSC52-emit (or
 * `null` for none); for `drop` it's the `removed` boolean. The caller
 * folds the new register back into the model.
 *
 * register.js keeps thin wrappers over these for the test-facing API +
 * the OSC52 effect (a leaf + a thin bridge module — same pattern as
 * leaves/search / viewer-search.js).
 */
'use strict';

/** Prepend `text` (dedup-on-top, capped). Returns `[newRegister, value]`
 *  where `value` is the text to OSC52-emit (or null for a no-op input).
 *  A dup-of-top is a no-op on history but still returns the text for
 *  re-emit (pressing y on the same selection re-mirrors to clipboard). */
function push(register, text) {
  if (!register || typeof text !== 'string' || !text) return [register, null];
  const h = register.history;
  if (h[0] === text) return [register, text];   // dedup: re-emit, no prepend
  const next = [text, ...h];
  if (next.length > register.cap) next.length = register.cap;
  return [{ ...register, history: next }, text];
}

/** Move history[idx] to the top. Returns `[newRegister, value]`; value
 *  is null for an out-of-range or already-at-top idx. */
function promote(register, idx) {
  const h = register && register.history;
  if (!h || !Number.isInteger(idx) || idx <= 0 || idx >= h.length) return [register, null];
  const v = h[idx];
  const next = [v, ...h.slice(0, idx), ...h.slice(idx + 1)];
  return [{ ...register, history: next }, v];
}

/** Drop history[idx]. Returns `[newRegister, removed]` where `removed`
 *  is true iff the index was in range and the entry was deleted. */
function drop(register, idx) {
  const h = register && register.history;
  if (!h || !Number.isInteger(idx) || idx < 0 || idx >= h.length) return [register, false];
  const next = [...h.slice(0, idx), ...h.slice(idx + 1)];
  return [{ ...register, history: next }, true];
}

/** Empty the history. Returns the new register (or same ref if already
 *  empty — caller can use identity to skip writes). */
function clear(register) {
  if (!register || register.history.length === 0) return register;
  return { ...register, history: [] };
}

module.exports = { push, promote, drop, clear };
