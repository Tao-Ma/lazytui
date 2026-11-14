/**
 * A terminal pane keeps its grid when the main frame writes over its rows for
 * a reason the pane's own row cache can't see.
 *
 * The terminal grid is painted AFTER the main frame, outside its cell-diff; the
 * frame holds the pane's BLANK interior. Wherever the frame drops its record of
 * a screen row (render()'s popup-coverage reconcile, the vanish reclaim of a
 * surface that stopped painting, an `invalidate` from elsewhere) its diff
 * rewrites the WHOLE row — blanking every terminal interior on that row — and
 * the terminal painter skipped it, because the row's text and popup spans were
 * unchanged. Pre-release review 2026-11-14: a popup over one of two
 * side-by-side terminals blanked the other's rows; minimizing one, or switching
 * its slot to another tab, blanked the other permanently.
 *
 * Now painter.paintFrame reports the cells it wrote, and the terminal painter
 * repaints any of its rows the frame wrote over. And render() reconciles a
 * popup's coverage only where it lands INSIDE a terminal's columns — a popup
 * beside a terminal leaves its rows alone.
 *
 *   [1] paintFrame reports the cells it wrote
 *   [2] a popup beside a terminal doesn't touch the terminal's rows
 *   [3] a popup over one terminal leaves the terminal beside it intact
 *   [4] minimizing one terminal leaves the other intact (and restoring it)
 *   [5] switching one terminal's slot to another tab leaves the other intact
 *   [6] a row invalidated from elsewhere comes back
 *
 * Run: node js/test/test-terminal-frame-overwrite.js
 */
'use strict';

process.stdout.columns = 160; process.stdout.rows = 40;

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, section, assert, eq, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const painter = require('../leaves/render/painter');
const terminal = require('../io/terminal');
const route = require('../panel/route');
const mpane = require('../leaves/wm/pane');
const mpool = require('../leaves/wm/pool');
const { parse } = require('../parser');
const { visibleTerminalSurfaces } = require('../panel/terminal-surfaces');
const { invalidateRows } = require('../render/paint');
const { getModel } = require('../model/store');
const { dispatchMsg } = require('../dispatch/runtime/loop');

if (!sm.api.getComponent('terminal')) sm.api.registerComponent(require('../panel/terminal/terminal'));

describe('[1] paintFrame reports the cells it wrote', () => {
  const prev = ['aaaaaaaaaa', 'bbbbbbbbbb', 'ab⚡dddddd'];
  const next = ['aaXaaaaaYY', 'bbbbbbbbbb', 'abXYdddddd'];
  it('the cell diff: each run of changed cells, per row', () => {
    const { didFull, wrote } = painter.paintFrame(prev, next, false);
    eq(didFull, false);
    eq([...wrote], [[0, [[2, 3], [8, 10]]], [2, [[2, 4]]]]);
  });
  it('a row whose record was dropped (invalidated) is written whole', () => {
    eq([...painter.paintFrame(['', 'bbbbbbbbbb'], ['aaaaaaaaaa', 'bbbbbbbbbb'], false).wrote], [[0, [[0, 10]]]]);
  });
  it('the whole-row path (replay highlighting) writes a changed row whole', () => {
    const { wrote } = painter.paintFrame(prev, next, false, { mode: 'line', hlOn: '\x1b[7m', hlOff: '\x1b[27m' });
    eq([...wrote], [[0, [[0, Infinity]]], [2, [[0, Infinity]]]]);
  });
  it('a full repaint says so (didFull) and lists nothing', () => {
    const { didFull, wrote } = painter.paintFrame(prev, next, true);
    eq(didFull, true);
    eq(wrote.size, 0);
  });
});

// --- two terminals side by side, on a decoded screen -------------------------
// A shares its slot with Groups (tabs) over Detail in a 70-wide column; B is
// alone in the flex column, so every row A covers B covers too.
const hs = require('./_helpers/host-screen').install({ cols: 160, rows: 40 });

