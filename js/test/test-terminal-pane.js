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

// Mock writeToSession FIRST — before ANY module that destructures it at load
// (input.js does, pulled in transitively by the runtime below). The other tests
// spawn real PTYs but never write to them, so this stub is harmless to them.
const terminal = require('../io/terminal');
const writeToSessionCalls = [];
terminal.writeToSession = (id, data) => { writeToSessionCalls.push({ id, data }); };

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const route = require('../panel/route');
const { visibleTerminalSurfaces, focusedTerminalId } = require('../panel/terminal-surfaces');
const { dispatchMsg, applyMsg } = require('../dispatch/runtime/loop');
const { getModel } = require('../model/store');
const { _handleTerminalModeData } = require('../dispatch/control/input');

// The test-runner auto-registers only layout/detail/groups; register the pane
// types this test mints (as test-mint-tab does for text-view).
const api = sm.api;
if (!api.getComponent('terminal'))  api.registerComponent(require('../panel/terminal/terminal'));
if (!api.getComponent('text-view')) api.registerComponent(require('../panel/text-view/text-view'));

// P1a — wire the PTY-exit fan-out (handleExit) so the clean-exit auto-close test
// can drive it, exactly as test-spawn-pty-tab does. Harmless for the P0b tests
// (a killed session's async onExit lands after the instance is disposed → no-op).
const ptyLifecycle = require('../panel/content/pty-lifecycle');
ptyLifecycle.install(require('../dispatch/runtime/effects').effectHost());

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

describe('[terminal-pane] P1a — focus resolution + clean-exit auto-close', () => {
  it('focusedTerminalId resolves the FOCUSED terminal pane (input/activation target)', () => {
    sm.bootFresh();
    const focus = route.getInstanceSlice('layout').focus;
    dispatchMsg(route.wrap('layout', {
      type: 'mint_tab', paneId: focus, paneType: 'terminal', poolId: 'term-1', config: { cmd: 'sleep 30' },
    }));
    // mint_tab focus-follows the focused slot, so the terminal pane is now focused.
    eq(route.instanceKind(route.getFocus()), 'terminal', 'the minted terminal pane is focused');
    eq(focusedTerminalId(), 'pane-term-1', 'focusedTerminalId → the focused terminal pane');
    // clean up the real PTY
    dispatchMsg(route.wrap('layout', { type: 'remove_tab', paneId: focus, tabPoolId: 'term-1' }));
  });

  it('handleExit(code 0) auto-closes the terminal tab AND destroys the PTY (D-exit)', () => {
    sm.bootFresh();
    const focus = route.getInstanceSlice('layout').focus;
    dispatchMsg(route.wrap('layout', {
      type: 'mint_tab', paneId: focus, paneType: 'terminal', poolId: 'term-1', config: { cmd: 'sleep 30' },
    }));
    const ptyId = 'pane-term-1';
    assert(terminal.getSession(ptyId), 'precondition: PTY alive');
    // Simulate the PTY's clean-exit fan-out (the event io/terminal fires on exit 0).
    ptyLifecycle.handleExit(ptyId, 0);
    assert(!(paneAt(focus).tabs || []).some(t => t.id === 'term-1'), 'clean exit auto-closed the tab');
    assert(!terminal.getSession(ptyId), 'PTY destroyed by the reconcile orphan-dispose');
  });

  it('handleExit(non-zero) leaves the tab in place (user dismisses with x)', () => {
    sm.bootFresh();
    const focus = route.getInstanceSlice('layout').focus;
    dispatchMsg(route.wrap('layout', {
      type: 'mint_tab', paneId: focus, paneType: 'terminal', poolId: 'term-1', config: { cmd: 'sleep 30' },
    }));
    ptyLifecycle.handleExit('pane-term-1', 1);
    assert(paneAt(focus).tabs.some(t => t.id === 'term-1'), 'non-zero exit keeps the tab (readable exit code)');
    dispatchMsg(route.wrap('layout', { type: 'remove_tab', paneId: focus, tabPoolId: 'term-1' }));  // cleanup
  });
});

