/**
 * Emoji are drawn 2 columns wide by the host, and the frame accounts for it.
 *
 * Field report 2026-11-14 (nvim with LazyVim in a `type: terminal` pane):
 * rows carrying ⚡/💤 ran one column past the pane's
 * right border. Reproduced beyond terminal panes — an action labelled
 * `✅ done 🚀 go` pushed the Actions pane's right border off-screen, a `⚡` in a
 * group label shifted the Groups border. charWidth scored every emoji 1 (its
 * `eastasianwidth` table predates Unicode 9's Wide emoji); so did the embedded
 * emulator's Unicode 6 table; the host — glibc 2.39 wcwidth, tmux 3.4 —
 * draws them 2.
 *
 * The check decodes every frame lazytui writes on a virtual HOST terminal whose
 * widths for the glyphs used here are the measured host widths (and the
 * emulator's own table otherwise) — NOT charWidth, so a frame painted with the
 * wrong widths shows up as a shifted border, exactly as on screen.
 *
 *   [1] a pane row with emoji keeps every border column (groups + actions)
 *   [2] a terminal pane row the program fills, starting with ⚡, ends at the
 *       pane border (the emulator lays it out at the frame's widths)
 *   [3] a pane row with SEQUENCES the host draws as one glyph (❤️ 👍🏽 👨‍👩‍👧 🇺🇸)
 *       keeps every border column
 *   [4] a terminal row the program fills, starting with ❤️ 👍🏽, ends at the
 *       pane border
 *
 * The virtual host joins sequences the way tmux 3.4 was measured to (2026-11-15)
 * — its own rule, written from the measurements, not char-width's `joinStep`.
 *
 * Run: node js/test/test-emoji-width-render.js
 */
'use strict';

