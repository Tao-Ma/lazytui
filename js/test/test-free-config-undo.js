/**
 * Free-config undo / redo restore what free-config edited, not the runtime's
 * tab lifecycle.
 *
 * Round-2 review 2026-11-14: c4d90d12 made undo restore the snapshot's whole
 * pool (so a title edit undoes). A transient tab that closed AFTER the snapshot
 * — a finished command, an exited `:terminal` (remove_tab drops its entry,
 * pushes no undo step) — then came back with its entry on `u`, and the finalizer
 * spawned its command AGAIN. (Before c4d90d12 the tab came back without its
 * entry: a broken tab.)
 *
 *   [1] a transient tab closed since the snapshot stays closed — no entry, no tab
 *   [2] an edit to an entry that still exists is undone (the title)
 *   [3] redo after it
 *
 * Round-3 review 2026-11-14: the drop went tab by tab (mpane.removeTab), and a
 * slot whose ACTIVE tab and the tab it hands over to had both closed (two
 * `:terminal`s minted into it — a mint activates) was dropped WHOLE: its
 * configured tab, its instance and its running program with it.
 *   [4] two closed transient tabs of one slot, the snapshot's active one of
 *       them: the slot stays with its configured tab, instance alive; redo too
 *   [5] the same in the viewer slot: the layout keeps its viewer
 *
 * Run: node js/test/test-free-config-undo.js
 */
'use strict';

const { section, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const route = require('../panel/route');
const mpool = require('../leaves/wm/pool');

sm.bootFresh();
sm.resize(140, 40);
const L = () => route.getInstanceSlice('layout');
const layout = (m) => sm.api.dispatchMsg(sm.api.wrap('layout', m));
const panes = () => mpool.allPanesInColumns(L().arrange);
const tabIds = () => panes().flatMap(p => (p.tabs || []).map(t => t.poolId));
const viewer = () => panes().find(p => p.role === 'content');

// A transient tab in the content slot — what a `type: run` action's output or a
// `:terminal` mints (a text-view here: no process needed to make the point).
layout({ type: 'mint_tab', paneId: viewer().paneId, paneType: 'text-view', poolId: 'out-1', title: 'out' });
assert(tabIds().includes('out-1') && L().arrange.pool['out-1'], 'precondition: the transient tab is placed, with its entry');

layout({ type: 'free_config_enter' });
const groups = panes().find(p => p.id === 'groups');
layout({ type: 'focus_set', focus: groups.paneId });
layout({ type: 'free_config_title_enter' });
L().freeConfig.titleEdit.text = 'Renamed';
layout({ type: 'free_config_title_submit', freeConfigTitleEditMode: true });
eq(L().arrange.pool.groups.title, 'Renamed', 'precondition: an edit (the snapshot holds out-1)');

// The tab closes on its own (its command finished): remove_tab, no undo step.
layout({ type: 'remove_tab', paneId: viewer().paneId, tabPoolId: 'out-1' });
assert(!tabIds().includes('out-1') && !L().arrange.pool['out-1'], 'precondition: closed, entry dropped');

layout({ type: 'free_config_undo' });
section('[1] a transient tab closed since the snapshot stays closed');
eq(tabIds().includes('out-1'), false, 'not placed again');
eq(L().arrange.pool['out-1'], undefined, 'its entry not brought back (it would be re-minted — a command re-run)');

section('[2] an edit to an entry that still exists is undone');
eq([L().arrange.pool.groups.title, panes().find(p => p.id === 'groups').title], ['Groups', 'Groups']);

section('[3] redo');
layout({ type: 'free_config_redo' });
eq([L().arrange.pool.groups.title, tabIds().includes('out-1')], ['Renamed', false]);

layout({ type: 'free_config_exit' });

// Two transient tabs minted into one slot, then an edit (the snapshot holds the
// slot with the LAST minted tab active), then both close on their own.
function twoClosed(slotPane, prefix) {
  const pid = slotPane().paneId;
  const own = slotPane().tabs.map(t => t.poolId);
  layout({ type: 'mint_tab', paneId: pid, paneType: 'text-view', poolId: `${prefix}-1`, title: 'one' });
  layout({ type: 'mint_tab', paneId: pid, paneType: 'text-view', poolId: `${prefix}-2`, title: 'two' });
  layout({ type: 'free_config_enter' });
  const acts = panes().find(p => p.id === 'actions');
  layout({ type: 'focus_set', focus: acts.paneId });
  layout({ type: 'free_config_title_enter' });
  L().freeConfig.titleEdit.text = `Renamed-${prefix}`;
  layout({ type: 'free_config_title_submit', freeConfigTitleEditMode: true });
  const snapSlot = L().freeConfig.undo[L().freeConfig.undo.length - 1].columns
    .flatMap(c => c.panels).find(p => p.paneId === pid);
  eq(snapSlot && snapSlot.activeTabId, `${prefix}-2`, 'precondition: the snapshot\'s active tab is one that will close');
  layout({ type: 'remove_tab', paneId: pid, tabPoolId: `${prefix}-1` });
  layout({ type: 'remove_tab', paneId: pid, tabPoolId: `${prefix}-2` });
  const state = () => {
    const p = panes().find(q => q.paneId === pid);
    return { placed: !!p, tabs: p ? p.tabs.map(t => t.poolId) : null,
      active: p ? p.activeTabId : null,
      instance: !!(p && route.getInstance(route.activeInstanceOf(pid))) };
  };
  layout({ type: 'free_config_undo' });
  const undone = state();
  const title = L().arrange.pool.actions.title;
  layout({ type: 'free_config_redo' });
  const redone = state();
  layout({ type: 'free_config_exit' });
  return { pid, own, undone, title, redone };
}

section('[4] two closed transient tabs of one slot — the slot stays');
{
  const r = twoClosed(() => panes().find(p => p.id === 'groups'), 'term');
  eq(r.undone, { placed: true, tabs: r.own, active: r.own[r.own.length - 1], instance: true },
    'undo: the slot, its configured tab active, its instance alive');
  eq(r.title, 'Actions', 'the edit itself is undone');
  eq(r.redone, { placed: true, tabs: r.own, active: r.own[r.own.length - 1], instance: true }, 'redo: the same');
}

section('[5] the same in the viewer slot — the layout keeps its viewer');
{
  const r = twoClosed(viewer, 'run');
  eq([r.undone.placed, r.undone.tabs, r.undone.instance], [true, r.own, true], 'undo keeps the viewer slot');
  eq(!!viewer(), true, 'a viewer is still resolvable');
  eq([r.redone.placed, r.redone.tabs], [true, r.own], 'redo too');
}
report();
