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
const route = require('../panel/route');
const sm = require('./smoke/_helpers/smoke');
const treeRegions = require('../panel/tree-regions');
const { hitTestTreeMarker } = require('../panel/chrome-hittest');
const { visibleBoundsFor } = require('../leaves/wm/geometry');
const { dispatchMsg } = require('../dispatch/runtime/loop');
const mpool = require('../leaves/wm/pool');
const sessionLog = require('../io/session-log');   // WAL Set-aware codec (replay round-trip)

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
  it('z during an active filter is a no-op (tree suspended → falls through)', () => {
    const s = treeSlice(); s.nav.cursor = 1; s.nav.filter = '2';
    eq(table._handleTreeKey(keyMsg({ key: 'z' }), s), undefined, 'z not claimed while filtering');
  });
});

describe('[table-tree] update — click twins of t/z (tree_mode_toggle, tree_toggle)', () => {
  it('tree_mode_toggle flips treeMode + emits render (shares _toggleMode with `t`)', () => {
    const [next, cmds] = table.update({ type: 'tree_mode_toggle' }, treeSlice());
    eq(next.treeMode, false);
    assert(cmds.some(c => c.type === 'render'));
  });
  it('tree_toggle{id} folds that node — by id, independent of the cursor', () => {
    setMetric('host.proc', SERIES);
    const [next] = table.update({ type: 'tree_toggle', id: '100' }, treeSlice());
    assert(next.collapsed.has('100'), '100 folded');
    eq(table.getItems(next), ['1', '100', '200'], '300 (child of 100) hidden');
  });
  it('tree_toggle again unfolds', () => {
    const s = treeSlice(); s.collapsed = new Set(['100']);
    const [next] = table.update({ type: 'tree_toggle', id: '100' }, s);
    assert(!next.collapsed.has('100'));
  });
  it('a stray tree Msg on a NON-tree pane is inert (returns the slice unchanged)', () => {
    const flat = table.init('p', { paneDef: { topic: 't' } });
    eq(table.update({ type: 'tree_mode_toggle' }, flat), flat);
    eq(table.update({ type: 'tree_toggle', id: '100' }, flat), flat);
  });
  it('tree_toggle with a null id is inert', () => {
    const s = treeSlice();
    eq(table.update({ type: 'tree_toggle', id: null }, s), s);
  });
});

