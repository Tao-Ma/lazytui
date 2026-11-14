/**
 * The smoke harness's bootFresh starts each scenario like a new process: every
 * pane is minted from THIS config's pane def, nothing carries over from the last
 * scenario.
 *
 * Pre-release review 2026-11-14: pane instances kept their ids across boots and
 * initState doesn't re-mint an existing one, so bootFresh patched a few fields
 * back by hand — list cursors; the Info / Transcript buffers — and, since
 * dfa24dbe, skipped a text-view declared under `panels:` entirely (so its
 * configured lines survived). A declared text-view then kept the last
 * scenario's lines, cursor and search, and the next config's `lines:` never
 * applied; any other declared setting (an agent's `backend:`) leaked the same
 * way. Now bootFresh disposes every pane instance through the mint's own
 * teardown (state.disposePaneInstance) and initState mints them fresh.
 *
 *   [1] a declared text-view starts from the new config, not the last scenario
 *   [2] a declared agent's settings come from the new config
 *   [3] list cursors start at the top
 *   [4] what a pane owned goes with it (a terminal's PTY)
 *   [5] the layout instance and services live on
 *
 * Run: node js/test/test-boot-fresh.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { section, assert, eq, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const route = require('../panel/route');
const terminal = require('../io/terminal');
const { parse } = require('../parser');

for (const m of ['text-view/text-view', 'agent/agent', 'terminal/terminal']) {
  const c = require('../panel/' + m);
  if (!sm.api.getComponent(c.name)) sm.api.registerComponent(c);
}

const dirs = [];
function config({ lines, backend }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-boot-fresh-'));
  dirs.push(dir);
  const yml = path.join(dir, 'tui.yml');
  fs.writeFileSync(yml, `project_dir: .
groups:
  g1:
    label: G1
    actions:
      a: { label: A, script: echo a }
      b: { label: B, script: echo b }
  g2:
    label: G2
    actions:
      c: { label: C, script: echo c }
panels:
  groups: { type: groups, title: Groups }
  notes: { type: text-view, title: Notes, lines: [${lines.join(', ')}] }
  bot: { type: agent, title: Bot, backend: ${backend} }
  dev: { type: terminal, title: Dev, cmd: 'sleep 60' }
  detail: { type: detail, title: Detail }
layout:
  columns:
    - width: 30
      panels: [groups, dev]
    - panels: [notes, bot, detail]
`);
  return parse(yml);
}
const slice = (id) => route.getInstanceSlice(id);

// --- scenario A: boot, then leave state behind everywhere ---------------------
sm.bootFresh(config({ lines: ['a1', 'a2'], backend: 'mock' }));
sm.resize(140, 40);
eq(slice('pane-notes').lines, ['a1', 'a2'], 'precondition: scenario A\'s notes');
route.setInstance('pane-notes', 'text-view', { ...slice('pane-notes'),
  cursor: { line: 1, col: 1 }, scroll: 1, search: { active: true, term: 'a2', idx: 0, typing: '' } });
const groupsA = slice('pane-groups');
route.setInstance('pane-groups', 'groups', { ...groupsA, nav: { ...groupsA.nav, cursor: 1 } });
let killed = false;
const oldSession = {
  pty: { kill() { killed = true; }, write() {}, resize() {} },
  screen: { dispose() {} }, cmd: 'sleep 60', cwd: '.', exited: false, exitCode: null,
};
terminal._setSessionForTest('pane-dev', oldSession);
const layoutA = route.getInstance('layout');

// --- scenario B: another config, same pane ids --------------------------------
sm.bootFresh(config({ lines: ['b1'], backend: 'pi' }));
sm.resize(140, 40);

section('[1] a declared text-view starts from the new config, not the last scenario');
const notes = slice('pane-notes');
eq(notes.lines, ['b1'], 'its lines are the new config\'s');
eq([notes.cursor, notes.scroll], [{ line: 0, col: 0 }, 0], 'cursor and scroll at the top');
eq(notes.search.active, false, 'no search left open');

section('[2] a declared agent\'s settings come from the new config');
eq(slice('pane-bot').descriptor.backend, 'pi', 'backend: pi (scenario A said mock)');

section('[3] list cursors start at the top');
eq(slice('pane-groups').nav.cursor, 0, 'the groups cursor (scenario A left it on row 1)');

section('[4] what a pane owned goes with it');
assert(killed, 'scenario A\'s terminal PTY was stopped');
assert(terminal.getSession('pane-dev') !== oldSession, 'and its session is gone (the new pane spawns its own)');

section('[5] the layout instance and services live on');
assert(route.getInstance('layout') === layoutA, 'the layout instance is the same one (a kind seed)');

terminal.destroyAll();
for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
report();
