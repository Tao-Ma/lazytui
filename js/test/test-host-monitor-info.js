/**
 * host-monitor demo — process/row DETAIL CARD integration. Parses the REAL
 * demo/host-monitor/tui.yml and drives the shipped `table`/`gauge` panels'
 * getInfo through the actual pane-instance routing (the parser mints `pane-*`
 * ids + the per-pane instance map), then injects a metric sample and asserts the
 * selected row projects into a full detail card.
 *
 * Guards two things point-tests can't:
 *   1. Per-pane resolution — the demo has TWO table panes (procs + net); each
 *      getInfo must resolve ITS OWN topic (sliceForPane arm 1 by paneId), not
 *      collapse onto the kind primary.
 *   2. The demo config itself — the enriched host.proc schema (state / threads /
 *      rss / ppid / user / command) reaches the card, incl. off-table columns.
 *
 * Run: node js/test/test-host-monitor-info.js
 */
'use strict';

const path = require('path');
const { describe, it, eq, assert, report } = require('./test-runner');   // auto-registers layout/detail/groups
const api = require('../panel/api');

// The host-monitor demo places actions / stats / table / gauge panes.
for (const p of ['navigator/actions', 'navigator/groups', 'monitor/stats', 'monitor/table', 'monitor/gauge']) {
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

// Inject one sample per topic (the producers are async; the card reads the
// mirror the same way render does — frame = f(model)).
getModel().metrics = {
  'host.proc': {
    schema: cfg.metrics['host.proc'].schema,
    series: { '404185': [{ cpu: 2.3, mem: 4.0, state: 'Sl+', threads: 10, rss: 800296960, ppid: 185, user: 'root', comm: 'claude', command: 'claude --resume' }] },
  },
  'host.net': {
    schema: cfg.metrics['host.net'].schema,
    series: { eth0: [{ rx: 2048, tx: 512 }] },
  },
};

// Resolve real placed pane ids by type from the arrange (mirror pane-select.js).
function panesOfType(type) {
  const layout = api.getInstanceSlice('layout');
  const out = [];
  for (const col of (layout.arrange.columns || [])) {
    for (const pn of (col.panels || [])) {
      if (pn && pn.type === type && pn.paneId) out.push(pn.paneId);
      for (const t of ((pn && pn.tabs) || [])) if (t && t.type === type && t.paneId) out.push(t.paneId);
    }
  }
  return out;
}

describe('[host-monitor] process detail card via the real pane routing', () => {
  const tables = panesOfType('table');   // pane-procs, pane-net
  const gauges = panesOfType('gauge');   // pane-cpubars

  it('parses two table panes (procs, net) + a gauge (cpubars)', () => {
    assert(tables.length >= 2, `expected ≥2 table panes, got ${tables.join(',')}`);
    assert(gauges.length >= 1, `expected a gauge pane, got ${gauges.join(',')}`);
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

  it('each pane resolves ITS OWN topic — no kind-primary collapse', () => {
    const procs = tables.find(id => api.getInstanceSlice(id).topic === 'host.proc');
    const net = tables.find(id => api.getInstanceSlice(id).topic === 'host.net');
    assert(procs && net && procs !== net, 'two distinct table panes on distinct topics');
    eq(api.getPanelDef(net).getInfo('eth0', net)[0], '[bold]iface eth0[/]', 'net card keyed by iface (not collapsed to procs/pid)');
  });

  it('the CPU-bars gauge shares the same card projection (same topic as the table)', () => {
    const g = gauges.find(id => api.getInstanceSlice(id).topic === 'host.proc');   // not the disk gauge
    eq(api.getPanelDef(g).getInfo('404185', g)[0], '[bold]pid 404185[/]');
  });
});

// The storage & network panels each get their OWN column slot (placed directly).
// A multi-tab slot only renders its strip for content panes, so a metrics panel
// in a multi-tab group would show invisible tabs AND misroute title clicks onto
// phantom tab hit-zones — the middle-column click bug. Guard the layout against
// reintroducing that, and pin that the disk/net panels wire to their topics.
describe('[host-monitor] storage & network panels are placed directly (click-safe)', () => {
  function placedPanes() {
    const layout = api.getInstanceSlice('layout');
    const out = [];
    for (const col of (layout.arrange.columns || [])) for (const pn of (col.panels || [])) if (pn && pn.paneId) out.push(pn);
    return out;
  }

  it('no metrics pane sits in a multi-tab slot (no phantom tab strip / misrouted click)', () => {
    const bad = placedPanes().filter(pn => ['table', 'gauge', 'stats'].includes(pn.type) && Array.isArray(pn.tabs) && pn.tabs.length > 1);
    eq(bad.map(p => p.paneId), [], 'metrics panels must each own a single-tab slot');
  });

  it('disk gauge, disk-I/O table, and network graph are placed and wired to their topics', () => {
    // Read the topic off the PLACED PANE (`pn.topic`, hoisted by the arrange):
    // table/gauge also store it in their slice, but a stats pane keeps an empty
    // slice and reads its topic from the pane def at render.
    const panes = placedPanes();
    const typeOnTopic = (topic) => panes.filter(pn => pn.topic === topic).map(pn => pn.type);
    assert(typeOnTopic('host.disk').includes('gauge'), 'disk usage → gauge');
    assert(typeOnTopic('host.diskio').includes('table'), 'disk I/O → table');
    assert(typeOnTopic('host.net').includes('stats'), 'network trend graph (stats on host.net) is placed');
    assert(typeOnTopic('host.net').includes('table'), 'network throughput table is placed');
  });
});

report();
