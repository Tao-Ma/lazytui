/**
 * A popup over a terminal pane stays on top while open, and the pane comes back
 * when it closes.
 *
 * Field report 2026-11-14 (nvim in a `type: terminal` pane): `p` on the
 * focused pane opened the action palette (expected — the
 * pane wasn't in terminal mode), and closing it left the rows it had covered
 * blank. The terminal grid is painted AFTER the main frame, outside its
 * cell-diff; every popup composites INTO the frame. Since v0.6.51 a popup close
 * is a cell-diff of the frame (no whole-screen repaint), which paints the vacated
 * cells with the pane's blank body — and the grid's row cache still said
 * "unchanged". The other half of the same gap: any program output while the
 * popup was open repainted that grid row over the popup.
 *
 * Now row-compositor.compositeRow records what each popup covers on the frame
 * buffer, and the terminal painter draws only the uncovered spans (keyed into its
 * row cache), on render()'s pass and on the PTY fast path.
 *
 *   [1] compositeRow records the columns each splice covers
 *   [2] occlusion helpers: uncovered spans, column slices of styled runs
 *   [3] the palette (opened by `p`) paints over the grid intact
 *   [4] program output while it is open draws around it, not over it
 *   [5] Esc closes it and the grid comes back where it was
 *
 * Run: node js/test/test-terminal-popup-occlusion.js
 */
'use strict';

process.stdout.columns = 160; process.stdout.rows = 40;

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, section, assert, eq, report } = require('./test-runner');
const tl = require('./_helpers/terminal-layout');
const terminal = require('../io/terminal');
const route = require('../panel/route');
const { compositeRow } = require('../leaves/render/row-compositor');
const { uncovered, sliceRuns, spliceRuns } = require('../leaves/render/occlusion');
const { visibleTerminalSurfaces } = require('../panel/terminal-surfaces');
const { renderTerminalOverlay } = require('../render/paint');
const { getModel } = require('../model/store');
const { dispatchMsg } = require('../dispatch/runtime/loop');

describe('[1] compositeRow records the columns each splice covers', () => {
  it('one span per splice, clamped to the screen; the buffer still serializes as rows', () => {
    const rows = ['abcdefghij', 'klmnopqrst'];
    compositeRow(rows, 10, 'XYZ', 2, 0, 3);
    compositeRow(rows, 10, 'QQQQ', 8, 1, 4);     // runs off the right edge → [8, 10)
    compositeRow(rows, 10, 'PP', -1, 1, 2);      // starts off the left edge → [0, 1)
    eq([...rows.covered], [[0, [[2, 5]]], [1, [[8, 10], [0, 1]]]]);
    eq(JSON.stringify(rows), JSON.stringify([rows[0], rows[1]]), 'no extra enumerable field');
  });
  it('a fresh buffer has no coverage', () => eq(['a'].covered, undefined));
});

describe('[2] occlusion helpers', () => {
  it('uncovered: the gaps between overlapping / out-of-range spans', () => {
    eq(uncovered(0, 10, [[3, 5], [4, 7], [12, 20], [-5, 1]]), [[1, 3], [7, 10]]);
    eq(uncovered(0, 10, []), [[0, 10]]);
    eq(uncovered(0, 10, [[0, 10]]), []);
  });
  const runs = [{ sgr: '', text: 'ab' }, { sgr: '1', text: '⚡cd' }, { sgr: '', text: 'éf' }];   // 8 columns
  it('sliceRuns: exact columns; a wide glyph cut by an edge becomes a blank in its style', () => {
    eq(sliceRuns(runs, 0, 8), runs);
    eq(sliceRuns(runs, 3, 8), [{ sgr: '1', text: ' cd' }, { sgr: '', text: 'éf' }]);
    eq(sliceRuns(runs, 0, 3), [{ sgr: '', text: 'ab' }, { sgr: '1', text: ' ' }]);
    eq(sliceRuns(runs, 6, 7), [{ sgr: '', text: 'é' }], 'a combining mark follows its base');
  });
  it('spliceRuns: replaces columns, never past the width', () => {
    eq(spliceRuns(runs, 8, 4, [{ sgr: '7', text: '[↑9]' }]),
      [{ sgr: '', text: 'ab' }, { sgr: '1', text: '⚡' }, { sgr: '7', text: '[↑9]' }]);
    eq(spliceRuns(runs, 8, 6, [{ sgr: '7', text: 'XYZ' }]),
      [{ sgr: '', text: 'ab' }, { sgr: '1', text: '⚡cd' }, { sgr: '7', text: 'XY' }]);
  });
});