describe('[terminal-pane] P1b — input forwarding + _onSessionExit fan-out', () => {
  it('_handleTerminalModeData forwards keystrokes to the FOCUSED terminal pane PTY', () => {
    sm.bootFresh();
    const focus = route.getInstanceSlice('layout').focus;
    dispatchMsg(route.wrap('layout', {
      type: 'mint_tab', paneId: focus, paneType: 'terminal', poolId: 'term-1', config: { cmd: 'sleep 30' },
    }));
    // mint focus-follows the focused slot → the terminal pane is focused.
    applyMsg({ type: 'terminal_enter' });
    writeToSessionCalls.length = 0;
    _handleTerminalModeData('hi');
    eq(writeToSessionCalls.length, 1, 'forwarded once');
    eq(writeToSessionCalls[0].id, 'pane-term-1', 'to the FOCUSED terminal pane PTY (focusedTerminalId)');
    eq(writeToSessionCalls[0].data, 'hi', 'the exact bytes');
    dispatchMsg(route.wrap('layout', { type: 'remove_tab', paneId: focus, tabPoolId: 'term-1' }));  // cleanup
  });

  it('_onSessionExit(0) fans out through the exit handler → auto-closes the pane', () => {
    sm.bootFresh();
    const focus = route.getInstanceSlice('layout').focus;
    dispatchMsg(route.wrap('layout', {
      type: 'mint_tab', paneId: focus, paneType: 'terminal', poolId: 'term-1', config: { cmd: 'sleep 30' },
    }));
    assert(terminal.getSession('pane-term-1'), 'precondition: PTY alive');
    // The io/terminal exit fan-out entry (what onExit calls) → the wired handleExit.
    terminal._onSessionExit('pane-term-1', 0);
    assert(!paneAt(focus).tabs.some(t => t.id === 'term-1'), 'clean exit fan-out auto-closed the tab');
    assert(!terminal.getSession('pane-term-1'), 'PTY destroyed');
  });
});

describe('[terminal-pane] P2.5 — docker exec mints a reused terminal pane', () => {
  // Capture the docker effect handlers without registering the whole component
  // (avoids its polling/subprocess machinery). A MOCK host records the dispatched
  // Msgs so we test the docker-specific dispatch logic (poolId sanitization, the
  // docker-exec cmd, reuse-via-set_active_tab) without a real `docker exec` spawn —
  // the mint→pane wiring itself is covered by the tests above.
  const dockerHandlers = {};
  require('../panel/navigator/docker').installEffects((t, fn) => { dockerHandlers[t] = fn; });

  it('dockerShell dispatches a `terminal`-pane mint keyed per container + reuse', () => {
    sm.bootFresh();
    const dispatched = [];
    const mockHost = {
      dispatchMsg: (m) => dispatched.push(m),
      applyMsg: (m) => dispatched.push(m),
      wrap: (target, msg) => ({ __target: target, ...msg }),
    };
    dockerHandlers.dockerShell({ item: 'my/c1' }, mockHost);

    const mint = dispatched.find(m => m.type === 'mint_tab');
    assert(mint, 'dispatched a mint_tab');
    eq(mint.paneType, 'terminal', 'mints a terminal pane');
    eq(mint.poolId, 'term-dockersh-my_c1', 'stable poolId per container (sanitized)');
    assert(mint.config.cmd.includes('docker exec -it "my/c1"'), 'runs docker exec for the container');
    eq(mint.hint.origin, 'docker-shell', 'stamps a docker-shell hint');
    assert(dispatched.some(m => m.type === 'set_active_tab' && m.tabPoolId === 'term-dockersh-my_c1'),
      're-activates the tab (reuse on re-exec)');
    assert(dispatched.some(m => m.type === 'focus_set'), 'focuses the container');
    assert(dispatched.some(m => m.type === 'terminal_enter'), 'enters terminal mode');
  });
});

