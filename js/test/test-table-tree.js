/**
 * table panel — process-tree mode (Tier 1b). The generic tree leaf wired into the
 * table via `tree: { parent: ppid }`: tree ordering in getItems, sibling-sort,
 * fold/unfold, flat-during-filter, the `t`/`z` keys, and the rendered glyphs.
 *
 * Run: node js/test/test-table-tree.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const table = require('../panel/monitor/table');
const api = require('../panel/api');
const sm = require('./smoke/_helpers/smoke');

const SCHEMA = { cpu: { type: 'percent' }, comm: { type: 'string' }, ppid: { type: 'number' } };
function setMetric(topic, seriesByRow) {
  getModel().metrics = { ...(getModel().metrics || {}), [topic]: { series: seriesByRow, schema: { columns: SCHEMA } } };
}
// 1(root) → 100 → 300 ; 1 → 200. cpu chosen so a desc sort orders siblings 100>200.
const SERIES = {
  '1':   [{ cpu: 5,  comm: 'init',  ppid: 0 }],
  '100': [{ cpu: 90, comm: 'node',  ppid: 1 }],
  '200': [{ cpu: 10, comm: 'redis', ppid: 1 }],
  '300': [{ cpu: 50, comm: 'psql',  ppid: 100 }],
};
function treeSlice(over) {
  const s = table.init('procs', { paneDef: { topic: 'host.proc', columns: ['cpu', 'comm'], sort: 'cpu', tree: { parent: 'ppid' }, ...over } });
  return s;
}

describe('[table-tree] init — tree config', () => {
  it('seeds tree/{parentKey} + treeMode from `tree: {parent}`; default expanded', () => {
    const s = treeSlice();
    eq(s.tree, { parentKey: 'ppid' });
    eq(s.treeMode, true);
    eq(s.collapsed instanceof Set && s.collapsed.size, 0);
  });
  it('a plain table is unaffected: no tree, treeMode false', () => {
    const s = table.init('p', { paneDef: { topic: 't' } });
    eq(s.tree, null);
    eq(s.treeMode, false);
  });
  it('`tree` without a parent column is ignored', () => {
    eq(table.init('p', { paneDef: { topic: 't', tree: {} } }).tree, null);
    eq(table.init('p', { paneDef: { topic: 't', tree: true } }).tree, null);
  });
});

describe('[table-tree] _treeActive', () => {
  it('true when configured + mode on + no filter', () => { assert(table._treeActive(treeSlice())); });
  it('false when a filter is active (flat during filter — v1)', () => {
    const s = treeSlice(); s.nav.filter = '2';
    assert(!table._treeActive(s));
  });
  it('false when mode off, or not configured', () => {
    const s = treeSlice(); s.treeMode = false;
    assert(!table._treeActive(s));
    assert(!table._treeActive(table.init('p', { paneDef: { topic: 't' } })));
  });
});

describe('[table-tree] getItems — DFS order, sibling-sort, fold, flat-during-filter', () => {
  it('tree mode → DFS order with siblings honouring the sort (cpu desc)', () => {
    setMetric('host.proc', SERIES);
    eq(table.getItems(treeSlice()), ['1', '100', '300', '200'], '1 → (100 → 300) → 200; 100 before 200 by cpu');
  });
  it('folding a node hides its subtree', () => {
    setMetric('host.proc', SERIES);
    const s = treeSlice(); s.collapsed = new Set(['100']);
    eq(table.getItems(s), ['1', '100', '200'], '300 (child of collapsed 100) hidden');
  });
  it('a filter falls back to the FLAT filtered list (no tree)', () => {
    setMetric('host.proc', SERIES);
    const s = treeSlice(); s.nav.filter = '2';
    eq(table.getItems(s), ['200'], 'flat: only the pid matching /2, not tree order');
  });
  it('an orphan (parent not present) is a root', () => {
    setMetric('host.proc', { '1': [{ cpu: 5, ppid: 0 }], '900': [{ cpu: 9, ppid: 999 }] });
    eq(table.getItems(treeSlice()).sort(), ['1', '900']);
  });
});

describe('[table-tree] _handleTreeKey — t toggles mode, z folds the selected node', () => {
  const keyMsg = (over) => ({ type: 'key', focusKind: 'table', items: ['1', '100', '300', '200'], ...over });
  it('t toggles treeMode (claimed + render)', () => {
    const s = treeSlice();
    const [next, cmds] = table._handleTreeKey(keyMsg({ key: 't' }), s);
    eq(next.treeMode, false);
    assert(cmds.some(c => c.type === '_claimed'));
  });
  it('z folds the node under the cursor into collapsed', () => {
    const s = treeSlice(); s.nav.cursor = 1;   // cursor on '100'
    const [next] = table._handleTreeKey(keyMsg({ key: 'z' }), s);
    assert(next.collapsed.has('100'), '100 folded');
    setMetric('host.proc', SERIES);
    eq(table.getItems(next), ['1', '100', '200'], 'its subtree (300) is now hidden');
  });
  it('z again unfolds', () => {
    const s = treeSlice(); s.nav.cursor = 1; s.collapsed = new Set(['100']);
    const [next] = table._handleTreeKey(keyMsg({ key: 'z' }), s);
    assert(!next.collapsed.has('100'), '100 unfolded');
  });
  it('z on a non-tree-capable pane → undefined (falls through to the item-op arm)', () => {
    const s = table.init('p', { paneDef: { topic: 't' } });
    eq(table._handleTreeKey(keyMsg({ key: 'z' }), s), undefined);
    eq(table._handleTreeKey(keyMsg({ key: 't' }), s), undefined);
  });
});

// --- integration: the tree renders with indent glyphs -----------------------
if (!api.getComponent('table')) api.registerComponent(require('../panel/monitor/table'));

describe('[table-tree] render — indent + branch glyphs', () => {
  it('a tree-mode pane paints tree glyphs and the hierarchy', () => {
    const paneCfg = { id: 'procs', type: 'table', title: 'Procs',
      config: { topic: 'host.proc', columns: ['cpu', 'comm'], sort: 'cpu', tree: { parent: 'ppid' } } };
    sm.bootFresh({
      groups: { g: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
      layout: { pool: { procs: paneCfg }, columns: [{ panels: [paneCfg] }] },
    });
    setMetric('host.proc', SERIES);
    const { frame } = sm.capture(() => sm.render());
    assert(/[├└]─/.test(frame), 'branch glyphs painted');
    assert(/▾|▸/.test(frame), 'an expand marker painted on a parent');
    // 300 renders under 100 (its deepest indent) — the pids all appear.
    for (const pid of ['1', '100', '200', '300']) assert(frame.includes(pid), `pid ${pid} present`);
  });
});

report();