// --- the field case, on a decoded screen ------------------------------------
const hs = require('./_helpers/host-screen').install({ cols: 160, rows: 40 });
const { sync, line, find, feed: flush, paint: paintAndSync } = hs;
const key = (bytes) => require('../dispatch/control/input')._dispatchToken(bytes);

(async () => {
  if (!terminal.ptyAvailable()) {
    hs.write('  (skipped [3]–[5]: the optional node-pty dependency is not installed)\n');
    hs.restore();
    report();
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-popup-occl-'));
  const script = path.join(dir, 'fill.sh');
  fs.writeFileSync(script, "i=1; while [ $i -le 60 ]; do printf 'ROW%02d-ooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo\\n' $i; i=$((i+1)); done; sleep 60\n");
  const fx = tl.boot({ cmd: `sh ${script}` });
  const pane = fx.pane();
  dispatchMsg(route.wrap('layout', { type: 'focus_set', focus: pane.paneId }));
  await tl.waitFor(fx.id, 'ROW60');
  await paintAndSync();
  const surf = visibleTerminalSurfaces(getModel())[0];
  const ix0 = surf.bounds.x + 1, iy0 = surf.bounds.y + 1;     // the grid's first cell on screen
  const gridRow = (r) => line(iy0 + r).slice(ix0, ix0 + surf.cols);
  const expected = () => terminal.sessionViewportRows(fx.id, surf.rows, surf.cols).rows;

  section('[3] the palette (opened by `p`) paints over the grid intact');
  assert(gridRow(0).startsWith('ROW'), `precondition: the grid is painted (${JSON.stringify(gridRow(0).slice(0, 10))})`);
  key('p');
  await paintAndSync();
  const top = find('Action palette');
  assert(top, 'the palette is on screen');
  const close = find('[esc] close');
  assert(close && close.y > top.y, 'its help row is on screen');
  const boxRows = [];
  for (let y = top.y; y <= close.y + 1; y++) boxRows.push(y);
  const boxX0 = line(top.y).indexOf('╭'), boxX1 = line(top.y).lastIndexOf('╮');
  assert(boxX0 >= 0 && boxX1 > boxX0 && boxX0 < ix0 + surf.cols, `precondition: the palette overlaps the grid (cols ${boxX0}–${boxX1})`);
  const inBox = (y) => line(y).slice(boxX0, boxX1 + 1);
  for (const y of boxRows) assert(!/ROW|ooo/.test(inBox(y)), `row ${y}: no grid text inside the palette`);

  section('[4] program output while it is open draws around it, not over it');
  // Every grid row changes (an editor redraw), then the PTY fast path paints.
  let redraw = '\x1b[H';
  for (let r = 0; r < surf.rows; r++) redraw += `\x1b[${r + 1};1HNEW${String(r).padStart(2, '0')}-` + 'n'.repeat(surf.cols - 6);
  await flush(terminal.getSession(fx.id).screen, redraw);
  renderTerminalOverlay(getModel());                     // what the render queue runs on PTY output
  await sync();
  for (const y of boxRows) assert(!/NEW|nnn/.test(inBox(y)), `row ${y}: the redraw did not paint over the palette`);
  assert(find('[esc] close'), 'the palette is whole');
  const left = line(close.y).slice(ix0, boxX0);
  assert(/^NEW\d\d-n*$/.test(left), `the grid left of the palette is live (${JSON.stringify(left)})`);
  assert(gridRow(0).startsWith('NEW00'), 'rows the palette does not touch are live');

  section('[5] Esc closes it and the grid comes back where it was');
  key('\x1b');
  await paintAndSync();
  assert(!find('Action palette'), 'the palette is gone');
  const want = expected();
  for (let r = 0; r < surf.rows; r++) {
    if (gridRow(r) !== want[r].trimEnd()) { eq(gridRow(r), want[r].trimEnd(), `grid row ${r} restored`); break; }
  }
  eq(boxRows.map(y => gridRow(y - iy0)), boxRows.map(y => want[y - iy0].trimEnd()),
    'every row the palette covered shows the program\'s text again');

  terminal.destroyAll();
  fx.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
  hs.restore();
  report();
})().catch((e) => { hs.restore(); console.error(e); process.exit(1); });
