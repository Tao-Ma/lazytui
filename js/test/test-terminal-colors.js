/**
 * A terminal pane paints the program's colours and attributes.
 *
 * Field report 2026-11-14 (nvim in a `type: terminal` pane): the pane rendered
 * monochrome — the overlay read each row as plain text (translateToString), so
 * vim's visual selection, syntax colours, and status line highlights were
 * invisible. Rows are now read cell by cell as styled runs (io/term-screen) and
 * painted with the program's SGR; a colour the program left at its default takes
 * the theme's screen colour (ansi.sgrRun), like a reset inside streamed output.
 *
 *   [1] the port reads attributes + colours as SGR runs, exactly the asked width
 *   [2] painted cells carry the program's attributes (decoded on a host screen);
 *       a colour-only change repaints
 *   [3] screen colours on: default cells take the theme colours; `:theme`
 *       re-resolves them
 *   [4] a 16-colour host gets 16-colour SGR (downgraded at the write boundary)
 *   [5] the checkpoint snapshot keeps attributes (replay exit restores live
 *       terminals from it)
 *
 * Run: node js/test/test-terminal-colors.js
 */
'use strict';

process.stdout.columns = 160; process.stdout.rows = 40;

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Terminal } = require('@xterm/headless');
const { section, assert, eq, report } = require('./test-runner');
const tl = require('./_helpers/terminal-layout');
const terminal = require('../io/terminal');
const ts = require('../io/term-screen');
const { enableScreenColors } = require('../leaves/text/ansi');
const { render, setColorDepth } = require('../render/paint');
const { getModel } = require('../model/store');
const sm = require('./smoke/_helpers/smoke');

const vt = new Terminal({ cols: 160, rows: 40, allowProposedApi: true });
let _frames = '';
const _origWrite = process.stdout.write.bind(process.stdout);
const _origErr = console.error;
process.stdout.write = (chunk, ...rest) => {
  const str = String(chunk);
  if (str.includes('\x1b')) { _frames += str; return true; }
  return _origWrite(chunk, ...rest);
};
const flush = (t, bytes) => new Promise((res) => t.write(bytes, res));
async function paintAndSync() {
  render(getModel());
  await new Promise(res => setImmediate(res));
  const bytes = _frames; _frames = '';
  await flush(vt, bytes);
}
const _cell = vt.buffer.active.getNullCell();
function cellAt(x, y) { vt.buffer.active.getLine(y).getCell(x, _cell); return _cell; }
// The screen position of the first character of `needle`.
function find(needle) {
  for (let y = 0; y < vt.rows; y++) {
    const x = vt.buffer.active.getLine(y).translateToString(false).indexOf(needle);
    if (x >= 0) return { x, y };
  }
  return null;
}
const rgb = (v) => '#' + v.toString(16).padStart(6, '0');