process.stdout.columns = 120; process.stdout.rows = 30;

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Terminal } = require('@xterm/headless');
const { section, assert, eq, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const terminal = require('../io/terminal');
const { visibleTerminalSurfaces } = require('../panel/terminal-surfaces');
const { waitFor } = require('./_helpers/terminal-layout');
const { getModel } = require('../model/store');
const { parse } = require('../parser');

// test-runner registers layout/detail/groups; the rest this layout shows:
if (!sm.api.getComponent('terminal')) sm.api.registerComponent(require('../panel/terminal/terminal'));
if (!sm.api.getComponent('actions')) sm.api.registerComponent(require('../panel/navigator/actions'));

// --- the virtual host terminal ---------------------------------------------
// Host widths measured 2026-11-14 (glibc 2.39 `wcwidth`, tmux 3.4 cursor advance).
const HOST_WIDE = new Set([0x26a1 /* ⚡ */, 0x1f4a4 /* 💤 */, 0x2705 /* ✅ */, 0x1f680 /* 🚀 */,
  0x1f44d /* 👍 */, 0x1f3fd /* 🏽 */, 0x1f468 /* 👨 */, 0x1f469 /* 👩 */, 0x1f467 /* 👧 */,
  0x1f1fa /* 🇺 */, 0x1f1f8 /* 🇸 */]);
const _ref = new Terminal({ allowProposedApi: true });              // built-in Unicode 6 table
const _builtin = (cp) => _ref._core.unicodeService.wcwidth(cp);
// tmux 3.4's joining, as measured 2026-11-15: VS16 joins and makes the cell 2;
// after a ZWJ any non-ASCII codepoint joins (keeping the width); a skin tone
// joins a 2-wide cell; a Regional Indicator joins one; a zero-width codepoint
// joins. State (<< 3): bit 0 = the last codepoint was a ZWJ, bit 1 = a RI.
const _RI = (cp) => cp >= 0x1f1e6 && cp <= 0x1f1ff;
const HOST = {
  version: 'host-measured',
  wcwidth: (cp) => (HOST_WIDE.has(cp) ? 2 : (cp === 0x200d || cp === 0xfe0f) ? 0 : _builtin(cp)),
  charProperties(cp, preceding) {
    const w = HOST.wcwidth(cp);
    const prevW = (preceding >> 1) & 3, afterZwj = (preceding >> 3) & 1, afterRi = (preceding >> 4) & 1;
    const st = (cp === 0x200d ? 1 : 0) | (_RI(cp) ? 2 : 0);
    const out = (width, join) => (st << 3) | (width << 1) | (join ? 1 : 0);
    if (prevW === 0) return out(w, false);
    if (cp === 0xfe0f) return out(2, true);
    if (afterZwj && cp >= 0x80) return out(prevW, true);
    if (cp >= 0x1f3fb && cp <= 0x1f3ff && prevW === 2) return out(2, true);
    if (afterRi && _RI(cp)) return out(2, true);
    if (w === 0) return out(prevW, true);
    return out(w, false);
  },
};
const COLS = 120, ROWS = 30;
const hs = require('./_helpers/host-screen').install({ cols: COLS, rows: ROWS, unicode: HOST });
const { vt, paint: paintAndSync } = hs;
const _cell = vt.buffer.active.getNullCell();
function cellAt(x, y) {
  const ln = vt.buffer.active.getLine(y);
  if (!ln) return '';
  ln.getCell(x, _cell);
  return _cell.getChars();
}
function rowText(y) { const ln = vt.buffer.active.getLine(y); return ln ? ln.translateToString(true) : ''; }
function rowOf(needle) {
  for (let y = 0; y < ROWS; y++) if (rowText(y).includes(needle)) return y;
  return -1;
}
// The columns of every vertical border glyph on a screen row.
function borderCols(y) {
  const out = [];
  for (let x = 0; x < COLS; x++) if (cellAt(x, y) === '│') out.push(x);
  return out;
}

// --- the layout --------------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-emoji-width-'));
const emit = path.join(dir, 'emit.sh');
// One ⚡, then enough x's to fill the first row and wrap.
fs.writeFileSync(emit, "printf '\\342\\232\\241'; i=0; while [ $i -lt 300 ]; do printf x; i=$((i+1)); done; sleep 60\n");
// ❤️ then 👍🏽 (UTF-8, octal), then y's to fill the first row and wrap.
const emit2 = path.join(dir, 'emit2.sh');
fs.writeFileSync(emit2, "printf '\\342\\235\\244\\357\\270\\217\\360\\237\\221\\215\\360\\237\\217\\275'; " +
  "i=0; while [ $i -lt 300 ]; do printf y; i=$((i+1)); done; sleep 60\n");
const yml = path.join(dir, 'tui.yml');
fs.writeFileSync(yml, [
  'project_dir: .',
  'groups:',
  '  g1:',
  '    label: "Emoji ⚡ group"',
  '    actions:',
  '      a: { label: "✅ done 🚀 go", script: echo a }',
  '      b: { label: "plain label here", script: echo b }',
  '      c: { label: "❤️ love 👍🏽 ok 👨‍👩‍👧 fam 🇺🇸 us", script: echo c }',
  'panels:',
  '  groups: { type: groups, title: Groups }',
  `  dev: { type: terminal, title: Dev, cmd: ${JSON.stringify('sh ' + emit)} }`,
  `  dev2: { type: terminal, title: Dev2, cmd: ${JSON.stringify('sh ' + emit2)} }`,
  '  actions: { type: actions, title: Actions }',
  '  detail: { type: detail, title: Detail }',
  'layout:',
  '  columns:',
  '    - width: 30',
  '      panels: [groups]',
  '    - width: flex',
  '      panels:',
  '        - { tabs: [dev], hotkey: 4 }',
  '        - { tabs: [dev2] }',
  '    - panels:',
  '        - actions',
  '        - { tabs: [detail], height: 40% }',
  '',
].join('\n'));

(async () => {
  sm.bootFresh(parse(yml));
  sm.resize(COLS, ROWS);

  section('[1] a pane row with emoji keeps every border column');
  await paintAndSync();
  const yAct = rowOf('done');
  const yPlain = rowOf('plain label here');
  assert(yAct >= 0 && yPlain >= 0, `precondition: both action rows painted (${yAct}, ${yPlain})`);
  eq(borderCols(yAct), borderCols(yPlain), 'the ✅/🚀 action row has the same border columns as a plain row');
  const yGroup = rowOf('group');
  assert(yGroup >= 0, 'precondition: the ⚡ group row is painted');
  eq(borderCols(yGroup), borderCols(yGroup + 1), 'the ⚡ group row has the same border columns as the row below');

  section('[2] a terminal row the program fills ends at the pane border');
  if (!terminal.ptyAvailable()) {
    hs.write('  (skipped: the optional node-pty dependency is not installed)\n');
  } else {
    const surf = () => visibleTerminalSurfaces(getModel())[0];
    assert(surf(), 'precondition: the terminal pane is an on-screen surface');
    const { id } = surf();
    // Wait for the program's output to reach the session's screen.
    await waitFor(id, 'x');
    const rows = terminal.sessionViewportRows(id, 2, surf().cols).rows;
    assert(rows[0] && rows[0].startsWith('⚡'), `precondition: the first row starts with ⚡ (${JSON.stringify((rows[0] || '').slice(0, 8))})`);
    await paintAndSync();
    const { bounds, cols } = surf();
    const y = bounds.y + 1;                    // first interior row
    const right = bounds.x + 1 + cols;         // the pane's right border column
    eq(cellAt(right, y), '│', `the ⚡ row leaves the right border in place (col ${right})`);
    eq(cellAt(right - 1, y), 'x', 'the row fills up to the border');
    eq(borderCols(y), borderCols(y + 1), 'the ⚡ row has the same border columns as the row below');
  }

  section('[3] a pane row with sequences the host draws as one glyph keeps every border column');
  await paintAndSync();
  const ySeq = rowOf('love');
  assert(ySeq >= 0, 'precondition: the ❤️/👍🏽/👨‍👩‍👧/🇺🇸 action row is painted');
  eq(borderCols(ySeq), borderCols(rowOf('plain label here')), 'the sequence row has the same border columns as a plain row');

  section('[4] a terminal row the program fills, starting with ❤️ 👍🏽, ends at the pane border');
  if (!terminal.ptyAvailable()) {
    hs.write('  (skipped: the optional node-pty dependency is not installed)\n');
  } else {
    const surf2 = () => visibleTerminalSurfaces(getModel()).find((s) => s.bounds.y > visibleTerminalSurfaces(getModel())[0].bounds.y);
    assert(surf2(), 'precondition: the second terminal pane is an on-screen surface');
    const { id } = surf2();
    await waitFor(id, 'y');
    const rows = terminal.sessionViewportRows(id, 2, surf2().cols).rows;
    assert(rows[0] && rows[0].startsWith('\u2764\uFE0F\u{1F44D}\u{1F3FD}y'),
      `precondition: the first row starts with ❤️👍🏽y (${JSON.stringify((rows[0] || '').slice(0, 8))})`);
    await paintAndSync();
    const { bounds, cols } = surf2();
    const y = bounds.y + 1;
    const right = bounds.x + 1 + cols;
    eq(cellAt(bounds.x + 1, y), '\u2764\uFE0F', 'the host holds ❤️ in one cell');
    eq(cellAt(bounds.x + 3, y), '\u{1F44D}\u{1F3FD}', 'and 👍🏽 in the next one, 2 columns on');
    eq(cellAt(right, y), '│', `the ❤️ 👍🏽 row leaves the right border in place (col ${right})`);
    eq(cellAt(right - 1, y), 'y', 'the row fills up to the border');
    eq(borderCols(y), borderCols(y + 1), 'the ❤️ 👍🏽 row has the same border columns as the row below');
    terminal.destroyAll();
  }

  hs.restore();
  fs.rmSync(dir, { recursive: true, force: true });
  report();
})().catch((e) => { hs.restore(); console.error(e); process.exit(1); });
