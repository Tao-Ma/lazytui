/**
 * createSelector — the project's memoized-derived-data model.
 *
 * A reselect-style single-slot memo. `inputsOf(...args)` extracts the
 * dependency values the computation reads (state refs and/or primitives);
 * `compute(...inputs)` runs ONLY when one of those dependencies changes by
 * `===`. Same inputs → same output reference (so downstream `===` checks and
 * render diffing stay cheap).
 *
 * Why reference-equality is a valid cache key here: reducers update slices
 * IMMUTABLY (spread per write; pinned by test-immutable-leaves), so an
 * unchanged ref means unchanged content. A dependency that mutates in place
 * would defeat the memo — list every such value in `inputsOf` as the value
 * it ACTUALLY reads, not a container of it.
 *
 * CONTRACT (the one rule): `inputsOf` must return EVERY value `compute`
 * reads. Miss one and the selector returns stale output when only the missed
 * dependency changed. Keep `compute` a pure function of its inputs — no
 * module-global reads, no IO, no mutation.
 *
 * This generalizes the ad-hoc memos already in the tree (search.matchesFor's
 * `_matchMemo`, api.js's `_layoutMemo`) into one shared primitive. New
 * derived-data sites should use this rather than hand-rolling a memo.
 *
 * Single-slot is deliberate: these selectors are called many times against
 * the SAME state within a frame (per-pane hit-test loops, per-row render),
 * then the state advances. A 1-entry cache fits that access pattern and
 * never grows. If a future caller genuinely interleaves N distinct states,
 * it recomputes on each switch (correct, just not cached) — revisit then.
 */
'use strict';

function createSelector(inputsOf, compute) {
  let lastInputs = null;
  let lastResult;
  return function selector(...args) {
    const inputs = inputsOf(...args);
    if (lastInputs
        && inputs.length === lastInputs.length
        && inputs.every((v, i) => v === lastInputs[i])) {
      return lastResult;
    }
    lastInputs = inputs;
    lastResult = compute(...inputs);
    return lastResult;
  };
}

module.exports = { createSelector };
