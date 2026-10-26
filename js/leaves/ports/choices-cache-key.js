/**
 * Shared cache-key derivation for computed-port choices results. Used by
 * both the TUI (model-resident stale-while-refetch cache, Brief 3 of
 * v0.6.41) and the completion helper's on-disk TTL cache (Brief for
 * v0.6.43). Centralized so the two cache schemes can't drift — a
 * CLI/TUI-drift class that already bit this project (v0.6.29 postmortem,
 * also the motivation for [[js/leaves/ports/variadic.js]]).
 *
 * Pure leaf: data-in / data-out, no I/O, no model.
 *
 * The two callers pass different value maps intentionally:
 *   - TUI (fabric-form.js _depValuesForField): only the port's declared
 *     `depends_on:` values. The fetch handler on the TUI side was built
 *     around that scope.
 *   - Completion (completion.js _bindEarlierPositionals): all earlier
 *     positionals typed so far — scope is wider because the user has
 *     already typed every word up to the cursor and binding them all is
 *     strictly more useful than only `depends_on`.
 * The hash function doesn't care. Same key format, different values.
 *
 * Key format: `${actionKey}|${port}|${source}|${depsHash}`
 * `source` is `cmd:<cmd>` or `fn:<ref>` so same-port fetches with
 * different channels never collide.
 */
'use strict';

/**
 * Deterministic hash of a value map. Order-independent (sorted keys) so a
 * decl rewrite that reorders depends_on can't invalidate the cache. Pure
 * JSON stringify so replay reproduces identical hashes byte-for-byte.
 */
function depsHash(values) {
  const keys = Object.keys(values || {}).sort();
  const pairs = keys.map((k) => [k, values[k]]);
  return JSON.stringify(pairs);
}

/**
 * Build a cache key, or null when any required piece is missing (caller
 * must treat null as "uncacheable; skip read AND write").
 */
function cacheKey(actionKey, port, source, values) {
  if (!actionKey || !port || !source) return null;
  return `${actionKey}|${port}|${source}|${depsHash(values)}`;
}

module.exports = { depsHash, cacheKey };
