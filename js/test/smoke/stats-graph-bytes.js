/**
 * Smoke — stats graph per-tick WIRE bytes (the 13×-bytes mitigation,
 * docs/truecolor.md). Drives the REAL render + cell-diff pipeline: render a full
 * frame, then shift the series one sample and render WITHOUT a forced full
 * repaint — the captured bytes ARE the incremental cell-diff that goes on the
 * wire that tick.
 *
 * Guards the mitigation against regression:
 *   - `height` (the default) costs a small fraction of `value` per tick, because
 *     row colors are static so cell-diff only re-sends changed glyphs;
 *   - a pane with NO `graph_color:` behaves like `height` (the default);
 *   - `banded` sits between the two.
 *
 * Run: node js/scripts/run-smoke.js stats-graph-bytes   (or directly)
 */
'use strict';

const sm = require('./_helpers/smoke');
const api = sm.api;
const paint = require('../../render/paint');
const { describe, it, assert, report } = require('../test-runner');

for (const [modPath, name] of [
  ['../../panel/navigator/docker', 'containers'],
  ['../../panel/monitor/stats', 'stats'],
  ['../../panel/info/info', 'info'],
  ['../../panel/text-view/text-view', 'text-view'],
]) {
  if (!api.getComponent(name)) api.registerComponent(require(modPath));
}

// graph_color: undefined tests the DEFAULT path (should equal 'height').
function boot(graphColor) {
  const config = { topic: 'smoke.stats', select_from: 'containers', metrics: ['cpu'], window: 78 };
  if (graphColor !== undefined) config.graph_color = graphColor;
  sm.bootFresh({
    groups: { g1: { name: 'g1', label: 'Group 1', containers: ['c1'], actions: {}, children: [], parent: null, depth: 0, quick: false } },
    layout: {
      columns: [
        { width: 40, panels: [{ id: 'containers', type: 'containers' }] },
        { panels: [{ id: 'stats', type: 'stats', title: 'Stats', config }, { id: 'detail', type: 'detail' }] },
      ],
    },
  });
  sm.resize(120, 40);
}

// A moving CPU walk in [~0,95] so every tick shifts the per-column values (the
// worst case for value-mapped color).
const seriesAt = (t, n) => Array.from({ length: n }, (_, i) => ({ cpu: 47.5 + 47 * Math.sin((i + t) / 6) }));

function sync(rowKey, samples) {
  sm.applyMsg({ type: 'metrics_synced', topic: 'smoke.stats',
    series: { [rowKey]: samples }, schema: { columns: { cpu: { type: 'percent' } } } });
}

// Average incremental (per-tick) wire bytes over `ticks` one-sample shifts.
function avgTickBytes(graphColor, ticks = 20) {
  boot(graphColor);
  paint.setColorDepth('truecolor');
  const rowKey = api.getItems('containers')[0];
  const N = 78;
  sync(rowKey, seriesAt(0, N));
  paint.forceFullRepaint();
  sm.capture(() => sm.render());               // establish the baseline frame
  let total = 0;
  for (let t = 1; t <= ticks; t++) {
    sync(rowKey, seriesAt(t, N));
    total += sm.capture(() => sm.render()).raw.length;   // incremental diff only
  }
  return total / ticks;
}

const value  = avgTickBytes('value');
const banded = avgTickBytes('banded');
const height = avgTickBytes('height');
const dflt   = avgTickBytes(undefined);

describe('stats graph per-tick wire bytes — the 13× mitigation', () => {
  it(`height is a small fraction of value (height=${Math.round(height)}B, value=${Math.round(value)}B)`, () => {
    assert(height < value * 0.4, `height ${Math.round(height)}B should be < 40% of value ${Math.round(value)}B`);
  });
  it(`banded sits between height and value (banded=${Math.round(banded)}B)`, () => {
    assert(banded < value * 0.85 && banded > height, `banded ${Math.round(banded)}B between height and value`);
  });
  it(`the default (no graph_color) matches height (default=${Math.round(dflt)}B)`, () => {
    // Same series + pipeline → byte-identical to the explicit 'height'.
    assert(Math.abs(dflt - height) <= Math.max(16, height * 0.05), `default ${Math.round(dflt)}B ≈ height ${Math.round(height)}B`);
  });
});

report();