(async () => {
  section('[1] the port reads attributes + colours as SGR runs, exactly the asked width');
  {
    const s = ts.createScreen(40, 4);
    await flush(s, '\x1b[1;3;4mA\x1b[0m\x1b[2;5;7;8;9;53mB\x1b[0m' +
      '\x1b[38;5;1mC\x1b[38;5;9mD\x1b[38;5;208mE\x1b[38;2;1;2;3;48;2;10;20;30mF\x1b[0m' +
      '\r\n\x1b[44m\x1b[K\x1b[0mx\r\n⚡wide\x1b[41m⚡\x1b[0m');
    const v = ts.readViewport(s, 3, 40);
    eq(v.runs[0].slice(0, 6).map(r => [r.sgr, r.text]), [
      ['1;3;4', 'A'], ['2;5;7;8;9;53', 'B'], ['31', 'C'], ['91', 'D'], ['38;5;208', 'E'],
      ['38;2;1;2;3;48;2;10;20;30', 'F'],
    ], 'attributes, the 16 ANSI colours in their 16-colour form, 256 and RGB exact');
    eq(v.runs[1].map(r => r.sgr), ['', '44'], 'an erased row keeps the bg it was erased with (after the x)');
    for (let r = 0; r < 3; r++) {
      const w = v.rows[r].length + (v.rows[r].match(/⚡/g) || []).length;   // ⚡ is 1 unit, 2 columns
      eq(w, 40, `row ${r} is exactly 40 columns`);
    }
    const narrow = ts.readViewport(s, 3, 6);
    eq(narrow.runs[2].map(r => [r.sgr, r.text]), [['', '⚡wide']], 'cut before the column limit: ⚡wide = 6');
    const edge = ts.readViewport(s, 3, 7);
    eq(edge.runs[2].map(r => [r.sgr, r.text]), [['', '⚡wide ']],
      'a wide glyph that would cross the edge is not drawn — the row pads to 7 instead of running to 8');
    eq(ts.readViewport(s, 3, 8).runs[2].map(r => [r.sgr, r.text]), [['', '⚡wide'], ['41', '⚡']],
      'at 8 columns it fits, with its own bg');
  }

  if (!terminal.ptyAvailable()) {
    _origErr('  (skipped [2]–[4]: the optional node-pty dependency is not installed)');
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-term-colors-'));
    const script = path.join(dir, 'colors.sh');
    fs.writeFileSync(script, "printf '\\033[1;31mBOLDRED\\033[0m \\033[7mVISUAL\\033[0m " +
      "\\033[38;5;208mORANGE\\033[0m \\033[48;2;10;20;30mRGBBG\\033[0m \\033[4mUL\\033[0m " +
      "\\033[44mBLUEBG\\033[0m PLAIN'; sleep 60\n");
    setColorDepth('truecolor');
    const fx = tl.boot({ cmd: `sh ${script}` });
    const id = fx.id;
    for (let i = 0; i < 100; i++) {
      const rows = terminal.getSession(id) ? terminal.sessionViewportRows(id, 1, 120).rows : [];
      if (rows[0] && rows[0].includes('PLAIN')) break;
      await new Promise(res => setTimeout(res, 30));
    }

    section('[2] painted cells carry the program\'s attributes; a colour-only change repaints');
    await paintAndSync();
    const p = find('BOLDRED');
    assert(p, 'precondition: the program\'s row is painted');
    let c = cellAt(p.x, p.y);
    assert(c.isBold() && c.isFgPalette() && c.getFgColor() === 1, 'BOLDRED is bold + palette red');
    c = cellAt(find('VISUAL').x, p.y);
    assert(c.isInverse(), 'VISUAL is inverse (vim\'s visual selection)');
    c = cellAt(find('ORANGE').x, p.y);
    assert(c.isFgPalette() && c.getFgColor() === 208, 'ORANGE is 256-colour 208');
    c = cellAt(find('RGBBG').x, p.y);
    assert(c.isBgRGB() && c.getBgColor() === 0x0a141e, `RGBBG has its RGB background (${rgb(c.getBgColor())})`);
    c = cellAt(find('UL').x, p.y);
    assert(c.isUnderline(), 'UL is underlined');
    c = cellAt(find('PLAIN').x, p.y);
    assert(c.isAttributeDefault(), 'PLAIN keeps the default attributes (screen colours off)');
    // Same text, now inverse: only the attributes change.
    await flush(terminal.getSession(id).screen, '\x1b[1;1H\x1b[7mBOLDRED\x1b[0m');
    await paintAndSync();
    c = cellAt(p.x, p.y);
    assert(c.isInverse() && !c.isBold(), 'the colour-only change reached the screen');

    section('[3] screen colours on: default cells take the theme colours; :theme re-resolves them');
    enableScreenColors(true);
    sm.applyMsg({ type: 'set_theme', name: 'dracula' });
    await paintAndSync();
    c = cellAt(find('PLAIN').x, p.y);
    assert(c.isBgRGB() && c.getBgColor() === 0x282a36 && c.isFgRGB() && c.getFgColor() === 0xf8f8f2,
      `a default cell is the theme's screen fg on bg (${rgb(c.getFgColor())} on ${rgb(c.getBgColor())})`);
    const blank = cellAt(find('PLAIN').x + 20, p.y);
    assert(blank.isBgRGB() && blank.getBgColor() === 0x282a36, 'the blank rest of the row too');
    c = cellAt(find('BLUEBG').x, p.y);
    assert(c.isBgPalette() && c.getBgColor() === 4 && c.isFgRGB() && c.getFgColor() === 0xf8f8f2,
      'a program bg is kept; its default fg takes the theme fg');
    c = cellAt(find('BOLDRED').x, p.y);
    assert(c.isInverse() && c.isBgRGB() && c.getBgColor() === 0x282a36,
      'inverse with default colours inverts the theme pair');
    sm.applyMsg({ type: 'set_theme', name: 'solarized-light' });
    await paintAndSync();
    c = cellAt(find('PLAIN').x, p.y);
    assert(c.isBgRGB() && c.getBgColor() === 0xfdf6e3, `:theme re-resolves the default cells (${rgb(c.getBgColor())})`);

    section('[4] a 16-colour host gets 16-colour SGR');
    enableScreenColors(false);
    setColorDepth('16');
    sm.applyMsg({ type: 'set_theme', name: 'dracula' });   // a theme change forces a full repaint
    await paintAndSync();
    c = cellAt(find('RGBBG').x, p.y);
    assert(c.isBgPalette() && c.getBgColor() < 16, `the RGB bg is a 16-colour bg (${c.getBgColor()})`);
    c = cellAt(find('ORANGE').x, p.y);
    assert(c.isFgPalette() && c.getFgColor() < 16, `the 256-colour fg is a 16-colour fg (${c.getFgColor()})`);
    setColorDepth('truecolor');

    terminal.destroyAll();
    fx.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  section('[5] the checkpoint snapshot keeps attributes');
  {
    const s = ts.createScreen(30, 3);
    await flush(s, 'plain\r\n\x1b[1;31mred\x1b[0m \x1b[7;48;2;1;2;3mvis\x1b[0m\r\n\x1b[44m  \x1b[0m');
    const snap = ts.serializeScreen(s);
    eq(snap.lines[0], 'plain', 'a plain line is just its text');
    const back = await new Promise(res => { const r = ts.restoreScreen(snap, () => res(r)); });
    eq(ts.readViewport(back, 3, 30).runs, ts.readViewport(s, 3, 30).runs, 'restored runs == original runs');
    const old = await new Promise(res => {
      const r = ts.restoreScreen({ cols: 30, rows: 3, lines: ['text-only', 'snapshot'], baseY: 0, viewportY: 0 }, () => res(r));
    });
    eq(ts.readViewport(old, 2, 30).rows.map(x => x.trimEnd()), ['text-only', 'snapshot'], 'a text-only snapshot still restores');
  }

  process.stdout.write = _origWrite;
  report();
})().catch((e) => { process.stdout.write = _origWrite; console.error(e); process.exit(1); });