(async () => {
  if (!terminal.ptyAvailable()) {
    hs.write('  (skipped [2]–[6]: the optional node-pty dependency is not installed)\n');
    hs.restore();
    report();
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-frame-overwrite-'));
  const fill = (name, tag) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, `i=1; while [ $i -le 60 ]; do printf '${tag}%02d-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n' $i; i=$((i+1)); done; sleep 60\n`);
    return `sh ${p}`;
  };
  const yml = path.join(dir, 'tui.yml');
  fs.writeFileSync(yml, [
    'project_dir: .',
    'groups:',
    '  g1:',
    '    label: Group 1',
    '    actions:',
    '      hello: { label: Hello, script: echo hello }',
    'panels:',
    '  groups: { type: groups, title: Groups }',
    `  ta: { type: terminal, title: TA, cmd: ${JSON.stringify(fill('a.sh', 'AAA'))} }`,
    `  tb: { type: terminal, title: TB, cmd: ${JSON.stringify(fill('b.sh', 'BBB'))} }`,
    '  detail: { type: detail, title: Detail }',
    'layout:',
    '  columns:',
    '    - width: 70',
    '      panels: [{ tabs: [ta, groups] }, detail]',
    '    - width: flex',
    '      panels: [tb]',
    '',
  ].join('\n'));
  sm.bootFresh(parse(yml));
  sm.resize(160, 40);
  const panes = () => mpool.allPanesInColumns(route.getInstanceSlice('layout').arrange);
  const paneOf = (id) => panes().find(p => p.id === id);
  const idA = mpane.newPaneId('ta'), idB = mpane.newPaneId('tb');
  const { waitFor } = require('./_helpers/terminal-layout');
  await waitFor(idA, 'AAA60');
  await waitFor(idB, 'BBB60');
  await hs.paint();
  await hs.paint();

  const surfB = () => visibleTerminalSurfaces(getModel()).find(s => s.id === idB);
  // B's interior rows whose screen text differs from what the program shows.
  function bWrong() {
    const s = surfB();
    const x0 = s.bounds.x + 1, y0 = s.bounds.y + 1;
    const want = terminal.sessionViewportRows(idB, s.rows, s.cols).rows;
    const wrong = [];
    for (let r = 0; r < s.rows; r++) if (hs.line(y0 + r).slice(x0, x0 + s.cols).trimEnd() !== want[r].trimEnd()) wrong.push(y0 + r);
    return wrong;
  }
  const MENU = '╭──Tabs';   // the pane menu of a slot with tabs
  const aRows = () => { const s = visibleTerminalSurfaces(getModel()).find(x => x.id === idA); return [s.bounds.y + 1, s.bounds.y + 1 + s.rows]; };
  const [aTop, aBottom] = aRows();
  assert(surfB() && aBottom > aTop, 'precondition: both terminals paint');
  assert(hs.line(surfB().bounds.y + 2).includes('BBB'), 'precondition: B\'s grid is on screen');
  eq(bWrong(), [], 'precondition: B shows exactly its program\'s screen');

  section('[2] a popup beside a terminal doesn\'t touch the terminal\'s rows');
  {
    const detail = paneOf('detail');
    // Capture the bytes the open writes (before hs.sync feeds them on).
    let bytes = '';
    const tap = process.stdout.write;
    process.stdout.write = (c, ...r) => { bytes += String(c); return tap(c, ...r); };
    dispatchMsg(route.wrap('layout', { type: 'pane_menu_open', paneId: detail.paneId, cursor: 0, scroll: 0 }));
    await hs.paint();
    process.stdout.write = tap;
    const menu = hs.find(MENU);
    assert(menu, 'the pane menu is open (on Detail)');
    const right = hs.line(menu.y).indexOf('╮', menu.x);
    assert(right > 0 && right < surfB().bounds.x && menu.y > surfB().bounds.y,
      'precondition: the menu sits left of B, on rows B also covers');
    assert(!bytes.includes('BBB'), 'B\'s rows were not re-sent — nothing wrote over them');
    eq(bWrong(), [], 'B is intact with the menu open');
    dispatchMsg(route.wrap('layout', { type: 'pane_menu_close' }));
    await hs.paint();
    assert(!hs.find(MENU), 'the menu closed');
    eq(bWrong(), [], 'B is intact after it closes');
  }

  section('[3] a popup over one terminal leaves the terminal beside it intact');
  dispatchMsg(route.wrap('layout', { type: 'pane_menu_open', paneId: paneOf('ta').paneId, cursor: 0, scroll: 0 }));
  await hs.paint();
  const menu = hs.find(MENU);
  assert(menu && menu.y >= aTop - 1 && menu.y < aBottom, 'precondition: the pane menu sits over A');
  eq(bWrong(), [], 'B is intact with the menu over A open');
  dispatchMsg(route.wrap('layout', { type: 'pane_menu_close' }));
  await hs.paint();
  eq(bWrong(), [], 'B is intact after it closes');

  section('[4] minimizing one terminal leaves the other intact (and restoring it)');
  dispatchMsg(route.wrap('layout', { type: 'panel_collapse_toggle', id: paneOf('ta').id }));
  await hs.paint();
  assert(!visibleTerminalSurfaces(getModel()).some(s => s.id === idA), 'precondition: A no longer paints');
  eq(bWrong(), [], 'B is intact with A minimized');
  dispatchMsg(route.wrap('layout', { type: 'panel_collapse_toggle', id: paneOf('ta').id }));
  await hs.paint();
  eq(bWrong(), [], 'B is intact with A restored');

  section('[5] switching one terminal\'s slot to another tab leaves the other intact');
  dispatchMsg(route.wrap('layout', { type: 'set_active_tab', paneId: paneOf('ta').paneId, tabPoolId: 'groups' }));
  await hs.paint();
  assert(!visibleTerminalSurfaces(getModel()).some(s => s.id === idA), 'precondition: A\'s slot shows Groups');
  eq(bWrong(), [], 'B is intact after A vanishes');

  section('[6] a row invalidated from elsewhere comes back');
  const y = surfB().bounds.y + 3;
  invalidateRows(y, y + 1);
  await hs.paint();
  eq(bWrong(), [], `B row ${y} is repainted after its frame record was dropped`);

  terminal.destroyAll();
  fs.rmSync(dir, { recursive: true, force: true });
  hs.restore();
  report();
})().catch((e) => { hs.restore(); console.error(e); process.exit(1); });
