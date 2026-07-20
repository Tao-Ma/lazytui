/**
 * U2d P0b — the embedded PTY as a first-class pane type. See
 * docs/one-tab-system.md. Run: node js/test/test-terminal-pane.js
 *
 * End-to-end through the real dispatch → finalizer → reconcile path: minting a
 * `terminal` into a focused slot appends+activates a tab, mints its per-tab
 * instance, the finalizer spawns its PTY (keyed by the tab-instance id ==
 * ptyId), and the shared `visibleTerminalSurfaces` selector reports it. The new
 * `remove_tab` primitive then tears it all down — the tab, the transient pool
 * entry, the instance, AND the PTY (destroySession-on-orphan: no leak). Also
 * pins the remove_tab guards (refuse the slot's last tab; re-activate the
 * previous tab when the active one is removed).
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const route = require('../panel/route');
const terminal = require('../io/terminal');
const { visibleTerminalSurfaces } = require('../panel/terminal-surfaces');
const { dispatchMsg } = require('../dispatch/runtime/loop');
const { getModel } = require('../model/store');

// The test-runner auto-registers only layout/detail/groups; register the pane
// types this test mints (as test-mint-tab does for text-view).
const api = sm.api;
if (!api.getComponent('terminal'))  api.registerComponent(require('../panel/terminal/terminal'));
if (!api.getComponent('text-view')) api.registerComponent(require('../panel/text-view/text-view'));

function paneAt(focus) {
  const arr = route.getInstanceSlice('layout').arrange;
  for (const col of arr.columns) for (const p of col.panels) if (p.paneId === focus) return p;
  return null;
}

describe('[terminal-pane] mint → spawn → render-surface → remove → destroy', () => {
  it('mints a terminal tab + instance and the finalizer spawns its PTY', () => {
    sm.bootFresh();
    const focus = route.getInstanceSlice('layout').focus;
    const nTabs = (paneAt(focus).tabs || []).length;

    dispatchMsg(route.wrap('layout', {
      type: 'mint_tab', paneId: focus, paneType: 'terminal', poolId: 'term-1',
      title: 'sh', config: { cmd: 'sleep 30', label: 'sh' },
    }));

    const after = paneAt(focus);
    eq(after.tabs.length, nTabs + 1, 'a tab was appended');
    eq(after.activeTabId, 'term-1', 'the minted terminal tab is active');
    eq(after.type, 'terminal', 'legacy type mirrors the active terminal tab');

    const ptyId = 'pane-term-1';
    assert(route.getInstance(ptyId), 'terminal instance minted at pane-term-1');
    eq(route.getInstance(ptyId).kind, 'terminal');
    eq(route.getInstanceSlice(focus).cmd, 'sleep 30', 'terminal slice seeded with cmd');
    // The finalizer's PTY reconcile spawned the session, keyed by the instance id.
    assert(terminal.getSession(ptyId), 'PTY spawned for the terminal pane');
    // The shared selector reports the surface (the overlay + the poll gate read it).
    assert(visibleTerminalSurfaces(getModel()).some(s => s.id === ptyId),
      'visibleTerminalSurfaces includes the minted terminal pane');
  });

  it('remove_tab tears down the tab, pool entry, instance, AND the PTY (no leak)', () => {
    const focus = route.getInstanceSlice('layout').focus;
    const ptyId = 'pane-term-1';
    assert(terminal.getSession(ptyId), 'precondition: PTY alive');

    dispatchMsg(route.wrap('layout', { type: 'remove_tab', paneId: focus, tabPoolId: 'term-1' }));

    const after = paneAt(focus);
    assert(!(after.tabs || []).some(t => t.id === 'term-1'), 'the terminal tab was removed');
    assert(!route.getInstanceSlice('layout').arrange.pool['term-1'], 'transient pool entry dropped');
    assert(!route.getInstance(ptyId), 'terminal instance disposed by reconcile');
    assert(!terminal.getSession(ptyId), 'PTY destroyed on orphan — no leaked child');
  });
});

describe('[terminal-pane] remove_tab guards', () => {
  it("refuses to remove the slot's only tab (a slot never goes empty)", () => {
    sm.bootFresh();
    const focus = route.getInstanceSlice('layout').focus;
    const soleTab = paneAt(focus).tabs[0].id;
    const before = JSON.stringify(paneAt(focus).tabs);
    dispatchMsg(route.wrap('layout', { type: 'remove_tab', paneId: focus, tabPoolId: soleTab }));
    eq(JSON.stringify(paneAt(focus).tabs), before, 'the only tab is not removed (no-op)');
  });

  it('re-activates the previous tab when the active tab is removed', () => {
    sm.bootFresh();
    const focus = route.getInstanceSlice('layout').focus;
    dispatchMsg(route.wrap('layout', { type: 'mint_tab', paneId: focus, paneType: 'text-view', poolId: 'a', config: { lines: ['a'] } }));
    dispatchMsg(route.wrap('layout', { type: 'mint_tab', paneId: focus, paneType: 'text-view', poolId: 'b', config: { lines: ['b'] } }));
    eq(paneAt(focus).activeTabId, 'b', 'b is active after minting');
    dispatchMsg(route.wrap('layout', { type: 'remove_tab', paneId: focus, tabPoolId: 'b' }));
    eq(paneAt(focus).activeTabId, 'a', 'removing active b re-activates the previous tab a');
  });
});

report();