describe('[table-tree] _treeControl chip — self-suppressing flat↔tree toggle', () => {
  it('suppressed in free-config (null render)', () => {
    eq(table._treeControl.render({ modes: { freeConfigMode: true } }, { paneId: 'procs' }), null);
  });
  it('suppressed on a pane with no live slice (null render)', () => {
    eq(table._treeControl.render({ modes: {} }, { paneId: 'no-such-pane' }), null);
  });
  it('one click region over the whole chip → tree_mode_toggle owner-Msg', () => {
    const regions = table._treeControl.regions(10, 0, 6);
    eq(regions.length, 1);
    eq(regions[0], { x0: 10, x1: 15, y: 0, action: 'toggle' });
    eq(table._treeControl.dispatch('toggle', { paneId: 'procs', type: 'table' }),
       { owner: 'procs', msg: { type: 'tree_mode_toggle', panel: 'table' } });
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

// --- integration: click-to-fold — marker regions + hit-test agreement -------
describe('[table-tree] click a ▾/▸ marker folds that node (paint↔hit-test)', () => {
  const paneCfg = { id: 'procs', type: 'table', title: 'Procs',
    config: { topic: 'host.proc', columns: ['cpu', 'comm'], sort: 'cpu', tree: { parent: 'ppid' } } };
  // The placed pane's id follows the harness convention `pane-<poolkey>`; derive
  // it from the layout so the test doesn't hardcode it (production keys the
  // registry + the hit-test off this same p.paneId, so they never disagree).
  function paneId() {
    const arrange = route.getInstanceSlice('layout').arrange;
    return mpool.allPanesInColumns(arrange).find(p => p.type === 'table').paneId;
  }
  function boot() {
    sm.bootFresh({
      groups: { g: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
      layout: { pool: { procs: paneCfg }, columns: [{ panels: [paneCfg] }] },
    });
    setMetric('host.proc', SERIES);
    sm.capture(() => sm.render());
  }
  const boundsOf = (id) => visibleBoundsFor(route.getInstanceSlice('layout'), id);

  it('render publishes a fold marker for every PARENT row (leaves get none)', () => {
    boot();
    const markers = treeRegions.get(paneId()) || [];
    eq(markers.map(m => m.id).sort(), ['1', '100'], 'parents 1 + 100; leaves 200/300 have no marker');
  });

  it('a click at each published marker cell resolves to THAT node (coord transform)', () => {
    boot();
    const id = paneId();
    const b = boundsOf(id);
    for (const m of treeRegions.get(id)) {
      eq(hitTestTreeMarker(b.x + m.x0, b.y + m.y), { owner: id, id: m.id }, `marker ${m.id}`);
    }
    // The left border column on a marker row is NOT a marker → no phantom hit.
    const m0 = treeRegions.get(id)[0];
    eq(hitTestTreeMarker(b.x, b.y + m0.y), null, 'border cell is inert');
  });

  it('end-to-end: a real press on 100’s marker folds it, a second press unfolds', () => {
    boot();
    const id = paneId();
    const b = boundsOf(id);
    // handleMouse takes 1-based SGR coords (it decrements to 0-based); the raw
    // hit-test above is 0-based. So drive the marker cell as (screen + 1).
    const press = (m) => sm.capture(() => sm.handleMouse('press', b.x + m.x0 + 1, b.y + m.y + 1));
    const sliceNow = () => route.getInstanceSlice(id);
    assert(table.getItems(sliceNow()).includes('300'), '300 (psql) visible before the fold');

    press(treeRegions.get(id).find(m => m.id === '100'));   // real input path → hitTestTreeMarker → tree_toggle
    assert(sliceNow().collapsed.has('100'), '100 folded by the marker click');
    assert(!table.getItems(sliceNow()).includes('300'), '300 (child of 100) now hidden');
    assert(sliceNow().treeMode === true, 'still in tree mode — the marker click didn’t disturb flat/tree');

    press(treeRegions.get(id).find(m => m.id === '100'));   // marker republished (collapsed ▸) → toggles back
    assert(!sliceNow().collapsed.has('100'), '100 unfolded by the second click');
    assert(table.getItems(sliceNow()).includes('300'), '300 restored');
  });

  it('the tree chip is hit-testable on the top border and a click toggles flat↔tree', () => {
    boot();
    const id = paneId();
    const b = boundsOf(id);
    const { hitTestBorderControls } = require('../panel/chrome-hittest');
    // Presence mirrors paint (borderControlsFor + bc.fits gate both): scan the top
    // border row for the cell whose control Msg is our tree toggle.
    let hitX = -1;
    for (let x = b.x; x < b.x + b.w; x++) {
      const h = hitTestBorderControls(x, b.y);
      if (h && h.owner === id && h.msg.type === 'tree_mode_toggle') { hitX = x; break; }
    }
    assert(hitX >= 0, 'the ‹ tree › chip is hit-testable on the top border');
    assert(route.getInstanceSlice(id).treeMode === true, 'starts in tree mode');
    sm.capture(() => sm.handleMouse('press', hitX + 1, b.y + 1));   // 1-based SGR
    assert(route.getInstanceSlice(id).treeMode === false, 'chip click → flat');
    sm.capture(() => sm.handleMouse('press', hitX + 1, b.y + 1));
    assert(route.getInstanceSlice(id).treeMode === true, 'chip click → tree');
  });

  it('a marker click is inert while a non-modal overlay owns the mouse (pane menu open)', () => {
    // Regression: the marker is a BODY-row affordance, resolved at body precedence
    // (after the chain-mode gates) — NOT in the border-chrome cluster. A pane-menu
    // dropdown anchors at b.y+1, so its row 0 sits at b.y+2 == the first data row's
    // marker; if the marker fired there it would fold a hidden node + eat the menu pick.
    boot();
    const id = paneId();
    const b = boundsOf(id);
    const m1 = treeRegions.get(id).find(x => x.id === '1');   // root, on the first data row
    eq(m1.y, 2, 'root marker is on the first data row (where a dropdown row 0 lands)');
    dispatchMsg(route.wrap('layout', { type: 'pane_menu_open', paneId: id, cursor: 0, scroll: 0 }));
    assert(getModel().modes.paneMenuMode === true, 'pane menu is open');
    sm.capture(() => sm.handleMouse('press', b.x + m1.x0 + 1, b.y + m1.y + 1));
    assert(!route.getInstanceSlice(id).collapsed.has('1'), 'the overlay wins — the marker did NOT fold');
    dispatchMsg(route.wrap('layout', { type: 'pane_menu_close' }));
  });

  it('no-phantom: a pane too narrow for a deep marker publishes none for it', () => {
    boot();
    const id = paneId();
    sm.resize(24, 20);            // idW collapses to its floor → deep (indented) markers clip
    sm.capture(() => sm.render());
    const ids = (treeRegions.get(id) || []).map(m => m.id);
    assert(ids.length && !ids.includes('100'), 'root marker survives; the depth-1 marker (100) is clipped → no phantom');
    sm.resize(120, 40);          // restore for any later scenario
  });
});

describe('[table-tree] folding an ancestor below the cursor does not strand the arrows', () => {
  it('after a marker-fold shrinks the list past the cursor, nav still moves (base-clamp)', () => {
    // tree: root 1 → (100 → 300), 200 ; plus a second root 2 → expanded = 5 rows.
    const cfg = { id: 'nav', type: 'table', title: 'N', config: { topic: 'host.nav', columns: ['cpu'], sort: 'cpu', tree: { parent: 'ppid' } } };
    sm.bootFresh({ groups: { g: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } }, layout: { pool: { nav: cfg }, columns: [{ panels: [cfg] }] } });
    setMetric('host.nav', { '1': [{ cpu: 50, ppid: 0 }], '100': [{ cpu: 90, ppid: 1 }], '300': [{ cpu: 40, ppid: 100 }], '200': [{ cpu: 10, ppid: 1 }], '2': [{ cpu: 5, ppid: 0 }] });
    sm.capture(() => sm.render());
    const id = mpool.allPanesInColumns(route.getInstanceSlice('layout').arrange).find(p => p.type === 'table').paneId;
    const b = visibleBoundsFor(route.getInstanceSlice('layout'), id);
    const nav = require('../panel/nav-state');
    const items0 = table.getItems(route.getInstanceSlice(id));
    const last = items0.length - 1;
    // focus + select the last (deep) row by clicking its BODY (far right, not the marker)
    sm.capture(() => sm.handleMouse('press', b.x + b.w - 3, b.y + 2 + last + 1));
    eq(nav.getSel(id), last, 'cursor on the last (deep) row');
    // fold root '1' via its marker → hides its subtree → list shrinks to [1, 2]
    const m1 = treeRegions.get(id).find(m => m.id === '1');
    sm.capture(() => sm.handleMouse('press', b.x + m1.x0 + 1, b.y + m1.y + 1));
    const shrunk = table.getItems(route.getInstanceSlice(id));
    eq(shrunk.length, 2, 'list shrank below the stored cursor');
    assert(nav.getSel(id) >= shrunk.length, 'stored cursor now outruns the list (the class hazard)');
    // arrows must still work (pre-fix: both directions dead-no-op'd off the stale base)
    sm.capture(() => sm.handleKey('k'));   // nav_up
    const up = nav.getSel(id);
    assert(up >= 0 && up < shrunk.length, `nav_up landed on a valid row (${up})`);
    sm.capture(() => sm.handleKey('j'));   // nav_down
    assert(nav.getSel(id) >= 0 && nav.getSel(id) < shrunk.length, 'nav_down valid too');
  });
});

describe('[table-tree] the collapsed Set survives the WAL checkpoint codec (replay)', () => {
  it('a folded node round-trips encodeJson → JSON → decodeJson and stays folded', () => {
    setMetric('host.proc', SERIES);
    // Fold '100' via the SAME transition the mouse tree_toggle{id} uses.
    const [folded] = table.update({ type: 'tree_toggle', id: '100' }, treeSlice());
    assert(folded.collapsed instanceof Set && folded.collapsed.has('100'), 'folded before serialize');
    // Full WAL wire round-trip (checkpoints embed slices; the codec is Set-aware).
    const wire = JSON.stringify(sessionLog.encodeJson({ slices: { procs: folded } }));
    eq(JSON.parse(wire).slices.procs.collapsed, { __set__: ['100'] }, 'Set encoded as {__set__:[...]} on the wire');
    const restored = sessionLog.decodeJson(JSON.parse(wire)).slices.procs;
    assert(restored.collapsed instanceof Set && restored.collapsed.has('100'), 'restored back to a functional Set');
    eq(table.getItems(restored), ['1', '100', '200'], 'the restored fold still hides the subtree (300)');
  });
});

describe('[table-tree] no bottom-border phantom marker at the pane-height floor (h==3)', () => {
  it('every published marker across a stack of min-height panes sits on a DRAWN row', () => {
    // Stack many tree panes in one column on a short terminal → the layout floor
    // (minH=3) forces several panes to h==3, where the sticky header eats the only
    // inner row. The publish loop's `dataH = max(1, innerH-1)` still iterates row 0,
    // so without the vertical clip guard its marker would land on the bottom border.
    const N = 10, pool = {}, panels = [];
    for (let i = 0; i < N; i++) {
      const c = { id: 'p' + i, type: 'table', title: 'P' + i, config: { topic: 'host.p' + i, columns: ['cpu'], tree: { parent: 'ppid' } } };
      pool['p' + i] = c; panels.push(c);
    }
    sm.bootFresh({ groups: { g: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } }, layout: { pool, columns: [{ panels }] } });
    for (let i = 0; i < N; i++) setMetric('host.p' + i, { '1': [{ cpu: 5, ppid: 0 }], '2': [{ cpu: 9, ppid: 1 }] });
    sm.resize(80, 40);
    sm.capture(() => sm.render());
    const panes = mpool.allPanesInColumns(route.getInstanceSlice('layout').arrange).filter(p => p.type === 'table');
    const hs = panes.map(p => visibleBoundsFor(route.getInstanceSlice('layout'), p.paneId).h);
    assert(hs.some(h => h === 3), 'scenario actually produced an h==3 pane (heights ' + hs.join(',') + ')');
    let checked = 0, bad = 0;
    for (const p of panes) {
      const b = visibleBoundsFor(route.getInstanceSlice('layout'), p.paneId);
      for (const m of (treeRegions.get(p.paneId) || [])) { checked++; if (m.y < 1 || m.y > b.h - 2) bad++; }
    }
    assert(checked > 0, 'markers were published across the stack');
    eq(bad, 0, 'no marker lands on a border / off-pane row (paint↔hit-test vertical agreement)');
    sm.resize(120, 40);
  });
});

report();