describe('[terminal-pane] P2 — YAML group.terminals → auto-generated terminal actions', () => {
  it('getMergedActions generates a type:terminal action per group.terminals entry', () => {
    sm.bootFresh();
    const group = getModel().currentGroup;
    getModel().config.groups[group].terminals = { sh: { cmd: 'sleep 30', label: 'Shell' } };
    const acts = api.getMergedActions(group);
    assert(acts.sh, 'a "sh" action generated from group.terminals');
    eq(acts.sh.type, 'terminal', 'type:terminal');
    eq(acts.sh.script, 'sleep 30', 'script = the configured cmd');
    eq(acts.sh.label, 'Shell', 'label carried through');
  });

  it('running a type:terminal action mints a REUSED terminal pane', () => {
    sm.bootFresh();
    const { runAction } = require('../dispatch/runtime/action-runner');
    const group = getModel().currentGroup;
    const act = { type: 'terminal', script: 'sleep 30', label: 'Shell' };
    runAction('sh', act, []);
    const ptyId = `pane-term-yaml-${group}-sh`;
    assert(route.getInstance(ptyId), 'terminal pane minted for the YAML terminal');
    eq(route.getInstance(ptyId).kind, 'terminal');
    eq(getModel().modes.terminalMode, true, 'entered terminal mode');
    // Reuse: a second run of the same terminal must NOT open a second pane.
    const countTermTabs = () => {
      let n = 0;
      for (const col of route.getInstanceSlice('layout').arrange.columns)
        for (const p of col.panels)
          for (const t of (p.tabs || [])) if (t.poolId === `term-yaml-${group}-sh`) n++;
      return n;
    };
    eq(countTermTabs(), 1, 'one terminal tab after first run');
    runAction('sh', act, []);
    eq(countTermTabs(), 1, 'reused — still one tab after re-run (no duplicate)');
    terminal.destroySession(ptyId);  // cleanup the real PTY
  });
});

describe('[terminal-pane] overlay-repaint poll follows half-view slot swaps (round-4 #3 — sub-gate leak)', () => {
  it('reconcile is NOT skipped when a terminal is swapped out of a half slot (halfView moves, arrange does not)', () => {
    const state = require('../app/state');
    sm.bootFresh();
    const termPane = route.getInstanceSlice('layout').focus;
    const others = [];
    for (const col of route.getInstanceSlice('layout').arrange.columns)
      for (const p of col.panels) if (p.paneId && p.paneId !== termPane) others.push(p.paneId);
    assert(others.length >= 2, 'need two non-terminal panes for the half slots');
    const [A, B] = others;

    dispatchMsg(route.wrap('layout', { type: 'mint_tab', paneId: termPane, paneType: 'terminal', poolId: 'term-sg', config: { cmd: 'sleep 30' } }));
    dispatchMsg(route.wrap('layout', { type: 'view_set', mode: 'half' }));
    dispatchMsg(route.wrap('layout', { type: 'view_place_pane', slot: 'left', paneId: termPane }));

    const overlayLive = () => state._liveSubKeys().some(k => k.includes('overlay-repaint'));

    // Terminal in the left half slot → on screen → poll armed.
    state.reconcileSubscriptions(getModel());
    assert(visibleTerminalSurfaces(getModel()).length >= 1, 'precondition: terminal on screen in the left half slot');
    assert(overlayLive(), 'overlay-repaint poll armed while the terminal is on screen');

    // Fill BOTH half slots with NON-terminals: `halfView` changes but `arrange`
    // does NOT (same pool + columns), so the terminal leaves the screen without an
    // arrange rebuild. The pre-fix gate keyed only on arrange/dims/viewMode → it
    // SKIPPED this reconcile, leaving the 250ms poll running with no terminal on
    // screen. The fix folds `halfView` into the gate key.
    const arrangeBefore = route.getInstanceSlice('layout').arrange;
    dispatchMsg(route.wrap('layout', { type: 'view_place_pane', slot: 'left',  paneId: A }));
    dispatchMsg(route.wrap('layout', { type: 'view_place_pane', slot: 'right', paneId: B }));
    assert(route.getInstanceSlice('layout').arrange === arrangeBefore, 'arrange unchanged by the slot swaps (only halfView moved) — the crux');
    state.reconcileSubscriptions(getModel());
    assert(visibleTerminalSurfaces(getModel()).length === 0, 'terminal off screen once both half slots hold non-terminals');
    assert(!overlayLive(), 'overlay-repaint poll torn down once no terminal is on screen (gate honored the halfView change)');

    dispatchMsg(route.wrap('layout', { type: 'remove_tab', paneId: termPane, tabPoolId: 'term-sg' }));
    state._resetSubscriptions();   // clear any live interval timers so the process exits promptly
  });
});

report();
