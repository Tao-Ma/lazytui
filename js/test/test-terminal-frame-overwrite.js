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
 *   [7] a terminal that shrinks leaves nothing in the cells it gave up
 *   [8] a terminal moved without changing size shows its whole grid where it is now
 *   [9] a surface that vanishes or moves between frames is still reclaimed
 *       (a fast-path / poll repaint first)
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

  section('[7] a terminal that shrinks leaves nothing in the cells it gave up');
  {
    // A terminal grows into the rows of the pane above it while that pane is
    // minimized, prints there, then shrinks back when it is restored: its text
    // stayed on the rows it gave up wherever the restored pane's cells are blank
    // (round-2 review 2026-11-14, since v0.6.58). A moved / resized surface now
    // reclaims its old rows.
    terminal.destroyAll();
    const yml2 = path.join(dir, 'grow.yml');
    fs.writeFileSync(yml2, [
      'project_dir: .', 'groups:', '  g1:', '    label: Group 1', '    actions:', '      hello: { label: Hello, script: echo hello }',
      'panels:', '  groups: { type: groups, title: Groups }', '  tc: { type: terminal, title: TC, cmd: "sleep 60" }',
      '  detail: { type: detail, title: Detail }',
      'layout:', '  columns:', '    - width: 70', '      panels: [groups, tc]', '    - width: flex', '      panels: [detail]', '',
    ].join('\n'));
    sm.bootFresh(parse(yml2));
    sm.resize(160, 40);
    await hs.paint();
    const idC = mpane.newPaneId('tc');
    const surfC = () => visibleTerminalSurfaces(getModel()).find(x => x.id === idC);
    const groupsPane = () => panes().find(p => p.id === 'groups');
    dispatchMsg(route.wrap('layout', { type: 'panel_collapse_toggle', id: groupsPane().id }));
    await hs.paint();
    const big = surfC();
    await hs.feed(terminal.getSession(idC).screen, Array.from({ length: big.rows }, (_, i) => `GROWN${i}`).join('\r\n'));
    await hs.paint();
    const grownRows = () => { const out = []; for (let y = 0; y < 40; y++) if (/GROWN/.test(hs.line(y).slice(0, 70))) out.push(y); return out; };
    assert(grownRows().length > 30, `precondition: the terminal drew down most of the column (${grownRows().length} rows)`);
    dispatchMsg(route.wrap('layout', { type: 'panel_collapse_toggle', id: groupsPane().id }));
    await hs.paint();
    const small = surfC();
    assert(small.rows < big.rows, 'precondition: it shrank');
    const outside = grownRows().filter(y => y < small.bounds.y + 1 || y >= small.bounds.y + 1 + small.rows);
    eq(outside, [], `no terminal text outside its interior (rows ${small.bounds.y + 1}..${small.bounds.y + small.rows})`);
  }

  // A terminal slot over an equal-height Actions pane, Detail below, in one
  // full-width column: reordering the terminal down moves it without changing
  // its size (the [8] precondition checks).
  async function bootThree(tag) {
    terminal.destroyAll();
    const yml3 = path.join(dir, `three-${tag}.yml`);
    fs.writeFileSync(yml3, [
      'project_dir: .', 'groups:', '  g1:', '    label: Group 1', '    actions:', '      hello: { label: Hello, script: echo hello }',
      'panels:', '  groups: { type: groups, title: Groups }', `  tm: { type: terminal, title: TM, cmd: ${JSON.stringify(fill(`m-${tag}.sh`, 'MMM'))} }`,
      '  detail: { type: detail, title: Detail }', '  actions: { type: actions, title: Actions }',
      'layout:', '  columns:', '    - width: flex', '      panels: [{ tabs: [tm, groups] }, actions, detail]', '',
    ].join('\n'));
    sm.bootFresh(parse(yml3));
    sm.resize(160, 40);
    const idM = mpane.newPaneId('tm');
    await waitFor(idM, 'MMM60');
    await hs.paint();
    return idM;
  }
  // The terminal's interior rows whose screen text differs from its program's
  // screen, and the rows outside it that show its text.
  function gridCheck(id, needle) {
    const s = visibleTerminalSurfaces(getModel()).find(x => x.id === id);
    const outside = [];
    for (let y = 0; y < 40; y++) {
      const inside = s && y >= s.bounds.y + 1 && y < s.bounds.y + 1 + s.rows;
      if (!inside && hs.line(y).includes(needle)) outside.push(y);
    }
    if (!s) return { wrong: [], outside };
    const x0 = s.bounds.x + 1, y0 = s.bounds.y + 1;
    const want = terminal.sessionViewportRows(id, s.rows, s.cols).rows;
    const wrong = [];
    for (let r = 0; r < s.rows; r++) if (hs.line(y0 + r).slice(x0, x0 + s.cols).trimEnd() !== want[r].trimEnd()) wrong.push(y0 + r);
    return { wrong, outside };
  }

  section('[8] a terminal moved without changing size shows its whole grid where it is now');
  {
    // A same-size move left the per-row cache valid for rows it was never
    // drawn on: the frame rewrites the new place only where the previous
    // occupant's cells differ from the blank interior, so the terminal showed
    // blank rows (most of them) until its program printed (round-3 review).
    const idM = await bootThree('move');
    const s0 = visibleTerminalSurfaces(getModel()).find(x => x.id === idM);
    eq(gridCheck(idM, 'MMM'), { wrong: [], outside: [] }, 'precondition: the terminal shows its program\'s screen');
    const slot = paneOf('tm');
    dispatchMsg(route.wrap('layout', { type: 'focus_set', focus: slot.paneId }));
    dispatchMsg(route.wrap('layout', { type: 'free_config_enter' }));
    await hs.paint();
    dispatchMsg(route.wrap('layout', { type: 'free_config_reorder', dir: +1 }));
    await hs.paint();
    const s1 = visibleTerminalSurfaces(getModel()).find(x => x.id === idM);
    assert(s1.bounds.y > s0.bounds.y && s1.rows === s0.rows && s1.cols === s0.cols,
      `precondition: moved down, same size (${s0.bounds.y}→${s1.bounds.y}, ${s0.cols}x${s0.rows}→${s1.cols}x${s1.rows})`);
    eq(gridCheck(idM, 'MMM'), { wrong: [], outside: [] }, 'its whole grid at the new place, nothing at the old');
    dispatchMsg(route.wrap('layout', { type: 'free_config_exit' }));
    await hs.paint();
    eq(gridCheck(idM, 'MMM'), { wrong: [], outside: [] }, 'and after free-config exits');
  }

  section('[9] a surface that vanishes or moves between frames is still reclaimed (fast path / poll first)');
  {
    // The PTY fast path and the 250 ms poll paint the surfaces between frames
    // and re-recorded (or pruned) the rect render()'s reclaim read: a layout
    // change whose frame is deferred (a clean exit's remove_tab → scheduleRender)
    // with a poll tick first left the closed terminal's text in the next tab
    // (round-3 review).
    const { renderTerminalOverlay } = require('../render/paint');
    let idM = await bootThree('vanish');
    let slot = paneOf('tm');
    dispatchMsg(route.wrap('layout', { type: 'remove_tab', paneId: slot.paneId, tabPoolId: 'tm' }));
    renderTerminalOverlay(getModel());   // a poll tick lands before the frame
    await hs.paint();
    assert(!visibleTerminalSurfaces(getModel()).some(x => x.id === idM), 'precondition: the terminal tab closed');
    eq(gridCheck(idM, 'MMM').outside, [], 'a vanished terminal leaves no text (a poll tick before the frame)');

    idM = await bootThree('moved');
    slot = paneOf('tm');
    dispatchMsg(route.wrap('layout', { type: 'focus_set', focus: slot.paneId }));
    dispatchMsg(route.wrap('layout', { type: 'free_config_enter' }));
    await hs.paint();
    dispatchMsg(route.wrap('layout', { type: 'free_config_reorder', dir: +1 }));
    renderTerminalOverlay(getModel());   // the poll paints it at its new place first
    await hs.sync();
    await hs.paint();
    eq(gridCheck(idM, 'MMM'), { wrong: [], outside: [] }, 'a moved terminal: its grid where it is, nothing where it was');
    dispatchMsg(route.wrap('layout', { type: 'free_config_exit' }));
    await hs.paint();
  }

  section('[10] mid-drag, a pass between frames paints where the preview put the terminal');
  {
    // The fast path / poll passed no preview: they painted at the committed
    // rect, and since fdd4b111's `moved` force a quiet terminal the preview
    // had moved (same size) was repainted WHOLE there — over the preview's
    // other pane — until the next frame (round-4 review 2026-11-15).
    const { renderTerminalOverlay } = require('../render/paint');
    const idM = await bootThree('drag');
    const slot = paneOf('tm');
    const s0 = visibleTerminalSurfaces(getModel()).find(x => x.id === idM);
    dispatchMsg(route.wrap('layout', { type: 'focus_set', focus: slot.paneId }));
    dispatchMsg(route.wrap('layout', { type: 'free_config_enter' }));
    await hs.paint();
    // Press in the terminal pane, drag into the lower part of the pane below.
    const px = s0.bounds.x + 10, py = s0.bounds.y + 4;
    const my = s0.bounds.y + 2 * s0.bounds.h - 2;
    dispatchMsg(route.wrap('layout', { type: 'free_config_mouse_press', mx: px, my: py, cols: 160 }));
    dispatchMsg(route.wrap('layout', { type: 'free_config_mouse_motion', mx: px, my, cols: 160 }));
    const drag = route.getInstanceSlice('layout').freeConfig.drag;
    await hs.paint();
    const sp = visibleTerminalSurfaces(getModel(), drag && drag.previewArrange).find(x => x.id === idM);
    assert(sp && sp.bounds.y !== s0.bounds.y && sp.rows === s0.rows && sp.cols === s0.cols,
      `precondition: the preview moves it, same size (${s0.bounds.y}→${sp && sp.bounds.y})`);
    const offPreview = () => {
      const o = [];
      for (let y = 0; y < 40; y++) {
        if ((y < sp.bounds.y + 1 || y >= sp.bounds.y + 1 + sp.rows) && hs.line(y).includes('MMM')) o.push(y);
      }
      return o;
    };
    eq(offPreview(), [], 'precondition: the frame shows it at the preview rect only');
    renderTerminalOverlay(getModel());   // a poll tick, no frame after it
    await hs.sync();
    eq(offPreview(), [], 'a poll tick paints nothing outside the preview rect');
    dispatchMsg(route.wrap('layout', { type: 'free_config_mouse_release', mx: px, my, cols: 160 }));
    dispatchMsg(route.wrap('layout', { type: 'free_config_exit' }));
    await hs.paint();
  }

  terminal.destroyAll();
  fs.rmSync(dir, { recursive: true, force: true });
  hs.restore();
  report();
})().catch((e) => { hs.restore(); console.error(e); process.exit(1); });
