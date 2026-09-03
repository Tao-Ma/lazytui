/**
 * Layering gate — the cross-layer dependency graph must stay ACYCLIC.
 *
 * The directory layers (app / dispatch / panel / leaves / io / render / overlay /
 * feature / parser / model / fabric / hosts / agent) form a DAG: a lower layer
 * never imports up into a higher one. That was held by CONVENTION — js/scripts/
 * dep-walker.js could report a cycle, but nothing failed on one. This test wires
 * the walker's analysis into the suite so a regression (a new upward require)
 * breaks the build instead of silently re-forming a cycle.
 *
 * TWO invariants:
 *   - top-level edges acyclic  — the load-order property (a top-level `require`
 *     up into a not-yet-loaded higher layer is a real init-order hazard).
 *   - all edges (incl. deferred/lazy) acyclic — the stricter architectural
 *     property. A deferred upward require doesn't break load order, but it's still
 *     a layer inversion; this pins the dispatch→app back-edge (Phase 5 C9) closed.
 *
 * Run: node js/test/test-dep-layering.js
 */
'use strict';

const { describe, it, assert, report } = require('./test-runner');
const { analyze } = require('../scripts/dep-walker');

const { topSCCs, allSCCs } = analyze();

describe('[dep-layering] the cross-layer graph is a DAG', () => {
  it('has NO top-level layer cycle (load-order acyclicity)', () => {
    assert(topSCCs.length === 0,
      `top-level layer cycle(s) — a top-level require inverts the layering: ${JSON.stringify(topSCCs)}`);
  });

  it('has NO layer cycle even counting deferred (lazy) requires', () => {
    assert(allSCCs.length === 0,
      `layer cycle(s) incl. deferred requires — a lazy upward import still inverts a layer: ${JSON.stringify(allSCCs)}. ` +
      `Break it with an injected seam (setFabricHost / setExternalRegistrar style) or relocate the module down a layer.`);
  });
});

report();
