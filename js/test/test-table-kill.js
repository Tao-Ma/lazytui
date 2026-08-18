/**
 * table panel — kill-selected (killable process table).
 *
 * Pins the new surface: the `killable` opt-in gate, the pure key/click arms that
 * open the signal picker (keyboard ↔ click resolve through the SAME _killMenuCmds),
 * the pid guard, and the keyboard end-to-end (focus a killable pane → `K` → the
 * signal menu opens) + the render gate (the Kill chip shows on a focused killable
 * pane only).
 *
 * Run: node js/test/test-table-kill.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const table = require('../panel/monitor/table');
const api = require('../panel/api');
const sm = require('./smoke/_helpers/smoke');

const SCHEMA = { cpu: { type: 'percent' }, comm: { type: 'string' } };
function setMetric(topic, seriesByRow) {
  getModel().metrics = { ...(getModel().metrics || {}), [topic]: { series: seriesByRow, schema: { columns: SCHEMA } } };
}
function killableSlice(extra) {
  return table.init('procs', { paneDef: { topic: 't', columns: ['cpu', 'comm'], killable: true, ...extra } });
}
// The Cmd a focused killable `K` / a kill-chip click should produce.
function menuOpenCmdOf(result) {
  assert(Array.isArray(result), 'arm returned [slice, cmds]');
  const cmds = result[1];
  return cmds.find(c => c.type === 'msg' && c.msg && c.msg.type === 'menu_open');
}

describe('[table-kill] init — killable flag', () => {
  it('seeds killable from the pane def; defaults false', () => {
    eq(killableSlice().killable, true);
    eq(table.init('p', { paneDef: { topic: 't' } }).killable, false);
  });
});

describe('[table-kill] itemOps — the operation declaration (item-ops contract)', () => {
  it('a killable pane declares Kill on BOTH surfaces (K key)', () => {
    eq(table.itemOps(killableSlice()), [{ id: 'kill', label: 'Kill', key: 'K', surfaces: ['bottom', 'menu'] }]);
  });
  it('a non-killable pane declares no operations (self-suppresses everywhere)', () => {
    eq(table.itemOps(table.init('p', { paneDef: { topic: 't' } })), []);
    eq(table.itemOps(null), []);
  });
});

describe('[table-kill] _handleKey — the keyboard arm', () => {
  const keyMsg = (over) => ({ type: 'key', key: 'K', focusKind: 'table', items: ['4242'], ...over });

  it('killable + focused table + K + valid pid → opens the picker and CLAIMS the key', () => {
    const slice = killableSlice();
    const res = table._handleKey(keyMsg(), slice);
    const open = menuOpenCmdOf(res);
    assert(open, 'a menu_open Cmd is emitted');
    eq(open.msg.title, 'Signal PID 4242');
    eq(open.msg.items[0], ['SIGTERM (15)', 'kill_signal', { pid: 4242, sig: 'TERM' }]);
    assert(res[1].some(c => c.type === '_claimed'), 'the key is claimed');
    eq(res[0], slice, 'slice unchanged (display-only action)');
  });

  it('non-killable pane → returns the slice UNCLAIMED (no menu)', () => {
    const slice = table.init('p', { paneDef: { topic: 't' } });
    const res = table._handleKey(keyMsg(), slice);
    eq(res, slice, 'bare slice, not [slice, cmds]');
  });

  it('a different focused kind → ignored (the key was meant for another pane)', () => {
    const slice = killableSlice();
    eq(table._handleKey(keyMsg({ focusKind: 'stats' }), slice), slice);
  });

  it('a non-K key → not our action, unclaimed', () => {
    const slice = killableSlice();
    eq(table._handleKey(keyMsg({ key: 'x' }), slice), slice);
  });

  it('an unsignalable rowKey (pid 1 / garbage) → unclaimed (never kill -TERM <garbage>)', () => {
    const slice = killableSlice();
    eq(table._handleKey(keyMsg({ items: ['1'] }), slice), slice, 'pid 1 (init)');
    eq(table._handleKey(keyMsg({ items: ['kworker'] }), slice), slice, 'non-numeric rowKey');
  });

  it('reads the cursor: K signals the row UNDER the cursor, not the first', () => {
    const slice = killableSlice();
    slice.nav.cursor = 1;
    const res = table._handleKey(keyMsg({ items: ['111', '222', '333'] }), slice);
    eq(menuOpenCmdOf(res).msg.items[0][2].pid, 222, 'the cursor row (index 1) is the target');
  });
});

describe('[table-kill] _handleItemAction — the click arm (bottom-bar chip)', () => {
  it('kill click → SAME menu_open Cmd as the keyboard path (no drift)', () => {
    const slice = killableSlice();
    const viaClick = menuOpenCmdOf(table._handleItemAction({ type: 'item_action', action: 'kill', item: '4242' }, slice));
    const viaKey = menuOpenCmdOf(table._handleKey({ type: 'key', key: 'K', focusKind: 'table', items: ['4242'] }, slice));
    eq(viaClick.msg, viaKey.msg, 'click and keyboard produce the identical menu');
  });
  it('a non-killable pane ignores a kill click (bare slice)', () => {
    const slice = table.init('p', { paneDef: { topic: 't' } });
    eq(table._handleItemAction({ type: 'item_action', action: 'kill', item: '4242' }, slice), slice);
  });
  it('an unknown action on a killable pane is ignored (bare slice)', () => {
    const k = killableSlice();
    eq(table._handleItemAction({ type: 'item_action', action: 'zap', item: '4242' }, k), k);
  });
  it('a kill click on an unsignalable pid → [slice, []] (no menu Cmd)', () => {
    const k = killableSlice();
    const res = table._handleItemAction({ type: 'item_action', action: 'kill', item: '1' }, k);
    eq(res[0], k);
    eq(menuOpenCmdOf(res), undefined, 'no menu_open Cmd for pid 1');
  });
});

describe('[table-kill] augmentMsg — threads rowKeys for the key arm only', () => {
  it('a non-key Msg passes through untouched', () => {
    const m = { type: 'nav_down' };
    eq(table.augmentMsg(m, {}, killableSlice()), m);
  });
  it('a key Msg on a non-killable pane passes through untouched (no wasted work)', () => {
    const m = { type: 'key', key: 'x' };
    eq(table.augmentMsg(m, {}, table.init('p', { paneDef: { topic: 't' } })), m);
  });
});

// --- integration: focus a killable pane → K opens the signal picker ----------
if (!api.getComponent('table')) api.registerComponent(require('../panel/monitor/table'));

// A DISTINCT paneId per killable-ness: a pool pane persists its instance across
// bootFresh calls (reconcile skips re-minting a stable id, so init — hence the
// killable flag — isn't re-run). Distinct ids force a fresh mint, so each pane
// gets the killable flag its config declares. (In production the flag is fixed at
// mint; it never flips under one pane.)
function bootProcs(killable, id) {
  id = id || (killable ? 'procs' : 'plain');
  const paneCfg = { id, type: 'table', title: 'Procs',
    config: { topic: 'host.proc', columns: ['cpu', 'comm'], sort: 'cpu', killable } };
  sm.bootFresh({
    groups: { g: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
    layout: { pool: { [id]: paneCfg }, columns: [{ panels: [paneCfg] }] },
  });
  setMetric('host.proc', { '4242': [{ cpu: 88.0, comm: 'node' }] });
  sm.api.dispatchMsg(sm.api.wrap('layout', { type: 'focus_set', focus: id }));
}

describe('[table-kill] keyboard end-to-end — K opens the signal picker', () => {
  it('focused killable pane: K → menu opens with the signal rows for the selected pid', () => {
    bootProcs(true);
    sm.capture(() => sm.render());
    sm.capture(() => sm.handleKey('K', 'K'));
    assert(getModel().modes.menuOpen, 'the menu is open');
    const menu = getModel().modal.menu;
    eq(menu.title, 'Signal PID 4242');
    eq(menu.items[0][0], 'SIGTERM (15)', 'SIGTERM leads the picker');
    assert(menu.items.some(r => r[2] && r[2].sig === 'KILL' && r[2].pid === 4242), 'SIGKILL row targets pid 4242');
  });

  it('non-killable pane: K does NOT open a menu', () => {
    bootProcs(false);
    sm.capture(() => sm.render());
    assert(!getModel().modes.menuOpen, 'precondition: boot left no menu open');
    sm.capture(() => sm.handleKey('K', 'K'));
    assert(!getModel().modes.menuOpen, 'no menu — a non-killable table ignores K');
  });
});

describe('[table-kill] right-click → context menu → Kill opens the picker', () => {
  const cm = require('../leaves/input/context-menu');
  const { contextOpRows } = require('../leaves/render/item-ops');

  // The real instance paneId (a pool id `procs` mints as `pane-procs`); this is
  // what _resolveContextAt reads from allPanels() in production.
  const tablePaneId = () => require('../panel/nav-state').allPanels().find(p => p.type === 'table').paneId;

  it('the pointed process row offers Kill in the context menu; activating it opens the signal picker', () => {
    bootProcs(true);   // pid 4242
    const paneId = tablePaneId();
    const ops = table.itemOps(sm.route.getInstanceSlice(paneId));
    const opRows = contextOpRows(paneId, '4242', ops);   // as _resolveContextAt would build
    const items = cm.buildContextItems({ paneKind: 'table', itemLabel: '4242', paneOpRows: opRows });
    const killIdx = items.findIndex(r => r && r[1] === 'pane_item_action' && r[2] && r[2].id === 'kill');
    assert(killIdx >= 0, 'the context menu contains a Kill row for the pointed process');
    eq(items[killIdx][2], { paneId, id: 'kill', item: '4242' });

    // Open that context menu and activate Kill → pane_item_action → item_action → picker.
    sm.applyMsg({ type: 'menu_open', items, title: 'Actions' });
    sm.capture(() => sm.applyMsg({ type: 'menu_activate', idx: killIdx }));
    assert(getModel().modes.menuOpen, 'a menu is open after activating Kill');
    eq(getModel().modal.menu.title, 'Signal PID 4242', 'the signal picker opened for the pointed pid');
  });

  it('a non-killable table contributes NO rows to the context menu', () => {
    bootProcs(false, 'plain');
    const paneId = tablePaneId();
    const ops = table.itemOps(sm.route.getInstanceSlice(paneId));
    eq(contextOpRows(paneId, '4242', ops), [], 'no item-op rows from a non-killable table');
  });
});

describe('[table-kill] render gate — the Kill chip', () => {
  it('a focused killable pane paints the Kill affordance; a non-killable one does not', () => {
    bootProcs(true);
    const { frame: killableFrame } = sm.capture(() => sm.render());
    assert(/Kill/.test(killableFrame), 'the Kill chip is painted on the killable pane');

    bootProcs(false);
    const { frame: plainFrame } = sm.capture(() => sm.render());
    assert(!/Kill/.test(plainFrame), 'no Kill chip on a non-killable table');
  });
});

report();
