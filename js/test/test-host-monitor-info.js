/**
 * host-monitor demo — integration over the REAL demo/host-monitor/tui.yml after
 * the compact-pane reshape (docs/compact-panes.md). Guards, against the actual
 * parsed + placed layout:
 *   1. The dashboard is COMPOSITE boxes (CPU/Memory/Network) — the density win —
 *      each carrying its widget list; the placed-pane count stays btop-low (8) and
 *      every column stays at/under the soft cap of 3.
 *   2. The process TABLE resolves host.proc via the pane-instance routing (sliceForPane
 *      arm 1 by paneId) and the enriched host.proc schema reaches the detail card.
 *   3. The select_from drill-down (procsel → proctrend) resolves its intended pane
 *      (B-F3) — which also guards NON-PRIMARY resolution (proctrend's own mode:multi
 *      slice, not a collapse onto another stats pane).
 *   4. No metrics pane sits in a multi-tab slot (the middle-column click bug).
 *
 * (The detail-card PROJECTION itself is unit-tested in test-metrics-row-info; the
 * composite split/subscriptions in test-composite. This is the demo-shape guard.)
 *
 * Run: node js/test/test-host-monitor-info.js
 */
'use strict';

const path = require('path');
const { describe, it, eq, assert, report } = require('./test-runner');   // auto-registers layout/detail/groups
const api = require('../panel/api');
const route = require('../panel/route');

// The reshaped demo places actions / stats / table / composite panes.
for (const p of ['navigator/actions', 'navigator/groups', 'monitor/stats', 'monitor/table', 'monitor/gauge', 'monitor/composite']) {
  const c = require('../panel/' + p);
  if (!api.getComponent(c.name)) { try { api.registerComponent(c); } catch (_) { /* order-guarded */ } }
}

const { parse } = require('../parser/index');
const { getModel } = require('../app/runtime');
const { initState } = require('../app/state');

const DEMO = path.join(__dirname, '..', '..', 'demo', 'host-monitor', 'tui.yml');
const cfg = parse(DEMO);
getModel().config = cfg;
getModel().projectDir = cfg.project_dir;
initState();

// Inject one sample for the process topic (the producers are async; the card reads
// the mirror the same way render does — frame = f(model)). procs (table) + proctrend
// (mode:multi) + procsel (drill) are three host.proc panes — the non-primary pane
// resolution is guarded via proctrend below.
getModel().metrics = {
  'host.proc': {
    schema: cfg.metrics['host.proc'].schema,
    series: { '404185': [{ cpu: 2.3, mem: 4.0, state: 'Sl+', threads: 10, rss: 800296960, ppid: 185, user: 'root', comm: 'claude', command: 'claude --resume' }] },
  },
};

function placedPanes() {
  const layout = api.getInstanceSlice('layout');
  const out = [];
  for (const col of (layout.arrange.columns || [])) for (const pn of (col.panels || [])) if (pn && pn.paneId) out.push(pn);
  return out;
}

// Resolve real placed pane ids by type from the arrange (mirror pane-select.js).
function panesOfType(type) {
  return placedPanes().filter(pn => pn.type === type).map(pn => pn.paneId);
}

