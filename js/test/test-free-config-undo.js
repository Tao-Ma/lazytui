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
report();
