/**
 * One-line text fields keep the END of what is typed — and the caret — on
 * screen (leaves/text/field-window), and the chrome that labels them measures
 * width in columns, not UTF-16 units. Read back from the HOST screen (a
 * headless xterm fed the bytes lazytui writes) where it matters.
 *
 * 2026-11-15 (after the grapheme-cluster arc). Only the agent prompt windowed
 * its draft. The `:` cmdline's row was never cut: a command wider than the
 * screen ran past the last column of the LAST row, the host wrapped it and the
 * whole screen scrolled up. The fabric-field popup, the fabric form's fields
 * and choices filter, the action palette filter and the footer's filter /
 * search / rename fields painted from the text's start and let the row
 * truncate: past the field's width the caret and the end of what was typed
 * went off the edge. The hover tooltip sized its box by `.length` (a CJK label
 * was cut), which-key and help padded keys by `.length` (and which-key read a
 * `[` key as markup: it vanished), `--list` padded labels by `.length`.
 *
 *   [1] fieldWindow — the window, the caret column, wide glyphs whole
 *   [2] cmdline — a long command never scrolls the screen; the cursor is on
 *       the end of the shown text (host screen)
 *   [3] the popups' fields — fabric field, fabric form field + choices filter,
 *       action palette filter (host screen)
 *   [4] the footer's fields — filter, search, rename (host screen)
 *   [5] widths in columns — tooltip, which-key, help, --list
 *   [6] review round 2: tiny budgets, the suffix window, seeded values, the
 *       footer beside a plugin segment, and the rest of the `.length` class
 *       (help, palette, stats header, --keymap, plugin footer segments)
 *   [7] text that ends in `\` keeps the tag the painter puts after it (a
 *       field's caret, the filter's `[/]`)
 *
 * Run: node js/test/test-field-window.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const { describe, it, section, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const runtime = require('../app/runtime');
const store = require('../model/store');
const { getModel } = runtime;
const { _makeDataHandler } = require('../dispatch/control/input');
const { fieldWindow } = require('../leaves/text/field-window');
const { stringWidth } = require('../leaves/text/char-width');
const { stripMarkup } = require('../leaves/text/ansi');
const hs = require('./_helpers/host-screen').install({ cols: 60, rows: 16 });

const stdin = new EventEmitter();
stdin.on('data', _makeDataHandler(stdin));
const type = (bytes) => stdin.emit('data', bytes);
const paste = (text) => type(`\x1b[200~${text}\x1b[201~`);
const boot = (cols = 60, rows = 16) => { sm.bootFresh(); sm.resize(cols, rows); hs.vt.resize(cols, rows); };
const withModel = (fn) => { let m = store.getModel(); [m] = fn(m); store.setModel(m); };
const LONG = 'word '.repeat(30) + 'END';                     // 153 columns
const LONG_CAPPED = 'word '.repeat(19) + 'END';              // 98: under the filters' 128 cap
const screen = () => Array.from({ length: hs.vt.rows }, (_, y) => hs.line(y));
// assert, with the host screen written out when it fails.
const onScreen = (ok, label) => { if (!ok) hs.write(`${screen().join('\n')}\n`); assert(ok, label); };
// The first reverse-video cell on screen (an in-buffer caret).
function caret() {
  const buf = hs.vt.buffer.active; const cell = buf.getNullCell();
  for (let y = 0; y < hs.vt.rows; y++) {
    const l = buf.getLine(y);
    for (let x = 0; x < hs.vt.cols; x++) { l.getCell(x, cell); if (cell.isInverse()) return { x, y }; }
  }
  return null;
}
const FORM_PA = { actionKey: 'greet', action: { label: 'Greet', type: 'run', script: 'echo "$name"',
  ports: { in: { name: { type: 'string' } } } } };
const openForm = () => withModel((m) => runtime.update(m, { type: 'fabric_form_enter', pendingAction: FORM_PA,
  fields: [{ port: 'name', text: '', required: false, default: null, desc: 'name' }] }));

// The runner is synchronous: a host-screen case (it awaits the paint) runs as a
// step under section(); a throw is recorded, not lost.
async function step(name, fn) {
  try { await fn(); } catch (e) { assert(false, `${name} threw: ${e.stack}`); }
}

(async () => {

describe('[1] fieldWindow', () => {
  it('text that fits: whole, the caret after it', () => {
    eq(fieldWindow('abc', 3, 10), { clipped: false, before: 'abc', at: '', after: '', caretCol: 3 });
  });
  it('text that does not: `…` + the tail, the caret on the last column', () => {
    const w = fieldWindow('abcdefghij', 10, 6);
    eq(w, { clipped: true, before: 'fghij'.slice(1), at: '', after: '', caretCol: 5 });
    eq(1 + stringWidth(w.before) + 1, 6, '`…` + text + caret cell fill the field exactly');
  });
  it('wide glyphs are kept or dropped whole — never past the field', () => {
    for (let avail = 3; avail <= 12; avail++) {
      const w = fieldWindow('中文字符测试ab', 14, avail);
      const used = (w.clipped ? 1 : 0) + stringWidth(w.before) + 1;
      assert(used <= avail, `avail ${avail}: ${used} columns used`);
      assert(used >= avail - 1, `avail ${avail}: at most one column short (a wide glyph that did not fit)`);
      eq(w.caretCol, used - 1, `avail ${avail}: the caret is on the last used column`);
    }
  });
  it('a caret inside the text: the window holds the cell under it and what follows', () => {
    const w = fieldWindow('0123456789', 2, 6);
    eq(w, { clipped: false, before: '01', at: '2', after: '345', caretCol: 2 });
  });
});

section('[2] cmdline: a long command never scrolls the screen');
  for (const [label, text, hostMeasures] of [['ASCII', LONG, true], ['CJK, an odd budget', '中'.repeat(40) + 'END', true],
    ['emoji', '👍🏽❤️'.repeat(20) + 'END', false]]) {
    await step(label, async () => {
      boot(41, 10);
      await hs.paint();
      const top = hs.line(0), scrolled = hs.scrolled();
      type(':');
      paste(text);
      await hs.paint();
      eq(hs.scrolled(), scrolled, `${label}: the screen did not scroll`);
      eq(hs.line(0), top, `${label}: the top row did not move`);
      const row = hs.line(9).trimEnd();            // (the row is padded to the screen with spaces)
      assert(row.startsWith(' :…') && row.endsWith('END'), `${label}: the prompt row shows \`…\` + the tail: ${JSON.stringify(row)}`);
      const cur = require('../overlay/cmdline').cmdlineCursor(getModel());
      assert(cur.col <= 41, `${label}: the cursor is on the row (col ${cur.col})`);
      if (!hostMeasures) return;                   // (the headless host draws ❤️ / 👍🏽 narrower than tmux)
      const end = stringWidth(row);
      eq([hs.vt.buffer.active.cursorX, hs.vt.buffer.active.cursorY, cur.col], [end, 9, end + 1], `${label}: the cursor is right after the shown text`);
    });
  }

section('[3] the popups\' fields keep the end and the caret in view');
  await step('fabric field popup', async () => {
    boot();
    withModel((m) => runtime.update(m, { type: 'fabric_field_enter', addr: 'greet.name', text: '', pendingAction: FORM_PA }));
    paste(LONG);
    await hs.paint();
    const end = hs.find('END'), c = caret();
    onScreen(end && c && c.y === end.y && c.x === end.x + 3, `END then the caret: ${JSON.stringify({ end, c })}`);
    assert(hs.line(end.y).includes('> …'), 'the start is marked as cut');
  });
  await step('fabric form: the focused field', async () => {
    boot();
    openForm();
    paste(LONG);
    await hs.paint();
    const end = hs.find('END'), c = caret();
    onScreen(end && c && c.y === end.y && c.x === end.x + 3, `END then the caret: ${JSON.stringify({ end, c })}`);
  });
  await step('fabric form: the choices filter', async () => {
    boot();
    openForm();
    store.setModel({ ...store.getModel(), modal: { ...store.getModel().modal, fabricForm: {
      ...store.getModel().modal.fabricForm, picking: { port: 'name', idx: 0, filter: '' } } } });
    paste(LONG_CAPPED);
    await hs.paint();
    onScreen(hs.find('/…') && hs.find('END'), 'the filter row shows /… + the tail');
  });
  await step('action palette filter', async () => {
    boot();
    type('p');
    paste(LONG_CAPPED);
    await hs.paint();
    onScreen(hs.find('/…') && hs.find('END'), 'the filter row shows /… + the tail');
  });

section('[4] the footer\'s fields keep the end and the caret in view');
  const footer = () => hs.line(hs.vt.rows - 1);
  await step('filter (beside a view-mode tag on the right)', async () => {
    boot();
    type('+');                                     // half view → a ` [half]` tag ends the row
    withModel((m) => runtime.update(m, { type: 'filter_enter', panel: 'actions', text: '', route: null }));
    paste(LONG);
    await hs.paint();
    assert(footer().startsWith(' /…') && footer().includes('END│') && footer().endsWith(' [half]'), JSON.stringify(footer()));
    eq(stringWidth(footer()), hs.vt.cols, 'the row fills the screen, no more');
  });
  await step('viewer search (the live count stays beside it)', async () => {
    boot();
    type('\x1b[C'); type('\x1b[C'); type('/');
    paste(LONG);
    await hs.paint();
    assert(footer().startsWith(' /…') && footer().includes('END│ [0/0]'), JSON.stringify(footer()));
  });
  await step('free-config rename', async () => {
    boot();
    const layout = (msg) => sm.api.dispatchMsg(sm.api.wrap('layout', msg));
    layout({ type: 'free_config_enter' });
    layout({ type: 'free_config_title_enter' });
    paste(LONG);
    await hs.paint();
    assert(footer().startsWith(' rename: …') && footer().includes('END│'), JSON.stringify(footer()));
    assert(stringWidth(footer()) <= hs.vt.cols, 'the row fits');
  });

section('[5] chrome widths in columns, not UTF-16 units');
  await step('hover tooltip: a CJK label is not cut', async () => {
    boot(100, 20);
    const hoverRegion = require('../panel/hover-region');
    const tooltip = require('../overlay/hover-tooltip');
    for (const text of ['温度传感器 42°C', 'ディスク使用率 81%']) {
      hoverRegion.publish({ text, x: 5, y: 3 });
      const rows = Array.from({ length: 20 }, () => ' '.repeat(100));
      tooltip.render(getModel(), rows, 100);
      const body = stripMarkup(rows[4]);
      assert(body.includes(text) && !body.includes('…'), `${JSON.stringify(text)} → ${JSON.stringify(body.trim())}`);
    }
  });
  await step('which-key: a `[` key shows; CJK / emoji keys line their labels up', async () => {
    const { whichKeyLines } = require('../overlay/which-key');
    const leaf = (label) => ({ label, run() {} });
    const lines = whichKeyLines({ children: { '[': leaf('prev'), '中': leaf('mid'), '❤️': leaf('love'), x: leaf('ex') } })
      .map((l) => stripMarkup(l));
    eq(lines.map((l) => l.trim().split(/\s+/)[0]), ['[', 'x', '❤️', '中'].sort((a, b) => a.localeCompare(b)), 'every key is shown, as itself');
    const labelCols = lines.map((l) => stringWidth(l.slice(0, l.search(/(prev|mid|love|ex)$/))));
    eq(new Set(labelCols).size, 1, `labels start at one column: ${JSON.stringify(lines)}`);
  });
  await step('help: leader keys and commands line their descriptions up', async () => {
    boot();
    const kb = require('../leaves/input/keybindings');
    kb.registerKeyBinding('中', { label: 'mid-help', run() {} });
    kb.registerKeyBinding('[', { label: 'prev-help', run() {} });
    require('../panel/content/help').showHelp();
    const lines = (sm.api.getInstanceSlice(sm.route.resolveTarget('viewer')).lines || []).map((l) => stripMarkup(l));
    const at = (label) => { const l = lines.find((x) => x.endsWith(label)); assert(l, `${label} listed`); return stringWidth(l.slice(0, l.length - label.length)); };
    eq([at('mid-help'), at('prev-help')], [18, 18], 'both descriptions start after the 15-column key column');
    assert(lines.some((l) => l.startsWith('  Space [ ')), 'the `[` key is shown as itself');
  });
  await step('--list: a CJK label does not push its desc out of line', async () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'field-window-'));
    try {
      const cfg = path.join(TMP, 'tui.yml');
      fs.writeFileSync(cfg, `project_dir: .

groups:
  g:
    label: G
    actions:
      a:
        script: echo a
        type: run
        label: 温度传感器
        desc: first
      b:
        script: echo b
        type: run
        label: Disk
        desc: second
`);
      const r = spawnSync(process.execPath, [path.resolve(__dirname, '..', 'app', 'tui.js'), cfg, '--list'], { encoding: 'utf8', timeout: 5000 });
      eq(r.status, 0, `rc 0 ${r.stderr}`);
      const rows = r.stdout.split('\n').filter((l) => / — (first|second)$/.test(l));
      eq(rows.length, 2, 'both actions listed');
      const cols = rows.map((l) => stringWidth(l.slice(0, l.indexOf(' — '))));
      eq(cols[0], cols[1], `descs start at one column: ${JSON.stringify(rows)}`);
    } finally { fs.rmSync(TMP, { recursive: true, force: true }); }
  });

section('[6] review round 2');
await step('fieldWindow never runs past a field of 1+ columns (the `…` goes first)', async () => {
  const texts = ['abcdefgh', '中文中文中文', 'a中b文c', '❤️👍🏽❤️👍🏽', ''];
  let worst = 0;
  for (const t of texts) for (let avail = 1; avail <= 6; avail++) for (let cur = 0; cur <= t.length; cur++) {
    const w = fieldWindow(t, cur, avail);
    const at = w.at ? stringWidth(w.at) : 1;
    const used = (w.clipped ? 1 : 0) + stringWidth(w.before) + at + stringWidth(w.after);
    if (at <= avail) worst = Math.max(worst, used - avail);
  }
  eq(worst, 0, 'columns past the field, worst case');
});
await step('fieldTail (a suffix of a long text) = the window over the whole text', async () => {
  const { fieldTail } = require('../leaves/text/field-window');
  const { fieldText } = require('../leaves/text/printable');
  const bits = ['x', '中', '❤️', '👍🏽', '\u{1F468}‍\u{1F469}', 'e\u0301', '\t', '\x1b[31m', ' '];
  let diff = 0;
  for (let k = 0; k < 400; k++) {
    let t = ''; const n = 50 + (k * 37) % 900;
    for (let i = 0; i < n; i++) t += bits[(i * 7 + k) % bits.length];
    for (const avail of [5, 17, 40]) {
      const ft = fieldText(t);
      if (JSON.stringify(fieldTail(t, avail)) !== JSON.stringify(fieldWindow(ft, ft.length, avail))) diff++;
    }
  }
  // A suffix that cannot fill the field: one glyph of 2000 combining marks at
  // the end — the window must still mark the cut start (the fallback).
  const longGlyph = 'abcdefghij'.repeat(5) + 'e' + '\u0301'.repeat(2000);
  for (const avail of [5, 17]) {
    if (JSON.stringify(fieldTail(longGlyph, avail)) !== JSON.stringify(fieldWindow(longGlyph, longGlyph.length, avail))) diff++;
  }
  eq(diff, 0, 'windows that differ');
});
await step('fabric form: a seeded value with a tab keeps the chips in one column', async () => {
  boot();
  const PA2 = { actionKey: 'greet', action: { label: 'Greet', type: 'run', script: 'echo',
    ports: { in: { a: { type: 'string' }, b: { type: 'string' } } } } };
  withModel((m) => runtime.update(m, { type: 'fabric_form_enter', pendingAction: PA2, fields: [
    { port: 'a', text: 'x\ty\nz', required: false, default: 'dflt', desc: '' },
    { port: 'b', text: 'x\ty\nz', required: false, default: 'dflt', desc: '' }] }));
  await hs.paint();
  const rows = screen().filter((l) => l.includes('[modified]'));
  eq(rows.length, 2, 'both rows show their chip whole');
  eq(new Set(rows.map((l) => stringWidth(l.slice(0, l.indexOf('[modified]'))))).size, 1, `one chip column: ${JSON.stringify(rows)}`);
  withModel((m) => runtime.update(m, { type: 'fabric_form_cancel' }));
});
await step('footer search beside a plugin\'s footerRight segment keeps its caret', async () => {
  boot();
  sm.api.registerComponent({ name: 'fw-right-probe', init: () => ({}), update: (m, s) => s,
    viewContributions: { footerRight: () => 'CPU 12% MEM 40%' } });
  type('\x1b[C'); type('\x1b[C'); type('/');
  paste(LONG);
  await hs.paint();
  const f = hs.line(hs.vt.rows - 1);
  assert(f.includes('END│') && f.includes('CPU 12% MEM 40%'), JSON.stringify(f));
  sm.api._resetViewContributions();
});
await step('help: a `[` key with a `]` after it; a CJK command; columns line up', async () => {
  boot();
  const kb = require('../leaves/input/keybindings');
  kb.registerKeyBinding('z [ ]', { label: 'pair-help', run() {} });
  sm.api.registerComponent({ name: 'fw-cmd-probe', init: () => ({}), update: (m, s) => s,
    commands: [{ name: '温度表示', desc: 'cjk-cmd', run() {} }, { name: 'ab', desc: 'ascii-cmd', run() {} }] });
  require('../panel/content/help').showHelp();
  const lines = (sm.api.getInstanceSlice(sm.route.resolveTarget('viewer')).lines || []).map((l) => stripMarkup(l));
  const at = (label) => { const l = lines.find((x) => x.endsWith(label)) || ''; return stringWidth(l.slice(0, l.length - label.length)); };
  assert(lines.some((l) => l.startsWith('  Space z [ ] ')), 'the chord is shown whole');
  eq([at('cjk-cmd'), at('ascii-cmd')], [18, 18], 'command descriptions start after the 15-column key column');
});
await step('palette: a long CJK label leaves no room for the description', async () => {
  const { _formatRow } = require('../overlay/action-palette');
  const row = _formatRow({ path: 'g:a', label: '温'.repeat(26), desc: 'DESC' }, 68);
  assert(!stripMarkup(row).includes('DESC'), `52 columns of label: the budget is 9, under 10 (${JSON.stringify(stripMarkup(row))})`);
});
await step('stats header: a CJK or bracketed metric name fits the pane and shows', async () => {
  const stats = require('../panel/monitor/stats');
  const { visibleLen } = require('../leaves/text/ansi');
  const now = Date.now();
  for (const metric of ['温度', 'ディスク使用率', '[x]']) {
    const samples = [10, 20, 30].map((v, i) => ({ ts: now - (3 - i) * 1000, [metric]: v }));
    const head = stats._renderSection(metric, samples, { columns: { [metric]: { type: 'percent' } } }, 40, 2, 'braille', 'height', -1, false, false, null, 0)[0];
    const shown = stripMarkup(head);
    eq([visibleLen(head), shown.startsWith(metric.toUpperCase()) || shown.startsWith(metric.toUpperCase().slice(0, 5)), shown.endsWith('avg 20.0%')],
      [40, true, true], `${metric}: ${JSON.stringify(shown)}`);
  }
});
await step('plugin footer segments are cut to their budget in columns, never inside a tag', async () => {
  const { visibleLen } = require('../leaves/text/ansi');
  for (const text of ['温度传感器温度传感器温度传感器', '[accent]status ok[/] more text here']) {
    sm.api._resetViewContributions();
    sm.api.registerComponent({ name: 'fw-seg-' + visibleLen(text), init: () => ({}), update: (m, s) => s,
      viewContributions: { footerRight: () => text } });
    const out = sm.api.collectViewContributions('footerRight', { width: 12 });
    assert(visibleLen(out) <= 12 && visibleLen(out) >= 11 && stripMarkup(out).endsWith('…'), `${JSON.stringify(text)} → ${JSON.stringify(out)}`);
  }
  sm.api._resetViewContributions();
});
await step('--keymap: a CJK key lines up its `->`; --list keeps one row per action', async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'field-window-'));
  try {
    const cfg = path.join(TMP, 'tui.yml');
    fs.writeFileSync(cfg, `project_dir: .
keymap:
  version: 1
  normal:
    中: show_help
    Q: cmdline
groups:
  g:
    label: G
    actions:
      a:
        script: echo a
        type: run
        label: "two\\nlines"
        desc: |
          first line
          second\tline
`);
    const run = (flag) => spawnSync(process.execPath, [path.resolve(__dirname, '..', 'app', 'tui.js'), cfg, flag], { encoding: 'utf8', timeout: 5000 }).stdout;
    const km = run('--keymap').split('\n').filter((l) => /^  (中|Q) /.test(l));
    eq(km.length, 2, 'both bindings listed');
    eq(new Set(km.map((l) => stringWidth(l.slice(0, l.indexOf(' -> '))))).size, 1, `one -> column: ${JSON.stringify(km)}`);
    const list = run('--list').split('\n').filter(Boolean);
    eq(list, ['g:a  two lines  — first line second line'], 'one row, whitespace collapsed');
  } finally { fs.rmSync(TMP, { recursive: true, force: true }); }
});
await step('tooltip: a label with a tab is not cut', async () => {
  boot(100, 20);
  const hoverRegion = require('../panel/hover-region');
  hoverRegion.publish({ text: 'web\tworker 42%', x: 5, y: 3 });
  const rows = Array.from({ length: 20 }, () => ' '.repeat(100));
  require('../overlay/hover-tooltip').render(getModel(), rows, 100);
  assert(stripMarkup(rows[4]).includes('worker 42%'), JSON.stringify(stripMarkup(rows[4]).trim()));
});

section('[7] text that ends in `\\` keeps the tag the painter puts after it');
  // Review round 2 (2026-11-15): esc() escaped only `[`, so a field's trailing
  // `\` + the caret's `[reverse]` (or the filter's `[/]`) read as `\[` — a
  // literal bracket: no caret, and the tag's text on screen.
  for (const [label, open] of [
    ['fabric field popup', () => withModel((m) => runtime.update(m, { type: 'fabric_field_enter', addr: 'greet.name', text: '', pendingAction: FORM_PA }))],
    ['fabric form: the focused field', openForm]]) {
    await step(label, async () => {
      boot();
      open();
      for (const ch of 'C:\\dir\\') type(ch);
      await hs.paint();
      const at = hs.find('C:\\dir\\'), c = caret();
      onScreen(at && c && c.y === at.y && c.x === at.x + 7, `the text, then the caret: ${JSON.stringify({ at, c })}`);
      onScreen(!hs.find('[reverse]'), 'no tag text on screen');
    });
  }
  for (const [label, open] of [
    ['fabric form: the choices filter', () => { openForm(); store.setModel({ ...store.getModel(), modal: { ...store.getModel().modal,
      fabricForm: { ...store.getModel().modal.fabricForm, picking: { port: 'name', idx: 0, filter: '' } } } }); }],
    ['action palette filter', () => type('p')],
    ['footer filter', () => withModel((m) => runtime.update(m, { type: 'filter_enter', panel: 'actions', text: '', route: null }))]]) {
    await step(label, async () => {
      boot();
      open();
      for (const ch of 'a\\') type(ch);
      await hs.paint();
      onScreen(hs.find('/a\\') && !hs.find('[/]'), 'the filter shows `/a\\`, no `[/]`');
    });
  }

hs.restore();
report();
})();
