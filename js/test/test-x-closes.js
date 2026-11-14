/**
 * `x` closes a dead / content tab only where the tab CAN close; a pane alone in
 * its slot gets the menu.
 *
 * remove_tab (leaves/wm/pane removeTab) refuses a slot's last tab — a slot is
 * never empty. `x` on a dead terminal checked that (ede7c35a: a lone dead
 * terminal opens the menu, as its footer says), but the dead-agent and
 * content-text-view arms dispatched remove_tab regardless and stopped there: on
 * an agent or text-view declared alone in its slot, `x` did nothing at all
 * (pre-release review 2026-11-14). The rule now lives beside removeTab
 * (mpane.canRemoveTab) and every arm asks it.
 *
 *   [1] canRemoveTab is removeTab's rule
 *   [2] a dead agent alone in its slot: `x` opens the menu
 *   [3] a dead agent with a sibling tab: `x` closes it
 *   [4] a declared text-view alone in its slot: `x` opens the menu
 *
 * Run: node js/test/test-x-closes.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { section, assert, eq, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const route = require('../panel/route');
const mpane = require('../leaves/wm/pane');
const mpool = require('../leaves/wm/pool');
const { parse } = require('../parser');
const { getModel } = require('../model/store');
const { dispatchMsg } = require('../dispatch/runtime/loop');
const { _dispatchToken } = require('../dispatch/control/input');

for (const m of ['agent/agent', 'text-view/text-view']) {
  const c = require('../panel/' + m);
  if (!sm.api.getComponent(c.name)) sm.api.registerComponent(c);
}

const dirs = [];
function boot(slots) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-x-closes-'));
  dirs.push(dir);
  const yml = path.join(dir, 'tui.yml');
  fs.writeFileSync(yml, `project_dir: .
groups:
  g1:
    label: G
    actions:
      a: { label: A, script: echo a }
panels:
  groups: { type: groups, title: Groups }
  bot: { type: agent, title: Bot }
  notes: { type: text-view, title: Notes, lines: [one] }
  detail: { type: detail, title: Detail }
layout:
  columns:
    - width: 30
      panels: [groups]
    - panels: [${slots}, detail]
`);
  sm.bootFresh(parse(yml));
  sm.resize(140, 40);
}
const panes = () => mpool.allPanesInColumns(route.getInstanceSlice('layout').arrange);
const paneWith = (poolId) => panes().find(p => (p.tabs || []).some(t => t.id === poolId));
function focus(poolId) {
  const p = paneWith(poolId);
  dispatchMsg(route.wrap('layout', { type: 'focus_set', focus: p.paneId }));
  if (p.activeTabId !== poolId) dispatchMsg(route.wrap('layout', { type: 'set_active_tab', paneId: p.paneId, tabPoolId: poolId }));
  return p.paneId;
}
function killAgent() {
  const id = mpane.newPaneId('bot');
  const inst = route.getInstance(id);
  route.setInstance(id, inst.kind, { ...inst.slice, status: { ...inst.slice.status, state: 'exited' } });
}
const x = () => sm.capture(() => _dispatchToken('x'));
const menuOpen = () => !!getModel().modes.menuOpen;

section('[1] canRemoveTab is removeTab\'s rule');
{
  const pool = { a: { id: 'a', type: 't' }, b: { id: 'b', type: 't' } };
  const one = { paneId: 'p', tabs: [{ id: 'a', poolId: 'a' }], activeTabId: 'a' };
  const two = { ...one, tabs: [{ id: 'a', poolId: 'a' }, { id: 'b', poolId: 'b' }] };
  eq([mpane.canRemoveTab(one), mpane.removeTab(one, 'a', pool)], [false, null], 'a lone tab: no');
  eq(mpane.canRemoveTab(two), true, 'one of two: yes');
  assert(mpane.removeTab(two, 'a', pool), '…and removeTab does it');
}

section('[2] a dead agent alone in its slot: `x` opens the menu');
boot('bot');
focus('bot');
killAgent();
x();
assert(menuOpen(), 'the menu is open');
assert(paneWith('bot'), 'the pane stays');

section('[3] a dead agent with a sibling tab: `x` closes it');
boot('{ tabs: [bot, notes] }');
focus('bot');
killAgent();
x();
eq(menuOpen(), false, 'no menu');
eq(paneWith('bot'), undefined, 'the dead agent\'s tab is gone');
assert(paneWith('notes'), 'its sibling stays');

section('[4] a declared text-view alone in its slot: `x` opens the menu');
boot('notes');
focus('notes');
x();
assert(menuOpen(), 'the menu is open');
assert(paneWith('notes'), 'the pane stays');

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
report();
