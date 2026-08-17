/**
 * host-monitor demo — integration over the REAL demo/host-monitor/tui.yml after
 * the compact-pane reshape (docs/compact-panes.md). Guards, against the actual
 * parsed + placed layout:
 *   1. The dashboard is COMPOSITE boxes (CPU/Memory/Network) — the density win —
 *      each carrying its widget list; the placed-pane count stays btop-low.
 *   2. The two kept TABLES (procs = host.proc, diskio = host.diskio) each resolve
 *      ITS OWN topic via the pane-instance routing (sliceForPane arm 1 by paneId),
 *      not the kind primary — and the enriched host.proc schema reaches the card.
 *   3. select_from drill-downs (procsel → procs) resolve their intended table
 *      (B-F3), and a NON-primary table (diskio) resolves to its own rows.
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

// Inject one sample per asserted topic (the producers are async; the card reads
// the mirror the same way render does — frame = f(model)). procs + diskio are the
// two selectable tables; distinct row keys make a kind-primary COLLAPSE detectable.
getModel().metrics = {
  'host.proc': {
    schema: cfg.metrics['host.proc'].schema,
    series: { '404185': [{ cpu: 2.3, mem: 4.0, state: 'Sl+', threads: 10, rss: 800296960, ppid: 185, user: 'root', comm: 'claude', command: 'claude --resume' }] },
  },
  'host.diskio': {
    schema: cfg.metrics['host.diskio'].schema,
    series: { vda: [{ read: 4096, write: 8192 }] },
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

  it('the composites fold the dashboard topics into widgets (graph + bars)', () => {
    const topics = new Set();
    for (const c of panes.filter(p => p.type === 'composite')) for (const w of (c.widgets || [])) topics.add(w.topic);
    for (const t of ['host.cpu', 'host.core', 'host.mem', 'host.disk', 'host.nettotal', 'host.net']) {
      assert(topics.has(t), `a composite widget covers ${t}`);
    }
  });

  it('density: the reshape holds the placed-pane count btop-low (was 12)', () => {
    assert(panes.length <= 8, `expected ≤8 placed panes, got ${panes.length}: ${panes.map(p => p.paneId).join(',')}`);
  });

  it('no metrics pane sits in a multi-tab slot (no phantom tab strip / misrouted click)', () => {
    const bad = panes.filter(pn => ['table', 'gauge', 'stats', 'composite'].includes(pn.type)
      && Array.isArray(pn.tabs) && pn.tabs.length > 1);
    eq(bad.map(p => p.paneId), [], 'metrics panels must each own a single-tab slot');
  });
});

describe('[host-monitor] detail card + per-pane topic resolution (two tables)', () => {
  const tables = panesOfType('table');   // pane-procs, pane-diskio

  it('two table panes on distinct topics (procs = host.proc, diskio = host.diskio)', () => {
    assert(tables.length >= 2, `expected ≥2 table panes, got ${tables.join(',')}`);
    const topics = tables.map(id => api.getInstanceSlice(id).topic).sort();
    assert(topics.includes('host.proc') && topics.includes('host.diskio'),
      `tables on host.proc + host.diskio, got ${topics.join(',')}`);
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

  it('each table resolves ITS OWN topic — no kind-primary collapse', () => {
    const procs = tables.find(id => api.getInstanceSlice(id).topic === 'host.proc');
    const diskio = tables.find(id => api.getInstanceSlice(id).topic === 'host.diskio');
    assert(procs && diskio && procs !== diskio, 'two distinct table panes on distinct topics');
    eq(api.getPanelDef(diskio).getInfo('vda', diskio)[0], '[bold]dev vda[/]', 'diskio card keyed by dev (not collapsed to procs/pid)');
  });
});

describe('[host-monitor] select_from drill-downs resolve their intended table', () => {
  it('a NON-primary table (diskio) resolves to its OWN rows, independent of mint order (B-F3)', () => {
    const bareDiskio = api.getItems('diskio');
    assert(bareDiskio.includes('404185') && !bareDiskio.includes('vda'),
      '(documents) a BARE pool-id collapses to the primary table — why the fix lives at the call site');
    const diskio = api.getItems(route.resolveSourcePaneId('diskio'));
    assert(diskio.includes('vda') && !diskio.includes('404185'),
      `resolveSourcePaneId(diskio) reads the DISK rows (got ${JSON.stringify(diskio)}), not the primary`);
    assert(api.getItems(route.resolveSourcePaneId('procs')).includes('404185'),
      'procs still resolves to its own host.proc rows');
  });

  it('procsel (select_from: procs) reads the PROCESS rows via the resolved pane', () => {
    const procsel = placedPanes().find(pn => pn.type === 'stats' && pn.select_from);
    eq(procsel.select_from, 'procs');
    const items = api.getItems(route.resolveSourcePaneId(procsel.select_from));   // exactly what stats._resolveSelection reads
    assert(items.includes('404185'), `procsel resolves host.proc rows (got ${JSON.stringify(items)})`);
    assert(!items.includes('vda'), 'must NOT be the diskio rows');
  });
});

report();
