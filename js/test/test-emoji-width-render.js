/**
 * Emoji are drawn 2 columns wide by the host, and the frame accounts for it.
 *
 * Field report 2026-11-14 (pg_spectrum dev.sh: nvim with LazyVim in a
 * `type: terminal` pane): rows carrying ⚡/💤 ran one column past the pane's
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
const { render } = require('../render/paint');
const { getModel } = require('../model/store');
const { parse } = require('../parser');

// test-runner registers layout/detail/groups; the rest this layout shows:
if (!sm.api.getComponent('terminal')) sm.api.registerComponent(require('../panel/terminal/terminal'));
if (!sm.api.getComponent('actions')) sm.api.registerComponent(require('../panel/navigator/actions'));

// --- the virtual host terminal ---------------------------------------------
// Host widths measured 2026-11-14 (glibc 2.39 `wcwidth`, tmux 3.4 cursor advance).
const HOST_WIDE = new Set([0x26a1 /* ⚡ */, 0x1f4a4 /* 💤 */, 0x2705 /* ✅ */, 0x1f680 /* 🚀 */]);
const _ref = new Terminal({ allowProposedApi: true });              // built-in Unicode 6 table
const _builtin = (cp) => _ref._core.unicodeService.wcwidth(cp);
const HOST = {
  version: 'host-measured',
  wcwidth: (cp) => (HOST_WIDE.has(cp) ? 2 : _builtin(cp)),
  charProperties(cp, preceding) {
    let width = HOST.wcwidth(cp);
    let join = width === 0 && preceding !== 0;
    if (join) { const p = (preceding >> 1) & 3; if (p === 0) join = false; else if (p > width) width = p; }
    return ((width & 3) << 1) | (join ? 1 : 0);
  },
};
const COLS = 120, ROWS = 30;
const vt = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
vt.unicode.register(HOST);
vt.unicode.activeVersion = HOST.version;

let _frames = '';
const _origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  const str = String(chunk);
  if (str.includes('\x1b')) { _frames += str; return true; }
  return _origWrite(chunk, ...rest);
};
const flush = (bytes) => new Promise((res) => vt.write(bytes, res));
async function paintAndSync() {
  render(getModel());
  await new Promise(res => setImmediate(res));
  const bytes = _frames; _frames = '';
  await flush(bytes);
}
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
const yml = path.join(dir, 'tui.yml');
fs.writeFileSync(yml, [
  'project_dir: .',
  'groups:',
  '  g1:',
  '    label: "Emoji ⚡ group"',
  '    actions:',
  '      a: { label: "✅ done 🚀 go", script: echo a }',
  '      b: { label: "plain label here", script: echo b }',
  'panels:',
  '  groups: { type: groups, title: Groups }',
  `  dev: { type: terminal, title: Dev, cmd: ${JSON.stringify('sh ' + emit)} }`,
  '  actions: { type: actions, title: Actions }',
  '  detail: { type: detail, title: Detail }',
  'layout:',
  '  columns:',
  '    - width: 30',
  '      panels: [groups]',
  '    - width: flex',
  '      panels:',
  '        - { tabs: [dev], hotkey: 4 }',
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
    _origWrite('  (skipped: the optional node-pty dependency is not installed)\n');
  } else {
    const surf = () => visibleTerminalSurfaces(getModel())[0];
    assert(surf(), 'precondition: the terminal pane is an on-screen surface');
    const { id } = surf();
    // Wait for the program's output to reach the session's screen.
    let rows = [];
    for (let i = 0; i < 100; i++) {
      const s = terminal.getSession(id);
      if (s) rows = terminal.sessionViewportRows(id, 2, surf().cols).rows;
      if (rows[1] && rows[1].includes('x')) break;
      await new Promise(res => setTimeout(res, 30));
    }
    assert(rows[0] && rows[0].startsWith('⚡'), `precondition: the first row starts with ⚡ (${JSON.stringify((rows[0] || '').slice(0, 8))})`);
    await paintAndSync();
    const { bounds, cols } = surf();
    const y = bounds.y + 1;                    // first interior row
    const right = bounds.x + 1 + cols;         // the pane's right border column
    eq(cellAt(right, y), '│', `the ⚡ row leaves the right border in place (col ${right})`);
    eq(cellAt(right - 1, y), 'x', 'the row fills up to the border');
    eq(borderCols(y), borderCols(y + 1), 'the ⚡ row has the same border columns as the row below');
    terminal.destroyAll();
  }

  process.stdout.write = _origWrite;
  fs.rmSync(dir, { recursive: true, force: true });
  report();
})().catch((e) => { process.stdout.write = _origWrite; console.error(e); process.exit(1); });
