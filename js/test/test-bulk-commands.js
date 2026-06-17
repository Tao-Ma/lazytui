/**
 * Bulk container commands smoke test — verifies docker plugin's
 * stop/start/restart commands resolve through the `:` cmdline registry,
 * read multi-selection (or fall back to focused), and invoke streamCommand
 * with the right docker invocation.
 *
 * Mocks streamCommand by overriding the module's exports before docker
 * plugin loads — captures (label, cmd) calls into a list.
 *
 * Run: node js/test/test-bulk-commands.js
 */
'use strict';

// Mock streamCommand BEFORE loading docker plugin. docker reaches it through
// the panel-host seam (api re-exports panelHost.streamCommand), so override the
// seam slot directly — independent of when test-runner wires the real one.
const stream = require('../dispatch/runtime/stream');
const calls = [];
stream.streamCommand = (label, cmd) => { calls.push({ label, cmd }); };
require('../leaves/panel-host').setPanelHost({ streamCommand: stream.streamCommand });

const { toggleMultiSel, setSel, clearMultiSel } = require('../app/state');
const api = require('../panel/api');
// docker is a Component now — its bulk `:` verbs are collected from the
// component registry (getCommands), and getItems('containers') reads config.
// Phase 3 requires `layout` to register before any other Component so
// non-layout slices nest under it; Phase 4a piggy-backs on that ordering
// since each Navigator's nav slice lives on its own Component slice.
api.registerComponent(require('../panel/layout'));
const dockerPlugin = require('../panel/navigator/docker');
api.registerComponent(dockerPlugin);

const { describe, it, assert, eq, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const { getInstanceSlice } = require('../panel/api');


// Set up a fake config + group so apiGetItems('containers', S) returns names.
getModel().config = {
  groups: {
    g1: { name: 'g1', containers: ['c1', 'c2', 'c3'] },
  },
};
getModel().currentGroup = 'g1';
const cmds = api.getCommands();
const stopCmd    = cmds.find(c => c.name === 'stop');
const startCmd   = cmds.find(c => c.name === 'start');
const restartCmd = cmds.find(c => c.name === 'restart');
const inspectCmd = cmds.find(c => c.name === 'inspect');

describe('[1] :stop / :start / :restart / :inspect resolve via getCommands', () => {
  it('all four bulk commands appear in the cmdline registry', () => {
    const names = cmds.map(c => c.name);
    assert(names.includes('stop'),    ':stop registered');
    assert(names.includes('start'),   ':start registered');
    assert(names.includes('restart'), ':restart registered');
    assert(names.includes('inspect'), ':inspect registered');
  });
});

describe('[2] no multi-select → focused container', () => {
  it('cmd targets only the focused row', () => {
    calls.length = 0;
    setSel('containers', 1);  // c2 is focused
    stopCmd.run([]);
    eq(calls.length, 1, 'one streamCommand call');
    assert(calls[0].cmd === 'docker stop "c2"', `cmd is "docker stop \\"c2\\"" (got ${calls[0].cmd})`);
    assert(calls[0].label.includes('c2'), `label mentions c2 (got ${calls[0].label})`);
  });
});

describe('[3] multi-select → all marked containers', () => {
  it('cmd targets the multi-selection set, not focused', () => {
    calls.length = 0;
    toggleMultiSel('containers', 'c1');
    toggleMultiSel('containers', 'c3');
    stopCmd.run([]);
    eq(calls.length, 1, 'one streamCommand call');
    assert(calls[0].cmd === 'docker stop "c1" "c3"',
           `cmd is "docker stop \\"c1\\" \\"c3\\"" (got ${calls[0].cmd})`);
    assert(calls[0].label.includes('2 containers'), `label says "2 containers" (got ${calls[0].label})`);
  });
});

describe('[4] start / restart / inspect use correct verbs', () => {
  it('verbs are docker start / restart / inspect', () => {
    calls.length = 0;
    startCmd.run([]);
    restartCmd.run([]);
    inspectCmd.run([]);
    eq(calls[0].cmd, 'docker start "c1" "c3"', 'start verb');
    eq(calls[1].cmd, 'docker restart "c1" "c3"', 'restart verb');
    assert(calls[2].cmd.startsWith('docker inspect "c1" "c3"'), `inspect verb (got ${calls[2].cmd})`);
    assert(calls[2].cmd.includes('jq'), 'inspect pipes through jq fallback');
  });
});

describe('[5] empty operand → no streamCommand call', () => {
  it('no-op when there is nothing to operate on', () => {
    calls.length = 0;
    getModel().config = { groups: { g1: { name: 'g1', containers: [] } } };
    clearMultiSel('containers');
    setSel('containers', 0);
    stopCmd.run([]);
    eq(calls.length, 0);
  });
});

describe('[6] command leaves terminalMode (R6: tab transition handled by stream_start auto-jump)', () => {
  it('leaves terminal mode + invokes streamCommand', () => {
    // v0.6.2 R6 — the pre-stream setActiveTab(0) was dropped (legacy
    // from pre-Transcript-tab era). In production, stream_start's
    // unrouted-auto-jump puts the user on Transcript (idx 1) when
    // the spawn fires; in this test streamCommand is mocked so no
    // stream_start fires — slice.tab stays where it was. We only
    // verify the synchronous side-effects: terminalMode cleared +
    // streamCommand invoked with the right args.
    getModel().config = { groups: { g1: { name: 'g1', containers: ['c1'] } } };
    getInstanceSlice('detail').tab = 3;
    require('../dispatch/control/dispatch').applyMsg({ type: 'mode_set', flag: 'terminalMode' });
    setSel('containers', 0);
    clearMultiSel('containers');
    calls.length = 0;
    stopCmd.run([]);
    eq(getModel().modes.terminalMode, false, 'left terminal mode');
    assert(calls.length === 1 && calls[0].cmd.startsWith('docker stop'), 'streamCommand invoked with docker stop');
  });
});

describe('[7] full cmdline path: type "inspect" + Enter → bulk command runs', () => {
  // Regression for the bug found in real use: cmdline.js called match.run()
  // with no args, leaving S undefined inside the run() body. The contract is
  // run(args, S); cmdline.js now passes both. Exercise the actual cmdline
  // dispatch end-to-end.
  it('cmdline-dispatched run reaches the docker plugin', () => {
    const { getModel } = require('../app/runtime');
    const dispatch = require('../dispatch/control/dispatch');
    const m = getModel();
    getModel().config = { groups: { g1: { name: 'g1', containers: ['c1', 'c2'] } } };
    getModel().currentGroup = 'g1';
    setSel('containers', 0);
    clearMultiSel('containers');
    calls.length = 0;
    // cmdline folded onto the update spine: enter + each keystroke + submit
    // flow as Msgs through update (cmdline_key emits cmdline_rebuild → the
    // facade re-query → cmdline_set_matches; submit emits cmdline_run).
    dispatch.applyMsg({ type: 'cmdline_enter' });
    for (const ch of 'inspect') dispatch.applyMsg({ type: 'cmdline_key', seq: ch });
    dispatch.applyMsg({ type: 'cmdline_submit' });
    eq(calls.length, 1, 'cmdline dispatched the run');
    assert(calls[0].cmd.startsWith('docker inspect "c1"'),
           `cmd via cmdline: docker inspect "c1" ... (got ${calls[0].cmd})`);
  });
});

report();