describe('[host-monitor] composite dashboard + density', () => {
  const panes = placedPanes();

  it('the CPU / Memory / Network dashboards are composite boxes with widgets', () => {
    const composites = panes.filter(p => p.type === 'composite');
    eq(composites.length, 3, `three composite boxes, got ${composites.map(p => p.paneId).join(',')}`);
    for (const c of composites) {
      assert(Array.isArray(c.widgets) && c.widgets.length >= 2, `${c.paneId} carries ≥2 widgets`);
    }
  });

  it('the composites fold the dashboard topics into widgets (graph / bars / meter)', () => {
    const topics = new Set();
    for (const c of panes.filter(p => p.type === 'composite')) for (const w of (c.widgets || [])) {
      topics.add(w.topic);
      assert(['graph', 'bars', 'meter'].includes(w.type), `widget type is graph|bars|meter, got ${JSON.stringify(w.type)}`);
    }
    for (const t of ['host.cpu', 'host.core', 'host.mem', 'host.disk', 'host.net']) {
      assert(topics.has(t), `a composite widget covers ${t}`);
    }
  });

  it('the dashboard showcases the Tier-2 + stats-interactivity widgets', () => {
    const widgets = panes.filter(p => p.type === 'composite').flatMap(c => c.widgets || []);
    // (net_box uses stacked, independently-scaled rx/tx sections — btop's shape —
    // rather than a shared-scale `overlay`, so no overlay widget is asserted here;
    // the overlay feature itself is covered by test-render-body / test-stats.)
    assert(widgets.some(w => w.type === 'meter'), 'a meter widget (fullest disk)');
    assert(widgets.some(w => w.type === 'bars' && w.interactive === true), 'an interactive bars widget (disk cursor)');
    // The CPU-trend overview is a SELECTABLE `mode: multi` pane (re-added by the stats-
    // interactivity follow-on — it now owns a row cursor + is a select_from source,
    // unlike the v0.6.18 display-only wall that was removed for looking selectable but
    // not being it). It DRIVES the multi-metric drill-down: procsel (select_from:
    // proctrend) graphs cpu/mem/rss history for whichever row the overview has selected.
    assert(panes.some(p => p.type === 'stats' && p.mode === 'multi'), 'a selectable mode:multi overview (proctrend)');
    const drill = panes.find(p => p.type === 'stats' && p.select_from
      && Array.isArray(p.metrics) && p.metrics.length >= 2);
    assert(drill, 'a multi-metric select_from drill-down (procsel: cpu/mem/rss)');
  });

  it('density: the reshape holds the placed-pane count btop-low (12 → 8; every column at/under the soft cap of 3)', () => {
    assert(panes.length <= 8, `expected ≤8 placed panes, got ${panes.length}: ${panes.map(p => p.paneId).join(',')}`);
    const cols = api.getInstanceSlice('layout').arrange.columns || [];
    for (let i = 0; i < cols.length; i++) {
      assert((cols[i].panels || []).length <= 3, `col ${i} exceeds the soft cap of 3 (would warn)`);
    }
  });

  it('no metrics pane sits in a multi-tab slot (no phantom tab strip / misrouted click)', () => {
    const bad = panes.filter(pn => ['table', 'gauge', 'stats', 'composite'].includes(pn.type)
      && Array.isArray(pn.tabs) && pn.tabs.length > 1);
    eq(bad.map(p => p.paneId), [], 'metrics panels must each own a single-tab slot');
  });
});

describe('[host-monitor] detail card + per-pane topic resolution', () => {
  const tables = panesOfType('table');   // pane-procs (the one detailed table)

  it('the process table resolves host.proc', () => {
    const procs = tables.find(id => api.getInstanceSlice(id).topic === 'host.proc');
    assert(procs, `a table pane on host.proc, got ${tables.map(id => api.getInstanceSlice(id).topic).join(',')}`);
  });

  it('the process table card shows OFF-TABLE columns, formatted by type', () => {
    const procs = tables.find(id => api.getInstanceSlice(id).topic === 'host.proc');
    const lines = api.getPanelDef(procs).getInfo('404185', procs);
    eq(lines[0], '[bold]pid 404185[/]', 'header = row identity');
    const body = lines.slice(2).join('\n');
    assert(/\[dim\]state +\[\/]  Sl\+/.test(body), 'state (off-table string)');
    assert(/\[dim\]threads *\[\/]  10/.test(body), 'threads (off-table number)');   // widest label → zero pad
    assert(/\[dim\]rss +\[\/]  763\.2M/.test(body), 'rss (off-table bytes, KiB→bytes→compact)');
    assert(/\[dim\]ppid +\[\/]  185/.test(body), 'parent pid');
    assert(/\[dim\]command\[\/]  claude --resume/.test(body), 'full command line (tab-delimited field)');
  });
});

describe('[host-monitor] select_from drill-down resolves its intended pane (B-F3)', () => {
  it('procsel (select_from: proctrend) reads the PROCESS rows via the resolved pane', () => {
    const procsel = placedPanes().find(pn => pn.type === 'stats' && pn.select_from);
    eq(procsel.select_from, 'proctrend');
    // proctrend is a mode:multi host.proc pane → its getItems is the process rows (pids).
    // This ALSO guards NON-PRIMARY resolution: proctrend must resolve its OWN slice, not
    // collapse onto another stats pane (procsel/procsel are NOT mode:multi → getItems []),
    // so a non-empty list here proves the paneId-keyed resolution held.
    const items = api.getItems(route.resolveSourcePaneId(procsel.select_from));
    assert(items.includes('404185'), `procsel resolves host.proc rows via proctrend (got ${JSON.stringify(items)})`);
  });
});

report();
